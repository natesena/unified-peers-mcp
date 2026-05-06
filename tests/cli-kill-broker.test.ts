/**
 * Regression tests for `bun cli.ts kill-broker` (upm-r2x).
 *
 * Original bug: kill-broker invoked `lsof -ti :PORT`, which returns every pid
 * with a socket on the port — both the listening broker AND every connected
 * MCP client (unified-peers, opencode-peers) AND the cli.ts process itself.
 * The loop then SIGTERM'd all of them. Observed live on 2026-05-06: a single
 * kill-broker call killed 6 peer MCP servers and self-terminated cli.ts (143).
 *
 * Fix: filter lsof to LISTEN-state sockets only via `-sTCP:LISTEN`.
 *
 * These tests reproduce the bug condition (a peer with an open TCP connection
 * to the broker port) and assert that kill-broker leaves it alive.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17902; // distinct from send-message-multi.test.ts (17901)
const DB = join(tmpdir(), `peers-killtest-${process.pid}.db`);
const REPO = new URL("..", import.meta.url).pathname;
const BROKER_SCRIPT = join(REPO, "broker.ts");
const CLI_SCRIPT = join(REPO, "cli.ts");

let broker: ReturnType<typeof Bun.spawn> | null = null;
const clients: ReturnType<typeof Bun.spawn>[] = [];

async function waitForBroker(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(50);
  }
  throw new Error("broker did not start");
}

async function startBroker(): Promise<void> {
  broker = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: { ...process.env, PEERS_PORT: String(PORT), PEERS_DB: DB },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForBroker();
}

/**
 * Spawn a subprocess that hammers /health every 50ms. The continuous traffic
 * guarantees it has an established TCP socket on the broker port during the
 * lsof snapshot — exactly the condition that the bug triggered on for real
 * MCP servers polling /poll-messages.
 */
function spawnConnectedClient(): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `
      while (true) {
        try { await fetch("http://127.0.0.1:${PORT}/health"); } catch {}
        await Bun.sleep(50);
      }
      `,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  clients.push(proc);
  return proc;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + suffix);
    } catch {
      // not present
    }
  }
}

beforeEach(() => {
  clearDbFiles();
});

afterEach(() => {
  for (const c of clients.splice(0)) {
    try {
      c.kill();
    } catch {
      // already gone
    }
  }
  if (broker) {
    try {
      broker.kill();
    } catch {
      // already gone
    }
    broker = null;
  }
  clearDbFiles();
});

describe("cli kill-broker", () => {
  test("kills only the listening broker, not connected clients", async () => {
    await startBroker();
    const brokerPid = broker!.pid!;
    const client = spawnConnectedClient();
    const clientPid = client.pid!;

    // Let the client establish at least one connection cycle to the broker.
    await Bun.sleep(200);

    expect(isAlive(brokerPid)).toBe(true);
    expect(isAlive(clientPid)).toBe(true);

    const cli = Bun.spawn(["bun", CLI_SCRIPT, "kill-broker"], {
      env: { ...process.env, PEERS_PORT: String(PORT) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await cli.exited;
    const stdout = await new Response(cli.stdout).text();

    // Self-SIGTERM regression: buggy code self-terminates with exit 143.
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Broker stopped/);

    // Give SIGTERM time to land on the broker.
    await Bun.sleep(200);

    // Broker is gone.
    expect(isAlive(brokerPid)).toBe(false);

    // Key regression: the connected client must survive.
    expect(isAlive(clientPid)).toBe(true);
  });

  test("prints 'not running' cleanly when no broker is up", async () => {
    // Deliberately don't startBroker().
    const cli = Bun.spawn(["bun", CLI_SCRIPT, "kill-broker"], {
      env: { ...process.env, PEERS_PORT: String(PORT) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await cli.exited;
    const stdout = await new Response(cli.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/not running/i);
  });
});
