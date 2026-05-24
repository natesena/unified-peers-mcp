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
import {
  isPeerStatus,
  isTaskState,
  isValidSkillsInput,
  parseSkills,
  serializeSkills,
} from "./shared/status.ts";
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
  RetitleRequest,
  SendMessageMultiRequest,
  SendMessageMultiResponse,
  SendMessageMultiResult,
  SendMessageRequest,
  SendMessageResponse,
  SetStatusRequest,
  SetSummaryRequest,
  SetTaskStateRequest,
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
    status TEXT NOT NULL DEFAULT 'available',
    team TEXT,
    role TEXT,
    skills TEXT,
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
  "ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'available'",
  "ALTER TABLE peers ADD COLUMN team TEXT",
  "ALTER TABLE peers ADD COLUMN role TEXT",
  "ALTER TABLE peers ADD COLUMN skills TEXT",
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
    task_id TEXT,
    task_state TEXT,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

try { db.run("ALTER TABLE messages ADD COLUMN delivered_via TEXT"); } catch {}
try { db.run("ALTER TABLE messages ADD COLUMN task_id TEXT"); } catch {}
try { db.run("ALTER TABLE messages ADD COLUMN task_state TEXT"); } catch {}

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
  INSERT INTO peers (id, pid, cwd, git_root, tty, runtime, plugin_port, terminal_program, summary, status, team, role, skills, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, delivered_via, task_id, task_state)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
const selectAnyTaskRow = db.prepare(`SELECT id FROM messages WHERE task_id = ? LIMIT 1`);
const selectTaskRowForRecipient = db.prepare(
  `SELECT id FROM messages WHERE task_id = ? AND to_id = ? LIMIT 1`,
);
const updateTaskState = db.prepare(
  `UPDATE messages SET task_state = ? WHERE task_id = ? AND to_id = ?`,
);

/**
 * Convert a raw SQLite row to the Peer shape callers expect.
 *
 * The DB stores `skills` as a JSON-encoded TEXT column so the schema stays
 * simple TEXT/INTEGER. Callers always see `string[] | null`. Doing the parse
 * here means every read path (list-peers, diagnose, set-summary lookup, …)
 * gets consistent output without each callsite repeating the parse.
 */
