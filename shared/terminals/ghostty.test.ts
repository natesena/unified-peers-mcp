import { describe, expect, test } from "bun:test";
import { buildResetBackgroundBytes, buildSetBackgroundBytes } from "./ghostty.ts";

describe("Ghostty OSC 11 wire format", () => {
  test("set background frames a #rrggbb color as ESC ] 11 ; <color> BEL", () => {
    expect(buildSetBackgroundBytes("#1a0a2a")).toBe("\x1b]11;#1a0a2a\x07");
  });

  test("set background passes the color through verbatim (no quoting)", () => {
    // Color validation happens upstream in shared/team-color.ts; the framer
    // is dumb on purpose so the byte sequence is easy to lock down.
    expect(buildSetBackgroundBytes("rgb:1a/0a/2a")).toBe("\x1b]11;rgb:1a/0a/2a\x07");
  });

  test("reset background is exactly ESC ] 111 BEL — no payload", () => {
    expect(buildResetBackgroundBytes()).toBe("\x1b]111\x07");
  });
});
