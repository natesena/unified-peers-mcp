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
 * Hand-curated palette of *subtle* dark tints. Each color sits in the
 * 0x05–0x18 range — visible against a pure-black terminal background but
 * unobtrusive enough not to fight syntax-highlighted text. Halved from the
 * original launch palette after user feedback that the tint was too loud.
 *
 * Order matters — first entries are the most visually pleasant hues so
 * small teams land on them first.
 *
 * If you reorder or recolor, expect existing teams to switch backgrounds on
 * the next broker restart. That's fine — there is no contract that a given
 * team gets a specific color, only that *this run* of the broker is consistent.
 */
const PALETTE = [
  "#150d05", // orange
  "#050d15", // blue
  "#05150a", // green
  "#0f0515", // purple
  "#15050a", // red
  "#15150a", // yellow
  "#051515", // teal
  "#150515", // pink
  "#0d1505", // lime
  "#0d0515", // indigo
  "#150a05", // burnt orange
  "#05150f", // forest
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
 * Map a team name to a background color hex string (e.g. "#1a0a2a").
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

/** Exposed for tests / diagnostics — don't depend on length being stable. */
export const TEAM_PALETTE_SIZE = PALETTE.length;
