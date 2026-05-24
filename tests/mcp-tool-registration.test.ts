/**
 * Sanity check that the new MCP tools (set_status, set_task_state) are
 * registered on BOTH runtime servers (claude + opencode), with the expected
 * inputSchema enum constraints. Catches a regression where someone adds a tool
 * to one runtime but forgets the other.
 *
 * We dynamic-import the server modules just for their exported TOOLS array.
 * Doing so spins up the side-effectful broker auto-launch, so we run this
 * with a fake PEERS_PORT and ignore connection errors — we only care about
 * the exported tool definitions.
 */

import { describe, expect, test } from "bun:test";

// Set a high, unused port so the server's brokerFetch helper never collides
// with a real broker. We never actually exercise the server's runtime here.
process.env.PEERS_PORT = "17999";

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, { type?: string | string[]; enum?: string[] }>;
    required?: string[];
  };
}

async function loadTools(modulePath: string): Promise<Tool[]> {
  const mod = (await import(modulePath)) as { TOOLS: Tool[] };
  return mod.TOOLS;
}

describe.each([
  ["claude runtime", "../runtimes/claude/server.ts"],
  ["opencode runtime", "../runtimes/opencode/server.ts"],
])("%s exports the AgentCard MCP tools", (_label, modulePath) => {
  test("set_status is registered with the right enum on status", async () => {
    const tools = await loadTools(modulePath);
    const tool = tools.find((t) => t.name === "set_status");
    expect(tool).toBeDefined();
    const statusProp = tool!.inputSchema.properties?.status;
    expect(statusProp?.enum).toEqual(["available", "busy", "away"]);
    // status is OPTIONAL (partial update). Required must NOT include status.
    expect(tool!.inputSchema.required ?? []).not.toContain("status");
  });

  test("set_task_state is registered with the right enum on state", async () => {
    const tools = await loadTools(modulePath);
    const tool = tools.find((t) => t.name === "set_task_state");
    expect(tool).toBeDefined();
    const stateProp = tool!.inputSchema.properties?.state;
    expect(stateProp?.enum).toEqual(["working", "completed", "failed", "canceled"]);
    // Both task_id and state must be required.
    expect(tool!.inputSchema.required).toContain("task_id");
    expect(tool!.inputSchema.required).toContain("state");
  });

  test("list_peers accepts the new status/team/skill filter args", async () => {
    const tools = await loadTools(modulePath);
    const tool = tools.find((t) => t.name === "list_peers");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties?.status).toBeDefined();
    expect(tool!.inputSchema.properties?.status?.enum).toEqual(["available", "busy", "away"]);
    expect(tool!.inputSchema.properties?.team).toBeDefined();
    expect(tool!.inputSchema.properties?.skill).toBeDefined();
  });

  test("send_message accepts the new optional task_id arg", async () => {
    const tools = await loadTools(modulePath);
    const tool = tools.find((t) => t.name === "send_message");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties?.task_id).toBeDefined();
    // task_id stays optional — required must be exactly to_ids + message.
    expect((tool!.inputSchema.required ?? []).sort()).toEqual(["message", "to_ids"]);
  });
});
