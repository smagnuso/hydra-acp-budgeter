import { strict as assert } from "node:assert";
import { test, afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { scanSessions, sessionsDir } from "../src/cost/session-store.js";

function createTempSessionStore(): string {
  const base = mkdtempSync(resolve(tmpdir(), "budgeter-session-store-"));
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

let tempSessionsPath: string | null = null;

function withTempSessionStore(fn: (sessionsPath: string) => void): void {
  const sessionsPath = createTempSessionStore();
  try {
    fn(sessionsPath);
  } finally {
    rmSync(sessionsPath, { recursive: true, force: true });
  }
}

test("scanSessions returns valid records from temp directory", () => {
  withTempSessionStore((sessionsPath) => {
    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");

      writeMeta(sessionsPath, "sess_valid", {
        sessionId: "sess_valid",
        cwd: "/home/user/projects/myapp",
        agentId: "agent_a",
        currentModel: "claude-sonnet-4-20250514",
        interactive: true,
        currentUsage: { costAmount: 1.5, costCurrency: "USD" },
        title: "Valid session",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      });

      const records = scanSessions();
      assert.equal(records.length, 1);
      assert.equal(records[0].sessionId, "sess_valid");
      assert.equal(records[0].costAmount, 1.5);
      assert.equal(records[0].costCurrency, "USD");
      assert.equal(records[0].interactive, true);
      assert.equal(records[0].agentId, "agent_a");
      assert.equal(records[0].model, "claude-sonnet-4-20250514");
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

test("scanSessions skips malformed JSON", () => {
  withTempSessionStore((sessionsPath) => {
    const sessionDir = resolve(sessionsPath, "sess_malformed");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(resolve(sessionDir, "meta.json"), "{not valid json!!!");

    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      const records = scanSessions();
      assert.equal(records.length, 0);
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

test("scanSessions skips meta.json without sessionId", () => {
  withTempSessionStore((sessionsPath) => {
    writeMeta(sessionsPath, "sess_no_id", {
      cwd: "/home/user/projects/myapp",
      agentId: "agent_a",
      currentModel: "gpt-4o",
      interactive: true,
      currentUsage: { costAmount: 0.5, costCurrency: "USD" },
      title: "No session ID",
    });

    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      const records = scanSessions();
      assert.equal(records.length, 0);
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

test("scanSessions handles session with missing cwd", () => {
  withTempSessionStore((sessionsPath) => {
    writeMeta(sessionsPath, "sess_no_cwd", {
      sessionId: "sess_no_cwd",
      agentId: "agent_b",
      currentModel: "claude-sonnet-4-20250514",
      interactive: false,
      currentUsage: { costAmount: 3.0, costCurrency: "USD" },
      title: "Session without cwd",
      createdAt: "2025-06-01T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
    });

    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      const records = scanSessions();
      assert.equal(records.length, 1);
      assert.equal(records[0].sessionId, "sess_no_cwd");
      assert.equal(records[0].cwd, undefined);
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

test("scanSessions handles non-interactive sessions", () => {
  withTempSessionStore((sessionsPath) => {
    writeMeta(sessionsPath, "sess_bg", {
      sessionId: "sess_bg",
      cwd: "/home/user/projects/myapp",
      agentId: "agent_c",
      currentModel: "claude-sonnet-4-20250514",
      interactive: false,
      currentUsage: { costAmount: 0.75, costCurrency: "USD" },
      title: "Background session",
      createdAt: "2025-06-01T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
    });

    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      const records = scanSessions();
      assert.equal(records.length, 1);
      assert.equal(records[0].sessionId, "sess_bg");
      assert.equal(records[0].interactive, false);
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

test("scanSessions skips non-object meta.json (array, string, number)", () => {
  withTempSessionStore((sessionsPath) => {
    const sessionDir1 = resolve(sessionsPath, "sess_array");
    mkdirSync(sessionDir1, { recursive: true });
    writeFileSync(resolve(sessionDir1, "meta.json"), "[1, 2, 3]");

    const sessionDir2 = resolve(sessionsPath, "sess_string");
    mkdirSync(sessionDir2, { recursive: true });
    writeFileSync(resolve(sessionDir2, "meta.json"), '"just a string"');

    const sessionDir3 = resolve(sessionsPath, "sess_number");
    mkdirSync(sessionDir3, { recursive: true });
    writeFileSync(resolve(sessionDir3, "meta.json"), "42");

    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      const records = scanSessions();
      assert.equal(records.length, 0);
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

test("scanSessions skips empty meta.json", () => {
  withTempSessionStore((sessionsPath) => {
    const sessionDir = resolve(sessionsPath, "sess_empty");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(resolve(sessionDir, "meta.json"), "");

    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      const records = scanSessions();
      assert.equal(records.length, 0);
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

test("scanSessions skips non-directory entries in sessions dir", () => {
  withTempSessionStore((sessionsPath) => {
    // Create a file directly in the sessions directory (not a directory)
    writeFileSync(resolve(sessionsPath, "not_a_session"), "hello");

    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      const records = scanSessions();
      assert.equal(records.length, 0);
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

test("scanSessions returns empty array when sessions directory does not exist", () => {
  const env = process.env.HYDRA_ACP_HOME;
  try {
    process.env.HYDRA_ACP_HOME = "/nonexistent/path/that/should/not/exist";
    const records = scanSessions();
    assert.equal(records.length, 0);
  } finally {
    if (env === undefined) {
      delete process.env.HYDRA_ACP_HOME;
    } else {
      process.env.HYDRA_ACP_HOME = env;
    }
  }
});

test("scanSessions uses defaults for missing fields", () => {
  withTempSessionStore((sessionsPath) => {
    writeMeta(sessionsPath, "sess_defaults", {
      sessionId: "sess_defaults",
    });

    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      const records = scanSessions();
      assert.equal(records.length, 1);
      assert.equal(records[0].cwd, undefined);
      assert.equal(records[0].agentId, "");
      assert.equal(records[0].model, "");
      assert.equal(records[0].interactive, false);
      assert.equal(records[0].costAmount, 0);
      assert.equal(records[0].costCurrency, "");
      assert.equal(records[0].title, "");
      assert.equal(records[0].createdAt, "");
      assert.equal(records[0].updatedAt, "");
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

test("scanSessions handles mixed valid and invalid sessions", () => {
  withTempSessionStore((sessionsPath) => {
    // Valid session
    writeMeta(sessionsPath, "sess_a", {
      sessionId: "sess_a",
      cwd: "/home/user/projects/myapp",
      agentId: "agent_a",
      currentModel: "claude-sonnet-4-20250514",
      interactive: true,
      currentUsage: { costAmount: 1.0, costCurrency: "USD" },
      title: "Good session",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z",
    });

    // Malformed JSON
    const dir_b = resolve(sessionsPath, "sess_b");
    mkdirSync(dir_b, { recursive: true });
    writeFileSync(resolve(dir_b, "meta.json"), "{broken");

    // Missing sessionId
    writeMeta(sessionsPath, "sess_c", {
      cwd: "/home/user/projects/other",
      agentId: "agent_b",
      currentModel: "gpt-4o",
      interactive: false,
      currentUsage: { costAmount: 2.0, costCurrency: "USD" },
    });

    // Valid non-interactive session
    writeMeta(sessionsPath, "sess_d", {
      sessionId: "sess_d",
      cwd: "/home/user/projects/myapp/src",
      agentId: "agent_a",
      currentModel: "claude-sonnet-4-20250514",
      interactive: false,
      currentUsage: { costAmount: 0.5, costCurrency: "USD" },
      title: "Background task",
      createdAt: "2025-06-01T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
    });

    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      const records = scanSessions();
      assert.equal(records.length, 2);
      assert.ok(records.some(r => r.sessionId === "sess_a" && r.interactive === true));
      assert.ok(records.some(r => r.sessionId === "sess_d" && r.interactive === false));
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

test("scanSessions handles session with relative cwd", () => {
  withTempSessionStore((sessionsPath) => {
    writeMeta(sessionsPath, "sess_rel_cwd", {
      sessionId: "sess_rel_cwd",
      cwd: "./relative/path",
      agentId: "agent_a",
      currentModel: "claude-sonnet-4-20250514",
      interactive: true,
      currentUsage: { costAmount: 0.25, costCurrency: "USD" },
      title: "Relative cwd session",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z",
    });

    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      const records = scanSessions();
      assert.equal(records.length, 1);
      // Relative cwd should be preserved as-is (not realpathed)
      assert.equal(records[0].cwd, "./relative/path");
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

// meta.json splits lifetime cost across cumulativeCost (retired agent lives)
// and costAmount (current life). Reading costAmount alone under-reports any
// session that has rotated its agent via compaction swap, /hydra agent, or a
// resurrect.
test("scanSessions sums cumulativeCost with costAmount", () => {
  withTempSessionStore((sessionsPath) => {
    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");

      writeMeta(sessionsPath, "sess_split", {
        sessionId: "sess_split",
        cwd: "/home/user/projects/myapp",
        agentId: "agent_a",
        currentModel: "claude-sonnet-4-20250514",
        interactive: true,
        currentUsage: {
          costAmount: 1.5,
          cumulativeCost: 3.5,
          costCurrency: "USD",
        },
        title: "Swapped session",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      });

      const records = scanSessions();
      assert.equal(records.length, 1);
      assert.equal(records[0].costAmount, 5.0);
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

// Daemons predating the split collapse the lifetime total into costAmount and
// omit cumulativeCost entirely; summing must leave those records untouched.
test("scanSessions leaves legacy collapsed totals unchanged", () => {
  withTempSessionStore((sessionsPath) => {
    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");

      writeMeta(sessionsPath, "sess_legacy", {
        sessionId: "sess_legacy",
        cwd: "/home/user/projects/myapp",
        agentId: "agent_a",
        currentModel: "claude-sonnet-4-20250514",
        interactive: true,
        currentUsage: { costAmount: 5.0, costCurrency: "USD" },
        title: "Legacy session",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      });

      const records = scanSessions();
      assert.equal(records.length, 1);
      assert.equal(records[0].costAmount, 5.0);
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
    }
  });
});

// Attribution tests use REAL directories: scanSessions realpath-resolves
// an absolute cwd and yields undefined when the path does not exist, so
// fictional paths would silently read as "no cwd" and prove nothing.
function realDir(label: string): string {
  return mkdtempSync(resolve(tmpdir(), `budgeter-${label}-`));
}

test("attributes an isolated session's spend to its source tree, not its workspace", () => {
  // Regression guard for silent under-reporting. An isolated session runs
  // in a workspace OUTSIDE the repo, so a record carrying only the
  // workspace path drops out of `--dir <repo>` entirely. Orchestrated
  // runs are the heaviest spenders and the ones that get isolated, so
  // this is where per-project cost would be most wrong.
  const sourceDir = realDir("source");
  const wsDir = realDir("workspace");
  withTempSessionStore((sessionsPath) => {
    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      writeMeta(sessionsPath, "sess_isolated", {
        sessionId: "sess_isolated",
        // cwd is the workspace: that is where the agent actually ran.
        cwd: wsDir,
        workspace: {
          path: wsDir,
          sourceCwd: sourceDir,
          label: "featureA",
          provider: "git",
        },
        agentId: "agent_a",
        interactive: true,
        currentUsage: { costAmount: 4.25, costCurrency: "USD" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      });

      const records = scanSessions();
      assert.equal(records.length, 1);
      assert.equal(records[0].cwd, realpathSync(sourceDir));
      assert.notEqual(records[0].cwd, realpathSync(wsDir));
      assert.equal(records[0].costAmount, 4.25);
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
    }
  });
});

test("still attributes spend after the workspace directory is gone", () => {
  // Workspaces are removed when their session is; source trees are not.
  // Attributing to the workspace would make the spend unresolvable the
  // moment cleanup ran, since a vanished path realpaths to undefined and
  // is then skipped by directory filtering altogether.
  const sourceDir = realDir("source-persist");
  const wsDir = realDir("workspace-gone");
  rmSync(wsDir, { recursive: true, force: true });
  withTempSessionStore((sessionsPath) => {
    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      writeMeta(sessionsPath, "sess_gone_ws", {
        sessionId: "sess_gone_ws",
        cwd: wsDir,
        workspace: { path: wsDir, sourceCwd: sourceDir, label: "old", provider: "git" },
        agentId: "agent_a",
        interactive: true,
        currentUsage: { costAmount: 9.0, costCurrency: "USD" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      });

      const records = scanSessions();
      assert.equal(records[0].cwd, realpathSync(sourceDir));
      assert.equal(records[0].costAmount, 9.0);
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

test("leaves a non-isolated session's cwd alone, and tolerates a malformed workspace block", () => {
  const plainDir = realDir("plain");
  withTempSessionStore((sessionsPath) => {
    const env = process.env.HYDRA_ACP_HOME;
    try {
      process.env.HYDRA_ACP_HOME = resolve(sessionsPath, "..");
      writeMeta(sessionsPath, "sess_plain", {
        sessionId: "sess_plain",
        cwd: plainDir,
        agentId: "agent_a",
        interactive: true,
        currentUsage: { costAmount: 1.0, costCurrency: "USD" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      });
      writeMeta(sessionsPath, "sess_bad_ws", {
        sessionId: "sess_bad_ws",
        cwd: plainDir,
        workspace: "not-an-object",
        agentId: "agent_a",
        interactive: true,
        currentUsage: { costAmount: 2.0, costCurrency: "USD" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      });

      const records = scanSessions();
      const expected = realpathSync(plainDir);
      for (const r of records) {
        assert.equal(r.cwd, expected);
      }
    } finally {
      if (env === undefined) {
        delete process.env.HYDRA_ACP_HOME;
      } else {
        process.env.HYDRA_ACP_HOME = env;
      }
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
