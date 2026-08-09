// Pure core of the cost reconciliation. No filesystem or database access —
// callers supply an already-built call index and ledger, so every decision
// here is unit-testable without fixtures.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// hydra's recorded `usage_update` rows carry a lifetime cost total that is
// inflated on any session that was cold-resurrected before the ledger-probe
// fix landed. On resurrect the daemon banked its own displayed total into
// cumulativeCost, then a session-scoped agent (OpenCode reports
// totalSessionCost(messages) — a re-sum of its WHOLE history) re-reported that
// same spend, and the two were added. The error compounds once per resurrect.
//
// Rather than trying to detect those events from the cost series — which is
// unreliable, since a resurrect and one expensive turn look identical — this
// reconstructs the truth from the agent's own ledger and overwrites each row.
//
// ---------------------------------------------------------------------------
// ATTRIBUTION
//
// The hard part is knowing WHICH agent sessions a hydra session used.
// `params.sessionId` on a recorded row is the hydra id, and meta.json keeps
// only the CURRENT upstreamSessionId — earlier ones are overwritten when the
// upstream rotates (compaction swap, /hydra agent, restart, rollback). So a
// cost series spanning several upstreams is not attributable from meta.json.
//
// It IS attributable from tool calls: hydra records `toolCallId`, and OpenCode
// stores the same value as `part.data.callID` alongside its `session_id`. The
// distinct set of sessions reachable that way is exactly the set of upstreams
// the hydra session used, current and retired.
//
// Two classes of tool call must NOT be counted:
//
//   * Forwarded worker calls. The planner re-emits a worker's tool calls onto
//     the orchestrator's wire, namespaced `<taskId>:` and stamped with
//     _meta["hydra-acp"].planner (planner/src/worker-forward.ts). That work
//     belongs to the worker's own session; folding it in would attribute spend
//     the orchestrator's agent never reported. Detected via the _meta marker
//     rather than the id prefix, because task ids are free-form and a regex on
//     `T\d+:` misses compound ones.
//
//   * Unresolvable ids, when they dominate. Means the agent's ledger has been
//     partially purged, so any total we computed would silently under-report.
//
// ---------------------------------------------------------------------------
// GUARANTEES
//
// Every repair is checked against invariants before it may be written
// (see checkGuards). A session failing any of them is refused outright rather
// than partially repaired — during development this logic produced a negative
// cost and a 30% over-count, both of which the guards catch.

/** `callID` -> the agent session that owns it. */
export type CallIndex = ReadonlyMap<string, string>;

/** Agent session id -> its assistant-message costs, ascending by timestamp. */
export type Ledger = ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;

/** One recorded `usage_update`, in transcript order. */
export interface UsageRow {
  /** Archive file the row lives in ("history.jsonl", "history.jsonl.2.gz", …). */
  readonly file: string;
  /** Zero-based line offset within that file. */
  readonly line: number;
  readonly recordedAt: number;
  /** Current cost.amount, or the stamped pristine value if already repaired. */
  readonly amount: number;
}

/** One recorded `tool_call`, used only for attribution. */
export interface ToolCallRow {
  readonly toolCallId: string;
  /** True when _meta["hydra-acp"].planner is present (forwarded worker work). */
  readonly forwarded: boolean;
}

export interface SessionInput {
  readonly sessionId: string;
  readonly agentId: string;
  readonly forkedFromSessionId?: string | undefined;
  /** meta.json currentUsage, already collapsed to a lifetime total. */
  readonly reportedTotal: number;
  readonly usageRows: readonly UsageRow[];
  readonly toolCalls: readonly ToolCallRow[];
  /**
   * meta.json's upstreamSessionId — the agent session the hydra session is
   * sitting on right now. Required to split the repaired total into the
   * persisted ledger's two halves; see `LedgerSplit`.
   */
  readonly currentUpstream?: string | undefined;
}

/**
 * The repaired total, divided the way meta.json's cost ledger must store it.
 *
 * hydra persists cost as two fields: `cumulativeCost` is spend on upstreams
 * that have been retired, and `costAmount` is spend on the upstream the
 * session is on NOW. Writing the whole lifetime into `costAmount` gets the
 * total right but the shape wrong, and the shape is load-bearing on the next
 * resurrect: `Session.armCostLedgerProbe` arms the probe with `costAmount`
 * and `reconcileCostLedger` then compares the agent's first report against
 * it. That comparison assumes `costAmount` covers ONLY the current upstream.
 *
 * Violate it and the probe mis-adjudicates. An agent like opencode re-sums
 * its own session on reload, so it reports just the current upstream's
 * spend; against a probe inflated with retired spend that read as
 * "incoming < retained", i.e. "the agent restarted at $0", and the whole
 * collapsed total got banked on top of the fresh report — double-counting
 * the current upstream. Observed on a real session ($335.27 recorded against
 * $257.91 of true spend, over by exactly the current upstream's cost at
 * repair time).
 */
