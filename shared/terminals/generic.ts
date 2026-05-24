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
 * Directory holding TTY device files. Defaults to /dev. Can be overridden via
 * UPM_TTY_DIR for tests (write to a temp dir instead of real character devices)
 * or for unusual sandbox setups where TTY devices live elsewhere.
 *
 * Trailing slash is normalized away.
 */
const TTY_DEVICE_DIR = (process.env.UPM_TTY_DIR ?? "/dev").replace(/\/+$/, "");

/**
 * Write `bytes` to <TTY_DEVICE_DIR>/<tty>. Silent-fail on any error.
 *
 * The tty may have closed (terminal window quit), or the broker process may
 * not own the tty (foreign user, sandboxed environment). Title hygiene is
 * best-effort; we don't surface these errors to callers.
 *
 * Exported so specialized adapters (ghostty.ts) can reuse the same plumbing
 * without duplicating the file-write + UPM_TTY_DIR override + silent-fail
 * pattern. Test harness exploits this via UPM_TTY_DIR.
 */
export async function writeToTty(tty: string, bytes: string): Promise<void> {
  try {
    await Bun.write(`${TTY_DEVICE_DIR}/${tty}`, bytes);
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

  // No-op. Generic targets the broadest set of terminals — many ignore OSC 11
  // or worse, render dynamic background changes badly. Specialized adapters
  // (ghostty.ts) override this when the terminal is known to honor it cleanly.
  async setBackground() { /* intentional no-op */ },
};
