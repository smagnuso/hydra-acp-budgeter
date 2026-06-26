import { relative, resolve } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import type { SessionRecord } from "./session-store.js";
import type { CostEvent, EditEvent } from "./history-stream.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Date bucket granularity. */
export type BucketSpec = "hour" | "day" | "week" | "month";

/** Relative-duration spec accepted by parseSince(). */
export type SinceSpec = string;

/** Grouping dimension for --by. */
export type GroupBy = "dir" | "session" | "model" | "agent" | "language";

// ---------------------------------------------------------------------------
// CostAggregate — expressive enough for T4 to render any output shape
// ---------------------------------------------------------------------------

/** A single row of aggregated cost data. */
export interface AggregateRow {
  label: string;
  costAmount: number;
  sessionCount?: number;
  deltaCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  linesAdded?: number;
  linesRemoved?: number;
}

/** A single bucket in a time-series output. */
export interface TimeBucket {
  bucket: string;
  costAmount: number;
  deltaCost: number;
  sessionCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  linesAdded?: number;
  linesRemoved?: number;
}

/** A group (e.g. a directory) containing either rows or time buckets. */
export interface Group<T> {
  label: string;
  items: T[];
}

/**
 * Discriminated union covering every output shape T4/T5 may need:
 *
 *   total             — single headline number (no grouping, no bucketing)
 *   grouped           — table of rows grouped by dir/session/model/agent
 *   timeSeries        — ungrouped time series (only --bucket, no --by)
 *   timeSeriesGrouped — grouped time series (--by + --bucket)
 */
export type CostAggregate =
  | { kind: "total"; row: AggregateRow; currency: string; totalSessions?: number }
  | { kind: "grouped"; groups: Group<AggregateRow>[]; currency: string; totalSessions?: number }
  | { kind: "timeSeries"; timeSeries: TimeBucket[]; currency: string; totalSessions?: number }
  | { kind: "timeSeriesGrouped"; groups: Group<TimeBucket>[]; currency: string; totalSessions?: number };

// ---------------------------------------------------------------------------
// parseSince
// ---------------------------------------------------------------------------

/**
 * Parse a since-spec into a Date.
 *
 * Accepts relative durations (7d, 24h, 2w, 1m, 1y) or ISO date strings.
 */
export function parseSince(spec: string): Date {
  const relMatch = spec.match(/^(\d+)\s*([dhmwy])$/i);

  if (relMatch !== null) {
    const amountStr = relMatch[1];
    const unitStr = relMatch[2];

    if (amountStr === undefined || unitStr === undefined) {
      const err = new Error(`invalid since spec: ${spec}`);
      throw err;
    }

    const amount = parseInt(amountStr, 10);
    const unit = unitStr.toLowerCase();

    const now = new Date();

    if (unit === "d") {
      now.setDate(now.getDate() - amount);
    } else if (unit === "h") {
      now.setHours(now.getHours() - amount);
    } else if (unit === "w") {
      now.setDate(now.getDate() - amount * 7);
    } else if (unit === "m") {
      now.setMonth(now.getMonth() - amount);
    } else if (unit === "y") {
      now.setFullYear(now.getFullYear() - amount);
    }

    return now;
  }

  const date = new Date(spec);

  if (Number.isNaN(date.getTime())) {
    const err = new Error(`invalid since spec: ${spec}`);
    throw err;
  }

  return date;
}

// ---------------------------------------------------------------------------
// FilterOptions — subset of AggregateOptions used by applyFilters
// ---------------------------------------------------------------------------

export interface FilterOptions {
  since?: Date;
  dir?: string;
  interactive?: boolean | undefined;
  /** Host filter, matching `hydra session list` semantics:
   *   "local"   — sessions created here OR imported and bound to a local
   *               agent (upstreamSessionId set). Default.
   *   "all"     — every session, no filter.
   *   <host>    — passive mirrors imported from <host> that haven't been
   *               attached locally yet.
   * Undefined behaves like "all" (no filtering) for backwards-compat with
   * callers that don't pass the option. */
  host?: string;
  /** Strict lower bound on the active metric. Sessions where the metric
   * value is <= min are dropped. Defaults to 0 — i.e. zero-value sessions
   * are excluded. Pass a negative number to include them. */
  min?: number;
  /** When true, the min threshold compares against contextTokens; else
   * against costAmount. "loc" compares against the session's net LOC
   * (sum over languages of added − removed). */
  minMetric?: "cost" | "tokens" | "loc";
}