export interface LedgerSplit {
  /** Spend on retired upstreams -> meta.json cumulativeCost. */
  readonly retired: number;
  /** Spend on the current upstream -> meta.json costAmount. */
  readonly current: number;
  /** Per-upstream cost, ascending by first message. Ordering is the ledger's. */
  readonly perUpstream: ReadonlyArray<{
    readonly upstreamSessionId: string;
    readonly cost: number;
    readonly firstAt: number;
    readonly lastAt: number;
    readonly isCurrent: boolean;
  }>;
}

/**
 * Divide the ledger sum over `upstreams` into retired vs current.
 *
 * When `currentUpstream` is absent or unknown to the ledger the split cannot
 * be made honestly, so everything is reported as `current` — which reproduces
 * the pre-split behaviour and is exactly right for the single-upstream case
 * that dominates the corpus.
 */
export function splitLedger(
  ledger: Ledger,
  upstreams: readonly string[],
  currentUpstream: string | undefined,
): LedgerSplit {
  const per = upstreams.map((sid) => {
    const entries = ledger.get(sid) ?? [];
    let cost = 0;
    for (const [, c] of entries) {
      cost += c;
    }
    return {
      upstreamSessionId: sid,
      cost,
      firstAt: entries[0]?.[0] ?? Number.MAX_SAFE_INTEGER,
      lastAt: entries[entries.length - 1]?.[0] ?? 0,
      isCurrent: sid === currentUpstream,
    };
  });
  per.sort((a, b) => a.firstAt - b.firstAt);

  const known = currentUpstream !== undefined && per.some((p) => p.isCurrent);
  let retired = 0;
  let current = 0;
  for (const p of per) {
    if (!known || p.isCurrent) {
      current += p.cost;
    } else {
      retired += p.cost;
    }
  }
  return { retired, current, perUpstream: per };
}

export type RefusalReason =
  | "zero-cost"
  | "fork"
  | "no-own-upstream"
  | "majority-unresolved"
  | "guard-violation";

export interface Attribution {
  /** Agent sessions proven to belong to this hydra session. */
  readonly upstreams: readonly string[];
  readonly ownResolved: number;
  readonly ownUnresolved: number;
  readonly forwardedSkipped: number;
}

export interface RepairedRow extends UsageRow {
  readonly repaired: number;
}

export interface RepairPlan {
  readonly sessionId: string;
  readonly attribution: Attribution;
  readonly rows: readonly RepairedRow[];
  readonly reportedTotal: number;
  readonly trueTotal: number;
  /** How `trueTotal` must be laid out across meta.json's two cost fields. */
  readonly split: LedgerSplit;
}

export interface Refusal {
  readonly sessionId: string;
  readonly reason: RefusalReason;
  readonly detail: string;
  readonly attribution?: Attribution;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: RepairPlan }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * Resolve the set of agent sessions a hydra session actually used.
 * Forwarded worker calls are excluded — see the file header.
 */
export function attribute(
  toolCalls: readonly ToolCallRow[],
  index: CallIndex,
): Attribution {
  const upstreams = new Set<string>();
  let ownResolved = 0;
  let ownUnresolved = 0;
  let forwardedSkipped = 0;
  for (const tc of toolCalls) {
    if (tc.forwarded) {
      forwardedSkipped += 1;
      continue;
    }
    const sid = index.get(tc.toolCallId);
    if (sid === undefined) {
      ownUnresolved += 1;
      continue;
    }
    upstreams.add(sid);
    ownResolved += 1;
  }
  return {
    upstreams: [...upstreams].sort(),
    ownResolved,
    ownUnresolved,
    forwardedSkipped,
  };
}

/**
 * Lifetime cost across `upstreams` as of `ts`, summing every assistant message
 * at or before that instant. Linear scan per call; callers repairing a long
 * session should prefer `truthSeries`.
 */
export function truthAt(
  ledger: Ledger,
  upstreams: readonly string[],
  ts: number,
): number {
  let total = 0;
  for (const sid of upstreams) {
    for (const [t, cost] of ledger.get(sid) ?? []) {
      if (t > ts) {
        break; // ledger entries are ascending
      }
      total += cost;
    }
  }
  return total;
}

/**
 * Truth for a whole ascending series of timestamps in one merged pass —
 * O(rows + messages) rather than O(rows × messages). A two-month session can
 * hold ~400 rows against ~10k messages, so the linear form matters.
 */
export function truthSeries(
  ledger: Ledger,
  upstreams: readonly string[],
  timestamps: readonly number[],
): number[] {
  const merged: Array<readonly [number, number]> = [];
  for (const sid of upstreams) {
    for (const entry of ledger.get(sid) ?? []) {
      merged.push(entry);
    }
  }
  merged.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  let i = 0;
  let running = 0;
  for (const ts of timestamps) {
    while (i < merged.length && merged[i]![0] <= ts) {
      running += merged[i]![1];
      i += 1;
    }
    out.push(running);
  }
  return out;
}

export interface GuardResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

/**
 * Invariants every repair must satisfy. A violation means our attribution is
 * wrong, not that the data is unusual — so the session is refused rather than
 * written. Each of these caught a real defect during development.
 */
