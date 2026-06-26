import { createInterface } from "node:readline";
import { createReadStream, statSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../util/log.js";
import type { SessionRecord } from "./session-store.js";
import { sessionsDir } from "./session-store.js";
import { languageForPath } from "./language.js";

const log = logger("cost/history-stream");

/** A single cost event emitted from a history.jsonl usage_update line. */
export interface CostEvent {
  sessionId: string;
  ts: string;
  deltaCost: number;
  cumulativeCost: number;
  currency: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** A single edit event emitted from a history.jsonl tool_call_update line
 *  carrying a diff payload (Edit/Write tools). One event per file diff. */
export interface EditEvent {
  sessionId: string;
  ts: string;
  path: string;
  language: string;
  linesAdded: number;
  linesRemoved: number;
}

function readCumulativeFromMeta(
  meta: unknown,
): number | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const ns = (meta as Record<string, unknown>)["hydra-acp"];
  if (!ns || typeof ns !== "object" || Array.isArray(ns)) {
    return undefined;
  }
  const v = (ns as Record<string, unknown>).cumulativeCost;
  return typeof v === "number" ? v : undefined;
}

function readCost(
  update: Record<string, unknown>,
): { amount: number; currency: string | undefined } | undefined {
  const cumulative = readCumulativeFromMeta(update._meta);
  const cost = (update.cost ?? undefined) as
    | { amount?: unknown; currency?: unknown }
    | undefined;
  const amount =
    cumulative !== undefined
      ? cumulative
      : typeof cost?.amount === "number"
        ? cost.amount
        : undefined;
  if (amount === undefined) {
    return undefined;
  }
  const currency =
    typeof cost?.currency === "string" ? cost.currency : undefined;
  return { amount, currency };
}

function formatRecordedAt(rec: Record<string, unknown>): string {
  const raw = rec.recordedAt;
  if (typeof raw === "number") {
    return new Date(raw).toISOString();
  }
  if (typeof raw === "string") {
    return raw;
  }
  return "";
}

/**
 * Stream history.jsonl line-by-line for the given session(s), filtering to
 * usage_update envelopes and yielding delta-cost CostEvent rows.
 *
 * Delta logic mirrors src/tracker.ts:306-339 — prefer
 * params.update._meta['hydra-acp'].cumulativeCost when present, fall back to
 * params.update.cost.amount. Track previous cumulative per sessionId so that
 * resurrects (where cost resets) do not produce negative deltas.
 */
export async function* streamHistoryEvents(
  sessions: SessionRecord | SessionRecord[],
): AsyncGenerator<CostEvent, void, undefined> {
  const sessionList = Array.isArray(sessions) ? sessions : [sessions];

  for (const session of sessionList) {
    const historyPath = resolve(
      sessionsDir(),
      session.sessionId,
      "history.jsonl",
    );

    // Pre-check: history.jsonl may not exist (e.g. brand-new sessions).
    // createReadStream does NOT throw synchronously on ENOENT — it emits
    // an error event asynchronously, which would surface from the for-await
    // loop as an unhandled rejection. Using statSync avoids that complexity.
    try {
      statSync(historyPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        log.debug(`no history for ${session.sessionId}`);
        continue;
      }
      log.debug(`stat failed for ${historyPath}: ${e.message}`);
      continue;
    }

    const stream = createReadStream(historyPath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    // Track previous cumulative cost per session to compute deltas.
    const prevCumulative = new Map<string, number>();

    try {
      for await (const line of rl) {
        if (line.length === 0) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          log.debug(`malformed JSON in history.jsonl for ${session.sessionId}`);
          continue;
        }

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

        const rec = parsed as Record<string, unknown>;

        if (rec.method !== "session/update") continue;

        const params = (rec.params ?? undefined) as
          | Record<string, unknown>
          | undefined;
        if (!params || typeof params !== "object" || Array.isArray(params)) continue;

        // In history.jsonl the update payload is nested under params.update.
        const update = (params.update ?? undefined) as
          | Record<string, unknown>
          | undefined;
        if (!update || typeof update !== "object" || Array.isArray(update)) continue;

        if (update.sessionUpdate !== "usage_update") continue;

        const ts = formatRecordedAt(rec);
        const costInfo = readCost(update);
        if (costInfo === undefined) continue;
        const currency = costInfo.currency ?? "";

        const cumulative = costInfo.amount;

        const prev = prevCumulative.get(session.sessionId) ?? 0;
        const delta = Math.max(0, cumulative - prev);
        prevCumulative.set(session.sessionId, cumulative);

        // Token counts from update.usage — omit fields that are absent.
        const usage = (update.usage ?? undefined) as
          | Record<string, unknown>
          | undefined;

        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        let cacheReadTokens: number | undefined;
        let cacheWriteTokens: number | undefined;

        if (usage && typeof usage === "object" && !Array.isArray(usage)) {
          const i = usage.inputTokens;
          if (typeof i === "number") inputTokens = i;

          const o = usage.outputTokens;
          if (typeof o === "number") outputTokens = o;

          const c = usage.cacheReadInputTokens;
          if (typeof c === "number") cacheReadTokens = c;

          const w = usage.cacheCreationInputTokens;
          if (typeof w === "number") cacheWriteTokens = w;
        }

        yield {
          sessionId: session.sessionId,
          ts,
          deltaCost: delta,
          cumulativeCost: cumulative,
          currency,
          ...(inputTokens !== undefined && { inputTokens }),
          ...(outputTokens !== undefined && { outputTokens }),
          ...(cacheReadTokens !== undefined && { cacheReadTokens }),
          ...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
        };
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }
}

function countLines(s: string): number {
  if (s.length === 0) {
    return 0;
  }
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      n++;
    }
  }
  if (s.charCodeAt(s.length - 1) === 10) {
    n--;
  }
  return n;
}

/**
 * Stream history.jsonl line-by-line for the given session(s), yielding one
 * EditEvent per diff payload found in tool_call_update envelopes (Edit and
 * Write tools both surface as update.content[].type === "diff" with path,
 * oldText, newText). One toolCallId may carry multiple file diffs (rare,
 * but supported by the protocol) — each diff yields its own event.
 *
 * linesAdded = lines in newText; linesRemoved = lines in oldText. Net LOC
 * for a file is (added - removed); the consumer can compute that.
 */
export async function* streamHistoryEditEvents(
  sessions: SessionRecord | SessionRecord[],
): AsyncGenerator<EditEvent, void, undefined> {
  const sessionList = Array.isArray(sessions) ? sessions : [sessions];

  for (const session of sessionList) {
    const historyPath = resolve(
      sessionsDir(),
      session.sessionId,
      "history.jsonl",
    );

    try {
      statSync(historyPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        continue;
      }
      log.debug(`stat failed for ${historyPath}: ${e.message}`);
      continue;
    }

    const stream = createReadStream(historyPath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (line.length === 0) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const rec = parsed as Record<string, unknown>;
        if (rec.method !== "session/update") continue;

        const params = (rec.params ?? undefined) as
          | Record<string, unknown>
          | undefined;
        if (!params || typeof params !== "object" || Array.isArray(params)) continue;

        const update = (params.update ?? undefined) as
          | Record<string, unknown>
          | undefined;
        if (!update || typeof update !== "object" || Array.isArray(update)) continue;

        if (
          update.sessionUpdate !== "tool_call" &&
          update.sessionUpdate !== "tool_call_update"
        ) {
          continue;
        }

        const content = update.content;
        if (!Array.isArray(content) || content.length === 0) continue;

        const ts = formatRecordedAt(rec);

        for (const c of content) {
          if (!c || typeof c !== "object" || Array.isArray(c)) continue;
          const item = c as Record<string, unknown>;
          if (item.type !== "diff") continue;

          const path = typeof item.path === "string" ? item.path : "";
          if (path === "") continue;

          const oldText = typeof item.oldText === "string" ? item.oldText : "";
          const newText = typeof item.newText === "string" ? item.newText : "";

          yield {
            sessionId: session.sessionId,
            ts,
            path,
            language: languageForPath(path),
            linesAdded: countLines(newText),
            linesRemoved: countLines(oldText),
          };
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }
}