function netLocForRecord(r: SessionRecord): number {
  const map = r.locByLanguage;
  if (map === undefined) {
    return 0;
  }
  let net = 0;
  for (const k of Object.keys(map)) {
    const v = map[k];
    if (v !== undefined) {
      net += v.added - v.removed;
    }
  }
  return net;
}

/** realpath normalization cache — shared across applyFilters calls. */
const _realpathCache = new Map<string, string>();

function realpathCached(path: string): string {
  if (_realpathCache.has(path)) {
    return _realpathCache.get(path) as string;
  }
  try {
    const result = realpathSync(path);
    _realpathCache.set(path, result);
    return result;
  } catch {
    _realpathCache.set(path, path);
    return path;
  }
}

/**
 * Apply filter predicates to session records.
 *
 * Drops sessions whose updatedAt precedes `since`, whose realpath cwd does
 * not prefix-match the `dir` filter (both sides realpath-normalized), and
 * (when explicitly set) filters on the interactive flag.
 */
export function applyFilters(
  records: SessionRecord[],
  opts: FilterOptions,
): SessionRecord[] {
  let result = records;

  if (opts.since !== undefined) {
    const sinceMs = opts.since.getTime();
    const filtered: SessionRecord[] = [];

    for (const r of result) {
      const updatedAtMs = new Date(r.updatedAt).getTime();

      if (updatedAtMs < sinceMs) {
        continue;
      }

      filtered.push(r);
    }

    result = filtered;
  }

  if (opts.dir !== undefined) {
    const filterRoot = realpathCached(resolve(opts.dir));

    const filtered: SessionRecord[] = [];

    for (const r of result) {
      if (r.cwd === undefined || r.cwd === "") {
        continue;
      }

      if (r.cwd.startsWith(filterRoot + "/") || r.cwd === filterRoot) {
        filtered.push(r);
      }
    }

    result = filtered;
  }

  if (opts.host !== undefined && opts.host !== "all") {
    const host = opts.host;
    const filtered: SessionRecord[] = [];
    for (const r of result) {
      if (host === "local") {
        if (!r.importedFromMachine || !!r.upstreamSessionId) {
          filtered.push(r);
        }
      } else {
        if (r.importedFromMachine === host && !r.upstreamSessionId) {
          filtered.push(r);
        }
      }
    }
    result = filtered;
  }

  if (opts.interactive !== undefined) {
    const want = opts.interactive;
    const filtered: SessionRecord[] = [];

    for (const r of result) {
      if (r.interactive === want) {
        filtered.push(r);
      }
    }

    result = filtered;
  }

  const min = opts.min ?? 0;
  const minFiltered: SessionRecord[] = [];

  for (const r of result) {
    let value: number;
    if (opts.minMetric === "tokens") {
      value = r.contextTokens;
    } else if (opts.minMetric === "loc") {
      value = netLocForRecord(r);
    } else {
      value = r.costAmount;
    }
    if (value > min) {
      minFiltered.push(r);
    }
  }

  return minFiltered;
}

// ---------------------------------------------------------------------------
// AggregateOptions — full option set for aggregate()
// ---------------------------------------------------------------------------

