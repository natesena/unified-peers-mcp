import { describe, expect, test } from "bun:test";
import { colorForTeam, emojiForTeam, TEAM_PALETTE_SIZE } from "./team-color.ts";

describe("colorForTeam — null / empty handling", () => {
  test("null returns null (no tint)", () => {
    expect(colorForTeam(null)).toBe(null);
  });

  test("undefined returns null", () => {
    expect(colorForTeam(undefined)).toBe(null);
  });

  test("empty string returns null", () => {
    expect(colorForTeam("")).toBe(null);
  });

  test("whitespace-only returns null (trim semantics)", () => {
    expect(colorForTeam("   ")).toBe(null);
    expect(colorForTeam("\t")).toBe(null);
    expect(colorForTeam("\n")).toBe(null);
  });
});

describe("colorForTeam — determinism", () => {
  test("same team name produces the same color twice", () => {
    expect(colorForTeam("alpha")).toBe(colorForTeam("alpha"));
    expect(colorForTeam("auth-refactor-001")).toBe(colorForTeam("auth-refactor-001"));
  });

  test("hash is stable across many calls (regression guard against accidental mutable state)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const c = colorForTeam("alpha");
      if (c) seen.add(c);
    }
    expect(seen.size).toBe(1);
  });

  test("leading/trailing whitespace is normalized (trim)", () => {
    expect(colorForTeam(" alpha ")).toBe(colorForTeam("alpha"));
    expect(colorForTeam("\talpha\n")).toBe(colorForTeam("alpha"));
  });
});

describe("colorForTeam — distinctness", () => {
  test("different team names usually produce different colors (small-sample sanity)", () => {
    // Not a guarantee (palette is only 12), but we want some confidence that
    // closely-related strings don't all collide.
    const colors = new Set([
      colorForTeam("alpha"),
      colorForTeam("beta"),
      colorForTeam("gamma"),
      colorForTeam("delta"),
    ]);
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });

  // Note: we deliberately don't assert "different case → different color".
  // With only 12 palette slots, hash collisions are statistically expected
  // even for different inputs — including different cases of the same word.
  // The contract is "same string in → same color out" (determinism), not
  // "different string in → different color out" (impossible with 12 slots).
});

describe("colorForTeam — output shape", () => {
  test("returns a 7-char #rrggbb hex string", () => {
    const c = colorForTeam("alpha");
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("only returns colors from the published palette", () => {
    // Hammer through ~200 random team names; every result must be one of
    // exactly TEAM_PALETTE_SIZE distinct colors.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const team = `team-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const c = colorForTeam(team);
      if (c) seen.add(c);
    }
    expect(seen.size).toBeLessThanOrEqual(TEAM_PALETTE_SIZE);
  });
});

describe("emojiForTeam — null / empty handling", () => {
  test("null / undefined / empty / whitespace → null", () => {
    expect(emojiForTeam(null)).toBe(null);
    expect(emojiForTeam(undefined)).toBe(null);
    expect(emojiForTeam("")).toBe(null);
    expect(emojiForTeam("   ")).toBe(null);
  });
});

describe("emojiForTeam — determinism", () => {
  test("same team → same emoji every time", () => {
    expect(emojiForTeam("alpha")).toBe(emojiForTeam("alpha"));
    expect(emojiForTeam("auth-refactor-001")).toBe(emojiForTeam("auth-refactor-001"));
  });

  test("trim semantics match colorForTeam", () => {
    expect(emojiForTeam(" alpha ")).toBe(emojiForTeam("alpha"));
  });
});

describe("emojiForTeam — output", () => {
  test("returns a non-empty string for a non-empty team", () => {
    const emoji = emojiForTeam("alpha");
    expect(typeof emoji).toBe("string");
    expect(emoji!.length).toBeGreaterThan(0);
  });

  test("uses at most TEAM_PALETTE_SIZE distinct emoji", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const e = emojiForTeam(`team-${i}-${Math.random().toString(36).slice(2, 8)}`);
      if (e) seen.add(e);
    }
    expect(seen.size).toBeLessThanOrEqual(TEAM_PALETTE_SIZE);
  });
});

describe("color + emoji palettes are paired by index", () => {
  test("two teams that hash to the same color also hash to the same emoji", () => {
    // Generate many team names and verify (color, emoji) is a bijection —
    // any two inputs mapping to the same color also map to the same emoji.
    const byColor = new Map<string, Set<string>>();
    for (let i = 0; i < 500; i++) {
      const team = `${i}-${Math.random().toString(36).slice(2, 8)}`;
      const c = colorForTeam(team);
      const e = emojiForTeam(team);
      if (c && e) {
        const set = byColor.get(c) ?? new Set();
        set.add(e);
        byColor.set(c, set);
      }
    }
    for (const [, emojis] of byColor) {
      // Each color must correspond to exactly one emoji across all seen teams.
      expect(emojis.size).toBe(1);
    }
  });
});
