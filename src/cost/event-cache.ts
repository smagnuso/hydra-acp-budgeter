import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { logger } from "../util/log.js";
import { fetchUsageEventsFromDaemon } from "./daemon-client.js";
import type { DaemonConn, UsageEvent } from "./daemon-client.js";

const log = logger("cost/event-cache");

const FORMAT_VERSION = 1;
// Re-request this much before the newest stored event so a late-arriving row is not missed.
const OVERLAP_MS = 60 * 60 * 1000;
// Events are append-only, but `repair` can rewrite history, so resync fully now and then.
const FULL_RESYNC_MS = 24 * 60 * 60 * 1000;

export interface EventCacheInfo {
  path: string;
  exists: boolean;
  bytes: number;
  events: number;
  newest: string | undefined;
  fullSyncAt: string | undefined;
}

interface CacheFile {
  fullAt: number;
  events: UsageEvent[];
}

export function eventCachePath(): string {
  const home = process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");
  return resolve(home, "budgeter-usage-events.jsonl");
}

function readCache(): CacheFile | undefined {
  let text: string;
  try {
    text = readFileSync(eventCachePath(), "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  try {
    const head = JSON.parse(lines[0] ?? "") as { v?: number; fullAt?: number };
    if (head.v !== FORMAT_VERSION || typeof head.fullAt !== "number") {
      return undefined;
    }
    const events: UsageEvent[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.length === 0) {
        continue;
      }
      const r = JSON.parse(line) as [string, string, number, string, number];
      events.push({
        sessionId: r[0],
        ts: r[1],
        costCumulative: r[2],
        costCurrency: r[3],
        contextTokens: r[4],
      });
    }
    return { fullAt: head.fullAt, events };
  } catch (err) {
    log.debug(`event cache unreadable, ignoring: ${(err as Error).message}`);
    return undefined;
  }
}

function writeCache(cache: CacheFile): void {
  const path = eventCachePath();
  const out: string[] = [JSON.stringify({ v: FORMAT_VERSION, fullAt: cache.fullAt })];
  for (const e of cache.events) {
    out.push(JSON.stringify([e.sessionId, e.ts, e.costCumulative, e.costCurrency, e.contextTokens]));
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, out.join("\n") + "\n");
    renameSync(tmp, path);
  } catch (err) {
    log.debug(`event cache write failed: ${(err as Error).message}`);
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
  }
}

function newestTs(events: UsageEvent[]): string | undefined {
  let best: string | undefined;
  for (const e of events) {
    if (best === undefined || e.ts > best) {
      best = e.ts;
    }
  }
  return best;
}

function mergeEvents(base: UsageEvent[], delta: UsageEvent[]): UsageEvent[] {
  const byKey = new Map<string, UsageEvent>();
  for (const e of base) {
    byKey.set(`${e.sessionId}|${e.ts}|${e.costCumulative}|${e.contextTokens}`, e);
  }
  for (const e of delta) {
    byKey.set(`${e.sessionId}|${e.ts}|${e.costCumulative}|${e.contextTokens}`, e);
  }
  return [...byKey.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/**
 * Usage events for every session, from a local cache topped up with only the
 * events newer than what it holds. The first call (or `refresh`, or a cache
 * older than a day) does one full fetch. If the daemon can't be reached, the
 * stored events are returned as they are.
 */
export async function syncUsageEvents(
  conn?: DaemonConn,
  opts?: { refresh?: boolean },
): Promise<UsageEvent[] | undefined> {
  const cached = opts?.refresh ? undefined : readCache();
  const newest = cached ? newestTs(cached.events) : undefined;

  if (cached !== undefined && newest !== undefined && Date.now() - cached.fullAt < FULL_RESYNC_MS) {
    const since = new Date(Date.parse(newest) - OVERLAP_MS);
    const delta = await fetchUsageEventsFromDaemon(since, conn);
    if (delta === undefined) {
      return cached.events;
    }
    const merged = mergeEvents(cached.events, delta);
    writeCache({ fullAt: cached.fullAt, events: merged });
    return merged;
  }

  const all = await fetchUsageEventsFromDaemon(undefined, conn);
  if (all === undefined) {
    return readCache()?.events;
  }
  writeCache({ fullAt: Date.now(), events: all });
  return all;
}

/** Delete the cache file. Returns whether there was one to delete. */
export function clearEventCache(): boolean {
  try {
    unlinkSync(eventCachePath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.debug(`event cache delete failed: ${(err as Error).message}`);
    }
    return false;
  }
}

export function eventCacheInfo(): EventCacheInfo {
  const path = eventCachePath();
  if (!existsSync(path)) {
    return { path, exists: false, bytes: 0, events: 0, newest: undefined, fullSyncAt: undefined };
  }
  const cache = readCache();
  return {
    path,
    exists: true,
    bytes: statSync(path).size,
    events: cache?.events.length ?? 0,
    newest: cache ? newestTs(cache.events) : undefined,
    fullSyncAt: cache ? new Date(cache.fullAt).toISOString() : undefined,
  };
}
