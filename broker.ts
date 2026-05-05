#!/usr/bin/env bun
/**
 * unified-peers-mcp broker daemon
 *
 * One localhost HTTP server (default port 7900) backed by SQLite. Tracks all
 * registered peers across runtimes (opencode, claude, …) and routes messages
 * between them.
 *
 * Auto-launched by each runtime's MCP server if not already running.
 * Run directly: bun broker.ts
 *
 * Adding a new runtime: see shared/runtimes.ts.
 */

import { Database } from "bun:sqlite";
import {
  getInstantDelivery,
  isValidRuntime,
  RUNTIMES,
} from "./shared/runtimes.ts";
import type {
  HeartbeatRequest,
  ListPeersRequest,
  Message,
  Peer,
  PollMessagesRequest,
  PollMessagesResponse,
  RegisterPluginRequest,
  RegisterRequest,
  RegisterResponse,
  SendMessageRequest,
  SendMessageResponse,
  SetSummaryRequest,
} from "./shared/types.ts";

const PORT = parseInt(
  process.env.PEERS_PORT ?? process.env.OPENCODE_PEERS_PORT ?? process.env.CLAUDE_PEERS_PORT ?? "7900",
  10,
);
const DB_PATH =
  process.env.PEERS_DB ??
  process.env.OPENCODE_PEERS_DB ??
  process.env.CLAUDE_PEERS_DB ??
  `${process.env.HOME}/.peers.db`;

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    runtime TEXT NOT NULL DEFAULT 'opencode',
    plugin_port INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Backfill columns for older DBs.
for (const stmt of [
  "ALTER TABLE peers ADD COLUMN runtime TEXT NOT NULL DEFAULT 'opencode'",
  "ALTER TABLE peers ADD COLUMN plugin_port INTEGER",
]) {
  try { db.run(stmt); } catch { /* column already exists */ }
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
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

try { db.run("ALTER TABLE messages ADD COLUMN delivered_via TEXT"); } catch {}

function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, runtime, plugin_port, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updatePluginPort = db.prepare(`UPDATE peers SET plugin_port = ? WHERE id = ?`);
const clearPluginPort = db.prepare(`UPDATE peers SET plugin_port = NULL WHERE id = ?`);
const selectPeerByPid = db.prepare(`SELECT id FROM peers WHERE pid = ?`);
const updateLastSeen = db.prepare(`UPDATE peers SET last_seen = ? WHERE id = ?`);
const updateSummary = db.prepare(`UPDATE peers SET summary = ? WHERE id = ?`);
const deletePeer = db.prepare(`DELETE FROM peers WHERE id = ?`);
const selectAllPeers = db.prepare(`SELECT * FROM peers`);
const selectPeersByDirectory = db.prepare(`SELECT * FROM peers WHERE cwd = ?`);
const selectPeersByGitRoot = db.prepare(`SELECT * FROM peers WHERE git_root = ?`);
const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, delivered_via)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);
const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1, delivered_via = COALESCE(delivered_via, 'poll') WHERE id = ?
`);
const selectLastDeliveryToPeer = db.prepare(`
  SELECT sent_at, delivered_via FROM messages
  WHERE to_id = ? AND delivered = 1
  ORDER BY id DESC LIMIT 1
