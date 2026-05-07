/**
 * Generic OSC 2 terminal adapter.
 *
 * Fallback for any terminal we don't have a specialized adapter for. Uses
 * the standard OSC 2 escape sequence (ESC ] 2 ; <title> BEL) which is
 * honored by virtually every modern terminal emulator: iTerm, Terminal.app,
 * WezTerm, kitty, alacritty, xterm, tmux (with `set-titles on`), screen, …
 *
 * The wire-format helpers (`buildTitleBytes`, `buildClearTitleBytes`) are
 * exported separately from the adapter object so the byte sequence can be
 * unit-tested without touching real TTY devices.
 */

import type { TerminalAdapter } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Wire format
// ─────────────────────────────────────────────────────────────────────────────

const ESC = "\x1b";
const BEL = "\x07";
const OSC_SET_TITLE = 2;

/**
 * Build the raw bytes of an OSC 2 set-title command.
 *
 * The title text is NOT sanitized here; callers (formatTitle in format.ts)
 * are responsible for stripping control bytes before bytes ever reach this
 * function. Keeping framing dumb means tests can lock in the exact byte
 * sequence without coupling to sanitization rules.
 */
export function buildTitleBytes(title: string): string {
  return `${ESC}]${OSC_SET_TITLE};${title}${BEL}`;
}

/** Build the bytes of an empty OSC 2, used to reset the title. */
export function buildClearTitleBytes(): string {
  return `${ESC}]${OSC_SET_TITLE};${BEL}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write `bytes` to /dev/<tty>. Silent-fail on any error.
 *
 * The tty may have closed (terminal window quit), or the broker process may
 * not own the tty (foreign user, sandboxed environment). Title hygiene is
 * best-effort; we don't surface these errors to callers.
 */
async function writeToTty(tty: string, bytes: string): Promise<void> {
  try {
    await Bun.write(`/dev/${tty}`, bytes);
  } catch {
    // Intentional silent fail — see contract on TerminalAdapter.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export const generic: TerminalAdapter = {
  name: "generic",

  async writeTitle(tty, title) {
    if (!tty) return;
    await writeToTty(tty, buildTitleBytes(title));
  },

  async clearTitle(tty) {
    if (!tty) return;
    await writeToTty(tty, buildClearTitleBytes());
  },
};
