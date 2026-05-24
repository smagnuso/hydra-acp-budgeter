import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BudgetState } from "./rule.js";
import { logger } from "./util/log.js";

const log = logger("tracker");

export interface TrackerOptions {
  softLimit: number;
  hardLimit: number;
  currency: string;
  // Absolute path of the JSON file that holds the persisted per-session
  // cost map. Loaded on construction, atomically rewritten on every
  // applyUsageUpdate. Pass undefined to disable persistence (tests).
  statePath?: string;
}

export interface TrackerSnapshot {
  total: number;
  perSession: number;
  currency: string;
  soft: number;
  hard: number;
  state: BudgetState;
}

// Cost arrives via usage_update notifications. Each one carries a running
// total *for the current agent life* — not strictly monotonic across
// resurrects, but monotonic within a single agent process. We store the
// latest amount we've observed per sessionId and sum across sessions to
// derive the process-wide total. The map is persisted so spend survives
// daemon restarts (and resets — see adoptFromDisk / src/paths.ts).
//
// Cross-life cumulativeCost (when the daemon stamps it on the envelope)
// is honored if present, otherwise we fall back to costAmount.
interface PerSessionState {
  // Highest observed running cost. Resets on resurrect would otherwise
  // make the sum dip; clamping with max keeps the total non-decreasing.
  cost: number;
  // Mirror of the agent's reported currency for the latest update. Used
  // for cross-checking — if a session reports a currency different from
  // our configured one, we log a warning but keep summing.
  currency: string | undefined;
}

interface PersistedState {
  // Schema marker — bumped if the on-disk layout ever changes.
  version: 1;
  sessions: Record<string, PerSessionState>;
}

export class CostTracker {
  private sessions = new Map<string, PerSessionState>();
  private currentState: BudgetState = "ok";
  // Last JSON we wrote to disk. The watcher uses this to ignore its own
  // writes — if the file's content matches, we did it.
  private lastWrittenJson = "";

  constructor(private readonly opts: TrackerOptions) {
    if (opts.statePath) {
      this.loadFromDisk();
    }
  }

  applyUsageUpdate(
    sessionId: string,
    update: Record<string, unknown>,
  ): TrackerSnapshot {
    const cost = readCost(update);
    if (cost === undefined) {
      return this.snapshotFor(sessionId);
    }
    const prior = this.sessions.get(sessionId) ?? { cost: 0, currency: undefined };
    const next: PerSessionState = {
      cost: Math.max(prior.cost, cost.amount),
      currency: cost.currency ?? prior.currency,
    };
    this.sessions.set(sessionId, next);
    this.persist();
    return this.snapshotFor(sessionId);
  }

  // Public snapshot accessor for the synthetic events (session_opened,
  // prompt_request) that don't carry a cost in their own envelope.
  snapshotFor(sessionId: string): TrackerSnapshot {
    const per = this.sessions.get(sessionId);
    const total = this.totalCost();
    return {
      total,
      perSession: per?.cost ?? 0,
      currency: per?.currency ?? this.opts.currency,
      soft: this.opts.softLimit,
      hard: this.opts.hardLimit,
      state: deriveState(total, this.opts.softLimit, this.opts.hardLimit),
    };
  }

  // Returns the new state if this call transitioned to a higher tier
  // (ok→soft, ok→hard, soft→hard). Returns undefined if the state didn't
  // change or if it dropped (e.g. a reset zeroed everything).
  consumeStateTransition(): BudgetState | undefined {
    const next = deriveState(
      this.totalCost(),
      this.opts.softLimit,
      this.opts.hardLimit,
    );
    if (rank(next) > rank(this.currentState)) {
      this.currentState = next;
      return next;
    }
    if (next !== this.currentState) {
      this.currentState = next;
    }
    return undefined;
  }

  get state(): BudgetState {
    return this.currentState;
  }

  // Zero everything in memory and persist (or remove) the state file.
  // Used by the SIGUSR1-style flow when a user runs `hydra-acp-budgeter
  // reset` while the transformer process is alive, and by adoptFromDisk
  // when an external reset deleted the file.
  reset(): void {
    this.sessions.clear();
    this.currentState = "ok";
    this.persist();
  }

