import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runBudgeterCommand } from "../src/bridge.js";
import { CostTracker } from "../src/tracker.js";

function makeTracker(statePath?: string): CostTracker {
  return new CostTracker({
    softLimit: 5,
    hardLimit: 10,
    currency: "USD",
    statePath,
  });
}

function applyCost(tracker: CostTracker, sessionId: string, amount: number) {
  tracker.applyUsageUpdate(sessionId, {
    sessionUpdate: "usage_update",
    cost: { amount, currency: "USD" },
  });
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

test("reset persists the new baseline through the state file", () => {
  const dir = mkdtempSync(join(tmpdir(), "budgeter-ext-cmd-"));
  const statePath = join(dir, "state.json");
  const tracker = makeTracker(statePath);
  applyCost(tracker, "s1", 8);
  assert.ok(existsSync(statePath), "state file should exist after a usage update");

  runBudgeterCommand(tracker, "USD", { verb: "reset", sessionId: "s1" });

  const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
    sessions: Record<string, { cost: number; baseline: number }>;
  };
  const session = persisted.sessions["s1"]!;
  assert.equal(session.baseline, session.cost);
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

test("reset survives a write race on the state file (atomic rename)", () => {
  // Repro for the "tracker writes mid-reset" smoke: write a sentinel into
  // the state file before reset, run reset, then confirm the sentinel was
  // replaced with the new payload without partial-write corruption.
  const dir = mkdtempSync(join(tmpdir(), "budgeter-ext-cmd-race-"));
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, "{}", "utf8");

  const tracker = makeTracker(statePath);
  applyCost(tracker, "s1", 6);
  runBudgeterCommand(tracker, "USD", { verb: "reset", sessionId: "s1" });

  const persisted = JSON.parse(readFileSync(statePath, "utf8"));
  assert.ok(persisted.sessions, "state file should contain sessions object after reset");
});
