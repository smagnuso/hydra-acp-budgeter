import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  rewriteLine,
  revertLine,
  applyPlan,
  revertSession,
  reshapeSession,
  postRepairUsageRows,
} from "../src/cost/repair-write.js";
import { scanSession, readMeta, readGate, knownUpstreams, BUDGETER_NS } from "../src/cost/repair-io.js";
import { planSession, splitLedger, type CallIndex, type Ledger } from "../src/cost/repair-core.js";

function usageLine(ts: number, amount: number): string {
  return JSON.stringify({
    method: "session/update",
    params: {
      sessionId: "hydra_session_x",
      update: {
        sessionUpdate: "usage_update",
        used: 100,
        size: 1000,
        cost: { amount, currency: "USD" },
      },
    },
    recordedAt: ts,
  });
}
function toolLine(id: string, forwarded = false): string {
  const update: Record<string, unknown> = {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title: "bash",
  };
  if (forwarded) {
    update._meta = { "hydra-acp": { planner: { taskId: "T1" } } };
  }
  return JSON.stringify({
    method: "session/update",
    params: { sessionId: "hydra_session_x", update },
    recordedAt: 1,
  });
}

function makeSession(opts: {
  lines: string[];
  archive?: string[];
  gzArchive?: string[];
  usage?: Record<string, unknown>;
  extensionState?: Record<string, Record<string, unknown>>;
}): string {
  const root = mkdtempSync(resolve(tmpdir(), "budgeter-repair-"));
  const sd = resolve(root, "hydra_session_x");
  mkdirSync(sd, { recursive: true });
  writeFileSync(resolve(sd, "history.jsonl"), opts.lines.join("\n"));
  if (opts.archive) {
    writeFileSync(resolve(sd, "history.jsonl.1"), opts.archive.join("\n"));
  }
  if (opts.gzArchive) {
    writeFileSync(resolve(sd, "history.jsonl.2.gz"), gzipSync(Buffer.from(opts.gzArchive.join("\n"))));
  }
  writeFileSync(
    resolve(sd, "meta.json"),
    JSON.stringify(
      {
        sessionId: "hydra_session_x",
        agentId: "opencode",
        upstreamSessionId: "ses_A",
        currentUsage: opts.usage ?? { used: 1, costAmount: 50, costCurrency: "USD" },
        ...(opts.extensionState ? { extensionState: opts.extensionState } : {}),
      },
      null,
      2,
    ),
  );
  return sd;
}

const idx = (p: Array<[string, string]>): CallIndex => new Map(p);
const led = (o: Record<string, Array<[number, number]>>): Ledger => new Map(Object.entries(o));

// --- line-level ------------------------------------------------------------

test("rewriteLine stamps the pristine value and replaces the amount", () => {
  const out = rewriteLine(usageLine(10, 31.5), 16.9);
  const e = JSON.parse(out);
  assert.equal(e.params.update.cost.amount, 16.9);
  assert.equal(e.params.update.cost.currency, "USD", "other cost fields survive");
  assert.equal(e.params.update._meta["hydra-acp"].costRepair.original, 31.5);
  assert.equal(e.params.update.used, 100, "token fields untouched");
});

// The whole no-data-loss story rests on this: a second pass must not capture
// the already-repaired figure as "original".
test("rewriteLine keeps original write-once across a second pass", () => {
  const once = rewriteLine(usageLine(10, 31.5), 16.9);
  const twice = rewriteLine(once, 12.0);
  const e = JSON.parse(twice);
  assert.equal(e.params.update._meta["hydra-acp"].costRepair.original, 31.5);
  assert.equal(e.params.update.cost.amount, 12.0);
});

test("revertLine restores the pristine amount and removes the marker", () => {
  const reverted = revertLine(rewriteLine(usageLine(10, 31.5), 16.9))!;
  const e = JSON.parse(reverted);
  assert.equal(e.params.update.cost.amount, 31.5);
  assert.equal(e.params.update._meta, undefined, "empty _meta is dropped entirely");
});

