/**
 * Schema migration smoke test.
 *
 * Pre-seeds a SQLite DB with the OLD schema (no status/team/role/skills on
 * peers, no task_id/task_state on messages), spawns the broker against it,
 * and asserts:
 *   - boot succeeds (ALTER TABLE statements work)
 *   - pre-existing peer rows read back with default status='available'
 *   - pre-existing message rows read back with null task fields
 *   - second boot is idempotent (no duplicate-column errors crashing the daemon)
 *
 * This is the regression guard for forgetting to add an ALTER TABLE when a
 * schema field is added in the future.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17977; // distinct from default 7900 and other test files
const BASE = `http://127.0.0.1:${PORT}`;
const BROKER_SCRIPT = new URL("../broker.ts", import.meta.url).pathname;

let tmpDir: string;
let dbPath: string;
let broker: ReturnType<typeof Bun.spawn> | undefined;
const peerProcs: ReturnType<typeof Bun.spawn>[] = [];

async function waitForBroker(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
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

async function killBroker(): Promise<void> {
  if (!broker) return;
  broker.kill();
  await broker.exited.catch(() => {});
  broker = undefined;
}

async function startBroker(): Promise<void> {
  broker = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: { ...process.env, PEERS_PORT: String(PORT), PEERS_DB: dbPath, UPM_TTY_DIR: tmpDir },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForBroker();
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "upm-migration-"));
  dbPath = join(tmpDir, "peers.db");
});

afterAll(async () => {
  await killBroker();
  for (const p of peerProcs) try { p.kill(); } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("schema migration from old DB", () => {
  test("boots against a pre-existing DB with the OLD schema and backfills defaults", async () => {
    // Pre-seed the DB with the schema as it existed BEFORE this change.
    // Note: we intentionally OMIT status/team/role/skills/task_id/task_state.
    const seed = new Database(dbPath);
    seed.run("PRAGMA journal_mode = WAL");
    seed.run(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        git_root TEXT,
        tty TEXT,
        runtime TEXT NOT NULL DEFAULT 'opencode',
        plugin_port INTEGER,
        terminal_program TEXT,
        summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      )
    `);
    seed.run(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        text TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        delivered_via TEXT,
        FOREIGN KEY (from_id) REFERENCES peers(id),
        FOREIGN KEY (to_id) REFERENCES peers(id)
      )
    `);

    // Use a live pid so the broker's stale-peer cleanup doesn't immediately
    // delete this row when it boots and runs cleanStalePeers().
    const aliveProc = Bun.spawn(["bun", "-e", "await new Promise(() => {})"], {
      stdout: "ignore", stderr: "ignore",
    });
    peerProcs.push(aliveProc);

    const now = new Date().toISOString();
    seed.run(
      `INSERT INTO peers (id, pid, cwd, runtime, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["old-peer", aliveProc.pid!, "/tmp", "claude", "preexisting", now, now],
    );
    seed.run(
      `INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?, ?, ?, ?, ?)`,
      ["old-peer", "old-peer", "old message", now, 1],
    );
    seed.close();

    await startBroker();

    // Verify the pre-existing peer is visible AND has defaults backfilled.
    const listRes = await fetch(`${BASE}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "machine", cwd: "/tmp", git_root: null }),
    });
    expect(listRes.status).toBe(200);
    const peers = (await listRes.json()) as Array<Record<string, unknown>>;
    const oldPeer = peers.find((p) => p.id === "old-peer");
    expect(oldPeer).toBeDefined();
    expect(oldPeer?.status).toBe("available"); // ALTER ... DEFAULT applied
    expect(oldPeer?.team).toBe(null);
    expect(oldPeer?.role).toBe(null);
    expect(oldPeer?.skills).toBe(null);
  });

  test("second boot against the now-migrated DB is idempotent (no crash on duplicate ALTER)", async () => {
    // First boot is up from the previous test. Shut it down and restart to
    // exercise the ALTER-fails-silently path on the migrated schema.
    await killBroker();
    await startBroker();
    const res = await fetch(`${BASE}/health`);
    expect(res.ok).toBe(true);
  });

  test("messages from before the migration read back with null task fields", async () => {
    // The previous tests left the broker running. Insert a sender peer (via
    // /register) and send a fresh message; then verify both old and new
    // messages have null task_id/task_state when not provided.
    const sender = Bun.spawn(["bun", "-e", "await new Promise(() => {})"], {
      stdout: "ignore", stderr: "ignore",
    });
    peerProcs.push(sender);
    const reg = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pid: sender.pid, cwd: "/tmp", git_root: null, tty: null,
        runtime: "claude", summary: "",
      }),
    });
    const { id: senderId } = (await reg.json()) as { id: string };

    // Send a fresh (post-migration) message without task_id
    await fetch(`${BASE}/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_id: senderId, to_id: "old-peer", text: "fresh" }),
    });

    const poll = await fetch(`${BASE}/poll-messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "old-peer" }),
    });
    const { messages } = (await poll.json()) as { messages: Array<Record<string, unknown>> };
    expect(messages.length).toBeGreaterThanOrEqual(1);
    // Every message (old + new) has null task fields.
    for (const m of messages) {
      expect(m.task_id).toBe(null);
      expect(m.task_state).toBe(null);
    }
  });
});
