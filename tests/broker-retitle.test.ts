/**
 * Integration tests for POST /retitle.
 *
 * /retitle re-asserts a peer's current title. Useful when the title has been
 * clobbered (long ssh, tmux without set-titles, another tool's OSC writes).
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

describe("broker /retitle", () => {
  let broker: TestBroker;

  beforeAll(async () => { broker = await spawnTestBroker(); });
  afterAll(async () => { await broker.kill(); });

  test("re-asserts the current title for a registered peer", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      terminal_program: "Ghostty",
      summary: "current task",
    });
    await waitForBytes(tty.getBytes, (s) => s.includes("current task"));

    // Simulate the title being clobbered by overwriting the fake tty.
    await Bun.write(tty.ttyPath, "CLOBBERED");
    expect(await tty.getBytes()).toBe("CLOBBERED");

    const res = await postJson(broker, "/retitle", { id });
    expect(res.ok).toBe(true);

    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("current task"));
    expect(bytes).toBe(`\x1b]2;[${id}] current task\x07`);
  });

  test("unknown peer ID returns 404 with a clear error", async () => {
    const res = await postJson(broker, "/retitle", { id: "doesnotexist" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not found");

    // Broker still healthy.
    const health = await fetch(`http://127.0.0.1:${broker.port}/health`);
    expect(health.ok).toBe(true);
  });

  test("works with generic-fallback peer", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      terminal_program: "WezTerm", // unknown to registry → generic
      summary: "wez work",
    });
    await waitForBytes(tty.getBytes, (s) => s.includes("wez work"));

    await Bun.write(tty.ttyPath, "");
    await postJson(broker, "/retitle", { id });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("wez work"));
    expect(bytes).toBe(`\x1b]2;[${id}] wez work\x07`);
  });
});
