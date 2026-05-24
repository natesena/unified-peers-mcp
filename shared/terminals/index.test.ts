import { describe, expect, test } from "bun:test";
import { TERMINAL_PROGRAMS, getAdapter } from "./index.ts";

describe("getAdapter", () => {
  test("Ghostty → ghostty adapter", () => {
    expect(getAdapter("Ghostty").name).toBe("ghostty");
  });

  // Real Ghostty installs vary in case (some set "ghostty", others "Ghostty").
  // Bug upm-zg5: case-sensitive lookup silently dropped lowercase users onto
  // the generic adapter so per-team background tinting was a no-op for them.
  test("lowercase 'ghostty' → ghostty adapter (case-insensitive lookup)", () => {
    expect(getAdapter("ghostty").name).toBe("ghostty");
  });

  test("mixed-case 'GHOSTTY' / 'gHoStTy' → ghostty adapter", () => {
    expect(getAdapter("GHOSTTY").name).toBe("ghostty");
    expect(getAdapter("gHoStTy").name).toBe("ghostty");
  });

  test("null → generic", () => {
    expect(getAdapter(null).name).toBe("generic");
  });

  test("undefined → generic", () => {
    expect(getAdapter(undefined).name).toBe("generic");
  });

  test("empty string → generic", () => {
    expect(getAdapter("").name).toBe("generic");
  });

  test("unknown TERM_PROGRAM (iTerm.app) → generic", () => {
    expect(getAdapter("iTerm.app").name).toBe("generic");
  });

  test("unknown TERM_PROGRAM (Apple_Terminal) → generic", () => {
    expect(getAdapter("Apple_Terminal").name).toBe("generic");
  });

  test("unknown TERM_PROGRAM (vscode) → generic", () => {
    expect(getAdapter("vscode").name).toBe("generic");
  });

  test("never returns null — always a working adapter", () => {
    const adapter = getAdapter("totally-made-up-terminal");
    expect(adapter).toBeDefined();
    expect(typeof adapter.writeTitle).toBe("function");
    expect(typeof adapter.clearTitle).toBe("function");
  });
});

describe("TERMINAL_PROGRAMS", () => {
  test("contains 'Ghostty'", () => {
    expect(TERMINAL_PROGRAMS).toContain("Ghostty");
  });

  test("every entry has a specialized (non-generic) adapter via getAdapter", () => {
    // Sanity check: if you add a key to TERMINAL_PROGRAMS without wiring it
    // up in ADAPTERS_BY_TERM_PROGRAM, this test catches it.
    for (const tp of TERMINAL_PROGRAMS) {
      const adapter = getAdapter(tp);
      expect(adapter.name).not.toBe("generic");
    }
  });
});