export interface AggregateOptions {
  by?: GroupBy;
  depth?: number;
  bucket?: BucketSpec;
  since?: Date;
  interactive?: boolean | undefined;
  dir?: string;
  tokens?: boolean;
  /** When true, the active metric is net lines of code rather than cost or
   * tokens. Mutually exclusive with `tokens`. Time-bucketed LOC is not
   * supported in this version — callers should reject the combination
   * before calling aggregate(). */
  loc?: boolean;
  min?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the root path used for directory grouping.
 *
 * When --dir is set, the filter root becomes the grouping root so that
 * depth-1 means one level below the filtered directory. Otherwise falls
 * back to $HOME.
 */
function resolveDirRoot(opts: AggregateOptions): string {
  if (opts.dir !== undefined) {
    return resolve(opts.dir);
  }

  return resolve(homedir());
}

/**
 * Compute a directory-group label for a session's cwd.
 *
 * When `depth` is undefined, returns the full cwd (with $HOME shortened to
 * `~`). When `depth` is a positive integer, takes the first `depth` path
 * segments below the grouping root.
 */
function dirGroupLabel(
  cwd: string | undefined,
  depth: number | undefined,
  root: string,
): string {
  if (cwd === undefined || cwd === "") {
    return "<unknown>";
  }

  const resolvedCwd = realpathCached(resolve(cwd));

  if (depth === undefined) {
    const home = realpathCached(resolve(homedir()));
    if (resolvedCwd === home) {
      return "~";
    }
    if (resolvedCwd.startsWith(home + "/")) {
      return "~/" + resolvedCwd.slice(home.length + 1);
    }
    return resolvedCwd;
  }

  const resolvedRoot = realpathCached(resolve(root));
  let relPath = relative(resolvedRoot, resolvedCwd);

  if (relPath === "" || relPath === ".") {
    return "<root>";
  }

  if (relPath.startsWith("..")) {
    return "<unknown>";
  }

  const parts = relPath.split("/");

  if (parts.length === 0) {
    return "<root>";
  }

  const take = Math.min(depth, parts.length);
  const selected = parts.slice(0, take);

  if (selected.length === 0) {
    return "<root>";
  }

  return selected.join("/");
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

/**
 * Aggregate session records into a CostAggregate.
 *
 * Fast path — when opts has no since/bucket/tokens/grouping/filtering, sums
 * from records.costAmount only and does NOT touch events.
 *
 * Slow path — collects history events for the survivor set to compute
 * per-session deltas, then groups or buckets those events.
 */
export function aggregate(
  records: SessionRecord[],
  events?: CostEvent[],
  opts: AggregateOptions = {},
  editEvents?: EditEvent[],
): CostAggregate {
  // Infer default since when bucketing is requested without explicit --since.
  let effectiveSince: Date | undefined = opts.since;

  if (effectiveSince === undefined && opts.bucket !== undefined) {
    const now = new Date();

    if (opts.bucket === "hour") {
      now.setHours(now.getHours() - 24);
      effectiveSince = now;
    } else if (opts.bucket === "day") {
      now.setDate(now.getDate() - 30);
      effectiveSince = now;
    } else if (opts.bucket === "week") {
      now.setMonth(now.getMonth() - 6);
      effectiveSince = now;
    } else if (opts.bucket === "month") {
      now.setFullYear(now.getFullYear() - 2);
      effectiveSince = now;
    }
  }

  // Slow path is needed when we have any filtering, bucketing, tokens, loc,
  // or grouping that requires event data or filtered record sets.
  const hasSlowPath =
    effectiveSince !== undefined ||
    opts.bucket !== undefined ||
    opts.tokens === true ||
    opts.loc === true ||
    opts.by !== undefined ||
    opts.dir !== undefined ||
    opts.interactive !== undefined;

  // -----------------------------------------------------------------------
  // Fast path — no filtering, no grouping, no bucketing, no tokens.
  // Sum from records.costAmount only.
  // -----------------------------------------------------------------------
  if (!hasSlowPath) {
    let totalCost = 0;

    for (const r of records) {
      totalCost += r.costAmount;
    }

    let currency = "";

    for (const r of records) {
      currency = r.costCurrency;
      break;
    }

    return {
      kind: "total",
      row: { label: "All sessions", costAmount: totalCost, sessionCount: records.length },
      currency,
    };
  }

  // -----------------------------------------------------------------------
  // Slow path — apply filters and collect events.
  // -----------------------------------------------------------------------

  const filterOpts: FilterOptions = {
    since: effectiveSince,
    dir: opts.dir,
    interactive: opts.interactive,
    min: opts.min,
    minMetric:
      opts.loc === true ? "loc" : opts.tokens === true ? "tokens" : "cost",
  };

  const filtered = applyFilters(records, filterOpts);

  // Collect events grouped by sessionId (preserving insertion order).
  const eventMap = new Map<string, CostEvent[]>();

  if (events !== undefined) {
    for (const ev of events) {
      const existing = eventMap.get(ev.sessionId);

      if (existing === undefined) {
        eventMap.set(ev.sessionId, [ev]);
      } else {
        existing.push(ev);
      }
    }
  }

  // Determine currency from the first record's events or meta.
  let currency = "";

  if (events !== undefined && events.length > 0) {
    for (const ev of events) {
      currency = ev.currency;
      break;
    }
  } else if (filtered.length > 0) {
    for (const r of filtered) {
      currency = r.costCurrency;
      break;
    }
  }

  // -----------------------------------------------------------------------
  // Special case: --by language (non-bucketed)
  //
  // Unlike dir/session/model/agent, a single session contributes to many
  // language groups (one per file extension touched). Fan out per record
  // across its locByLanguage map. The bucketed variant is handled later in
  // the bucketed-LOC branch.
  // -----------------------------------------------------------------------
  if (opts.by === "language" && opts.bucket === undefined) {
    const groupsMap = new Map<string, { added: number; removed: number; sessions: Set<string> }>();
    const uniqueSessions = new Set<string>();
    for (const r of filtered) {
      const map = r.locByLanguage;
      if (map === undefined) continue;
      let touched = false;
      for (const lang of Object.keys(map)) {
        const v = map[lang];
        if (v === undefined) continue;
        let g = groupsMap.get(lang);
        if (g === undefined) {
          g = { added: 0, removed: 0, sessions: new Set() };
          groupsMap.set(lang, g);
        }
        g.added += v.added;
        g.removed += v.removed;
        if (v.added > 0 || v.removed > 0) {
          g.sessions.add(r.sessionId);
          touched = true;
        }
      }
      if (touched) {
        uniqueSessions.add(r.sessionId);
      }
    }
    const groups: Group<AggregateRow>[] = [];
    // Stash the unique-session count on a sentinel "_total" row that the
    // renderer pulls out for the headline. Other consumers (json) see it
    // alongside the language rows; harmless.
    for (const [lang, g] of groupsMap) {
      const row: AggregateRow = {
        label: lang,
        costAmount: 0,
        sessionCount: g.sessions.size,
        linesAdded: g.added,
        linesRemoved: g.removed,
      };
      groups.push({ label: lang, items: [row] });
    }
    return {
      kind: "grouped",
      groups,
      currency,
      totalSessions: uniqueSessions.size,
    };
  }

  // Grouping key function.
  const groupKey = (r: SessionRecord): string => {
    if (opts.by === "dir") {
      return dirGroupLabel(r.cwd, opts.depth, resolveDirRoot(opts));
    }

    if (opts.by === "session") {
      return r.sessionId.startsWith("hydra_session_")
        ? r.sessionId.slice("hydra_session_".length)
        : r.sessionId;
    }

    if (opts.by === "model") {
      if (r.model === "") {
        return "<unknown>";
      }

      return r.model;
    }

    if (opts.by === "agent") {
      if (r.agentId === "") {
        return "<unknown>";
      }

      return r.agentId;
    }

    return "<all>";
  };

  // Bucket key function — uses local time, not UTC.
  const bucketKey = (ts: string): string => {
    const date = new Date(ts);

    if (Number.isNaN(date.getTime())) {
      return "<invalid>";
    }

    if (opts.bucket === "hour") {
      const datePart = date.toLocaleDateString(undefined, {
        month: "2-digit",
        day: "2-digit",
      });
      const hh = String(date.getHours()).padStart(2, "0");
      return `${datePart} ${hh}:00`;
    }

    if (opts.bucket === "day") {
      return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    }

    if (opts.bucket === "week") {
      const startOfWeek = new Date(date);
      const day = startOfWeek.getDay();
      const diff = startOfWeek.getDate() - day + (day === 0 ? -6 : 1);
      startOfWeek.setDate(diff);

      return startOfWeek.toLocaleDateString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    }

    if (opts.bucket === "month") {
      return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "2-digit",
      });
    }

    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  };

