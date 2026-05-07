/**
 * Integration tests for the broker's terminal-title side effects.
 *
 * Verifies that POST /register and POST /set-summary both trigger an OSC 2
 * write to the peer's tty (via the adapter selected by terminal_program).
 *
 * Strategy: spawn the broker subprocess pointed at a temp UPM_TTY_DIR, use
 * regular files inside that dir as fake ttys, and assert on the bytes the
 * adapter wrote. Harness in tests/harness.ts is reused by upm-3sz and upm-74z.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  makeFakeTty,
  postJson,
  registerPeer,
  spawnTestBroker,
  waitForBytes,
  type TestBroker,
} from "./harness.ts";

describe("broker title-write integration", () => {
  let broker: TestBroker;

  beforeAll(async () => { broker = await spawnTestBroker(); });
  afterAll(async () => { await broker.kill(); });

  test("/register writes initial title to peer's tty (Ghostty)", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      terminal_program: "Ghostty",
      summary: "initial work",
    });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("initial work"));
    expect(bytes).toBe(`\x1b]2;[${id}] initial work\x07`);
  });

  test("/set-summary writes updated title bytes", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      terminal_program: "Ghostty",
      summary: "first",
    });
    await waitForBytes(tty.getBytes, (s) => s.includes("first"));

    await postJson(broker, "/set-summary", { id, summary: "second update" });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("second update"));
    expect(bytes).toBe(`\x1b]2;[${id}] second update\x07`);
  });

  test("unknown TERM_PROGRAM falls back to generic adapter (still writes OSC 2)", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      terminal_program: "Apple_Terminal", // unknown to registry → generic
      summary: "unknown terminal",
    });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("unknown terminal"));
    expect(bytes).toBe(`\x1b]2;[${id}] unknown terminal\x07`);
  });

  test("null terminal_program also works (generic fallback)", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      terminal_program: null,
      summary: "no term program",
    });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("no term program"));
    expect(bytes).toBe(`\x1b]2;[${id}] no term program\x07`);
  });

  test("summary with embedded escape sequences is sanitized in the wire bytes", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      terminal_program: "Ghostty",
      summary: "harmless\x1b]0;injected\x07tail",
    });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.length > 0);

    // Frame must be exactly one ESC + ]2; … BEL with NO nested control bytes
    // anywhere in the title payload — otherwise summary text could smuggle in
    // a foreign OSC sequence.
    expect(bytes.startsWith("\x1b]2;")).toBe(true);
    expect(bytes.endsWith("\x07")).toBe(true);
    const title = bytes.slice(4, -1);
    expect(title).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(title).toContain(`[${id}]`);
    expect(title).toContain("harmless");
    expect(title).toContain("tail");
  });

  test("null tty in /register is a no-op (no file created, no crash)", async () => {
    const res = await postJson(broker, "/register", {
      pid: Math.floor(Math.random() * 100000) + 100000,
      cwd: "/tmp",
      git_root: null,
      tty: null,
      runtime: "claude",
      terminal_program: "Ghostty",
      summary: "no tty",
    });
    expect(res.ok).toBe(true);
    const health = await fetch(`http://127.0.0.1:${broker.port}/health`);
    expect(health.ok).toBe(true);
  });

  test("/set-summary on unknown peer ID does not crash the broker", async () => {
    const res = await postJson(broker, "/set-summary", { id: "nonexistent", summary: "no-op" });
    expect(res.ok).toBe(true);
    const health = await fetch(`http://127.0.0.1:${broker.port}/health`);
    expect(health.ok).toBe(true);
  });

  test("opencode peer also gets a title write (adapter selection is by terminal, not runtime)", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      terminal_program: "Ghostty",
      runtime: "opencode",
      summary: "opencode work",
    });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("opencode work"));
    expect(bytes).toBe(`\x1b]2;[${id}] opencode work\x07`);
  });
});
