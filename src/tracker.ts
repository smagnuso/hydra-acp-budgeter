import type { BudgetState } from "./rule.js";
import { logger } from "./util/log.js";

const log = logger("tracker");

// Backing-store interface. Encapsulates the two extension_state RPCs the
// tracker cares about. Injected so tests can supply an in-memory fake
// without wiring up a whole transformer client.
export interface StateStore {
  // Fetch the persisted PerSessionState for one session, or undefined
  // when no data has been written yet.
  get(sessionId: string): Promise<PerSessionState | undefined>;
  // Overwrite the PerSessionState for one session. Fire-and-forget from
  // the tracker's perspective — failures log a warning but never propagate
  // (tracker state is authoritative in-memory during the process lifetime).
  set(sessionId: string, state: PerSessionState): Promise<void>;
  // Enumerate every session id the daemon knows about, so the tracker can
  // hydrate its in-memory map at boot. Returning [] disables boot
  // hydration — the tracker will still lazily load per session as
  // usage_updates arrive.
  listSessionIds(): Promise<string[]>;
}

export interface TrackerOptions {
  softLimit: number;
  hardLimit: number;
  currency: string;
  // Backing store for per-session cost state. Absent = tests / dry-run
  // mode: state lives in memory only, nothing is persisted.
  store?: StateStore;
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
// latest amount we've observed per sessionId (via the injected store) and
// sum across sessions to derive the process-wide total.
//
// PerSessionState is exposed on this interface because it's the exact
// shape written to extension_state; keeping it single-source-of-truth
// prevents drift between the on-disk format and the in-memory model.
export interface PerSessionState {
  // Highest observed running cost. Resets on resurrect would otherwise
  // make the sum dip; clamping with max keeps the total non-decreasing.
  cost: number;
  // Cost at the last reset. Effective spend = max(0, cost - baseline).
  // Allows reset without discarding the agent's running total.
  baseline: number;
  // Mirror of the agent's reported currency for the latest update. Used
  // for cross-checking — if a session reports a currency different from
  // our configured one, we log a warning but keep summing.
  currency: string | undefined;
}

export class CostTracker {
  private sessions = new Map<string, PerSessionState>();
  // Sessions we know are absent in the store (checked once, got nothing
  // back). Prevents repeat RPCs for sessions that never emitted cost.
  private confirmedAbsent = new Set<string>();
  // In-flight hydration promises so concurrent applyUsageUpdate calls
  // for a not-yet-loaded session serialize on the same fetch.
  private hydrating = new Map<string, Promise<void>>();
  private currentState: BudgetState = "ok";

  constructor(private readonly opts: TrackerOptions) {}

  // Boot-time bulk hydration. Iterates every session the daemon knows
  // about and loads its bucket. Best-effort — a failure on one session
  // is logged and skipped rather than aborting the boot. Safe to call
  // multiple times; already-loaded sessions are skipped.
  async hydrateAll(): Promise<void> {
    if (!this.opts.store) return;
    let ids: string[];
    try {
      ids = await this.opts.store.listSessionIds();
    } catch (err) {
      log.warn(
        `boot hydration failed to list sessions: ${(err as Error).message} — continuing with lazy loading`,
      );
      return;
    }
    for (const id of ids) {
      if (this.sessions.has(id) || this.confirmedAbsent.has(id)) continue;
      try {
        const state = await this.opts.store.get(id);
        if (state) {
          this.sessions.set(id, state);
        } else {
          this.confirmedAbsent.add(id);
        }
      } catch (err) {
        log.warn(
          `boot hydration failed for session ${id.slice(0, 12)}: ${(err as Error).message}`,
        );
      }
    }
    this.currentState = deriveState(
      this.totalCost(),
      this.opts.softLimit,
      this.opts.hardLimit,
    );
    log.info(
      `hydrated ${this.sessions.size} session(s), total=${this.totalCost().toFixed(2)}`,
    );
  }