function rowToPeer(row: Record<string, unknown>): Peer {
  return {
    ...(row as unknown as Peer),
    skills: parseSkills(row.skills as string | null),
  };
}

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
  // Validate optional AgentCard fields before we insert, so partial-write
  // anomalies (one bad field nulling everything) can't happen.
  if (body.status !== undefined && !isPeerStatus(body.status)) {
    return { error: `invalid status "${String(body.status)}". valid: available, busy, away` };
  }
  if (body.skills !== undefined && !isValidSkillsInput(body.skills)) {
    return { error: "invalid skills: must be an array of strings or null" };
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
    body.status ?? "available",
    body.team ?? null,
    body.role ?? null,
    serializeSkills(body.skills),
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
 * Partial update of a peer's AgentCard-style fields. Each optional key in
 * SetStatusRequest is applied iff present in the body; explicit `null` clears
 * the column (only valid for the nullable team/role/skills — status is NOT NULL).
 *
 * Returns { ok: true } / 404 / 400. Validation runs first so an invalid status
 * doesn't partially apply other fields.
 */
function handleSetStatus(body: SetStatusRequest): { ok: true } | { error: string; status: number } {
  const exists = db.query("SELECT id FROM peers WHERE id = ?").get(body.id) as { id: string } | null;
  if (!exists) return { error: `peer ${body.id} not found`, status: 404 };

  if ("status" in body && body.status !== undefined) {
    if (body.status === null || !isPeerStatus(body.status)) {
      return {
        error: `invalid status "${String(body.status)}". valid: available, busy, away`,
        status: 400,
      };
    }
  }
  if ("skills" in body && body.skills !== undefined && !isValidSkillsInput(body.skills)) {
    return { error: "invalid skills: must be an array of strings or null", status: 400 };
  }
  // team and role are free-text. Reject only obvious wrong-types — they must be
  // string or null (or omitted). Strings of any content (incl. empty) are kept
  // verbatim; clearing is null.
  for (const key of ["team", "role"] as const) {
    if (key in body && body[key] !== undefined && body[key] !== null && typeof body[key] !== "string") {
      return { error: `invalid ${key}: must be a string or null`, status: 400 };
    }
  }

  const sets: string[] = [];
  const args: (string | null)[] = [];
  if ("status" in body && body.status !== undefined) {
    sets.push("status = ?");
    args.push(body.status);
  }
  if ("team" in body && body.team !== undefined) {
    sets.push("team = ?");
    args.push(body.team);
  }
  if ("role" in body && body.role !== undefined) {
    sets.push("role = ?");
    args.push(body.role);
  }
  if ("skills" in body && body.skills !== undefined) {
    sets.push("skills = ?");
    args.push(serializeSkills(body.skills));
  }
  if (sets.length === 0) return { ok: true }; // no-op read-modify-write

  args.push(body.id);
  db.run(`UPDATE peers SET ${sets.join(", ")} WHERE id = ?`, args);
  return { ok: true };
}

/**
 * Worker transitions a task they own to a new state. Ownership =
 * caller's id (body.id) appears as `to_id` on at least one row tagged
 * with task_id. Returns 404 if the task doesn't exist at all, 403 if
 * it exists but the caller isn't a recipient.
 */
function handleSetTaskState(
  body: SetTaskStateRequest,
): { ok: true } | { error: string; status: number } {
  if (!isTaskState(body.state)) {
    return {
      error: `invalid task state "${String(body.state)}". valid: working, completed, failed, canceled`,
      status: 400,
    };
  }
  if (typeof body.task_id !== "string" || body.task_id.length === 0) {
    return { error: "task_id must be a non-empty string", status: 400 };
  }
  if (typeof body.id !== "string" || body.id.length === 0) {
    return { error: "id (caller peer id) is required", status: 400 };
  }
  const anyRow = selectAnyTaskRow.get(body.task_id) as { id: number } | null;
  if (!anyRow) return { error: `task ${body.task_id} not found`, status: 404 };
  const ownedRow = selectTaskRowForRecipient.get(body.task_id, body.id) as { id: number } | null;
  if (!ownedRow) {
    return {
      error: `peer ${body.id} is not a recipient of task ${body.task_id}`,
      status: 403,
    };
  }
  updateTaskState.run(body.state, body.task_id, body.id);
  return { ok: true };
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

/**
 * Re-assert a peer's current title. Used when the title has been clobbered
 * (long ssh session, tmux without set-titles, another tool's OSC writes).
 *
 * Returns 404 if the peer is unknown so the CLI can give a clear error;
 * otherwise the title write is fire-and-forget.
 */
function handleRetitle(body: RetitleRequest): { ok: boolean; error?: string } {
  const peer = db.query("SELECT * FROM peers WHERE id = ?").get(body.id) as Peer | null;
  if (!peer) return { ok: false, error: `peer ${body.id} not found` };
  void getAdapter(peer.terminal_program).writeTitle(peer.tty, formatTitle(peer));
  return { ok: true };
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let rawRows: Record<string, unknown>[];
  switch (body.scope) {
    case "machine":
      rawRows = selectAllPeers.all() as Record<string, unknown>[];
      break;
    case "directory":
      rawRows = selectPeersByDirectory.all(body.cwd) as Record<string, unknown>[];
      break;
    case "repo":
      rawRows = body.git_root
        ? (selectPeersByGitRoot.all(body.git_root) as Record<string, unknown>[])
        : (selectPeersByDirectory.all(body.cwd) as Record<string, unknown>[]);
      break;
    default:
      rawRows = selectAllPeers.all() as Record<string, unknown>[];
  }

  let peers = rawRows.map(rowToPeer);

  if (body.exclude_id) peers = peers.filter((p) => p.id !== body.exclude_id);
  if (body.runtime) peers = peers.filter((p) => p.runtime === body.runtime);
  if (body.status) peers = peers.filter((p) => p.status === body.status);
  if (body.team) peers = peers.filter((p) => p.team === body.team);
  // Skill filter: exact string match within the parsed skills array. Avoids
  // the JSON-substring false positive (`rust` vs `rust-analyzer`) we'd get
  // from a naive LIKE. With small N (<= a few hundred peers) the in-memory
  // pass is cheaper than wiring SQLite's json_each through the prepared-
  // statement layer.
  if (body.skill) peers = peers.filter((p) => p.skills?.includes(body.skill!) ?? false);

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
  taskId: string | null,
): Promise<{ ok: boolean; error?: string; delivered_via?: "instant" | "poll" | "poll_after_failure"; latency_ms?: number }> {
  const recipient = db.query("SELECT * FROM peers WHERE id = ?").get(toId) as Peer | null;
  if (!recipient) {
    return { ok: false, error: `Peer ${toId} not found` };
  }

  // A task-tagged message starts as 'working'; non-task messages have no state.
  const taskState = taskId ? "working" : null;

  const handler = getInstantDelivery(recipient.runtime);

  if (handler) {
    const result = await handler(recipient, fromId, text, ctx);
    if (result.clear_runtime_state) {
      // Currently runtime-state-to-clear == plugin_port. If a future runtime
      // adds its own connection field, extend this with a runtime-specific clear.
      clearPluginPort.run(toId);
    }
    if (result.ok) {
      // For opencode, "instant" delivery only confirms the plugin's HTTP
      // endpoint returned 200 — NOT that the LLM saw the message. The TUI
      // appendPrompt/submitPrompt bus events are dropped silently while the
      // session is mid-generation. Keep the poll path open (delivered=0) so
      // the receiver's MCP server picks the message up via /poll-messages and
      // surfaces it to the LLM via the check_messages tool. The poll handler
      // marks delivered=1 on first drain (handlePollMessages, below), so this
      // doesn't cause re-delivery. Other runtimes (claude) push via
      // mcp.notification synchronously and don't need the fallback. See upm-uab.
      const markedDelivered = recipient.runtime === "opencode" ? 0 : 1;
      try {
        insertMessage.run(fromId, toId, text, now, markedDelivered, recipient.runtime, taskId, taskState);
      } catch {}
      return { ok: true, delivered_via: "instant", latency_ms: result.latency_ms };
    }
    // Handler tried and failed → polling fallback
    try {
      insertMessage.run(fromId, toId, text, now, 0, null, taskId, taskState);
    } catch {}
    return { ok: true, delivered_via: "poll_after_failure", latency_ms: result.latency_ms };
  }

  // No instant handler for this runtime → straight to polling
  try {
    insertMessage.run(fromId, toId, text, now, 0, null, taskId, taskState);
  } catch {}
  return { ok: true, delivered_via: "poll", latency_ms: 0 };
}

async function handleSendMessage(body: SendMessageRequest): Promise<SendMessageResponse> {
  const ctx = loadSenderContext(body.from_id);
  const now = new Date().toISOString();
  return deliverToOne(body.to_id, body.from_id, body.text, ctx, now, body.task_id ?? null);
}

async function handleSendMessageMulti(body: SendMessageMultiRequest): Promise<SendMessageMultiResponse> {
  if (!Array.isArray(body.to_ids) || body.to_ids.length === 0) {
    return { ok: false, results: [] };
  }
  const ctx = loadSenderContext(body.from_id);
  const now = new Date().toISOString();
  const taskId = body.task_id ?? null;

  const results = await Promise.all(
    body.to_ids.map(async (toId): Promise<SendMessageMultiResult> => {
      const r = await deliverToOne(toId, body.from_id, body.text, ctx, now, taskId);
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
  const rawRows = selectAllPeers.all() as Record<string, unknown>[];
  const peers = rawRows.map(rowToPeer);
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
      status: p.status,
      team: p.team,
      role: p.role,
      skills: p.skills,
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
        case "/set-status": {
          const result = handleSetStatus(body as SetStatusRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/set-task-state": {
          const result = handleSetTaskState(body as SetTaskStateRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
        case "/clear-title":
          handleClearTitle(body as ClearTitleRequest);
          return Response.json({ ok: true });
        case "/retitle": {
          const result = handleRetitle(body as RetitleRequest);
          return Response.json(result, { status: result.ok ? 200 : 404 });
        }
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
