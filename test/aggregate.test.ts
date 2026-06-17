import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseSince, applyFilters, aggregate, type AggregateOptions, type FilterOptions, type CostEvent } from "../src/cost/aggregate.js";
import type { SessionRecord } from "../src/cost/session-store.js";

function makeSession(overrides: Partial<SessionRecord> & { sessionId?: string }): SessionRecord {
  const cwd = "cwd" in overrides ? overrides.cwd : "/home/user/projects/myapp";
  const agentId = "agentId" in overrides ? overrides.agentId : "agent_a";
  const model = "model" in overrides ? overrides.model : "claude-sonnet-4-20250514";
  const interactive = "interactive" in overrides ? overrides.interactive : true;
  const costAmount = typeof overrides.costAmount === "number" ? overrides.costAmount : 1.0;
  const costCurrency = "costCurrency" in overrides ? overrides.costCurrency : "USD";
  const contextTokens = typeof overrides.contextTokens === "number" ? overrides.contextTokens : 1000;
  const title = "title" in overrides ? overrides.title : "Test session";
  const createdAt = "createdAt" in overrides ? overrides.createdAt : "2025-01-01T00:00:00.000Z";
  const updatedAt = "updatedAt" in overrides ? overrides.updatedAt : "2026-06-16T00:00:00.000Z";
  return {
    sessionId: overrides.sessionId ?? "sess_001",
    cwd, agentId, model, interactive, costAmount, costCurrency, contextTokens, title, createdAt, updatedAt,
  };
}

function makeEvent(overrides: Partial<CostEvent>): CostEvent {
  return {
    sessionId: overrides.sessionId ?? "sess_001",
    ts: overrides.ts ?? "2026-06-15T12:00:00.000Z",
    deltaCost: typeof overrides.deltaCost === "number" ? overrides.deltaCost : 0.1,
    cumulativeCost: typeof overrides.cumulativeCost === "number" ? overrides.cumulativeCost : 1.0,
    currency: overrides.currency as string | undefined,
    ...(overrides.inputTokens !== undefined && { inputTokens: overrides.inputTokens }),
    ...(overrides.outputTokens !== undefined && { outputTokens: overrides.outputTokens }),
  };
}

test("parseSince handles relative durations: d, h, w, m, y", () => {
  const d7 = parseSince("7d");
  assert.ok(d7 instanceof Date);
  assert.ok(!Number.isNaN(d7.getTime()));
  const h24 = parseSince("24h"); assert.ok(h24 instanceof Date);
  const w2 = parseSince("2w"); assert.ok(w2 instanceof Date);
  const m1 = parseSince("1m"); assert.ok(m1 instanceof Date);
  const y1 = parseSince("1y"); assert.ok(y1 instanceof Date);
  assert.ok(parseSince("7D") instanceof Date);
});

test("parseSince handles ISO date strings", () => {
  const result = parseSince("2024-03-15T10:30:00.000Z");
  assert.equal(result.toISOString(), "2024-03-15T10:30:00.000Z");
});

test("parseSince throws on invalid spec", () => {
  assert.throws(() => parseSince("not-a-date"), /invalid since spec/);
  assert.throws(() => parseSince(""), /invalid since spec/);
});

test("applyFilters drops sessions before since date", () => {
  const records = [
    makeSession({ sessionId: "a", updatedAt: "2025-01-01T00:00:00.000Z" }),
    makeSession({ sessionId: "b", updatedAt: "2026-06-16T00:00:00.000Z" }),
    makeSession({ sessionId: "c", updatedAt: "2025-03-01T00:00:00.000Z" }),
  ];
  const result = applyFilters(records, { since: new Date("2025-04-01T00:00:00.000Z") });
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, "b");
});

test("applyFilters dir prefix-match with trailing-slash safety", () => {
  const records = [
    makeSession({ sessionId: "a", cwd: "/home/user/projects/myapp" }),
    makeSession({ sessionId: "b", cwd: "/home/user/projects/myapp-other" }),
    makeSession({ sessionId: "c", cwd: "/home/user/projects/myapp/sub/deep" }),
    makeSession({ sessionId: "d", cwd: undefined }),
  ];
  const result = applyFilters(records, { dir: "/home/user/projects/myapp" });
  assert.equal(result.length, 2);
  assert.ok(result.some(r => r.sessionId === "a"));
  assert.ok(result.some(r => r.sessionId === "c"));
  assert.ok(!result.some(r => r.sessionId === "b"));
  assert.ok(!result.some(r => r.sessionId === "d"));
});

