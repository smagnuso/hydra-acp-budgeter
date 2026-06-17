import type { CostAggregate, AggregateRow, TimeBucket, Group } from "./aggregate.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options controlling how renderText formats its output. */
export interface RenderOptions {
  /** Show an ASCII histogram bar next to each row/bucket. Default: false. */
  histogram?: boolean;
  /** When true, bars and values use tokens instead of $. Default: false. */
  tokens?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers — pure formatting, no I/O
// ---------------------------------------------------------------------------

/** Extract the display label from either an AggregateRow or TimeBucket. */
function getItemLabel(item: AggregateRow | TimeBucket): string {
  return "label" in item ? item.label : item.bucket;
}

function humanizeTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }

  let v: number;
  let suffix: string;

  if (n < 1_000_000) {
    v = n / 1000;
    suffix = "k";
  } else if (n < 1_000_000_000) {
    v = n / 1_000_000;
    suffix = "M";
  } else {
    v = n / 1_000_000_000;
    suffix = "B";
  }

  const formatted = v % 1 === 0 ? v.toFixed(0) : v.toFixed(2);
  return formatted.replace(/\.?0+$/, "") + suffix;
}

// ---------------------------------------------------------------------------
// Histogram bar renderer
// ---------------------------------------------------------------------------

function renderBars(
  values: number[],
  maxBarWidth: number,
): string[] {
  let maxValue = 0;

  for (const v of values) {
    if (v > maxValue) {
      maxValue = v;
    }
  }

  if (maxValue <= 0 || maxBarWidth <= 0) {
    return values.map(() => "");
  }

  const barWidth = Math.max(1, maxBarWidth);

  const bars: string[] = [];

  for (const v of values) {
    const ratio = v / maxValue;
    const fill = Math.round(ratio * barWidth);
    const empty = barWidth - fill;
    bars.push("\u2588".repeat(fill) + "\u2591".repeat(empty));
  }

  return bars;
}

// ---------------------------------------------------------------------------
// renderText
// ---------------------------------------------------------------------------

/**
 * Render a CostAggregate as plain text suitable for terminal display.
 *
 * Output structure:
 *   1. Headline — "Total: $X across N sessions"
 *   2. Separator line
 *   3. Grouped table or time-bucketed list
 *      - With histogram: label + bar
 *      - Without histogram: label | cost | tokens (side-by-side when token data present)
 *
 * No ANSI color codes — output is greppable and pipeable.
 */
