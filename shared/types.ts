import type { Runtime } from "./runtimes.ts";

export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  runtime: Runtime;
  /** opencode-specific: HTTP port of the in-app helper plugin. NULL for runtimes without one. */
  plugin_port: number | null;
  summary: string;
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
}

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  runtime: Runtime;
  /** Optional, runtime-specific. Currently only set by opencode peers. */
  plugin_port?: number | null;
  summary: string;
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

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
  /** Optional filter: only return peers of the given runtime. */
  runtime?: Runtime;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  /** "instant" when the runtime's instant handler succeeded, "poll" when queued for polling fallback. */
  delivered_via?: "instant" | "poll" | "poll_after_failure";
  latency_ms?: number;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}
