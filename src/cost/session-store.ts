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
  let cwd: string | undefined;
  const rawCwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
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
    | { costAmount?: unknown; costCurrency?: unknown; used?: unknown }
    | undefined;
  const costAmount = typeof costUsage?.costAmount === "number" ? costUsage.costAmount : 0;
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
