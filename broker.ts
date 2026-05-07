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
import { formatTitle } from "./shared/terminals/format.ts";
import { getAdapter } from "./shared/terminals/index.ts";
import type {
  ClearTitleRequest,
  HeartbeatRequest,
  ListPeersRequest,
  Message,
  Peer,
  PollMessagesRequest,
  PollMessagesResponse,
  RegisterPluginRequest,
  RegisterRequest,
  RegisterResponse,
  SendMessageMultiRequest,
  SendMessageMultiResponse,
  SendMessageMultiResult,
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
    terminal_program TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Backfill columns for older DBs. Each ALTER throws "duplicate column" on
// already-migrated DBs; the catch lets us re-run safely on every startup.
for (const stmt of [
  "ALTER TABLE peers ADD COLUMN runtime TEXT NOT NULL DEFAULT 'opencode'",
  "ALTER TABLE peers ADD COLUMN plugin_port INTEGER",
  "ALTER TABLE peers ADD COLUMN terminal_program TEXT",
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
  INSERT INTO peers (id, pid, cwd, git_root, tty, runtime, plugin_port, terminal_program, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    body.terminal_program ?? null,
    body.summary,
    now,
    now,
  );

  // Fire-and-forget terminal title write. The adapter is selected from the
  // peer's TERM_PROGRAM (open set) and falls back to generic OSC 2 for
  // unknown terminals. We don't await because title hygiene is best-effort
  // and registration must stay fast.
  const adapter = getAdapter(body.terminal_program ?? null);
  void adapter.writeTitle(
    body.tty,
    formatTitle({ id, summary: body.summary, runtime: body.runtime }),
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

  // Fire-and-forget terminal title write reflecting the new summary.
  // Lookup is needed because this handler doesn't receive tty/runtime/
  // terminal_program in the request — those live on the peer row.
  const peer = db.query("SELECT * FROM peers WHERE id = ?").get(body.id) as Peer | null;
  if (peer) {
    void getAdapter(peer.terminal_program).writeTitle(peer.tty, formatTitle(peer));
  }
}

/**
 * Reset a peer's terminal title. Called by MCP servers on graceful shutdown
 * so the user isn't left looking at a stale agent summary.
 *
 * No-ops silently if the peer doesn't exist (already unregistered) or has
 * no tty. Title hygiene is best-effort.
 */
function handleClearTitle(body: ClearTitleRequest): void {
  const peer = db.query("SELECT tty, terminal_program FROM peers WHERE id = ?").get(body.id) as
    | { tty: string | null; terminal_program: string | null }
    | null;
  if (peer) {
    void getAdapter(peer.terminal_program).clearTitle(peer.tty);
  }
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

interface SenderContext {
  senderSummary: string;
  senderCwd: string;
  senderGitRoot: string | null;
}

function loadSenderContext(fromId: string): SenderContext {
  const sender = db.query("SELECT summary, cwd, git_root FROM peers WHERE id = ?")
    .get(fromId) as { summary: string; cwd: string; git_root: string | null } | null;
  return {
    senderSummary: sender?.summary ?? "",
    senderCwd: sender?.cwd ?? "",
    senderGitRoot: sender?.git_root ?? null,
  };
}

/**
 * Deliver `text` to a single recipient. Used by both the single-send endpoint
 * (`/send-message`) and the multi-send endpoint (`/send-message-multi`).
 *
 * Returns the same fields as SendMessageResponse minus the response wrapper —
 * callers attach `to_id` / overall `ok` themselves.
 */
async function deliverToOne(
  toId: string,
  fromId: string,
  text: string,
  ctx: SenderContext,
  now: string,
): Promise<{ ok: boolean; error?: string; delivered_via?: "instant" | "poll" | "poll_after_failure"; latency_ms?: number }> {
  const recipient = db.query("SELECT * FROM peers WHERE id = ?").get(toId) as Peer | null;
  if (!recipient) {
    return { ok: false, error: `Peer ${toId} not found` };
  }

  const handler = getInstantDelivery(recipient.runtime);

  if (handler) {
    const result = await handler(recipient, fromId, text, ctx);
    if (result.clear_runtime_state) {
      // Currently runtime-state-to-clear == plugin_port. If a future runtime
      // adds its own connection field, extend this with a runtime-specific clear.
      clearPluginPort.run(toId);
    }
    if (result.ok) {
      try {
        insertMessage.run(fromId, toId, text, now, 1, recipient.runtime);
      } catch {}
      return { ok: true, delivered_via: "instant", latency_ms: result.latency_ms };
    }
    // Handler tried and failed → polling fallback
    try {
      insertMessage.run(fromId, toId, text, now, 0, null);
    } catch {}
    return { ok: true, delivered_via: "poll_after_failure", latency_ms: result.latency_ms };
  }

  // No instant handler for this runtime → straight to polling
  try {
    insertMessage.run(fromId, toId, text, now, 0, null);
  } catch {}
  return { ok: true, delivered_via: "poll", latency_ms: 0 };
}

async function handleSendMessage(body: SendMessageRequest): Promise<SendMessageResponse> {
  const ctx = loadSenderContext(body.from_id);
  const now = new Date().toISOString();
  return deliverToOne(body.to_id, body.from_id, body.text, ctx, now);
}

async function handleSendMessageMulti(body: SendMessageMultiRequest): Promise<SendMessageMultiResponse> {
  if (!Array.isArray(body.to_ids) || body.to_ids.length === 0) {
    return { ok: false, results: [] };
  }
  const ctx = loadSenderContext(body.from_id);
  const now = new Date().toISOString();

  const results = await Promise.all(
    body.to_ids.map(async (toId): Promise<SendMessageMultiResult> => {
      const r = await deliverToOne(toId, body.from_id, body.text, ctx, now);
      return { to_id: toId, ...r };
    }),
  );
  return { ok: results.every((r) => r.ok), results };
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
        case "/clear-title":
          handleClearTitle(body as ClearTitleRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(await handleSendMessage(body as SendMessageRequest));
        case "/send-message-multi":
          return Response.json(await handleSendMessageMulti(body as SendMessageMultiRequest));
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
