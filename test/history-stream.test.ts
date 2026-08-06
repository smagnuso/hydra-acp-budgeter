import { strict as assert } from "node:assert";
import { test, afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { SessionRecord } from "../src/cost/session-store.js";
import { streamHistoryEvents } from "../src/cost/history-stream.js";

function createTempSessionStore(): string {
  const base = mkdtempSync(resolve(tmpdir(), "budgeter-history-stream-"));
  const sessionsPath = resolve(base, "sessions");
  mkdirSync(sessionsPath, { recursive: true });
  return sessionsPath;
}

function writeMeta(sessionsPath: string, sessionId: string): SessionRecord {
  const sessionDir = resolve(sessionsPath, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(resolve(sessionDir, "meta.json"), JSON.stringify({
    sessionId,
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    currentModel: "claude-sonnet-4-20250514",
    interactive: true,
    currentUsage: { costAmount: 0, costCurrency: "USD" },
    title: "Test session",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
  }));
  return {
    sessionId,
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    model: "claude-sonnet-4-20250514",
    interactive: true,
    costAmount: 0,
    costCurrency: "USD",
    title: "Test session",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
  };
}

function writeHistory(sessionsPath: string, sessionId: string, lines: string[]): void {
  const sessionDir = resolve(sessionsPath, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(resolve(sessionDir, "history.jsonl"), lines.map(l => l + "\n").join(""));
}

async function collectEvents(sessions: SessionRecord | SessionRecord[]): Promise<any[]> {
  const events = [];
  for await (const ev of streamHistoryEvents(sessions)) {
    events.push(ev);
  }
  return events;
}

let tempBase: string | null = null;

afterEach(() => {
  if (tempBase !== null) {
    rmSync(tempBase, { recursive: true, force: true });
    tempBase = null;
    delete process.env.HYDRA_ACP_HOME;
  }
});

function setupTemp(): string {
  if (tempBase === null) {
    tempBase = createTempSessionStore();
    // streamHistoryEvents uses sessionsDir() which reads HYDRA_ACP_HOME
    process.env.HYDRA_ACP_HOME = tempBase;
  }
  return resolve(tempBase, "sessions");
}

test("streamHistoryEvents yields events from normal cost progression", async () => {
  const sessionsPath = setupTemp();
  const session = writeMeta(sessionsPath, "sess_normal");

  writeHistory(sessionsPath, "sess_normal", [
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 0.1, currency: "USD" } } },
      recordedAt: "2026-06-15T10:00:00.000Z",
    }),
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 0.3, currency: "USD" } } },
      recordedAt: "2026-06-15T11:00:00.000Z",
    }),
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 0.8, currency: "USD" } } },
      recordedAt: "2026-06-15T12:00:00.000Z",
    }),
  ]);

  const events = await collectEvents(session);
  assert.equal(events.length, 3);
  assert.equal(events[0].deltaCost, 0.1);
  assert.equal(events[0].cumulativeCost, 0.1);
  assert.ok(Math.abs(events[1].deltaCost - 0.2) < 0.0001);
  assert.equal(events[1].cumulativeCost, 0.3);
  assert.ok(Math.abs(events[2].deltaCost - 0.5) < 0.0001);
  assert.equal(events[2].cumulativeCost, 0.8);
});