test("applyFilters exact dir match", () => {
  const result = applyFilters([makeSession({ sessionId: "a", cwd: "/home/user/projects/myapp" })], { dir: "/home/user/projects/myapp" });
  assert.equal(result.length, 1);
});

test("applyFilters interactive filter", () => {
  const records = [makeSession({ sessionId: "a", interactive: true }), makeSession({ sessionId: "b", interactive: false }), makeSession({ sessionId: "c", interactive: true })];
  let r = applyFilters(records, { interactive: false });
  assert.equal(r.length, 1); assert.equal(r[0].sessionId, "b");
  r = applyFilters(records, { interactive: true });
  assert.equal(r.length, 2);
});

test("applyFilters combines all filters", () => {
  const records = [
    makeSession({ sessionId: "a", cwd: "/home/user/projects/myapp", updatedAt: "2025-01-01T00:00:00.000Z", interactive: true }),
    makeSession({ sessionId: "b", cwd: "/home/user/projects/myapp", updatedAt: "2026-06-16T00:00:00.000Z", interactive: false }),
    makeSession({ sessionId: "c", cwd: "/home/user/projects/other", updatedAt: "2026-06-16T00:00:00.000Z", interactive: true }),
  ];
  const result = applyFilters(records, { since: new Date("2025-04-01T00:00:00.000Z"), dir: "/home/user/projects/myapp", interactive: false });
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, "b");
});

test("aggregate fast path: sums costAmount from records only", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 1.5 }), makeSession({ sessionId: "b", costAmount: 2.5 }), makeSession({ sessionId: "c", costAmount: 0.5 })], undefined, {});
  assert.equal(result.kind, "total");
  assert.equal((result as any).row.costAmount, 4.5);
  assert.equal((result as any).currency, "USD");
});

test("aggregate fast path ignores events", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 10 })], [makeEvent({ sessionId: "a", deltaCost: 999 })], {});
  assert.equal(result.kind, "total");
  assert.equal((result as any).row.costAmount, 10);
});

test("aggregate with --since: sums costAmount + deltaCost", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 1.0, updatedAt: "2026-06-16T00:00:00.000Z" }), makeSession({ sessionId: "b", costAmount: 2.0, updatedAt: "2024-01-01T00:00:00.000Z" })], [makeEvent({ sessionId: "a", deltaCost: 0.3, ts: "2026-06-15T12:00:00.000Z" })], { since: new Date("2025-04-01T00:00:00.000Z") });
  assert.equal(result.kind, "total");
  assert.equal((result as any).row.costAmount, 1.0);
  assert.equal((result as any).row.deltaCost, 0.3);
});

test("aggregate with --since and --tokens: includes token totals", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 1.0, updatedAt: "2026-06-16T00:00:00.000Z" })], [makeEvent({ sessionId: "a", deltaCost: 0.1, ts: "2026-06-15T12:00:00.000Z", inputTokens: 1000, outputTokens: 500 }), makeEvent({ sessionId: "a", deltaCost: 0.2, ts: "2026-06-14T12:00:00.000Z", inputTokens: 2000, outputTokens: 1000 })], { since: new Date("2025-04-01T00:00:00.000Z"), tokens: true });
  assert.equal(result.kind, "total");
  assert.equal((result as any).row.inputTokens, 3000);
  assert.equal((result as any).row.outputTokens, 1500);
});

test("aggregate grouped by dir: creates kind=grouped output", () => {
  const result = aggregate([makeSession({ sessionId: "a", cwd: "/home/user/projects/myapp", costAmount: 1.0 }), makeSession({ sessionId: "b", cwd: "/home/user/projects/other", costAmount: 2.0 })], undefined, { by: "dir" });
  assert.equal(result.kind, "grouped");
});

test("aggregate grouped by dir: unknown cwd lands in <unknown>", () => {
  const result = aggregate([makeSession({ sessionId: "a", cwd: undefined, costAmount: 1.0 }), makeSession({ sessionId: "b", cwd: "/home/user/projects/myapp", costAmount: 2.0 })], undefined, { by: "dir" });
  assert.equal(result.kind, "grouped");
  const grouped = result as Extract<typeof result, { kind: "grouped" }>;
  assert.ok(grouped.groups.some(g => g.label === "<unknown>"));
});

