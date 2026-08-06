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
import { rewriteLine, revertLine, applyPlan, revertSession } from "../src/cost/repair-write.js";
import { scanSession, readMeta, readGate, BUDGETER_NS } from "../src/cost/repair-io.js";
import { planSession, type CallIndex, type Ledger } from "../src/cost/repair-core.js";

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
