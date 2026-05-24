/**
 * Integration tests for per-team background tinting via the broker.
 *
 * Validates the wire path end-to-end:
 *   register/set-status/retitle/clear-title → broker handler → ghostty adapter
 *   → OSC 11 / OSC 111 bytes land in the fake TTY file.
 *
 * Tint is gated on the peer having BOTH `team` and `role` set — a peer just
 * labeled with a team but no role stays untinted (signal: active participation,
 * not passive grouping).
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

/** Register a Ghostty peer with explicit AgentCard fields. */
async function registerGhostty(
  tty: string,
  fields: { summary?: string; team?: string; role?: string } = {},
): Promise<string> {
  const res = await postJson(broker, "/register", {
    pid: Math.floor(Math.random() * 100000) + 100000,
    cwd: "/tmp",
    git_root: null,
    tty,
    runtime: "claude",
    terminal_program: "Ghostty",
    summary: fields.summary ?? "",
    ...(fields.team !== undefined ? { team: fields.team } : {}),
    ...(fields.role !== undefined ? { role: fields.role } : {}),
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

describe("Ghostty register: tint requires BOTH team and role", () => {
  test("team + role on register → OSC 11 emitted with team's palette color", async () => {
    const tty = makeFakeTty(broker);
    await registerGhostty(tty.ttyName, {
      summary: "tinted on register",
      team: "alpha",
      role: "worker",
    });
    const expected = `\x1b]11;${colorForTeam("alpha")}\x07`;
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    expect(bytes).toBe(expected);
  });

  test("team only (no role) on register → no OSC 11 emitted", async () => {
    const tty = makeFakeTty(broker);
    await registerGhostty(tty.ttyName, { summary: "team only", team: "alpha" });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]2;"));
    expect(bytes).toContain("]2;[");
    expect(bytes).not.toContain("]11;");
  });

  test("role only (no team) on register → no OSC 11 emitted", async () => {
    const tty = makeFakeTty(broker);
    await registerGhostty(tty.ttyName, { summary: "role only", role: "worker" });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]2;"));
    expect(bytes).not.toContain("]11;");
  });

  test("neither team nor role → no OSC 11 emitted (file only has title bytes)", async () => {
    const tty = makeFakeTty(broker);
    await registerPeer(broker, {
      tty: tty.ttyName,
      summary: "plain register",
      terminal_program: "Ghostty",
    });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]2;"));
    expect(bytes).toContain("]2;[");
    expect(bytes).not.toContain("]11;");
  });

  test("non-Ghostty terminal with team + role → no OSC 11 (generic adapter no-ops)", async () => {
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
      role: "worker",
    });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]2;"));
    expect(bytes).not.toContain("]11;");
  });
});

describe("set_status: tint transitions", () => {
  test("untinted → set team+role together: emits OSC 11", async () => {
    const tty = makeFakeTty(broker);
    const id = await registerGhostty(tty.ttyName, { summary: "joining" });
    await postJson(broker, "/set-status", { id, team: "beta", role: "worker" });
    const expected = `\x1b]11;${colorForTeam("beta")}\x07`;
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    expect(bytes).toBe(expected);
  });

  test("set just team (no role yet) → no OSC 11", async () => {
    const tty = makeFakeTty(broker);
    const id = await registerGhostty(tty.ttyName);
    await postJson(broker, "/set-status", { id, team: "gamma" });
    await Bun.sleep(150);
    const bytes = await tty.getBytes();
    expect(bytes).not.toContain("]11;");
    expect(bytes).not.toContain("]111");
  });

  test("team is set, then setting role completes the gate → OSC 11 emitted", async () => {
    const tty = makeFakeTty(broker);
    const id = await registerGhostty(tty.ttyName);
    await postJson(broker, "/set-status", { id, team: "delta" });
    await Bun.sleep(50);
    await Bun.write(tty.ttyPath, ""); // clear file so we can observe new emit
    await postJson(broker, "/set-status", { id, role: "worker" });
    const expected = `\x1b]11;${colorForTeam("delta")}\x07`;
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    expect(bytes).toBe(expected);
  });

  test("tinted peer clears team → OSC 111 reset emitted", async () => {
    const tty = makeFakeTty(broker);
    const id = await registerGhostty(tty.ttyName, { team: "epsilon", role: "worker" });
    await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    await postJson(broker, "/set-status", { id, team: null });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]111"));
    expect(bytes).toBe("\x1b]111\x07");
  });

  test("tinted peer clears role → OSC 111 reset emitted (team alone isn't enough)", async () => {
    const tty = makeFakeTty(broker);
    const id = await registerGhostty(tty.ttyName, { team: "zeta", role: "worker" });
    await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    await postJson(broker, "/set-status", { id, role: null });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]111"));
    expect(bytes).toBe("\x1b]111\x07");
  });

  test("set_status that doesn't touch team or role → no OSC 11 / OSC 111", async () => {
    const tty = makeFakeTty(broker);
    const id = await registerGhostty(tty.ttyName, { team: "eta", role: "worker" });
    await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    await Bun.write(tty.ttyPath, "");
    // Mutate ONLY status; team/role unchanged.
    await postJson(broker, "/set-status", { id, status: "busy" });
    await Bun.sleep(150);
    const bytes = await tty.getBytes();
    expect(bytes).not.toContain("]11;");
    expect(bytes).not.toContain("]111");
  });

  test("untinted peer setting team-only twice → still no OSC bytes (no spurious resets)", async () => {
    const tty = makeFakeTty(broker);
    const id = await registerGhostty(tty.ttyName);
    await postJson(broker, "/set-status", { id, team: "theta" });
    await postJson(broker, "/set-status", { id, team: "iota" });
    await Bun.sleep(150);
    const bytes = await tty.getBytes();
    expect(bytes).not.toContain("]11;");
    expect(bytes).not.toContain("]111");
  });
});

describe("retitle re-asserts the team tint (when gate is satisfied)", () => {
  test("/retitle with team + role peer emits OSC 11", async () => {
    const tty = makeFakeTty(broker);
    const id = await registerGhostty(tty.ttyName, { team: "kappa", role: "worker" });
    await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    await Bun.write(tty.ttyPath, "");
    await postJson(broker, "/retitle", { id });
    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("]11;"));
    expect(bytes).toBe(`\x1b]11;${colorForTeam("kappa")}\x07`);
  });

  test("/retitle with team-only peer does NOT emit OSC 11", async () => {
    const tty = makeFakeTty(broker);
    const id = await registerGhostty(tty.ttyName, { team: "lambda" });
    await Bun.write(tty.ttyPath, "");
    await postJson(broker, "/retitle", { id });
    await waitForBytes(tty.getBytes, (s) => s.includes("]2;"));
    const bytes = await tty.getBytes();
    expect(bytes).not.toContain("]11;");
    expect(bytes).not.toContain("]111");
  });

  test("/retitle with no team or role does NOT emit OSC 11 or OSC 111", async () => {
    const tty = makeFakeTty(broker);
    const id = await registerGhostty(tty.ttyName);
    await Bun.write(tty.ttyPath, "");
    await postJson(broker, "/retitle", { id });
    await waitForBytes(tty.getBytes, (s) => s.includes("]2;"));
    const bytes = await tty.getBytes();
    expect(bytes).not.toContain("]11;");
    expect(bytes).not.toContain("]111");
  });
});

describe("PEERS_VISUAL_DISABLED kill-switch", () => {
  test("when set, register-with-team+role emits no OSC 11", async () => {
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
          summary: "disabled", team: "alpha", role: "worker",
        }),
      });
      expect(res.status).toBe(200);
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
