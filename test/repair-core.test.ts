import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  attribute,
  checkGuards,
  planSession,
  truthAt,
  truthSeries,
  type CallIndex,
  type Ledger,
  type RepairedRow,
  type SessionInput,
  type ToolCallRow,
  type UsageRow,
} from "../src/cost/repair-core.js";

function idx(pairs: Array<[string, string]>): CallIndex {
  return new Map(pairs);
}
function ledger(o: Record<string, Array<[number, number]>>): Ledger {
  return new Map(Object.entries(o));
}
function rows(vals: Array<[number, number]>): UsageRow[] {
  return vals.map(([recordedAt, amount], i) => ({
    file: "history.jsonl",
    line: i,
    recordedAt,
    amount,
  }));
}
function tc(id: string, forwarded = false): ToolCallRow {
  return { toolCallId: id, forwarded };
}
function session(over: Partial<SessionInput> = {}): SessionInput {
  return {
    sessionId: "hydra_session_test",
    agentId: "opencode",
    reportedTotal: 100,
    usageRows: [],
    toolCalls: [],
    ...over,
  };
}

// --- attribution -----------------------------------------------------------

test("attribute collects every distinct agent session a tool call resolves to", () => {
  const a = attribute(
    [tc("c1"), tc("c2"), tc("c3")],
    idx([
      ["c1", "ses_A"],
      ["c2", "ses_B"],
      ["c3", "ses_A"],
    ]),
  );
  assert.deepEqual(a.upstreams, ["ses_A", "ses_B"]);
  assert.equal(a.ownResolved, 3);
  assert.equal(a.ownUnresolved, 0);
});

// The planner re-emits worker tool calls onto the orchestrator's wire. That
// spend sits in the worker's own agent session and never appears in the
// orchestrator agent's reported cost, so counting it would attribute money the
// orchestrator never spent. Stripping the `<taskId>:` prefix and resolving
// anyway was measured to over-attribute by $167 across the corpus.
test("attribute skips forwarded worker tool calls", () => {
  const a = attribute(
    [tc("own1"), tc("T1:worker1", true), tc("S2:worker2", true)],
    idx([
      ["own1", "ses_MINE"],
      ["T1:worker1", "ses_WORKER"],
      ["worker1", "ses_WORKER"],
      ["S2:worker2", "ses_WORKER2"],
    ]),
  );
  assert.deepEqual(a.upstreams, ["ses_MINE"]);
  assert.equal(a.forwardedSkipped, 2);
  assert.equal(a.ownResolved, 1);
});

test("attribute counts unresolvable own ids without inventing an upstream", () => {
  const a = attribute([tc("gone1"), tc("gone2"), tc("here")], idx([["here", "ses_A"]]));
  assert.deepEqual(a.upstreams, ["ses_A"]);
  assert.equal(a.ownUnresolved, 2);
});

// --- truth -----------------------------------------------------------------

test("truthAt sums across every attributed upstream up to the instant", () => {
  const l = ledger({
    ses_A: [
      [100, 1],
      [300, 2],
    ],
    ses_B: [[200, 10]],
  });
  assert.equal(truthAt(l, ["ses_A", "ses_B"], 50), 0);
  assert.equal(truthAt(l, ["ses_A", "ses_B"], 150), 1);
  assert.equal(truthAt(l, ["ses_A", "ses_B"], 250), 11);
  assert.equal(truthAt(l, ["ses_A", "ses_B"], 999), 13);
});

test("truthSeries matches truthAt row by row", () => {
  const l = ledger({
    ses_A: [
      [100, 1],
      [300, 2],
    ],
    ses_B: [[200, 10]],
  });
  const ts = [50, 150, 250, 999];
  assert.deepEqual(
    truthSeries(l, ["ses_A", "ses_B"], ts),
    ts.map((t) => truthAt(l, ["ses_A", "ses_B"], t)),
  );
});

// --- guards ----------------------------------------------------------------

function rr(vals: Array<[number, number]>): RepairedRow[] {
  return vals.map(([amount, repaired], i) => ({
    file: "history.jsonl",
    line: i,
    recordedAt: i,
    amount,
    repaired,
  }));
}

// A real session produced -$87.86 during development, from a non-monotonic
// series caused by a fork resetting billing mid-transcript.
test("guard rejects a negative repaired value", () => {
  const g = checkGuards(rr([[10, 5], [20, -3]]), 20);
  assert.equal(g.ok, false);
  assert.match(g.violations.join(), /negative/);
});

test("guard rejects a decreasing repaired series", () => {
  const g = checkGuards(rr([[10, 8], [20, 4]]), 20);
  assert.equal(g.ok, false);
  assert.match(g.violations.join(), /decreases/);
});

// hydra over-reports, never under-reports. Truth above the recorded value means
// we folded in an agent session that isn't this hydra session's.
test("guard rejects truth persistently exceeding the recorded value", () => {
  const g = checkGuards(rr([[10, 12]]), 100);
  assert.equal(g.ok, false);
  assert.match(g.violations.join(), /exceeds recorded/);
});

// hydra writes its snapshot at the turn boundary; a message can land in the
// agent's ledger in the gap before we look it up, leaving our figure
// momentarily ahead. Measured on real data: 5 sessions, all sub-$1, all
// resolved by the following row. Rejecting these would refuse good repairs.
test("guard tolerates a transient excess that the next row absorbs", () => {
  const g = checkGuards(rr([[0.64, 0.84], [0.98, 0.98]]), 5);
  assert.equal(g.ok, true, g.violations.join());
});

