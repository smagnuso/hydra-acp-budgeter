import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderText, renderJson, type RenderOptions } from "../src/cost/format.js";
import type { CostAggregate, AggregateRow, TimeBucket } from "../src/cost/aggregate.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTotal(opts: Partial<CostAggregate & { kind: "total" }> = {}): CostAggregate {
  return {
    kind: "total",
    row: opts.row ?? { label: "All sessions", costAmount: 4.56 },
    currency: opts.currency ?? "USD",
  };
}

function makeRow(overrides: Partial<AggregateRow> = {}): AggregateRow {
  return {
    label: overrides.label ?? "default",
    costAmount: overrides.costAmount ?? 1.0,
    deltaCost: overrides.deltaCost,
    inputTokens: overrides.inputTokens,
    outputTokens: overrides.outputTokens,
    cacheReadTokens: overrides.cacheReadTokens,
    cacheWriteTokens: overrides.cacheWriteTokens,
  };
}

function makeBucket(overrides: Partial<TimeBucket> = {}): TimeBucket {
  return {
    bucket: overrides.bucket ?? "01/01",
    costAmount: overrides.costAmount ?? 1.0,
    deltaCost: overrides.deltaCost ?? 1.0,
    inputTokens: overrides.inputTokens,
    outputTokens: overrides.outputTokens,
    cacheReadTokens: overrides.cacheReadTokens,
    cacheWriteTokens: overrides.cacheWriteTokens,
  };
}

// ---------------------------------------------------------------------------
// renderText — total kind
// ---------------------------------------------------------------------------

test("renderText total: shows headline with cost", () => {
  const agg = makeTotal({ row: { label: "All sessions", costAmount: 12.345 } });
  const result = renderText(agg);
  assert.ok(result.includes("Total: $12.35 across All sessions"));
});

test("renderText total: handles zero cost", () => {
  const agg = makeTotal({ row: { label: "None", costAmount: 0 } });
  const result = renderText(agg);
  assert.ok(result.includes("Total: $0.00 across None"));
});

test("renderText total: does not render a separator line", () => {
  const agg = makeTotal();
  const result = renderText(agg);
  assert.ok(!result.includes("\u2500"));
});

// ---------------------------------------------------------------------------
// renderText — grouped kind
// ---------------------------------------------------------------------------

function makeGrouped(opts: Partial<CostAggregate & { kind: "grouped" }> = {}): CostAggregate {
  return {
    kind: "grouped",
    groups: opts.groups ?? [
      { label: "myapp", items: [makeRow({ label: "sess_001", costAmount: 1.5 })] },
      { label: "other", items: [makeRow({ label: "sess_002", costAmount: 3.0 })] },
    ],
    currency: opts.currency ?? "USD",
  };
}

test("renderText grouped: shows headline with session count", () => {
  const agg = makeGrouped();
  const result = renderText(agg);
  assert.ok(/Total: \$4\.50 across \d+ sessions?/.test(result));
});

test("renderText grouped: lists group labels as flat rows", () => {
  const agg = makeGrouped();
  const result = renderText(agg);
  assert.ok(result.includes("myapp"));
  assert.ok(result.includes("other"));
});

test("renderText grouped: shows label and cost per row", () => {
  const agg = makeGrouped();
  const result = renderText(agg);
  assert.ok(result.includes("myapp"));
  assert.ok(result.includes("$1.50"));
  assert.ok(result.includes("other"));
  assert.ok(result.includes("$3.00"));
});

test("renderText grouped: shows token values when --tokens", () => {
  const agg: CostAggregate = {
    kind: "grouped",
    groups: [
      { label: "proj", items: [makeRow({ label: "s1", costAmount: 0.5, inputTokens: 142000 })] },
    ],
    currency: "USD",
  };
  const opts: RenderOptions = { tokens: true };
  const result = renderText(agg, opts);
  assert.ok(result.includes("142k"));
});

