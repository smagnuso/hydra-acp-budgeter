import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { transcriptFiles, transcriptLines } from "../src/cost/history-files.js";

function session(files: Record<string, string>): string {
  const d = mkdtempSync(resolve(tmpdir(), "hydra-hf-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(resolve(d, name), name.endsWith(".gz") ? gzipSync(Buffer.from(body)) : body);
  }
  return d;
}
const names = (d: string) => transcriptFiles(d).map((p) => basename(p));

// Ascending N is ascending TIME (history-store spills to N then rolls to
// N+1), so .1 is the OLDEST archive. Reading in logrotate order makes the
// cumulative cost series jump backwards at every seam.
test("orders archives by ascending N, then the live file", () => {
  const d = session({
    "history.jsonl": "live\n",
    "history.jsonl.1": "a\n",
    "history.jsonl.2": "b\n",
    "history.jsonl.10": "c\n",
  });
  assert.deepEqual(names(d), ["history.jsonl.1", "history.jsonl.2", "history.jsonl.10", "history.jsonl"]);
  rmSync(d, { recursive: true, force: true });
});

// The ring unlinks the lowest N, so gaps are normal, not corruption.
test("tolerates non-contiguous archive indices left by ring eviction", () => {
  const d = session({ "history.jsonl": "live\n", "history.jsonl.4": "d\n", "history.jsonl.2": "b\n" });
  assert.deepEqual(names(d), ["history.jsonl.2", "history.jsonl.4", "history.jsonl"]);
  rmSync(d, { recursive: true, force: true });
});

// A crash between seal-to-.gz and unlink-plain leaves both. Counting both
// would double that archive's spend.
test("prefers the sealed .gz when both forms of an archive exist", async () => {
  const d = session({
    "history.jsonl": "live\n",
    "history.jsonl.1.gz": "sealed\n",
    "history.jsonl.1": "stale\n",
  });
  assert.deepEqual(names(d), ["history.jsonl.1.gz", "history.jsonl"]);
  const out: string[] = [];
  for await (const l of transcriptLines(d)) out.push(l);
  assert.deepEqual(out, ["sealed", "live"]);
  rmSync(d, { recursive: true, force: true });
});

test("decompresses .gz archives and streams the live file last", async () => {
  const d = session({ "history.jsonl": "z\n", "history.jsonl.1.gz": "x\ny\n" });
  const out: string[] = [];
  for await (const l of transcriptLines(d)) out.push(l);
  assert.deepEqual(out, ["x", "y", "z"]);
  rmSync(d, { recursive: true, force: true });
});

test("a session with no live file still yields its archives", async () => {
  const d = session({ "history.jsonl.1": "only\n" });
  assert.deepEqual(names(d), ["history.jsonl.1"]);
  rmSync(d, { recursive: true, force: true });
});

test("an absent session directory yields nothing", () => {
  assert.deepEqual(transcriptFiles(resolve(tmpdir(), "hydra-hf-does-not-exist")), []);
});
