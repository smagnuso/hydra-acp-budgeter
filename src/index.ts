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
import { scanSessions, enrichSessionsWithLoc } from "./cost/session-store.js";
import { listSessionsFromDaemon, fetchUsageEventsFromDaemon } from "./cost/daemon-client.js";
import { streamHistoryEvents, streamHistoryEditEvents } from "./cost/history-stream.js";
import type { CostEvent, EditEvent } from "./cost/history-stream.js";
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

const COST_HELP = `Usage: hydra budgeter usage [OPTIONS]

Options:
  --since <date|duration>  Only include sessions updated after this date (e.g. 7d, 2024-01-01)
  --bucket <hour|day|week|month>  Group results into time buckets (implies --since 24h/30d/6m/2y)
  --by <dir|session|model|agent|filetype>  Group by dimension (filetype requires --metric loc)
  --depth <N>              Depth for --by dir grouping (default: 1)
  --dir <path>             Only include sessions under this directory prefix
  --interactive            Only include interactive sessions (default: include both)
  --host <name|local|all>  Filter sessions by host. "local" (default) shows sessions
                           created here plus imports attached locally; "all" includes
                           every session; <name> shows passive mirrors imported from
                           that host.
  --min <N>                Drop sessions whose active-metric value is <= N (default: 0)
  --histogram              Show an ASCII histogram bar next to each row (implies --bucket week if no bucket given)
  --metric <cost|tokens|loc>  Display metric (default: cost). "loc" counts net lines of code
                              from Edit/Write tool diffs in session history.
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
    let host: string | undefined;

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
        } else if (arg === "--host") {
            i += 1;
            host = argv[i];
        } else if (arg.startsWith("--host=")) {
            host = arg.slice("--host=".length);
        } else if (arg.startsWith("--")) {
            const err = new Error(`Unknown option: ${arg}\nRun "hydra budgeter usage --help" for usage.`);
            throw err;
        }
    }

    if (metric !== undefined && metric !== "cost" && metric !== "tokens" && metric !== "loc") {
        const err = new Error("Invalid --metric value. Must be 'cost', 'tokens', or 'loc'.\nRun \"hydra budgeter usage --help\" for usage.");
        throw err;
    }

    const useLoc = metric === "loc";

    const validBy = new Set(["dir", "session", "model", "agent", "filetype"]);
    if (by !== undefined && !validBy.has(by)) {
        throw new Error(`Invalid --by value: ${by}. Must be one of: dir, session, model, agent, filetype.\nRun "hydra budgeter usage --help" for usage.`);
    }

    if (by === "filetype" && !useLoc) {
        throw new Error("--by filetype requires --metric loc.\nRun \"hydra budgeter usage --help\" for usage.");
    }

    let parsedSince: Date | undefined;

    if (since !== undefined) {
        try {
            parsedSince = parseSince(since);
        } catch (err) {
            const e = err as Error;
            const parseErr = new Error(`Invalid --since value: ${e.message}\nRun "hydra budgeter usage --help" for usage.`);
            throw parseErr;
        }
    }

    if (argv.length === 0) {
        bucket = "hour";
        histogram = true;
    }

    if (histogram && bucket === undefined) {
        bucket = "week";
    }

    let effectiveSince: Date | undefined = parsedSince;

    if (effectiveSince === undefined && bucket !== undefined) {
        const now = new Date();

        if (bucket === "hour") {
            now.setHours(now.getHours() - 24);
            effectiveSince = now;
        } else if (bucket === "day") {
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

    const allRecords =
    (await listSessionsFromDaemon()) ?? scanSessions();

    // LOC totals aren't carried by meta.json or the daemon's session list —
    // stream history.jsonl for each survivor to populate locByFiletype.
    // Done before filtering so a --min on loc has data to compare against.
    if (useLoc || by === "filetype") {
        await enrichSessionsWithLoc(allRecords);
    }

    const records = applyFilters(allRecords, {
        since: effectiveSince,
        dir,
        interactive: interactiveOpt,
        min: minVal,
        minMetric: useLoc ? "loc" : useTokens ? "tokens" : "cost",
        host: host ?? "local",
    });

    // Fetch per-turn usage events from the daemon when a bucket view is
    // requested. Each event carries cumulative cost + ts; the aggregator
    // diffs them per session for proper time-bucketing instead of lumping
    // each session's full cost at meta.updatedAt.
    //
    // NOTE: we deliberately do NOT pass `since` to the daemon here. The
    // daemon's `since` filter cuts events at the window boundary, which
    // would make the first in-window event's cumulative get attributed
    // entirely as a delta (re-creating the lump-at-boundary problem).
    // The aggregator's bucketKey + records.updatedAt pre-filter already
    // handles window slicing on its end.
    let events: CostEvent[] | undefined = undefined;
    if (bucket !== undefined) {
        const wireEvents = await fetchUsageEventsFromDaemon();
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
    }

    // For time-bucketed LOC views, stream EditEvents (with timestamps) for
    // the survivor set. Non-bucketed LOC views use the locByFiletype totals
    // that enrichSessionsWithLoc already populated, so no streaming here.
    let editEvents: EditEvent[] | undefined = undefined;
    if (useLoc && bucket !== undefined) {
        const list: EditEvent[] = [];
        for await (const ev of streamHistoryEditEvents(records)) {
            list.push(ev);
        }
        editEvents = list;
    }

    const depth = depthStr !== undefined ? parseInt(depthStr, 10) : undefined;

    const opts = {
        by: by as "dir" | "session" | "model" | "agent" | "filetype" | undefined,
        depth,
        bucket: bucket as "day" | "week" | "month" | undefined,
        since: effectiveSince,
        interactive: interactiveOpt,
        dir,
        tokens: useTokens,
        loc: useLoc,
        min: minVal,
    };

    const agg = aggregate(records, events, opts, editEvents);

    if (json) {
        process.stdout.write(renderJson(agg) + "\n");
    } else {
        const text = renderText(agg, { histogram, tokens: useTokens, loc: useLoc });
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
      `  hydra budgeter [usage] <flags> Report historical cost/usage across sessions\n` +
      `  hydra budgeter reset           Zero the accumulated-cost baseline\n` +
            `\n` +
            `Flags:\n` +
            `  -v, --version                 Print version and exit\n` +
            `  -h, --help                    Show this help\n`
    );
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes("--version") || argv.includes("-v")) {
        process.stdout.write(`hydra-acp-budgeter ${readVersion()}\n`);
        return;
    }
    if (argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
        if (argv[0] !== "usage" && argv[0] !== "cost") {
            printUsage();
            return;
        }
    }
    if (argv[0] === "reset") {
        runReset();
        return;
    }
    if (argv[0] === "usage" || argv[0] === "cost") {
        await runCost(argv.slice(1));
        return;
    }
    if (argv[0] === "run" || process.env.HYDRA_ACP_TOKEN) {
        await runTransformer();
        return;
    }
    await runCost(argv);
}

main().catch((err) => {
    process.stderr.write(`hydra-acp-budgeter: ${(err as Error).message}\n`);
    process.exit(1);
});
