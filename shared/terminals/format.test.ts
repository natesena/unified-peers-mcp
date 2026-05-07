import { describe, expect, test } from "bun:test";
import { formatTitle } from "./format.ts";

describe("formatTitle", () => {
  test("produces [<id>] <summary>", () => {
    expect(formatTitle({ id: "abcd1234", summary: "fixing bug", runtime: "claude" }))
      .toBe("[abcd1234] fixing bug");
  });

  test("truncates entire result (including prefix) to 120 chars", () => {
    const longSummary = "x".repeat(200);
    const result = formatTitle({ id: "abcd1234", summary: longSummary, runtime: "claude" });
    expect(result.length).toBe(120);
    expect(result.startsWith("[abcd1234] ")).toBe(true);
  });

  test("falls back to [<id>] <runtime> when summary is empty", () => {
    expect(formatTitle({ id: "abcd1234", summary: "", runtime: "claude" }))
      .toBe("[abcd1234] claude");
  });

  test("falls back to runtime when summary is whitespace-only after sanitize", () => {
    expect(formatTitle({ id: "abcd1234", summary: "   \n\t  ", runtime: "claude" }))
      .toBe("[abcd1234] claude");
  });

  test("strips C0 control bytes from summary (escape-sequence smuggling defense)", () => {
    const evil = "harmless\x1b]0;hijacked\x07more";
    const result = formatTitle({ id: "abcd1234", summary: evil, runtime: "claude" });
    expect(result).not.toContain("\x1b");
    expect(result).not.toContain("\x07");
    expect(result).toContain("harmless");
    expect(result).toContain("more");
  });

  test("strips DEL (0x7f)", () => {
    expect(formatTitle({ id: "abcd1234", summary: "be\x7ffore", runtime: "claude" }))
      .toBe("[abcd1234] be fore");
  });

  test("collapses whitespace runs introduced by sanitization", () => {
    expect(formatTitle({ id: "abcd1234", summary: "a\n\n\nb", runtime: "claude" }))
      .toBe("[abcd1234] a b");
  });

  test("preserves Unicode characters in summary", () => {
    expect(formatTitle({ id: "abcd1234", summary: "🚀 Ωmega プロジェクト", runtime: "claude" }))
      .toBe("[abcd1234] 🚀 Ωmega プロジェクト");
  });

  test("works for opencode runtime fallback", () => {
    expect(formatTitle({ id: "xyz98765", summary: "", runtime: "opencode" }))
      .toBe("[xyz98765] opencode");
  });
});
