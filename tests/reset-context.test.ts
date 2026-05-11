/**
 * reset_context: broker /reset-context route.
 *
 * Verifies that:
 *   - opencode targets receive a POST /reset with the right `mode` at their
 *     registered plugin port, for both "compact" and "clear" modes.
 *   - self-targeting an opencode peer (passing its own id) works just like
 *     targeting another peer — same code path.
 *   - claude targets get a per-slot "unsupported" error rather than poisoning
 *     the batch; top-level ok=false when any slot fails.
 *   - unknown peer ids get a per-slot "not found" error.
 *   - opencode peers with no registered plugin_port get a per-slot error.
 *   - multi-target fan-out hits every plugin in parallel.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17903; // distinct from send-message-multi (17901) and dual-path (17902)
const DB = join(tmpdir(), `peers-reset-context-test-${process.pid}.db`);
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
 * Stand-in for the opencode plugin's HTTP server. Records every /reset POST
 * body it sees so the test can assert which mode arrived.
 */
function spawnFakePlugin(): { port: number; received: Array<{ mode?: string }> } {
  const received: Array<{ mode?: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "POST" && path === "/reset") {
        try {
          received.push(await req.json() as { mode?: string });
        } catch {
          received.push({});
        }
        return Response.json({ ok: true });
      }
      // /message exists for completeness but isn't exercised here.
      if (req.method === "POST" && path === "/message") {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  helperServers.push(server);
  if (server.port == null) throw new Error("fake plugin failed to bind a port");
  return { port: server.port, received };
}

type ResetResp = {
  ok: boolean;
  mode: string;
  results: Array<{ to_id: string; ok: boolean; error?: string; latency_ms?: number }>;
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

describe("/reset-context", () => {
  test("compact: opencode target receives POST /reset with mode=compact", async () => {
    const plugin = spawnFakePlugin();
    const target = await registerPeer({ summary: "oc-1", runtime: "opencode", plugin_port: plugin.port });

    const res = await post<ResetResp>("/reset-context", { ids: [target], mode: "compact" });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe("compact");
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.to_id).toBe(target);
    expect(res.results[0]?.ok).toBe(true);
    expect(plugin.received).toHaveLength(1);
    expect(plugin.received[0]?.mode).toBe("compact");
  });

  test("clear: opencode target receives POST /reset with mode=clear", async () => {
    const plugin = spawnFakePlugin();
    const target = await registerPeer({ summary: "oc-2", runtime: "opencode", plugin_port: plugin.port });

    const res = await post<ResetResp>("/reset-context", { ids: [target], mode: "clear" });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe("clear");
    expect(plugin.received[0]?.mode).toBe("clear");
  });

  test("self-target works (peer passes its own id) — no special path", async () => {
    const plugin = spawnFakePlugin();
    const peer = await registerPeer({ summary: "oc-self", runtime: "opencode", plugin_port: plugin.port });

    const res = await post<ResetResp>("/reset-context", { ids: [peer], mode: "compact" });
    expect(res.ok).toBe(true);
    expect(plugin.received).toHaveLength(1);
    expect(plugin.received[0]?.mode).toBe("compact");
  });

  test("multi-target fan-out: each plugin receives one /reset", async () => {
    const a = spawnFakePlugin();
    const b = spawnFakePlugin();
    const c = spawnFakePlugin();
    const idA = await registerPeer({ summary: "a", runtime: "opencode", plugin_port: a.port });
    const idB = await registerPeer({ summary: "b", runtime: "opencode", plugin_port: b.port });
    const idC = await registerPeer({ summary: "c", runtime: "opencode", plugin_port: c.port });

    const res = await post<ResetResp>("/reset-context", { ids: [idA, idB, idC], mode: "clear" });
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(3);
    expect(res.results.every((r) => r.ok)).toBe(true);
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
    expect(c.received).toHaveLength(1);
    for (const p of [a, b, c]) expect(p.received[0]?.mode).toBe("clear");
  });

  test("claude target returns per-slot 'unsupported' error; batch top-level ok=false", async () => {
    const plugin = spawnFakePlugin();
    const oc = await registerPeer({ summary: "oc-mix", runtime: "opencode", plugin_port: plugin.port });
    const cl = await registerPeer({ summary: "cl-mix", runtime: "claude" });

    const res = await post<ResetResp>("/reset-context", { ids: [oc, cl], mode: "compact" });
    expect(res.ok).toBe(false); // one slot failed → overall false
    expect(res.results).toHaveLength(2);

    const ocSlot = res.results.find((r) => r.to_id === oc);
    const clSlot = res.results.find((r) => r.to_id === cl);
    expect(ocSlot?.ok).toBe(true);
    expect(clSlot?.ok).toBe(false);
    expect(clSlot?.error).toMatch(/unsupported/i);
    expect(clSlot?.error).toMatch(/claude/i);

    // The opencode plugin still received its /reset — bad slots don't poison the batch.
    expect(plugin.received).toHaveLength(1);
  });

  test("unknown peer id → per-slot 'not found' error", async () => {
    const res = await post<ResetResp>("/reset-context", {
      ids: ["definitely-not-a-real-id"],
      mode: "compact",
    });
    expect(res.ok).toBe(false);
    expect(res.results[0]?.ok).toBe(false);
    expect(res.results[0]?.error).toMatch(/not found/i);
  });

  test("opencode peer with no plugin_port → per-slot error; other slot still succeeds", async () => {
    const plugin = spawnFakePlugin();
    const good = await registerPeer({ summary: "ok-port", runtime: "opencode", plugin_port: plugin.port });
    const noPort = await registerPeer({ summary: "no-port", runtime: "opencode", plugin_port: null });

    const res = await post<ResetResp>("/reset-context", { ids: [good, noPort], mode: "compact" });
    expect(res.ok).toBe(false);
    expect(res.results.find((r) => r.to_id === good)?.ok).toBe(true);
    expect(res.results.find((r) => r.to_id === noPort)?.ok).toBe(false);
    expect(res.results.find((r) => r.to_id === noPort)?.error).toMatch(/no helper port/i);
  });

  test("invalid mode → empty results, ok=false", async () => {
    const plugin = spawnFakePlugin();
    const target = await registerPeer({ summary: "bad-mode", runtime: "opencode", plugin_port: plugin.port });
    const res = await post<ResetResp>("/reset-context", { ids: [target], mode: "vacuum" });
    expect(res.ok).toBe(false);
    expect(res.results).toHaveLength(0);
    // Plugin should NOT have been called.
    expect(plugin.received).toHaveLength(0);
  });

  test("empty ids → empty results, ok=false", async () => {
    const res = await post<ResetResp>("/reset-context", { ids: [], mode: "compact" });
    expect(res.ok).toBe(false);
    expect(res.results).toHaveLength(0);
  });
});
