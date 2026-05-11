# unified-peers-mcp

Cross-runtime peer messaging. One broker, one CLI, one runtime registry — shared by every agent runtime that wants to participate.

What lives here:

- The **broker daemon** (`broker.ts`) — singleton on `localhost:7900` + SQLite at `~/.peers.db`
- The **CLI** (`cli.ts`) — diagnose / status / send / clean-orphans
- The **runtime registry** (`shared/runtimes.ts`) — closed enum + per-runtime instant-delivery handler registry. **The only file you edit to add a new runtime.**
- The **claude runtime's MCP server** (`runtimes/claude/server.ts`)
- The **opencode runtime's MCP server** (`runtimes/opencode/server.ts`)

What also lives here:

- The **opencode in-app helper plugin** (`plugins/opencode-peers.ts`) — hooks into opencode's plugin system for instant TUI delivery. Copy or symlink to `~/.config/opencode/plugins/`.

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
bun broker.ts                                        # start the daemon (auto-launched by MCP servers)
bun cli.ts diagnose                                  # health check across all runtimes
bun cli.ts peers                                     # list peers
bun cli.ts send <id> <msg>                           # send a message
bun cli.ts retitle <id>                              # re-assert a peer's terminal window title
bun cli.ts reset-context <compact|clear> <id> [id …] # compact or clear a peer's LLM context
bun cli.ts kill-broker                               # stop the daemon
```

## Wiring up Claude Code

Register the claude runtime's MCP server with Claude Code:

```sh
claude mcp add --scope user --transport stdio unified-peers -- \
  bun /Users/<you>/Documents/code/unified-peers-mcp/runtimes/claude/server.ts
```

Then run Claude Code with the channel:

```sh
claude --dangerously-load-development-channels server:unified-peers
```

The broker auto-launches on first session.

> **The name `unified-peers` must match in both commands.** Claude Code matches `--dangerously-load-development-channels server:NAME` against the entry name you passed to `claude mcp add`. If they disagree, every channel notification is silently dropped and the MCP server's stderr log will say `Channel notifications skipped: server X not in --channels list for this session`. Tools (`send_message`, `list_peers`, etc.) still work, but inbound messages never surface as `<channel source="unified-peers" ...>` blocks.
>
> **Migrating from `claude-peers`?** If you previously ran `claude mcp add ... claude-peers ...`, either rename the entry (`claude mcp remove claude-peers && claude mcp add ... unified-peers ...`) or keep launching with `server:claude-peers` — the flag must equal whatever your entry is called.

## Wiring up opencode

Register the opencode runtime's MCP server in your opencode config (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "mcp": {
    "unified-peers": {
      "type": "local",
      "command": ["bun", "/Users/<you>/Documents/code/unified-peers-mcp/runtimes/opencode/server.ts"],
      "enabled": true
    }
  }
}
```

For instant TUI delivery, copy the in-app helper plugin to opencode's plugin directory:

```sh
mkdir -p ~/.config/opencode/plugins
cp plugins/opencode-peers.ts ~/.config/opencode/plugins/
```

Without it, messages still arrive via polling (~1s delay).

## Delivery semantics

For each `runtime` value the broker has a different delivery contract. The relevant detail when reasoning about message loss:

| Runtime | Instant path | Poll fallback | Why |
|---|---|---|---|
| `claude` | (none — no broker-initiated push) | always on | Claude Code only listens to its own MCP server's stdio. The MCP server polls every ~1s and pushes via `mcp.notification`. |
| `opencode` | broker POSTs `/message` to the in-app plugin's HTTP port; plugin appends + submits to the TUI | **always on** | The plugin's `appendPrompt` + `submitPrompt` calls fire opencode `Bus` events. Those events are dropped silently when the session is mid-generation (TUI input disabled). The poll path is the only reliable in-context delivery channel during that window. |

For opencode specifically, the broker keeps every message on the poll queue (`delivered=0`) even when the instant POST returns 200, so the receiver's MCP server picks it up via `/poll-messages` within ~1s and surfaces it to the LLM via the `check_messages` tool. The poll handler marks the message delivered on first drain, so this does not cause re-delivery.

A consequence is that an idle opencode recipient may see the same peer message twice — once as a TUI user prompt (via instant) and once via `check_messages` (via poll). The `check_messages` tool description tells the LLM to dedupe by sender + text. This is intentional: the duplicate cost is a one-line "already received" reply; the cost of dropping silently during mid-generation is a hung conversation.

If you add a new runtime whose own MCP server already pushes notifications synchronously, register it without an instant handler and the broker will route through the poll path generically. Set the `delivered` flag check in `broker.ts:deliverToOne` to mirror this if you instead need the same dual-path treatment opencode gets.

## Remote context reset (`reset_context`)

Peers can ask each other — or themselves — to compact or clear their LLM context. The `reset_context` MCP tool is exposed by both runtimes' MCP servers, with two semantically distinct modes:

