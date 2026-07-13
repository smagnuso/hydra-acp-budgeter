# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-acp-budgeter` — cost-budget **transformer** for Hydra. Watches every
session's `usage_update` events, warns attached clients when total spend
crosses a soft limit, and rejects further prompts once it crosses a hard
limit — with a human-readable reason returned to the client.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon. Full docs and wire protocol
live at [`smagnuso/hydra-acp`](https://github.com/smagnuso/hydra-acp) — see
`cli/PROTOCOL.md` for the transformer surface.

This is a **transformer**, not a client extension: it connects to the
daemon once, declares its intercepts via `transformer/initialize`, and
sits inside the daemon's message pipeline for every live session.
Transformers see traffic in both directions before the daemon acts on it,
so they can block prompts and inspect usage updates before clients see
them. Reference implementations live in `cli/examples/transformer-*.mjs`.

## Layout

- `src/index.ts` — entry point
- `src/bridge.ts` — transformer WS connection + intercept dispatch
- `src/router.ts` — dispatches intercepted messages to handlers
- `src/tracker.ts` — per-session running-cost tracker
- `src/enforce.ts` — soft-warn / hard-block decisions
- `src/cost/` — pricing model + token→cost math
- `src/rule.ts`, `src/config.ts`, `src/paths.ts` — user config + state
- `src/acp/`, `src/util/`

## Build & test

```
npm install
npm run build     # tsup → dist/
npm test          # vitest
npm run lint
```

Ships as `hydra-acp-budgeter` on PATH. Registered via
`hydra-acp transformer add hydra-acp-budgeter` (note: *transformer*, not
*extension*). Also reachable as `hydra-acp budgeter`.

## Conventions

- TypeScript, ESM, tsup, vitest.
- **Transformer trust boundary**: this process can rewrite or block any
  message flowing through the daemon. Fail-open on error — never bring a
  session down because a rule threw. Log and continue.
- Cost calculation must be pure: given `usage_update` + pricing table →
  cost. Persist running totals but never require reading them to make a
  block decision (rehydrate on start).
- Reject reason strings surface to the user. Keep them concise and
  actionable.

## Gotchas

- `usage_update` shapes vary by agent. Handle missing/partial fields
  defensively.
- Pricing table drift: when models change price, old sessions have already
  been computed with old prices. Don't retroactively rewrite totals.
- Hard-block must be idempotent — if a client retries after a rejection,
  reject again rather than partially processing.
- **`usage_update` is a running total, not a delta** (`tracker.ts` uses
  `Math.max(prior.cost, cost.amount)`). Treating it as a delta
  double-counts every turn; treating a shrinking value as authoritative
  under-counts on retries. Read this before touching cost math.
- **The state-file watcher fires on this process's own writes** — a
  `lastWrittenJson` mirror in `tracker.ts` filters self-writes so the
  `reset` subcommand's rewrite doesn't loop. `watchTimer` debounces
  bursts 50ms in `bridge.ts`.
- **`request:session/prompt` awaits the rule** (`bridge.ts`). The
  daemon's `forwardRequest` is blocked until we reply — a slow rule
  visibly stalls every prompt. Rules that do I/O will show up as user
  latency.
- **"Reset" is baseline snapshot, not zero** (`tracker.ts`). It captures
  the current agent-reported total and subtracts on subsequent updates.
  Editing this to literally zero the counter will silently double-charge
  on the next `usage_update`.

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
