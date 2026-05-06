/**
 * End-to-end tests for the multi-recipient send-message flow.
 *
 * Strategy: spawn the broker as a subprocess against a temp DB and a
 * non-default port (so it never collides with the user's real broker on 7900).
 * Drive it with raw fetch calls and assert delivery via /poll-messages.
 *
 * Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17901; // far from default 7900
const DB = join(tmpdir(), `peers-test-${process.pid}.db`);
const BASE = `http://127.0.0.1:${PORT}`;
const BROKER_SCRIPT = new URL("../broker.ts", import.meta.url).pathname;

let broker: ReturnType<typeof Bun.spawn>;
const peerProcs: ReturnType<typeof Bun.spawn>[] = [];

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
 * Register a peer using a freshly-spawned long-lived subprocess as its pid.
 *
 * The broker's stale-peer cleanup runs `process.kill(pid, 0)` and deletes any
 * peer whose pid is dead, so we can't reuse our own pid for many peers — we
 * need distinct, alive pids. A `bun -e 'await new Promise(()=>{})'` subprocess
 * is the simplest way to mint one.
 */
async function registerPeer(
  summary: string,
  runtime: "claude" | "opencode" = "claude",
): Promise<string> {
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
    runtime,
    summary,
  });
  return r.id;
}

beforeAll(async () => {
  // Make sure no stale DB from a prior run leaks state.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${DB}${suffix}`);
    } catch {
      // not present
    }
  }
  broker = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: { ...process.env, PEERS_PORT: String(PORT), PEERS_DB: DB },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForBroker();
});

afterAll(() => {
  for (const p of peerProcs) {
    try {
      p.kill();
    } catch {
      // already gone
    }
  }
  try {
    broker.kill();
  } catch {
    // already gone
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${DB}${suffix}`);
    } catch {
      // not present
    }
  }
});

type MultiResult = {
  to_id: string;
  ok: boolean;
  error?: string;
  delivered_via?: "instant" | "poll" | "poll_after_failure";
  latency_ms?: number;
};
type MultiResponse = { ok: boolean; results: MultiResult[] };

describe("send-message-multi", () => {
  test("fans out to N peers (all delivered_via=poll for claude recipients)", async () => {
    const sender = await registerPeer("sender");
    const a = await registerPeer("recipient a");
    const b = await registerPeer("recipient b");
    const c = await registerPeer("recipient c");

    const res = await post<MultiResponse>("/send-message-multi", {
      from_id: sender,
      to_ids: [a, b, c],
      text: "hi all",
    });

    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.to_id)).toEqual([a, b, c]);
    expect(res.results.every((r) => r.ok)).toBe(true);
    expect(res.results.every((r) => r.delivered_via === "poll")).toBe(true);

    // Each recipient now has exactly one queued message.
    for (const id of [a, b, c]) {
      const polled = await post<{ messages: Array<{ from_id: string; text: string }> }>(
        "/poll-messages",
        { id },
      );
      expect(polled.messages.length).toBe(1);
      const m = polled.messages[0];
      if (!m) throw new Error(`expected one message for ${id}`);
      expect(m.text).toBe("hi all");
      expect(m.from_id).toBe(sender);
    }
  });

  test("partial failure: bogus ID does not block valid recipients", async () => {
    const sender = await registerPeer("sender2");
    const a = await registerPeer("recipient a2");

    const res = await post<MultiResponse>("/send-message-multi", {
      from_id: sender,
      to_ids: [a, "nonexistent-id"],
      text: "partial",
    });

    expect(res.ok).toBe(false); // overall ok flips false on any failure
    expect(res.results.length).toBe(2);

    const aResult = res.results.find((r) => r.to_id === a);
    const badResult = res.results.find((r) => r.to_id === "nonexistent-id");
    if (!aResult || !badResult) throw new Error("expected both results to be present");
    expect(aResult.ok).toBe(true);
    expect(badResult.ok).toBe(false);
    expect(badResult.error ?? "").toMatch(/not found/i);

    // The valid recipient still got the message.
    const polled = await post<{ messages: Array<{ text: string }> }>("/poll-messages", { id: a });
    expect(polled.messages.map((m) => m.text)).toContain("partial");
  });

  test("single-recipient via to_ids: ['x'] still delivers", async () => {
    const sender = await registerPeer("sender3");
    const a = await registerPeer("recipient a3");

    const res = await post<MultiResponse>("/send-message-multi", {
      from_id: sender,
      to_ids: [a],
      text: "solo",
    });
    expect(res.ok).toBe(true);
    expect(res.results.length).toBe(1);
    const only = res.results[0];
    if (!only) throw new Error("expected exactly one result");
    expect(only.ok).toBe(true);
    expect(only.to_id).toBe(a);

    const polled = await post<{ messages: Array<{ text: string }> }>("/poll-messages", { id: a });
    expect(polled.messages.map((m) => m.text)).toContain("solo");
  });

  test("legacy /send-message single endpoint still works (CLI path)", async () => {
    const sender = await registerPeer("sender4");
    const a = await registerPeer("recipient a4");

    const res = await post<{ ok: boolean; delivered_via?: string; error?: string }>(
      "/send-message",
      { from_id: sender, to_id: a, text: "legacy" },
    );
    expect(res.ok).toBe(true);
    expect(res.delivered_via).toBe("poll");

    const polled = await post<{ messages: Array<{ text: string }> }>("/poll-messages", { id: a });
    expect(polled.messages.map((m) => m.text)).toContain("legacy");
  });
});