| Mode | Effect | SDK call (opencode) |
|---|---|---|
| `compact` | Summarize prior turns in place. Lossy compression; references still resolve through the summary. | `client.tui.executeCommand({ command: "session.compact" })` |
| `clear` | Discard the existing context entirely (start a new session). Nothing carries over. | `client.tui.executeCommand({ command: "session.new" })` |

Two patterns:

- **Orchestrator → delegate:** `reset_context({ to_ids: ["abc123"], mode: "compact" })` — caller A frees delegate B's context once delegation is done.
- **Delegate self-reset:** `reset_context({ mode: "clear" })` — omit `to_ids` (or pass `[]`) to target yourself when the next task is unrelated to anything in the current session.

`to_ids` is a fan-out array shaped like `send_message`'s — pass a single ID or several, each is dispatched in parallel.

**Constraint: opencode targets only.** Claude peers have no SDK affordance to run slash commands against their host TUI, so a claude target returns a per-slot `reset unsupported for runtime=claude` error rather than silently no-oping. The batch keeps going for other targets; only the failing slot reports `ok: false`.

CLI form (no peer identity, so at least one id is required):

```sh
bun cli.ts reset-context compact <opencode-peer-id>
bun cli.ts reset-context clear <id1> <id2>          # fan-out
```

## Terminal title integration

Each peer's host terminal window/tab title is auto-updated to reflect the peer's identity and current work — so a glance at the dock or window switcher tells you which agent is which:

```
[k3p9q2nm] working on the broker dispatch refactor
```

Format: `[<peer-id>] <summary>`. The peer ID always comes first so you can read it off the dock and pass it directly to `send_message` without a `list_peers` round-trip.

The broker writes [OSC 2](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Operating-System-Commands) escape sequences directly to the peer's TTY device (`/dev/<tty>`) on registration and on every `set_summary`. Adapter selection lives in `shared/terminals/index.ts` and is keyed off the agent process's `TERM_PROGRAM` env var:

| Terminal | Adapter | Notes |
|---|---|---|
| Ghostty | `ghostty` | Standard OSC 2 today; reserved as the seam for future Ghostty-specific extensions (OSC 9 notifications, AppleScript, the deferred flash tool). |
| iTerm 2, Terminal.app, WezTerm, kitty, alacritty, … | `generic` | Standard OSC 2. Works on every modern terminal emulator. |
| tmux / screen | `generic` | OSC sequences pass through to the outer terminal when `set-titles on` (tmux) is enabled. |
| Unknown / null `TERM_PROGRAM` | `generic` | Always-safe fallback. |

To add a specialized adapter for a new terminal, see the file-header comment in `shared/terminals/types.ts`.

Sanitization: summaries are stripped of C0 control bytes and DEL before they reach an adapter, so a malicious summary can't smuggle in a foreign escape sequence. Titles are also truncated to 120 chars total.

Caveats:
- If the agent process is hard-killed (`kill -9`), the title may stay stale until the shell's next prompt callback reclaims it. Graceful exit clears the title.
- Some shell prompts overwrite the title on every prompt redraw. While the agent is in the foreground (which is the normal case), the agent's title sticks.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PEERS_PORT` | `7900` | Falls back to legacy `OPENCODE_PEERS_PORT` / `CLAUDE_PEERS_PORT` for back-compat |
| `PEERS_DB` | `~/.peers.db` | Falls back to legacy `OPENCODE_PEERS_DB` / `CLAUDE_PEERS_DB` |
| `UPM_TTY_DIR` | `/dev` | Directory the broker writes terminal-title escape sequences into. Override for tests or unusual sandbox setups where TTY devices live elsewhere. |

## HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/diagnose` | Full peer + delivery state |
| GET | `/runtimes` | The closed enum of supported runtimes |
| POST | `/register` | Register a peer (must include valid `runtime`) |
| POST | `/register-plugin` | Out-of-band registration of a runtime-specific helper port |
| POST | `/heartbeat` | Update `last_seen` |
| POST | `/set-summary` | Update peer's 1-2 sentence summary (also rewrites the host terminal's window title) |
| POST | `/clear-title` | Reset the peer's terminal window title (called by MCP servers on graceful shutdown) |
| POST | `/retitle` | Re-assert the peer's current title (recovery for clobbered titles; 404 on unknown peer) |
| POST | `/list-peers` | List peers (with scope and optional `runtime` filter) |
| POST | `/send-message` | Route a message |
| POST | `/send-message-multi` | Route a message to multiple peers in one call |
| POST | `/reset-context` | Compact or clear the LLM context of one or more peers (opencode targets only) |
| POST | `/poll-messages` | Pull undelivered messages for a peer |
| POST | `/unregister` | Remove a peer |

## Bun

Uses Bun: `bun.serve()`, `bun:sqlite`, `Bun.file`, `Bun.Glob`. Don't replace these with Node equivalents.