test("streamHistoryEvents clamps delta at zero on agent resurrection (cost drop)", async () => {
  const sessionsPath = setupTemp();
  const session = writeMeta(sessionsPath, "sess_resurrect");

  // Simulate an agent that accumulated cost, then resurrected (agent reset),
  // so cumulative cost drops back down before climbing again.
  writeHistory(sessionsPath, "sess_resurrect", [
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 5.0, currency: "USD" } } },
      recordedAt: "2026-06-15T10:00:00.000Z",
    }),
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 8.0, currency: "USD" } } },
      recordedAt: "2026-06-15T11:00:00.000Z",
    }),
    // Agent resurrects — cumulative resets to 0.2 (first usage after restart)
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 0.2, currency: "USD" } } },
      recordedAt: "2026-06-15T14:00:00.000Z",
    }),
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 1.5, currency: "USD" } } },
      recordedAt: "2026-06-15T15:00:00.000Z",
    }),
  ]);

  const events = await collectEvents(session);
  assert.equal(events.length, 4);
  // Normal climb: 5.0 -> delta=5.0
  assert.equal(events[0].deltaCost, 5.0);
  assert.equal(events[0].cumulativeCost, 5.0);
  // Normal climb: 8.0 -> delta=3.0
  assert.equal(events[1].deltaCost, 3.0);
  assert.equal(events[1].cumulativeCost, 8.0);
  // Resurrection: 0.2 < 8.0 -> delta clamped to 0
  assert.equal(events[2].deltaCost, 0);
  assert.equal(events[2].cumulativeCost, 0.2);
  // Normal climb after reset: 1.5 - 0.2 = 1.3
  assert.ok(Math.abs(events[3].deltaCost - 1.3) < 0.0001);
  assert.equal(events[3].cumulativeCost, 1.5);
});

// cost.amount is the collapsed lifetime total on every hydra wire shape
// (PROTOCOL.md "Cost ledger scope"). _meta["hydra-acp"].cumulativeCost has
// never been emitted by the daemon, and under the split ledger it would mean
// "retired agent lives only" — a component, not the total. Ignore it.
test("streamHistoryEvents ignores _meta.hydra-acp.cumulativeCost", async () => {
  const sessionsPath = setupTemp();
  const session = writeMeta(sessionsPath, "sess_cumulative_meta");

  // A stray _meta.cumulativeCost must not displace cost.amount.
  writeHistory(sessionsPath, "sess_cumulative_meta", [
    JSON.stringify({
      method: "session/update",
      params: { update: {
        sessionUpdate: "usage_update",
        cost: { amount: 0.1, currency: "USD" },
        _meta: { "hydra-acp": { cumulativeCost: 5.5 } },
      }},
      recordedAt: "2026-06-15T10:00:00.000Z",
    }),
    JSON.stringify({
      method: "session/update",
      params: { update: {
        sessionUpdate: "usage_update",
        cost: { amount: 0.2, currency: "USD" },
        _meta: { "hydra-acp": { cumulativeCost: 6.0 } },
      }},
      recordedAt: "2026-06-15T11:00:00.000Z",
    }),
  ]);

  const events = await collectEvents(session);
  assert.equal(events.length, 2);
  assert.equal(events[0].cumulativeCost, 0.1);
  assert.equal(events[0].deltaCost, 0.1);
  assert.equal(events[1].cumulativeCost, 0.2);
  assert.ok(Math.abs(events[1].deltaCost - 0.1) < 0.0001);
});

test("streamHistoryEvents skips non-usage_update events", async () => {
  const sessionsPath = setupTemp();
  const session = writeMeta(sessionsPath, "sess_skip");

  writeHistory(sessionsPath, "sess_skip", [
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 0.1, currency: "USD" } } },
      recordedAt: "2026-06-15T10:00:00.000Z",
    }),
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "prompt_request" } },
      recordedAt: "2026-06-15T10:30:00.000Z",
    }),
    JSON.stringify({
      method: "session/opened",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 999, currency: "USD" } } },
      recordedAt: "2026-06-15T10:45:00.000Z",
    }),
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 0.3, currency: "USD" } } },
      recordedAt: "2026-06-15T11:00:00.000Z",
    }),
  ]);

  const events = await collectEvents(session);
  assert.equal(events.length, 2);
  assert.equal(events[0].deltaCost, 0.1);
  assert.ok(Math.abs(events[1].deltaCost - 0.2) < 0.0001);
});

test("streamHistoryEvents skips malformed JSON lines", async () => {
  const sessionsPath = setupTemp();
  const session = writeMeta(sessionsPath, "sess_malformed");

  writeHistory(sessionsPath, "sess_malformed", [
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 0.1, currency: "USD" } } },
      recordedAt: "2026-06-15T10:00:00.000Z",
    }),
    "{this is not valid json}",
    "",
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 0.3, currency: "USD" } } },
      recordedAt: "2026-06-15T11:00:00.000Z",
    }),
  ]);

  const events = await collectEvents(session);
  assert.equal(events.length, 2);
  assert.equal(events[0].deltaCost, 0.1);
  assert.ok(Math.abs(events[1].deltaCost - 0.2) < 0.0001);
});

