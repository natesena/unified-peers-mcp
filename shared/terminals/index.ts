/**
 * Terminal adapter registry.
 *
 * Maps a peer's TERM_PROGRAM env value (stored in peers.terminal_program)
 * to its TerminalAdapter. Unknown values fall back to the generic adapter,
 * which uses standard OSC 2 — works on virtually every modern terminal.
 *
 * To add a specialized adapter:
 *   1. Add the new adapter file under shared/terminals/.
 *   2. Add its TERM_PROGRAM key to TERMINAL_PROGRAMS below.
 *   3. Add the import + registry entry in ADAPTERS_BY_TERM_PROGRAM.
 *
 * Common TERM_PROGRAM values worth knowing (open set — terminals can set
 * anything here, but these are the ones you'll actually encounter):
 *   "Ghostty"          — Ghostty (specialized adapter)
 *   "iTerm.app"        — iTerm 2 (uses generic)
 *   "Apple_Terminal"   — Terminal.app (uses generic)
 *   "WezTerm"          — WezTerm (uses generic)
 *   "tmux", "screen"   — multiplexers; OSC pass-through if set-titles is on
 *   "vscode"           — VS Code integrated terminal (uses generic)
 */

import type { TerminalAdapter } from "./types.ts";
import { generic } from "./generic.ts";
import { ghostty } from "./ghostty.ts";

/**
 * Closed enum of TERM_PROGRAM values for which we ship a specialized adapter.
 * Mirrors the RUNTIMES pattern in shared/runtimes.ts:18.
 *
 * Note: this is the *closed* set of adapter keys. Peer.terminal_program (in
 * shared/types.ts) stores the *raw* TERM_PROGRAM string, which is an open set
 * — anything a terminal emulator chooses to set. Don't conflate the two.
 */
export const TERMINAL_PROGRAMS = ["Ghostty"] as const;
export type KnownTerminalProgram = (typeof TERMINAL_PROGRAMS)[number];

const ADAPTERS_BY_TERM_PROGRAM: Record<KnownTerminalProgram, TerminalAdapter> = {
  Ghostty: ghostty,
};

/**
 * Lowercased lookup table for case-insensitive matching. TERM_PROGRAM is
 * conventionally a brand name but real installs are inconsistent — Ghostty
 * sets `ghostty` (lowercase) on some versions, `Ghostty` on others, and
 * Apple's terminal sets `Apple_Terminal`. We don't want a one-character case
 * difference to silently dump users onto the generic adapter (the bug
 * tracked in upm-zg5).
 */
const ADAPTERS_LOWERCASED: Record<string, TerminalAdapter> = Object.fromEntries(
  Object.entries(ADAPTERS_BY_TERM_PROGRAM).map(([k, v]) => [k.toLowerCase(), v]),
);

/**
 * Pick the adapter for a peer's terminal_program value.
 *
 * `terminalProgram` is the raw TERM_PROGRAM string captured at registration —
 * could be anything a terminal emulator chooses to set, or null if the peer
 * registered without one. Lookup is case-insensitive (see ADAPTERS_LOWERCASED
 * comment). Returns the specialized adapter if we ship one, otherwise the
 * generic OSC 2 adapter.
 *
 * Never returns null — there is always a working fallback.
 */
export function getAdapter(terminalProgram: string | null | undefined): TerminalAdapter {
  if (!terminalProgram) return generic;
  return ADAPTERS_LOWERCASED[terminalProgram.toLowerCase()] ?? generic;
}

export type { TerminalAdapter } from "./types.ts";
