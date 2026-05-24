// The shape passed to the rule function. Mirrors the notifier's
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

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  CAD: "C$",
  AUD: "A$",
  NZD: "NZ$",
  CHF: "CHF ",
  HKD: "HK$",
  SGD: "S$",
  INR: "₹",
  KRW: "₩",
  BRL: "R$",
  MXN: "MX$",
};

function fmtMoney(amount: number, currency: string): string {
  const fixed = amount.toFixed(2);
  const sym = CURRENCY_SYMBOLS[currency.toUpperCase()];
  if (sym) {
    return `${sym}${fixed}`;
  }
  return `${currency} ${fixed}`;
}

// The rule the budgeter runs on every event. Strategy:
//   - threshold_cross to "soft": warn (one-shot, the tracker only fires
//     crosses once per transition)
//   - threshold_cross to "hard": warn (also one-shot)
//   - prompt_request in "hard" state: reject with stopReason "refusal"
//     and an explanation in the message
//   - session_opened in "hard" state: warn the new session so the user
//     understands why their next prompt will bounce
//   - usage_update and session_closed: do nothing
export const DEFAULT_RULE: RuleFunction = (ev) => {
  const { budget } = ev;
  const totalStr = fmtMoney(budget.total, budget.currency);
  const softStr = fmtMoney(budget.soft, budget.currency);
  const hardStr = fmtMoney(budget.hard, budget.currency);

  if (ev.kind === "threshold_cross") {
    const to = (ev.raw.to ?? "ok") as BudgetState;
    if (to === "hard") {
      return {
        warn: {
          title: `🛑 Budget hard limit hit`,
          body: `Spent ${totalStr} ≥ ${hardStr} hard limit. Further prompts will be rejected until the budget is reset.`,
        },
      };
    }
    return null;
  }

  // Warn on every turn that reports a cost while over the soft limit.
  if (ev.kind === "usage_update" && budget.state !== "ok" && typeof (ev.raw.cost as Record<string, unknown> | undefined)?.amount === "number") {
    const label = budget.state === "hard" ? "🛑 Over hard limit" : "💰 Over soft limit";
    return {
      warn: {
        title: `${label} · ${totalStr} spent`,
        body: budget.state === "hard"
          ? `Hard limit ${hardStr} reached. Prompts will be rejected until budget is reset.`
          : `Soft limit ${softStr} reached (hard: ${hardStr}).`,
      },
    };
  }

  if (ev.kind === "prompt_request" && budget.state === "hard") {
    return {
      warn: {
        title: `🛑 Prompt blocked — budget exceeded`,
        body: `Spent ${totalStr} ≥ ${hardStr} hard limit. Reset the budget or raise HYDRA_ACP_BUDGETER_HARD to continue.`,
      },
      reject: {
        message: `Budget exceeded: spent ${totalStr} ≥ ${hardStr} hard limit. Reset the budget or raise HYDRA_ACP_BUDGETER_HARD to continue.`,
        stopReason: "refusal",
      },
    };
  }

  if (ev.kind === "session_opened" && budget.state === "hard") {
    return {
      warn: {
        title: `🛑 Session opened over budget`,
        body: `Total spend ${totalStr} ≥ ${hardStr}. Prompts on this session will be rejected.`,
      },
    };
  }

  return null;
};
