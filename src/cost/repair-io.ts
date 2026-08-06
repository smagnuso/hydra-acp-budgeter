// Filesystem and OpenCode-database access for the cost reconciliation.
// Kept separate from repair-core.ts so the decision logic stays pure and
// testable; everything here is I/O that a test would have to mock.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { logger } from "../util/log.js";
import type {
  CallIndex,
  Ledger,
  SessionInput,
  ToolCallRow,
  UsageRow,
} from "./repair-core.js";

const log = logger("cost/repair-io");

/** Namespace our marker lives under in meta.json's extensionState bucket. */
export const BUDGETER_NS = "hydra-acp-budgeter";
/** Key within that bucket. Budgeter's tracker owns "state"; never touch it. */
export const REPAIR_KEY = "costRepair";

export const ARCHIVE_RE = /^history\.jsonl(\.(\d+)(\.gz)?)?$/;

export function defaultOpencodeDbs(): string[] {
  const dir =
    process.env.OPENCODE_DATA_DIR ?? resolve(homedir(), ".local/share/opencode");
  return ["opencode.db", "opencode-local.db"]
    .map((f) => resolve(dir, f))
    .filter((p) => existsSync(p));
}

export interface OpencodeIndex {
  readonly callIndex: CallIndex;
  readonly ledger: Ledger;
}

/**
 * Build the two lookups the repair needs from OpenCode's own storage:
 *
 *   callIndex — tool-call id -> the agent session that ran it. This is what
 *               makes attribution provable rather than inferred; see the
 *               repair-core header.
 *   ledger    — agent session -> its assistant-message costs over time.
 *
 * Opened read-only. This is a one-time migration input, not a runtime
 * dependency: once the repair has run and stamped its results, nothing reads
 * OpenCode again.
 */
export function buildOpencodeIndex(dbPaths: string[]): OpencodeIndex {
  const callIndex = new Map<string, string>();
  const ledger = new Map<string, Array<[number, number]>>();

  for (const path of dbPaths) {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path, { readOnly: true });
    } catch (err) {
      log.warn(`cannot open ${path}: ${(err as Error).message}`);
      continue;
    }
    try {
      // callID lives inside the part's JSON blob rather than a column, so this
      // is a substring scan rather than a join. Filtering in SQL first keeps
      // the row count down.
      for (const row of db
        .prepare("select session_id, data from part where data like '%callID%'")
        .all() as Array<{ session_id: string; data: string }>) {
        const at = row.data.indexOf('"callID":"');
        if (at < 0) {
          continue;
        }
        const end = row.data.indexOf('"', at + 10);
        if (end < 0) {
          continue;
        }
        callIndex.set(row.data.slice(at + 10, end), row.session_id);
      }
      for (const row of db
        .prepare("select session_id, data from message")
        .all() as Array<{ session_id: string; data: string }>) {
        let msg: { role?: string; cost?: number; time?: { created?: number } };
        try {
          msg = JSON.parse(row.data);
        } catch {
          continue;
        }
        if (msg.role !== "assistant") {
          continue;
        }
        const ts = msg.time?.created;
        if (typeof ts !== "number") {
          continue;
        }
        const arr = ledger.get(row.session_id) ?? [];
        arr.push([ts, msg.cost ?? 0]);
        ledger.set(row.session_id, arr);
      }
    } catch (err) {
      log.warn(`reading ${path} failed: ${(err as Error).message}`);
    } finally {
      db.close();
    }
  }
  for (const arr of ledger.values()) {
    arr.sort((a, b) => a[0] - b[0]);
  }
  log.debug(`indexed ${callIndex.size} tool calls, ${ledger.size} agent sessions`);
  return { callIndex, ledger };
}

/** One transcript file, held as raw lines so untouched ones stay byte-exact. */
export interface TranscriptFile {
  readonly name: string;
  readonly gz: boolean;
  readonly lines: string[];
}

/** Live file plus every archive, oldest first. */
export function readTranscriptFiles(sessionDir: string): TranscriptFile[] {
  const names = readdirSync(sessionDir).filter((n) => ARCHIVE_RE.test(n));
  // history.jsonl is the newest; history.jsonl.N ascends with age reversed
  // (higher N is newer), so sort archives by index and put the live file last.
  names.sort((a, b) => {
    const ia = a === "history.jsonl" ? Number.MAX_SAFE_INTEGER : Number(ARCHIVE_RE.exec(a)?.[2] ?? 0);
    const ib = b === "history.jsonl" ? Number.MAX_SAFE_INTEGER : Number(ARCHIVE_RE.exec(b)?.[2] ?? 0);
    return ia - ib;
  });
  const out: TranscriptFile[] = [];
  for (const name of names) {
    try {
      const raw = readFileSync(resolve(sessionDir, name));
      const text = name.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
      out.push({ name, gz: name.endsWith(".gz"), lines: text.split("\n") });
    } catch (err) {
      log.warn(`reading ${name} failed: ${(err as Error).message}`);
    }
  }
  return out;
}

