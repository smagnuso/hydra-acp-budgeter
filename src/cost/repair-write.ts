// Writing and reverting the cost reconciliation.
//
// The safety model, in order of importance:
//
//   1. Untouched lines are never re-serialised. We hold each transcript file
//      as raw strings and substitute only the rows we repair, so byte-identity
//      for everything else is structural rather than asserted. Files with no
//      repaired rows are not rewritten at all.
//
//   2. `original` is write-once. It records the value as it stood BEFORE ANY
//      repair, and is never updated by a later run. Stamping "the value that
//      was there when the fixup ran" would, on a second run, capture the
//      already-repaired figure and destroy the pristine one.
//
//   3. A session-level gate in meta.json's extensionState makes re-running a
//      no-op. Undo is explicit, not implicit: if the algorithm turns out to be
//      wrong, revert and re-run rather than layering a second correction over
//      the first.
//
//   4. meta.json and the transcript are written together. Repairing rows while
//      leaving meta.json stale is worse than doing neither — the daemon would
//      resume from the old inflated baseline and the next resurrect would bank
//      against a value the transcript no longer contains.
//
// Writes go to a temp file and are renamed, so a crash mid-write leaves the
// original intact.

import { renameSync, writeFileSync, readFileSync, statSync, utimesSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { logger } from "../util/log.js";
import type { RepairPlan } from "./repair-core.js";
import {
  BUDGETER_NS,
  REPAIR_KEY,
  readMeta,
  readTranscriptFiles,
  type ScannedSession,
} from "./repair-io.js";

const log = logger("cost/repair-write");

/** Bumped only when detection/repair logic changes — what you discount on. */
export const ALGO_VERSION = 1;
/** Bumped when the marker's shape changes. */
export const MARKER_VERSION = 1;

export interface RepairGate {
  v: number;
  algo: number;
  tool: string;
  source: "opencode-ledger";
  method: "tool-call-join";
  upstreams: string[];
  rowsRewritten: number;
  /** Write-once. meta.json's currentUsage before any repair. */
  originalCurrentUsage: Record<string, unknown> | undefined;
  /**
   * Whether meta.json carried an extensionState key before the repair. A
   * session with an empty `extensionState: {}` must get it back on revert —
   * deleting it because it is empty would leave a trace.
   */
  hadExtensionState: boolean;
  reportedTotal: number;
  trueTotal: number;
  at: string;
}

function toolString(version: string): string {
  return `${BUDGETER_NS}@${version}`;
}

/**
 * Rewrite one JSONL line's cost.amount and stamp the pristine value.
 * Returns the line unchanged if it already carries a stamp — `original` must
 * survive a second pass untouched.
 */
export function rewriteLine(line: string, repaired: number): string {
  const entry = JSON.parse(line) as {
    params: { update: Record<string, unknown> };
  };
  const update = entry.params.update;
  const meta = (update._meta as Record<string, unknown> | undefined) ?? {};
  const ns = ((meta["hydra-acp"] as Record<string, unknown> | undefined) ?? {}) as Record<
    string,
    unknown
  >;
  const cost = (update.cost as Record<string, unknown> | undefined) ?? {};
  const existing = ns[REPAIR_KEY] as { original?: unknown } | undefined;

  // Write-once: only capture `original` if this row has never been repaired.
  const original =
    existing && typeof existing.original === "number"
      ? existing.original
      : (cost.amount as number | undefined);

  ns[REPAIR_KEY] = { v: MARKER_VERSION, algo: ALGO_VERSION, original };
  meta["hydra-acp"] = ns;
  update._meta = meta;
  update.cost = { ...cost, amount: repaired };
  return JSON.stringify(entry);
}

/** Restore a repaired line to its pristine value and drop the marker. */
export function revertLine(line: string): string | undefined {
  const entry = JSON.parse(line) as {
    params: { update: Record<string, unknown> };
  };
  const update = entry.params.update;
  const meta = update._meta as Record<string, unknown> | undefined;
  const ns = meta?.["hydra-acp"] as Record<string, unknown> | undefined;
  const marker = ns?.[REPAIR_KEY] as { original?: unknown } | undefined;
  if (!marker) {
    return undefined; // not ours; leave alone
  }
  if (typeof marker.original === "number") {
    update.cost = { ...((update.cost as Record<string, unknown>) ?? {}), amount: marker.original };
  }
  delete ns![REPAIR_KEY];
  if (Object.keys(ns!).length === 0) {
    delete meta!["hydra-acp"];
  }
  if (Object.keys(meta!).length === 0) {
    delete update._meta;
  }
  return JSON.stringify(entry);
}

// The daemon derives a session's `updatedAt` from the history.jsonl mtime
// (session-manager historyStatus), which drives AGE, picker ordering and
// session-gc candidacy. Rewriting cost fields is not activity, so the
// original mtime is carried across the rename.
function writeFileAtomic(path: string, body: Buffer | string): void {
  const tmp = `${path}.repair-tmp`;
  let prior: { atime: Date; mtime: Date } | undefined;
  try {
    const st = statSync(path);
    prior = { atime: st.atime, mtime: st.mtime };
  } catch {
    prior = undefined;
  }
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
  if (prior) {
    utimesSync(path, prior.atime, prior.mtime);
  }
}

function serialise(file: { name: string; gz: boolean; lines: string[] }): Buffer | string {
  const text = file.lines.join("\n");
  return file.gz ? gzipSync(Buffer.from(text, "utf8")) : text;
}

export interface ApplyResult {
  readonly filesRewritten: string[];
  readonly rowsRewritten: number;
}

/**
 * Apply a plan: rewrite the affected transcript rows, update meta.json's
 * currentUsage, and install the gate. Throws before touching anything if the
 * session is already gated.
 */
export function applyPlan(
  scanned: ScannedSession,
  plan: RepairPlan,
  toolVersion: string,
): ApplyResult {
  const byFile = new Map<string, Map<number, number>>();
  for (const row of plan.rows) {
    // Rows whose value is already correct need no rewrite and no marker.
    if (Math.abs(row.repaired - row.amount) < 1e-9) {
      continue;
    }
    const m = byFile.get(row.file) ?? new Map<number, number>();
    m.set(row.line, row.repaired);
    byFile.set(row.file, m);
  }

  const rewritten: string[] = [];
  let rows = 0;
  for (const file of scanned.files) {
    const edits = byFile.get(file.name);
    if (!edits || edits.size === 0) {
      continue; // untouched files are not rewritten at all
    }
    const lines = [...file.lines];
    for (const [lineNo, value] of edits) {
      const src = lines[lineNo];
      if (src === undefined || src.length === 0) {
        throw new Error(`${file.name}:${lineNo} missing while applying repair`);
      }
      lines[lineNo] = rewriteLine(src, value);
      rows += 1;
    }
    writeFileAtomic(resolve(scanned.dir, file.name), serialise({ ...file, lines }));
    rewritten.push(file.name);
  }

  writeMetaRepaired(scanned, plan, rows, toolVersion);
  return { filesRewritten: rewritten, rowsRewritten: rows };
}

/**
 * Update meta.json: corrected currentUsage plus the gate. The gate carries the
 * ORIGINAL currentUsage, which is the only way to undo sessions that have no
 * usage rows to stamp — those get a meta-only repair.
 *
 * The extensionState bucket is merged, never replaced: budgeter's tracker owns
 * a "state" key there and overwriting the bucket would destroy it.
 */
function writeMetaRepaired(
  scanned: ScannedSession,
  plan: RepairPlan,
  rowsRewritten: number,
  toolVersion: string,
): void {
  const path = resolve(scanned.dir, "meta.json");
  const meta = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const usage = (meta.currentUsage as Record<string, unknown> | undefined) ?? {};

  const gate: RepairGate = {
    v: MARKER_VERSION,
    algo: ALGO_VERSION,
    tool: toolString(toolVersion),
    source: "opencode-ledger",
    method: "tool-call-join",
    upstreams: [...plan.attribution.upstreams],
    rowsRewritten,
    originalCurrentUsage: meta.currentUsage as Record<string, unknown> | undefined,
    hadExtensionState: meta.extensionState !== undefined,
    reportedTotal: plan.reportedTotal,
    trueTotal: plan.trueTotal,
    at: new Date().toISOString(),
  };

  // The split is collapsed deliberately: costAmount carries the agent's own
  // lifetime total and cumulativeCost is cleared, which is the correct shape
  // for a resurrect probe to compare against.
  meta.currentUsage = { ...usage, costAmount: plan.trueTotal, cumulativeCost: undefined };
  const state = (meta.extensionState as Record<string, Record<string, unknown>> | undefined) ?? {};
  state[BUDGETER_NS] = { ...(state[BUDGETER_NS] ?? {}), [REPAIR_KEY]: gate };
  meta.extensionState = state;

  writeFileAtomic(path, `${JSON.stringify(meta, null, 2)}\n`);
}

export interface RevertResult {
  readonly filesRewritten: string[];
  readonly rowsReverted: number;
}

/** Undo a repair: pristine row values restored, markers and gate removed. */
export function revertSession(sessionDir: string): RevertResult | undefined {
  const meta = readMeta(sessionDir);
  if (meta === undefined) {
    return undefined;
  }
  const bucket = meta.extensionState?.[BUDGETER_NS];
  const gate = bucket?.[REPAIR_KEY] as RepairGate | undefined;
  if (!gate) {
    return undefined; // never repaired
  }

  const rewritten: string[] = [];
  let reverted = 0;
  for (const file of readTranscriptFiles(sessionDir)) {
    const lines = [...file.lines];
    let touched = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.length === 0 || !line.includes(REPAIR_KEY)) {
        continue;
      }
      let next: string | undefined;
      try {
        next = revertLine(line);
      } catch {
        continue;
      }
      if (next !== undefined) {
        lines[i] = next;
        touched = true;
        reverted += 1;
      }
    }
    if (touched) {
      writeFileAtomic(resolve(sessionDir, file.name), serialise({ ...file, lines }));
      rewritten.push(file.name);
    }
  }

  const path = resolve(sessionDir, "meta.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (gate.originalCurrentUsage === undefined) {
    delete raw.currentUsage;
  } else {
    raw.currentUsage = gate.originalCurrentUsage;
  }
  const state = (raw.extensionState as Record<string, Record<string, unknown>>) ?? {};
  if (state[BUDGETER_NS]) {
    delete state[BUDGETER_NS]![REPAIR_KEY];
    // Drop the namespace only if we were the only occupant — budgeter's
    // tracker may own "state" in the same bucket.
    if (Object.keys(state[BUDGETER_NS]!).length === 0) {
      delete state[BUDGETER_NS];
    }
  }
  // Leave no trace: restore whether the key existed at all, not merely
  // whether it is now empty. A session that already had `extensionState: {}`
  // must get it back, and one that had none must not gain one.
  if (Object.keys(state).length === 0 && !gate.hadExtensionState) {
    delete raw.extensionState;
  } else {
    raw.extensionState = state;
  }
  writeFileAtomic(path, `${JSON.stringify(raw, null, 2)}\n`);
  log.debug(`reverted ${sessionDir}: ${reverted} rows`);
  return { filesRewritten: rewritten, rowsReverted: reverted };
}
