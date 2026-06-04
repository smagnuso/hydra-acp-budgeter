# hydra-acp-budgeter

Cost-budget transformer extension for [hydra-acp](https://github.com/smagnuso/hydra-acp). Watches every session's `usage_update` events, warns attached clients when total spend crosses a soft limit, and rejects further prompts once it crosses a hard limit — with a human-readable reason returned to the client.

Runs as a daemon-managed *transformer* (not a client extension): it connects once, declares its intercepts via `transformer/initialize`, and sits inside the daemon's message pipeline for every live session.

## Install

From npm (recommended once published):

```sh
npm install -g @hydra-acp/cli @hydra-acp/budgeter
```

This drops the `hydra-acp` (and `hydra`) CLI plus a `hydra-acp-budgeter` binary on your PATH. The CLI dispatches `hydra-acp <name>` to any `hydra-acp-<name>` binary on PATH, so the budgeter is also reachable as `hydra-acp budgeter`.

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

That registers the transformer but does **not** wire it into sessions yet. You also need to add it to `defaultTransformers` in `~/.hydra-acp/config.json` — there's no CLI command for this, edit the file directly:

```json
{
  "transformers": {
    "hydra-acp-budgeter": {
      "command": ["node"],
      "args": ["/home/you/dev/hydra-acp-budgeter/dist/index.js"]
    }
  },
  "defaultTransformers": ["hydra-acp-budgeter"]
}
```

Without `defaultTransformers`, the transformer process runs but no sessions route through it.

On `hydra-acp daemon start`, hydra spawns hydra-acp-budgeter with these env
vars set: `HYDRA_ACP_DAEMON_URL`, `HYDRA_ACP_TOKEN`, `HYDRA_ACP_WS_URL`,
`HYDRA_ACP_HOME`, `HYDRA_ACP_TRANSFORMER_NAME`. Stdout/stderr land in
`~/.hydra-acp/transformers/hydra-acp-budgeter.log`. Lifecycle is managed with
`hydra-acp transformers start|stop|restart hydra-acp-budgeter` and
`hydra-acp transformers log hydra-acp-budgeter -f` to tail.

## Behavior

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

### State and reset

The per-session cost map is persisted to `~/.hydra-acp/budgeter-cost.json`, atomically rewritten on every `usage_update`. The running budgeter reads it on startup and `fs.watch`es it for external mutations — so daemon restarts preserve the running total, and a reset from elsewhere is picked up live without restarting.

Spend is sticky across `session.closed`: a closed session's cost stays in the total until you reset.

To zero the budget:

```sh
hydra-acp budgeter reset
```

That deletes the state file. If the transformer is running, its watcher adopts the deletion and the in-memory total drops to zero on the next tick (≤50ms). If it isn't running, the file is just gone and the next start begins at zero.

## Configuration

Create `~/.hydra-acp/budgeter.conf` (override path via `HYDRA_ACP_BUDGETER_CONF`):

```
# ~/.hydra-acp/budgeter.conf
SOFT=5
HARD=10
CURRENCY=USD
DEBUG=false
```

The file is optional — all keys have defaults and the transformer works without it. Environment variables always win over file values, so you can temporarily override a limit without editing the file.

| Key / env var | Default | Purpose |
|---|---|---|
| `SOFT` / `HYDRA_ACP_BUDGETER_SOFT` | `5` | Soft limit (warning threshold) |
| `HARD` / `HYDRA_ACP_BUDGETER_HARD` | `10` | Hard limit (rejection threshold). Must be ≥ soft. |
| `CURRENCY` / `HYDRA_ACP_BUDGETER_CURRENCY` | `USD` | ISO-3 currency code for formatted messages |
| `DEBUG` | `false` | Verbose logging |
| `HYDRA_ACP_DAEMON_URL` | `http://127.0.0.1:8765` | Daemon HTTP endpoint (injected by hydra) |
| `HYDRA_ACP_TOKEN` | *(required)* | Daemon auth token (injected by hydra) |
| `HYDRA_ACP_WS_URL` | derived | Override WS endpoint |

## How it works

- Connects via WebSocket to `/acp`, calls `initialize`, then `transformer/initialize` declaring the intercepts:
  - `response:session/update`   — observe `usage_update` to track cost
  - `request:session/prompt`    — reject when over hard limit
  - `lifecycle:session.opened`  — warn brand-new sessions that are already over budget
  - `lifecycle:session.closed`  — fires session_closed rule event (cost stays sticky)
- For every `transformer/message` the daemon dispatches, the budgeter responds with `{ action: "continue" }` (observe-only on response side, allow on request side when under budget) or `{ action: "stop", payload: { stopReason: "refusal", _meta: ... } }` (when over hard limit).
- Warnings are emitted via `hydra-acp/message/emit` with `route: "chain"` and `method: "session/update"` so they flow back through the daemon's broadcast machinery and reach every attached client.
- All cost state is in-memory; restart the transformer to reset.

For a working example of the transformer protocol the budgeter speaks, see [`hydra-acp/cli/examples/transformer-observe.mjs`](https://github.com/smagnuso/hydra-acp/blob/main/cli/examples/transformer-observe.mjs).
