import type { Runtime } from "./runtimes.ts";

export type PeerId = string;

/**
 * Availability/working state of a peer. Used by orchestrators to decide who to
 * task. Typed enum; free-text role/team/skills live in their own fields.
 */
export const PEER_STATUSES = ["available", "busy", "away"] as const;
export type PeerStatus = (typeof PEER_STATUSES)[number];

/**
 * Lifecycle of a task-tagged message. `working` is the implicit initial state
 * when a sender attaches a `task_id`; the recipient transitions it via
 * /set-task-state. We intentionally do NOT enforce state-machine transitions
 * (e.g. completed → working is allowed) in v1 — keep callers honest.
 */
export const TASK_STATES = ["working", "completed", "failed", "canceled"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  runtime: Runtime;
  /** opencode-specific: HTTP port of the in-app helper plugin. NULL for runtimes without one. */
  plugin_port: number | null;
  /**
   * Raw value of the agent process's TERM_PROGRAM env var when it registered —
   * the open set of strings a terminal emulator may set. Common values:
   * "Ghostty", "iTerm.app", "Apple_Terminal", "WezTerm", "tmux", "vscode".
   * NULL when the agent was not running under an identifiable terminal.
   *
   * This is the *raw* string. Adapter selection happens in
   * shared/terminals/index.ts via getAdapter(), which maps known values to
   * specialized adapters and falls back to generic for everything else.
   * Don't conflate this field (open set) with adapter identifiers (closed set).
   */
  terminal_program: string | null;
  summary: string;
  /** Availability — typed enum. Defaults to "available" on register. */
  status: PeerStatus;
  /** Free-text team label. Two peers with the same `team` are on the same team. */
  team: string | null;
  /** Free-text role (e.g. "orchestrator", "worker", "reviewer"). No enforced vocabulary. */
  role: string | null;
  /** Free-text capability tags (e.g. ["rust", "sql"]). No enforced vocabulary. */
  skills: string[] | null;
  registered_at: string;
  last_seen: string;
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string;
  delivered: boolean;
  delivered_via: string | null;
  /** Optional task identifier — sender-chosen. NULL for non-task messages. */
  task_id: string | null;
  /** Task lifecycle state — NULL iff task_id is NULL; otherwise one of TASK_STATES. */
  task_state: TaskState | null;
}

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  runtime: Runtime;
  /** Optional, runtime-specific. Currently only set by opencode peers. */
  plugin_port?: number | null;
  /** Raw TERM_PROGRAM env value at the time of registration. See Peer.terminal_program. */
  terminal_program?: string | null;
  summary: string;
  /** Optional initial AgentCard fields. Defaults: status='available', team=role=skills=null. */
  status?: PeerStatus;
  team?: string | null;
  role?: string | null;
  skills?: string[] | null;
}

export interface RegisterPluginRequest {
  /** PID of the host process whose helper is registering — for opencode this is opencode's PID, not the MCP server's. */
  opencode_pid: number;
  plugin_port: number;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

/**
 * Partial update of AgentCard-style identity fields. Each optional key:
 *   - omitted     → no change
 *   - present, non-null → set to that value
 *   - present, null     → clear (only valid for nullable columns: team/role/skills)
 *
 * `status` is NOT NULL in the DB; passing `status: null` is a validation error.
 */
export interface SetStatusRequest {
  id: PeerId;
  status?: PeerStatus;
  team?: string | null;
  role?: string | null;
  skills?: string[] | null;
}

/**
 * Worker reports progress on a task they own. Ownership = the caller's peer id
 * appears as `to_id` on at least one message row tagged with this task_id.
 * The broker updates every row matching (task_id, to_id=id).
 */
export interface SetTaskStateRequest {
  /** Caller's peer id. Must be a recipient of the task. */
  id: PeerId;
  task_id: string;
  state: TaskState;
}

/** Request body for POST /clear-title — resets the peer's terminal window title. */
export interface ClearTitleRequest {
  id: PeerId;
}

/**
 * Request body for POST /retitle — re-asserts the peer's current title.
 * Useful when the title has been clobbered (e.g. by a long ssh session, a
 * tmux config without `set-titles`, or another tool's OSC writes).
 */
export interface RetitleRequest {
  id: PeerId;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
  /** Optional filter: only return peers of the given runtime. */
  runtime?: Runtime;
  /** Optional filter: only return peers with this status. */
  status?: PeerStatus;
  /** Optional filter: only return peers on this team (exact match). */
  team?: string;
  /** Optional filter: only return peers whose skills array contains this exact string. */
  skill?: string;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  /** Optional task tag. When set, the persisted message starts at task_state='working'. */
  task_id?: string | null;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  /** "instant" when the runtime's instant handler succeeded, "poll" when queued for polling fallback. */
  delivered_via?: "instant" | "poll" | "poll_after_failure";
  latency_ms?: number;
}

export interface SendMessageMultiRequest {
  from_id: PeerId;
  to_ids: PeerId[];
  text: string;
  /** Optional task tag — shared by every recipient row but tracked independently per recipient. */
  task_id?: string | null;
}

export interface SendMessageMultiResult {
  to_id: PeerId;
  ok: boolean;
  error?: string;
  delivered_via?: "instant" | "poll" | "poll_after_failure";
  latency_ms?: number;
}

export interface SendMessageMultiResponse {
  /** True iff every recipient in `results` has ok=true. */
  ok: boolean;
  /** One entry per requested to_id, in input order. */
  results: SendMessageMultiResult[];
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}