test("renderText grouped: cost-only by default even when token data is present", () => {
  const agg: CostAggregate = {
    kind: "grouped",
    groups: [
      { label: "proj", items: [makeRow({ label: "s1", costAmount: 0.5, inputTokens: 142000, outputTokens: 38100 })] },
    ],
    currency: "USD",
  };
  const result = renderText(agg);
  assert.ok(result.includes("$0.50"));
});

test("renderText grouped: handles <unknown> bucket label", () => {
  const agg: CostAggregate = {
    kind: "grouped",
    groups: [
      { label: "<unknown>", items: [makeRow({ label: "sess_no_cwd", costAmount: 2.0 })] },
    ],
    currency: "USD",
  };
  const result = renderText(agg);
  assert.ok(result.includes("<unknown>"));
});

// ---------------------------------------------------------------------------
// renderText — timeSeries kind
// ---------------------------------------------------------------------------

function makeTimeSeries(opts: Partial<CostAggregate & { kind: "timeSeries" }> = {}): CostAggregate {
  return {
    kind: "timeSeries",
    timeSeries: opts.timeSeries ?? [
      makeBucket({ bucket: "06/14", costAmount: 0.5, deltaCost: 0.5 }),
      makeBucket({ bucket: "06/15", costAmount: 1.0, deltaCost: 1.0 }),
    ],
    currency: opts.currency ?? "USD",
  };
}

test("renderText timeSeries: shows headline with session count", () => {
  const agg = makeTimeSeries();
  const result = renderText(agg);
  assert.ok(/Total: \$1\.50 across \d+ sessions?/.test(result));
});

test("renderText timeSeries: renders bucket labels and cost values", () => {
  const agg = makeTimeSeries();
  const result = renderText(agg);
  assert.ok(result.includes("06/14"));
  assert.ok(result.includes("06/15"));
  assert.ok(result.includes("$0.50"));
  assert.ok(result.includes("$1.00"));
});

// ---------------------------------------------------------------------------
// renderText — timeSeriesGrouped kind
// ---------------------------------------------------------------------------

function makeTimeSeriesGrouped(opts: Partial<CostAggregate & { kind: "timeSeriesGrouped" }> = {}): CostAggregate {
  return {
    kind: "timeSeriesGrouped",
    groups: opts.groups ?? [
      { label: "myapp", items: [makeBucket({ bucket: "06/14", costAmount: 0.3, deltaCost: 0.3 })] },
      { label: "other", items: [makeBucket({ bucket: "06/14", costAmount: 0.7, deltaCost: 0.7 })] },
    ],
    currency: opts.currency ?? "USD",
  };
}

test("renderText timeSeriesGrouped: shows group headers with buckets", () => {
  const agg = makeTimeSeriesGrouped();
  const result = renderText(agg);
  assert.ok(result.includes("\nmyapp:\n"));
  assert.ok(result.includes("\nother:\n"));
  assert.ok(result.includes("06/14"));
});

// ---------------------------------------------------------------------------
// Histogram rendering
// ---------------------------------------------------------------------------

test("renderText histogram: shows bar characters for grouped data", () => {
  const agg: CostAggregate = {
    kind: "grouped",
    groups: [
      { label: "proj", items: [makeRow({ label: "a", costAmount: 1.0 }), makeRow({ label: "b", costAmount: 3.0 })] },
    ],
    currency: "USD",
  };
  const opts: RenderOptions = { histogram: true };
  const result = renderText(agg, opts);
  assert.ok(result.includes("\u2588")); // fill character
  assert.ok(result.includes("\u2591")); // background character
});

test("renderText histogram: bars scale proportionally", () => {
  const agg: CostAggregate = {
    kind: "grouped",
    groups: [
      { label: "proj", items: [makeRow({ label: "x", costAmount: 1.0 }), makeRow({ label: "y", costAmount: 2.0 })] },
    ],
    currency: "USD",
  };
  const opts: RenderOptions = { histogram: true };
  const result = renderText(agg, opts);

  // Extract bar character counts per line by counting █ chars
  const lines = result.split("\n");
  let fills: number[] = [];

  for (const line of lines) {
    if (/^\s+/.test(line) && !line.includes("Total") && !line.includes("\u2500")) {
      const fillCount = (line.match(/\u2588/g) ?? []).length;
      fills.push(fillCount);
    }
  }

  // y's bar should be at least as long as x's (2.0 >= 1.0)
  assert.ok(fills.length >= 2, "Should have at least 2 data lines");
  assert.ok(fills[1] >= fills[0], `Bar for y (${fills[1]}) should be >= bar for x (${fills[0]})`);
});

