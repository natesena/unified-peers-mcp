/**
 * Integration tests for AgentCard-style initial values on /register.
 *
 * Same enum + array validation as /set-status applies here so a misbehaving
 * client can't seed garbage state at registration time.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { postJson, registerLivePeer, spawnTestBroker, type TestBroker } from "./harness.ts";

let broker: TestBroker;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  broker = await spawnTestBroker();
});

afterAll(async () => {
  for (const c of cleanups) c();
  await broker.kill();
});

async function getPeer(id: string) {
  const res = await postJson(broker, "/list-peers", {
    scope: "machine", cwd: "/tmp", git_root: null,
  });
  const peers = (await res.json()) as Array<Record<string, unknown>>;
  return peers.find((p) => p.id === id);
}

describe("/register — AgentCard defaults", () => {
  test("no status/team/role/skills → defaults applied", async () => {
    const { id, cleanup } = await registerLivePeer(broker);
    cleanups.push(cleanup);
    const peer = await getPeer(id);
    expect(peer?.status).toBe("available");
    expect(peer?.team).toBe(null);
    expect(peer?.role).toBe(null);
    expect(peer?.skills).toBe(null);
  });
});

describe("/register — AgentCard values persisted on initial register", () => {
  test("all four fields set up-front", async () => {
    const { id, cleanup } = await registerLivePeer(broker, {
      status: "busy",
      team: "auth",
      role: "orchestrator",
      skills: ["planning", "rust"],
    });
    cleanups.push(cleanup);
    const peer = await getPeer(id);
    expect(peer?.status).toBe("busy");
    expect(peer?.team).toBe("auth");
    expect(peer?.role).toBe("orchestrator");
    expect(peer?.skills).toEqual(["planning", "rust"]);
  });

  test("empty skills [] persists as [] (declared zero)", async () => {
    const { id, cleanup } = await registerLivePeer(broker, { skills: [] });
    cleanups.push(cleanup);
    const peer = await getPeer(id);
    expect(peer?.skills).toEqual([]);
  });
});

describe("/register — AgentCard validation matches /set-status", () => {
  test("invalid status → 400", async () => {
    const proc = Bun.spawn(["bun", "-e", "await new Promise(() => {})"], {
      stdout: "ignore", stderr: "ignore",
    });
    cleanups.push(() => { try { proc.kill(); } catch {} });
    const res = await postJson(broker, "/register", {
      pid: proc.pid,
      cwd: "/tmp",
      git_root: null,
      tty: null,
      runtime: "claude",
      summary: "",
      status: "WORKING",
    });
    expect(res.status).toBe(400);
  });

  test("invalid skills (string instead of array) → 400", async () => {
    const proc = Bun.spawn(["bun", "-e", "await new Promise(() => {})"], {
      stdout: "ignore", stderr: "ignore",
    });
    cleanups.push(() => { try { proc.kill(); } catch {} });
    const res = await postJson(broker, "/register", {
      pid: proc.pid,
      cwd: "/tmp",
      git_root: null,
      tty: null,
      runtime: "claude",
      summary: "",
      skills: "rust",
    });
    expect(res.status).toBe(400);
  });

  test("invalid skills (array with non-string) → 400", async () => {
    const proc = Bun.spawn(["bun", "-e", "await new Promise(() => {})"], {
      stdout: "ignore", stderr: "ignore",
    });
    cleanups.push(() => { try { proc.kill(); } catch {} });
    const res = await postJson(broker, "/register", {
      pid: proc.pid,
      cwd: "/tmp",
      git_root: null,
      tty: null,
      runtime: "claude",
      summary: "",
      skills: ["rust", 1],
    });
    expect(res.status).toBe(400);
  });
});