  // Re-read the state file and replace in-memory state if it changed
  // from what we last wrote. Called from the fs.watch handler in bridge.
  // Returns true when state was adopted (caller can react if it cares).
  adoptFromDisk(): boolean {
    if (!this.opts.statePath) {
      return false;
    }
    let raw: string;
    try {
      raw = readFileSync(this.opts.statePath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        // External deletion = reset.
        if (this.sessions.size === 0) {
          return false;
        }
        log.info("state file removed externally — resetting in-memory total");
        this.sessions.clear();
        this.currentState = "ok";
        this.lastWrittenJson = "";
        return true;
      }
      log.warn(`read state failed: ${e.message}`);
      return false;
    }
    if (raw === this.lastWrittenJson) {
      return false;
    }
    const adopted = this.applyPersisted(raw);
    if (adopted) {
      this.lastWrittenJson = raw;
      log.info(`adopted state from disk (total=${this.totalCost().toFixed(2)})`);
    }
    return adopted;
  }

  private loadFromDisk(): void {
    if (!this.opts.statePath) {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.opts.statePath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        log.warn(`read state failed: ${e.message}; starting fresh`);
      }
      return;
    }
    if (this.applyPersisted(raw)) {
      this.lastWrittenJson = raw;
      log.info(
        `loaded state from ${this.opts.statePath} (total=${this.totalCost().toFixed(2)})`,
      );
    }
  }

  private applyPersisted(raw: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn(`state file malformed: ${(err as Error).message}; ignoring`);
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log.warn("state file is not an object; ignoring");
      return false;
    }
    const obj = parsed as Partial<PersistedState>;
    const sessions = obj.sessions ?? {};
    if (typeof sessions !== "object" || Array.isArray(sessions)) {
      log.warn("state.sessions is not an object; ignoring");
      return false;
    }
    this.sessions.clear();
    for (const [id, val] of Object.entries(sessions)) {
      if (val && typeof val === "object" && typeof (val as PerSessionState).cost === "number") {
        const v = val as PerSessionState;
        this.sessions.set(id, {
          cost: v.cost,
          currency: typeof v.currency === "string" ? v.currency : undefined,
        });
      }
    }
    this.currentState = deriveState(
      this.totalCost(),
      this.opts.softLimit,
      this.opts.hardLimit,
    );
    return true;
  }

  private persist(): void {
    if (!this.opts.statePath) {
      return;
    }
    const payload: PersistedState = {
      version: 1,
      sessions: Object.fromEntries(this.sessions),
    };
    const json = JSON.stringify(payload, null, 2);
    if (json === this.lastWrittenJson) {
      return;
    }
    try {
      mkdirSync(dirname(this.opts.statePath), { recursive: true });
      const tmp = `${this.opts.statePath}.tmp`;
      writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.opts.statePath);
      this.lastWrittenJson = json;
    } catch (err) {
      log.warn(`persist failed: ${(err as Error).message}`);
    }
  }

  private totalCost(): number {
    let sum = 0;
    for (const s of this.sessions.values()) {
      sum += s.cost;
    }
    return sum;
  }
}

// Delete the persisted state file. Used by the `reset` subcommand when
// no live process is running (or as the message the live process picks
// up via fs.watch).
export function deleteStateFile(statePath: string): boolean {
  try {
    unlinkSync(statePath);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function deriveState(total: number, soft: number, hard: number): BudgetState {
  if (total >= hard) {
    return "hard";
  }
  if (total >= soft) {
    return "soft";
  }
  return "ok";
}

function rank(state: BudgetState): number {
  if (state === "hard") return 2;
  if (state === "soft") return 1;
  return 0;
}

function readCost(
  update: Record<string, unknown>,
): { amount: number; currency: string | undefined } | undefined {
  // hydra injects cumulative cost via _meta.hydra-acp.cumulativeCost on
  // usage_update for sessions that have lived across multiple agents.
  // Prefer that when present so resurrects don't undercount.
  const cumulative = readCumulativeFromMeta(update._meta);
  const cost = (update.cost ?? undefined) as
    | { amount?: unknown; currency?: unknown }
    | undefined;
  const amount =
    cumulative !== undefined
      ? cumulative
      : typeof cost?.amount === "number"
      ? cost.amount
      : undefined;
  if (amount === undefined) {
    return undefined;
  }
  const currency =
    typeof cost?.currency === "string" ? cost.currency : undefined;
  return { amount, currency };
}

function readCumulativeFromMeta(meta: unknown): number | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const ns = (meta as Record<string, unknown>)["hydra-acp"];
  if (!ns || typeof ns !== "object" || Array.isArray(ns)) {
    return undefined;
  }
  const v = (ns as Record<string, unknown>).cumulativeCost;
  return typeof v === "number" ? v : undefined;
}
