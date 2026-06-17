import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { logger } from "../util/log.js";
import type { SessionRecord } from "./session-store.js";

const log = logger("cost/daemon-client");

interface ClientConfig {
  daemonUrl: string;
  token: string;
}

// Token resolution order matches the cli's own pattern for local tools:
//   HYDRA_ACP_TOKEN env  →  budgeter.conf HYDRA_TOKEN  →  ~/.hydra-acp/auth-token
// We use the service token directly (option 1 of the auth design discussion);
// when daemon-side scoped tokens land we'll switch to requesting sessions:read.
function resolveToken(): string | undefined {
  if (process.env.HYDRA_ACP_TOKEN) {
    return process.env.HYDRA_ACP_TOKEN;
  }
  const tokenPath = resolve(
    process.env.HYDRA_HOME ?? resolve(homedir(), ".hydra-acp"),
    "auth-token",
  );
  try {
    const text = readFileSync(tokenPath, "utf8").trim();
    if (text.length > 0) {
      return text;
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      log.debug(`auth-token read failed: ${e.message}`);
    }
  }
  return undefined;
}

function resolveDaemonUrl(): string {
  return (
    process.env.HYDRA_ACP_DAEMON_URL ??
    "http://127.0.0.1:8765"
  );
}

function resolveConfig(): ClientConfig | undefined {
  const token = resolveToken();
  if (token === undefined) {
    return undefined;
  }
  return { daemonUrl: resolveDaemonUrl(), token };
}

// Map a daemon /v1/sessions row into our internal SessionRecord shape.
// Hydra-specific fields (cwd, agentId, currentModel, currentUsage,
// interactive) live in _meta["hydra-acp"]. Top-level updatedAt and
// sessionId are spec-shaped.
function rowToRecord(row: Record<string, unknown>): SessionRecord | undefined {
  const sessionId = typeof row.sessionId === "string" ? row.sessionId : undefined;
  if (sessionId === undefined) {
    return undefined;
  }
  const topUpdatedAt = typeof row.updatedAt === "string" ? row.updatedAt : "";

  const meta = (row._meta ?? {}) as Record<string, unknown>;
  const ns = (meta["hydra-acp"] ?? {}) as Record<string, unknown>;

  const cwd = typeof ns.cwd === "string" ? ns.cwd : undefined;
  const agentId = typeof ns.agentId === "string" ? ns.agentId : "";
  const model = typeof ns.currentModel === "string" ? ns.currentModel : "";
  const title = typeof ns.title === "string" ? ns.title : (typeof row.title === "string" ? row.title : "");
  const interactive = ns.interactive === true;

  const usage = (ns.currentUsage ?? undefined) as
    | { costAmount?: unknown; costCurrency?: unknown; used?: unknown }
    | undefined;
  const costAmount = typeof usage?.costAmount === "number" ? usage.costAmount : 0;
  const costCurrency =
    typeof usage?.costCurrency === "string" ? usage.costCurrency : "";
  const contextTokens = typeof usage?.used === "number" ? usage.used : 0;

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
    createdAt: "",
    updatedAt: topUpdatedAt,
  };
}

// Fetch the full session list from the daemon. Returns undefined when no
// auth token is available (no env var, no auth-token file) or when the
// daemon refuses / is unreachable. The caller falls back to a direct
// meta.json scan.
export async function listSessionsFromDaemon(): Promise<
  SessionRecord[] | undefined
> {
  const cfg = resolveConfig();
  if (cfg === undefined) {
    log.debug("no daemon token resolved; skipping daemon fetch");
    return undefined;
  }
  const url = `${cfg.daemonUrl.replace(/\/$/, "")}/v1/sessions?includeNonInteractive=1`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
  } catch (err) {
    log.debug(`daemon fetch failed (${url}): ${(err as Error).message}`);
    return undefined;
  }
  if (!resp.ok) {
    log.debug(`daemon returned HTTP ${resp.status} for ${url}`);
    return undefined;
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    log.debug(`daemon response not JSON: ${(err as Error).message}`);
    return undefined;
  }
  const obj = body as { sessions?: unknown };
  if (!Array.isArray(obj.sessions)) {
    log.debug("daemon response missing sessions[]");
    return undefined;
  }
  const out: SessionRecord[] = [];
  for (const row of obj.sessions) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const rec = rowToRecord(row as Record<string, unknown>);
      if (rec !== undefined) {
        out.push(rec);
      }
    }
  }
  return out;
}