test("streamHistoryEvents yields no events when history.jsonl does not exist", async () => {
  const sessionsPath = setupTemp();
  const session = writeMeta(sessionsPath, "sess_no_history");
  // Do NOT create history.jsonl — only meta.json exists.

  const events = await collectEvents(session);
  assert.equal(events.length, 0);
});

test("streamHistoryEvents handles multiple sessions", async () => {
  const sessionsPath = setupTemp();
  const sessA = writeMeta(sessionsPath, "sess_multi_a");
  const sessB = writeMeta(sessionsPath, "sess_multi_b");

  writeHistory(sessionsPath, "sess_multi_a", [
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 1.0, currency: "USD" } } },
      recordedAt: "2026-06-15T10:00:00.000Z",
    }),
  ]);

  writeHistory(sessionsPath, "sess_multi_b", [
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 2.0, currency: "USD" } } },
      recordedAt: "2026-06-15T10:00:00.000Z",
    }),
  ]);

  const events = await collectEvents([sessA, sessB]);
  assert.equal(events.length, 2);
  assert.ok(events.some(e => e.sessionId === "sess_multi_a" && e.deltaCost === 1.0));
  assert.ok(events.some(e => e.sessionId === "sess_multi_b" && e.deltaCost === 2.0));
});

test("streamHistoryEvents includes token counts when present in usage", async () => {
  const sessionsPath = setupTemp();
  const session = writeMeta(sessionsPath, "sess_tokens");

  writeHistory(sessionsPath, "sess_tokens", [
    JSON.stringify({
      method: "session/update",
      params: { update: {
        sessionUpdate: "usage_update",
        cost: { amount: 0.5, currency: "USD" },
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 50,
        },
      }},
      recordedAt: "2026-06-15T10:00:00.000Z",
    }),
  ]);

  const events = await collectEvents(session);
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 1000);
  assert.equal(events[0].outputTokens, 500);
  assert.equal(events[0].cacheReadTokens, 200);
  assert.equal(events[0].cacheWriteTokens, 50);
});

test("streamHistoryEvents omits token fields when not present in usage", async () => {
  const sessionsPath = setupTemp();
  const session = writeMeta(sessionsPath, "sess_no_tokens");

  writeHistory(sessionsPath, "sess_no_tokens", [
    JSON.stringify({
      method: "session/update",
      params: { update: {
        sessionUpdate: "usage_update",
        cost: { amount: 0.5, currency: "USD" },
      }},
      recordedAt: "2026-06-15T10:00:00.000Z",
    }),
  ]);

  const events = await collectEvents(session);
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, undefined);
  assert.equal(events[0].outputTokens, undefined);
  assert.equal(events[0].cacheReadTokens, undefined);
  assert.equal(events[0].cacheWriteTokens, undefined);
});

test("streamHistoryEvents uses recordedAt as timestamp", async () => {
  const sessionsPath = setupTemp();
  const session = writeMeta(sessionsPath, "sess_ts");

  writeHistory(sessionsPath, "sess_ts", [
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 0.1, currency: "USD" } } },
      recordedAt: "2026-06-15T14:30:00.000Z",
    }),
  ]);

  const events = await collectEvents(session);
  assert.equal(events.length, 1);
  assert.equal(events[0].ts, "2026-06-15T14:30:00.000Z");
});

test("streamHistoryEvents currency propagates from cost.currency", async () => {
  const sessionsPath = setupTemp();
  const session = writeMeta(sessionsPath, "sess_eur");

  writeHistory(sessionsPath, "sess_eur", [
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", cost: { amount: 0.5, currency: "EUR" } } },
      recordedAt: "2026-06-15T10:00:00.000Z",
    }),
  ]);

  const events = await collectEvents(session);
  assert.equal(events.length, 1);
  assert.equal(events[0].currency, "EUR");
});
