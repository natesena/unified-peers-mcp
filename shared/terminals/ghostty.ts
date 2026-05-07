/**
 * Ghostty terminal adapter.
 *
 * Today this is a thin pass-through to the generic OSC 2 adapter — Ghostty
 * fully supports the standard sequence. The reason this file exists at all
 * (rather than just routing "Ghostty" → generic in the registry):
 *
 *   - Future Ghostty-specific behavior lands here without touching the broker
 *     or the generic adapter. Candidates: OSC 9 desktop notifications, the
 *     flash_terminal tool deferred to bd issue upm-azr, AppleScript-based
 *     window targeting (Ghostty 1.3+ exposes a window dictionary).
 *
 *   - Having the seam from day one means we don't have to retrofit the
 *     registry or rewire callers when those features arrive.
 *
 * Don't delete this as redundant.
 */

import type { TerminalAdapter } from "./types.ts";
import { generic } from "./generic.ts";

export const ghostty: TerminalAdapter = {
  name: "ghostty",
  // Delegated to generic for now. Override either method here when Ghostty-
  // specific behavior arrives (e.g. OSC 9 notifications on flash, or routing
  // through Ghostty's AppleScript dictionary instead of /dev/<tty>).
  writeTitle: generic.writeTitle,
  clearTitle: generic.clearTitle,
};
