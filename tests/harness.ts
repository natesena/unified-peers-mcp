/**
 * Shared test harness for broker integration tests.
 *
 * Spawns the real `broker.ts` as a subprocess against a temp SQLite DB and a
 * temp UPM_TTY_DIR (so writeTitle's I/O lands in a directory we can read,
 * instead of real character devices). Each test gets a unique fake "tty"
 * filename inside that dir.
 *
 * Used by tests/broker-title.test.ts and any future broker integration tests
 * (clear-title, retitle, …). Not a `*.test.ts` file itself, so bun:test
 * doesn't try to run it as tests.
 */

import { mkdir, rm } from "node:fs/promises";
import type { Subprocess } from "bun";

export interface TestBroker {
  port: number;
  dbPath: string;
  ttyDir: string;
  proc: Subprocess;
  kill(): Promise<void>;
}

/**
 * Spawn a clean broker subprocess on a random high port, with isolated DB and
 * TTY directory. Waits up to 5s for /health to respond OK before resolving.
 *
 * Caller is responsible for invoking `kill()` (typically in afterAll). It
 * cleans up the subprocess, the temp DB (+ WAL/SHM sidecars), and the TTY dir.
 */
export async function spawnTestBroker(): Promise<TestBroker> {
  const port = 17900 + Math.floor(Math.random() * 1000);
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const dbPath = `/tmp/upm-test-broker-${stamp}.db`;
  const ttyDir = `/tmp/upm-test-tty-${stamp}`;
  await mkdir(ttyDir, { recursive: true });

  // broker.ts is at the project root (one level up from tests/).
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;

  const proc = Bun.spawn({
    cmd: ["bun", brokerPath],
    env: {
      ...process.env,
      PEERS_PORT: String(port),
      PEERS_DB: dbPath,
      UPM_TTY_DIR: ttyDir,
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        return {
          port, dbPath, ttyDir, proc,
          async kill() {
            proc.kill();
            await proc.exited;
            await rm(ttyDir, { recursive: true, force: true });
            await rm(dbPath, { force: true });
            await rm(`${dbPath}-wal`, { force: true });
            await rm(`${dbPath}-shm`, { force: true });
          },
        };
      }
    } catch { /* still booting */ }
    await Bun.sleep(50);
  }
  proc.kill();
  throw new Error(`test broker failed to become healthy on port ${port}`);
}

export interface FakeTty {
  /** Bare name (e.g. "fake-abc123") — what tests pass as `tty` in /register. */
  ttyName: string;
  /** Full path inside ttyDir — what writeTitle actually writes to. */
  ttyPath: string;
  /** Read whatever bytes currently sit in the fake tty file. */
  getBytes(): Promise<string>;
}

/** Create a unique fake tty for one test. Each call gets a fresh filename. */
export function makeFakeTty(broker: TestBroker): FakeTty {
  const ttyName = `fake-${Math.random().toString(36).slice(2, 10)}`;
  const ttyPath = `${broker.ttyDir}/${ttyName}`;
  return {
    ttyName,
    ttyPath,
    async getBytes() {
      try {
        return await Bun.file(ttyPath).text();
      } catch {
        return "";
      }
    },
  };
}

/**
 * Title writes are fire-and-forget — the HTTP response can return before the
 * I/O completes. Poll the fake tty until `predicate(bytes)` is satisfied or
 * `timeoutMs` elapses, then return the latest bytes (last-read-wins).
 */
export async function waitForBytes(
  getBytes: () => Promise<string>,
  predicate: (s: string) => boolean,
  timeoutMs = 1000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bytes = await getBytes();
    if (predicate(bytes)) return bytes;
    await Bun.sleep(20);
  }
  return await getBytes();
}

export async function postJson(broker: TestBroker, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${broker.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function registerPeer(
  broker: TestBroker,
  opts: {
    tty: string | null;
    summary?: string;
    terminal_program?: string | null;
    pid?: number;
    runtime?: "claude" | "opencode";
  },
): Promise<{ id: string }> {
  const res = await postJson(broker, "/register", {
    pid: opts.pid ?? Math.floor(Math.random() * 100000) + 100000,
    cwd: "/tmp",
    git_root: null,
    tty: opts.tty,
    runtime: opts.runtime ?? "claude",
    terminal_program: opts.terminal_program ?? null,
    summary: opts.summary ?? "",
  });
  return res.json() as Promise<{ id: string }>;
}
