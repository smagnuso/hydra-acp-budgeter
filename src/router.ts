import type { Logger } from "./util/log.js";
import type { Enforcer } from "./enforce.js";
import type { BudgetEvent, RuleFunction } from "./rule.js";
import type { CostTracker } from "./tracker.js";

export interface SessionMeta {
  cwd?: string;
  agentId?: string;
  title?: string;
}

// Translates incoming hydra-acp/transformer/message and hydra-acp/transformer/session_event
// envelopes into BudgetEvents, runs them through the rule, and dispatches
// the resulting verdicts via the Enforcer. Unlike the notifier's
// EventRouter (one instance per session), this is a singleton — the
// transformer process holds one connection for every session, so the
// router keeps a sessionId → SessionMeta map.
export class EventRouter {
  private metas = new Map<string, SessionMeta>();

  constructor(
    private readonly rule: RuleFunction,
    private readonly tracker: CostTracker,
    private readonly enforcer: Enforcer,
    private readonly log: Logger,
  ) {}

  setMeta(sessionId: string, meta: SessionMeta): void {
    this.metas.set(sessionId, meta);
  }

  forgetSession(sessionId: string): void {
    this.metas.delete(sessionId);
  }

  // Fired by the bridge when an agent→client session/update notification
  // is being routed. usage_update is the only kind we care about for cost
  // tracking; other kinds may still flow through the rule so a custom
  // rule can observe (but the default rule ignores them).
  async onResponseUpdate(
    sessionId: string,
    update: Record<string, unknown>,
  ): Promise<void> {
    const kind =
      typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    // session_info_update may carry an updated title; mirror the notifier
    // and refresh meta so subsequent warning messages reflect the latest.
    if (kind === "session_info_update") {
      this.applySessionInfoUpdate(sessionId, update);
    }
    if (kind !== "usage_update") {
      return;
    }
    this.tracker.applyUsageUpdate(sessionId, update);
    const transition = this.tracker.consumeStateTransition();
    if (transition !== undefined) {
      await this.fire({
        sessionId,
        kind: "threshold_cross",
        raw: { to: transition, from: this.tracker.state },
        meta: this.metaFor(sessionId),
        budget: this.tracker.snapshotFor(sessionId),
      });
    }
    // Also run a plain usage_update event so a custom rule can act on
    // every tick (e.g. emit a status notification every $1 spent). The
    // default rule ignores this kind.
    await this.fire({
      sessionId,
      kind: "usage_update",
      raw: update,
      meta: this.metaFor(sessionId),
      budget: this.tracker.snapshotFor(sessionId),
    });
  }

  // Fired by the bridge for a request:session/prompt intercept. Returns
  // the stop payload to send back to the daemon, or undefined to let the
  // prompt continue. The rule decides — the default rule rejects when
  // we're in the "hard" state.
  async onPromptRequest(
    sessionId: string,
    envelope: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    const verdict = await this.runRule({
      sessionId,
      kind: "prompt_request",
      raw: { envelope } as Record<string, unknown>,
      meta: this.metaFor(sessionId),
      budget: this.tracker.snapshotFor(sessionId),
    });
    if (!verdict) {
      return undefined;
    }
    return this.enforcer.dispatch(sessionId, verdict);
  }

  // Fired by the bridge for lifecycle:session.opened and session.closed.
  async onLifecycle(
    event: "session.opened" | "session.closed",
    sessionId: string,
  ): Promise<void> {
    if (event === "session.opened") {
      await this.fire({
        sessionId,
        kind: "session_opened",
        raw: {},
        meta: this.metaFor(sessionId),
        budget: this.tracker.snapshotFor(sessionId),
      });
      return;
    }
    if (event === "session.closed") {
      // Note: we deliberately do NOT drop the session's cost from the
      // tracker — total spend is sticky across session.closed so the
      // budget reflects every dollar this transformer has seen. Reset
      // via `hydra-acp-budgeter reset` (deletes the state file) when
      // you want to zero it.
      await this.fire({
        sessionId,
        kind: "session_closed",
        raw: {},
        meta: this.metaFor(sessionId),
        budget: this.tracker.snapshotFor(sessionId),
      });
      this.forgetSession(sessionId);
    }
  }

  private async fire(ev: BudgetEvent): Promise<void> {
    const verdict = await this.runRule(ev);
    if (!verdict) {
      return;
    }
    // For non-prompt events, only the warn side can fire — reject without
    // a prompt to attach it to is a no-op. Log and skip so a misconfigured
    // rule doesn't fail silently.
    if (verdict.reject && ev.kind !== "prompt_request") {
      this.log.warn(
        `rule returned reject on kind=${ev.kind} for ${ev.sessionId.slice(0, 12)} — only valid on prompt_request; ignored`,
      );
    }
    if (verdict.warn) {
      await this.enforcer.warn(ev.sessionId, verdict.warn);
    }
  }

  private async runRule(ev: BudgetEvent) {
    try {
      return await this.rule(ev);
    } catch (err) {
      this.log.warn(
        `rule threw on kind=${ev.kind} sessionId=${ev.sessionId.slice(0, 12)}: ${(err as Error).message}; skipping`,
      );
      return null;
    }
  }

  private metaFor(sessionId: string): SessionMeta {
    return this.metas.get(sessionId) ?? {};
  }

  private applySessionInfoUpdate(
    sessionId: string,
    update: Record<string, unknown>,
  ): void {
    const cur: SessionMeta = { ...this.metaFor(sessionId) };
    let changed = false;
    if (typeof update.title === "string" && cur.title !== update.title) {
      cur.title = update.title;
      changed = true;
    }
    const agentId = readHydraAgentId(update._meta);
    if (agentId !== undefined && cur.agentId !== agentId) {
      cur.agentId = agentId;
      changed = true;
    }
    if (changed) {
      this.metas.set(sessionId, cur);
    }
  }
}

function readHydraAgentId(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const ns = (meta as Record<string, unknown>)["hydra-acp"];
  if (!ns || typeof ns !== "object" || Array.isArray(ns)) {
    return undefined;
  }
  const v = (ns as Record<string, unknown>).agentId;
  return typeof v === "string" ? v : undefined;
}
