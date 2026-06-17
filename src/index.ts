#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { BudgeterBridge } from "./bridge.js";
import { stateFilePath } from "./paths.js";
import { DEFAULT_RULE } from "./rule.js";
import { deleteStateFile } from "./tracker.js";
import { logger, setDebug } from "./util/log.js";
import { scanSessions } from "./cost/session-store.js";
import { streamHistoryEvents } from "./cost/history-stream.js";
import type { CostEvent } from "./cost/history-stream.js";
import { aggregate, applyFilters, parseSince } from "./cost/aggregate.js";
import { renderText, renderJson } from "./cost/format.js";

const log = logger("main");

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function runReset(): void {
  deleteStateFile(stateFilePath());
  process.stdout.write("hydra-acp-budgeter accumulated cost reset\n");
}

const COST_HELP = `Usage: hydra budgeter cost [OPTIONS]

Options:
  --since <date|duration>  Only include sessions updated after this date (e.g. 7d, 2024-01-01)
  --bucket <day|week|month>  Group results into time buckets (implies --since 30d/6m/2y)
  --by <dir|session|model|agent>  Group by dimension
  --depth <N>              Depth for --by dir grouping (default: 1)
  --dir <path>             Only include sessions under this directory prefix
  --interactive            Only include interactive sessions (default: include both)
  --min <N>                Drop sessions whose active-metric value is <= N (default: 0)
  --histogram              Show an ASCII histogram bar next to each row (implies --bucket week if no bucket given)
  --metric <cost|tokens>   Display metric (default: cost)
  --json                   Output as JSON
  --help                   Show this help message`;

async function runCost(argv: string[]): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write(COST_HELP + "\n");
    return;
  }

  let since: string | undefined;
  let bucket: string | undefined;
  let by: string | undefined;
  let depthStr: string | undefined;
  let dir: string | undefined;
  let interactiveOnly = false;
  let minStr: string | undefined;
  let histogram = false;
  let metric: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--since") {
      i += 1;
      since = argv[i];
    } else if (arg === "--bucket") {
      i += 1;
      bucket = argv[i];
    } else if (arg === "--by") {
      i += 1;
      by = argv[i];
    } else if (arg === "--depth") {
      i += 1;
      depthStr = argv[i];
    } else if (arg === "--dir") {
      i += 1;
      dir = argv[i];
    } else if (arg === "--interactive") {
      interactiveOnly = true;
    } else if (arg === "--min") {
      i += 1;
      minStr = argv[i];
    } else if (arg === "--histogram") {
      histogram = true;
    } else if (arg === "--metric") {
      i += 1;
      metric = argv[i];
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--")) {
      const err = new Error(`Unknown option: ${arg}\nRun "hydra budgeter cost --help" for usage.`);
      throw err;
    }
  }

  if (metric !== undefined && metric !== "cost" && metric !== "tokens") {
    const err = new Error("Invalid --metric value. Must be 'cost' or 'tokens'.\nRun \"hydra budgeter cost --help\" for usage.");
    throw err;
  }

  let parsedSince: Date | undefined;

  if (since !== undefined) {
    try {
      parsedSince = parseSince(since);
    } catch (err) {
      const e = err as Error;
      const parseErr = new Error(`Invalid --since value: ${e.message}\nRun "hydra budgeter cost --help" for usage.`);
      throw parseErr;
    }
  }

  if (histogram && bucket === undefined) {
    bucket = "week";
  }

  let effectiveSince: Date | undefined = parsedSince;

  if (effectiveSince === undefined && bucket !== undefined) {
    const now = new Date();

    if (bucket === "day") {
      now.setDate(now.getDate() - 30);
      effectiveSince = now;
    } else if (bucket === "week") {
      now.setMonth(now.getMonth() - 6);
      effectiveSince = now;
    } else if (bucket === "month") {
      now.setFullYear(now.getFullYear() - 2);
      effectiveSince = now;
    }
  }

  const interactiveOpt: boolean | undefined = interactiveOnly ? true : undefined;
  const useTokens = metric === "tokens";
  const minVal = minStr !== undefined ? parseFloat(minStr) : undefined;

  const allRecords = scanSessions();
  const records = applyFilters(allRecords, {
    since: effectiveSince,
    dir,
    interactive: interactiveOpt,
    min: minVal,
    minMetric: useTokens ? "tokens" : "cost",
  });

  const needsEvents = false;

  let events: CostEvent[] | undefined = undefined;

  if (needsEvents) {
    events = [];
    for await (const ev of streamHistoryEvents(records)) {
      events.push(ev);
    }
  }

  const depth = depthStr !== undefined ? parseInt(depthStr, 10) : undefined;

  const opts = {
    by: by as "dir" | "session" | "model" | "agent" | undefined,
    depth,
    bucket: bucket as "day" | "week" | "month" | undefined,
    since: effectiveSince,
    interactive: interactiveOpt,
    dir,
    tokens: useTokens,
    min: minVal,
  };

  const agg = aggregate(records, events, opts);

  if (json) {
    process.stdout.write(renderJson(agg) + "\n");
  } else {
    const text = renderText(agg, { histogram, tokens: metric === "tokens" });
    process.stdout.write(text);
  }
}

async function runTransformer(): Promise<void> {
  const config = loadConfig();
  setDebug(config.debug);

  const statePath = stateFilePath();
  const bridge = new BudgeterBridge({
    daemonWsUrl: config.hydraWsUrl,
    token: config.hydraToken,
    softLimit: config.softLimit,
    hardLimit: config.hardLimit,
    currency: config.currency,
    rule: DEFAULT_RULE,
    statePath,
  });
  bridge.start();

  const shutdown = (sig: string): void => {
    log.info(`${sig} received — shutting down`);
    bridge.stop();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info(
    `hydra-acp-budgeter up; daemon=${config.hydraDaemonUrl} soft=${config.softLimit} hard=${config.hardLimit} ${config.currency} state=${statePath}`,
  );
}

function printUsage(): void {
  process.stdout.write(
    `hydra-acp-budgeter ${readVersion()}\n` +
      `\n` +
      `Usage:\n` +
      `  hydra budgeter cost [flags]   Report historical cost across sessions\n` +
      `  hydra budgeter reset          Zero the accumulated-cost baseline\n` +
      `  hydra budgeter run            Run as a hydra transformer (requires HYDRA_ACP_TOKEN)\n` +
      `\n` +
      `Flags:\n` +
      `  -v, --version                 Print version and exit\n` +
      `  -h, --help                    Show this help\n` +
      `\n` +
      `Run 'hydra budgeter cost --help' for cost-command flags.\n` +
      `\n` +
      `When invoked by hydra as a transformer, HYDRA_ACP_TOKEN is injected\n` +
      `automatically and the process enters transformer mode. With no\n` +
      `arguments and no token in the environment, this help is shown.\n`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`hydra-acp-budgeter ${readVersion()}\n`);
    return;
  }
  if (argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
    if (argv[0] !== "cost") {
      printUsage();
      return;
    }
  }
  if (argv[0] === "reset") {
    runReset();
    return;
  }
  if (argv[0] === "cost") {
    await runCost(argv.slice(1));
    return;
  }
  if (argv[0] === "run" || process.env.HYDRA_ACP_TOKEN) {
    await runTransformer();
    return;
  }
  printUsage();
}

main().catch((err) => {
  process.stderr.write(`hydra-acp-budgeter: ${(err as Error).message}\n`);
  process.exit(1);
});
