// `hydra-acp-budgeter repair` — one-time reconciliation of hydra's recorded
// cost against the agent's own ledger.
//
// Dry-run by default. Nothing is written without --apply, and everything
// --apply writes can be undone with --revert.
//
// Preconditions and refusals are deliberately loud: this rewrites transcripts
// and meta.json, so anything it cannot prove it declines to touch.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import {
  buildOpencodeIndex,
  defaultOpencodeDbs,
  listSessionDirs,
  knownUpstreams,
  readGate,
  scanSession,
  type OpencodeIndex,
} from "./repair-io.js";
import { planSession, splitLedger, type RefusalReason, type RepairPlan } from "./repair-core.js";
import { applyPlan, revertSession, reshapeSession, ALGO_VERSION } from "./repair-write.js";

export const REPAIR_HELP = `Usage: hydra-acp-budgeter repair [OPTIONS]

Reconcile recorded session cost against the agent's own ledger.

Sessions resurrected before the ledger-probe fix have inflated cost: the daemon
banked its displayed total, then a session-scoped agent re-reported the same
spend and the two were summed. This recomputes each recorded usage_update from
the agent's ledger, attributing work via tool-call ids.

Dry-run by default — prints what would change and writes nothing.

OPTIONS:
  --apply              Write the repair (requires the daemon to be stopped)
  --revert             Undo a previous repair, restoring the original values
  --reshape            Re-split an already-repaired session's cost ledger into
                       cumulativeCost (retired upstreams) + costAmount (current)
                       without touching its transcript. Fixes repairs written
                       before the split existed, whose collapsed shape makes the
                       next resurrect double-count the current upstream.
  --session <id>       Limit to one session (repeatable)
  --limit <n>          Process at most n sessions, largest inflation first
  --report <path>      Write a JSON report of the plan
  --json               Emit the report to stdout instead of a table
  --skip-warm          Allow running with the daemon up, skipping live sessions
  --force              Skip the daemon-stopped check (not recommended)
  -h, --help           Show this help

SAFETY
  * Original values are stamped into each rewritten row, write-once, so
    --revert restores byte-for-byte.
  * A repaired session is gated in meta.json and will not be repaired twice;
    to redo it, --revert first.
  * Sessions that cannot be proven are refused, never guessed at.
  * --revert refuses a session that recorded usage after its repair: those rows
    have no pristine value to restore, so the undo cannot be lossless. --force
    accepts the loss.
  * --reshape is idempotent and shape-only: for a session whose total is
    already right it moves money between the two fields and changes no total.
    The pre-reshape currentUsage is stamped write-once into the gate.
`;

interface Options {
  apply: boolean;
  revert: boolean;
  sessions: string[];
  limit: number | undefined;
  report: string | undefined;
  json: boolean;
  force: boolean;
  skipWarm: boolean;
  reshape: boolean;
}

function parseArgs(argv: string[]): Options | undefined {
  const o: Options = {
    apply: false,
    revert: false,
    sessions: [],
    limit: undefined,
    report: undefined,
    json: false,
    force: false,
    skipWarm: false,
    reshape: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--revert") o.revert = true;
    else if (a === "--reshape") o.reshape = true;
    else if (a === "--json") o.json = true;
    else if (a === "--force") o.force = true;
    else if (a === "--skip-warm") o.skipWarm = true;
    else if (a === "--session") o.sessions.push(argv[++i] ?? "");
    else if (a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "--report") o.report = argv[++i];
    else if (a === "-h" || a === "--help") return undefined;
    else {
      process.stderr.write(`repair: unknown option ${a}\n`);
      process.exit(2);
    }
  }
  if (o.apply && o.revert) {
    process.stderr.write(`repair: --apply and --revert are mutually exclusive\n`);
    process.exit(2);
  }
  if (o.reshape && o.revert) {
    process.stderr.write(`repair: --reshape and --revert are mutually exclusive\n`);
    process.exit(2);
  }
  return o;
}

