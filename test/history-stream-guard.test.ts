import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { SessionRecord } from "../src/cost/session-store.js";

const SID = "hydra_session_guard";

function usage(ts: number, amount: number): string {
  return JSON.stringify({
    method: "session/update",
    params: { sessionId: SID, update: { sessionUpdate: "usage_update", cost: { amount, currency: "USD" } } },
    recordedAt: ts,
  });
}

function record(costAmount: number): SessionRecord {
  return {
    sessionId: SID, cwd: "/x", agentId: "opencode", model: "m", interactive: true,
    costAmount, costCurrency: "USD", contextTokens: 0, title: "t",
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  } as SessionRecord;
}

async function collect(archive: string[], live: string[], costAmount: number) {
  const home = mkdtempSync(resolve(tmpdir(), "hydra-guard-"));
  mkdirSync(resolve(home, "sessions", SID), { recursive: true });
  const d = resolve(home, "sessions", SID);
  writeFileSync(resolve(d, "history.jsonl.1"), archive.join("\n") + "\n");
  writeFileSync(resolve(d, "history.jsonl"), live.join("\n") + "\n");
  const prev = process.env.HYDRA_ACP_HOME;
  process.env.HYDRA_ACP_HOME = home;
  const { streamHistoryEvents } = await import("../src/cost/history-stream.js");
  const out: number[] = [];
  for await (const e of streamHistoryEvents(record(costAmount))) out.push(e.deltaCost);
  if (prev === undefined) delete process.env.HYDRA_ACP_HOME; else process.env.HYDRA_ACP_HOME = prev;
  rmSync(home, { recursive: true, force: true });
  return out;
}

// Archives can hold a pre-repair (inflated) series that does not join the
// live file. Differencing that prefix invents the whole inflated amount as
// spend — $12k on one real session. meta.json's recorded lifetime is the
// authority, so an overshooting series must be abandoned, not emitted.
test("abandons a transcript series that overshoots the recorded lifetime", async () => {
  const deltas = await collect(
    [usage(1000, 4000), usage(2000, 12000)],   // inflated archive prefix
    [usage(3000, 70), usage(4000, 73)],        // repaired live series
    73,                                        // meta says the session cost $73
  );
  const total = deltas.reduce((a, b) => a + b, 0);
  assert.ok(total <= 73 * 1.5 + 1, `emitted ${total}, expected the guard to stop near the lifetime`);
});

// The guard must not interfere with an ordinary session whose archive and
// live series join cleanly.
test("emits the full series when archives agree with the live file", async () => {
  const deltas = await collect([usage(1000, 10), usage(2000, 20)], [usage(3000, 30), usage(4000, 40)], 40);
  assert.equal(deltas.reduce((a, b) => a + b, 0), 40);
  assert.equal(deltas.length, 4);
});