test("aggregate grouped by session", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 1.0 }), makeSession({ sessionId: "b", costAmount: 2.0 })], undefined, { by: "session" });
  assert.equal(result.kind, "grouped");
  const grouped = result as Extract<typeof result, { kind: "grouped" }>;
  assert.equal(grouped.groups.length, 2);
  assert.ok(grouped.groups.some(g => g.label === "a"));
  assert.ok(grouped.groups.some(g => g.label === "b"));
});

test("aggregate grouped by model", () => {
  const result = aggregate([makeSession({ sessionId: "a", model: "claude-sonnet-4-20250514", costAmount: 1.0 }), makeSession({ sessionId: "b", model: "gpt-4o", costAmount: 2.0 }), makeSession({ sessionId: "c", model: "claude-sonnet-4-20250514", costAmount: 3.0 })], undefined, { by: "model" });
  assert.equal(result.kind, "grouped");
  const grouped = result as Extract<typeof result, { kind: "grouped" }>;
  assert.equal(grouped.groups.length, 2);
  const sg = grouped.groups.find(g => g.label === "claude-sonnet-4-20250514");
  assert.ok(sg); assert.equal(sg!.items[0].costAmount, 4.0);
});

test("aggregate grouped by agent", () => {
  const result = aggregate([makeSession({ sessionId: "a", agentId: "agent_x", costAmount: 1.0 }), makeSession({ sessionId: "b", agentId: "agent_y", costAmount: 2.0 })], undefined, { by: "agent" });
  assert.equal(result.kind, "grouped");
  const grouped = result as Extract<typeof result, { kind: "grouped" }>;
  assert.equal(grouped.groups.length, 2);
});

test("aggregate grouped with --tokens: includes token totals from events", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 1.0, contextTokens: 0 }), makeSession({ sessionId: "b", costAmount: 2.0, contextTokens: 0 })], [makeEvent({ sessionId: "a", deltaCost: 0.1, ts: "2026-06-15T12:00:00.000Z", inputTokens: 100 }), makeEvent({ sessionId: "b", deltaCost: 0.2, ts: "2026-06-14T13:00:00.000Z", inputTokens: 200 })], { by: "session", tokens: true, min: -1 });
  assert.equal(result.kind, "grouped");
  const grouped = result as Extract<typeof result, { kind: "grouped" }>;
  const a = grouped.groups.find(g => g.label === "a");
  assert.ok(a);
  assert.equal(a!.items[0].costAmount, 1.0);
  assert.equal(a!.items[0].deltaCost, 0.1);
  assert.equal(a!.items[0].inputTokens, 100);
  const b = grouped.groups.find(g => g.label === "b");
  assert.ok(b);
  assert.equal(b!.items[0].costAmount, 2.0);
  assert.equal(b!.items[0].deltaCost, 0.2);
  assert.equal(b!.items[0].inputTokens, 200);
});

test("aggregate grouped with depth: rolls up directory paths", () => {
  const result = aggregate([makeSession({ sessionId: "a", cwd: "/home/user/projects/myapp/src", costAmount: 1.0 }), makeSession({ sessionId: "b", cwd: "/home/user/projects/other", costAmount: 2.0 })], undefined, { by: "dir", depth: 1 });
  assert.equal(result.kind, "grouped");
});

test("aggregate grouped with --dir: grouping root matches filter root", () => {
  const result = aggregate([makeSession({ sessionId: "a", cwd: "/home/user/projects/myapp/src", costAmount: 1.0 })], undefined, { by: "dir", dir: "/home/user/projects" });
  assert.equal(result.kind, "grouped");
});

test("aggregate grouped by model with empty model lands in <unknown>", () => {
  const result = aggregate([makeSession({ sessionId: "a", model: "", costAmount: 1.0 }), makeSession({ sessionId: "b", model: "gpt-4o", costAmount: 2.0 })], undefined, { by: "model" });
  assert.equal(result.kind, "grouped");
  const grouped = result as Extract<typeof result, { kind: "grouped" }>;
  const ug = grouped.groups.find(g => g.label === "<unknown>");
  assert.ok(ug); assert.equal(ug!.items[0].costAmount, 1.0);
});