/**
 * Whether the hydra daemon is running.
 *
 * A live daemon holds cumulativeCost in memory and rewrites meta.json on the
 * next usage_update, which would undo the meta half of the repair and leave
 * the transcript inconsistent with it — worse than not repairing at all. So
 * this is a hard precondition.
 *
 * FAIL-CLOSED. An earlier version returned "down" on any error, which meant a
 * wrong filename silently disabled the check and the repair ran against a live
 * daemon. Anything short of positive evidence that the daemon is stopped is
 * reported as "unknown" and blocks, so a future change to hydra's pid-file
 * layout degrades into a refusal rather than a silent bypass.
 */
export function daemonState(pidFilePath?: string): "up" | "down" | "unknown" {
  const path =
    pidFilePath ??
    resolve(process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp"), "daemon.pid");
  if (!existsSync(path)) {
    return "down"; // no pid file at all is positive evidence
  }
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
  } catch {
    return "unknown"; // unreadable/!JSON — cannot prove it is down
  }
  if (typeof pid !== "number") {
    return "unknown";
  }
  try {
    process.kill(pid, 0); // signal 0 tests liveness without delivering
    return "up";
  } catch (err) {
    // ESRCH: no such process -> stale pid file, daemon really is down.
    // EPERM: alive but not ours -> still up.
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "down" : "unknown";
  }
}

/**
 * Session ids the daemon currently holds warm, or undefined if that cannot be
 * established.
 *
 * Only warm sessions are unsafe to repair while the daemon runs: it holds
 * their cumulativeCost in memory and rewrites meta.json on the next
 * usage_update, undoing the meta half of the repair. A cold session is not
 * held at all, and resurrecting one AFTER repair is fine — the daemon reads
 * the corrected split and the probe matches, which is the outcome we want.
 *
 * Returns undefined rather than an empty set on any failure, so callers fail
 * closed instead of treating "could not ask" as "nothing is live".
 */
