/**
 * Ghostty terminal adapter.
 *
 * Title operations delegate to the generic OSC 2 path — Ghostty fully
 * supports the standard sequence.
 *
 * Beyond titles: Ghostty honors OSC 11 to set the default background color
 * dynamically, and OSC 111 to reset it. We use that to give each team's
 * pane(s) a distinct background tint, so the user can tell teams apart at
 * a glance — especially in Mission Control thumbnails, where the tinted
 * pane stands out far better than a few title characters do.
 *
 * Future seam candidates that still belong here:
 *   - OSC 9 desktop notifications
 *   - OSC 9 ; 4 progress bar (1.2+) for active-task signaling
 *   - AppleScript window targeting (1.3+ exposes a window dictionary)
 *   - The flash_terminal tool deferred to bd issue upm-azr
 */

import type { TerminalAdapter } from "./types.ts";
import { generic, writeToTty } from "./generic.ts";

const ESC = "\x1b";
const BEL = "\x07";

/**
 * Build the OSC 11 set-background bytes: ESC ] 11 ; <#rrggbb> BEL
 *
 * Caller is responsible for color validation. We accept any string the caller
 * passes and frame it; sanitization is the caller's job (broker validates
 * #rrggbb shape upstream via the team-color palette, which is closed).
 */
export function buildSetBackgroundBytes(color: string): string {
  return `${ESC}]11;${color}${BEL}`;
}

/** OSC 111: reset background to the terminal's configured default. */
export function buildResetBackgroundBytes(): string {
  return `${ESC}]111${BEL}`;
}

export const ghostty: TerminalAdapter = {
  name: "ghostty",
  writeTitle: generic.writeTitle,
  clearTitle: generic.clearTitle,

  async setBackground(tty, color) {
    if (!tty) return;
    const bytes = color === null
      ? buildResetBackgroundBytes()
      : buildSetBackgroundBytes(color);
    await writeToTty(tty, bytes);
  },
};
