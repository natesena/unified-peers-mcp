import { describe, expect, test } from "bun:test";
import { buildClearTitleBytes, buildTitleBytes, generic } from "./generic.ts";

describe("buildTitleBytes", () => {
  test("produces ESC ] 2 ; <title> BEL exactly", () => {
    expect(buildTitleBytes("hello")).toBe("\x1b]2;hello\x07");
  });

  test("preserves spaces and Unicode in title", () => {
    expect(buildTitleBytes("hello world 🌍")).toBe("\x1b]2;hello world 🌍\x07");
  });

  test("handles empty title (used for clear)", () => {
    expect(buildTitleBytes("")).toBe("\x1b]2;\x07");
  });

  test("does NOT sanitize — that is the caller's responsibility (format.ts)", () => {
    // Documents the contract: buildTitleBytes is dumb framing. Callers must
    // hand it pre-sanitized text. Sanitization lives in format.ts/sanitize.
    expect(buildTitleBytes("a\x1bb")).toBe("\x1b]2;a\x1bb\x07");
  });
});

describe("buildClearTitleBytes", () => {
  test("produces empty OSC 2 (ESC ] 2 ; BEL)", () => {
    expect(buildClearTitleBytes()).toBe("\x1b]2;\x07");
  });
});

describe("generic adapter", () => {
  test("name is 'generic'", () => {
    expect(generic.name).toBe("generic");
  });

  test("writeTitle is a no-op on null tty (does not throw)", async () => {
    await generic.writeTitle(null, "test");
  });

  test("writeTitle is a no-op on empty-string tty (does not throw)", async () => {
    await generic.writeTitle("", "test");
  });

  test("clearTitle is a no-op on null tty (does not throw)", async () => {
    await generic.clearTitle(null);
  });

  test("writeTitle silently swallows I/O errors on a non-existent tty", async () => {
    // /dev/this-tty-does-not-exist-xyz123 will fail to open. Adapter must
    // not throw — title hygiene is best-effort. (See TerminalAdapter contract.)
    await generic.writeTitle("this-tty-does-not-exist-xyz123", "test");
  });

  test("clearTitle silently swallows I/O errors on a non-existent tty", async () => {
    await generic.clearTitle("this-tty-does-not-exist-xyz123");
  });
});
