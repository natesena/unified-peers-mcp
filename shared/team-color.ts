/**
 * Deterministic team → background color mapping.
 *
 * Same team name always maps to the same color, across peers and across
 * broker restarts, with no shared state or config — just a stable hash of
 * the team string indexing into a hand-picked palette of dark terminal-
 * friendly backgrounds.
 *
 * The palette is intentionally small (12 colors) and tuned for readability
 * with light foreground text. Collisions are possible above 12 teams; that
 * is acceptable for a localhost peer network — see PALETTE comment.
 */

/**
 * Hand-curated palette of *very* subtle dark tints. Each color sits in the
 * 0x03–0x0a range — barely a hint of color against a pure-black terminal
 * background, just enough to register peripherally without competing with
 * syntax-highlighted text. Halved twice from the original loud launch palette
 * after user feedback ("subtler" → "even subtler").
 *
 * Order matches EMOJI_PALETTE below so the same hash → same color AND same
 * emoji prefix in the window title. Both are user-visible identity for the
 * same team.
 *
 * If you reorder or recolor, expect existing teams to switch backgrounds on
 * the next broker restart. That's fine — there is no contract that a given
 * team gets a specific color, only that *this run* of the broker is consistent.
 */
const PALETTE = [
  "#0a0703", // orange
  "#03060a", // blue
  "#030a06", // green
  "#07030a", // purple
  "#0a0305", // red
  "#0a0a03", // yellow
  "#030a0a", // teal
  "#0a030a", // pink
  "#060a03", // lime
  "#04030a", // indigo
  "#0a0403", // burnt orange
  "#03080a", // forest
] as const;

/**
 * Parallel emoji palette — index N here matches color N in PALETTE so the
 * same team always renders with the same emoji AND the same background tint.
 * Each is a distinct colored circle/square so the dock / Mission Control /
 * tab bar can render it without falling back to a missing-glyph box.
 *
 * Picked for emoji-rendering ubiquity (all in Emoji 5.0 or earlier, with
 * the exception of the brown circle which is Emoji 12.0 — still ~6 years
 * old, supported by macOS 10.15+).
 */
const EMOJI_PALETTE = [
  "🟠", // orange circle
  "🔵", // blue circle
  "🟢", // green circle
  "🟣", // purple circle
  "🔴", // red circle
  "🟡", // yellow circle
  "🟦", // blue square (teal slot — no teal circle emoji)
  "🟪", // purple square (pink slot — no pink circle emoji)
  "🟩", // green square (lime slot)
  "🟫", // brown square (indigo slot)
  "🟧", // orange square (burnt orange slot)
  "🟥", // red square (forest slot — visually distinct from red circle)
] as const;

/**
 * djb2 hash, picked because it's tiny, well-distributed for short strings,
 * and easy to reason about — not because we need crypto. Returns a
 * non-negative 32-bit integer.
 */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0; // force unsigned
}

/**
 * Map a team name to a background color hex string (e.g. "#0a0703").
 *
 * Returns null for null / empty / whitespace-only team — peers without a
 * team get the terminal's default background, no tint.
 */
export function colorForTeam(team: string | null | undefined): string | null {
  if (!team) return null;
  const trimmed = team.trim();
  if (trimmed.length === 0) return null;
  const idx = hashString(trimmed) % PALETTE.length;
  return PALETTE[idx]!;
}

/**
 * Map a team name to a colored circle/square emoji. Same hash function as
 * colorForTeam, so a peer's background tint and title emoji always match.
 *
 * Returns null on null / empty / whitespace — peers without a team get no
 * emoji prefix in their window title.
 */
export function emojiForTeam(team: string | null | undefined): string | null {
  if (!team) return null;
  const trimmed = team.trim();
  if (trimmed.length === 0) return null;
  const idx = hashString(trimmed) % EMOJI_PALETTE.length;
  return EMOJI_PALETTE[idx]!;
}

/** Exposed for tests / diagnostics — don't depend on length being stable. */
export const TEAM_PALETTE_SIZE = PALETTE.length;
