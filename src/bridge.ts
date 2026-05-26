import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
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
  // Absolute path to the persisted state file. Loaded on startup,
  // rewritten on every usage_update. The bridge also fs.watches it so
  // external resets (eg. `hydra-acp-budgeter reset` deleting the file)
  // are picked up without restarting.
  statePath?: string;
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
  private watcher: FSWatcher | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
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
      statePath: opts.statePath,
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
    this.client.on("open", () => {
      void this.registerSlashCommands();
    });
    this.client.start();
    this.startWatcher();
  }

  private async registerSlashCommands(): Promise<void> {
    try {
      await this.client.request("hydra-acp/register_commands", {
        commands: [
          {
            verb: "reset",
            description: "Reset accumulated cost baseline to current totals",
          },
          {
            verb: "status",
            description: "Show current spend vs. soft/hard limits",
          },
        ],
      });
      log.info("registered /hydra hydra-acp-budgeter {reset,status}");
    } catch (err) {
      log.warn(`register_commands failed: ${(err as Error).message}`);
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
    this.client.stop();
  }

  // Watch the state file's parent directory so we still see events when
  // the file is created later (e.g. first usage_update of a fresh run)
  // or deleted entirely (the reset subcommand). fs.watch on a missing
  // file throws on some platforms, but the parent dir is created by
  // CostTracker.persist before any write happens, and the daemon writes
  // the .pid file there even sooner — so the dir reliably exists by
  // the time start() runs. We still try/catch in case it doesn't.
  private startWatcher(): void {
    if (!this.opts.statePath) {
      return;
    }
    const dir = dirname(this.opts.statePath);
    const file = basename(this.opts.statePath);
    try {
      this.watcher = watch(dir, (eventType, filename) => {
        if (filename && filename !== file) {
          return;
        }
        // fs.watch can fire 1–N times per logical change (especially
        // when our own atomic-rename hits it). Debounce briefly so we
        // do at most one re-read per burst.
        if (this.watchTimer) {
          return;
        }
        this.watchTimer = setTimeout(() => {
          this.watchTimer = undefined;
          try {
            this.tracker.adoptFromDisk();
          } catch (err) {
            log.warn(`adoptFromDisk failed: ${(err as Error).message}`);
          }
        }, 50);
      });
      log.debug(`watching ${this.opts.statePath}`);
    } catch (err) {
      log.warn(`fs.watch failed for ${dir}: ${(err as Error).message}`);
    }
  }

  private onRequest(r: JsonRpcRequest): void {
    if (r.method === "hydra-acp/extension_command") {
      this.handleExtensionCommand(r);
      return;
    }
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

  // "/hydra hydra-acp-budgeter <verb> [args]" routes to here. The daemon
  // validates the verb against what we registered before forwarding, so
  // an unknown verb here means the registry and our switch fell out of
  // sync. Replies are returned as { text } and surface in the session
  // transcript as a synthetic agent message.
  private handleExtensionCommand(r: JsonRpcRequest): void {
    const params = (r.params ?? {}) as {
      sessionId?: unknown;
      verb?: unknown;
      args?: unknown;
    };
    const verb = typeof params.verb === "string" ? params.verb : "";
    const sessionId =
      typeof params.sessionId === "string" ? params.sessionId : "";
    const outcome = runBudgeterCommand(this.tracker, this.opts.currency, {
      verb,
      sessionId,
    });
    if (outcome.kind === "ok") {
      this.client.reply(r.id, { text: outcome.text });
    } else {
      this.client.replyError(r.id, -32601, outcome.message);
    }
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

// Pure verb dispatch — extracted from BudgeterBridge.handleExtensionCommand
// so unit tests can exercise it without a TransformerClient. Mutates the
// tracker for `reset`; reads the tracker for `status`. Returns the text
// the bridge should hand back to the daemon, or a JSON-RPC error message
// for unknown verbs.
export type BudgeterCommandOutcome =
  | { kind: "ok"; text: string }
  | { kind: "error"; message: string };

export function runBudgeterCommand(
  tracker: CostTracker,
  configuredCurrency: string,
  input: { verb: string; sessionId: string },
): BudgeterCommandOutcome {
  if (input.verb === "reset") {
    tracker.reset();
    const snap = input.sessionId
      ? tracker.snapshotFor(input.sessionId)
      : { total: 0, currency: configuredCurrency };
    return {
      kind: "ok",
      text: `hydra-acp-budgeter: spend reset (total now ${snap.total.toFixed(2)} ${snap.currency})`,
    };
  }
  if (input.verb === "status") {
    const snap = tracker.snapshotFor(input.sessionId);
    return {
      kind: "ok",
      text:
        `hydra-acp-budgeter: total ${snap.total.toFixed(2)} ${snap.currency} ` +
        `(this session ${snap.perSession.toFixed(2)}, soft ${snap.soft}, hard ${snap.hard}, state ${snap.state})`,
    };
  }
  return { kind: "error", message: `unknown verb: ${input.verb}` };
}
