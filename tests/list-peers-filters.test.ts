/**
 * Integration tests for the new /list-peers filters: status, team, skill.
 *
 * Special attention to the JSON substring false-positive (skill='rust' must
 * NOT match 'rust-analyzer') because we store skills as a JSON-encoded TEXT
 * column. We use in-memory filtering via parseSkills.includes() to dodge that,
 * but the test guards against any future regression to LIKE-based matching.
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

async function makePeer(opts: Parameters<typeof registerLivePeer>[1] = {}): Promise<string> {
  const { id, cleanup } = await registerLivePeer(broker, opts);
  cleanups.push(cleanup);
  return id;
}

async function listPeers(filters: Record<string, unknown>) {
  const res = await postJson(broker, "/list-peers", {
    scope: "machine",
    cwd: "/tmp",
    git_root: null,
    ...filters,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Array<Record<string, unknown>>;
}

describe("/list-peers — status filter", () => {
  test("status='available' returns only available peers", async () => {
    const free = await makePeer({ status: "available" });
    const busy = await makePeer({ status: "busy" });
    const away = await makePeer({ status: "away" });

    const result = await listPeers({ status: "available" });
    const ids = result.map((p) => p.id);
    expect(ids).toContain(free);
    expect(ids).not.toContain(busy);
    expect(ids).not.toContain(away);
  });

  test("status='busy' returns only busy peers", async () => {
    const free = await makePeer({ status: "available" });
    const busy = await makePeer({ status: "busy" });
    const result = await listPeers({ status: "busy" });
    const ids = result.map((p) => p.id);
    expect(ids).toContain(busy);
    expect(ids).not.toContain(free);
  });
});

describe("/list-peers — team filter", () => {
  test("team='alpha' returns peers on exactly that team", async () => {
    const a = await makePeer({ team: "alpha" });
    const b = await makePeer({ team: "alpha" });
    const c = await makePeer({ team: "beta" });
    const noTeam = await makePeer();

    const result = await listPeers({ team: "alpha" });
    const ids = result.map((p) => p.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(ids).not.toContain(c);
    expect(ids).not.toContain(noTeam);
  });

  test("team exact match — 'alpha' must NOT match 'alpha-prime'", async () => {
    const a = await makePeer({ team: "alpha" });
    const ap = await makePeer({ team: "alpha-prime" });
    const result = await listPeers({ team: "alpha" });
    const ids = result.map((p) => p.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(ap);
  });

  test("filter on missing team value returns empty array, not error", async () => {
    await makePeer({ team: "alpha" });
    const result = await listPeers({ team: "no-such-team" });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});

describe("/list-peers — skill filter", () => {
  test("skill='rust' returns peers whose skills array contains 'rust'", async () => {
    const rust = await makePeer({ skills: ["rust", "sql"] });
    const sql = await makePeer({ skills: ["sql"] });
    const none = await makePeer();

    const result = await listPeers({ skill: "rust" });
    const ids = result.map((p) => p.id);
    expect(ids).toContain(rust);
    expect(ids).not.toContain(sql);
    expect(ids).not.toContain(none);
  });

  test("skill='rust' must NOT match 'rust-analyzer' (JSON substring guard)", async () => {
    const rust = await makePeer({ skills: ["rust"] });
    const analyzer = await makePeer({ skills: ["rust-analyzer"] });
    const result = await listPeers({ skill: "rust" });
    const ids = result.map((p) => p.id);
    expect(ids).toContain(rust);
    expect(ids).not.toContain(analyzer);
  });

  test("skill=<x> with no matching peers → empty array", async () => {
    await makePeer({ skills: ["go"] });
    const result = await listPeers({ skill: "ocaml" });
    expect(result.length).toBe(0);
  });

  test("skill filter against a peer with no skills declared → not returned", async () => {
    const none = await makePeer(); // skills=null
    const result = await listPeers({ skill: "rust" });
    expect(result.map((p) => p.id)).not.toContain(none);
  });

  test("skill filter against a peer with empty skills array → not returned", async () => {
    const empty = await makePeer({ skills: [] });
    const result = await listPeers({ skill: "rust" });
    expect(result.map((p) => p.id)).not.toContain(empty);
  });
});

describe("/list-peers — composed filters", () => {
  test("status=available AND skill=rust", async () => {
    const target = await makePeer({ status: "available", skills: ["rust"] });
    const busyRust = await makePeer({ status: "busy", skills: ["rust"] });
    const availSql = await makePeer({ status: "available", skills: ["sql"] });

    const result = await listPeers({ status: "available", skill: "rust" });
    const ids = result.map((p) => p.id);
    expect(ids).toContain(target);
    expect(ids).not.toContain(busyRust);
    expect(ids).not.toContain(availSql);
  });

  test("status=busy AND team=alpha AND skill=rust", async () => {
    const target = await makePeer({ status: "busy", team: "alpha", skills: ["rust"] });
    const wrongStatus = await makePeer({ status: "available", team: "alpha", skills: ["rust"] });
    const wrongTeam = await makePeer({ status: "busy", team: "beta", skills: ["rust"] });
    const wrongSkill = await makePeer({ status: "busy", team: "alpha", skills: ["sql"] });

    const result = await listPeers({ status: "busy", team: "alpha", skill: "rust" });
    const ids = result.map((p) => p.id);
    expect(ids).toContain(target);
    expect(ids).not.toContain(wrongStatus);
    expect(ids).not.toContain(wrongTeam);
    expect(ids).not.toContain(wrongSkill);
  });
});

describe("/list-peers — interaction with existing filters", () => {
  test("runtime filter composes with new filters", async () => {
    const claudeBusy = await makePeer({ runtime: "claude", status: "busy", team: "x" });
    const opencodeBusy = await makePeer({ runtime: "opencode", status: "busy", team: "x" });
    const result = await listPeers({ runtime: "claude", status: "busy", team: "x" });
    const ids = result.map((p) => p.id);
    expect(ids).toContain(claudeBusy);
    expect(ids).not.toContain(opencodeBusy);
  });

  test("exclude_id still works alongside new filters", async () => {
    const self = await makePeer({ status: "available" });
    const other = await makePeer({ status: "available" });
    const result = await listPeers({ status: "available", exclude_id: self });
    const ids = result.map((p) => p.id);
    expect(ids).toContain(other);
    expect(ids).not.toContain(self);
  });
});

describe("/list-peers — output shape", () => {
  test("includes status/team/role/skills in returned rows when set", async () => {
    const id = await makePeer({ status: "busy", team: "g", role: "orchestrator", skills: ["rust"] });
    const result = await listPeers({});
    const peer = result.find((p) => p.id === id);
    expect(peer).toBeDefined();
    expect(peer?.status).toBe("busy");
    expect(peer?.team).toBe("g");
    expect(peer?.role).toBe("orchestrator");
    expect(peer?.skills).toEqual(["rust"]);
  });

  test("returns nulls cleanly when unset (not undefined or missing)", async () => {
    const id = await makePeer();
    const result = await listPeers({});
    const peer = result.find((p) => p.id === id);
    expect(peer?.status).toBe("available"); // DEFAULT
    expect(peer?.team).toBe(null);
    expect(peer?.role).toBe(null);
    expect(peer?.skills).toBe(null);
  });
});
