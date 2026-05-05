# unified-peers-mcp

Cross-runtime peer messaging broker. Owns one localhost daemon + one CLI shared by every runtime that wants to participate (opencode, claude, future).

## Architecture

- `broker.ts` — singleton HTTP daemon on `localhost:7900` + SQLite at `~/.peers.db`. Auto-launched by MCP servers when they start.
- `cli.ts` — diagnose / status / peers / send / clean-orphans / kill-broker.
- `shared/types.ts` — canonical Peer, Message, request/response types.
- `shared/runtimes.ts` — **the extensibility surface**. Closed `RUNTIMES` enum + instant-delivery handler registry. Add a new runtime here.
- `shared/summarize.ts` — auto-summary helper using gpt-5.4-nano (used by `runtimes/claude/server.ts`).
- `runtimes/claude/server.ts` — the claude runtime's MCP server. Polls broker every 1s, pushes via `mcp.notification("notifications/claude/channel", …)`. Lives here because it's small and has no runtime-specific helper code.

## Where the per-runtime delivery handlers live

In `shared/runtimes.ts`. Each handler runs in the broker process when a message is sent to a peer of that runtime:

- `opencode` — POSTs to the in-app helper plugin's HTTP endpoint (`/message`). Helper lives in `~/.config/opencode/plugins/opencode-peers.ts` (managed by `opencode-peers-mcp`).
- `claude` — *no instant handler*; relies on the receiver's MCP server polling the broker every ~1s and pushing via `mcp.notification("notifications/claude/channel", …)`.

## Sibling repo

- [`opencode-peers-mcp`](../opencode-peers-mcp) — opencode's MCP server + the in-app helper plugin (which is real opencode-specific code that hooks into opencode's plugin system, hence its own repo).

It auto-launches this broker if no broker is alive on `PEERS_PORT`.

The claude runtime does NOT have a separate repo — its MCP server is small and lives here at `runtimes/claude/server.ts`.

## Bun

Default to using Bun:
- `Bun.serve()` for HTTP, `bun:sqlite` for the DB, `Bun.file` for I/O, `Bun.Glob` for file scanning.
- `bun <file>` instead of `node <file>`. `bun install` instead of npm/yarn/pnpm.
- Bun auto-loads `.env`, no `dotenv` needed.

## When adding a runtime

Read `README.md`'s "Adding a new runtime" section. Three steps, one file.

## Don't

- Don't import from individual client repos (opencode-peers-mcp, claude-peers-mcp). The dependency direction is **clients → unified-peers-mcp**, never the reverse.
- Don't add per-runtime fields to the `peers` table without first considering whether the runtime registry pattern can hold the data instead.
- Don't migrate `~/.opencode-peers.db` automatically. If a user has the old DB, the broker will create `~/.peers.db` fresh; rename is a manual step.