  applyUsageUpdate(
    sessionId: string,
    update: Record<string, unknown>,
  ): TrackerSnapshot {
    log.debug(`usage_update session=${sessionId.slice(0, 12)} raw=${JSON.stringify(update).slice(0, 200)}`);
    const cost = readCost(update);
    if (cost === undefined) {
      log.debug(`readCost returned undefined for session=${sessionId.slice(0, 12)}`);
      return this.snapshotFor(sessionId);
    }
    const prior = this.sessions.get(sessionId) ?? { cost: 0, baseline: 0, currency: undefined };
    const next: PerSessionState = {
      cost: Math.max(prior.cost, cost.amount),
      baseline: prior.baseline,
      currency: cost.currency ?? prior.currency,
    };
    this.sessions.set(sessionId, next);
    this.confirmedAbsent.delete(sessionId);
    void this.persistOne(sessionId, next);
    return this.snapshotFor(sessionId);
  }

  // Ensure this session's state is loaded from the store into memory.
  // Callers use this when a session first appears (session.opened event)
  // so total is accurate before any usage_update arrives. Serializes
  // concurrent calls for the same session on a single in-flight fetch.
  async ensureHydrated(sessionId: string): Promise<void> {
    if (!this.opts.store) return;
    if (this.sessions.has(sessionId) || this.confirmedAbsent.has(sessionId)) return;
    const inFlight = this.hydrating.get(sessionId);
    if (inFlight) return inFlight;
    const p = (async () => {
      try {
        const state = await this.opts.store!.get(sessionId);
        if (state) {
          this.sessions.set(sessionId, state);
        } else {
          this.confirmedAbsent.add(sessionId);
        }
      } catch (err) {
        log.warn(
          `hydrate session ${sessionId.slice(0, 12)} failed: ${(err as Error).message}`,
        );
      } finally {
        this.hydrating.delete(sessionId);
      }
    })();
    this.hydrating.set(sessionId, p);
    return p;
  }

  // Public snapshot accessor for the synthetic events (session_opened,
  // prompt_request) that don't carry a cost in their own envelope.
  snapshotFor(sessionId: string): TrackerSnapshot {
    const per = this.sessions.get(sessionId);
    const total = this.totalCost();
    return {
      total,
      perSession: per ? Math.max(0, per.cost - per.baseline) : 0,
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

  // Baseline all in-memory sessions from their current cost so effective
  // spend reads zero without discarding the agent's running total. Also
  // writes the new baselines through to the store, so a subsequent
  // daemon restart doesn't undo the reset.
  reset(): void {
    for (const [id, s] of this.sessions) {
      const next: PerSessionState = { ...s, baseline: s.cost };
      this.sessions.set(id, next);
      void this.persistOne(id, next);
    }
    this.currentState = "ok";
  }

  private async persistOne(sessionId: string, state: PerSessionState): Promise<void> {
    if (!this.opts.store) return;
    try {
      await this.opts.store.set(sessionId, state);
    } catch (err) {
      log.warn(
        `persist ${sessionId.slice(0, 12)} failed: ${(err as Error).message}`,
      );
    }
  }

  private totalCost(): number {
    let sum = 0;
    for (const s of this.sessions.values()) {
      sum += Math.max(0, s.cost - s.baseline);
    }
    return sum;
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

// NOTE: hydra has never emitted _meta["hydra-acp"].cumulativeCost — verified
// across all revisions of the daemon. This code previously preferred that
// field over cost.amount, which is also the wrong semantics under hydra's
// split ledger: cumulativeCost means "spend on retired agent lives" and is a
// COMPONENT of the total, not the total. Per PROTOCOL.md "Cost ledger scope",
// every wire shape carries a single collapsed lifetime total in cost.amount
// with cumulativeCost omitted, so cost.amount is authoritative here.
function readCost(
  update: Record<string, unknown>,
): { amount: number; currency: string | undefined } | undefined {
  const cost = (update.cost ?? undefined) as
    | { amount?: unknown; currency?: unknown }
    | undefined;
  if (typeof cost?.amount !== "number") {
    return undefined;
  }
  const currency =
    typeof cost.currency === "string" ? cost.currency : undefined;
  return { amount: cost.amount, currency };
}
