/**
 * Title formatting policy for the broker.
 *
 * Produces "[<peer-id>] <summary>" — peer ID first so it's readable from the
 * dock / window-switcher (peer IDs are what other agents pass to send_message,
 * so surfacing them visually saves a list_peers round-trip).
 *
 * Lives outside the adapters because format is broker policy, not a
 * terminal-specific concern. Adapters render bytes; format.ts decides what
 * bytes go in. Sanitization happens here, once, so every adapter receives
 * a string that is safe to embed verbatim in an escape sequence.
 */

import type { Peer } from "../types.ts";

const MAX_TITLE_LEN = 120;

/**
 * Strip control bytes (C0 + DEL) and collapse whitespace.
 *
 * Defense against escape-sequence smuggling: without this, a peer setting
 * a summary like `"\x1b]0;hijacked\x07"` would have its bytes passed
 * verbatim to the terminal, injecting a foreign OSC. We sanitize at format
 * time so by the time bytes reach an adapter, they are guaranteed safe.
 */
function sanitize(s: string): string {
  return s
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the terminal title for a peer.
 *
 * Format: `[<id>] <summary>`. Falls back to `[<id>] <runtime>` when summary
 * is empty (or whitespace-only after sanitization) — this is rare since
 * auto-summary populates it at registration, but it's a clean fallback.
 *
 * Truncates the entire result to MAX_TITLE_LEN chars (including the
 * bracketed prefix) so the title fits comfortably in dock / tab-bar UI.
 *
 * Accepts the minimal field subset rather than a full Peer so tests don't
 * need to construct a complete row.
 */
export function formatTitle(peer: Pick<Peer, "id" | "summary" | "runtime">): string {
  const cleaned = sanitize(peer.summary);
  const body = cleaned.length > 0 ? cleaned : peer.runtime;
  const full = `[${peer.id}] ${body}`;
  return full.length <= MAX_TITLE_LEN ? full : full.slice(0, MAX_TITLE_LEN);
}