  // -----------------------------------------------------------------------
  // Case 1: No grouping, no bucketing (e.g. --since only)
  // -----------------------------------------------------------------------
  if (opts.by === undefined && opts.bucket === undefined) {
    let totalCost = 0;
    let totalDelta = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;

    for (const r of filtered) {
      totalCost += r.costAmount;

      const evts = eventMap.get(r.sessionId);

      if (evts !== undefined) {
        for (const ev of evts) {
          totalDelta += ev.deltaCost;

          if (opts.tokens === true) {
            if (ev.inputTokens !== undefined) totalInputTokens += ev.inputTokens;
            if (ev.outputTokens !== undefined) totalOutputTokens += ev.outputTokens;
            if (ev.cacheReadTokens !== undefined) totalCacheReadTokens += ev.cacheReadTokens;
            if (ev.cacheWriteTokens !== undefined) totalCacheWriteTokens += ev.cacheWriteTokens;
          }
        }
      }
    }

    const row: AggregateRow = { label: "All sessions", costAmount: totalCost, deltaCost: totalDelta, sessionCount: filtered.length };

    if (opts.tokens === true) {
      row.inputTokens = totalInputTokens;
      row.outputTokens = totalOutputTokens;
      row.cacheReadTokens = totalCacheReadTokens;
      row.cacheWriteTokens = totalCacheWriteTokens;
    }

    if (opts.loc === true) {
      let added = 0;
      let removed = 0;
      for (const r of filtered) {
        const map = r.locByLanguage;
        if (map === undefined) continue;
        for (const lang of Object.keys(map)) {
          const v = map[lang];
          if (v !== undefined) {
            added += v.added;
            removed += v.removed;
          }
        }
      }
      row.linesAdded = added;
      row.linesRemoved = removed;
    }

    return { kind: "total", row, currency };
  }

