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
 * Hand-curated palette: each color is dark enough that white-on-X stays
 * comfortable, saturated enough that adjacent panes in Mission Control look
 * obviously distinct. Order matters — first entries are the most common /
 * visually pleasant hues so small teams land on them first.
 *
 * If you reorder or recolor, expect existing teams to switch backgrounds on
 * the next broker restart. That's fine — there is no contract that a given
 * team gets a specific color, only that *this run* of the broker is consistent.
 */
const PALETTE = [
  "#2a1a0a", // orange
  "#0a1a2a", // blue
  "#0a2a14", // green
  "#1f0a2a", // purple
  "#2a0a14", // red
  "#2a2a0a", // yellow
  "#0a2a2a", // teal
  "#2a0a2a", // pink
  "#1a2a0a", // lime
  "#1a0a2a", // indigo
  "#2a140a", // burnt orange
  "#0a2a1f", // forest
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
