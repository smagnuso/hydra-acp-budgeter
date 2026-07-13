import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runBudgeterCommand } from "../src/bridge.js";
import {
  CostTracker,
  type PerSessionState,
  type StateStore,
} from "../src/tracker.js";

// Minimal in-memory store for tests that exercise reset persistence
// through the new extension_state path.
class MemoryStore implements StateStore {
  readonly data = new Map<string, PerSessionState>();
  async get(sessionId: string): Promise<PerSessionState | undefined> {
    return this.data.get(sessionId);
  }
  async set(sessionId: string, state: PerSessionState): Promise<void> {
    this.data.set(sessionId, state);
  }
  async listSessionIds(): Promise<string[]> {
    return [...this.data.keys()];
  }
}

function makeTracker(store?: StateStore): CostTracker {
  return new CostTracker({
    softLimit: 5,
    hardLimit: 10,
    currency: "USD",
    ...(store ? { store } : {}),
  });
}

function applyCost(tracker: CostTracker, sessionId: string, amount: number) {
  tracker.applyUsageUpdate(sessionId, {
    sessionUpdate: "usage_update",
    cost: { amount, currency: "USD" },
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

test("reset baselines spend to zero and returns a confirmation", () => {
  const tracker = makeTracker();
  applyCost(tracker, "s1", 7);
  assert.equal(tracker.snapshotFor("s1").total, 7);

  const outcome = runBudgeterCommand(tracker, "USD", {
    verb: "reset",
    sessionId: "s1",
  });
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") {
    return;
  }
  assert.match(outcome.text, /spend reset/);
  // Reset baselines from current cost, so effective total drops to 0.
  assert.equal(tracker.snapshotFor("s1").total, 0);
});

test("reset persists the new baseline through the store (extension_state)", async () => {
  const store = new MemoryStore();
  const tracker = makeTracker(store);
  applyCost(tracker, "s1", 8);
  await settle();

  runBudgeterCommand(tracker, "USD", { verb: "reset", sessionId: "s1" });
  await settle();

  // After reset, the store has baseline == cost so a fresh tracker
  // hydrating this session reads a total of zero.
  const persisted = store.data.get("s1");
  assert.ok(persisted, "store should have s1 after reset");
  assert.equal(persisted!.baseline, persisted!.cost);
});

test("status reports per-session and total spend against soft/hard limits", () => {
  const tracker = makeTracker();
  applyCost(tracker, "s1", 3);
  applyCost(tracker, "s2", 4);

  const outcome = runBudgeterCommand(tracker, "USD", {
    verb: "status",
    sessionId: "s1",
  });
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") {
    return;
  }
  assert.match(outcome.text, /total 7\.00 USD/);
  assert.match(outcome.text, /this session 3\.00/);
  assert.match(outcome.text, /soft 5/);
  assert.match(outcome.text, /hard 10/);
});

test("unknown verbs return an error outcome instead of throwing", () => {
  const tracker = makeTracker();
  const outcome = runBudgeterCommand(tracker, "USD", {
    verb: "vaporize",
    sessionId: "s1",
  });
  assert.equal(outcome.kind, "error");
  if (outcome.kind !== "error") {
    return;
  }
  assert.match(outcome.message, /unknown verb: vaporize/);
});