test("renderText histogram: empty values produce empty bars", () => {
  const agg: CostAggregate = {
    kind: "grouped",
    groups: [
      { label: "proj", items: [makeRow({ label: "a", costAmount: 0 }), makeRow({ label: "b", costAmount: 0 })] },
    ],
    currency: "USD",
  };
  const opts: RenderOptions = { histogram: true };
  const result = renderText(agg, opts);
  // Bars should be empty when all values are zero
  assert.ok(!result.includes("\u2588"));
});

test("renderText histogram with --tokens: bars use token values", () => {
  const agg: CostAggregate = {
    kind: "grouped",
    groups: [
      { label: "proj", items: [makeRow({ label: "a", costAmount: 10, inputTokens: 1000 }), makeRow({ label: "b", costAmount: 5, inputTokens: 5000 })] },
    ],
    currency: "USD",
  };
  const opts: RenderOptions = { histogram: true, tokens: true };
  const result = renderText(agg, opts);

  // b has more tokens (5k vs 1k) so its bar should be longer
  const lines = result.split("\n");
  let fills: number[] = [];

  for (const line of lines) {
    if (/^\s+/.test(line) && !line.includes("Total") && !line.includes("\u2500")) {
      const fillCount = (line.match(/\u2588/g) ?? []).length;
      fills.push(fillCount);
    }
  }

  assert.ok(fills.length >= 2, "Should have at least 2 data lines");
  assert.ok(fills[1] > fills[0], `Bar for b (5k tokens, ${fills[1]}) should be longer than a (1k tokens, ${fills[0]})`);
});

// ---------------------------------------------------------------------------
// Number formatting helpers
// ---------------------------------------------------------------------------

test("renderText: humanizes token values correctly", () => {
  const agg: CostAggregate = {
    kind: "grouped",
    groups: [
      { label: "p", items: [makeRow({ label: "s", costAmount: 0.01, inputTokens: 999 })] },
    ],
    currency: "USD",
  };
  const opts: RenderOptions = { tokens: true };
  let result = renderText(agg, opts);
  assert.ok(result.includes("999"));

  agg.groups[0].items[0].inputTokens = 142000;
  result = renderText(agg, opts);
  assert.ok(result.includes("142k"));

  agg.groups[0].items[0].inputTokens = 3810000;
  result = renderText(agg, opts);
  assert.ok(result.includes("3.81M"));

  agg.groups[0].items[0].inputTokens = 1500000000;
  result = renderText(agg, opts);
  assert.ok(result.includes("1.5B"));

  // Test clean integer formatting
  agg.groups[0].items[0].inputTokens = 2000000;
  result = renderText(agg, opts);
  assert.ok(result.includes("2M"));
});

test("renderText: formats cost with 2 decimal places", () => {
  const agg = makeTotal({ row: { label: "X", costAmount: 1.2 } });
  const result = renderText(agg);
  assert.ok(result.includes("$1.20"));
});

// ---------------------------------------------------------------------------
// renderJson
// ---------------------------------------------------------------------------

test("renderJson total: produces stable shape with expected keys", () => {
  const agg = makeTotal({ row: { label: "All sessions", costAmount: 4.56, deltaCost: 0.3, inputTokens: 1000 } });
  const result = renderJson(agg);
  const parsed = JSON.parse(result);

  assert.equal(parsed.kind, "total");
  assert.equal(parsed.currency, "USD");
  assert.ok(parsed.row !== undefined);
  assert.equal(parsed.row.label, "All sessions");
  assert.equal(parsed.row.costAmount, 4.56);
  assert.equal(parsed.row.deltaCost, 0.3);
  assert.equal(parsed.row.inputTokens, 1000);
});

