import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EventRouter } from "../src/router.js";
import { CostTracker } from "../src/tracker.js";
import { Enforcer } from "../src/enforce.js";
import { DEFAULT_RULE } from "../src/rule.js";
import type { Logger } from "../src/util/log.js";

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function captureClient() {
  const requests: Array<{ method: string; params: unknown }> = [];
  return {
    requests,
    client: {
      async request(method: string, params?: unknown) {
        requests.push({ method, params });
        return { ok: true };
      },
    },
  };
}

function makeRouter(rule = DEFAULT_RULE, soft = 5, hard = 10) {
  const tracker = new CostTracker({ softLimit: soft, hardLimit: hard, currency: "USD" });
  const cap = captureClient();
  const log = silentLogger();
  const enforcer = new Enforcer(cap.client as never, log);
  const router = new EventRouter(rule, tracker, enforcer, log);
  return { router, tracker, capture: cap, enforcer };
}

function usage(amount: number): Record<string, unknown> {
  return { sessionUpdate: "usage_update", cost: { amount, currency: "USD" } };
}

test("ok state: usage_update tick does not emit anything", async () => {
  const { router, capture } = makeRouter();
  await router.onResponseUpdate("s1", usage(2));
  assert.equal(capture.requests.length, 0);
});

test("crossing soft fires exactly one warn via emit_message", async () => {
  const { router, capture } = makeRouter();
  await router.onResponseUpdate("s1", usage(2));
  await router.onResponseUpdate("s1", usage(5));
  assert.equal(capture.requests.length, 1);
  const req = capture.requests[0]!;
  assert.equal(req.method, "hydra-acp/emit_message");
  const p = req.params as { sessionId: string; method: string; envelope: { update: { sessionUpdate: string } } };
  assert.equal(p.sessionId, "s1");
  assert.equal(p.method, "session/update");
  assert.equal(p.envelope.update.sessionUpdate, "agent_message_chunk");
});

test("crossing hard fires a second warn (one-shot per transition)", async () => {
  const { router, capture } = makeRouter();
  await router.onResponseUpdate("s1", usage(5));
  await router.onResponseUpdate("s1", usage(10));
  assert.equal(capture.requests.length, 2);
});

test("subsequent ticks within the same tier do not re-warn", async () => {
  const { router, capture } = makeRouter();
  await router.onResponseUpdate("s1", usage(5));
  await router.onResponseUpdate("s1", usage(6));
  await router.onResponseUpdate("s1", usage(7));
  assert.equal(capture.requests.length, 1);
});

test("prompt_request below hard limit continues (no reject payload)", async () => {
  const { router } = makeRouter();
  await router.onResponseUpdate("s1", usage(3));
  const payload = await router.onPromptRequest("s1", {});
  assert.equal(payload, undefined);
});

test("prompt_request at or over hard limit returns reject payload", async () => {
  const { router } = makeRouter();
  await router.onResponseUpdate("s1", usage(12));
  const payload = await router.onPromptRequest("s1", {});
  assert.ok(payload, "expected reject payload");
  assert.equal(payload!.stopReason, "refusal");
  const meta = payload!._meta as { "hydra-acp": { budgeter: { message: string } } };
  assert.match(meta["hydra-acp"].budgeter.message, /Budget exceeded/);
});

test("session.opened over hard warns the new session", async () => {
  const { router, capture } = makeRouter();
  await router.onResponseUpdate("s1", usage(12));
  capture.requests.length = 0;
  await router.onLifecycle("session.opened", "s2");
  assert.equal(capture.requests.length, 1);
  const p = capture.requests[0]!.params as { sessionId: string };
  assert.equal(p.sessionId, "s2");
});

test("session.closed forgets per-session cost", async () => {
  const { router, tracker } = makeRouter();
  await router.onResponseUpdate("s1", usage(8));
  await router.onResponseUpdate("s2", usage(4));
  assert.equal(tracker.snapshotFor("s1").total, 12);
  await router.onLifecycle("session.closed", "s1");
  assert.equal(tracker.snapshotFor("s2").total, 4);
});

test("custom rule throwing is swallowed and skips dispatch", async () => {
  const throwingRule = () => {
    throw new Error("boom");
  };
  const { router, capture } = makeRouter(throwingRule);
  await router.onResponseUpdate("s1", usage(5));
  assert.equal(capture.requests.length, 0);
});

test("session_info_update refreshes cached session title", async () => {
  let observedTitle: string | undefined;
  const rule = (ev: import("../src/rule.js").BudgetEvent) => {
    if (ev.kind === "session_opened") {
      observedTitle = ev.meta.title;
    }
    return null;
  };
  const { router } = makeRouter(rule);
  await router.onResponseUpdate("s1", {
    sessionUpdate: "session_info_update",
    title: "Friendly Title",
  });
  await router.onLifecycle("session.opened", "s1");
  assert.equal(observedTitle, "Friendly Title");
});

test("custom rule that returns reject on a non-prompt event is ignored (warn still fires)", async () => {
  const rule = () => ({
    warn: { title: "still warn" },
    reject: { message: "should be ignored" },
  });
  const { router, capture } = makeRouter(rule);
  await router.onResponseUpdate("s1", usage(2));
  // The warn side should still fire even though reject is invalid here.
  assert.equal(capture.requests.length, 1);
});
