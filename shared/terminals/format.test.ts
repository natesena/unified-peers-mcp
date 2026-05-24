import { describe, expect, test } from "bun:test";
import { formatTitle } from "./format.ts";

describe("formatTitle — body shape", () => {
  test("produces 'working on <summary> [<id>]'", () => {
    expect(formatTitle({ id: "abcd1234", summary: "fixing bug", runtime: "claude" }))
      .toBe("working on fixing bug [abcd1234]");
  });

  test("falls back to 'idle [<id>]' when summary is empty", () => {
    expect(formatTitle({ id: "abcd1234", summary: "", runtime: "claude" }))
      .toBe("idle [abcd1234]");
  });

  test("falls back to 'idle' when summary is whitespace-only after sanitize", () => {
    expect(formatTitle({ id: "abcd1234", summary: "   \n\t  ", runtime: "claude" }))
      .toBe("idle [abcd1234]");
  });

  test("opencode runtime is not used as a fallback any more (idle is universal)", () => {
    expect(formatTitle({ id: "xyz98765", summary: "", runtime: "opencode" }))
      .toBe("idle [xyz98765]");
  });
});

describe("formatTitle — sanitization (escape-smuggling defense)", () => {
  test("strips C0 control bytes from summary", () => {
    const evil = "harmless\x1b]0;hijacked\x07more";
    const result = formatTitle({ id: "abcd1234", summary: evil, runtime: "claude" });
    expect(result).not.toContain("\x1b");
    expect(result).not.toContain("\x07");
    expect(result).toContain("harmless");
    expect(result).toContain("more");
  });

  test("strips DEL (0x7f)", () => {
    expect(formatTitle({ id: "abcd1234", summary: "be\x7ffore", runtime: "claude" }))
      .toBe("working on be fore [abcd1234]");
  });

  test("collapses whitespace runs introduced by sanitization", () => {
    expect(formatTitle({ id: "abcd1234", summary: "a\n\n\nb", runtime: "claude" }))
      .toBe("working on a b [abcd1234]");
  });

  test("preserves Unicode characters in summary", () => {
    expect(formatTitle({ id: "abcd1234", summary: "🚀 Ωmega プロジェクト", runtime: "claude" }))
      .toBe("working on 🚀 Ωmega プロジェクト [abcd1234]");
  });
});

describe("formatTitle — truncation", () => {
  test("truncates entire result (including suffix) to 120 chars", () => {
    const longSummary = "x".repeat(200);
    const result = formatTitle({ id: "abcd1234", summary: longSummary, runtime: "claude" });
    expect(result.length).toBe(120);
    expect(result.startsWith("working on ")).toBe(true);
  });

  test("truncation includes the emoji prefix in the budget", () => {
    const longSummary = "x".repeat(200);
    const result = formatTitle(
      { id: "abcd1234", summary: longSummary, runtime: "claude" },
      { emojiPrefix: "🟠" },
    );
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.startsWith("🟠 working on ")).toBe(true);
  });
});

describe("formatTitle — emojiPrefix option", () => {
  test("prepends '<emoji> ' when emojiPrefix is provided", () => {
    expect(formatTitle(
      { id: "abcd1234", summary: "fixing bug", runtime: "claude" },
      { emojiPrefix: "🟠" },
    )).toBe("🟠 working on fixing bug [abcd1234]");
  });

  test("emojiPrefix on an idle (empty-summary) peer", () => {
    expect(formatTitle(
      { id: "abcd1234", summary: "", runtime: "claude" },
      { emojiPrefix: "🟡" },
    )).toBe("🟡 idle [abcd1234]");
  });

  test("emojiPrefix=null is the same as no opts (no prefix)", () => {
    expect(formatTitle(
      { id: "abcd1234", summary: "x", runtime: "claude" },
      { emojiPrefix: null },
    )).toBe("working on x [abcd1234]");
  });

  test("emojiPrefix=undefined is the same as no opts (no prefix)", () => {
    expect(formatTitle(
      { id: "abcd1234", summary: "x", runtime: "claude" },
      {},
    )).toBe("working on x [abcd1234]");
  });
});
