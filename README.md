# unified-peers-mcp

Cross-runtime peer messaging. One broker, one CLI, one runtime registry — shared by every agent runtime that wants to participate.

What lives here:

- The **broker daemon** (`broker.ts`) — singleton on `localhost:7900` + SQLite at `~/.peers.db`
- The **CLI** (`cli.ts`) — diagnose / status / send / clean-orphans
- The **runtime registry** (`shared/runtimes.ts`) — closed enum + per-runtime instant-delivery handler registry. **The only file you edit to add a new runtime.**
- The **claude runtime's MCP server** (`runtimes/claude/server.ts`) — small enough to live here

What lives elsewhere:

- The **opencode runtime's MCP server + in-app helper plugin** lives in [`opencode-peers-mcp`](../opencode-peers-mcp), because the helper plugin is real opencode-specific code that hooks into opencode's plugin system.

## What it is

```
                  ┌─────────────────────────────────────────────┐
                  │   unified-peers-mcp broker (port 7900)          │
                  │   ──────────────────────────                │
                  │   • SQLite at ~/.peers.db                   │
                  │   • Tracks every peer + its runtime         │
                  │   • Routes messages between them            │
                  │   • Per-runtime instant-delivery handlers   │
                  └─────────────────────────────────────────────┘
                                       ▲
                          HTTP localhost:7900
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
       opencode peers          Claude Code peers          future runtime
```

The broker doesn't care who's connected — peers just register themselves with a `runtime` tag (`"opencode"`, `"claude"`, …) and the broker handles tracking, scoping, polling, and dispatch generically.

## Adding a new runtime

Edit one file: `shared/runtimes.ts`.

1. Add the runtime name to the `RUNTIMES` tuple:
   ```ts
   export const RUNTIMES = ["opencode", "claude", "newcli"] as const;
   ```
2. *(Optional)* If your runtime supports broker-initiated push, register an instant-delivery handler:
   ```ts
   registerInstantDelivery("newcli", async (peer, fromId, text, ctx) => {
     // call newcli's API to deliver the text
     return { ok: true, latency_ms: 12 };
   });
   ```
   If you skip this, your runtime's MCP server can still receive messages by polling the broker (which is what `claude` does today).

3. Ship a thin MCP server for that runtime that calls `POST /register` with `runtime: "newcli"`.

That's it. List, scope filtering, diagnostics, and the per-peer message log all light up automatically.

## Running

```sh
bun broker.ts                # start the daemon (auto-launched by MCP servers)
bun cli.ts diagnose          # health check across all runtimes
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message
bun cli.ts kill-broker       # stop the daemon
```

## Wiring up Claude Code

Register the claude runtime's MCP server with Claude Code:

```sh
claude mcp add --scope user --transport stdio claude-peers -- \
  bun /Users/<you>/Documents/code/unified-peers-mcp/runtimes/claude/server.ts
```

Then run Claude Code with the channel:

```sh
claude --dangerously-load-development-channels server:claude-peers
```

The broker auto-launches on first session.

## Wiring up opencode

See [`opencode-peers-mcp`](../opencode-peers-mcp) for opencode's MCP server and the in-app helper plugin.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PEERS_PORT` | `7900` | Falls back to legacy `OPENCODE_PEERS_PORT` / `CLAUDE_PEERS_PORT` for back-compat |
| `PEERS_DB` | `~/.peers.db` | Falls back to legacy `OPENCODE_PEERS_DB` / `CLAUDE_PEERS_DB` |

## HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/diagnose` | Full peer + delivery state |
| GET | `/runtimes` | The closed enum of supported runtimes |
| POST | `/register` | Register a peer (must include valid `runtime`) |
| POST | `/register-plugin` | Out-of-band registration of a runtime-specific helper port |
| POST | `/heartbeat` | Update `last_seen` |
| POST | `/set-summary` | Update peer's 1-2 sentence summary |
| POST | `/list-peers` | List peers (with scope and optional `runtime` filter) |
| POST | `/send-message` | Route a message |
| POST | `/poll-messages` | Pull undelivered messages for a peer |
| POST | `/unregister` | Remove a peer |

## Bun

Uses Bun: `bun.serve()`, `bun:sqlite`, `Bun.file`, `Bun.Glob`. Don't replace these with Node equivalents.
