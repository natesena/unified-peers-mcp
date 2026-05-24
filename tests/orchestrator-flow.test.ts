/**
 * End-to-end orchestrator pattern walk-through.
 *
 * One test, six steps, three peers. Exercises the full intended flow so a
 * regression in any single piece (status/team/role/skills/task lifecycle)
 * shows up here too.
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

async function list(filters: Record<string, unknown>) {
  const res = await postJson(broker, "/list-peers", {
    scope: "machine", cwd: "/tmp", git_root: null, ...filters,
  });
  return (await res.json()) as Array<Record<string, unknown>>;
}

describe("orchestrator pattern — end-to-end", () => {
  test("orchestrator finds workers by skill, assigns tasks, workers complete", async () => {
    // 1. Three peers in the network — one will become orchestrator, two are workers
    //    with different skills.
    const orchestrator = await makePeer({ summary: "I'll orchestrate" });
    const rustWorker = await makePeer({
      summary: "rust dev", status: "available", skills: ["rust", "sql"],
    });
    const frontendWorker = await makePeer({
      summary: "frontend dev", status: "available", skills: ["react", "typescript"],
    });

    // 2. Orchestrator declares itself.
    await postJson(broker, "/set-status", {
      id: orchestrator,
      status: "busy",
      team: "auth-refactor",
      role: "orchestrator",
      skills: ["planning"],
    });

    // 3. Orchestrator queries for an available rust worker.
    const candidates = await list({ status: "available", skill: "rust" });
    expect(candidates.map((p) => p.id)).toContain(rustWorker);
    expect(candidates.map((p) => p.id)).not.toContain(frontendWorker);
    expect(candidates.map((p) => p.id)).not.toContain(orchestrator); // already busy

    // 4. Orchestrator assigns a task; worker switches itself to busy + joins team.
    await postJson(broker, "/send-message", {
      from_id: orchestrator,
      to_id: rustWorker,
      text: "refactor /auth/middleware",
      task_id: "auth-refactor-001",
    });
    await postJson(broker, "/set-status", {
      id: rustWorker,
      status: "busy",
      team: "auth-refactor",
      role: "worker",
    });

    // 5. Orchestrator can find its team via team filter.
    const team = await list({ team: "auth-refactor" });
    const teamIds = team.map((p) => p.id);
    expect(teamIds).toContain(orchestrator);
    expect(teamIds).toContain(rustWorker);
    expect(teamIds).not.toContain(frontendWorker);

    // 5b. Worker drains the task message (sees task_state='working').
    const inbox = await postJson(broker, "/poll-messages", { id: rustWorker });
    const inboxBody = (await inbox.json()) as { messages: Array<Record<string, unknown>> };
    expect(inboxBody.messages.length).toBe(1);
    expect(inboxBody.messages[0]?.task_id).toBe("auth-refactor-001");
    expect(inboxBody.messages[0]?.task_state).toBe("working");

    // 6. Worker completes the task and resets to available.
    const transition = await postJson(broker, "/set-task-state", {
      id: rustWorker,
      task_id: "auth-refactor-001",
      state: "completed",
    });
    expect(transition.status).toBe(200);

    await postJson(broker, "/set-status", {
      id: rustWorker,
      status: "available",
      team: null,
      role: null,
    });
    await postJson(broker, "/set-status", {
      id: orchestrator,
      status: "available",
      team: null,
      role: null,
    });

    // 7. After reset, list with team='auth-refactor' returns nothing.
    const teamAfter = await list({ team: "auth-refactor" });
    expect(teamAfter.length).toBe(0);

    // 8. Both are available again.
    const free = await list({ status: "available" });
    const freeIds = free.map((p) => p.id);
    expect(freeIds).toContain(orchestrator);
    expect(freeIds).toContain(rustWorker);
    expect(freeIds).toContain(frontendWorker);
  });
});
