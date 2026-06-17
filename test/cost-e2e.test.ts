import { strict as assert } from "node:assert";
import { test, afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function createTempSessionStore(): string {
  const base = mkdtempSync(resolve(tmpdir(), "budgeter-e2e-"));
  const sessionsPath = resolve(base, "sessions");
  mkdirSync(sessionsPath, { recursive: true });
  return sessionsPath;
}

function writeMeta(sessionsPath: string, sessionId: string, meta: Record<string, unknown>): void {
  const sessionDir = resolve(sessionsPath, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(resolve(sessionDir, "meta.json"), JSON.stringify(meta));
}

function writeHistory(sessionsPath: string, sessionId: string, lines: string[]): void {
  const sessionDir = resolve(sessionsPath, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(resolve(sessionDir, "history.jsonl"), lines.map(l => l + "\n").join(""));
}

// Per-test temp state — created once per test via setupTemp()
let _tempBase: string | null = null;
let _tempSessionsPath: string | null = null;

function setupTemp(): { base: string; sessionsPath: string } {
  if (_tempBase === null) {
    _tempBase = createTempSessionStore();
    _tempSessionsPath = resolve(_tempBase, "sessions");
    // streamHistoryEvents + scanSessions use sessionsDir() which reads HYDRA_ACP_HOME
    process.env.HYDRA_ACP_HOME = _tempBase;
  }
  return { base: _tempBase, sessionsPath: _tempSessionsPath };
}

afterEach(() => {
  if (_tempBase !== null) {
    rmSync(_tempBase, { recursive: true, force: true });
    _tempBase = null;
    _tempSessionsPath = null;
    delete process.env.HYDRA_ACP_HOME;
  }
});

async function runCost(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const distPath = resolve(process.cwd(), "dist", "index.js");
  const env = { ...process.env, HYDRA_ACP_HOME: _tempBase! };
  return execFileAsync("node", [distPath, "cost", ...args], { env, timeout: 10000 });
}

test("cost subcommand: text output shows total cost from meta.json", async () => {
  const { sessionsPath } = setupTemp();

  writeMeta(sessionsPath, "sess_001", {
    sessionId: "sess_001",
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    currentModel: "claude-sonnet-4-20250514",
    interactive: true,
    currentUsage: { costAmount: 3.50, costCurrency: "USD" },
    title: "Test session one",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
  });

  writeMeta(sessionsPath, "sess_002", {
    sessionId: "sess_002",
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    currentModel: "gpt-4o",
    interactive: false,
    currentUsage: { costAmount: 1.25, costCurrency: "USD" },
    title: "Test session two",
    createdAt: "2025-06-01T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
  });

  const { stdout } = await runCost([]);
  assert.ok(stdout.includes("Total:"), "Output should include 'Total:'");
  assert.ok(stdout.includes("$"), "Output should include '$'");
  // Fast path sums costAmount from meta.json: 3.50 + 1.25 = 4.75
  assert.ok(stdout.includes("4.75"), "Output should include total of 4.75");
});

test("cost subcommand: --json output is valid JSON with expected shape", async () => {
  const { sessionsPath } = setupTemp();

  writeMeta(sessionsPath, "sess_json", {
    sessionId: "sess_json",
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    currentModel: "claude-sonnet-4-20250514",
    interactive: true,
    currentUsage: { costAmount: 2.00, costCurrency: "USD" },
    title: "JSON test session",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
  });

  const { stdout } = await runCost(["--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "total");
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.row.costAmount, 2.0);
});

test("cost subcommand: --json with multiple sessions shows correct totals", async () => {
  const { sessionsPath } = setupTemp();

  writeMeta(sessionsPath, "sess_a", {
    sessionId: "sess_a",
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    currentModel: "claude-sonnet-4-20250514",
    interactive: true,
    currentUsage: { costAmount: 1.00, costCurrency: "USD" },
    title: "Session A",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
  });

  writeMeta(sessionsPath, "sess_b", {
    sessionId: "sess_b",
    cwd: "/home/user/projects/other",
    agentId: "agent_b",
    currentModel: "gpt-4o",
    interactive: false,
    currentUsage: { costAmount: 3.00, costCurrency: "USD" },
    title: "Session B",
    createdAt: "2025-06-01T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
  });

  const { stdout } = await runCost(["--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "total");
  assert.equal(parsed.row.costAmount, 4.0);
});

test("cost subcommand: --by dir produces grouped output", async () => {
  const { sessionsPath } = setupTemp();

  writeMeta(sessionsPath, "sess_a", {
    sessionId: "sess_a",
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    currentModel: "claude-sonnet-4-20250514",
    interactive: true,
    currentUsage: { costAmount: 1.00, costCurrency: "USD" },
    title: "Myapp session",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
  });

  writeMeta(sessionsPath, "sess_b", {
    sessionId: "sess_b",
    cwd: "/home/user/projects/other",
    agentId: "agent_a",
    currentModel: "gpt-4o",
    interactive: false,
    currentUsage: { costAmount: 2.00, costCurrency: "USD" },
    title: "Other session",
    createdAt: "2025-06-01T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
  });

  const { stdout } = await runCost(["--by", "dir", "--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "grouped");
  assert.ok(Array.isArray(parsed.groups));
  assert.ok(parsed.groups.length >= 1);
});

test("cost subcommand: --interactive filter works", async () => {
  const { sessionsPath } = setupTemp();

  writeMeta(sessionsPath, "sess_int", {
    sessionId: "sess_int",
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    currentModel: "claude-sonnet-4-20250514",
    interactive: true,
    currentUsage: { costAmount: 5.00, costCurrency: "USD" },
    title: "Interactive session",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
  });

  writeMeta(sessionsPath, "sess_bg", {
    sessionId: "sess_bg",
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    currentModel: "claude-sonnet-4-20250514",
    interactive: false,
    currentUsage: { costAmount: 3.00, costCurrency: "USD" },
    title: "Background session",
    createdAt: "2025-06-01T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
  });

  const { stdout } = await runCost(["--interactive", "--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "total");
  // Only interactive session should be included
  assert.equal(parsed.row.costAmount, 5.0);
});

test("cost subcommand: --interactive filter excludes non-interactive sessions", async () => {
  const { sessionsPath } = setupTemp();

  writeMeta(sessionsPath, "sess_int", {
    sessionId: "sess_int",
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    currentModel: "claude-sonnet-4-20250514",
    interactive: true,
    currentUsage: { costAmount: 5.00, costCurrency: "USD" },
    title: "Interactive session",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
  });

  writeMeta(sessionsPath, "sess_bg", {
    sessionId: "sess_bg",
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    currentModel: "claude-sonnet-4-20250514",
    interactive: false,
    currentUsage: { costAmount: 3.00, costCurrency: "USD" },
    title: "Background session",
    createdAt: "2025-06-01T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
  });

  const { stdout } = await runCost(["--interactive", "--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "total");
  assert.equal(parsed.row.costAmount, 5.0);
});

test("cost subcommand: empty sessions dir returns zero cost", async () => {
  setupTemp(); // Creates temp but writes no sessions

  const { stdout } = await runCost([]);
  assert.ok(stdout.includes("Total:"), "Output should include 'Total:'");
});

test("cost subcommand: --metric tokens with history events includes token counts", async () => {
  const { sessionsPath } = setupTemp();

  writeMeta(sessionsPath, "sess_tok", {
    sessionId: "sess_tok",
    cwd: "/home/user/projects/myapp",
    agentId: "agent_a",
    currentModel: "claude-sonnet-4-20250514",
    interactive: true,
    currentUsage: { costAmount: 0.50, costCurrency: "USD" },
    title: "Token session",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
  });

  writeHistory(sessionsPath, "sess_tok", [
    JSON.stringify({
      method: "session/update",
      params: { update: {
        sessionUpdate: "usage_update",
        cost: { amount: 0.5, currency: "USD" },
        usage: { inputTokens: 1000, outputTokens: 500 },
        recordedAt: "2026-06-15T10:00:00.000Z",
      }},
    }),
  ]);

  const { stdout } = await runCost(["--metric", "tokens", "--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "total");
  assert.ok(parsed.row.inputTokens !== undefined, "Should include inputTokens");
  assert.ok(parsed.row.outputTokens !== undefined, "Should include outputTokens");
});
