import { TransformerClient } from "./acp/transformer.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  TransformerMessageParams,
  TransformerSessionEvent,
} from "./acp/protocol.js";
import { Enforcer } from "./enforce.js";
import { EventRouter } from "./router.js";
import type { RuleFunction } from "./rule.js";
import { CostTracker } from "./tracker.js";
import { logger } from "./util/log.js";

const log = logger("bridge");

export interface BridgeOptions {
  daemonWsUrl: string;
  token: string;
  softLimit: number;
  hardLimit: number;
  currency: string;
  rule: RuleFunction;
}

// The set of intercepts the budgeter declares to the daemon. Kept in one
// place so the rule, the router, and the README stay in agreement.
//
//   response:session/update    — observe usage_update for cost tracking
//   request:session/prompt     — reject when over hard limit
//   lifecycle:session.opened   — warn on new sessions while over budget
//   lifecycle:session.closed   — drop per-session cost state
const BUDGETER_INTERCEPTS = [
  "response:session/update",
  "request:session/prompt",
  "lifecycle:session.opened",
  "lifecycle:session.closed",
];

// One bridge per budgeter process. Owns the WS connection, the cost
// tracker, the enforcer, and the router. The mirror of NotifierBridge,
// except scoped to the whole process rather than to a single session.
export class BudgeterBridge {
  private readonly client: TransformerClient;
  private readonly tracker: CostTracker;
  private readonly enforcer: Enforcer;
  private readonly router: EventRouter;
  private stopped = false;

  constructor(private readonly opts: BridgeOptions) {
    this.client = new TransformerClient({
      daemonWsUrl: opts.daemonWsUrl,
      token: opts.token,
      intercepts: BUDGETER_INTERCEPTS,
    });
    this.tracker = new CostTracker({
      softLimit: opts.softLimit,
      hardLimit: opts.hardLimit,
      currency: opts.currency,
    });
    this.enforcer = new Enforcer(this.client, log);
    this.router = new EventRouter(
      opts.rule,
      this.tracker,
      this.enforcer,
      log,
    );
  }

  start(): void {
    this.client.on("request", (r) => this.onRequest(r));
    this.client.on("notification", (n) => this.onNotification(n));
    this.client.on("error", (err) => {
      log.warn(`client error: ${err.message}`);
    });
    this.client.start();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.client.stop();
  }

  private onRequest(r: JsonRpcRequest): void {
    if (r.method !== "transformer/message") {
      // The daemon only sends transformer/message requests to us. Anything
      // else is an error on the daemon side or a future protocol kind we
      // don't yet understand. Continue rather than guessing.
      this.client.reply(r.id, { action: "continue" });
      return;
    }
    const params = (r.params ?? {}) as Partial<TransformerMessageParams>;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const phase = params.phase;
    const method = params.method;
    if (!sessionId || !phase || !method) {
      this.client.reply(r.id, { action: "continue" });
      return;
    }

    if (phase === "response" && method === "session/update") {
      // Response side is observe-only — we always continue and run the
      // tracker update asynchronously. The daemon proceeds with the
      // original envelope; any warning we want to emit goes out via a
      // separate emit_message call.
      this.client.reply(r.id, { action: "continue" });
      const envelope = params.envelope;
      const update =
        envelope && typeof envelope === "object" && !Array.isArray(envelope)
          ? ((envelope as { update?: unknown }).update as
              | Record<string, unknown>
              | undefined)
          : undefined;
      if (update) {
        void this.router
          .onResponseUpdate(sessionId, update)
          .catch((err) => log.warn(`response update error: ${(err as Error).message}`));
      }
      return;
    }

    if (phase === "request" && method === "session/prompt") {
      // Request side: ask the rule. If it returns a reject payload, stop;
      // otherwise let the prompt continue. The reply waits on the rule —
      // the daemon's forwardRequest is awaiting our response, so a slow
      // rule pauses the prompt, which is acceptable for the rare reject
      // path.
      void this.router
        .onPromptRequest(sessionId, params.envelope)
        .then((rejectPayload) => {
          if (rejectPayload) {
            this.client.reply(r.id, { action: "stop", payload: rejectPayload });
          } else {
            this.client.reply(r.id, { action: "continue" });
          }
        })
        .catch((err) => {
          log.warn(`prompt request error: ${(err as Error).message}`);
          this.client.reply(r.id, { action: "continue" });
        });
      return;
    }

    // Unknown phase/method — declare nothing and let the daemon proceed.
    this.client.reply(r.id, { action: "continue" });
  }

  private onNotification(n: JsonRpcNotification): void {
    if (n.method !== "transformer/session_event") {
      return;
    }
    const params = (n.params ?? {}) as Partial<TransformerSessionEvent>;
    const event = typeof params.event === "string" ? params.event : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    if (!event || !sessionId) {
      return;
    }
    if (event === "session.opened") {
      void this.router
        .onLifecycle("session.opened", sessionId)
        .catch((err) => log.warn(`session.opened error: ${(err as Error).message}`));
      return;
    }
    if (event === "session.closed") {
      void this.router
        .onLifecycle("session.closed", sessionId)
        .catch((err) => log.warn(`session.closed error: ${(err as Error).message}`));
      return;
    }
  }
}
