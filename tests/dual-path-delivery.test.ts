/**
 * Dual-path delivery for opencode (upm-uab).
 *
 * Verifies that even when "instant" delivery to an opencode peer's helper
 * succeeds (HTTP 200), the broker still keeps the message on the poll queue
 * (delivered=0). This is the fix for messages getting silently dropped when
 * the receiving opencode session is mid-generation: the plugin's TUI bus
 * events are dropped silently, but the receiver's MCP server polls every 1s
 * and surfaces messages via check_messages — so the poll path must stay open.
 *
 * What this test asserts:
 *   - opencode recipient with a working plugin: instant delivery succeeds AND
 *     /poll-messages returns the message on the next poll.
 *   - polling marks the message delivered, so a second poll returns nothing
 *     (no infinite re-delivery).
 *   - claude recipient: no instant handler exists, so messages route straight
 *     to poll (delivered_via=poll). Behavior unchanged.
 *   - opencode recipient whose plugin is down: instant fails →
 *     delivered_via=poll_after_failure, message still on the poll queue.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17902; // distinct from send-message-multi (17901) and broker default (7900)
const DB = join(tmpdir(), `peers-dual-path-test-${process.pid}.db`);
const BASE = `http://127.0.0.1:${PORT}`;
const BROKER_SCRIPT = new URL("../broker.ts", import.meta.url).pathname;

let broker: ReturnType<typeof Bun.spawn>;
const peerProcs: ReturnType<typeof Bun.spawn>[] = [];
const helperServers: ReturnType<typeof Bun.serve>[] = [];

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

async function waitForBroker() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(50);
  }
  throw new Error("broker did not come up");
}

/**
 * Mint a long-lived subprocess and use its pid as a peer's pid. The broker
 * cleans up peers whose pid is dead, so we need distinct alive pids.
 */
async function registerPeer(opts: {
  summary: string;
  runtime: "claude" | "opencode";
  plugin_port?: number | null;
}): Promise<string> {
  const proc = Bun.spawn(["bun", "-e", "await new Promise(() => {})"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  peerProcs.push(proc);
  const r = await post<{ id: string }>("/register", {
    pid: proc.pid,
    cwd: "/tmp",
    git_root: null,
    tty: null,
    runtime: opts.runtime,
    plugin_port: opts.plugin_port ?? null,
    summary: opts.summary,
  });
  return r.id;
}

/**
 * Spawn a tiny HTTP server that mimics the opencode-peers plugin: it accepts
 * POST /message and records the received body. Returns the port it bound to
 * and a `received` array the test can inspect.
 */
function spawnFakePlugin(): { port: number; received: unknown[] } {
  const received: unknown[] = [];
  const server = Bun.serve({
    port: 0, // random
    async fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname === "/message") {
        try {
          received.push(await req.json());
        } catch {
          received.push(null);
        }
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    },
  });
  helperServers.push(server);
  if (server.port == null) throw new Error("fake plugin failed to bind a port");
  return { port: server.port, received };
}

type SingleSendResponse = {
  ok: boolean;
  delivered_via?: "instant" | "poll" | "poll_after_failure";
  latency_ms?: number;
  error?: string;
};

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(`${DB}${suffix}`); } catch { /* ok */ }
  }
  broker = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: { ...process.env, PEERS_PORT: String(PORT), PEERS_DB: DB },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForBroker();
});

afterAll(() => {
  for (const s of helperServers) { try { s.stop(true); } catch { /* ok */ } }
  for (const p of peerProcs) { try { p.kill(); } catch { /* ok */ } }
  try { broker.kill(); } catch { /* ok */ }
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(`${DB}${suffix}`); } catch { /* ok */ }
  }
});

describe("dual-path delivery for opencode (upm-uab)", () => {
  test("opencode recipient: instant succeeds AND poll path still drains", async () => {
    const plugin = spawnFakePlugin();
    const sender = await registerPeer({ summary: "sender", runtime: "claude" });
    const recipient = await registerPeer({
      summary: "opencode receiver",
      runtime: "opencode",
      plugin_port: plugin.port,
    });

    const sendRes = await post<SingleSendResponse>("/send-message", {
      from_id: sender,
      to_id: recipient,
      text: "hello opencode",
    });
    expect(sendRes.ok).toBe(true);
    expect(sendRes.delivered_via).toBe("instant");

    // Plugin received it (TUI path attempted).
    expect(plugin.received.length).toBe(1);

    // Critical: the poll path STILL has the message — this is the upm-uab fix.
    const polled = await post<{ messages: Array<{ from_id: string; text: string }> }>(
      "/poll-messages",
      { id: recipient },
    );
    expect(polled.messages.length).toBe(1);
    const m = polled.messages[0];
    if (!m) throw new Error("expected one message");
    expect(m.text).toBe("hello opencode");
    expect(m.from_id).toBe(sender);
  });

  test("opencode recipient: second poll returns nothing (no re-delivery)", async () => {
    const plugin = spawnFakePlugin();
    const sender = await registerPeer({ summary: "sender2", runtime: "claude" });
    const recipient = await registerPeer({
      summary: "opencode receiver 2",
      runtime: "opencode",
      plugin_port: plugin.port,
    });

    await post<SingleSendResponse>("/send-message", {
      from_id: sender,
      to_id: recipient,
      text: "drain me once",
    });

    const first = await post<{ messages: unknown[] }>("/poll-messages", { id: recipient });
    expect(first.messages.length).toBe(1);

    const second = await post<{ messages: unknown[] }>("/poll-messages", { id: recipient });
    expect(second.messages.length).toBe(0);
  });

  test("claude recipient: no instant handler, message routes to poll only", async () => {
    const sender = await registerPeer({ summary: "sender3", runtime: "claude" });
    const recipient = await registerPeer({ summary: "claude receiver", runtime: "claude" });

    const sendRes = await post<SingleSendResponse>("/send-message", {
      from_id: sender,
      to_id: recipient,
      text: "hi claude",
    });
    expect(sendRes.ok).toBe(true);
    expect(sendRes.delivered_via).toBe("poll");

    const polled = await post<{ messages: Array<{ text: string }> }>(
      "/poll-messages",
      { id: recipient },
    );
    expect(polled.messages.map((m) => m.text)).toEqual(["hi claude"]);

    // And not re-delivered.
    const second = await post<{ messages: unknown[] }>("/poll-messages", { id: recipient });
    expect(second.messages.length).toBe(0);
  });

  test("opencode recipient with dead plugin: poll_after_failure, still drains", async () => {
    // Bind to a random closed port: spawn a server, capture port, immediately stop.
    const tmp = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadPort = tmp.port;
    tmp.stop(true);

    const sender = await registerPeer({ summary: "sender4", runtime: "claude" });
    const recipient = await registerPeer({
      summary: "opencode dead helper",
      runtime: "opencode",
      plugin_port: deadPort,
    });

    const sendRes = await post<SingleSendResponse>("/send-message", {
      from_id: sender,
      to_id: recipient,
      text: "fallback path",
    });
    expect(sendRes.ok).toBe(true);
    expect(sendRes.delivered_via).toBe("poll_after_failure");

    const polled = await post<{ messages: Array<{ text: string }> }>(
      "/poll-messages",
      { id: recipient },
    );
    expect(polled.messages.map((m) => m.text)).toEqual(["fallback path"]);
  });
});
