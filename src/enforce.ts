import type { Logger } from "./util/log.js";
import type { TransformerClient } from "./acp/transformer.js";
import type { BudgetVerdict } from "./rule.js";

// Hook used in tests to capture what the enforcer would have emitted
// without going through a real WebSocket.
export interface EmitTrace {
  emits: Array<{ sessionId: string; method: string; envelope: unknown }>;
}

// Builds outbound emit_message payloads and stop responses for the
// router. Centralises the "what does a warning/rejection look like on
// the wire" decisions so the router only deals with verdicts.
export class Enforcer {
  constructor(
    private readonly client: Pick<TransformerClient, "request">,
    private readonly log: Logger,
    private readonly trace?: EmitTrace,
  ) {}

  // Emit a warning to every client attached to the session. Sent as a
  // session/update with sessionUpdate="agent_message_chunk" so it
  // surfaces in the conversation log on every well-behaved client. A
  // _meta.hydra-acp.budgeter marker lets renderer-aware clients style it
  // differently (or filter it out, if they prefer their own UI).
  async warn(
    sessionId: string,
    warn: { title: string; body?: string },
  ): Promise<void> {
    const text = warn.body ? `\n\n${warn.title}\n${warn.body}\n\n` : `\n\n${warn.title}\n\n`;
    const envelope = {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        _meta: {
          "hydra-acp": {
            budgeter: {
              title: warn.title,
              ...(warn.body !== undefined ? { body: warn.body } : {}),
            },
          },
        },
      },
    };
    if (this.trace) {
      this.trace.emits.push({
        sessionId,
        method: "session/update",
        envelope,
      });
    }
    try {
      await this.client.request("hydra-acp/message/emit", {
        sessionId,
        method: "session/update",
        envelope,
        route: "chain",
      });
    } catch (err) {
      this.log.warn(
        `emit_message warn for ${sessionId} failed: ${(err as Error).message}`,
      );
    }
  }

  // Build the payload that the router returns as the stop action's
  // payload. Becomes the response delivered to the originator of the
  // session/prompt — clients render the stopReason and the _meta.
  buildRejectPayload(
    reject: { message: string; stopReason?: string },
  ): Record<string, unknown> {
    return {
      stopReason: reject.stopReason ?? "refusal",
      _meta: {
        "hydra-acp": {
          budgeter: { message: reject.message },
        },
      },
    };
  }

  // Convenience: combine a warn + reject into the appropriate side
  // effects. Called by the router on a prompt_request verdict that
  // includes both — the warn fires asynchronously so the stop payload
  // can be returned to the daemon without blocking on emit_message.
  async dispatch(
    sessionId: string,
    verdict: BudgetVerdict,
  ): Promise<Record<string, unknown> | undefined> {
    if (verdict.warn) {
      void this.warn(sessionId, verdict.warn);
    }
    if (verdict.reject) {
      return this.buildRejectPayload(verdict.reject);
    }
    return undefined;
  }
}
