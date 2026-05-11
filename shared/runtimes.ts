/**
 * Runtime registry — the single extensibility surface.
 *
 * To add support for a new agent runtime:
 *   1. Add its name to RUNTIMES below.
 *   2. (Optional) Register an instant-delivery handler so the broker can push
 *      directly to a peer of that runtime instead of waiting for the peer's
 *      MCP server to poll. If your runtime's MCP server already polls every
 *      second and pushes via its own native mechanism (e.g. mcp.notification),
 *      you don't need an instant handler — polling will deliver in ~1s.
 *
 * Everything else (registration, listing, polling, diagnostics) works
 * generically for any runtime registered here.
 */

import type { Peer, ResetMode } from "./types.ts";

export const RUNTIMES = ["opencode", "claude"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export function isValidRuntime(s: string): s is Runtime {
  return (RUNTIMES as readonly string[]).includes(s);
}

export interface InstantDeliveryResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
  /** Set to true if the recipient's runtime-specific connection info is stale and should be cleared in the DB (so future sends skip the instant attempt). */
  clear_runtime_state?: boolean;
}

export type InstantDeliveryHandler = (
  recipient: Peer,
  fromId: string,
  text: string,
  context: { senderSummary: string; senderCwd: string; senderGitRoot: string | null }
) => Promise<InstantDeliveryResult>;

const handlers = new Map<Runtime, InstantDeliveryHandler>();

export function registerInstantDelivery(runtime: Runtime, fn: InstantDeliveryHandler): void {
  handlers.set(runtime, fn);
}

export function getInstantDelivery(runtime: Runtime): InstantDeliveryHandler | undefined {
  return handlers.get(runtime);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset registry (parallel to InstantDelivery)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResetHandlerResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

/**
 * Reset handler for a runtime — compacts or clears the recipient's LLM context.
 * Runs in the broker process. If a runtime has no handler registered, the
 * broker returns a per-target "reset unsupported" error rather than silently
 * no-oping (so callers see the failure explicitly).
 */
export type ResetHandler = (peer: Peer, mode: ResetMode) => Promise<ResetHandlerResult>;

const resetHandlers = new Map<Runtime, ResetHandler>();

export function registerReset(runtime: Runtime, fn: ResetHandler): void {
  resetHandlers.set(runtime, fn);
}

export function getReset(runtime: Runtime): ResetHandler | undefined {
  return resetHandlers.get(runtime);
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in handlers
// ─────────────────────────────────────────────────────────────────────────────

const OPENCODE_HELPER_TIMEOUT_MS = 2000;

/**
 * opencode runtime: POST to the in-app helper's HTTP endpoint.
 * The helper is a plugin loaded inside opencode (~/.config/opencode/plugins/opencode-peers.ts)
 * that exposes `POST /message` and pushes the text into the user's TUI input.
 */
registerInstantDelivery("opencode", async (peer, fromId, text, ctx) => {
  if (!peer.plugin_port) {
    return { ok: false, latency_ms: 0, error: "no helper port registered" };
  }
  const start = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${peer.plugin_port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_id: fromId,
        text,
        from_summary: ctx.senderSummary,
        from_cwd: ctx.senderCwd,
        from_git_root: ctx.senderGitRoot,
      }),
      signal: AbortSignal.timeout(OPENCODE_HELPER_TIMEOUT_MS),
    });
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      return { ok: false, latency_ms, error: `helper HTTP ${res.status}`, clear_runtime_state: true };
    }
    return { ok: true, latency_ms };
  } catch (e) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
      clear_runtime_state: true,
    };
  }
});

// claude runtime: no instant handler.
//   The unified-peers MCP server polls the broker every 1s and pushes incoming
//   messages into Claude Code via mcp.notification("notifications/claude/channel").
//   No broker-initiated push is needed or possible (Claude Code only listens
//   to its own MCP server's stdio, not random localhost HTTP).

// ─────────────────────────────────────────────────────────────────────────────
// Reset handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * opencode runtime: POST to the in-app helper's /reset endpoint, which runs
 * the corresponding TUI slash command via the opencode SDK:
 *   - "compact" → client.tui.executeCommand({ command: "session.compact" })
 *   - "clear"   → client.tui.executeCommand({ command: "session.new" })
 *
 * (opencode has no `session.clear` SDK command; `session.new` is the
 * affordance that achieves a fully-cleared context — see plan.)
 */
registerReset("opencode", async (peer, mode) => {
  if (!peer.plugin_port) {
    return { ok: false, latency_ms: 0, error: "no helper port registered" };
  }
  const start = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${peer.plugin_port}/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(OPENCODE_HELPER_TIMEOUT_MS),
    });
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      return { ok: false, latency_ms, error: `helper HTTP ${res.status}` };
    }
    return { ok: true, latency_ms };
  } catch (e) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});

// claude runtime: no reset handler.
//   The claude MCP server runs inside Claude Code as a stdio server; it has
//   no way to invoke slash commands against its host TUI. A reset_context
//   call targeting a claude peer returns "reset unsupported for runtime=claude"
//   so the caller sees the failure rather than a silent no-op.