test("revertLine leaves rows it did not write alone", () => {
  assert.equal(revertLine(usageLine(10, 5)), undefined);
});

test("revertLine preserves foreign _meta keys", () => {
  const line = JSON.stringify({
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "usage_update",
        cost: { amount: 9 },
        _meta: { "hydra-acp": { upstreamSessionId: "ses_A" }, other: { k: 1 } },
      },
    },
    recordedAt: 1,
  });
  const e = JSON.parse(revertLine(rewriteLine(line, 4))!);
  assert.equal(e.params.update.cost.amount, 9);
  assert.equal(e.params.update._meta["hydra-acp"].upstreamSessionId, "ses_A");
  assert.deepEqual(e.params.update._meta.other, { k: 1 });
});

// --- session-level round trip ----------------------------------------------

function planFor(sd: string) {
  const scanned = scanSession(sd)!;
  const res = planSession(
    scanned.input,
    idx([["c1", "ses_A"]]),
    led({ ses_A: [[5, 1], [15, 2], [25, 3]] }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("plan refused");
  return { scanned, plan: res.plan };
}

test("apply then revert restores every transcript file byte-for-byte", () => {
  const lines = [toolLine("c1"), usageLine(10, 40), usageLine(20, 45), usageLine(30, 50), ""];
  const sd = makeSession({ lines });
  const before = readFileSync(resolve(sd, "history.jsonl"), "utf8");
  const beforeMeta = readFileSync(resolve(sd, "meta.json"), "utf8");

  const { scanned, plan } = planFor(sd);
  const applied = applyPlan(scanned, plan, "0.1.14");
  assert.ok(applied.rowsRewritten > 0);

  const after = readFileSync(resolve(sd, "history.jsonl"), "utf8");
  assert.notEqual(after, before, "apply changed the file");

  revertSession(sd);
  assert.equal(readFileSync(resolve(sd, "history.jsonl"), "utf8"), before);
  assert.equal(
    JSON.stringify(JSON.parse(readFileSync(resolve(sd, "meta.json"), "utf8"))),
    JSON.stringify(JSON.parse(beforeMeta)),
    "meta.json returns to its exact prior content",
  );
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

// The daemon reads a session's `updatedAt` off the history.jsonl mtime, and
// that value drives AGE, picker ordering and session-gc candidacy. A cost
// rewrite is not session activity, so both apply and revert must leave the
// mtime alone.
test("apply and revert preserve the history.jsonl mtime", () => {
  const lines = [toolLine("c1"), usageLine(10, 40), usageLine(20, 45), usageLine(30, 50), ""];
  const sd = makeSession({ lines });
  const hist = resolve(sd, "history.jsonl");
  const stamp = new Date("2026-06-17T04:05:06.000Z");
  utimesSync(hist, stamp, stamp);

  const { scanned, plan } = planFor(sd);
  const applied = applyPlan(scanned, plan, "0.1.14");
  assert.ok(applied.rowsRewritten > 0, "the row actually got rewritten");
  assert.equal(
    statSync(hist).mtime.toISOString(),
    stamp.toISOString(),
    "apply rewrote costs without bumping mtime",
  );

  revertSession(sd);
  assert.equal(
    statSync(hist).mtime.toISOString(),
    stamp.toISOString(),
    "revert also leaves mtime untouched",
  );
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

// Files with nothing to change must not be touched, so a partial repair can
// never perturb an archive it had no reason to rewrite.
test("apply does not rewrite transcript files that have no repaired rows", () => {
  const sd = makeSession({
    lines: [toolLine("c1"), usageLine(30, 50), ""],
    archive: [toolLine("c1"), usageLine(5, 1), ""], // already correct -> untouched
  });
  const archiveBefore = readFileSync(resolve(sd, "history.jsonl.1"));
  const { scanned, plan } = planFor(sd);
  const res = applyPlan(scanned, plan, "0.1.14");
  assert.ok(!res.filesRewritten.includes("history.jsonl.1"));
  assert.deepEqual(readFileSync(resolve(sd, "history.jsonl.1")), archiveBefore);
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("gzipped archives round-trip through apply and revert", () => {
  const sd = makeSession({
    lines: [toolLine("c1"), usageLine(30, 50), ""],
    gzArchive: [usageLine(10, 40), usageLine(20, 45), ""],
  });
  const { scanned, plan } = planFor(sd);
  applyPlan(scanned, plan, "0.1.14");
  const repaired = gunzipSync(readFileSync(resolve(sd, "history.jsonl.2.gz"))).toString("utf8");
  assert.match(repaired, /costRepair/);
  revertSession(sd);
  const back = gunzipSync(readFileSync(resolve(sd, "history.jsonl.2.gz"))).toString("utf8");
  assert.equal(back, [usageLine(10, 40), usageLine(20, 45), ""].join("\n"));
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

// --- meta.json + gate ------------------------------------------------------

test("apply writes the corrected total, clears cumulativeCost and installs the gate", () => {
  const sd = makeSession({
    lines: [toolLine("c1"), usageLine(30, 50), ""],
    usage: { used: 7, costAmount: 20, cumulativeCost: 30, costCurrency: "USD" },
  });
  const { scanned, plan } = planFor(sd);
  applyPlan(scanned, plan, "0.1.14");
  const meta = readMeta(sd)!;
  assert.equal(meta.currentUsage!.costAmount, 6);
  assert.equal(meta.currentUsage!.cumulativeCost, undefined);
  assert.equal(meta.currentUsage!.used, 7, "non-cost fields preserved");
  const gate = readGate(meta)!;
  assert.equal(gate.tool, "hydra-acp-budgeter@0.1.14");
  assert.equal(gate.method, "tool-call-join");
  assert.deepEqual(gate.upstreams, ["ses_A"]);
  assert.deepEqual(gate.originalCurrentUsage, {
    used: 7,
    costAmount: 20,
    cumulativeCost: 30,
    costCurrency: "USD",
  });
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

// budgeter's tracker owns "state" in the same bucket; clobbering it would
// destroy its per-session spend accounting.
test("apply merges into the extensionState bucket rather than replacing it", () => {
  const sd = makeSession({
    lines: [toolLine("c1"), usageLine(30, 50), ""],
    extensionState: { [BUDGETER_NS]: { state: { cost: 3, baseline: 1 } }, other: { k: 1 } },
  });
  const { scanned, plan } = planFor(sd);
  applyPlan(scanned, plan, "0.1.14");
  const meta = readMeta(sd)!;
  assert.deepEqual(meta.extensionState![BUDGETER_NS]!.state, { cost: 3, baseline: 1 });
  assert.deepEqual(meta.extensionState!.other, { k: 1 });
  assert.ok(readGate(meta));

  revertSession(sd);
  const after = readMeta(sd)!;
  assert.deepEqual(after.extensionState![BUDGETER_NS]!.state, { cost: 3, baseline: 1 });
  assert.equal(readGate(after), undefined, "only our key is removed");
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("revert on a session that was never repaired is a no-op", () => {
  const sd = makeSession({ lines: [toolLine("c1"), usageLine(30, 50), ""] });
  assert.equal(revertSession(sd), undefined);
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

// --- scanning --------------------------------------------------------------

test("scanSession reports the pristine amount for already-repaired rows", () => {
  const sd = makeSession({ lines: [toolLine("c1"), usageLine(30, 50), ""] });
  const { scanned, plan } = planFor(sd);
  applyPlan(scanned, plan, "0.1.14");
  const rescanned = scanSession(sd)!;
  assert.equal(
    rescanned.input.usageRows[0]!.amount,
    50,
    "planning always works from pristine data, never the rewritten value",
  );
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("scanSession flags forwarded worker tool calls", () => {
  const sd = makeSession({
    lines: [toolLine("c1"), toolLine("T1:w", true), usageLine(30, 50), ""],
  });
  const s = scanSession(sd)!;
  assert.deepEqual(
    s.input.toolCalls.map((t) => t.forwarded),
    [false, true],
  );
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

// --- daemon precondition ---------------------------------------------------
//
// This check must FAIL CLOSED. An earlier version probed a wrongly-named file
// and returned "down" on error, so it silently disabled itself and a repair
// ran against a live daemon across 399 sessions.

test("daemonState reports down when there is no pid file", async () => {
  const { daemonState } = await import("../src/cost/repair-cmd.js");
  const dir = mkdtempSync(resolve(tmpdir(), "budgeter-pid-"));
  assert.equal(daemonState(resolve(dir, "daemon.pid")), "down");
  rmSync(dir, { recursive: true, force: true });
});

test("daemonState reports up for a live pid", async () => {
  const { daemonState } = await import("../src/cost/repair-cmd.js");
  const dir = mkdtempSync(resolve(tmpdir(), "budgeter-pid-"));
  const p = resolve(dir, "daemon.pid");
  writeFileSync(p, JSON.stringify({ pid: process.pid, port: 1 }));
  assert.equal(daemonState(p), "up");
  rmSync(dir, { recursive: true, force: true });
});

test("daemonState reports down for a stale pid file", async () => {
  const { daemonState } = await import("../src/cost/repair-cmd.js");
  const dir = mkdtempSync(resolve(tmpdir(), "budgeter-pid-"));
  const p = resolve(dir, "daemon.pid");
  // 2^22 is above the default pid_max on Linux, so it cannot be live.
  writeFileSync(p, JSON.stringify({ pid: 4194303, port: 1 }));
  assert.equal(daemonState(p), "down");
  rmSync(dir, { recursive: true, force: true });
});

test("daemonState reports unknown - not down - when the pid file is unreadable", async () => {
  const { daemonState } = await import("../src/cost/repair-cmd.js");
  const dir = mkdtempSync(resolve(tmpdir(), "budgeter-pid-"));
  const p = resolve(dir, "daemon.pid");
  writeFileSync(p, "not json at all");
  assert.equal(daemonState(p), "unknown", "must not be treated as down");
  rmSync(dir, { recursive: true, force: true });
});

test("daemonState reports unknown when the pid field is missing", async () => {
  const { daemonState } = await import("../src/cost/repair-cmd.js");
  const dir = mkdtempSync(resolve(tmpdir(), "budgeter-pid-"));
  const p = resolve(dir, "daemon.pid");
  writeFileSync(p, JSON.stringify({ host: "0.0.0.0", port: 37549 }));
  assert.equal(daemonState(p), "unknown");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Multi-upstream shape. The regression these guard against is invisible on
// disk: the lifetime total reads correct, and the damage only appears on the
// next resurrect, when armCostLedgerProbe arms from costAmount.
// ---------------------------------------------------------------------------

function planMulti(sd: string) {
  const scanned = scanSession(sd)!;
  const res = planSession(
    scanned.input,
    idx([
      ["c1", "ses_OLD"],
      ["c2", "ses_A"],
    ]),
    // ses_OLD retired at $169.8538, ses_A (current) at $88.0546 — the real
    // figures from the session that exposed this.
    led({ ses_OLD: [[5, 169.8538]], ses_A: [[15, 40.0], [25, 48.0546]] }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("plan refused");
  return { scanned, plan: res.plan };
}

test("repair splits a multi-upstream total across cumulativeCost and costAmount", () => {
  const lines = [toolLine("c1"), toolLine("c2"), usageLine(10, 588.078), usageLine(30, 588.078), ""];
  const sd = makeSession({ lines, usage: { used: 7, costAmount: 588.078, costCurrency: "USD" } });

  const { scanned, plan } = planMulti(sd);
  applyPlan(scanned, plan, "0.1.14");

  const meta = JSON.parse(readFileSync(resolve(sd, "meta.json"), "utf8"));
  const cum = meta.currentUsage.cumulativeCost as number;
  const cur = meta.currentUsage.costAmount as number;

  // costAmount must be the CURRENT upstream only. If the whole lifetime were
  // collapsed into it, the next resurrect would arm the probe with 257.91,
  // read the agent's honest 88.05 re-report as a restart-at-$0, and bank the
  // lot — recording $345.96 for $257.91 of real spend.
  assert.ok(Math.abs(cur - 88.0546) < 1e-9, `costAmount=${cur} should be current upstream only`);
  assert.ok(Math.abs(cum - 169.8538) < 1e-9, `cumulativeCost=${cum} should be retired spend`);
  assert.ok(Math.abs(cum + cur - plan.trueTotal) < 1e-9, "halves reproduce the lifetime total");
  assert.equal(meta.currentUsage.used, 7, "non-cost fields preserved");
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("a single-upstream repair still leaves cumulativeCost absent", () => {
  const lines = [toolLine("c1"), usageLine(10, 40), usageLine(30, 50), ""];
  const sd = makeSession({ lines, usage: { used: 7, costAmount: 90, costCurrency: "USD" } });
  const { scanned, plan } = planFor(sd);
  applyPlan(scanned, plan, "0.1.14");
  const meta = JSON.parse(readFileSync(resolve(sd, "meta.json"), "utf8"));
  assert.equal(meta.currentUsage.cumulativeCost, undefined, "never-rotated shape on disk");
  assert.ok(Math.abs((meta.currentUsage.costAmount as number) - 6) < 1e-9);
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("revert undoes a multi-upstream repair exactly, including the split", () => {
  const lines = [toolLine("c1"), toolLine("c2"), usageLine(10, 588.078), usageLine(30, 588.078), ""];
  const sd = makeSession({ lines, usage: { used: 7, costAmount: 588.078, costCurrency: "USD" } });
  const beforeMeta = readFileSync(resolve(sd, "meta.json"), "utf8");
  const { scanned, plan } = planMulti(sd);
  applyPlan(scanned, plan, "0.1.14");
  revertSession(sd);
  assert.equal(
    JSON.stringify(JSON.parse(readFileSync(resolve(sd, "meta.json"), "utf8"))),
    JSON.stringify(JSON.parse(beforeMeta)),
    "cumulativeCost introduced by the split is removed again",
  );
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// reshapeSession: retro-fix for repairs written before the split existed.
// ---------------------------------------------------------------------------

// A session already repaired the OLD way: whole lifetime collapsed into
// costAmount, cumulativeCost cleared. Total right, shape wrong.
function makeCollapsedRepaired(): string {
  const sd = makeSession({
    lines: [toolLine("c1"), toolLine("c2"), usageLine(10, 257.9084), ""],
    usage: { used: 7, costAmount: 257.9084, costCurrency: "USD" },
    extensionState: {
      "hydra-acp-budgeter": {
        costRepair: {
          v: 1,
          algo: 1,
          tool: "hydra-acp-budgeter@0.1.14",
          source: "opencode-ledger",
          method: "tool-call-join",
          upstreams: ["ses_OLD", "ses_A"],
          rowsRewritten: 1,
          originalCurrentUsage: { used: 7, costAmount: 588.078, costCurrency: "USD" },
          hadExtensionState: false,
          reportedTotal: 588.078,
          trueTotal: 257.9084,
          at: "2026-08-06T17:39:02.434Z",
        },
      },
    },
  });
  return sd;
}

const multiSplit = () =>
  splitLedger(
    led({ ses_OLD: [[5, 169.8538]], ses_A: [[15, 88.0546]] }),
    ["ses_OLD", "ses_A"],
    "ses_A",
  );

test("reshapeSession splits a collapsed repair without changing the total", () => {
  const sd = makeCollapsedRepaired();
  const out = reshapeSession(sd, multiSplit(), "0.1.15");
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.ok(Math.abs(out.totalDelta) < 1e-9, "shape-only: total unchanged");
  const meta = JSON.parse(readFileSync(resolve(sd, "meta.json"), "utf8"));
  assert.ok(Math.abs(meta.currentUsage.cumulativeCost - 169.8538) < 1e-9);
  assert.ok(Math.abs(meta.currentUsage.costAmount - 88.0546) < 1e-9);
  assert.equal(meta.currentUsage.used, 7, "non-cost fields survive");
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("reshapeSession is idempotent — a second pass reports already-correct", () => {
  const sd = makeCollapsedRepaired();
  assert.equal(reshapeSession(sd, multiSplit(), "0.1.15").kind, "ok");
  const after = readFileSync(resolve(sd, "meta.json"), "utf8");
  const second = reshapeSession(sd, multiSplit(), "0.1.15");
  assert.equal(second.kind, "skip");
  if (second.kind === "skip") assert.equal(second.why, "already-correct");
  assert.equal(readFileSync(resolve(sd, "meta.json"), "utf8"), after, "byte-identical");
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("reshapeSession preserves the pristine usage write-once across two passes", () => {
  const sd = makeCollapsedRepaired();
  reshapeSession(sd, multiSplit(), "0.1.15");
  // A second reshape against a DIFFERENT split must not capture the first
  // pass's output as the pristine value.
  const moved = splitLedger(
    led({ ses_OLD: [[5, 100]], ses_A: [[15, 157.9084]] }),
    ["ses_OLD", "ses_A"],
    "ses_A",
  );
  reshapeSession(sd, moved, "0.1.15");
  const meta = JSON.parse(readFileSync(resolve(sd, "meta.json"), "utf8"));
  const gate = meta.extensionState["hydra-acp-budgeter"].costRepair;
  assert.ok(Math.abs(gate.preReshapeCurrentUsage.costAmount - 257.9084) < 1e-9,
    "still the pre-reshape collapsed value, not the first pass's split");
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("reshapeSession fixes a session whose total was ALREADY double-counted", () => {
  // The wHAgh case: a collapsed repair that has since been resurrected, so the
  // probe banked the collapsed total and the agent re-reported on top of it.
  const sd = makeSession({
    lines: [toolLine("c1"), toolLine("c2"), usageLine(10, 88.0546), ""],
    usage: { used: 7, costAmount: 88.0546, cumulativeCost: 247.2108, costCurrency: "USD" },
    extensionState: {
      "hydra-acp-budgeter": {
        costRepair: {
          v: 1, algo: 1, tool: "hydra-acp-budgeter@0.1.14",
          source: "opencode-ledger", method: "tool-call-join",
          upstreams: ["ses_OLD", "ses_A"], rowsRewritten: 1,
          originalCurrentUsage: { used: 7, costAmount: 588.078, costCurrency: "USD" },
          hadExtensionState: false, reportedTotal: 588.078, trueTotal: 247.2108,
          at: "2026-08-06T17:39:02.434Z",
        },
      },
    },
  });
  const out = reshapeSession(sd, multiSplit(), "0.1.15");
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.ok(Math.abs(out.beforeCum + out.beforeCur - 335.2654) < 1e-9, "was overstating");
  assert.ok(Math.abs(out.cum + out.cur - 257.9084) < 1e-9, "now matches the ledger");
  assert.ok(Math.abs(out.totalDelta + 77.357) < 1e-6, "removed exactly the double-counted portion");
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("reshapeSession skips an unrepaired session and a single-upstream one", () => {
  const plain = makeSession({ lines: [toolLine("c1"), usageLine(10, 5), ""] });
  const r1 = reshapeSession(plain, multiSplit(), "0.1.15");
  assert.equal(r1.kind, "skip");
  if (r1.kind === "skip") assert.equal(r1.why, "no-gate");
  rmSync(resolve(plain, ".."), { recursive: true, force: true });

  const sd = makeCollapsedRepaired();
  const single = splitLedger(led({ ses_A: [[15, 88.0546]] }), ["ses_A"], "ses_A");
  const r2 = reshapeSession(sd, single, "0.1.15");
  assert.equal(r2.kind, "skip");
  if (r2.kind === "skip") assert.equal(r2.why, "single-upstream");
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("reshapeSession refuses when the current upstream is absent from the ledger", () => {
  const sd = makeCollapsedRepaired();
  // meta says the session is on ses_A, but the ledger knows neither — the
  // retired/current boundary is not drawable, so guessing is not allowed.
  const blind = splitLedger(led({ ses_X: [[5, 10]], ses_Y: [[6, 20]] }), ["ses_X", "ses_Y"], "ses_A");
  const out = reshapeSession(sd, blind, "0.1.15");
  assert.equal(out.kind, "refuse");
  const meta = JSON.parse(readFileSync(resolve(sd, "meta.json"), "utf8"));
  assert.ok(Math.abs(meta.currentUsage.costAmount - 257.9084) < 1e-9, "untouched on refusal");
  assert.equal(meta.currentUsage.cumulativeCost, undefined, "untouched on refusal");
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// knownUpstreams: the three records of a session's ancestry disagree, and
// splitting against only one of them moves the total instead of its layout.
// ---------------------------------------------------------------------------

test("knownUpstreams unions the gate, the generation list, and the current upstream", () => {
  const meta = {
    sessionId: "s",
    agentId: "opencode",
    upstreamSessionId: "ses_NOW",
    upstreamGenerations: [{ upstreamSessionId: "ses_GEN1" }, { upstreamSessionId: "ses_GEN2" }],
    extensionState: {
      "hydra-acp-budgeter": { costRepair: { upstreams: ["ses_GATE", "ses_GEN1"] } },
    },
  };
  // Gate order first, then generations, then current — deduped.
  assert.deepEqual(knownUpstreams(meta as never), [
    "ses_GATE",
    "ses_GEN1",
    "ses_GEN2",
    "ses_NOW",
  ]);
});

test("knownUpstreams includes a current upstream the gate never saw", () => {
  // The case that made 3 real sessions unreshapeable: resurrected AFTER the
  // repair, so the gate's set predates the upstream they now sit on. Splitting
  // against the gate alone treats the current upstream as retired.
  const meta = {
    sessionId: "s",
    agentId: "opencode",
    upstreamSessionId: "ses_AFTER",
    extensionState: { "hydra-acp-budgeter": { costRepair: { upstreams: ["ses_X", "ses_Y"] } } },
  };
  assert.deepEqual(knownUpstreams(meta as never), ["ses_X", "ses_Y", "ses_AFTER"]);
});

test("knownUpstreams tolerates a missing gate, missing generations and junk entries", () => {
  assert.deepEqual(
    knownUpstreams({ sessionId: "s", agentId: "a", upstreamSessionId: "ses_1" } as never),
    ["ses_1"],
  );
  assert.deepEqual(knownUpstreams({ sessionId: "s", agentId: "a" } as never), []);
  const junk = {
    sessionId: "s",
    agentId: "a",
    upstreamSessionId: "",
    upstreamGenerations: [{}, { upstreamSessionId: "" }],
    extensionState: { "hydra-acp-budgeter": { costRepair: { upstreams: [1, null, "ses_ok"] } } },
  };
  assert.deepEqual(knownUpstreams(junk as never), ["ses_ok"]);
});

// ---------------------------------------------------------------------------
// Revert is only lossless while the session has been dormant since its repair.
// A session that kept working has rows with no pristine value to restore.
// ---------------------------------------------------------------------------

test("postRepairUsageRows counts only unstamped cost rows newer than the repair", () => {
  const sd = makeSession({
    lines: [toolLine("c1"), usageLine(10, 40), usageLine(30, 50), ""],
  });
  const { scanned, plan } = planFor(sd);
  applyPlan(scanned, plan, "0.1.14");
  const at = new Date(20).toISOString();
  // Both rows were rewritten, so both are stamped and restorable regardless
  // of when they were written.
  assert.equal(postRepairUsageRows(sd, at), 0);

  // Now append a row the repair never saw, dated after it.
  const p = resolve(sd, "history.jsonl");
  writeFileSync(p, `${readFileSync(p, "utf8").trimEnd()}\n${usageLine(999, 61)}\n`);
  assert.equal(postRepairUsageRows(sd, at), 1);
  assert.equal(postRepairUsageRows(sd, new Date(10_000).toISOString()), 0, "cutoff respected");
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("revertSession refuses a session that recorded usage after its repair", () => {
  const sd = makeSession({ lines: [toolLine("c1"), usageLine(10, 40), usageLine(30, 50), ""] });
  const { scanned, plan } = planFor(sd);
  applyPlan(scanned, plan, "0.1.14");

  const p = resolve(sd, "history.jsonl");
  writeFileSync(p, `${readFileSync(p, "utf8").trimEnd()}\n${usageLine(Date.now() + 60_000, 61)}\n`);
  const repaired = readFileSync(p, "utf8");
  const repairedMeta = readFileSync(resolve(sd, "meta.json"), "utf8");

  const out = revertSession(sd);
  assert.ok(out, "gate found");
  assert.ok(out!.refused, "refused rather than losing data");
  assert.equal(out!.postRepairRows, 1);
  assert.equal(out!.rowsReverted, 0);
  // Nothing may be written on a refusal — a partial revert is the worst case.
  assert.equal(readFileSync(p, "utf8"), repaired, "transcript untouched");
  assert.equal(readFileSync(resolve(sd, "meta.json"), "utf8"), repairedMeta, "meta untouched");
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("revertSession --force reverts anyway, and the post-repair row is left alone", () => {
  const sd = makeSession({ lines: [toolLine("c1"), usageLine(10, 40), usageLine(30, 50), ""] });
  const { scanned, plan } = planFor(sd);
  applyPlan(scanned, plan, "0.1.14");
  const p = resolve(sd, "history.jsonl");
  const late = usageLine(Date.now() + 60_000, 61);
  writeFileSync(p, `${readFileSync(p, "utf8").trimEnd()}\n${late}\n`);

  const out = revertSession(sd, { force: true });
  assert.ok(out && out.refused === undefined, "proceeded under force");
  const lines = readFileSync(p, "utf8").trimEnd().split("\n");
  // The stamped rows are back to their pristine amounts…
  assert.equal(JSON.parse(lines[1]!).params.update.cost.amount, 40);
  assert.equal(JSON.parse(lines[2]!).params.update.cost.amount, 50);
  // …and the unstamped one still holds its corrected-baseline value, which is
  // exactly the two-baseline seam the default refusal exists to prevent.
  assert.equal(JSON.parse(lines[3]!).params.update.cost.amount, 61);
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});

test("a dormant session still reverts without needing --force", () => {
  const sd = makeSession({ lines: [toolLine("c1"), usageLine(10, 40), usageLine(30, 50), ""] });
  const before = readFileSync(resolve(sd, "history.jsonl"), "utf8");
  const { scanned, plan } = planFor(sd);
  applyPlan(scanned, plan, "0.1.14");
  const out = revertSession(sd);
  assert.ok(out && out.refused === undefined, "no refusal for an untouched session");
  assert.equal(readFileSync(resolve(sd, "history.jsonl"), "utf8"), before);
  rmSync(resolve(sd, ".."), { recursive: true, force: true });
});