export function renderText(agg: CostAggregate, opts: RenderOptions = {}): string {
  const terminalWidth = process.stdout.columns ?? 80;
  const showHistogram = opts.histogram === true;
  const useTokens = opts.tokens === true;

  // Build headline
  let out = "";

  if (agg.kind === "total") {
    const totalStr = formatCost(agg.row.costAmount);
    const n = agg.row.sessionCount;
    const scope = n !== undefined ? `${n} session${n === 1 ? "" : "s"}` : (agg.row.label ?? "all sessions");
    out += `Total: ${totalStr} across ${scope}\n`;
  } else if (agg.kind === "grouped") {
    const totalCost = sumGroupCosts(agg.groups);
    const totalStr = formatCost(totalCost);
    out += `Total: ${totalStr} across ${agg.groups.length} group(s)\n`;
  } else if (agg.kind === "timeSeries") {
    const totalCost = agg.timeSeries.reduce((s, b) => s + b.costAmount, 0);
    const totalStr = formatCost(totalCost);
    out += `Total: ${totalStr} across ${agg.timeSeries.length} period(s)\n`;
  } else if (agg.kind === "timeSeriesGrouped") {
    const totalCost = sumGroupCosts(agg.groups);
    const totalStr = formatCost(totalCost);
    out += `Total: ${totalStr} across ${agg.groups.length} group(s)\n`;
  }

  out += "─".repeat(terminalWidth) + "\n";

  // Render content based on aggregate kind
  if (agg.kind === "grouped") {
    for (const group of agg.groups) {
      out += `\n${group.label}:\n`;
      const rows = group.items;
      const hasTokenData = rows.some((r) => r.inputTokens !== undefined || r.outputTokens !== undefined);

      if (showHistogram) {
        out += renderGroupHistogram(rows, terminalWidth, useTokens);
      } else {
        out += renderTableRows(rows, hasTokenData, useTokens);
      }
    }
  } else if (agg.kind === "timeSeries") {
    const hasTokenData = agg.timeSeries.some((b) => b.inputTokens !== undefined || b.outputTokens !== undefined);

    if (showHistogram) {
      out += renderGroupHistogram(agg.timeSeries, terminalWidth, useTokens);
    } else {
      out += renderTableRows(agg.timeSeries, hasTokenData, useTokens);
    }
  } else if (agg.kind === "timeSeriesGrouped") {
    for (const group of agg.groups) {
      out += `\n${group.label}:\n`;
      const hasTokenData = group.items.some((b) => b.inputTokens !== undefined || b.outputTokens !== undefined);

      if (showHistogram) {
        out += renderGroupHistogram(group.items, terminalWidth, useTokens);
      } else {
        out += renderTableRows(group.items, hasTokenData, useTokens);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Histogram rendering for a group of items (AggregateRow or TimeBucket)
// ---------------------------------------------------------------------------

function renderGroupHistogram(
  items: (AggregateRow | TimeBucket)[],
  terminalWidth: number,
  useTokens: boolean,
): string {
  if (items.length === 0) {
    return "  (no data)\n";
  }

  // Find max label length for column alignment
  let maxLabelLen = 0;

  for (const item of items) {
    const label = getItemLabel(item);
    if (label.length > maxLabelLen) {
      maxLabelLen = label.length;
    }
  }

  const values = items.map((item) => {
    return useTokens ? tokenSum(item) : item.costAmount;
  });

  const valueStrs = values.map((v) => {
    return useTokens ? humanizeTokens(v) : formatCost(v);
  });

  let maxValueLen = 0;
  for (const s of valueStrs) {
    if (s.length > maxValueLen) {
      maxValueLen = s.length;
    }
  }

  const countStrs = items.map((item) => {
    const n = (item as { sessionCount?: number }).sessionCount;
    if (n === undefined) {
      return "";
    }
    return `${n} session${n === 1 ? "" : "s"}`;
  });

  let maxCountLen = 0;
  for (const s of countStrs) {
    if (s.length > maxCountLen) {
      maxCountLen = s.length;
    }
  }

  const countCol = maxCountLen > 0 ? maxCountLen + 2 : 0;

  // Layout: "  <label>  <value>  <bar>  <count>  \n"
  // 2-space left gutter + 2-space right gutter.
  let barWidth = terminalWidth - maxLabelLen - maxValueLen - countCol - 8;
  if (barWidth < 1) {
    barWidth = items.length > 1 ? 1 : 0;
  }

  const bars = renderBars(values, barWidth);
  const out: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (item === undefined) {
      continue;
    }

    const label = getItemLabel(item).padEnd(maxLabelLen);
    const value = valueStrs[i].padStart(maxValueLen);
    let line = `  ${label}  ${value}  ${bars[i]}`;
    if (maxCountLen > 0) {
      line += `  ${countStrs[i].padStart(maxCountLen)}`;
    }
    out.push(line + "\n");
  }

  return out.join("");
}

// ---------------------------------------------------------------------------
// Table rendering for a group of rows/buckets (non-histogram path)
// ---------------------------------------------------------------------------

function renderTableRows(
  items: (AggregateRow | TimeBucket)[],
  hasTokenData: boolean,
  useTokens: boolean,
): string {
  if (items.length === 0) {
    return "  (no data)\n";
  }

  // Compute max label length for column alignment
  let maxLabelLen = 28;

  for (const item of items) {
    const label = getItemLabel(item);
    if (label.length > maxLabelLen) {
      maxLabelLen = label.length;
    }
  }

  // Header
  let out = "  ";
  out += padRight("Label", maxLabelLen);
  out += "  ";

  if (useTokens) {
    out += "       Tokens";
  } else {
    out += "      Cost";
    if (hasTokenData) {
      out += "          Tokens";
    }
  }

  out += "\n";

  // Data rows
  for (const item of items) {
    const label = getItemLabel(item).padEnd(maxLabelLen);
    let line = "  ";
    line += label;
    line += "  ";

    if (useTokens) {
      const tokens = tokenSum(item);
      line += humanizeTokens(tokens).padStart(12);
    } else {
      const cost = item.costAmount ?? 0;
      line += formatCost(cost).padStart(10);

      if (hasTokenData) {
        const tokens = tokenSum(item);
        line += "  ".padStart(2);
        line += humanizeTokens(tokens).padStart(12);
      }
    }

    out += line + "\n";
  }

  return out;
}

// ---------------------------------------------------------------------------
// renderJson
// ---------------------------------------------------------------------------

/**
 * Render a CostAggregate as a JSON string with a stable key order.
 *
 * Output shape — keys appear in this order:
 *   {
 *     kind: "total" | "grouped" | "timeSeries" | "timeSeriesGrouped",
 *     currency: string,
 *     // total:
 *     row?: { label, costAmount, deltaCost?, inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens? },
 *     // grouped / timeSeriesGrouped:
 *     groups?: [{ label, items: [{ label/bucket, costAmount, deltaCost?, inputTokens?, outputTokens?, ... }] }],
 *     // timeSeries:
 *     timeSeries?: [{ bucket, costAmount, deltaCost, inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens? }]
 *   }
 *
 * Groups are sorted by label for deterministic output.
 */
export function renderJson(agg: CostAggregate): string {
  const result: Record<string, unknown> = {
    kind: agg.kind,
    currency: agg.currency,
  };

  if (agg.kind === "total") {
    result.row = serializeRow(agg.row);
  } else if (agg.kind === "grouped") {
    const groups = agg.groups.slice().sort((a, b) => a.label.localeCompare(b.label));
    result.groups = groups.map((g) => ({
      label: g.label,
      items: g.items.map(serializeRow),
    }));
  } else if (agg.kind === "timeSeries") {
    result.timeSeries = agg.timeSeries.map(serializeBucket);
  } else if (agg.kind === "timeSeriesGrouped") {
    const groups = agg.groups.slice().sort((a, b) => a.label.localeCompare(b.label));
    result.groups = groups.map((g) => ({
      label: g.label,
      items: g.items.map(serializeBucket),
    }));
  }

  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeRow(row: AggregateRow): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    label: row.label,
    costAmount: row.costAmount,
  };

  if (row.deltaCost !== undefined) {
    obj.deltaCost = row.deltaCost;
  }

  if (row.inputTokens !== undefined) {
    obj.inputTokens = row.inputTokens;
  }

  if (row.outputTokens !== undefined) {
    obj.outputTokens = row.outputTokens;
  }

  if (row.cacheReadTokens !== undefined) {
    obj.cacheReadTokens = row.cacheReadTokens;
  }

  if (row.cacheWriteTokens !== undefined) {
    obj.cacheWriteTokens = row.cacheWriteTokens;
  }

  return obj;
}

function serializeBucket(bucket: TimeBucket): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    bucket: bucket.bucket,
    costAmount: bucket.costAmount,
    deltaCost: bucket.deltaCost,
  };

  if (bucket.inputTokens !== undefined) {
    obj.inputTokens = bucket.inputTokens;
  }

  if (bucket.outputTokens !== undefined) {
    obj.outputTokens = bucket.outputTokens;
  }

  if (bucket.cacheReadTokens !== undefined) {
    obj.cacheReadTokens = bucket.cacheReadTokens;
  }

  if (bucket.cacheWriteTokens !== undefined) {
    obj.cacheWriteTokens = bucket.cacheWriteTokens;
  }

  return obj;
}

// ---------------------------------------------------------------------------
// Formatting utilities
// ---------------------------------------------------------------------------

function formatCost(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function tokenSum(row: AggregateRow | TimeBucket): number {
  let total = 0;

  if (row.inputTokens !== undefined) {
    total += row.inputTokens;
  }

  if (row.outputTokens !== undefined) {
    total += row.outputTokens;
  }

  return total;
}

function padRight(s: string, width: number): string {
  if (s.length >= width) {
    return s;
  }

  return s + " ".repeat(width - s.length);
}

function sumGroupCosts(groups: Group<AggregateRow | TimeBucket>[]): number {
  let total = 0;

  for (const group of groups) {
    for (const item of group.items) {
      total += item.costAmount;
    }
  }

  return total;
}


