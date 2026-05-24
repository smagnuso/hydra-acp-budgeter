import type { BudgetState } from "./rule.js";

export interface TrackerOptions {
  softLimit: number;
  hardLimit: number;
  currency: string;
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
// derive the process-wide total.
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

export class CostTracker {
  private sessions = new Map<string, PerSessionState>();
  private currentState: BudgetState = "ok";

  constructor(private readonly opts: TrackerOptions) {}

  // Apply a usage_update envelope and return the snapshot reflecting the
  // post-update totals. The update shape (from hydra/Session) is:
  //   { sessionUpdate: "usage_update", used?, size?, cost?: { amount, currency } }
  // plus an optional _meta.hydra-acp.cumulativeCost we use when present.
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
    return this.snapshotFor(sessionId);
  }

  // Forget a session — fires on session_closed so the per-session total
  // doesn't linger. Note: this *reduces* the running total, which is the
  // right behavior for "budget consumed so far this transformer run"; if
  // you want a sticky total across closes, drop this call from the bridge.
  forget(sessionId: string): TrackerSnapshot {
    this.sessions.delete(sessionId);
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
  // change or if it dropped (e.g. a session forgot reduces the total).
  // Used by the bridge to fire a one-shot threshold_cross event.
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

  private totalCost(): number {
    let sum = 0;
    for (const s of this.sessions.values()) {
      sum += s.cost;
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