test("renderJson grouped: sorts groups by label", () => {
  const agg: CostAggregate = {
    kind: "grouped",
    groups: [
      { label: "zebra", items: [makeRow({ label: "s1", costAmount: 1.0 })] },
      { label: "alpha", items: [makeRow({ label: "s2", costAmount: 2.0 })] },
      { label: "middle", items: [makeRow({ label: "s3", costAmount: 3.0 })] },
    ],
    currency: "USD",
  };
  const result = renderJson(agg);
  const parsed = JSON.parse(result);

  assert.equal(parsed.groups.length, 3);
  assert.equal(parsed.groups[0].label, "alpha");
  assert.equal(parsed.groups[1].label, "middle");
  assert.equal(parsed.groups[2].label, "zebra");
});

test("renderJson timeSeries: preserves bucket order", () => {
  const agg = makeTimeSeries();
  const result = renderJson(agg);
  const parsed = JSON.parse(result);

  assert.ok(parsed.timeSeries !== undefined);
  assert.equal(parsed.timeSeries.length, 2);
  assert.equal(parsed.timeSeries[0].bucket, "06/14");
  assert.equal(parsed.timeSeries[1].bucket, "06/15");
});

test("renderJson timeSeriesGrouped: sorts groups by label", () => {
  const agg: CostAggregate = {
    kind: "timeSeriesGrouped",
    groups: [
      { label: "z-group", items: [makeBucket({ bucket: "01/01" })] },
      { label: "a-group", items: [makeBucket({ bucket: "01/01" })] },
    ],
    currency: "EUR",
  };
  const result = renderJson(agg);
  const parsed = JSON.parse(result);

  assert.equal(parsed.groups[0].label, "a-group");
  assert.equal(parsed.groups[1].label, "z-group");
});

test("renderJson: omits undefined optional fields", () => {
  const agg: CostAggregate = {
    kind: "total",
    row: { label: "X", costAmount: 1.0 },
    currency: "USD",
  };
  const result = renderJson(agg);
  const parsed = JSON.parse(result);

  assert.equal(parsed.row.deltaCost, undefined);
  assert.equal(parsed.row.inputTokens, undefined);
});

test("renderJson: includes all token fields when present", () => {
  const agg: CostAggregate = {
    kind: "total",
    row: {
      label: "X", costAmount: 1.0, deltaCost: 0.1,
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 10,
    },
    currency: "USD",
  };
  const result = renderJson(agg);
  const parsed = JSON.parse(result);

  assert.equal(parsed.row.inputTokens, 100);
  assert.equal(parsed.row.outputTokens, 50);
  assert.equal(parsed.row.cacheReadTokens, 30);
  assert.equal(parsed.row.cacheWriteTokens, 10);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("renderText: empty grouped data shows (no data)", () => {
  const agg: CostAggregate = {
    kind: "grouped",
    groups: [{ label: "empty", items: [] }],
    currency: "USD",
  };
  const result = renderText(agg);
  assert.ok(result.includes("(no data)"));
});

test("renderText: empty timeSeries shows (no data)", () => {
  const agg: CostAggregate = {
    kind: "timeSeries",
    timeSeries: [],
    currency: "USD",
  };
  const result = renderText(agg);
  assert.ok(result.includes("(no data)"));
});

test("renderText: output has no ANSI color codes", () => {
  const agg = makeTotal();
  const result = renderText(agg);
  // Check for common ANSI escape sequences
  assert.ok(!/\x1b\[[0-9;]*m/.test(result), "Output should not contain ANSI color codes");
});

test("renderText: output is plain ASCII + Unicode bars only", () => {
  const agg: CostAggregate = {
    kind: "grouped",
    groups: [{ label: "p", items: [makeRow({ label: "a", costAmount: 1.0, inputTokens: 5000 })] }],
    currency: "USD",
  };
  const result = renderText(agg);
  // Should only contain printable ASCII + the bar characters we use
  for (const ch of result) {
    const code = ch.charCodeAt(0);
    assert.ok(code < 128 || code === 0x2588 || code === 0x2591 || code === 0x2500, `Unexpected character: U+${code.toString(16).toUpperCase()}`);
  }
});
