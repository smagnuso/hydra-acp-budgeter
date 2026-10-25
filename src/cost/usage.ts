import { createHash } from "node:crypto";
import { aggregate, applyFilters } from "./aggregate.js";
import type { BucketSpec, CostAggregate, GroupBy } from "./aggregate.js";
import { fetchUsageEventsFromDaemon, listSessionsFromDaemon } from "./daemon-client.js";
import type { DaemonConn, UsageEvent } from "./daemon-client.js";
import { streamHistoryEditEvents } from "./history-stream.js";
import type { CostEvent, EditEvent } from "./history-stream.js";
import { scanSessions } from "./session-store.js";
import type { SessionRecord } from "./session-store.js";

export type { AggregateRow, BucketSpec, CostAggregate, GroupBy, Group, TimeBucket } from "./aggregate.js";
export type { DaemonConn } from "./daemon-client.js";
export { parseSince } from "./aggregate.js";

/**
 * Bumped only when the shape of CostAggregate (or UsageQuery semantics)
 * changes incompatibly. Additive fields and new --by dimensions don't count.
 */
export const USAGE_API_VERSION = 1;

export interface UsageQuery {
  /** Window start; the aggregator slices per-turn events against it. */
  since: Date;
  bucket?: BucketSpec;
  by?: GroupBy;
  depth?: number;
  dir?: string;
  interactive?: boolean;
  /** "local" (default), "all", or a federated peer name. */
  host?: string;
  min?: number;
  metric?: "cost" | "tokens" | "loc";
}

export interface UsageOptions {
  /**
   * Reuse the fetched session list and usage events for this long. Callers
   * that re-query the same data many ways (a UI with dropdowns) set this so
   * only the first query pays for the daemon round trip.
   */
  cacheMs?: number;
}

interface Snapshot {
  at: number;
  records: Promise<SessionRecord[]>;
  events: Promise<UsageEvent[] | undefined>;
}

const snapshots = new Map<string, Snapshot>();

// Edit events are immutable per (session, updatedAt), so no TTL is needed.
const editCache = new Map<string, EditEvent[]>();
const EDIT_CACHE_MAX = 5000;

function connKey(conn: DaemonConn | undefined): string {
  if (conn === undefined) {
    return "env";
  }
  const t = createHash("sha256").update(conn.token).digest("hex").slice(0, 16);
  return `${conn.daemonUrl}|${t}`;
}

function snapshotFor(conn: DaemonConn | undefined, cacheMs: number): Snapshot {
  const key = connKey(conn);
  const now = Date.now();
  const hit = snapshots.get(key);
  if (hit !== undefined && now - hit.at < cacheMs) {
    return hit;
  }
  const fresh: Snapshot = {
    at: now,
    records: listSessionsFromDaemon(conn).then((r) => r ?? scanSessions()),
    events: fetchUsageEventsFromDaemon(undefined, conn),
  };
  const drop = (): void => {
    if (snapshots.get(key) === fresh) {
      snapshots.delete(key);
    }
  };
  fresh.records.catch(drop);
  fresh.events.catch(drop);
  snapshots.set(key, fresh);
  return fresh;
}

async function editEventsFor(
  record: SessionRecord,
  conn: DaemonConn | undefined,
  cache: boolean,
): Promise<EditEvent[]> {
  const key = `${connKey(conn)}|${record.sessionId}|${record.updatedAt}`;
  const hit = cache ? editCache.get(key) : undefined;
  if (hit !== undefined) {
    return hit;
  }
  const list: EditEvent[] = [];
  for await (const ev of streamHistoryEditEvents(record, conn)) {
    list.push(ev);
  }
  if (cache) {
    if (editCache.size >= EDIT_CACHE_MAX) {
      editCache.clear();
    }
    editCache.set(key, list);
  }
  return list;
}

/**
 * Run a usage query end to end: list sessions, narrow by host, enrich LOC,
 * apply filters, fetch per-turn events, aggregate. `conn` points at the
 * daemon; omit it to resolve from env / ~/.hydra-acp as the CLI does.
 */
export async function computeUsage(
  query: UsageQuery,
  conn?: DaemonConn,
  opts?: UsageOptions,
): Promise<CostAggregate> {
  const useLoc = query.metric === "loc";
  const useTokens = query.metric === "tokens";
  const minMetric = useLoc ? "loc" : useTokens ? "tokens" : "cost";
  const host = query.host ?? "local";

  const cacheMs = opts?.cacheMs ?? 0;
  const snap = cacheMs > 0 ? snapshotFor(conn, cacheMs) : undefined;
  const allRecords = snap
    ? (await snap.records).map((r) => ({ ...r }))
    : (await listSessionsFromDaemon(conn)) ?? scanSessions();

  // Narrow before enriching: LOC means streaming each row's history (a
  // network fetch for federated rows), so only the survivors should pay.
  // The metric floor is skipped for loc since it isn't known until enrichment.
  const narrowed = applyFilters(allRecords, {
    since: query.since,
    dir: query.dir,
    interactive: query.interactive,
    host,
    minMetric,
    min: useLoc ? -1 : undefined,
  });

  const editEvents: EditEvent[] = [];
  if (useLoc || query.by === "filetype") {
    for (const r of narrowed) {
      const list = await editEventsFor(r, conn, cacheMs > 0);
      const map: Record<string, { added: number; removed: number }> = {};
      for (const ev of list) {
        const cur = map[ev.filetype] ?? { added: 0, removed: 0 };
        cur.added += ev.linesAdded;
        cur.removed += ev.linesRemoved;
        map[ev.filetype] = cur;
        editEvents.push(ev);
      }
      r.locByFiletype = map;
    }
  }

  const records = applyFilters(narrowed, {
    min: query.min,
    minMetric,
  });

  const kept = new Set(records.map((r) => r.sessionId));

  // `since` is deliberately not passed to the daemon: cutting events at the
  // window boundary would attribute the first in-window cumulative as a delta.
  let events: CostEvent[] | undefined = undefined;
  const wireEvents = snap ? await snap.events : await fetchUsageEventsFromDaemon(undefined, conn);
  if (wireEvents !== undefined) {
    events = wireEvents.map((e) => ({
      sessionId: e.sessionId,
      ts: e.ts,
      deltaCost: 0,
      cumulativeCost: e.costCumulative,
      currency: e.costCurrency,
      inputTokens: e.contextTokens,
    }));
  }

  return aggregate(
    records,
    events,
    {
      by: query.by,
      depth: query.depth,
      bucket: query.bucket,
      since: query.since,
      interactive: query.interactive,
      dir: query.dir,
      tokens: useTokens,
      loc: useLoc,
      min: query.min,
    },
    useLoc && query.bucket !== undefined
      ? editEvents.filter((ev) => kept.has(ev.sessionId))
      : undefined,
  );
}
