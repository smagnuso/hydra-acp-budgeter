import { aggregate, applyFilters } from "./aggregate.js";
import type { BucketSpec, CostAggregate, GroupBy } from "./aggregate.js";
import { fetchUsageEventsFromDaemon, listSessionsFromDaemon } from "./daemon-client.js";
import type { DaemonConn } from "./daemon-client.js";
import { streamHistoryEditEvents } from "./history-stream.js";
import type { CostEvent, EditEvent } from "./history-stream.js";
import { enrichSessionsWithLoc, scanSessions } from "./session-store.js";

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

/**
 * Run a usage query end to end: list sessions, narrow by host, enrich LOC,
 * apply filters, fetch per-turn events, aggregate. `conn` points at the
 * daemon; omit it to resolve from env / ~/.hydra-acp as the CLI does.
 */
export async function computeUsage(
  query: UsageQuery,
  conn?: DaemonConn,
): Promise<CostAggregate> {
  const useLoc = query.metric === "loc";
  const useTokens = query.metric === "tokens";
  const minMetric = useLoc ? "loc" : useTokens ? "tokens" : "cost";
  const host = query.host ?? "local";

  const allRecords = (await listSessionsFromDaemon(conn)) ?? scanSessions();

  // Narrow by host before enriching: LOC for a federated row is a network
  // fetch, so doing it for rows --host is about to drop is pure waste.
  const hostFiltered = applyFilters(allRecords, { host, minMetric });

  if (useLoc || query.by === "filetype") {
    await enrichSessionsWithLoc(hostFiltered, conn);
  }

  const records = applyFilters(hostFiltered, {
    since: query.since,
    dir: query.dir,
    interactive: query.interactive,
    min: query.min,
    minMetric,
    host,
  });

  // `since` is deliberately not passed to the daemon: cutting events at the
  // window boundary would attribute the first in-window cumulative as a delta.
  let events: CostEvent[] | undefined = undefined;
  const wireEvents = await fetchUsageEventsFromDaemon(undefined, conn);
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

  let editEvents: EditEvent[] | undefined = undefined;
  if (useLoc && query.bucket !== undefined) {
    const list: EditEvent[] = [];
    for await (const ev of streamHistoryEditEvents(records, conn)) {
      list.push(ev);
    }
    editEvents = list;
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
    editEvents,
  );
}
