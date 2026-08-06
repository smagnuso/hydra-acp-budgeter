import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const ARCHIVE = /^history\.jsonl\.(\d+)(\.gz)?$/;

/**
 * A session's transcript files in chronological order: archives by ascending
 * N, then the live file.
 *
 * Ordering matters and is counter-intuitive for anyone used to logrotate:
 * hydra's history-store spills the live file into history.jsonl.N and rolls
 * to N+1 as each archive fills, so **ascending N is ascending time** and
 * `.1` is the OLDEST surviving archive, not the newest. Reading them in the
 * logrotate order makes the cumulative cost series jump backwards and any
 * differencing consumer invents spend at every seam.
 *
 * N is not contiguous: history-store keeps a bounded ring
 * (archiveTiers) and unlinks the lowest N when a new archive is needed, so
 * gaps are normal and are not a signal of corruption.
 *
 * A given N may exist as both `.gz` and plain: history-store seals to `.gz`
 * then unlinks the plain file, and a crash in between leaves both. The `.gz`
 * is the sealed copy, so it wins — counting both would double the archive.
 */
export function transcriptFiles(sessionDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(sessionDir);
  } catch {
    return [];
  }
  const byIndex = new Map<number, string>();
  for (const name of names) {
    const m = ARCHIVE.exec(name);
    if (!m) {
      continue;
    }
    const n = Number(m[1]);
    const gz = m[2] !== undefined;
    const existing = byIndex.get(n);
    if (existing === undefined || (gz && !existing.endsWith(".gz"))) {
      byIndex.set(n, name);
    }
  }
  const out = [...byIndex.keys()].sort((a, b) => a - b).map((n) => resolve(sessionDir, byIndex.get(n)!));
  const live = resolve(sessionDir, "history.jsonl");
  if (existsSync(live)) {
    out.push(live);
  }
  return out;
}

/** Yield every line of a session's transcript, oldest archive first. */
export async function* transcriptLines(sessionDir: string): AsyncGenerator<string, void, undefined> {
  for (const path of transcriptFiles(sessionDir)) {
    const raw = createReadStream(path);
    const input = path.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (line.length > 0) {
          yield line;
        }
      }
    } catch {
      // A truncated or corrupt archive must not abort the whole session's
      // series; the live file is usually the important part.
    } finally {
      rl.close();
      raw.destroy();
    }
  }
}