export interface SessionMeta {
  readonly sessionId: string;
  readonly agentId: string;
  readonly forkedFromSessionId?: string;
  readonly currentUsage?: Record<string, unknown>;
  readonly extensionState?: Record<string, Record<string, unknown>>;
}

export function readMeta(sessionDir: string): SessionMeta | undefined {
  try {
    return JSON.parse(readFileSync(resolve(sessionDir, "meta.json"), "utf8")) as SessionMeta;
  } catch {
    return undefined;
  }
}

/** Lifetime cost as meta.json stores it: cumulativeCost + costAmount. */
export function reportedTotalOf(meta: SessionMeta): number {
  const u = meta.currentUsage ?? {};
  const a = typeof u.costAmount === "number" ? u.costAmount : 0;
  const c = typeof u.cumulativeCost === "number" ? u.cumulativeCost : 0;
  return a + c;
}

/** The repair marker on a session, if one has been applied. */
export function readGate(meta: SessionMeta): Record<string, unknown> | undefined {
  const bucket = meta.extensionState?.[BUDGETER_NS];
  const gate = bucket?.[REPAIR_KEY];
  return gate && typeof gate === "object" ? (gate as Record<string, unknown>) : undefined;
}

export interface ScannedSession {
  readonly dir: string;
  readonly meta: SessionMeta;
  readonly files: TranscriptFile[];
  readonly input: SessionInput;
}

/**
 * Turn a session directory into the shape repair-core plans against.
 *
 * Rows report their PRISTINE amount: if a previous run stamped
 * `_meta["hydra-acp"].costRepair.original`, that value is used rather than the
 * rewritten one, so planning always works from unmodified data. Combined with
 * the write-once rule on `original`, that makes revert-then-rerun exact and
 * stops a second run from compounding on a first.
 */
export function scanSession(sessionDir: string): ScannedSession | undefined {
  const meta = readMeta(sessionDir);
  if (meta === undefined) {
    return undefined;
  }
  const files = readTranscriptFiles(sessionDir);
  const usageRows: UsageRow[] = [];
  const toolCalls: ToolCallRow[] = [];

  for (const file of files) {
    for (let i = 0; i < file.lines.length; i += 1) {
      const line = file.lines[i]!;
      if (line.length === 0) {
        continue;
      }
      if (!line.includes('"usage_update"') && !line.includes('"toolCallId"')) {
        continue;
      }
      let entry: {
        recordedAt?: number;
        params?: { update?: Record<string, unknown> };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const update = entry.params?.update;
      if (!update) {
        continue;
      }
      const ns = (update._meta as Record<string, unknown> | undefined)?.["hydra-acp"] as
        | Record<string, unknown>
        | undefined;

      if (update.sessionUpdate === "usage_update") {
        const cost = update.cost as { amount?: unknown } | undefined;
        const stamped = (ns?.[REPAIR_KEY] as { original?: unknown } | undefined)?.original;
        const amount = typeof stamped === "number" ? stamped : cost?.amount;
        if (typeof amount === "number" && typeof entry.recordedAt === "number") {
          usageRows.push({ file: file.name, line: i, recordedAt: entry.recordedAt, amount });
        }
        continue;
      }
      if (typeof update.toolCallId === "string") {
        // Forwarded worker calls are marked by the planner; see repair-core.
        toolCalls.push({ toolCallId: update.toolCallId, forwarded: ns?.planner !== undefined });
      }
    }
  }
  usageRows.sort((a, b) => a.recordedAt - b.recordedAt);

  return {
    dir: sessionDir,
    meta,
    files,
    input: {
      sessionId: meta.sessionId,
      agentId: meta.agentId,
      forkedFromSessionId: meta.forkedFromSessionId,
      reportedTotal: reportedTotalOf(meta),
      usageRows,
      toolCalls,
    },
  };
}

export function hydraSessionsDir(): string {
  const home = process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");
  return resolve(home, "sessions");
}

export function listSessionDirs(): string[] {
  const root = hydraSessionsDir();
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .map((d) => resolve(root, d))
    .filter((d) => existsSync(resolve(d, "meta.json")));
}
