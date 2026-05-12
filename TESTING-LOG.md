# `feat/reset-context-tool` — testing log

> **Status: DO NOT MERGE.** This branch ships a working MCP tool surface,
> broker route, runtime registry, and plugin endpoint — but the underlying
> opencode SDK call it ultimately makes (`tui.executeCommand({ command:
> "session.compact" })`) returns `true` without producing any visible effect
> in the opencode TUI. As a feature for "actually compact a peer's LLM
> context", this branch is a no-op in practice. Kept on the remote as a
> reference and as scaffolding for a future v2-API-based rewrite. — 2026-05-11

## What ships on this branch

Plumbing additions (all verified working in isolation and against real peers):

| Layer | Verified live |
|---|---|
| Type defs (`ResetMode`, `ResetContextRequest/Result/Response`) | ✅ |
| Runtime registry (`registerReset`/`getReset`, parallel to `InstantDelivery`) | ✅ |
| Broker `POST /reset-context` route, parallel fan-out | ✅ (latency 1–8ms against real opencode peer) |
| Per-target results array; claude → per-slot "unsupported" | ✅ (9 integration tests cover this) |
| Plugin `POST /reset` endpoint | ✅ (the running opencode peer received and processed it) |
| `reset_context` MCP tool registered in opencode runtime | ✅ (a real opencode peer called the tool back at the sender in response to a `/compact` chat message — "the peer is asking me to compact, I should call reset_context") |
| `reset_context` MCP tool registered in claude runtime | ✅ (tools/list includes it after restart) |
| 67 tests pass, zero new TS errors | ✅ |

## What does NOT work

The plugin's `/reset` handler calls
`client.tui.executeCommand({ body: { command: "session.compact" } })` or
`"session.new"`. The SDK happily returns `200: true` for both, but neither
actually triggers visible TUI behavior in the opencode build we tested
against (opencode v1.14.48 client / 1.14.41-era server).

Things we tried:

1. **`tui.executeCommand` with `session.compact`** — `sdk_return: true`, but
   no UI change; conversation count from `session.list()` is identical
   before/after.
2. **`tui.executeCommand` with `session.new`** — same: `true` returned, no
   new session appears in `session.list()`, TUI doesn't switch views.
3. **`clearPrompt + appendPrompt("/compact") + submitPrompt`** (simulating
   the user typing `/compact` and hitting enter) — no visible effect either,
   confirming that opencode in this build doesn't expose `/compact` as a
   user-typeable slash command. The text gets submitted as a regular chat
   message; the model reads it and tries to respond, sometimes by invoking
   our own `reset_context` MCP tool right back at us.

## Why we ended up here

`session.compact` and `session.new` appear in the SDK's TUI command enum,
so we built around the assumption that `executeCommand` with those names
would do the visible thing. In practice they appear to be the *event names*
for whatever the TUI fires when a keybinding is pressed in a focused
session view — not a remote-control API that produces the effect on demand.

## What the correct fix probably is

Replace the plugin's TUI bus call with the **v2 API** which operates
directly on session data:

- compact: `client.v2.session.compact({ sessionID })` — bypasses the TUI
  entirely, just does the data-side compaction.
- clear: `client.session.create()` to mint a new session, then
  (somehow) tell the TUI to switch to it — this part is the unsolved bit.

For compact, we'd need to know the *currently active* session ID. The
plugin sees all sessions via `session.list()` but doesn't have an obvious
"which session is the user looking at right now" affordance. Worth a
deeper look at opencode internals or a feature request to expose
"active session id" on the plugin client.

## Testing trail (chronological)

1. Wrote 9 integration tests (`tests/reset-context.test.ts`) with a mock
   plugin that records the wire payload. **All pass.** These verified the
   broker logic, runtime registry, multi-target fan-out, mixed-runtime
   error semantics, unknown-id handling, and missing-plugin-port handling.
2. Spun up a side broker on `:17999` (same `~/.peers.db`) to avoid
   disrupting the long-running broker on `:7900`. Confirmed it saw all
   real peers.
3. Synced the new plugin file to `~/.config/opencode/plugins/` and asked
   the user to restart one opencode terminal. New peer registered, plugin
   `/reset` endpoint reachable.
4. Fired `POST /reset-context { ids: [peer], mode: "compact" }` via the
   side broker. Wire response: `ok: true, latency_ms: 5–8`. Plugin's
   `/diagnose` showed `last_reset_at` updating. **No visible TUI effect.**
5. Tried `mode: "clear"` (runs `session.new`). Same: `sdk_return: true`,
   `session.list()` count unchanged at 100 before and after.
6. Pivoted plugin to `clearPrompt + appendPrompt("/compact") + submitPrompt`,
   another restart, fired again. Still no visible effect — opencode
   doesn't recognize `/compact` as a slash command in this build.
7. Confirmed that the *one* opencode-side thing that does work via the
   plugin is `appendPrompt({ text }) + submitPrompt()` (the existing
   `/message` path used for peer chat) — but only because opencode treats
   that as user input, which is fine for messages but doesn't bypass into
   slash command behavior.

## Reset / handoff

- `~/.config/opencode/plugins/opencode-peers.ts` restored to the `main`
  version (SHA `4ae3c7b…`).
- Side broker on `:17999` stopped.
- Local checkout moved back to `main`.
- Branch left on origin as scaffolding; **do not merge as-is**.
- bd issues:
  - `upm-92e` (the feature) — was closed when commit landed; reopen and
    annotate with this finding if you pick this up again.
  - `upm-fhr` (mirror to legacy `opencode-peers-mcp/server.ts`) — close,
    not relevant unless the underlying issue gets a fix.
