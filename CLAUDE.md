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


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
