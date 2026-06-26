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
  /** When true, bars and values use net lines of code (added − removed)
   * instead of $ or tokens. Mutually exclusive with `tokens`. */
  loc?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers — pure formatting, no I/O
// ---------------------------------------------------------------------------

/** Extract the display label from either an AggregateRow or TimeBucket. */
function getItemLabel(item: AggregateRow | TimeBucket): string {
  return "label" in item ? item.label : item.bucket;
}

// Format a list of session counts so numbers right-align in one column
// and the word "session"/"sessions" left-aligns in the next, padded to a
// consistent overall width. Indices missing a count produce "".
function formatSessionCounts(
  counts: (number | undefined)[],
): { strs: string[]; width: number } {
  let maxNumLen = 0;
  let anyPlural = false;

  for (const n of counts) {
    if (n === undefined) {
      continue;
    }
    const nStr = String(n);
    if (nStr.length > maxNumLen) {
      maxNumLen = nStr.length;
    }
    if (n !== 1) {
      anyPlural = true;
    }
  }

  const wordWidth = anyPlural ? "sessions".length : "session".length;
  const strs = counts.map((n) => {
    if (n === undefined) {
      return "";
    }
    const num = String(n).padStart(maxNumLen);
    const word = (n === 1 ? "session" : "sessions").padEnd(wordWidth);
    return `${num} ${word}`;
  });

  const width = maxNumLen + 1 + wordWidth;
  return { strs, width };
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
  const useLoc = opts.loc === true;

  let out = "";

  const sessionsScope = (n: number): string => {
    return `${n} session${n === 1 ? "" : "s"}`;
  };

  const headlineTotal = (cost: number, rowsForLoc: (AggregateRow | TimeBucket)[]): string => {
    if (useLoc) {
      let net = 0;
      for (const it of rowsForLoc) {
        net += netLoc(it);
      }
      return `${formatLoc(net)} lines`;
    }
    return formatCost(cost);
  };

  if (agg.kind === "total") {
    const n = agg.row.sessionCount;
    const scope = n !== undefined ? sessionsScope(n) : (agg.row.label ?? "all sessions");
    out += `Total: ${headlineTotal(agg.row.costAmount, [agg.row])} across ${scope}\n`;
  } else if (agg.kind === "grouped") {
    const flatItems: AggregateRow[] = [];
    let n = 0;
    for (const g of agg.groups) {
      for (const it of g.items) {
        flatItems.push(it);
        n += it.sessionCount ?? 0;
      }
    }
    if (agg.totalSessions !== undefined) {
      n = agg.totalSessions;
    }
    const totalCost = sumGroupCosts(agg.groups);
    out += `Total: ${headlineTotal(totalCost, flatItems)} across ${sessionsScope(n)}\n`;
  } else if (agg.kind === "timeSeries") {
    const totalCost = agg.timeSeries.reduce((s, b) => s + b.costAmount, 0);
    const n = agg.timeSeries.reduce((s, b) => s + (b.sessionCount ?? 0), 0);
    out += `Total: ${headlineTotal(totalCost, agg.timeSeries)} across ${sessionsScope(n)}\n`;
  } else if (agg.kind === "timeSeriesGrouped") {
    const flatItems: TimeBucket[] = [];
    let n = 0;
    for (const g of agg.groups) {
      for (const it of g.items) {
        flatItems.push(it);
        n += it.sessionCount ?? 0;
      }
    }
    if (agg.totalSessions !== undefined) {
      n = agg.totalSessions;
    }
    const totalCost = sumGroupCosts(agg.groups);
    out += `Total: ${headlineTotal(totalCost, flatItems)} across ${sessionsScope(n)}\n`;
  }


  // Render content based on aggregate kind
  if (agg.kind === "grouped") {
    // Most --by queries produce one row per group; flatten so we get one
    // line per group instead of a per-group sub-table.
    const allSingleton = agg.groups.every((g) => g.items.length === 1);

    if (allSingleton) {
      const flattened: AggregateRow[] = [];

      for (const group of agg.groups) {
        const item = group.items[0];
        if (item === undefined) {
          continue;
        }
        flattened.push({ ...item, label: group.label });
      }

      flattened.sort((a, b) => {
        const av = valueOf(a, useTokens, useLoc);
        const bv = valueOf(b, useTokens, useLoc);
        return bv - av;
      });

      if (showHistogram) {
        out += renderGroupHistogram(flattened, terminalWidth, useTokens, useLoc);
      } else {
        out += renderFlatGroupedList(flattened, useTokens, useLoc);
      }
    } else {
      for (const group of agg.groups) {
        out += `\n${group.label}:\n`;
        const rows = group.items;
        const hasTokenData = rows.some((r) => r.inputTokens !== undefined || r.outputTokens !== undefined);

        if (showHistogram) {
          out += renderGroupHistogram(rows, terminalWidth, useTokens, useLoc);
        } else {
          out += renderTableRows(rows, hasTokenData, useTokens, useLoc);
        }
      }
    }
  } else if (agg.kind === "timeSeries") {
    const hasTokenData = agg.timeSeries.some((b) => b.inputTokens !== undefined || b.outputTokens !== undefined);

    if (showHistogram) {
      out += renderGroupHistogram(agg.timeSeries, terminalWidth, useTokens, useLoc);
    } else {
      out += renderTableRows(agg.timeSeries, hasTokenData, useTokens, useLoc);
    }
  } else if (agg.kind === "timeSeriesGrouped") {
    for (const group of agg.groups) {
      out += `\n${group.label}:\n`;
      const hasTokenData = group.items.some((b) => b.inputTokens !== undefined || b.outputTokens !== undefined);

      if (showHistogram) {
        out += renderGroupHistogram(group.items, terminalWidth, useTokens, useLoc);
      } else {
        out += renderTableRows(group.items, hasTokenData, useTokens, useLoc);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Histogram rendering for a group of items (AggregateRow or TimeBucket)
// ---------------------------------------------------------------------------

// Flat one-line-per-group rendering: `  label    $cost    N sessions`
function valueOf(item: AggregateRow | TimeBucket, useTokens: boolean, useLoc: boolean): number {
  if (useLoc) return netLoc(item);
  if (useTokens) return tokenSum(item);
  return item.costAmount;
}

function formatValue(item: AggregateRow | TimeBucket, useTokens: boolean, useLoc: boolean): string {
  if (useLoc) return formatLoc(netLoc(item));
  if (useTokens) return humanizeTokens(tokenSum(item));
  return formatCost(item.costAmount);
}

function renderFlatGroupedList(
  rows: AggregateRow[],
  useTokens: boolean,
  useLoc: boolean,
): string {
  if (rows.length === 0) {
    return "  (no data)\n";
  }

  let maxLabelLen = 0;
  for (const r of rows) {
    if (r.label.length > maxLabelLen) {
      maxLabelLen = r.label.length;
    }
  }

  const valueStrs = rows.map((r) => formatValue(r, useTokens, useLoc));

  let maxValueLen = 0;
  for (const s of valueStrs) {
    if (s.length > maxValueLen) {
      maxValueLen = s.length;
    }
  }

  const { strs: countStrs, width: countWidth } = formatSessionCounts(
    rows.map((r) => r.sessionCount),
  );

  const out: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r === undefined) {
      continue;
    }
    const valueStr = valueStrs[i] ?? "";
    let line = `  ${r.label.padEnd(maxLabelLen)}  ${valueStr.padStart(maxValueLen)}`;
    if (countWidth > 0) {
      line += `  ${countStrs[i]}`;
    }
    out.push(line + "\n");
  }

  return out.join("");
}

function renderGroupHistogram(
  items: (AggregateRow | TimeBucket)[],
  terminalWidth: number,
  useTokens: boolean,
  useLoc: boolean,
): string {
  if (items.length === 0) {
    return "  (no data)\n";
  }

  let maxLabelLen = 0;

  for (const item of items) {
    const label = getItemLabel(item);
    if (label.length > maxLabelLen) {
      maxLabelLen = label.length;
    }
  }

  // For LOC bars we use absolute net (net removals show as bars too, but
  // sign is preserved in the text column). For cost/tokens, raw value.
  const values = items.map((item) => {
    const v = valueOf(item, useTokens, useLoc);
    return useLoc ? Math.abs(v) : v;
  });

  const valueStrs = items.map((item) => formatValue(item, useTokens, useLoc));

  let maxValueLen = 0;
  for (const s of valueStrs) {
    if (s.length > maxValueLen) {
      maxValueLen = s.length;
    }
  }

  const { strs: countStrs, width: countWidth } = formatSessionCounts(
    items.map((it) => (it as { sessionCount?: number }).sessionCount),
  );

  const countCol = countWidth > 0 ? countWidth + 2 : 0;

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
    const value = (valueStrs[i] ?? "").padStart(maxValueLen);
    let line = `  ${label}  ${value}  ${bars[i] ?? ""}`;
    if (countWidth > 0) {
      line += `  ${countStrs[i]}`;
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
  useLoc: boolean,
): string {
  if (items.length === 0) {
    return "  (no data)\n";
  }

  let maxLabelLen = 28;

  for (const item of items) {
    const label = getItemLabel(item);
    if (label.length > maxLabelLen) {
      maxLabelLen = label.length;
    }
  }

  let out = "  ";
  out += padRight("", maxLabelLen);
  out += "  ";

  if (useLoc) {
    out += "    +Added   -Removed     Net";
  } else if (useTokens) {
    out += "       Tokens";
  } else {
    out += "      Cost";
    if (hasTokenData) {
      out += "          Tokens";
    }
  }

  out += "\n";

  for (const item of items) {
    const label = getItemLabel(item).padEnd(maxLabelLen);
    let line = "  ";
    line += label;
    line += "  ";

    if (useLoc) {
      const added = item.linesAdded ?? 0;
      const removed = item.linesRemoved ?? 0;
      line += added.toLocaleString().padStart(10);
      line += "  ";
      line += removed.toLocaleString().padStart(8);
      line += "  ";
      line += formatLoc(added - removed).padStart(8);
    } else if (useTokens) {
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

  if (row.linesAdded !== undefined) {
    obj.linesAdded = row.linesAdded;
  }

  if (row.linesRemoved !== undefined) {
    obj.linesRemoved = row.linesRemoved;
  }

  if (row.linesAdded !== undefined || row.linesRemoved !== undefined) {
    obj.linesNet = (row.linesAdded ?? 0) - (row.linesRemoved ?? 0);
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

  if (bucket.linesAdded !== undefined) {
    obj.linesAdded = bucket.linesAdded;
  }

  if (bucket.linesRemoved !== undefined) {
    obj.linesRemoved = bucket.linesRemoved;
  }

  if (bucket.linesAdded !== undefined || bucket.linesRemoved !== undefined) {
    obj.linesNet = (bucket.linesAdded ?? 0) - (bucket.linesRemoved ?? 0);
  }

  return obj;
}

// ---------------------------------------------------------------------------
// Formatting utilities
// ---------------------------------------------------------------------------

function formatCost(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function netLoc(row: AggregateRow | TimeBucket): number {
  const added = row.linesAdded ?? 0;
  const removed = row.linesRemoved ?? 0;
  return added - removed;
}

function formatLoc(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString()}`;
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