test("aggregate grouped by agent with empty agentId lands in <unknown>", () => {
  const result = aggregate([makeSession({ sessionId: "a", agentId: "", costAmount: 1.0 }), makeSession({ sessionId: "b", agentId: "agent_x", costAmount: 2.0 })], undefined, { by: "agent" });
  assert.equal(result.kind, "grouped");
  const grouped = result as Extract<typeof result, { kind: "grouped" }>;
  const ug = grouped.groups.find(g => g.label === "<unknown>");
  assert.ok(ug);
});

test("aggregate with --bucket day: creates kind=timeSeries output", () => {
  const result = aggregate([
    makeSession({ sessionId: "a", costAmount: 1.0, updatedAt: "2026-06-15T12:00:00.000Z" }),
    makeSession({ sessionId: "b", costAmount: 2.5, updatedAt: "2026-06-14T18:00:00.000Z" }),
  ], undefined, { bucket: "day" });
  assert.equal(result.kind, "timeSeries");
  const ts = result as Extract<typeof result, { kind: "timeSeries" }>;
  assert.equal(ts.timeSeries.length, 2);
  for (const bucket of ts.timeSeries) { assert.equal(bucket.costAmount, bucket.deltaCost); }
});

test("aggregate with --bucket week: groups by ISO week", () => {
  const result = aggregate([
    makeSession({ sessionId: "a", costAmount: 1.0, updatedAt: "2026-06-15T12:00:00.000Z" }),
    makeSession({ sessionId: "b", costAmount: 2.0, updatedAt: "2026-06-17T12:00:00.000Z" }),
  ], undefined, { bucket: "week" });
  assert.equal(result.kind, "timeSeries");
  const ts = result as Extract<typeof result, { kind: "timeSeries" }>;
  assert.equal(ts.timeSeries.length, 1);
});

test("aggregate with --bucket month: groups by calendar month", () => {
  const result = aggregate([
    makeSession({ sessionId: "a", costAmount: 1.0, updatedAt: "2026-06-01T12:00:00.000Z" }),
    makeSession({ sessionId: "b", costAmount: 2.0, updatedAt: "2026-07-15T12:00:00.000Z" }),
  ], undefined, { bucket: "month" });
  assert.equal(result.kind, "timeSeries");
  const ts = result as Extract<typeof result, { kind: "timeSeries" }>;
  assert.equal(ts.timeSeries.length, 2);
});

test("aggregate with --bucket sorts time series by bucket key", () => {
  const result = aggregate([
    makeSession({ sessionId: "a", costAmount: 0.3, updatedAt: "2026-06-15T12:00:00.000Z" }),
    makeSession({ sessionId: "b", costAmount: 0.1, updatedAt: "2026-06-13T12:00:00.000Z" }),
    makeSession({ sessionId: "c", costAmount: 0.2, updatedAt: "2026-06-14T12:00:00.000Z" }),
  ], undefined, { bucket: "day" });
  assert.equal(result.kind, "timeSeries");
  const ts = result as Extract<typeof result, { kind: "timeSeries" }>;
  assert.equal(ts.timeSeries.length, 3);
  assert.ok(ts.timeSeries[0].bucket <= ts.timeSeries[1].bucket);
  assert.ok(ts.timeSeries[1].bucket <= ts.timeSeries[2].bucket);
});

test("aggregate with --by session + --bucket day: creates kind=timeSeriesGrouped", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 1.0 }), makeSession({ sessionId: "b", costAmount: 2.0 })], [makeEvent({ sessionId: "a", deltaCost: 0.1, ts: "2026-06-15T12:00:00.000Z" }), makeEvent({ sessionId: "b", deltaCost: 0.2, ts: "2026-06-15T13:00:00.000Z" }), makeEvent({ sessionId: "a", deltaCost: 0.3, ts: "2026-06-14T12:00:00.000Z" })], { by: "session", bucket: "day" });
  assert.equal(result.kind, "timeSeriesGrouped");
  const tsg = result as Extract<typeof result, { kind: "timeSeriesGrouped" }>;
  assert.ok(tsg.groups.length >= 1);
  for (const group of tsg.groups) {
    assert.ok(group.items.length > 0);
    for (const bucket of group.items) { assert.equal(bucket.costAmount, bucket.deltaCost); }
  }
});