  // -----------------------------------------------------------------------
  // Case 2: Grouping without bucketing (--by dir/session/model/agent)
  // This was the unreachable branch — now fixed.
  // -----------------------------------------------------------------------
  if (opts.by !== undefined && opts.bucket === undefined) {
    const groupsMap = new Map<string, { label: string; rows: AggregateRow }>();

    for (const r of filtered) {
      const key = groupKey(r);
      let grp = groupsMap.get(key);

      if (grp === undefined) {
        grp = { label: key, rows: { label: key, costAmount: 0, deltaCost: 0, sessionCount: 0 } };
        groupsMap.set(key, grp);
      }

      grp.rows.costAmount += r.costAmount;
      grp.rows.sessionCount = (grp.rows.sessionCount ?? 0) + 1;
      if (opts.tokens === true) {
        if (grp.rows.inputTokens === undefined) grp.rows.inputTokens = 0;
        grp.rows.inputTokens += r.contextTokens;
      }
      if (opts.loc === true) {
        const map = r.locByLanguage;
        if (map !== undefined) {
          if (grp.rows.linesAdded === undefined) grp.rows.linesAdded = 0;
          if (grp.rows.linesRemoved === undefined) grp.rows.linesRemoved = 0;
          for (const lang of Object.keys(map)) {
            const v = map[lang];
            if (v !== undefined) {
              grp.rows.linesAdded += v.added;
              grp.rows.linesRemoved += v.removed;
            }
          }
        }
      }

      // Sum deltas and tokens from events when available.
      const evts = eventMap.get(r.sessionId);

      if (evts !== undefined) {
        for (const ev of evts) {
          grp.rows.deltaCost! += ev.deltaCost;

          if (opts.tokens === true) {
            if (grp.rows.inputTokens === undefined) grp.rows.inputTokens = 0;
            if (grp.rows.outputTokens === undefined) grp.rows.outputTokens = 0;
            if (grp.rows.cacheReadTokens === undefined) grp.rows.cacheReadTokens = 0;
            if (grp.rows.cacheWriteTokens === undefined) grp.rows.cacheWriteTokens = 0;

            if (ev.inputTokens !== undefined) grp.rows.inputTokens! += ev.inputTokens;
            if (ev.outputTokens !== undefined) grp.rows.outputTokens! += ev.outputTokens;
            if (ev.cacheReadTokens !== undefined) grp.rows.cacheReadTokens! += ev.cacheReadTokens;
            if (ev.cacheWriteTokens !== undefined) grp.rows.cacheWriteTokens! += ev.cacheWriteTokens;
          }
        }
      }
    }

    const groups: Group<AggregateRow>[] = [];

    for (const grp of groupsMap.values()) {
      groups.push({ label: grp.label, items: [grp.rows] });
    }

    return { kind: "grouped", groups, currency };
  }

