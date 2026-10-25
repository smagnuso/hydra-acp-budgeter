import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { computeUsage, USAGE_API_VERSION } from "../src/cost/usage.js";

test("computeUsage uses the supplied connection, not the environment", async () => {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const now = new Date();
  const ts = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    if (req.url?.startsWith("/v1/sessions/events")) {
      res.end(
        JSON.stringify({
          sessionId: "s1",
          ts,
          update: { cost: { amount: 1.5, currency: "USD" }, used: 100 },
        }) + "\n",
      );
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        sessions: [
          {
            sessionId: "s1",
            cwd: "/tmp/proj",
            agentId: "claude",
            currentModel: "opus",
            interactive: true,
            updatedAt: now.toISOString(),
            currentUsage: { costAmount: 1.5, costCurrency: "USD", used: 100 },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const prev = process.env.HYDRA_ACP_TOKEN;
  process.env.HYDRA_ACP_TOKEN = "env-token";
  try {
    const agg = await computeUsage(
      {
        since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        bucket: "hour",
      },
      { daemonUrl: `http://127.0.0.1:${port}`, token: "browser-token" },
    );
    assert.equal(agg.kind, "timeSeries");
    assert.equal(agg.currency, "USD");
    assert.ok(seen.length >= 2);
    for (const s of seen) {
      assert.equal(s.auth, "Bearer browser-token");
    }
  } finally {
    if (prev === undefined) {
      delete process.env.HYDRA_ACP_TOKEN;
    } else {
      process.env.HYDRA_ACP_TOKEN = prev;
    }
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("USAGE_API_VERSION is a positive integer", () => {
  assert.ok(Number.isInteger(USAGE_API_VERSION) && USAGE_API_VERSION > 0);
});
