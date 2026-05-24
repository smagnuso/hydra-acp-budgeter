# hydra-acp-budgeter

Cost-budget transformer extension for [hydra-acp](https://github.com/smagnuso/hydra-acp). Watches every session's `usage_update` events, warns attached clients when total spend crosses a soft limit, and rejects further prompts once it crosses a hard limit — with a human-readable reason returned to the client.

Runs as a daemon-managed *transformer* (not a client extension): it connects once, declares its intercepts via `transformer/initialize`, and sits inside the daemon's message pipeline for every live session.

## Install

From npm (recommended once published):

```sh
npm install -g @hydra-acp/budgeter
```

This drops a `hydra-acp-budgeter` binary on your PATH.

Or from source:

```sh
git clone git@github.com:smagnuso/hydra-acp-budgeter.git ~/dev/hydra-acp-budgeter
cd ~/dev/hydra-acp-budgeter
npm install
npm run build
```

Register the transformer with hydra. If installed via npm:

```sh
hydra-acp transformers add hydra-acp-budgeter --command hydra-acp-budgeter
```

Or pointed at a local build:

```sh
hydra-acp transformers add hydra-acp-budgeter \
  --command node \
  --args ~/dev/hydra-acp-budgeter/dist/index.js
```

That writes the equivalent entry into `~/.hydra-acp/config.json`:

```json
{
  "transformers": {
    "hydra-acp-budgeter": {
      "command": ["node"],
      "args": ["/home/you/dev/hydra-acp-budgeter/dist/index.js"],
      "enabled": true
    }
  },
  "defaultTransformers": ["hydra-acp-budgeter"]
}
```

Adding the name to `defaultTransformers` is what actually plumbs it into every new session's chain — without that, the transformer process runs but no traffic flows through it.

On `hydra-acp daemon start`, hydra spawns hydra-acp-budgeter with these env
vars set: `HYDRA_ACP_DAEMON_URL`, `HYDRA_ACP_TOKEN`, `HYDRA_ACP_WS_URL`,
`HYDRA_ACP_HOME`, `HYDRA_ACP_TRANSFORMER_NAME`. Stdout/stderr land in
`~/.hydra-acp/transformers/hydra-acp-budgeter.log`. Lifecycle is managed with
`hydra-acp transformers start|stop|restart hydra-acp-budgeter` and
`hydra-acp transformers logs hydra-acp-budgeter -f` to tail.

## Default behavior (no config)

Tracks each session's running cost from `usage_update` events (the `cost.amount` the agent reports, or `_meta.hydra-acp.cumulativeCost` when present), sums across sessions, and acts at two thresholds:

**1. Soft limit crossed** (`total ≥ HYDRA_ACP_BUDGETER_SOFT`)
- Emits a single warning `session/update` (`agent_message_chunk`) to every attached client on the session that triggered the cross.
- Body: `Spent $X.XX of $S.SS soft (hard: $H.HH). Heads up — prompts will be rejected at the hard limit.`
- Fires **once per upward transition**, not on every tick.

**2. Hard limit crossed** (`total ≥ HYDRA_ACP_BUDGETER_HARD`)
- Same one-shot warning, this time on the session that pushed us over.
- Body: `Spent $X.XX ≥ $H.HH hard limit. Further prompts will be rejected until the budget is reset.`

**3. Prompts while over hard limit**
- Any `session/prompt` from any session is intercepted at `request:session/prompt` and replaced with a stop response:
  ```json
  {
    "stopReason": "refusal",
    "_meta": {
      "hydra-acp": {
        "budgeter": {
          "message": "Budget exceeded: spent $X.XX ≥ $H.HH hard limit. Reset the budget or raise HYDRA_ACP_BUDGETER_HARD to continue."
        }
      }
    }
  }
  ```
- The agent never sees the prompt. The client's pending `session/prompt` resolves with the stop payload; well-behaved renderers (TUI, Zed, agent-shell) will surface the `stopReason: refusal` and the `_meta.hydra-acp.budgeter.message` body.

**4. New session opens while over hard limit**
- The budgeter fires the same warning style on `session.opened` so the user knows their next prompt will bounce, even before they send it.

Reset is currently "restart the transformer" — the per-session cost map is in-memory only. Stop/start with:

```sh
hydra-acp transformers restart hydra-acp-budgeter
```

## Configure

`~/.hydra-acp/budgeter.config.js` (override path via `HYDRA_ACP_BUDGETER_CONFIG`). Default-exports a function that decides per event:

```js
// ~/.hydra-acp/budgeter.config.js
export default function budget(ev) {
  // ev.kind: "usage_update" | "prompt_request" | "session_opened" |
  //          "session_closed" | "threshold_cross"
  // ev.sessionId, ev.meta.cwd, ev.meta.agentId, ev.meta.title
  // ev.budget: { total, perSession, currency, soft, hard, state }
  //   state ∈ "ok" | "soft" | "hard"
  // ev.raw: for usage_update kinds, the update payload;
  //         for prompt_request, { envelope };
  //         for threshold_cross, { from, to };
  //         else, {}.

  // Don't warn on the named-test sessions:
  if (ev.meta.title?.startsWith("test:")) return null;

  if (ev.kind === "threshold_cross" && ev.raw.to === "soft") {
    return {
      warn: {
        title: `💸 Halfway to your budget`,
        body: `You've spent ${ev.budget.total.toFixed(2)} ${ev.budget.currency} (limit ${ev.budget.hard}).`,
      },
    };
  }

  if (ev.kind === "prompt_request" && ev.budget.state === "hard") {
    return {
      reject: {
        message: `Budget cap reached. Bump HYDRA_ACP_BUDGETER_HARD to continue.`,
        stopReason: "refusal",
      },
    };
  }

  return null;
}
```

### Event shape

```ts
interface BudgetEvent {
  sessionId: string;
  kind:
    | "usage_update"
    | "prompt_request"
    | "session_opened"
    | "session_closed"
    | "threshold_cross";
  raw: Record<string, unknown>;
  meta: { cwd?: string; agentId?: string; title?: string };
  budget: {
    total: number;       // sum across every session the budgeter has seen
    perSession: number;  // this session's contribution
    currency: string;
    soft: number;
    hard: number;
    state: "ok" | "soft" | "hard";
  };
}
```

### Verdict shape

```ts
interface BudgetVerdict {
  // Emit a warning agent_message_chunk to every client attached to the session.
  warn?: { title: string; body?: string };
  // Only meaningful on prompt_request — turns session/prompt into a stop
  // with the given message. stopReason defaults to "refusal".
  reject?: { message: string; stopReason?: string };
}
```

Return `null` / `undefined` to skip. Throws are caught + logged + treated as skip.

### Reload

After editing `budgeter.config.js`:

```sh
hydra-acp transformers restart hydra-acp-budgeter
```

(Or `kill -HUP <pid>` for a no-restart reload — the process re-imports the rule on `SIGHUP`.)

## Environment

| Env var | Default | Purpose |
|---|---|---|
| `HYDRA_ACP_DAEMON_URL` | `http://127.0.0.1:8765` | Daemon HTTP endpoint (injected by hydra) |
| `HYDRA_ACP_TOKEN` | *(required)* | Daemon auth token (injected by hydra) |
| `HYDRA_ACP_WS_URL` | derived | Override WS endpoint |
| `HYDRA_ACP_BUDGETER_CONFIG` | `~/.hydra-acp/budgeter.config.js` | Rule module path |
| `HYDRA_ACP_BUDGETER_SOFT` | `5` | Soft limit (warning threshold) in `HYDRA_ACP_BUDGETER_CURRENCY` |
| `HYDRA_ACP_BUDGETER_HARD` | `10` | Hard limit (rejection threshold). Must be ≥ soft. |
| `HYDRA_ACP_BUDGETER_CURRENCY` | `USD` | Currency code used when formatting messages |
| `DEBUG` | `false` | Verbose logging |

## How it works

- Connects via WebSocket to `/acp`, calls `initialize`, then `transformer/initialize` declaring the intercepts:
  - `response:session/update`   — observe `usage_update` to track cost
  - `request:session/prompt`    — reject when over hard limit
  - `lifecycle:session.opened`  — warn brand-new sessions that are already over budget
  - `lifecycle:session.closed`  — drop per-session cost state
- For every `transformer/message` the daemon dispatches, the budgeter responds with `{ action: "continue" }` (observe-only on response side, allow on request side when under budget) or `{ action: "stop", payload: { stopReason: "refusal", _meta: ... } }` (when over hard limit).
- Warnings are emitted via `hydra-acp/emit_message` with `route: "chain"` and `method: "session/update"` so they flow back through the daemon's broadcast machinery and reach every attached client.
- All cost state is in-memory; restart the transformer to reset.

For a working example of the transformer protocol the budgeter speaks, see [`hydra-acp/cli/examples/transformer-observe.mjs`](https://github.com/smagnuso/hydra-acp/blob/main/cli/examples/transformer-observe.mjs).
