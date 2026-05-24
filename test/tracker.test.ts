import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CostTracker } from "../src/tracker.js";

function makeTracker() {
  return new CostTracker({ softLimit: 5, hardLimit: 10, currency: "USD" });
}

function usage(amount: number, currency = "USD"): Record<string, unknown> {
  return {
    sessionUpdate: "usage_update",
    cost: { amount, currency },
  };
}

test("applyUsageUpdate records cost and reports per-session + total", () => {
  const t = makeTracker();
  const snap = t.applyUsageUpdate("s1", usage(2));
  assert.equal(snap.perSession, 2);
  assert.equal(snap.total, 2);
  assert.equal(snap.currency, "USD");
  assert.equal(snap.state, "ok");
});

test("higher cost on the same session replaces the prior amount", () => {
  const t = makeTracker();
  t.applyUsageUpdate("s1", usage(2));
  const snap = t.applyUsageUpdate("s1", usage(3));
  assert.equal(snap.perSession, 3);
  assert.equal(snap.total, 3);
});

test("lower cost on the same session is clamped (resurrect would otherwise dip)", () => {
  const t = makeTracker();
  t.applyUsageUpdate("s1", usage(4));
  const snap = t.applyUsageUpdate("s1", usage(1));
  assert.equal(snap.perSession, 4);
  assert.equal(snap.total, 4);
});

test("total sums across sessions", () => {
  const t = makeTracker();
  t.applyUsageUpdate("s1", usage(2));
  t.applyUsageUpdate("s2", usage(3));
  const snap = t.snapshotFor("s2");
  assert.equal(snap.perSession, 3);
  assert.equal(snap.total, 5);
});

test("derived state matches thresholds", () => {
  const t = makeTracker();
  assert.equal(t.applyUsageUpdate("s1", usage(4)).state, "ok");
  assert.equal(t.applyUsageUpdate("s1", usage(5)).state, "soft");
  assert.equal(t.applyUsageUpdate("s1", usage(10)).state, "hard");
});

test("consumeStateTransition fires exactly once per upward transition", () => {
  const t = makeTracker();
  t.applyUsageUpdate("s1", usage(2));
  assert.equal(t.consumeStateTransition(), undefined);
  t.applyUsageUpdate("s1", usage(5));
  assert.equal(t.consumeStateTransition(), "soft");
  // Subsequent reads within the same tier don't re-fire.
  t.applyUsageUpdate("s1", usage(6));
  assert.equal(t.consumeStateTransition(), undefined);
  t.applyUsageUpdate("s1", usage(10));
  assert.equal(t.consumeStateTransition(), "hard");
  assert.equal(t.consumeStateTransition(), undefined);
});

test("forget drops per-session cost and reduces total", () => {
  const t = makeTracker();
  t.applyUsageUpdate("s1", usage(3));
  t.applyUsageUpdate("s2", usage(4));
  assert.equal(t.snapshotFor("s1").total, 7);
  const snap = t.forget("s1");
  assert.equal(snap.total, 4);
});

test("cumulativeCost in _meta.hydra-acp overrides cost.amount", () => {
  const t = makeTracker();
  const update: Record<string, unknown> = {
    sessionUpdate: "usage_update",
    cost: { amount: 1, currency: "USD" },
    _meta: { "hydra-acp": { cumulativeCost: 8 } },
  };
  const snap = t.applyUsageUpdate("s1", update);
  assert.equal(snap.perSession, 8);
  assert.equal(snap.total, 8);
});

test("missing cost leaves state unchanged", () => {
  const t = makeTracker();
  t.applyUsageUpdate("s1", usage(3));
  const snap = t.applyUsageUpdate("s1", { sessionUpdate: "usage_update" });
  assert.equal(snap.perSession, 3);
  assert.equal(snap.total, 3);
});