// The same shape, but the excess never resolves — that is over-attribution
// and must be refused. Real example: repaired $8.64 against recorded $0.04.
test("guard rejects an excess the next row does not absorb", () => {
  const g = checkGuards(rr([[0.04, 8.64], [0.05, 8.70]]), 26);
  assert.equal(g.ok, false);
  assert.match(g.violations.join(), /exceeds recorded/);
});

test("guard accepts a clean repair", () => {
  assert.equal(checkGuards(rr([[10, 2], [20, 5], [30, 9]]), 30).ok, true);
});

// --- planning --------------------------------------------------------------

test("planSession repairs a single-upstream session exactly", () => {
  const res = planSession(
    session({
      reportedTotal: 30,
      usageRows: rows([
        [100, 10],
        [200, 20],
        [300, 30],
      ]),
      toolCalls: [tc("c1")],
    }),
    idx([["c1", "ses_A"]]),
    ledger({
      ses_A: [
        [90, 1],
        [190, 2],
        [290, 3],
      ],
    }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.plan.rows.map((r) => r.repaired), [1, 3, 6]);
  assert.equal(res.plan.trueTotal, 6);
});

// The case meta.json alone cannot handle: it retains only the CURRENT upstream,
// so a rotated session's retired spend is invisible without the tool-call join.
test("planSession sums retired upstreams a rotated session used", () => {
  const res = planSession(
    session({
      reportedTotal: 100,
      usageRows: rows([
        [100, 40],
        [300, 90],
      ]),
      toolCalls: [tc("old"), tc("new")],
    }),
    idx([
      ["old", "ses_RETIRED"],
      ["new", "ses_CURRENT"],
    ]),
    ledger({
      ses_RETIRED: [[50, 5]],
      ses_CURRENT: [[250, 7]],
    }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.plan.attribution.upstreams, ["ses_CURRENT", "ses_RETIRED"]);
  assert.deepEqual(res.plan.rows.map((r) => r.repaired), [5, 12]);
});

test("planSession corrects meta-only sessions that have no usage rows", () => {
  const res = planSession(
    session({ reportedTotal: 50, usageRows: [], toolCalls: [tc("c1")] }),
    idx([["c1", "ses_A"]]),
    ledger({ ses_A: [[1, 2], [2, 3]] }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.plan.rows.length, 0);
  assert.equal(res.plan.trueTotal, 5);
});

// --- refusals --------------------------------------------------------------

test("planSession refuses a fork", () => {
  const res = planSession(
    session({ forkedFromSessionId: "hydra_session_parent", toolCalls: [tc("c1")] }),
    idx([["c1", "ses_A"]]),
    ledger({ ses_A: [[1, 1]] }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.refusal.reason, "fork");
});

test("planSession refuses when nothing resolves", () => {
  const res = planSession(
    session({ toolCalls: [tc("gone")] }),
    idx([]),
    ledger({}),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.refusal.reason, "no-own-upstream");
});

// A pure orchestrator runs no tools of its own; every call is forwarded. It has
// no provable upstream and must not borrow its workers'.
test("planSession refuses an orchestrator whose calls are all forwarded", () => {
  const res = planSession(
    session({ toolCalls: [tc("T1:a", true), tc("T2:b", true)] }),
    idx([["T1:a", "ses_W1"], ["T2:b", "ses_W2"]]),
    ledger({ ses_W1: [[1, 5]], ses_W2: [[1, 5]] }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.refusal.reason, "no-own-upstream");
  assert.equal(res.refusal.attribution?.forwardedSkipped, 2);
});

test("planSession refuses when most own ids are unresolvable", () => {
  const res = planSession(
    session({ toolCalls: [tc("a"), tc("x"), tc("y"), tc("z")] }),
    idx([["a", "ses_A"]]),
    ledger({ ses_A: [[1, 1]] }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.refusal.reason, "majority-unresolved");
});

test("planSession refuses a guard violation rather than writing it", () => {
  const res = planSession(
    session({
      reportedTotal: 10,
      // recorded value is BELOW the ledger truth -> over-attribution
      usageRows: rows([[100, 1]]),
      toolCalls: [tc("c1")],
    }),
    idx([["c1", "ses_A"]]),
    ledger({ ses_A: [[50, 99]] }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.refusal.reason, "guard-violation");
  assert.match(res.refusal.detail, /exceeds recorded/);
});

test("planSession refuses zero-cost sessions", () => {
  const res = planSession(session({ reportedTotal: 0 }), idx([]), ledger({}));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.refusal.reason, "zero-cost");
});

// hydra stops recording usage_update when a session goes cold mid-turn, so the
// agent's ledger can contain messages the transcript never saw. meta.json is a
// statement about the session NOW, so it must reflect the full ledger — taking
// the last row's value drops that tail. Seen on a real session where doing so
// moved the total further from the truth than the inflated original.
test("planSession totals meta from the full ledger, not the last recorded row", () => {
  const res = planSession(
    session({ reportedTotal: 0.46, usageRows: rows([[100, 0.19]]), toolCalls: [tc("c1")] }),
    idx([["c1", "ses_A"]]),
    // one message at/below the row, four after it that hydra never recorded
    ledger({ ses_A: [[90, 0.19], [200, 0.1], [300, 0.1], [400, 0.1], [500, 0.096]] }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.plan.rows[0]!.repaired, 0.19, "the row itself is truth at its own instant");
  assert.ok(Math.abs(res.plan.trueTotal - 0.586) < 1e-9, `got ${res.plan.trueTotal}`);
});
