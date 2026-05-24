import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Config {
  hydraDaemonUrl: string;
  hydraWsUrl: string;
  hydraToken: string;
  // Absolute path to the user's budgeter-config JS module
  // (~/.hydra-acp/budgeter.config.js by default). Falls back to
  // DEFAULT_RULE when the file doesn't exist.
  ruleConfigPath: string;
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

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return "wss://" + httpUrl.slice("https://".length).replace(/\/$/, "") + "/acp";
  }
  if (httpUrl.startsWith("http://")) {
    return "ws://" + httpUrl.slice("http://".length).replace(/\/$/, "") + "/acp";
  }
  throw new Error(`hydraDaemonUrl must start with http:// or https://: ${httpUrl}`);
}

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") {
    return fallback;
  }
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) {
    return fallback;
  }
  return TRUTHY.has(v.toLowerCase());
}

export function loadConfig(): Config {
  const hydraDaemonUrl =
    process.env.HYDRA_ACP_DAEMON_URL ?? "http://127.0.0.1:8765";
  const hydraToken = process.env.HYDRA_ACP_TOKEN ?? "";
  if (!hydraToken) {
    throw new Error(
      "Missing HYDRA_ACP_TOKEN env var. When run as a hydra transformer, hydra injects this automatically.",
    );
  }
  const hydraWsUrl =
    process.env.HYDRA_ACP_WS_URL ?? deriveWsUrl(hydraDaemonUrl);
  const ruleConfigPath =
    process.env.HYDRA_ACP_BUDGETER_CONFIG ??
    resolve(homedir(), ".hydra-acp", "budgeter.config.js");

  const softLimit = numEnv("HYDRA_ACP_BUDGETER_SOFT", 5);
  const hardLimit = numEnv("HYDRA_ACP_BUDGETER_HARD", 10);
  if (hardLimit < softLimit) {
    throw new Error(
      `HYDRA_ACP_BUDGETER_HARD (${hardLimit}) must be >= HYDRA_ACP_BUDGETER_SOFT (${softLimit})`,
    );
  }

  return {
    hydraDaemonUrl,
    hydraWsUrl,
    hydraToken,
    ruleConfigPath,
    softLimit,
    hardLimit,
    currency: process.env.HYDRA_ACP_BUDGETER_CURRENCY ?? "USD",
    debug: boolEnv("DEBUG", false),
  };
}
