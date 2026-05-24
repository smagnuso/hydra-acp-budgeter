import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_RULE, type BudgetEvent } from "../src/rule.js";

function ev(overrides: Partial<BudgetEvent>): BudgetEvent {
  return {
    sessionId: "hydra_session_abc",
    kind: "usage_update",
    raw: {},
    meta: {},
    budget: {
      total: 0,
      perSession: 0,
      currency: "USD",
      soft: 5,
      hard: 10,
      state: "ok",
    },
    ...overrides,
  };
}

test("DEFAULT_RULE warns on threshold_cross to soft", async () => {
  const result = await DEFAULT_RULE(
    ev({
      kind: "threshold_cross",
      raw: { to: "soft", from: "ok" },
      budget: { total: 5, perSession: 5, currency: "USD", soft: 5, hard: 10, state: "soft" },
    }),
  );
  assert.ok(result?.warn);
  assert.match(result!.warn!.title, /soft/i);
});

test("DEFAULT_RULE warns on threshold_cross to hard", async () => {
  const result = await DEFAULT_RULE(
    ev({
      kind: "threshold_cross",
      raw: { to: "hard", from: "soft" },
      budget: { total: 10, perSession: 10, currency: "USD", soft: 5, hard: 10, state: "hard" },
    }),
  );
  assert.ok(result?.warn);
  assert.match(result!.warn!.title, /hard/i);
});

test("DEFAULT_RULE rejects prompt_request when state is hard", async () => {
  const result = await DEFAULT_RULE(
    ev({
      kind: "prompt_request",
      budget: { total: 12, perSession: 12, currency: "USD", soft: 5, hard: 10, state: "hard" },
    }),
  );
  assert.ok(result?.reject);
  assert.match(result!.reject!.message, /Budget exceeded/);
  assert.equal(result!.reject!.stopReason, "refusal");
});

test("DEFAULT_RULE does not reject prompt_request in soft state", async () => {
  const result = await DEFAULT_RULE(
    ev({
      kind: "prompt_request",
      budget: { total: 7, perSession: 7, currency: "USD", soft: 5, hard: 10, state: "soft" },
    }),
  );
  assert.equal(result, null);
});

test("DEFAULT_RULE warns when a session opens while over hard", async () => {
  const result = await DEFAULT_RULE(
    ev({
      kind: "session_opened",
      budget: { total: 12, perSession: 0, currency: "USD", soft: 5, hard: 10, state: "hard" },
    }),
  );
  assert.ok(result?.warn);
  assert.match(result!.warn!.title, /over budget/i);
});

test("DEFAULT_RULE stays quiet on ordinary usage_update", async () => {
  const result = await DEFAULT_RULE(
    ev({
      kind: "usage_update",
      budget: { total: 2, perSession: 2, currency: "USD", soft: 5, hard: 10, state: "ok" },
    }),
  );
  assert.equal(result, null);
});
