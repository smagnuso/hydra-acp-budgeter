import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CostTracker,
  type PerSessionState,
  type StateStore,
  type TrackerOptions,
} from "../src/tracker.js";

// In-memory store implementing the StateStore interface. Records
// every set() so tests can assert on persistence side effects
// without a running daemon.
class MemoryStore implements StateStore {
  readonly data = new Map<string, PerSessionState>();
  readonly writes: Array<{ sessionId: string; state: PerSessionState }> = [];
  private sessionIds: string[] = [];

  async get(sessionId: string): Promise<PerSessionState | undefined> {
    return this.data.get(sessionId);
  }
  async set(sessionId: string, state: PerSessionState): Promise<void> {
    this.data.set(sessionId, state);
    this.writes.push({ sessionId, state: { ...state } });
  }
  async listSessionIds(): Promise<string[]> {
    return [...this.sessionIds];
  }
  // Test helper — seed a "session known to daemon" for hydration.
  seedKnownSession(id: string, state?: PerSessionState): void {
    if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
    if (state) this.data.set(id, state);
  }
}

function makeTracker(store?: StateStore): CostTracker {
  const opts: TrackerOptions = {
    softLimit: 5,
    hardLimit: 10,
    currency: "USD",
    ...(store ? { store } : {}),
  };
  return new CostTracker(opts);
}

function usage(amount: number, currency = "USD"): Record<string, unknown> {
  return {
    sessionUpdate: "usage_update",
    cost: { amount, currency },
  };
}

// Wait for fire-and-forget persistOne promises to settle. Two
// microtask boundaries are enough — persistOne awaits one
// store.set() call which itself resolves synchronously in
// MemoryStore.
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

// ── In-memory semantics (no store) ────────────────────────────────

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
  t.applyUsageUpdate("s1", usage(6));
  assert.equal(t.consumeStateTransition(), undefined);
  t.applyUsageUpdate("s1", usage(10));
  assert.equal(t.consumeStateTransition(), "hard");
  assert.equal(t.consumeStateTransition(), undefined);
});

test("reset zeros all per-session state", () => {
  const t = makeTracker();
  t.applyUsageUpdate("s1", usage(3));
  t.applyUsageUpdate("s2", usage(4));
  assert.equal(t.snapshotFor("s1").total, 7);
  t.reset();
  assert.equal(t.snapshotFor("s1").total, 0);
  assert.equal(t.snapshotFor("s1").state, "ok");
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

// ── Store persistence ─────────────────────────────────────────────

test("applyUsageUpdate persists per-session cost through the store", async () => {
  const store = new MemoryStore();
  const t = makeTracker(store);
  t.applyUsageUpdate("s1", usage(3));
  await settle();
  assert.deepEqual(store.data.get("s1"), {
    cost: 3,
    baseline: 0,
    currency: "USD",
  });
  assert.equal(store.writes.length, 1);
});

test("reset writes new baselines through the store for every in-memory session", async () => {
  const store = new MemoryStore();
  const t = makeTracker(store);
  t.applyUsageUpdate("s1", usage(3));
  t.applyUsageUpdate("s2", usage(4));
  await settle();
  const writesBefore = store.writes.length;
  t.reset();
  await settle();
  // Two additional writes — one per session — with baseline == cost.
  assert.equal(store.writes.length - writesBefore, 2);
  assert.deepEqual(store.data.get("s1"), {
    cost: 3,
    baseline: 3,
    currency: "USD",
  });
  assert.deepEqual(store.data.get("s2"), {
    cost: 4,
    baseline: 4,
    currency: "USD",
  });
  // Effective total reads zero.
  assert.equal(t.snapshotFor("s1").total, 0);
});

test("hydrateAll pulls every session's persisted state before the first usage_update", async () => {
  const store = new MemoryStore();
  store.seedKnownSession("s1", { cost: 4, baseline: 0, currency: "USD" });
  store.seedKnownSession("s2", { cost: 3, baseline: 0, currency: "USD" });
  store.seedKnownSession("s3-untouched" /* known but no state */);
  const t = makeTracker(store);
  await t.hydrateAll();
  const snap = t.snapshotFor("s1");
  assert.equal(snap.total, 7, "hydration should populate the in-memory total");
  assert.equal(snap.perSession, 4);
  // Sessions in the listing but without a stored bucket are silently
  // treated as "no data" — they don't count toward the total.
  assert.equal(t.snapshotFor("s3-untouched").perSession, 0);
});

test("ensureHydrated is idempotent under concurrent callers (single fetch)", async () => {
  const store = new MemoryStore();
  store.seedKnownSession("s1", { cost: 5, baseline: 0, currency: "USD" });
  let fetchCount = 0;
  const wrappedStore: StateStore = {
    get: async (id) => {
      fetchCount++;
      return store.get(id);
    },
    set: (id, s) => store.set(id, s),
    listSessionIds: () => store.listSessionIds(),
  };
  const t = makeTracker(wrappedStore);
  // Fire five concurrent hydrations for the same session.
  await Promise.all([
    t.ensureHydrated("s1"),
    t.ensureHydrated("s1"),
    t.ensureHydrated("s1"),
    t.ensureHydrated("s1"),
    t.ensureHydrated("s1"),
  ]);
  assert.equal(
    fetchCount,
    1,
    "concurrent ensureHydrated for the same session must share a single fetch",
  );
  assert.equal(t.snapshotFor("s1").perSession, 5);
});

test("ensureHydrated on an unknown session caches the absence", async () => {
  const store = new MemoryStore();
  // No seedKnownSession — the store returns undefined for s1.
  let getCount = 0;
  const wrappedStore: StateStore = {
    get: async (id) => {
      getCount++;
      return store.get(id);
    },
    set: (id, s) => store.set(id, s),
    listSessionIds: () => store.listSessionIds(),
  };
  const t = makeTracker(wrappedStore);
  await t.ensureHydrated("s1");
  await t.ensureHydrated("s1");
  await t.ensureHydrated("s1");
  assert.equal(getCount, 1, "confirmed-absent should short-circuit repeat calls");
});

test("applyUsageUpdate on a previously-absent session drops it from confirmedAbsent", async () => {
  const store = new MemoryStore();
  const t = makeTracker(store);
  await t.ensureHydrated("s1"); // marks s1 as absent
  t.applyUsageUpdate("s1", usage(2));
  await settle();
  // Store now has s1; a fresh tracker hydrating the same session
  // should see the recorded value.
  const t2 = makeTracker(store);
  await t2.ensureHydrated("s1");
  assert.equal(t2.snapshotFor("s1").perSession, 2);
});

test("tracker degrades gracefully when the store throws on set", async () => {
  const failingStore: StateStore = {
    get: async () => undefined,
    set: async () => {
      throw new Error("disk full");
    },
    listSessionIds: async () => [],
  };
  const t = makeTracker(failingStore);
  // In-memory state should still advance even when persistence fails.
  const snap = t.applyUsageUpdate("s1", usage(4));
  assert.equal(snap.perSession, 4);
  await settle(); // let the failed persistOne log-and-swallow
});

test("tracker degrades gracefully when hydrateAll fails to list sessions", async () => {
  const failingStore: StateStore = {
    get: async () => undefined,
    set: async () => undefined,
    listSessionIds: async () => {
      throw new Error("connection refused");
    },
  };
  const t = makeTracker(failingStore);
  // hydrateAll should NOT throw; the tracker just doesn't pre-populate.
  await t.hydrateAll();
  const snap = t.applyUsageUpdate("s1", usage(2));
  assert.equal(snap.perSession, 2, "lazy load still works after failed hydrate");
});
