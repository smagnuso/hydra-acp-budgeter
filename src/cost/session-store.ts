import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { logger } from "../util/log.js";

const log = logger("cost/session-store");

// realpath normalization cache — avoids repeated stat(2)/realpath(3) calls
// when many sessions share the same parent tree.
const realpathCache = new Map<string, string>();

function realpathCached(path: string): string | undefined {
  if (realpathCache.has(path)) {
    return realpathCache.get(path);
  }
  try {
    const result = realpathSync(path);
    realpathCache.set(path, result);
    return result;
  } catch {
    realpathCache.set(path, undefined as unknown as string);
    return undefined;
  }
}

/** Resolve the sessions directory. Honors $HYDRA_ACP_HOME (default ~/.hydra-acp). */
export function sessionsDir(): string {
  const root = process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");
  return resolve(root, "sessions");
}

/** A single session's worth of metadata, read from meta.json. */
export interface SessionRecord {
  sessionId: string;
  cwd: string | undefined;
  agentId: string;
  model: string;
  interactive: boolean;
  costAmount: number;
  costCurrency: string;
  /** Highest context-window token count observed for the session. */
  contextTokens: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Hostname this session was imported from, if any. Empty/undefined means
   * the session originated on the local machine. */
  importedFromMachine?: string;
  /** Set when an imported session has been bound to a local agent (i.e. the
   * user has attached to it here). Used together with importedFromMachine
   * to distinguish "local working copy of an import" from a passive mirror. */
  upstreamSessionId?: string;
  /** Per-language line-count totals derived from Edit/Write tool diffs in
   * history.jsonl. Populated lazily by enrichSessionsWithLoc(); undefined
   * means "not yet computed" (treated as zeros by aggregate). */
  locByFiletype?: Record<string, { added: number; removed: number }>;
}

function readMetaJson(sessionPath: string): SessionRecord | undefined {
  const metaPath = resolve(sessionPath, "meta.json");
  let raw: string;
  try {
    raw = readFileSync(metaPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return undefined;
    }
    log.debug(`skipping ${sessionPath}: read meta.json failed: ${e.message}`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.debug(`skipping ${sessionPath}: meta.json is not valid JSON`);
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.debug(`skipping ${sessionPath}: meta.json is not an object`);
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;

  const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : undefined;
  if (sessionId === undefined) {
    log.debug(`skipping ${sessionPath}: missing sessionId`);
    return undefined;
  }

  // cwd — realpath-normalize when present and absolute; leave as-is otherwise.
  //
  // Attribute an isolated session to its SOURCE tree, not to the
  // workspace it physically ran in. A workspace lives outside the repo
  // (under ~/.hydra-acp/workspaces/<hash>/) and shares no path prefix
  // with it, so without this remap `--dir <repo>` matches nothing for
  // those sessions and their spend silently vanishes from the project's
  // total. Orchestrated runs are both the heaviest spenders and the
  // reason workspaces exist, so per-project cost would under-report
  // worst exactly when it matters most.
  //
  // It also outlives cleanup. Workspaces are removed when their session
  // is, and realpathCached below yields undefined for a path that no
  // longer exists, after which directory filtering skips the record
  // entirely. Attributing to the workspace would therefore lose the
  // spend permanently the moment cleanup ran; the source tree persists.
  //
  // Doing it here, at ingest, is deliberate: both the directory filter
  // and the grouping label downstream read this single `cwd`, so one
  // remap fixes both and neither has to learn about workspaces.
  let cwd: string | undefined;
  const workspace =
    typeof obj.workspace === "object" && obj.workspace !== null
      ? (obj.workspace as Record<string, unknown>)
      : undefined;
  const sourceCwd =
    typeof workspace?.sourceCwd === "string" ? workspace.sourceCwd : undefined;
  const rawCwd = sourceCwd ?? (typeof obj.cwd === "string" ? obj.cwd : undefined);
  if (rawCwd !== undefined) {
    if (isAbsolute(rawCwd)) {
      const resolved = realpathCached(rawCwd);
      cwd = resolved;
    } else {
      cwd = rawCwd;
    }
  }

  const agentId = typeof obj.agentId === "string" ? obj.agentId : "";
  const model = typeof obj.currentModel === "string" ? obj.currentModel : "";

  const interactiveRaw = obj.interactive;
  const interactive = interactiveRaw === true;

  const costUsage = (obj.currentUsage ?? undefined) as
    | {
        costAmount?: unknown;
        cumulativeCost?: unknown;
        costCurrency?: unknown;
        used?: unknown;
      }
    | undefined;
  // meta.json splits lifetime cost across two fields: cumulativeCost is spend
  // from retired agent lives (compaction swaps, /hydra agent switches,
  // resurrects) and costAmount is the current life's portion. Older daemons
  // collapsed both into costAmount and omitted cumulativeCost, so summing is
  // correct against either layout. Reading costAmount alone under-reports any
  // session that has rotated its agent.
  //
  // The REST path (cost/daemon-client.ts) does not need this — the daemon
  // already sums the two before serialising GET /v1/sessions.
  const costAmount =
    (typeof costUsage?.costAmount === "number" ? costUsage.costAmount : 0) +
    (typeof costUsage?.cumulativeCost === "number"
      ? costUsage.cumulativeCost
      : 0);
  const costCurrency =
    typeof costUsage?.costCurrency === "string" ? costUsage.costCurrency : "";
  const contextTokens = typeof costUsage?.used === "number" ? costUsage.used : 0;

  const title = typeof obj.title === "string" ? obj.title : "";

  const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : "";
  const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : "";
  const importedFromMachine =
    typeof obj.importedFromMachine === "string" && obj.importedFromMachine.length > 0
      ? obj.importedFromMachine
      : undefined;
  const upstreamSessionId =
    typeof obj.upstreamSessionId === "string" && obj.upstreamSessionId.length > 0
      ? obj.upstreamSessionId
      : undefined;

  return {
    sessionId,
    cwd,
    agentId,
    model,
    interactive,
    costAmount,
    costCurrency,
    contextTokens,
    title,
    createdAt,
    updatedAt,
    importedFromMachine,
    upstreamSessionId,
  };
}

/**
 * Populate `locByFiletype` on each record by streaming its history.jsonl
 * for Edit/Write diff payloads. In-place mutation; returns the same array
 * for chaining. Records whose history.jsonl is missing/empty get an empty
 * `locByFiletype` map (not undefined) so callers can distinguish
 * "computed, nothing found" from "not yet computed".
 */
export async function enrichSessionsWithLoc(
  records: SessionRecord[],
): Promise<SessionRecord[]> {
  const { streamHistoryEditEvents } = await import("./history-stream.js");
  for (const r of records) {
    const map: Record<string, { added: number; removed: number }> = {};
    for await (const ev of streamHistoryEditEvents(r)) {
      const cur = map[ev.filetype] ?? { added: 0, removed: 0 };
      cur.added += ev.linesAdded;
      cur.removed += ev.linesRemoved;
      map[ev.filetype] = cur;
    }
    r.locByFiletype = map;
  }
  return records;
}

/** Scan the sessions directory and return a typed SessionRecord[] for every valid meta.json found. */
export function scanSessions(): SessionRecord[] {
  const dir = sessionsDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    log.debug(`session store not found at ${dir}: ${e.message}`);
    return [];
  }

  const records: SessionRecord[] = [];

  for (const name of entries) {
    const sessionPath = resolve(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(sessionPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      continue;
    }
    const record = readMetaJson(sessionPath);
    if (record !== undefined) {
      records.push(record);
    }
  }

  return records;
}