  // Time-bucketed cases use per-turn usage_update events when available.
  // Each event carries a cumulative-cost snapshot; per-session delta =
  // max(0, current - previous). Falls back to lump-at-updatedAt for
  // sessions that have no events (legacy / pre-T1 sessions). Sessions
  // are looked up by id; events with no matching record are skipped
  // (they were filtered out — out of dir/interactive scope).
  const filteredById = new Map<string, SessionRecord>();
  for (const r of filtered) {
    filteredById.set(r.sessionId, r);
  }

  // Group events by sessionId, sorted by ts ascending (the daemon's
  // /v1/sessions/events endpoint already sorts but we don't rely on it).
  const eventsBySession = new Map<string, CostEvent[]>();
  if (events !== undefined) {
    for (const ev of events) {
      if (!filteredById.has(ev.sessionId)) {
        continue;
      }
      const list = eventsBySession.get(ev.sessionId);
      if (list === undefined) {
        eventsBySession.set(ev.sessionId, [ev]);
      } else {
        list.push(ev);
      }
    }
    for (const list of eventsBySession.values()) {
      list.sort((a, b) => a.ts.localeCompare(b.ts));
    }
  }

  // Per-bucket session-id tracking so sessionCount counts unique
  // sessions per bucket (a session spanning N buckets contributes 1 to
  // each, not N to one).
  const trackSession = (
    bucket: TimeBucket & { _sessions?: Set<string> },
    sessionId: string,
  ): void => {
    if (bucket._sessions === undefined) {
      bucket._sessions = new Set<string>();
    }
    bucket._sessions.add(sessionId);
    bucket.sessionCount = bucket._sessions.size;
  };

  const finalize = (bucket: TimeBucket & { _sessions?: Set<string> }): void => {
    delete bucket._sessions;
  };

  // Accumulate one event's delta into the bucket map. The bucket key
  // comes from the event's ts; the delta from the running prevCumulative.
  // `groupBuckets` is the per-group buckets map (case 3) or the flat
  // bucketsMap (case 4).
  const accrueEvent = (
    groupBuckets: Map<string, TimeBucket>,
    ev: CostEvent,
    delta: number,
  ): void => {
    const bk = bucketKey(ev.ts);
    let bucket = groupBuckets.get(bk) as
      | (TimeBucket & { _sessions?: Set<string> })
      | undefined;
    if (bucket === undefined) {
      bucket = { bucket: bk, costAmount: 0, deltaCost: 0, sessionCount: 0 };
      groupBuckets.set(bk, bucket);
    }
    bucket.costAmount += delta;
    bucket.deltaCost += delta;
    trackSession(bucket, ev.sessionId);
    if (opts.tokens === true) {
      if (
        bucket.inputTokens === undefined ||
        (ev.inputTokens ?? 0) > bucket.inputTokens
      ) {
        bucket.inputTokens = ev.inputTokens ?? bucket.inputTokens ?? 0;
      }
    }
  };

    // Sessions with zero usage_update events are skipped from time-bucketed
  // views. The daemon has told us nothing about WHEN their
  // currentUsage.costAmount was spent, and for resurrected sessions that
  // number is the lineage cumulative inherited from upstream — lumping it
  // at updatedAt fabricates a spike at the resurrect moment. They still
  // appear in non-bucketed `--since` totals via the records path.