test("aggregate with --by session + --bucket day: sessions without cwd still appear", () => {
  const result = aggregate([makeSession({ sessionId: "a", cwd: undefined, costAmount: 1.0 }), makeSession({ sessionId: "b", cwd: "/home/user/projects/myapp", costAmount: 2.0 })], [makeEvent({ sessionId: "a", deltaCost: 0.1, ts: "2026-06-15T12:00:00.000Z" }), makeEvent({ sessionId: "b", deltaCost: 0.2, ts: "2026-06-15T13:00:00.000Z" })], { by: "session", bucket: "day" });
  assert.equal(result.kind, "timeSeriesGrouped");
  const tsg = result as Extract<typeof result, { kind: "timeSeriesGrouped" }>;
  assert.ok(tsg.groups.some(g => g.label === "a"));
  assert.ok(tsg.groups.some(g => g.label === "b"));
});

test("aggregate infers --since when --bucket day without explicit --since", () => {
  const recent = new Date();
  recent.setDate(recent.getDate() - 5);
  const result = aggregate([
    makeSession({ sessionId: "old", costAmount: 10.0, updatedAt: "2024-01-01T00:00:00.000Z" }),
    makeSession({ sessionId: "new", costAmount: 5.0, updatedAt: recent.toISOString() }),
  ], undefined, { bucket: "day" });
  assert.equal(result.kind, "timeSeries");
  const ts = result as Extract<typeof result, { kind: "timeSeries" }>;
  const total = ts.timeSeries.reduce((sum, b) => sum + b.costAmount, 0);
  assert.equal(total, 5.0);
});

test("aggregate propagates currency from records", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 1.0, costCurrency: "USD" })], undefined, {});
  assert.equal((result as any).currency, "USD");
});

test("aggregate propagates currency from events when present (non-empty)", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 1.0 })], [{ ...makeEvent({ sessionId: "a", deltaCost: 0.1 }), currency: "EUR" }], { bucket: "day" });
  assert.equal((result as any).currency, "EUR");
});

test("aggregate with empty records returns total with zero cost", () => {
  const result = aggregate([], undefined, {});
  assert.equal(result.kind, "total");
  assert.equal((result as any).row.costAmount, 0);
});

test("aggregate with filtered-out records returns total with zero cost", () => {
  const result = aggregate([makeSession({ sessionId: "a", updatedAt: "2024-01-01T00:00:00.000Z" })], undefined, { since: new Date("2025-06-01T00:00:00.000Z") });
  assert.equal(result.kind, "total");
  assert.equal((result as any).row.costAmount, 0);
});

test("aggregate with --dir filter excludes sessions outside dir", () => {
  const result = aggregate([makeSession({ sessionId: "a", cwd: "/home/user/projects/myapp", costAmount: 1.0 }), makeSession({ sessionId: "b", cwd: "/home/user/other", costAmount: 2.0 })], undefined, { dir: "/home/user/projects" });
  assert.equal(result.kind, "total");
  assert.equal((result as any).row.costAmount, 1.0);
});

test("aggregate with --interactive filter", () => {
  const result = aggregate([makeSession({ sessionId: "a", interactive: true, costAmount: 1.0 }), makeSession({ sessionId: "b", interactive: false, costAmount: 2.0 })], undefined, { interactive: false });
  assert.equal(result.kind, "total");
  assert.equal((result as any).row.costAmount, 2.0);
});

test("aggregate with --no-interactive filter", () => {
  const result = aggregate([makeSession({ sessionId: "a", interactive: true, costAmount: 1.0 }), makeSession({ sessionId: "b", interactive: false, costAmount: 2.0 })], undefined, { interactive: true });
  assert.equal(result.kind, "total");
  assert.equal((result as any).row.costAmount, 1.0);
});

test("aggregate grouped uses deltaCost from events when available", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 10.0 })], [makeEvent({ sessionId: "a", deltaCost: 0.5, ts: "2026-06-15T12:00:00.000Z" })], { by: "session" });
  assert.equal(result.kind, "grouped");
  const grouped = result as Extract<typeof result, { kind: "grouped" }>;
  const sg = grouped.groups.find(g => g.label === "a");
  assert.ok(sg); assert.equal(sg!.items[0].costAmount, 10.0); assert.equal(sg!.items[0].deltaCost, 0.5);
});

