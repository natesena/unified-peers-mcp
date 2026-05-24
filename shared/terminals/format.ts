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
 * Format: `[<emoji> ]working on <summary> [<id>]`
 *
 * Examples (with a team-emoji prefix):
 *   `🟠 working on refactoring auth [k3p9q2nm]`
 *   `working on writing tests [4xb2vw1c]`            ← no team → no emoji
 *   `🟡 idle [m8w7p2qn]`                              ← no summary → "idle"
 *   `idle [n5q9r3sk]`                                 ← neither
 *
 * Why this shape:
 *   - The summary leads (after the emoji) so it reads naturally in the dock /
 *     window-switcher: "working on refactoring auth" is what the user wants
 *     at a glance, not the opaque peer id.
 *   - Id is moved to the end in brackets so it's still pasteable into
 *     send_message without a list_peers round-trip, but no longer dominates.
 *   - Emoji prefix is opt-in (drawn from the team palette) and only present
 *     when the broker has determined the peer is an active team member.
 *
 * Truncates to MAX_TITLE_LEN chars (including emoji and id suffix) so the
 * title fits comfortably in dock / tab-bar UI.
 */
export function formatTitle(
  peer: Pick<Peer, "id" | "summary" | "runtime">,
  opts?: { emojiPrefix?: string | null },
): string {
  const cleaned = sanitize(peer.summary);
  const body = cleaned.length > 0 ? `working on ${cleaned}` : "idle";
  const emoji = opts?.emojiPrefix ? `${opts.emojiPrefix} ` : "";
  const full = `${emoji}${body} [${peer.id}]`;
  return full.length <= MAX_TITLE_LEN ? full : full.slice(0, MAX_TITLE_LEN);
}