export function checkGuards(
  rows: readonly RepairedRow[],
  reportedTotal: number,
): GuardResult {
  const violations: string[] = [];
  const EPS = 1e-6;

  for (const r of rows) {
    if (r.repaired < -EPS) {
      violations.push(`negative repaired value ${r.repaired} at ${r.file}:${r.line}`);
      break;
    }
  }
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i]!.repaired < rows[i - 1]!.repaired - EPS) {
      violations.push(
        `repaired series decreases at ${rows[i]!.file}:${rows[i]!.line} ` +
          `(${rows[i - 1]!.repaired} -> ${rows[i]!.repaired})`,
      );
      break;
    }
  }
  // hydra over-reports, so truth exceeding the recorded value means we folded
  // in an agent session that is not actually this hydra session's — the
  // failure mode that made an earlier cwd+time heuristic over-count by 30%.
  //
  // The comparison is against the NEXT row rather than this one, because a
  // small transient excess is expected and benign: hydra writes its snapshot
  // at the turn boundary, and a message can land in the agent's ledger in the
  // gap before we look it up, leaving our figure momentarily ahead. That
  // artifact resolves by the following row. Genuine over-attribution does not
  // — it persists for the rest of the series, so it still trips this on the
  // final row, which is compared against meta.json's total below.
  for (let i = 0; i < rows.length; i += 1) {
    const ceiling = Math.max(rows[i]!.amount, rows[i + 1]?.amount ?? rows[i]!.amount);
    if (rows[i]!.repaired > ceiling + EPS) {
      violations.push(
        `repaired ${rows[i]!.repaired} exceeds recorded ${rows[i]!.amount} ` +
          `at ${rows[i]!.file}:${rows[i]!.line}`,
      );
      break;
    }
  }
  const last = rows[rows.length - 1];
  if (last !== undefined && last.repaired > reportedTotal + EPS) {
    violations.push(
      `repaired final ${last.repaired} exceeds meta.json total ${reportedTotal}`,
    );
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Build a repair plan, or explain why the session is refused.
 *
 * `usageRows` may be empty: a session whose transcript predates per-turn usage
 * recording still gets a corrected meta.json total, which is what `session
 * list` / `session info` / REST actually display.
 */
export function planSession(
  input: SessionInput,
  index: CallIndex,
  ledger: Ledger,
): PlanResult {
  const refuse = (reason: RefusalReason, detail: string, a?: Attribution): PlanResult => ({
    ok: false,
    refusal: { sessionId: input.sessionId, reason, detail, ...(a ? { attribution: a } : {}) },
  });

  if (input.reportedTotal <= 0) {
    return refuse("zero-cost", "nothing to repair");
  }
  // A fork's transcript is COPIED from its parent, so the copied prefix's tool
  // calls resolve to the parent's upstream and would fold parent spend into the
  // child. Separating them needs the fork boundary; the OpenCode fork inflation
  // is small enough that refusing is the better trade.
  if (input.forkedFromSessionId) {
    return refuse("fork", `forked from ${input.forkedFromSessionId}`);
  }

  const attribution = attribute(input.toolCalls, index);
  if (attribution.upstreams.length === 0) {
    return refuse(
      "no-own-upstream",
      `no tool call resolves to an agent session (${attribution.ownUnresolved} unresolved, ` +
        `${attribution.forwardedSkipped} forwarded)`,
      attribution,
    );
  }
  if (attribution.ownUnresolved > attribution.ownResolved) {
    return refuse(
      "majority-unresolved",
      `${attribution.ownUnresolved} of ${attribution.ownUnresolved + attribution.ownResolved} ` +
        `own tool ids unresolved — ledger partially purged, total would under-report`,
      attribution,
    );
  }

  const truths = truthSeries(
    ledger,
    attribution.upstreams,
    input.usageRows.map((r) => r.recordedAt),
  );
  const rows: RepairedRow[] = input.usageRows.map((r, i) => ({
    ...r,
    repaired: truths[i] ?? 0,
  }));

  const guards = checkGuards(rows, input.reportedTotal);
  if (!guards.ok) {
    return refuse("guard-violation", guards.violations.join("; "), attribution);
  }

  // meta.json describes the session as it stands NOW, so its total is the full
  // ledger sum — not the truth as of the last recorded row. hydra stops writing
  // usage_update when a session goes cold mid-turn, so the agent's ledger can
  // hold messages the transcript never saw; taking the last row's value would
  // silently drop them. Observed on one real session, which the repair would
  // otherwise have moved further from the truth than it started.
  const trueTotal = truthAt(ledger, attribution.upstreams, Number.MAX_SAFE_INTEGER);
  const split = splitLedger(ledger, attribution.upstreams, input.currentUpstream);

  return {
    ok: true,
    plan: {
      sessionId: input.sessionId,
      attribution,
      rows,
      reportedTotal: input.reportedTotal,
      trueTotal,
      split,
    },
  };
}