`);

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

const pendingPlugins = new Map<number, number>();

function handleRegister(body: RegisterRequest): RegisterResponse | { error: string } {
  if (!isValidRuntime(body.runtime)) {
    return { error: `unknown runtime "${body.runtime}". valid: ${RUNTIMES.join(", ")}` };
  }
  const id = generateId();
  const now = new Date().toISOString();

  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) deletePeer.run(existing.id);

  let pluginPort = body.plugin_port ?? null;
  if (!pluginPort) {
    const pendingPort = pendingPlugins.get(body.pid);
    if (pendingPort) {
      pluginPort = pendingPort;
      pendingPlugins.delete(body.pid);
    }
  }

  insertPeer.run(
    id,
    body.pid,
    body.cwd,
    body.git_root,
    body.tty,
    body.runtime,
    pluginPort,
    body.summary,
    now,
    now,
  );
  return { id };
}

function handleRegisterPlugin(body: RegisterPluginRequest): void {
  const existing = selectPeerByPid.all(body.opencode_pid) as { id: string }[];
  if (existing.length > 0) {
    for (const peer of existing) {
      updatePluginPort.run(body.plugin_port, peer.id);
    }
  } else {
    pendingPlugins.set(body.opencode_pid, body.plugin_port);
  }
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];
  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      peers = body.git_root
        ? (selectPeersByGitRoot.all(body.git_root) as Peer[])
        : (selectPeersByDirectory.all(body.cwd) as Peer[]);
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  if (body.exclude_id) peers = peers.filter((p) => p.id !== body.exclude_id);
  if (body.runtime) peers = peers.filter((p) => p.runtime === body.runtime);

  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      deletePeer.run(p.id);
      return false;
    }
  });
}

async function handleSendMessage(body: SendMessageRequest): Promise<SendMessageResponse> {
  const recipient = db.query("SELECT * FROM peers WHERE id = ?").get(body.to_id) as Peer | null;
  if (!recipient) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  const sender = db.query("SELECT summary, cwd, git_root FROM peers WHERE id = ?")
    .get(body.from_id) as { summary: string; cwd: string; git_root: string | null } | null;
  const ctx = {
    senderSummary: sender?.summary ?? "",
    senderCwd: sender?.cwd ?? "",
    senderGitRoot: sender?.git_root ?? null,
  };

  const now = new Date().toISOString();
  const handler = getInstantDelivery(recipient.runtime);

  if (handler) {
    const result = await handler(recipient, body.from_id, body.text, ctx);
    if (result.clear_runtime_state) {
      // Currently runtime-state-to-clear == plugin_port. If a future runtime
      // adds its own connection field, extend this with a runtime-specific clear.
      clearPluginPort.run(body.to_id);
    }
    if (result.ok) {
      try {
        insertMessage.run(body.from_id, body.to_id, body.text, now, 1, recipient.runtime);
      } catch {}
      return { ok: true, delivered_via: "instant", latency_ms: result.latency_ms };
    }
    // Handler tried and failed → polling fallback
    try {
      insertMessage.run(body.from_id, body.to_id, body.text, now, 0, null);
    } catch {}
    return { ok: true, delivered_via: "poll_after_failure", latency_ms: result.latency_ms };
  }

  // No instant handler for this runtime → straight to polling
  try {
    insertMessage.run(body.from_id, body.to_id, body.text, now, 0, null);
  } catch {}
  return { ok: true, delivered_via: "poll", latency_ms: 0 };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  for (const msg of messages) markDelivered.run(msg.id);
  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

function handleDiagnose(): unknown {
  const peers = selectAllPeers.all() as Peer[];
  const enriched = peers.map((p) => {
    let alive = false;
    try { process.kill(p.pid, 0); alive = true; } catch {}
    const lastDelivery = selectLastDeliveryToPeer.get(p.id) as
      | { sent_at: string; delivered_via: string | null } | null;
    return {
      id: p.id,
      pid: p.pid,
      pid_alive: alive,
      cwd: p.cwd,
      git_root: p.git_root,
      runtime: p.runtime,
      summary: p.summary,
      plugin_port: p.plugin_port,
      last_seen: p.last_seen,
      last_delivery_at: lastDelivery?.sent_at ?? null,
      last_delivery_via: lastDelivery?.delivered_via ?? null,
    };
  });
  return {
    broker: { port: PORT, db_path: DB_PATH, peers_count: peers.length, runtimes: RUNTIMES },
    peers: enriched,
  };
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      if (path === "/diagnose") {
        return Response.json(handleDiagnose());
      }
      if (path === "/runtimes") {
        return Response.json({ runtimes: RUNTIMES });
      }
      return new Response("unified-peers-mcp broker", { status: 200 });
    }

    try {
      const body = await req.json();
      switch (path) {
        case "/register": {
          const result = handleRegister(body as RegisterRequest);
          if ("error" in result) return Response.json(result, { status: 400 });
          return Response.json(result);
        }
        case "/register-plugin":
          handleRegisterPlugin(body as RegisterPluginRequest);
          return Response.json({ ok: true });
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(await handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
});

console.error(`[unified-peers-mcp broker] listening on 127.0.0.1:${PORT}  db=${DB_PATH}  runtimes=${RUNTIMES.join(",")}`);
