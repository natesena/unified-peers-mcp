/**
 * Integration tests for /set-status — partial updates, validation, defaults,
 * and non-interference with /set-summary.
 *
 * Uses the shared harness (spawnTestBroker + registerLivePeer) so list_peers
 * / diagnose paths see real alive pids and don't garbage-collect mid-test.
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

async function makePeer(
  opts: Parameters<typeof registerLivePeer>[1] = {},
): Promise<string> {
  const { id, cleanup } = await registerLivePeer(broker, opts);
  cleanups.push(cleanup);
  return id;
}

async function getPeer(scopeCwd: string, id: string) {
  const res = await postJson(broker, "/list-peers", {
    scope: "machine",
    cwd: scopeCwd,
    git_root: null,
  });
  const peers = (await res.json()) as Array<Record<string, unknown>>;
  return peers.find((p) => p.id === id);
}

describe("/set-status — defaults on register", () => {
  test("fresh register defaults: status=available, team=null, role=null, skills=null", async () => {
    const id = await makePeer({ summary: "fresh" });
    const peer = await getPeer("/tmp", id);
    expect(peer).toBeDefined();
    expect(peer?.status).toBe("available");
    expect(peer?.team).toBe(null);
    expect(peer?.role).toBe(null);
    expect(peer?.skills).toBe(null);
  });
});

describe("/set-status — partial updates", () => {
  test("set only status, other fields preserved", async () => {
    const id = await makePeer({ team: "alpha", role: "orchestrator", skills: ["rust"] });
    const res = await postJson(broker, "/set-status", { id, status: "busy" });
    expect(res.status).toBe(200);
    const peer = await getPeer("/tmp", id);
    expect(peer?.status).toBe("busy");
    expect(peer?.team).toBe("alpha");
    expect(peer?.role).toBe("orchestrator");
    expect(peer?.skills).toEqual(["rust"]);
  });

  test("set only team, other fields preserved", async () => {
    const id = await makePeer({ status: "busy", role: "worker", skills: ["sql"] });
    const res = await postJson(broker, "/set-status", { id, team: "beta" });
    expect(res.status).toBe(200);
    const peer = await getPeer("/tmp", id);
    expect(peer?.status).toBe("busy");
    expect(peer?.team).toBe("beta");
    expect(peer?.role).toBe("worker");
    expect(peer?.skills).toEqual(["sql"]);
  });

  test("set only skills, status/team/role preserved", async () => {
    const id = await makePeer({ status: "away", team: "g", role: "x" });
    const res = await postJson(broker, "/set-status", { id, skills: ["frontend", "react"] });
    expect(res.status).toBe(200);
    const peer = await getPeer("/tmp", id);
    expect(peer?.status).toBe("away");
    expect(peer?.team).toBe("g");
    expect(peer?.role).toBe("x");
    expect(peer?.skills).toEqual(["frontend", "react"]);
  });

  test("set all four at once", async () => {
    const id = await makePeer();
    const res = await postJson(broker, "/set-status", {
      id,
      status: "busy",
      team: "auth",
      role: "orchestrator",
      skills: ["planning", "go"],
    });
    expect(res.status).toBe(200);
    const peer = await getPeer("/tmp", id);
    expect(peer?.status).toBe("busy");
    expect(peer?.team).toBe("auth");
    expect(peer?.role).toBe("orchestrator");
    expect(peer?.skills).toEqual(["planning", "go"]);
  });

  test("omitted fields are a no-op (read-modify-write)", async () => {
    const id = await makePeer({ status: "busy", team: "x", role: "y", skills: ["a"] });
    const res = await postJson(broker, "/set-status", { id }); // only id
    expect(res.status).toBe(200);
    const peer = await getPeer("/tmp", id);
    expect(peer?.status).toBe("busy");
    expect(peer?.team).toBe("x");
    expect(peer?.role).toBe("y");
    expect(peer?.skills).toEqual(["a"]);
  });
});

describe("/set-status — explicit null clears nullable fields", () => {
  test("team: null clears", async () => {
    const id = await makePeer({ team: "to-clear" });
    await postJson(broker, "/set-status", { id, team: null });
    const peer = await getPeer("/tmp", id);
    expect(peer?.team).toBe(null);
  });

  test("role: null clears", async () => {
    const id = await makePeer({ role: "to-clear" });
    await postJson(broker, "/set-status", { id, role: null });
    const peer = await getPeer("/tmp", id);
    expect(peer?.role).toBe(null);
  });

  test("skills: null clears (distinct from empty array)", async () => {
    const id = await makePeer({ skills: ["a", "b"] });
    await postJson(broker, "/set-status", { id, skills: null });
    const peer = await getPeer("/tmp", id);
    expect(peer?.skills).toBe(null);
  });

  test("skills: [] preserves declared-zero state, not cleared to null", async () => {
    const id = await makePeer({ skills: ["a"] });
    await postJson(broker, "/set-status", { id, skills: [] });
    const peer = await getPeer("/tmp", id);
    expect(peer?.skills).toEqual([]);
  });
});

describe("/set-status — validation errors", () => {
  test("status: null → 400 (status is NOT NULL)", async () => {
    const id = await makePeer();
    const res = await postJson(broker, "/set-status", { id, status: null });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/status/i);
  });

  test.each([
    ["BUSY", "uppercase"],
    ["working", "wrong-enum-value"],
    [123, "number"],
    [true, "boolean"],
    [{ status: "busy" }, "object"],
  ])("status=%p (%s) → 400", async (badValue) => {
    const id = await makePeer();
    const res = await postJson(broker, "/set-status", { id, status: badValue });
    expect(res.status).toBe(400);
  });

  test.each([
    ["rust", "string-not-array"],
    [42, "number"],
    [["rust", 1], "mixed-types"],
    [[null], "null-element"],
    [{ 0: "rust" }, "object-not-array"],
  ])("skills=%p (%s) → 400", async (badValue) => {
    const id = await makePeer();
    const res = await postJson(broker, "/set-status", { id, skills: badValue });
    expect(res.status).toBe(400);
  });

  test("team=number → 400", async () => {
    const id = await makePeer();
    const res = await postJson(broker, "/set-status", { id, team: 42 });
    expect(res.status).toBe(400);
  });

  test("role=array → 400", async () => {
    const id = await makePeer();
    const res = await postJson(broker, "/set-status", { id, role: ["x"] });
    expect(res.status).toBe(400);
  });

  test("validation runs before any UPDATE — bad status doesn't partially apply other fields", async () => {
    const id = await makePeer({ team: "preserved" });
    const res = await postJson(broker, "/set-status", { id, status: "BAD", team: "should-not-apply" });
    expect(res.status).toBe(400);
    const peer = await getPeer("/tmp", id);
    expect(peer?.team).toBe("preserved");
  });
});

describe("/set-status — not-found", () => {
  test("unknown id → 404", async () => {
    const res = await postJson(broker, "/set-status", { id: "no-such-peer", status: "busy" });
    expect(res.status).toBe(404);
  });
});

describe("/set-status — empty-string values for team/role are allowed (not cleared)", () => {
  test("team='' is stored as empty string, not converted to null", async () => {
    const id = await makePeer();
    await postJson(broker, "/set-status", { id, team: "" });
    const peer = await getPeer("/tmp", id);
    // Distinct from null. Caller can clear by passing null explicitly.
    expect(peer?.team).toBe("");
  });
});

describe("/set-status + /set-summary do not clobber each other", () => {
  test("set_summary then set_status preserves summary", async () => {
    const id = await makePeer();
    await postJson(broker, "/set-summary", { id, summary: "doing the thing" });
    await postJson(broker, "/set-status", { id, status: "busy", team: "alpha" });
    const peer = await getPeer("/tmp", id);
    expect(peer?.summary).toBe("doing the thing");
    expect(peer?.status).toBe("busy");
    expect(peer?.team).toBe("alpha");
  });

  test("set_status then set_summary preserves status/team/role/skills", async () => {
    const id = await makePeer();
    await postJson(broker, "/set-status", {
      id, status: "away", team: "beta", role: "reviewer", skills: ["sql"],
    });
    await postJson(broker, "/set-summary", { id, summary: "new summary" });
    const peer = await getPeer("/tmp", id);
    expect(peer?.summary).toBe("new summary");
    expect(peer?.status).toBe("away");
    expect(peer?.team).toBe("beta");
    expect(peer?.role).toBe("reviewer");
    expect(peer?.skills).toEqual(["sql"]);
  });
});
