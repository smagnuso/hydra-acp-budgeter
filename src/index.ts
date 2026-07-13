#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { BudgeterBridge } from "./bridge.js";
import { DEFAULT_RULE } from "./rule.js";
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
    // Legacy CLI subcommand. Cost state now lives in each session's
    // meta.json via extension_state, so there's no single file to
    // delete out-of-band. Direct the user to the slash-command path,
    // which reaches the live transformer over WS and resets across
    // all in-memory sessions.
    process.stderr.write(
        `hydra-acp-budgeter: 'reset' as a CLI subcommand is no longer supported.\n` +
        `Run \`/hydra hydra-acp-budgeter reset\` in a live hydra session instead.\n` +
        `Cost state is now persisted per-session in meta.json (extension_state).\n`,
    );
    process.exit(2);
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
  --histogram              Show an ASCII histogram bar next to each row (default on; implies --bucket hour if no bucket given)
  --no-histogram           Collapse to a single total row (also drops the default hourly bucket)
  --metric <cost|tokens|loc>  Display metric (default: cost). "loc" counts net lines of code
                              from Edit/Write tool diffs in session history.
  --json                   Output as JSON
  --help                   Show this help message`;

async function runCost(argv: string[]): Promise<void> {
    if (argv.includes("--help")) {
        process.stdout.write(COST_HELP + "\n");
        return;
    }

    // Defaults represent the bare `hydra budgeter` view: a 24h hourly
    // histogram. Flags below override individual fields. --by suppresses
    // histogram/bucket at resolution time (below) because grouping is
    // orthogonal to time-slicing.
    let since: string | undefined;
    let bucket: string | undefined = "hour";
    let by: string | undefined;
    let depthStr: string | undefined;
    let dir: string | undefined;
    let interactiveOnly = false;
    let minStr: string | undefined;
    let histogram = true;
    let metric: string | undefined;
    let json = false;
    let host: string | undefined;
    let bucketExplicit = false;
    let histogramExplicit = false;

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
            bucketExplicit = true;
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
            histogramExplicit = true;
        } else if (arg === "--no-histogram") {
            histogram = false;
            histogramExplicit = true;
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

    // --by is a grouping view, orthogonal to time-bucketing. If the user
    // didn't explicitly ask for a bucket or histogram, drop both — we'll
    // render a flat grouped table instead of a grouped time-series.
    if (by !== undefined) {
        if (!bucketExplicit) {
            bucket = undefined;
        }
        if (!histogramExplicit) {
            histogram = false;
        }
    }

    // Histogram and time-bucketing move together: turning off the histogram
    // (--no-histogram) drops the default hourly bucket too, so the view
    // collapses to a single total row instead of a time-series with no bars.
    if (!histogram && !bucketExplicit) {
        bucket = undefined;
    }

    // Resolve the window. Explicit --since wins; otherwise the bucket
    // (default "hour" for the histogram view, undefined for --by) picks a
    // natural width; otherwise 24 hours. Applied uniformly so the
    // "N sessions" scope is comparable across invocations that only differ
    // by display flags.
    let effectiveSince: Date;

    if (parsedSince !== undefined) {
        effectiveSince = parsedSince;
    } else {
        const now = new Date();
        if (bucket === "day") {
            now.setDate(now.getDate() - 30);
        } else if (bucket === "week") {
            now.setMonth(now.getMonth() - 6);
        } else if (bucket === "month") {
            now.setFullYear(now.getFullYear() - 2);
        } else {
            now.setHours(now.getHours() - 24);
        }
        effectiveSince = now;
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

    const windowLabel = computeWindowLabel({
        sinceRaw: since,
        effectiveSince,
        bucket,
    });

    if (json) {
        process.stdout.write(renderJson(agg) + "\n");
    } else {
        const text = renderText(agg, { histogram, tokens: useTokens, loc: useLoc, windowLabel });
        process.stdout.write(text);
    }
}

function computeWindowLabel(args: {
    sinceRaw: string | undefined;
    effectiveSince: Date;
    bucket: string | undefined;
}): string {
    if (args.sinceRaw !== undefined) {
        const pretty = prettyRelative(args.sinceRaw);
        return pretty !== undefined ? `last ${pretty}` : `since ${args.sinceRaw}`;
    }
    if (args.bucket === "day") return "last 30 days";
    if (args.bucket === "week") return "last 6 months";
    if (args.bucket === "month") return "last 2 years";
    if (args.bucket === "hour") return "last 24 hours";
    return "last 24 hours (default; pass --since to widen)";
}

// Turn a relative --since spec (7d, 24h, 2w, 90d, 18m, 10y) into a
// natural-language phrase — rolling up smaller units into larger ones
// when they land exactly on a boundary (24h → 1 day, 7d → 1 week,
// 12m → 1 year), and leaving them as-is when they don't. Returns
// undefined for ISO date strings — the caller falls back to the raw form.
function prettyRelative(spec: string): string | undefined {
    const m = spec.match(/^(\d+)\s*([dhmwy])$/i);
    if (m === null) {
        return undefined;
    }
    let amount = parseInt(m[1] ?? "0", 10);
    let unit = (m[2] ?? "").toLowerCase();

    if (unit === "h" && amount % 24 === 0) {
        amount = amount / 24;
        unit = "d";
    }
    if (unit === "d" && amount % 7 === 0 && amount < 30) {
        amount = amount / 7;
        unit = "w";
    }
    if (unit === "m" && amount % 12 === 0) {
        amount = amount / 12;
        unit = "y";
    }

    const word = ({
        h: "hour",
        d: "day",
        w: "week",
        m: "month",
        y: "year",
    } as Record<string, string>)[unit];
    if (word === undefined) {
        return undefined;
    }
    return `${amount} ${word}${amount === 1 ? "" : "s"}`;
}

async function runTransformer(): Promise<void> {
    const config = loadConfig();
    setDebug(config.debug);

    const bridge = new BudgeterBridge({
        daemonWsUrl: config.hydraWsUrl,
        daemonHttpBase: config.hydraDaemonUrl,
        token: config.hydraToken,
        softLimit: config.softLimit,
        hardLimit: config.hardLimit,
        currency: config.currency,
        rule: DEFAULT_RULE,
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
        `hydra-acp-budgeter up; daemon=${config.hydraDaemonUrl} soft=${config.softLimit} hard=${config.hardLimit} ${config.currency} state=per-session (extension_state)`,
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
