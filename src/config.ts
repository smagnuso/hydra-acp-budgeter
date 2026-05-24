import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Config {
  hydraDaemonUrl: string;
  hydraWsUrl: string;
  hydraToken: string;
  // Spend thresholds in the configured currency. Soft fires warnings;
  // hard rejects prompts and warns on session_opened.
  softLimit: number;
  hardLimit: number;
  // ISO-3 currency code used to format messages and to label cost when
  // the agent's usage_update omits one. Defaults to USD because every
  // ACP agent we ship reports prices in dollars today.
  currency: string;
  debug: boolean;
}

const PRIMARY_CONF_PATH = resolve(homedir(), ".hydra-acp", "budgeter.conf");

export function configPath(): string {
  const override = process.env.HYDRA_ACP_BUDGETER_CONF;
  if (override) {
    return override;
  }
  return PRIMARY_CONF_PATH;
}

function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out.set(key, val);
  }
  return out;
}

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return "wss://" + httpUrl.slice("https://".length).replace(/\/$/, "") + "/acp";
  }
  if (httpUrl.startsWith("http://")) {
    return "ws://" + httpUrl.slice("http://".length).replace(/\/$/, "") + "/acp";
  }
  throw new Error(`hydraDaemonUrl must start with http:// or https://: ${httpUrl}`);
}

function floatVal(
  map: Map<string, string>,
  envName: string,
  key: string,
  fallback: number,
): number {
  const v = process.env[envName] ?? map.get(key);
  if (v === undefined || v === "") {
    return fallback;
  }
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

function boolVal(
  map: Map<string, string>,
  envName: string,
  key: string,
  fallback: boolean,
): boolean {
  const v = process.env[envName] ?? map.get(key);
  if (v === undefined) {
    return fallback;
  }
  return TRUTHY.has(v.toLowerCase());
}

function strVal(
  map: Map<string, string>,
  envName: string,
  key: string,
  fallback: string,
): string {
  return process.env[envName] ?? map.get(key) ?? fallback;
}

export function loadConfig(path: string = configPath()): Config {
  let map = new Map<string, string>();
  if (existsSync(path)) {
    try {
      map = parseEnvFile(readFileSync(path, "utf8"));
    } catch (err) {
      // Non-fatal — log and continue with env vars / defaults.
      process.stderr.write(
        `hydra-acp-budgeter: warning: could not read ${path}: ${(err as Error).message}\n`,
      );
    }
  }

  // Hydra-injected connection vars: env always wins, conf file is fallback.
  const hydraDaemonUrl =
    process.env.HYDRA_ACP_DAEMON_URL ??
    map.get("HYDRA_DAEMON_URL") ??
    "http://127.0.0.1:8765";
  const hydraToken =
    process.env.HYDRA_ACP_TOKEN ?? map.get("HYDRA_TOKEN") ?? "";
  if (!hydraToken) {
    throw new Error(
      "Missing HYDRA_ACP_TOKEN env var (or HYDRA_TOKEN in budgeter.conf). " +
        "When run as a hydra transformer, hydra injects this automatically.",
    );
  }
  const hydraWsUrl =
    process.env.HYDRA_ACP_WS_URL ??
    map.get("HYDRA_WS_URL") ??
    deriveWsUrl(hydraDaemonUrl);

  const softLimit = floatVal(map, "HYDRA_ACP_BUDGETER_SOFT", "SOFT", 5);
  const hardLimit = floatVal(map, "HYDRA_ACP_BUDGETER_HARD", "HARD", 10);
  if (hardLimit < softLimit) {
    throw new Error(
      `HARD (${hardLimit}) must be >= SOFT (${softLimit})`,
    );
  }

  return {
    hydraDaemonUrl,
    hydraWsUrl,
    hydraToken,
    softLimit,
    hardLimit,
    currency: strVal(map, "HYDRA_ACP_BUDGETER_CURRENCY", "CURRENCY", "USD"),
    debug: boolVal(map, "DEBUG", "DEBUG", false),
  };
}
