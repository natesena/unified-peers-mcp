#!/usr/bin/env bun
/**
 * claude runtime — MCP server.
 *
 * Spawned by Claude Code as a stdio MCP server, one per session.
 * Connects to the unified-peers-mcp broker, registers with runtime: "claude",
 * polls for inbound messages, and pushes them into Claude Code via the
 * experimental claude/channel notification.
 *
 * Usage (one-time):
 *   claude mcp add --scope user --transport stdio unified-peers -- \
 *     bun /path/to/unified-peers-mcp/runtimes/claude/server.ts
 *
 * Then run Claude Code with the channel:
 *   claude --dangerously-load-development-channels server:unified-peers
 *
 * The name "unified-peers" must match in three places: the `claude mcp add`
 * entry name, the `--dangerously-load-development-channels server:NAME` flag,
 * and the `Server({name})` constructor below. If they disagree, Claude Code
 * silently drops every channel notification ("server X not in --channels list").
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  SendMessageMultiResponse,
} from "../../shared/types.ts";
import { PEER_STATUSES, TASK_STATES } from "../../shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "../../shared/summarize.ts";

const BROKER_PORT = parseInt(
  process.env.PEERS_PORT ?? process.env.CLAUDE_PEERS_PORT ?? "7900",
  10,
);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("../../broker.ts", import.meta.url).pathname;

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }
  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

function log(msg: string) {
  console.error(`[unified-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") return tty;
    }
  } catch {}
  return null;
}

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

const mcp = new Server(
  { name: "unified-peers", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the unified-peers network. Other Claude Code instances on this machine — and any opencode windows running with opencode-peers — can see you and send you messages.

IMPORTANT: When you receive a <channel source="unified-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with to_ids: [their from_id].

Available tools:
- list_peers: Discover other peers across runtimes (scope: machine/directory/repo). Optionally filter by status/team/skill to find specific peers.
- send_message: Send a message to one or more peers by ID. Pass to_ids as an array — use a single-element array for one recipient, or several IDs to fan out the same message in one call. Optionally tag with task_id when assigning trackable work.
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers).
- set_status: Update your AgentCard — availability (available/busy/away), team membership, role, and skills. Other peers (especially orchestrators) use these to pick who to task.
- set_task_state: As a worker, transition a task you received to working/completed/failed/canceled. The orchestrator who sent the task sees this state via list_peers or message history.
- check_messages: Manually check for new messages.

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.

## Orchestrator pattern

To coordinate a multi-agent task:
1. Declare yourself: set_status(status='busy', team='<task-name>', role='orchestrator', skills=[...])
2. Find workers: list_peers(status='available', skill='<needed skill>')
3. Assign work: send_message(to_ids=[...], message='do X', task_id='<task-name>-001'); also ask each worker to set_status(status='busy', team='<task-name>', role='worker')
4. Workers transition on done: set_task_state(task_id='<task-name>-001', state='completed')
5. Everyone resets: set_status(status='available', team=null, role=null)`,
  }
);

export const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other peers running on this machine across all runtimes (Claude Code and opencode). Returns their ID, runtime, working directory, git repo, summary, status, team, role, and skills. Optionally filter by status, team, or skill to narrow the result — useful for orchestrators looking for available workers with a specific capability.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository.',
        },
        status: {
          type: "string" as const,
          enum: [...PEER_STATUSES],
          description:
            'Optional. Only return peers with this status (e.g. "available" to find free workers).',
        },
        team: {
          type: "string" as const,
          description: "Optional. Only return peers on this team (exact-match free-text label).",
        },
        skill: {
          type: "string" as const,
          description:
            'Optional. Only return peers whose skills array contains this exact string (e.g. "rust").',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to one or more peers by ID. Pass `to_ids: [\"abc\"]` for a single peer, or `to_ids: [\"abc\", \"def\", ...]` to fan out to several peers in one call (the same message is delivered to each). Routed via the unified-peers-mcp broker — instant for runtimes with a push handler, otherwise queued for ~1s polling. Each recipient is delivered to independently; one failure does not block the others. Optionally pass `task_id` to tag the message as trackable work — recipients can then transition it via set_task_state and you can see progress via list_peers or message history.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          minItems: 1,
          description:
            "Peer IDs to send to (from list_peers). Use a one-element array for a single recipient.",
        },
        message: {
          type: "string" as const,
          description: "The message to send. The same text goes to every recipient.",
        },
        task_id: {
          type: "string" as const,
          description:
            'Optional. Tag this message as a trackable task. The recipient(s) start at task_state="working" and report progress via set_task_state. Choose a stable string like "auth-refactor-001".',
        },
      },
      required: ["to_ids", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. Visible to other peers when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "set_status",
    description:
      "Update your AgentCard fields: availability (status), team membership, role, and skills. Partial update — fields you omit are unchanged; passing null explicitly clears team/role/skills. status cannot be cleared (always one of available/busy/away). Other peers (especially orchestrators) use these to decide who to task. Convention: status='available' = free to take work; team='<task-name>' = working on a shared effort; role='orchestrator' or 'worker'; skills=['rust','sql'] = capabilities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string" as const,
          enum: [...PEER_STATUSES],
          description:
            'Your availability. "available" = free to take new work; "busy" = currently on a task; "away" = not actively monitoring.',
        },
        team: {
          type: ["string", "null"] as unknown as "string",
          description:
            "Free-text team label. Two peers with the same value are on the same team. Pass null to clear.",
        },
        role: {
          type: ["string", "null"] as unknown as "string",
          description:
            'Free-text role. Common values: "orchestrator", "worker", "reviewer". Pass null to clear.',
        },
        skills: {
          type: ["array", "null"] as unknown as "array",
          items: { type: "string" as const },
          description:
            'Free-text capability tags (e.g. ["rust","sql","frontend"]). Other peers filter by these via list_peers. Pass null to clear.',
        },
      },
    },
  },
  {
    name: "set_task_state",
    description:
      "As the recipient of a task-tagged message, transition the task to a new state. Only the recipient peer(s) can call this for a given task_id. Use this so the orchestrator who sent the task can see when you are done. Valid states: working (in progress), completed (done successfully), failed (could not complete), canceled (abandoned).",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string" as const,
          description: "The task_id from the message you received.",
        },
        state: {
          type: "string" as const,
          enum: [...TASK_STATES],
          description: "New task state.",
        },
      },
      required: ["task_id", "state"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages. Messages are normally pushed automatically via channel notifications; this is a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const a = args as { scope: string; status?: string; team?: string; skill?: string };
      const scope = a.scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
          status: a.status,
          team: a.team,
          skill: a.skill,
        });
        const filterDesc = [
          a.status && `status=${a.status}`,
          a.team && `team=${a.team}`,
          a.skill && `skill=${a.skill}`,
        ].filter(Boolean).join(", ");
        const header = filterDesc
          ? `scope: ${scope}; filters: ${filterDesc}`
          : `scope: ${scope}`;
        if (peers.length === 0) {
          return { content: [{ type: "text" as const, text: `No other peers found (${header}).` }] };
        }
        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `Runtime: ${p.runtime}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          parts.push(`Status: ${p.status}`);
          if (p.team) parts.push(`Team: ${p.team}`);
          if (p.role) parts.push(`Role: ${p.role}`);
          if (p.skills && p.skills.length > 0) parts.push(`Skills: ${p.skills.join(", ")}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });
        return { content: [{ type: "text" as const, text: `Found ${peers.length} peer(s) (${header}):\n\n${lines.join("\n\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "send_message": {
      const { to_ids, message, task_id } = args as { to_ids: string[]; message: string; task_id?: string };
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      if (!Array.isArray(to_ids) || to_ids.length === 0) {
        return { content: [{ type: "text" as const, text: "to_ids must be a non-empty array of peer IDs" }], isError: true };
      }
      try {
        const result = await brokerFetch<SendMessageMultiResponse>(
          "/send-message-multi",
          { from_id: myId, to_ids, text: message, task_id: task_id ?? null },
        );

        // Single-recipient: keep the old terse output.
        if (result.results.length === 1) {
          const r = result.results[0];
          if (!r) {
            return { content: [{ type: "text" as const, text: "Broker returned empty results" }], isError: true };
          }
          if (!r.ok) {
            return { content: [{ type: "text" as const, text: `Failed to send to ${r.to_id}: ${r.error ?? "unknown error"}` }], isError: true };
          }
          const latency = r.latency_ms != null ? ` in ${r.latency_ms}ms` : "";
          let text: string;
          switch (r.delivered_via) {
            case "instant":
              text = `Message sent to peer ${r.to_id} — delivered instantly${latency}`;
              break;
            case "poll_after_failure":
              text = `Instant delivery to peer ${r.to_id} failed; queued for polling${latency} (~1s)`;
              break;
            case "poll":
              text = `Peer ${r.to_id} has no instant-delivery channel; queued for polling${latency} (~1s)`;
              break;
            default:
              text = `Message sent to peer ${r.to_id} (delivery method: ${r.delivered_via ?? "unknown"})`;
          }
          return { content: [{ type: "text" as const, text }] };
        }

        // Multi-recipient: per-peer breakdown plus a one-line summary header.
        const lines = result.results.map((r) => {
          if (!r.ok) return `  ✗ ${r.to_id} — ${r.error ?? "failed"}`;
          const latency = r.latency_ms != null ? ` (${r.latency_ms}ms)` : "";
          let tag: string;
          switch (r.delivered_via) {
            case "instant":
              tag = `instant${latency}`;
              break;
            case "poll_after_failure":
              tag = `instant failed → queued${latency}`;
              break;
            case "poll":
              tag = `queued${latency}`;
              break;
            default:
              tag = r.delivered_via ?? "ok";
          }
          return `  ✓ ${r.to_id} — ${tag}`;
        });
        const okCount = result.results.filter((r) => r.ok).length;
        const total = result.results.length;
        const header = okCount === total
          ? `Message sent to ${total} peer(s):`
          : `Message sent to ${okCount}/${total} peer(s) (${total - okCount} failed):`;
        return { content: [{ type: "text" as const, text: `${header}\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error sending message: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return { content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "set_status": {
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      const a = args as { status?: string; team?: string | null; role?: string | null; skills?: string[] | null };
      // Forward only the fields the caller actually provided. Distinguishing
      // "absent" from "explicit null" matters: absent = no change, null = clear.
      const body: Record<string, unknown> = { id: myId };
      if ("status" in a) body.status = a.status;
      if ("team" in a) body.team = a.team;
      if ("role" in a) body.role = a.role;
      if ("skills" in a) body.skills = a.skills;
      try {
        await brokerFetch("/set-status", body);
        const summary = [
          a.status !== undefined && `status=${a.status}`,
          "team" in a && `team=${a.team === null ? "(cleared)" : a.team}`,
          "role" in a && `role=${a.role === null ? "(cleared)" : a.role}`,
          "skills" in a && `skills=${a.skills === null ? "(cleared)" : JSON.stringify(a.skills)}`,
        ].filter(Boolean).join(", ");
        return { content: [{ type: "text" as const, text: summary ? `Status updated: ${summary}` : "No changes." }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error setting status: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "set_task_state": {
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      const { task_id, state } = args as { task_id: string; state: string };
      try {
        await brokerFetch("/set-task-state", { id: myId, task_id, state });
        return { content: [{ type: "text" as const, text: `Task ${task_id} → ${state}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error setting task state: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "check_messages": {
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return { content: [{ type: "text" as const, text: "No new messages." }] };
        }
        const lines = result.messages.map((m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`);
        return { content: [{ type: "text" as const, text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function pollAndPushMessages() {
  if (!myId) return;
  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    for (const msg of result.messages) {
      let fromSummary = "";
      let fromCwd = "";
      let fromRuntime = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
          fromRuntime = sender.runtime;
        }
      } catch {
        // Non-critical
      }

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            from_runtime: fromRuntime,
            sent_at: msg.sent_at,
          },
        },
      });
      log(`Pushed message from ${msg.from_id} [${fromRuntime || "?"}]: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  await ensureBroker();

  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();
  // Open set — anything a terminal emulator chooses to set. The broker uses
  // this to pick a TerminalAdapter; unknown values fall back to generic OSC 2.
  // Common values: "Ghostty", "iTerm.app", "Apple_Terminal", "WezTerm", "tmux", "vscode".
  const terminalProgram = process.env.TERM_PROGRAM ?? null;

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);
  log(`TERM_PROGRAM: ${terminalProgram ?? "(unset)"}`);

  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    runtime: "claude" as const,
    terminal_program: terminalProgram,
    summary: initialSummary,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  (mcp as any)._instructions = `Your peer ID is ${myId}.\n\n` + (mcp as any)._instructions;

  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch {
          // Non-critical
        }
      }
    });
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      // Clear the terminal title before unregistering so the next shell prompt
      // reclaims the title cleanly. Best-effort; we don't want a failed write
      // here to block exit, so wrap in a short timeout + ignore failures.
      try {
        await Promise.race([
          brokerFetch("/clear-title", { id: myId }),
          new Promise((r) => setTimeout(r, 500)),
        ]);
      } catch {
        // Best effort — title hygiene shouldn't block shutdown.
      }
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// Only start the server when this module is executed directly (`bun server.ts`).
// On `import`, we still export TOOLS so tests can introspect the tool list
// without triggering the broker auto-launch or the MCP stdio connection.
if (import.meta.main) {
  main().catch((e) => {
    log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