  // -----------------------------------------------------------------------
  // Bucketed-LOC fast-forward.
  //
  // EditEvents already carry per-edit deltas (no cumulative baseline like
  // cost), so the bucketing logic is simpler than the cost path. We also
  // support fanning out per language when --by language is set.
  // -----------------------------------------------------------------------
  if (opts.loc === true && opts.bucket !== undefined) {
    const sessionIdSet = new Set<string>();
    for (const r of filtered) {
      sessionIdSet.add(r.sessionId);
    }
    const recordById = new Map<string, SessionRecord>();
    for (const r of filtered) {
      recordById.set(r.sessionId, r);
    }

    type BucketEx = TimeBucket & { _sessions?: Set<string> };
    const ensureBucket = (
      m: Map<string, TimeBucket>,
      bk: string,
    ): BucketEx => {
      let b = m.get(bk) as BucketEx | undefined;
      if (b === undefined) {
        b = { bucket: bk, costAmount: 0, deltaCost: 0, sessionCount: 0, linesAdded: 0, linesRemoved: 0 };
        m.set(bk, b);
      }
      if ((b.linesAdded ?? undefined) === undefined) b.linesAdded = 0;
      if ((b.linesRemoved ?? undefined) === undefined) b.linesRemoved = 0;
      return b;
    };

    const accrueEdit = (b: BucketEx, ev: EditEvent): void => {
      b.linesAdded = (b.linesAdded ?? 0) + ev.linesAdded;
      b.linesRemoved = (b.linesRemoved ?? 0) + ev.linesRemoved;
      if (b._sessions === undefined) b._sessions = new Set<string>();
      b._sessions.add(ev.sessionId);
      b.sessionCount = b._sessions.size;
    };

    const finalizeLoc = (b: BucketEx): void => {
      delete b._sessions;
    };

    const eventsList = editEvents ?? [];

    // --by language + --bucket → groups keyed by language, with sessionCount
    // deduped within (language, bucket).
    if (opts.by === "language") {
      const groupsMap = new Map<string, { label: string; buckets: Map<string, TimeBucket> }>();
      const uniqueSessions = new Set<string>();
      for (const ev of eventsList) {
        if (!sessionIdSet.has(ev.sessionId)) continue;
        if (effectiveSince !== undefined && new Date(ev.ts) < effectiveSince) continue;
        let grp = groupsMap.get(ev.language);
        if (grp === undefined) {
          grp = { label: ev.language, buckets: new Map() };
          groupsMap.set(ev.language, grp);
        }
        const bucket = ensureBucket(grp.buckets, bucketKey(ev.ts));
        accrueEdit(bucket, ev);
        uniqueSessions.add(ev.sessionId);
      }
      const groups: Group<TimeBucket>[] = [];
      for (const grp of groupsMap.values()) {
        const items = Array.from(grp.buckets.values());
        for (const it of items) finalizeLoc(it as BucketEx);
        items.sort((a, b) => a.bucket.localeCompare(b.bucket));
        if (items.length > 0) groups.push({ label: grp.label, items });
      }
      return { kind: "timeSeriesGrouped", groups, currency, totalSessions: uniqueSessions.size };
    }

    // --by dir|session|model|agent + --bucket → groups keyed by record dim.
    if (opts.by !== undefined) {
      const groupsMap = new Map<string, { label: string; buckets: Map<string, TimeBucket> }>();
      for (const ev of eventsList) {
        if (!sessionIdSet.has(ev.sessionId)) continue;
        if (effectiveSince !== undefined && new Date(ev.ts) < effectiveSince) continue;
        const r = recordById.get(ev.sessionId);
        if (r === undefined) continue;
        const key = groupKey(r);
        let grp = groupsMap.get(key);
        if (grp === undefined) {
          grp = { label: key, buckets: new Map() };
          groupsMap.set(key, grp);
        }
        const bucket = ensureBucket(grp.buckets, bucketKey(ev.ts));
        accrueEdit(bucket, ev);
      }
      const groups: Group<TimeBucket>[] = [];
      for (const grp of groupsMap.values()) {
        const items = Array.from(grp.buckets.values());
        for (const it of items) finalizeLoc(it as BucketEx);
        items.sort((a, b) => a.bucket.localeCompare(b.bucket));
        if (items.length > 0) groups.push({ label: grp.label, items });
      }
      return { kind: "timeSeriesGrouped", groups, currency };
    }

    // Plain --bucket, no grouping.
    const bucketsMap = new Map<string, TimeBucket>();
    for (const ev of eventsList) {
      if (!sessionIdSet.has(ev.sessionId)) continue;
      if (effectiveSince !== undefined && new Date(ev.ts) < effectiveSince) continue;
      const bucket = ensureBucket(bucketsMap, bucketKey(ev.ts));
      accrueEdit(bucket, ev);
    }
    const timeSeries: TimeBucket[] = Array.from(bucketsMap.values());
    for (const it of timeSeries) finalizeLoc(it as BucketEx);
    timeSeries.sort((a, b) => a.bucket.localeCompare(b.bucket));
    return { kind: "timeSeries", timeSeries, currency };
  }

