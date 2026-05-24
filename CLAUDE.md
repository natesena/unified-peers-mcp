# unified-peers-mcp

Cross-runtime peer messaging broker. Owns one localhost daemon + one CLI shared by every runtime that wants to participate (opencode, claude, future).

## Architecture

- `broker.ts` — singleton HTTP daemon on `localhost:7900` + SQLite at `~/.peers.db`. Auto-launched by MCP servers when they start.
- `cli.ts` — diagnose / status / peers / send / clean-orphans / kill-broker.
- `shared/types.ts` — canonical Peer, Message, request/response types. Includes `PeerStatus` and `TaskState` enums.
- `shared/status.ts` — pure helpers around `status`/`team`/`role`/`skills`: enum validators, skills JSON parse/serialize. Co-located unit tests in `status.test.ts`.
- `shared/team-color.ts` — deterministic team → hex color hash (djb2 → 12-color palette). Used by the broker to tint Ghostty backgrounds per team. Pure; co-located unit tests in `team-color.test.ts`.
- `shared/runtimes.ts` — **the extensibility surface**. Closed `RUNTIMES` enum + instant-delivery handler registry. Add a new runtime here.
- `shared/summarize.ts` — auto-summary helper using gpt-5.4-nano (used by `runtimes/claude/server.ts`).
- `runtimes/claude/server.ts` — the claude runtime's MCP server. Polls broker every 1s, pushes via `mcp.notification("notifications/claude/channel", …)`. Lives here because it's small and has no runtime-specific helper code.

## Where the per-runtime delivery handlers live

In `shared/runtimes.ts`. Each handler runs in the broker process when a message is sent to a peer of that runtime:

- `opencode` — POSTs to the in-app helper plugin's HTTP endpoint (`/message`). Helper lives in `~/.config/opencode/plugins/opencode-peers.ts` (managed by `opencode-peers-mcp`). The opencode runtime's MCP server (in `opencode-peers-mcp`) ALSO polls `/poll-messages` every ~1s and surfaces results via the `check_messages` tool.
- `claude` — *no instant handler*; relies on the receiver's MCP server polling the broker every ~1s and pushing via `mcp.notification("notifications/claude/channel", …)`.

### opencode dual-path delivery (upm-uab)

The opencode handler returning HTTP 200 only confirms the plugin received the message — it does NOT confirm the LLM saw it. The plugin calls `client.tui.appendPrompt` + `submitPrompt`, which fire opencode `Bus` events that are dropped silently when the session is mid-generation (TUI input disabled).

To prevent silent message loss in that window, `broker.ts:deliverToOne` keeps every opencode message on the poll queue (`delivered=0`) **even when the instant POST succeeds**. The poll handler marks `delivered=1` on first drain, so this does NOT cause re-delivery. Net effect: an idle recipient may see the same message twice (once via TUI, once via `check_messages`); a busy recipient gets the message reliably via the poll path within ~1s. The `check_messages` tool description tells the LLM to dedupe by sender + text.

If you add a runtime whose MCP server pushes synchronously and reliably (like `claude` does via `mcp.notification`), use the default `delivered=1` branch — the dual-path treatment is opencode-specific because of the TUI bus drop. Test coverage: `tests/dual-path-delivery.test.ts`.

## Sibling repo

- [`opencode-peers-mcp`](../opencode-peers-mcp) — opencode's MCP server + the in-app helper plugin (which is real opencode-specific code that hooks into opencode's plugin system, hence its own repo).

It auto-launches this broker if no broker is alive on `PEERS_PORT`.

The claude runtime does NOT have a separate repo — its MCP server is small and lives here at `runtimes/claude/server.ts`.

## Bun

Default to using Bun:
- `Bun.serve()` for HTTP, `bun:sqlite` for the DB, `Bun.file` for I/O, `Bun.Glob` for file scanning.
- `bun <file>` instead of `node <file>`. `bun install` instead of npm/yarn/pnpm.
- Bun auto-loads `.env`, no `dotenv` needed.

## Tests

Bun's built-in test runner — `import { test, expect, describe, beforeAll, afterAll } from "bun:test"`. Run `bun test`. No additional test deps.

**Layout:**
- **Integration tests** live in `tests/*.test.ts`. They spawn the real `broker.ts` as a subprocess against a temp SQLite DB and a temp `UPM_TTY_DIR`, drive it via raw `fetch`, and assert behavior end-to-end.
- **Unit tests for pure modules** are co-located: `*.test.ts` next to the source file (e.g. `shared/terminals/format.test.ts` next to `format.ts`). Use this for pure functions where a subprocess broker would be overkill.