async function warmSessionIds(): Promise<Set<string> | undefined> {
  const home = process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");
  let port: number | undefined;
  let token: string | undefined;
  try {
    port = (JSON.parse(readFileSync(resolve(home, "daemon.pid"), "utf8")) as {
      loopbackPort?: number;
      port?: number;
    }).loopbackPort;
  } catch {
    return undefined;
  }
  try {
    token = readFileSync(resolve(home, "auth-token"), "utf8").trim();
  } catch {
    return undefined;
  }
  if (typeof port !== "number" || !token) {
    return undefined;
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions?status=warm`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as { sessions?: Array<{ sessionId?: string }> };
    if (!Array.isArray(body.sessions)) {
      return undefined;
    }
    return new Set(body.sessions.map((x) => x.sessionId).filter((x): x is string => !!x));
  } catch {
    return undefined;
  }
}

interface Row {
  sessionId: string;
  dir: string;
  reported: number;
  trueTotal: number;
  rows: number;
  upstreams: number;
  plan: RepairPlan;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function runRepair(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (opts === undefined) {
    process.stdout.write(REPAIR_HELP);
    return;
  }

  // Resolved for dry runs too, so a dry run predicts exactly what --apply does.
  let warm: Set<string> = new Set();
  if (opts.skipWarm) {
    const ids = await warmSessionIds();
    if (ids === undefined) {
      process.stderr.write(
        `repair: --skip-warm needs the daemon's warm-session list and could not get it.\n` +
          `Refusing rather than guessing which sessions are live.\n`,
      );
      process.exit(2);
    }
    warm = ids;
    process.stderr.write(`skipping ${warm.size} warm session(s) held by the running daemon\n`);
  }
  if (opts.apply || opts.revert || opts.reshape) {
    const state = daemonState();
    if (state === "up" && opts.skipWarm && !opts.force) {
      // Repairing cold sessions with the daemon up is safe: it holds no
      // in-memory state for them, and resurrecting one after repair reads the
      // corrected split and behaves correctly.
    } else if (state !== "down" && !opts.force) {
      process.stderr.write(
        state === "up"
          ? `repair: the hydra daemon is running.\n` +
              `Stop it first (\`hydra daemon stop\`) — a live daemon overwrites meta.json\n` +
              `from stale in-memory state and undoes half of the repair.\n` +
              `Use --force only if you are certain no session is live.\n`
          : `repair: cannot determine whether the hydra daemon is running.\n` +
              `Refusing rather than risking a write against a live daemon.\n` +
              `Stop the daemon and retry, or pass --force.\n`,
      );
      process.exit(2);
    }
  }

  let dirs = listSessionDirs();
  if (opts.sessions.length > 0) {
    const want = new Set(opts.sessions);
    dirs = dirs.filter((d) => want.has(basename(d)) || [...want].some((w) => basename(d).endsWith(w)));
  }

  if (opts.revert) {
    let n = 0;
    let rows = 0;
    let refusedN = 0;
    for (const dir of dirs) {
      if (warm.size > 0 && warm.has(basename(dir))) continue;
      const r = revertSession(dir, { force: opts.force });
      if (!r) continue;
      if (r.refused !== undefined) {
        refusedN += 1;
        process.stdout.write(`refused  ${basename(dir)}  ${r.refused}\n`);
        continue;
      }
      n += 1;
      rows += r.rowsReverted;
      process.stdout.write(`reverted ${basename(dir)}  (${r.rowsReverted} rows)\n`);
    }
    process.stdout.write(`\n${n} session(s) reverted, ${rows} rows restored.\n`);
    if (refusedN > 0) {
      process.stdout.write(
        `${refusedN} session(s) refused: they kept working after their repair, so a\n` +
          `revert would lose spend recorded since. Use --force to accept that.\n`,
      );
    }
    return;
  }

  const dbs = defaultOpencodeDbs();
  if (dbs.length === 0) {
    process.stderr.write(`repair: no OpenCode database found; nothing to reconcile against.\n`);
    process.exit(1);
  }

  if (opts.reshape) {
    process.stderr.write(`indexing ${dbs.length} OpenCode database(s)…\n`);
    const idx: OpencodeIndex = buildOpencodeIndex(dbs);
    let fixed = 0;
    let skipped = 0;
    let refusedN = 0;
    let delta = 0;
    for (const dir of dirs) {
      const scanned = scanSession(dir);
      if (scanned === undefined) continue;
      if (warm.size > 0 && warm.has(scanned.input.sessionId)) continue;
      const gate = readGate(scanned.meta);
      if (gate === undefined) continue;
      // Full ancestry, not just the gate: a session resurrected after its
      // repair has a current upstream the gate never recorded, and one whose
      // generations were reconstructed by hand knows more than the gate does.
      // See knownUpstreams.
      const ups = knownUpstreams(scanned.meta);
      if (ups.length === 0) continue;
      const split = splitLedger(idx.ledger, ups, scanned.meta.upstreamSessionId);
      const out = reshapeSession(dir, split, readToolVersion(), { dryRun: !opts.apply });
      if (out.kind === "refuse") {
        refusedN += 1;
        process.stdout.write(`refused  ${scanned.input.sessionId}  ${out.why}\n`);
        continue;
      }
      if (out.kind === "skip") {
        skipped += 1;
        continue;
      }
      fixed += 1;
      delta += out.totalDelta;
      process.stdout.write(
        `${opts.apply ? "reshaped" : "would reshape"} ${scanned.input.sessionId}  ` +
          `${out.beforeCum.toFixed(2)}+${out.beforeCur.toFixed(2)} -> ` +
          `${out.cum.toFixed(2)}+${out.cur.toFixed(2)}` +
          (Math.abs(out.totalDelta) > 0.005 ? `  total ${out.totalDelta > 0 ? "+" : ""}${out.totalDelta.toFixed(2)}` : ``) +
          `\n`,
      );
    }
    process.stdout.write(
      `\n${fixed} session(s) ${opts.apply ? "reshaped" : "to reshape"}, ${skipped} already correct, ${refusedN} refused.\n` +
        (opts.apply ? `` : `dry run — nothing written. Re-run with --apply.\n`) +
        `net total change $${delta.toFixed(2)} (shape-only for sessions whose total was already right)\n`,
    );
    return;
  }
  process.stderr.write(`indexing ${dbs.length} OpenCode database(s)…\n`);
  const index: OpencodeIndex = buildOpencodeIndex(dbs);

  const planned: Row[] = [];
  const refused = new Map<RefusalReason, { n: number; reported: number }>();
  let gated = 0;

  for (const dir of dirs) {
    const scanned = scanSession(dir);
    if (scanned === undefined) continue;
    if (warm.has(scanned.input.sessionId)) continue;
    if (readGate(scanned.meta)) {
      gated += 1;
      continue; // already repaired; --revert first to redo
    }
    const res = planSession(scanned.input, index.callIndex, index.ledger);
    if (!res.ok) {
      const cur = refused.get(res.refusal.reason) ?? { n: 0, reported: 0 };
      cur.n += 1;
      cur.reported += scanned.input.reportedTotal;
      refused.set(res.refusal.reason, cur);
      continue;
    }
    planned.push({
      sessionId: scanned.input.sessionId,
      dir,
      reported: res.plan.reportedTotal,
      trueTotal: res.plan.trueTotal,
      rows: res.plan.rows.length,
      upstreams: res.plan.attribution.upstreams.length,
      plan: res.plan,
    });
  }

  planned.sort((a, b) => b.reported - b.trueTotal - (a.reported - a.trueTotal));
  const limited = opts.limit === undefined ? planned : planned.slice(0, opts.limit);

  const totalReported = limited.reduce((s, r) => s + r.reported, 0);
  const totalTrue = limited.reduce((s, r) => s + r.trueTotal, 0);

  const report = {
    tool: "hydra-acp-budgeter",
    algo: ALGO_VERSION,
    at: new Date().toISOString(),
    mode: opts.apply ? "apply" : "dry-run",
    sessions: limited.map((r) => ({
      sessionId: r.sessionId,
      reported: r.reported,
      trueTotal: r.trueTotal,
      rows: r.rows,
      upstreams: r.plan.attribution.upstreams,
      forwardedSkipped: r.plan.attribution.forwardedSkipped,
    })),
    totals: { reported: totalReported, trueTotal: totalTrue, phantom: totalReported - totalTrue },
    refused: Object.fromEntries([...refused].map(([k, v]) => [k, v])),
    alreadyRepaired: gated,
    warmSkipped: warm.size,
  };
  if (opts.report !== undefined) {
    writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `\n${"session".padEnd(34)}${"rows".padStart(6)}${"ups".padStart(5)}` +
        `${"reported".padStart(13)}${"true".padStart(12)}${"phantom".padStart(13)}\n`,
    );
    for (const r of limited.slice(0, 25)) {
      process.stdout.write(
        `${r.sessionId.slice(-32).padEnd(34)}${String(r.rows).padStart(6)}` +
          `${String(r.upstreams).padStart(5)}${money(r.reported).padStart(13)}` +
          `${money(r.trueTotal).padStart(12)}${money(r.reported - r.trueTotal).padStart(13)}\n`,
      );
    }
    if (limited.length > 25) {
      process.stdout.write(`… and ${limited.length - 25} more\n`);
    }
    process.stdout.write(
      `\n${limited.length} session(s) repairable: ` +
        `$${money(totalReported)} recorded -> $${money(totalTrue)} actual ` +
        `($${money(totalReported - totalTrue)} phantom)\n`,
    );
    if (gated > 0) {
      process.stdout.write(`${gated} session(s) already repaired (use --revert to redo)\n`);
    }
    for (const [reason, v] of [...refused].sort((a, b) => b[1].reported - a[1].reported)) {
      process.stdout.write(`refused: ${reason.padEnd(22)} ${String(v.n).padStart(4)} sessions  $${money(v.reported)}\n`);
    }
  }

  if (!opts.apply) {
    // stderr under --json so stdout stays parseable.
    const note = `\nDry run — nothing written. Re-run with --apply to commit.\n`;
    if (opts.json) {
      process.stderr.write(note);
    } else {
      process.stdout.write(note);
    }
    return;
  }

  let applied = 0;
  let rowsTotal = 0;
  const failures: string[] = [];
  for (const r of limited) {
    const scanned = scanSession(r.dir);
    if (scanned === undefined) continue;
    try {
      const res = applyPlan(scanned, r.plan, readToolVersion());
      applied += 1;
      rowsTotal += res.rowsRewritten;
    } catch (err) {
      failures.push(`${r.sessionId}: ${(err as Error).message}`);
    }
  }
  process.stdout.write(`\napplied to ${applied} session(s), ${rowsTotal} rows rewritten.\n`);
  for (const f of failures) {
    process.stderr.write(`FAILED ${f}\n`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

function readToolVersion(): string {
  try {
    const p = resolve(import.meta.dirname, "../../package.json");
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}