  // -----------------------------------------------------------------------
  // Case 3: Bucketing with grouping (--by + --bucket)
  // -----------------------------------------------------------------------
  if (opts.by !== undefined && opts.bucket !== undefined) {
    const groupsMap = new Map<string, { label: string; buckets: Map<string, TimeBucket> }>();

    const getGroupBuckets = (r: SessionRecord): Map<string, TimeBucket> => {
      const key = groupKey(r);
      let grp = groupsMap.get(key);
      if (grp === undefined) {
        grp = { label: key, buckets: new Map() };
        groupsMap.set(key, grp);
      }
      return grp.buckets;
    };

    for (const r of filtered) {
      const sessionEvents = eventsBySession.get(r.sessionId);
      if (sessionEvents === undefined || sessionEvents.length === 0) {
        continue;
      }
      const groupBuckets = getGroupBuckets(r);
      const first = sessionEvents[0];
      if (first === undefined) continue;
      // The first event's cumulative is a baseline, not a delta — we
      // don't know how that spend was distributed in time. Sessions
      // that pre-existed T1's per-turn recording would otherwise dump
      // a huge "pre-recording" lump into the first event's bucket.
      let prev = first.cumulativeCost;
      for (let i = 1; i < sessionEvents.length; i++) {
        const ev = sessionEvents[i];
        if (ev === undefined) continue;
        const delta = Math.max(0, ev.cumulativeCost - prev);
        prev = ev.cumulativeCost;
        if (effectiveSince !== undefined && new Date(ev.ts) < effectiveSince) {
          continue;
        }
        accrueEvent(groupBuckets, ev, delta);
      }
    }

    const groups: Group<TimeBucket>[] = [];
    for (const grp of groupsMap.values()) {
      const items = Array.from(grp.buckets.values());
      for (const it of items) {
        finalize(it as TimeBucket & { _sessions?: Set<string> });
      }
      items.sort((a, b) => a.bucket.localeCompare(b.bucket));
      if (items.length > 0) {
        groups.push({ label: grp.label, items });
      }
    }

    return { kind: "timeSeriesGrouped", groups, currency };
  }

  // -----------------------------------------------------------------------
  // Case 4: Bucketing only (no grouping)
  // -----------------------------------------------------------------------
  const bucketsMap = new Map<string, TimeBucket>();

  for (const r of filtered) {
    const sessionEvents = eventsBySession.get(r.sessionId);
    if (sessionEvents === undefined || sessionEvents.length === 0) {
      continue;
    }
    const first = sessionEvents[0];
    if (first === undefined) continue;
    // First event's cumulative is the baseline; deltas start at #2.
    // See comment in case 3 above for rationale.
    let prev = first.cumulativeCost;
    for (let i = 1; i < sessionEvents.length; i++) {
      const ev = sessionEvents[i];
      if (ev === undefined) continue;
      const delta = Math.max(0, ev.cumulativeCost - prev);
      prev = ev.cumulativeCost;
      if (effectiveSince !== undefined && new Date(ev.ts) < effectiveSince) {
        continue;
      }
      accrueEvent(bucketsMap, ev, delta);
    }
  }

  const timeSeries: TimeBucket[] = Array.from(bucketsMap.values());
  for (const it of timeSeries) {
    finalize(it as TimeBucket & { _sessions?: Set<string> });
  }
  timeSeries.sort((a, b) => a.bucket.localeCompare(b.bucket));

  return { kind: "timeSeries", timeSeries, currency };
}
