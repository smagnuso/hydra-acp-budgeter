import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  clearEventCache,
  eventCacheInfo,
  eventCachePath,
  syncUsageEvents,
} from "../src/cost/event-cache.js";

const home = mkdtempSync(resolve(tmpdir(), "budgeter-evcache-"));
process.env.HYDRA_ACP_HOME = home;

afterEach(() => {
  clearEventCache();
});

interface Row {
  sessionId: string;
  ts: string;
  amount: number;
}

async function fakeDaemon(rows: Row[]) {
  const requests: Array<string | null> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const since = url.searchParams.get("since");
    requests.push(since);
    const out = rows
      .filter((r) => since === null || r.ts >= since)
      .map((r) =>
        JSON.stringify({
          sessionId: r.sessionId,
          ts: r.ts,
          update: { used: 10, cost: { amount: r.amount, currency: "USD" } },
        }),
      );
    res.end(out.join("\n") + "\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    conn: { daemonUrl: `http://127.0.0.1:${port}`, token: "t" },
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const iso = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();

test("first sync fetches everything and stores it", async () => {
  const d = await fakeDaemon([
    { sessionId: "a", ts: iso(300), amount: 1 },
    { sessionId: "a", ts: iso(200), amount: 2 },
  ]);
  try {
    const events = await syncUsageEvents(d.conn);
    assert.equal(events?.length, 2);
    assert.deepEqual(d.requests, [null]);
    const info = eventCacheInfo();
    assert.equal(info.exists, true);
    assert.equal(info.events, 2);
  } finally {
    await d.close();
  }
});

test("later syncs ask only for newer events and merge without duplicates", async () => {
  const rows: Row[] = [
    { sessionId: "a", ts: iso(300), amount: 1 },
    { sessionId: "a", ts: iso(120), amount: 2 },
  ];
  const d = await fakeDaemon(rows);
  try {
    await syncUsageEvents(d.conn);
    rows.push({ sessionId: "a", ts: iso(5), amount: 3 });
    const events = await syncUsageEvents(d.conn);
    assert.equal(events?.length, 3);
    assert.equal(d.requests.length, 2);
    const since = d.requests[1];
    assert.ok(since !== null);
    assert.ok(Date.parse(since) < Date.parse(rows[1]!.ts), "overlaps the newest stored event");
    const ts = events!.map((e) => e.ts);
    assert.deepEqual(ts, [...ts].sort());
  } finally {
    await d.close();
  }
});

test("refresh refetches everything", async () => {
  const d = await fakeDaemon([{ sessionId: "a", ts: iso(100), amount: 1 }]);
  try {
    await syncUsageEvents(d.conn);
    await syncUsageEvents(d.conn, { refresh: true });
    assert.deepEqual(d.requests, [null, null]);
  } finally {
    await d.close();
  }
});

test("a cache older than a day triggers a full resync", async () => {
  const d = await fakeDaemon([{ sessionId: "a", ts: iso(100), amount: 1 }]);
  try {
    await syncUsageEvents(d.conn);
    const path = eventCachePath();
    const lines = readFileSync(path, "utf8").split("\n");
    lines[0] = JSON.stringify({ v: 1, fullAt: Date.now() - 25 * 60 * 60 * 1000 });
    writeFileSync(path, lines.join("\n"));
    await syncUsageEvents(d.conn);
    assert.deepEqual(d.requests, [null, null]);
  } finally {
    await d.close();
  }
});

test("an unreachable daemon serves the stored events", async () => {
  const d = await fakeDaemon([{ sessionId: "a", ts: iso(100), amount: 1 }]);
  await syncUsageEvents(d.conn);
  await d.close();
  const events = await syncUsageEvents(d.conn);
  assert.equal(events?.length, 1);
});

test("clearEventCache removes the file and reports whether one existed", async () => {
  const d = await fakeDaemon([{ sessionId: "a", ts: iso(100), amount: 1 }]);
  try {
    await syncUsageEvents(d.conn);
    assert.equal(clearEventCache(), true);
    assert.equal(eventCacheInfo().exists, false);
    assert.equal(clearEventCache(), false);
  } finally {
    await d.close();
  }
});

test("cleanup", () => {
  rmSync(home, { recursive: true, force: true });
});