test("aggregate grouped: sessions without events still appear with costAmount", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 1.0 })], undefined, { by: "session" });
  assert.equal(result.kind, "grouped");
  const grouped = result as Extract<typeof result, { kind: "grouped" }>;
  const sg = grouped.groups.find(g => g.label === "a");
  assert.ok(sg); assert.equal(sg!.items[0].costAmount, 1.0);
  assert.ok(sg!.items[0].deltaCost === undefined || sg!.items[0].deltaCost === 0);
});

test("aggregate timeSeries: bucket is taken from session updatedAt (no events needed)", () => {
  const result = aggregate([makeSession({ sessionId: "a", costAmount: 1.0, updatedAt: "2026-06-15T12:00:00.000Z" })], undefined, { bucket: "day" });
  assert.equal(result.kind, "timeSeries");
  const ts = result as Extract<typeof result, { kind: "timeSeries" }>;
  assert.equal(ts.timeSeries.length, 1);
  assert.equal(ts.timeSeries[0].costAmount, 1.0);
});

test("applyFilters dir prefix-match: ~/dev/hydra-acp does not match ~/dev/hydra-acp-other", () => {
  const records = [
    makeSession({ sessionId: "a", cwd: "/home/user/dev/hydra-acp" }),
    makeSession({ sessionId: "b", cwd: "/home/user/dev/hydra-acp-other" }),
    makeSession({ sessionId: "c", cwd: "/home/user/dev/hydra-acp/src" }),
    makeSession({ sessionId: "d", cwd: "/home/user/dev/hydra-acp-tools" }),
  ];
  const result = applyFilters(records, { dir: "/home/user/dev/hydra-acp" });
  assert.equal(result.length, 2);
  assert.ok(result.some(r => r.sessionId === "a"));
  assert.ok(result.some(r => r.sessionId === "c"));
  assert.ok(!result.some(r => r.sessionId === "b"));
  assert.ok(!result.some(r => r.sessionId === "d"));
});

test("aggregate fast path: events array is not consumed when no since/bucket/filter", () => {
  const events = [
    makeEvent({ sessionId: "a", deltaCost: 999, ts: "2026-06-15T12:00:00.000Z" }),
    makeEvent({ sessionId: "a", deltaCost: 888, ts: "2026-06-14T12:00:00.000Z" }),
  ];

  const result = aggregate(
    [makeSession({ sessionId: "a", costAmount: 5.0 })],
    events,
    {},
  );

  assert.equal(result.kind, "total");
  assert.equal((result as any).row.costAmount, 5.0);
  // Fast path does NOT include deltaCost — it sums from records only
  assert.equal((result as any).row.deltaCost, undefined);
});

test("aggregate fast path: events with tokens are not consumed when no since/bucket/filter", () => {
  const events = [
    makeEvent({ sessionId: "a", deltaCost: 1.0, ts: "2026-06-15T12:00:00.000Z", inputTokens: 10000, outputTokens: 5000 }),
  ];

  const result = aggregate(
    [makeSession({ sessionId: "a", costAmount: 3.0 })],
    events,
    {},
  );

  assert.equal(result.kind, "total");
  assert.equal((result as any).row.costAmount, 3.0);
  // Fast path ignores token data entirely
  assert.equal((result as any).row.inputTokens, undefined);
  assert.equal((result as any).row.outputTokens, undefined);
});

test("aggregate fast path: multiple sessions with events still returns record-only totals", () => {
  const events = [
    makeEvent({ sessionId: "a", deltaCost: 100, ts: "2026-06-15T12:00:00.000Z" }),
    makeEvent({ sessionId: "b", deltaCost: 200, ts: "2026-06-14T12:00:00.000Z" }),
    makeEvent({ sessionId: "c", deltaCost: 300, ts: "2026-06-13T12:00:00.000Z" }),
  ];

  const result = aggregate(
    [
      makeSession({ sessionId: "a", costAmount: 1.0 }),
      makeSession({ sessionId: "b", costAmount: 2.0 }),
      makeSession({ sessionId: "c", costAmount: 3.0 }),
    ],
    events,
    {},
  );

  assert.equal(result.kind, "total");
  // All three sessions summed from meta.json only
  assert.equal((result as any).row.costAmount, 6.0);
});
