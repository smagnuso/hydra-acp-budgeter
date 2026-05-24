import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostTracker, deleteStateFile } from "../src/tracker.js";

function makeTracker() {
  return new CostTracker({ softLimit: 5, hardLimit: 10, currency: "USD" });
}

function makePersistedTracker(statePath: string) {
  return new CostTracker({
    softLimit: 5,
    hardLimit: 10,
    currency: "USD",
    statePath,
  });
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

test("applyUsageUpdate persists per-session cost to the state file", () => {
  const dir = mkdtempSync(join(tmpdir(), "budgeter-state-"));
  try {
    const path = join(dir, "state.json");
    const t = makePersistedTracker(path);
    t.applyUsageUpdate("s1", usage(3));
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as {
      version: number;
      sessions: Record<string, { cost: number }>;
    };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.sessions.s1!.cost, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh tracker loads persisted state from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "budgeter-state-"));
  try {
    const path = join(dir, "state.json");
    const t1 = makePersistedTracker(path);
    t1.applyUsageUpdate("s1", usage(4));
    t1.applyUsageUpdate("s2", usage(3));
    const t2 = makePersistedTracker(path);
    assert.equal(t2.snapshotFor("s1").total, 7);
    assert.equal(t2.snapshotFor("s1").state, "soft");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reset on persisted tracker rewrites file with empty sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "budgeter-state-"));
  try {
    const path = join(dir, "state.json");
    const t = makePersistedTracker(path);
    t.applyUsageUpdate("s1", usage(3));
    t.reset();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      sessions: Record<string, unknown>;
    };
    assert.deepEqual(parsed.sessions, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adoptFromDisk picks up an externally deleted state file as a reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "budgeter-state-"));
  try {
    const path = join(dir, "state.json");
    const t = makePersistedTracker(path);
    t.applyUsageUpdate("s1", usage(7));
    assert.equal(t.snapshotFor("s1").total, 7);
    unlinkSync(path);
    const adopted = t.adoptFromDisk();
    assert.equal(adopted, true);
    assert.equal(t.snapshotFor("s1").total, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adoptFromDisk picks up externally rewritten state", () => {
  const dir = mkdtempSync(join(tmpdir(), "budgeter-state-"));
  try {
    const path = join(dir, "state.json");
    const t = makePersistedTracker(path);
    t.applyUsageUpdate("s1", usage(2));
    const overwritten = {
      version: 1,
      sessions: { s1: { cost: 8, currency: "USD" } },
    };
    writeFileSync(path, JSON.stringify(overwritten), "utf8");
    const adopted = t.adoptFromDisk();
    assert.equal(adopted, true);
    assert.equal(t.snapshotFor("s1").total, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adoptFromDisk leaves currentState unchanged so consumeStateTransition detects the crossing", () => {
  const dir = mkdtempSync(join(tmpdir(), "budgeter-state-"));
  try {
    const path = join(dir, "state.json");
    const t = makePersistedTracker(path);
    t.applyUsageUpdate("s1", usage(2));
    assert.equal(t.consumeStateTransition(), undefined);
    // External edit bumps total above soft limit.
    const overwritten = { version: 1, sessions: { s1: { cost: 7, currency: "USD" } } };
    writeFileSync(path, JSON.stringify(overwritten), "utf8");
    t.adoptFromDisk();
    assert.equal(t.snapshotFor("s1").total, 7);
    // currentState was NOT advanced — consumeStateTransition should detect ok→soft.
    assert.equal(t.consumeStateTransition(), "soft");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adoptFromDisk is a no-op when the file matches what we wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "budgeter-state-"));
  try {
    const path = join(dir, "state.json");
    const t = makePersistedTracker(path);
    t.applyUsageUpdate("s1", usage(4));
    const adopted = t.adoptFromDisk();
    assert.equal(adopted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteStateFile returns true on a present file, false on a missing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "budgeter-state-"));
  try {
    const path = join(dir, "state.json");
    writeFileSync(path, "{}", "utf8");
    assert.equal(deleteStateFile(path), true);
    assert.equal(deleteStateFile(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