**Shared harness:** `tests/harness.ts` exports `spawnTestBroker`, `makeFakeTty`, `waitForBytes`, `postJson`, `registerPeer`. New integration tests should import these — don't reinvent the subprocess + temp-DB scaffolding.

**Test seams:**
- `UPM_TTY_DIR` (default `/dev`) — overridable directory for terminal-title writes. Tests point this at a temp dir so writeTitle's I/O lands in regular files we can read.
- `PEERS_PORT` and `PEERS_DB` — already overridable; harness uses random high ports and tmp DB paths.

**What we test:**
- Pure functions exhaustively (sanitization, format, registry lookup, byte-frame builders).
- HTTP integration end-to-end via the harness for anything with side effects (registration, summary updates, title writes).
- We don't try to render in a real terminal — that's the human-verification step on PRs.

**Tests must accompany the feature.** Don't merge a feature without its tests. Don't merge a PR without README/CLAUDE.md/AGENTS.md updates covering user-visible changes.

## AgentCard fields on peers (status / team / role / skills)

Each peer row carries a typed `status` (enum: `available | busy | away`, defaults to `available`) plus three nullable free-text fields: `team`, `role`, `skills` (JSON-encoded TEXT column, exposed to callers as `string[] | null`).

- **Set via `/set-status`** (or the `set_status` MCP tool). Partial update — omitted fields unchanged; explicit `null` clears nullable ones; `status` is NOT NULL so passing `status: null` is a 400.
- **Filter via `/list-peers`** with optional `status`, `team`, `skill` (exact match on each). Skill match is exact-string against the parsed array (no JSON substring false positives like `rust` vs `rust-analyzer`).
- **Validation** lives in `shared/status.ts` (`isPeerStatus`, `isValidSkillsInput`); used by both `handleRegister` and `handleSetStatus` in the broker, and by both runtime MCP servers via the same enum constants exported from `shared/types.ts` (`PEER_STATUSES`, `TASK_STATES`).

Why not auto-derive status from message activity / add a claim-release lock / forbid invalid state transitions? Localhost humans-in-the-loop don't need correctness primitives. The advisory typed-enum + free-text shape is what production multi-agent frameworks (A2A, AutoGen, CrewAI, LangGraph) settled on for the same reason. Revisit if real contention shows up.

## Task lifecycle on messages

Any message can be tagged with `task_id` at send time. When set, the persisted message row starts at `task_state='working'`. The recipient transitions it via `/set-task-state` (or the `set_task_state` MCP tool). Senders/strangers get HTTP 403; unknown task → 404; bad state → 400. State transitions are not enforced in v1.

`send_message_multi` with a shared `task_id` writes one row per recipient — each recipient's `task_state` is independent.

## Per-team background tint (Ghostty)

When a peer's `team` is set, the broker tints its Ghostty pane's background with a deterministic team-color (OSC 11). Same team → same color across peers and across broker restarts. Visible in Mission Control thumbnails, so users can see team membership at a glance.

- Color comes from `colorForTeam(team)` in `shared/team-color.ts` — djb2 hash → 12-color palette. Pure function; deterministic.
- Only Ghostty receives the bytes; generic adapter no-ops `setBackground` (so non-Ghostty terminals are unaffected).
- Emitted from `handleRegister`, `handleSetStatus` (when `team` is in the body), `handleRetitle`, and reset in `handleClearTitle` — same wire path as title writes. Only emitted when the peer actually has a team (no-team peers don't pay the byte cost and don't get unnecessary OSC 111 resets — which matters in tests where the fake-TTY file mocks would clobber title bytes).
- Kill-switch: `PEERS_VISUAL_DISABLED=1` suppresses all `setBackground` calls. Titles still update.

The adapter contract (`shared/terminals/types.ts`) was extended with `setBackground(tty, color | null)` and `clearTitle` still resets only the title. If you add a specialized adapter for another terminal that supports OSC 11 cleanly, implement `setBackground` there; otherwise inherit the generic no-op.

## When adding a runtime

Read `README.md`'s "Adding a new runtime" section. Three steps, one file.

## Don't

- Don't import from individual client repos (e.g. opencode-peers-mcp). The dependency direction is **clients → unified-peers-mcp**, never the reverse. (The claude runtime has no separate client repo today; its MCP server lives at `runtimes/claude/server.ts` here.)
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
