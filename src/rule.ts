import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { logger } from "./util/log.js";

const log = logger("rule");

// The shape passed to the user's rule function. Mirrors the notifier's
// NotifyEvent in spirit — a per-event view augmented with cached session
// meta and current budget state so the rule can decide what to do
// without reaching back into hydra.
export interface BudgetEvent {
  // Hydra session id. Empty string for events that don't belong to a
  // single session (e.g. a process-wide threshold cross).
  sessionId: string;
  // The kind of moment we're asking the rule about:
  //   usage_update    — agent reported a new running cost
  //   prompt_request  — a session/prompt is about to forward
  //   session_opened  — a session attached this transformer
  //   session_closed  — a session was torn down
  //   threshold_cross — total just crossed soft or hard for the first time
  kind:
    | "usage_update"
    | "prompt_request"
    | "session_opened"
    | "session_closed"
    | "threshold_cross";
  // Raw payload, kind-specific:
  //   usage_update   → the agent's usage_update params.update
  //   prompt_request → the session/prompt envelope
  //   session_*      → empty object
  //   threshold_cross→ { from: BudgetState, to: BudgetState }
  raw: Record<string, unknown>;
  meta: {
    cwd?: string;
    agentId?: string;
    title?: string;
  };
  budget: {
    // Total cost summed across every session this transformer has seen
    // since startup, in the configured currency.
    total: number;
    // This session's contribution (latest seen amount in its current
    // agent life). Same value as the agent reported, before summation.
    perSession: number;
    currency: string;
    soft: number;
    hard: number;
    state: BudgetState;
  };
}

export type BudgetState = "ok" | "soft" | "hard";

// What the rule wants to happen. Both fields are optional and combine:
//   warn   — emit an agent_message_chunk to attached clients (visible in
//            the conversation) plus a hydra-acp/budget_warning custom
//            notification for budgeter-aware clients
//   reject — only meaningful when the event is a prompt_request; turns
//            the session/prompt into a stop with the given message
export interface BudgetVerdict {
  warn?: { title: string; body?: string };
  reject?: { message: string; stopReason?: string };
}

export type RuleFunction = (
  ev: BudgetEvent,
) => BudgetVerdict | null | undefined | Promise<BudgetVerdict | null | undefined>;

const SESSION_ID_PREFIX = "hydra_session_";

function shortSessionId(sessionId: string): string {
  const stripped = sessionId.startsWith(SESSION_ID_PREFIX)
    ? sessionId.slice(SESSION_ID_PREFIX.length)
    : sessionId;
  return stripped.slice(0, 8);
}

function fmtMoney(amount: number, currency: string): string {
  // Three-letter ISO codes render cleanly; anything else (e.g. "credits")
  // gets a plain "<amount> <unit>" rendering.
  const fixed = amount.toFixed(2);
  if (currency.length === 3 && currency.toUpperCase() === currency) {
    return `${currency} ${fixed}`;
  }
  return `${fixed} ${currency}`;
}

// Default rule when no config file is present. Strategy:
//   - threshold_cross to "soft": warn (one-shot, the tracker only fires
//     crosses once per transition)
//   - threshold_cross to "hard": warn (also one-shot)
//   - prompt_request in "hard" state: reject with stopReason "refusal"
//     and an explanation in the message
//   - session_opened in "hard" state: warn the new session so the user
//     understands why their next prompt will bounce
//   - usage_update and session_closed: do nothing by default
export const DEFAULT_RULE: RuleFunction = (ev) => {
  const { budget } = ev;
  const totalStr = fmtMoney(budget.total, budget.currency);
  const softStr = fmtMoney(budget.soft, budget.currency);
  const hardStr = fmtMoney(budget.hard, budget.currency);
  const sid = shortSessionId(ev.sessionId);

  if (ev.kind === "threshold_cross") {
    const to = (ev.raw.to ?? "ok") as BudgetState;
    if (to === "soft") {
      return {
        warn: {
          title: `💰 Budget soft limit hit · ${sid}`,
          body: `Spent ${totalStr} of ${softStr} soft (hard: ${hardStr}). Heads up — prompts will be rejected at the hard limit.`,
        },
      };
    }
    if (to === "hard") {
      return {
        warn: {
          title: `🛑 Budget hard limit hit · ${sid}`,
          body: `Spent ${totalStr} ≥ ${hardStr} hard limit. Further prompts will be rejected until the budget is reset.`,
        },
      };
    }
    return null;
  }

  if (ev.kind === "prompt_request" && budget.state === "hard") {
    return {
      reject: {
        message: `Budget exceeded: spent ${totalStr} ≥ ${hardStr} hard limit. Reset the budget or raise HYDRA_ACP_BUDGETER_HARD to continue.`,
        stopReason: "refusal",
      },
    };
  }

  if (ev.kind === "session_opened" && budget.state === "hard") {
    return {
      warn: {
        title: `🛑 Session opened over budget · ${sid}`,
        body: `Total spend ${totalStr} ≥ ${hardStr}. Prompts on this session will be rejected.`,
      },
    };
  }

  return null;
};

let loadCounter = 0;

export async function loadRule(path: string): Promise<RuleFunction> {
  try {
    await stat(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      log.info(
        `no rule config at ${path} — using DEFAULT_RULE (warn on soft cross, reject prompts when over hard)`,
      );
      return DEFAULT_RULE;
    }
    log.warn(`stat ${path} failed: ${e.message}; using DEFAULT_RULE`);
    return DEFAULT_RULE;
  }
  loadCounter += 1;
  const url = `${pathToFileURL(path).href}?v=${Date.now()}-${loadCounter}`;
  try {
    const mod = (await import(url)) as { default?: unknown };
    const fn = mod.default;
    if (typeof fn !== "function") {
      log.warn(`${path} did not export a default function; using DEFAULT_RULE`);
      return DEFAULT_RULE;
    }
    log.info(`loaded budgeter rule from ${path}`);
    return fn as RuleFunction;
  } catch (err) {
    log.warn(`import ${path} failed: ${(err as Error).message}; using DEFAULT_RULE`);
    return DEFAULT_RULE;
  }
}
