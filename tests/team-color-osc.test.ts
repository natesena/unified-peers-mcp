/**
 * Integration tests for per-team background tinting via the broker.
 *
 * Validates the wire path end-to-end:
 *   register/set-status/retitle/clear-title → broker handler → ghostty adapter
 *   → OSC 11 / OSC 111 bytes land in the fake TTY file.
 *
 * Uses the same UPM_TTY_DIR trick the title tests use: writes land in regular
 * files we can read with Bun.file().text(). One caveat: Bun.write truncates
 * regular files (real /dev/<tty> devices stream), so we test sequences in
 * isolation rather than asserting concatenated content.
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
import { colorForTeam } from "../shared/team-color.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await spawnTestBroker();
});

afterAll(async () => {
  await broker.kill();
});

describe("Ghostty peer registers with a team → background tinted", () => {
  test("OSC 11 with the team's palette color lands in the fake TTY", async () => {
    const tty = makeFakeTty(broker);
    // Register with a team set up-front. The broker should emit OSC 11.
    const res = await postJson(broker, "/register", {
      pid: Math.floor(Math.random() * 100000) + 100000,
      cwd: "/tmp",
      git_root: null,
      tty: tty.ttyName,
      runtime: "claude",
      terminal_program: "Ghostty",
      summary: "tinted on register",
      team: "alpha",
    });
    expect(res.status).toBe(200);

    const expected = `\x1b]11;${colorForTeam("alpha")}\x07`;
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    expect(bytes).toBe(expected);
  });

  test("no team on register → no OSC 11 emitted (file only has title bytes)", async () => {
    const tty = makeFakeTty(broker);
    await registerPeer(broker, {
      tty: tty.ttyName,
      summary: "no team",
      terminal_program: "Ghostty",
    });
    // Wait for title to land. After that, file should NOT contain OSC 11
    // (otherwise the title bytes would have been clobbered).
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]2;"));
    expect(bytes).toContain("]2;[");
    expect(bytes).not.toContain("]11;");
  });

  test("non-Ghostty terminal with a team → no OSC 11 emitted (generic adapter no-ops)", async () => {
    const tty = makeFakeTty(broker);
    await postJson(broker, "/register", {
      pid: Math.floor(Math.random() * 100000) + 100000,
      cwd: "/tmp",
      git_root: null,
      tty: tty.ttyName,
      runtime: "claude",
      terminal_program: "Apple_Terminal",
      summary: "Terminal.app peer",
      team: "alpha",
    });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]2;"));
    expect(bytes).not.toContain("]11;");
  });
});

describe("set_status changes the team → background updates", () => {
  test("team change emits new OSC 11 with the new team's color", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      summary: "switching teams",
      terminal_program: "Ghostty",
    });
    // No team yet, so no OSC 11 initially. Now switch to "beta".
    await postJson(broker, "/set-status", { id, team: "beta" });
    const expected = `\x1b]11;${colorForTeam("beta")}\x07`;
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    expect(bytes).toBe(expected);
  });

  test("explicit team=null emits OSC 111 reset", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      summary: "leave team",
      terminal_program: "Ghostty",
    });
    // Set team, then clear it. The clear should emit OSC 111.
    await postJson(broker, "/set-status", { id, team: "gamma" });
    await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    await postJson(broker, "/set-status", { id, team: null });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]111"));
    expect(bytes).toBe("\x1b]111\x07");
  });

  test("set_status that doesn't touch team → no OSC 11 / OSC 111", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      summary: "status only",
      terminal_program: "Ghostty",
      // give it a team so we'd have something to repaint if buggy
    });
    await postJson(broker, "/set-status", { id, team: "delta" });
    await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    // Wipe the file so we can detect any new background write.
    await Bun.write(tty.ttyPath, "");
    // Now mutate ONLY status; team unchanged.
    await postJson(broker, "/set-status", { id, status: "busy" });
    // Give the broker a beat to do any fire-and-forget I/O.
    await Bun.sleep(150);
    const bytes = await tty.getBytes();
    expect(bytes).not.toContain("]11;");
    expect(bytes).not.toContain("]111");
  });
});

describe("retitle re-asserts the team tint", () => {
  test("/retitle with a team peer emits OSC 11", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      summary: "needs retitle",
      terminal_program: "Ghostty",
    });
    await postJson(broker, "/set-status", { id, team: "epsilon" });
    await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    await Bun.write(tty.ttyPath, "");
    await postJson(broker, "/retitle", { id });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    expect(bytes).toBe(`\x1b]11;${colorForTeam("epsilon")}\x07`);
  });

  test("/retitle with a no-team peer does NOT emit OSC 11 or OSC 111", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      summary: "no team retitle",
      terminal_program: "Ghostty",
    });
    await Bun.write(tty.ttyPath, "");
    await postJson(broker, "/retitle", { id });
    // Title should land; nothing background-related should.
    await waitForBytes(tty.getBytes, (s) => s.includes("]2;"));
    const bytes = await tty.getBytes();
    expect(bytes).not.toContain("]11;");
    expect(bytes).not.toContain("]111");
  });
});

describe("PEERS_VISUAL_DISABLED kill-switch", () => {
  test("when set, register-with-team emits no OSC 11", async () => {
    // We need a separately-spawned broker with the env var set, since the
    // existing `broker` was spawned without it. Build a tiny inline harness.
    const { Bun: _ } = globalThis as never; // typing nudge
    const proc = Bun.spawn({
      cmd: ["bun", new URL("../broker.ts", import.meta.url).pathname],
      env: {
        ...process.env,
        PEERS_PORT: "19913",
        PEERS_DB: `/tmp/upm-test-disabled-${process.pid}.db`,
        UPM_TTY_DIR: broker.ttyDir,
        PEERS_VISUAL_DISABLED: "1",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      // Wait for the kill-switched broker to come up.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          const r = await fetch("http://127.0.0.1:19913/health");
          if (r.ok) break;
        } catch {}
        await Bun.sleep(50);
      }
      const tty = makeFakeTty(broker);
      const res = await fetch("http://127.0.0.1:19913/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pid: Math.floor(Math.random() * 100000) + 100000,
          cwd: "/tmp", git_root: null, tty: tty.ttyName,
          runtime: "claude", terminal_program: "Ghostty",
          summary: "disabled", team: "alpha",
        }),
      });
      expect(res.status).toBe(200);
      // Title should land; no OSC 11 because of the kill-switch.
      await waitForBytes(tty.getBytes, (s) => s.includes("]2;"));
      const bytes = await tty.getBytes();
      expect(bytes).not.toContain("]11;");
    } finally {
      proc.kill();
      await proc.exited.catch(() => {});
      try { (await import("node:fs")).rmSync(`/tmp/upm-test-disabled-${process.pid}.db`, { force: true }); } catch {}
    }
  });
});
