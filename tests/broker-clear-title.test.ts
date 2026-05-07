/**
 * Integration tests for POST /clear-title.
 *
 * /clear-title is what MCP servers call on graceful shutdown so the user
 * isn't left looking at a stale agent summary in the window title.
 *
 * Reuses the harness from tests/harness.ts.
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

describe("broker /clear-title", () => {
  let broker: TestBroker;

  beforeAll(async () => { broker = await spawnTestBroker(); });
  afterAll(async () => { await broker.kill(); });

  test("writes empty OSC 2 to peer's tty", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      terminal_program: "Ghostty",
      summary: "before clear",
    });

    // Wait for the initial title to land first so we don't race the clear
    // ahead of it.
    await waitForBytes(tty.getBytes, (s) => s.includes("before clear"));

    await postJson(broker, "/clear-title", { id });

    // After clear, the file should contain exactly the empty-title OSC 2
    // sequence (`\x1b]2;\x07`), nothing more.
    const bytes = await waitForBytes(tty.getBytes, (s) => s === "\x1b]2;\x07");
    expect(bytes).toBe("\x1b]2;\x07");
  });

  test("works with generic-fallback peer (unknown TERM_PROGRAM)", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      terminal_program: "Apple_Terminal", // → generic adapter
      summary: "to clear",
    });
    await waitForBytes(tty.getBytes, (s) => s.includes("to clear"));

    await postJson(broker, "/clear-title", { id });
    const bytes = await waitForBytes(tty.getBytes, (s) => s === "\x1b]2;\x07");
    expect(bytes).toBe("\x1b]2;\x07");
  });

  test("unknown peer ID returns ok:true and does not crash the broker", async () => {
    const res = await postJson(broker, "/clear-title", { id: "doesnotexist" });
    expect(res.ok).toBe(true);
    const health = await fetch(`http://127.0.0.1:${broker.port}/health`);
    expect(health.ok).toBe(true);
  });

  test("peer with null tty: no-op, no crash", async () => {
    const { id } = await registerPeer(broker, {
      tty: null,
      terminal_program: "Ghostty",
      summary: "no tty",
    });
    const res = await postJson(broker, "/clear-title", { id });
    expect(res.ok).toBe(true);
  });
});
