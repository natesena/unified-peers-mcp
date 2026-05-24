#!/usr/bin/env bun
/**
 * opencode runtime — MCP server.
 *
 * Spawned by opencode as a stdio MCP server (one per instance).
 * Connects to the unified-peers-mcp broker, registers with runtime: "opencode",
 * polls for inbound messages, and makes them available to the LLM via the
 * check_messages tool.
 *
 * Instant delivery: the broker POSTs to the opencode plugin's HTTP endpoint
 * (registered via plugin_port). If that succeeds, messages arrive instantly in
 * the TUI. If it fails, messages fall to the polling queue — pollMessages()
 * picks them up within ~1s and buffers them for check_messages to drain.
 *
 * Usage:
 *   Add to opencode.jsonc:
 *   "unified-peers": {
 *     "type": "local",
 *     "command": ["bun", "/path/to/unified-peers-mcp/runtimes/opencode/server.ts"],
 *     "enabled": true
 *   }
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
  process.env.PEERS_PORT ?? process.env.OPENCODE_PEERS_PORT ?? "7900",
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
  console.error(`[unified-peers/opencode] ${msg}`);
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
    if (code === 0) {
      return text.trim();
    }
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
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

const mcp = new Server(
  { name: "unified-peers", version: "0.2.0" },
  {
    capabilities: {
      tools: {},
    },
    instructions: `You are connected to the unified-peers network. Other opencode instances — and any Claude Code instances on this machine — can see you and send you messages.

## Handling Peer Messages

Peer messages arrive either instantly (via the in-app plugin) or via polling. When you see a message from check_messages:

1. Pause your current work immediately
2. Read the message
3. Reply right away using send_message with the sender's peer ID
4. Resume your previous work after replying

Never ignore a peer message. Always reply, even if just to acknowledge.

## Checking for Messages

Call check_messages regularly — after every task completion and before starting new work. Peer messages are queued until you check.

## Proactive Behavior

On startup, call set_summary to describe what you're working on. This helps other instances find and understand your context.

## Available Tools

- list_peers: Discover other peers across runtimes (scope: machine/directory/repo). Optionally filter by status/team/skill.
- send_message: Send a message to one or more peers by ID. Optionally tag with task_id when assigning trackable work.
- set_summary: Set your summary (visible to other peers)
- set_status: Update your AgentCard — availability (available/busy/away), team, role, skills. Orchestrators use these to pick who to task.
- set_task_state: As a worker, transition a task you received to working/completed/failed/canceled.
- check_messages: Check for queued messages from other peers

## Orchestrator pattern

To coordinate a multi-agent task:
1. Declare yourself: set_status(status='busy', team='<task-name>', role='orchestrator', skills=[...])
2. Find workers: list_peers(status='available', skill='<needed skill>')
3. Assign work: send_message(to_ids=[...], message='do X', task_id='<task-name>-001'); ask each worker to set_status(status='busy', team='<task-name>', role='worker')
4. Workers transition on done: set_task_state(task_id='<task-name>-001', state='completed')
5. Everyone resets: set_status(status='available', team=null, role=null)`,
  }
);

export const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other peers running on this machine across all runtimes (opencode and Claude Code). Returns their ID, working directory, git repo, summary, status, team, role, and skills. Optionally filter by status, team, or skill — useful for orchestrators looking for available workers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
        status: {
          type: "string" as const,
          enum: [...PEER_STATUSES],
          description: 'Optional. Only return peers with this status.',
        },
        team: {
          type: "string" as const,
          description: "Optional. Only return peers on this team (exact match).",
        },
        skill: {
          type: "string" as const,
          description: "Optional. Only return peers whose skills array contains this exact string.",
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to one or more peers by ID. Pass `to_ids: [\"abc\"]` for a single peer, or `to_ids: [\"abc\", \"def\"]` to fan out to several in one call. Optionally pass `task_id` to tag the message as trackable work — the recipient starts at task_state='working' and reports progress via set_task_state.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          minItems: 1,
          description: "Peer IDs to send to (from list_peers). Use a one-element array for a single recipient.",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
        task_id: {
          type: "string" as const,
          description: 'Optional. Tag this message as a trackable task (e.g. "auth-refactor-001").',
        },
      },
      required: ["to_ids", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other peers when they list peers.",
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
      "Update your AgentCard fields: availability (status), team membership, role, and skills. Partial update — fields you omit are unchanged; passing null explicitly clears team/role/skills. status cannot be cleared (always one of available/busy/away).",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string" as const,
          enum: [...PEER_STATUSES],
          description: 'Your availability: "available", "busy", or "away".',
        },
        team: {
          type: ["string", "null"] as unknown as "string",
          description: "Free-text team label. Pass null to clear.",
        },
        role: {
          type: ["string", "null"] as unknown as "string",
          description: 'Free-text role (e.g. "orchestrator", "worker"). Pass null to clear.',
        },
        skills: {
          type: ["array", "null"] as unknown as "array",
          items: { type: "string" as const },
          description: 'Free-text capability tags. Pass null to clear.',
        },
      },
    },
  },
  {
    name: "set_task_state",
    description:
      "As the recipient of a task-tagged message, transition the task to a new state. Only the recipient peer(s) can call this for a given task_id. Valid states: working, completed, failed, canceled.",
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
      "Check for new messages from other peers. Call this regularly: " +
      "between tool calls during long-running tasks, after every task completion, " +
      "and before starting new work. Peer messages are queued until you check. " +
      "Note: the same peer message may also appear as a user prompt in your " +
      "conversation (the plugin pushes to your TUI when you are idle). If you " +
      "see a duplicate from the same sender with the same text, treat it as " +
      "already received and reply once.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

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
        const header = filterDesc ? `scope: ${scope}; filters: ${filterDesc}` : `scope: ${scope}`;

        if (peers.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No other peers found (${header}).` }],
          };
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

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (${header}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_ids, message, task_id } = args as { to_ids: string[]; message: string; task_id?: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      if (!Array.isArray(to_ids) || to_ids.length === 0) {
        return {
          content: [{ type: "text" as const, text: "to_ids must be a non-empty array of peer IDs" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<SendMessageMultiResponse>("/send-message-multi", {
          from_id: myId,
          to_ids,
          text: message,
          task_id: task_id ?? null,
        });
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
              text = `Message sent to peer ${r.to_id} — delivered instantly${latency} (peer should see it on their screen immediately)`;
              break;
            case "poll_after_failure":
              text = `Instant delivery to peer ${r.to_id} failed; message queued, will arrive on their next poll (~1s).`;
              break;
            case "poll":
              text = `Peer ${r.to_id} has no instant-delivery channel; message queued, will arrive on their next poll (~1s).`;
              break;
            default:
              text = `Message sent to peer ${r.to_id} (delivery method: ${r.delivered_via ?? "unknown"})`;
          }
          return { content: [{ type: "text" as const, text }] };
        }
        const lines = result.results.map((r) => {
          if (!r.ok) return `  ✗ ${r.to_id} — ${r.error ?? "failed"}`;
          const latency = r.latency_ms != null ? ` (${r.latency_ms}ms)` : "";
          const tag = r.delivered_via === "instant" ? `instant${latency}` : `queued${latency}`;
          return `  ✓ ${r.to_id} — ${tag}`;
        });
        const okCount = result.results.filter((r) => r.ok).length;
        const total = result.results.length;
        const header = okCount === total
          ? `Message sent to ${total} peer(s):`
          : `Message sent to ${okCount}/${total} peer(s) (${total - okCount} failed):`;
        return { content: [{ type: "text" as const, text: `${header}\n${lines.join("\n")}` }] };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_status": {
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      const a = args as { status?: string; team?: string | null; role?: string | null; skills?: string[] | null };
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
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      const drained = messageQueue.splice(0);
      if (drained.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No new messages." }],
        };
      }

      const lines = drained.map((m) => `📧 FROM: ${m.from_id}\n${m.text}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `${drained.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const messageQueue: Array<{ from_id: string; text: string; sent_at: string }> = [];

async function pollMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    for (const msg of result.messages) {
      messageQueue.push({ from_id: msg.from_id, text: msg.text, sent_at: msg.sent_at });
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function readPluginPort(): Promise<number | null> {
  const portFile = `/tmp/opencode-peers-plugin-${process.ppid}.port`;
  for (let i = 0; i < 20; i++) {
    try {
      const text = await Bun.file(portFile).text();
      const port = parseInt(text.trim(), 10);
      if (!isNaN(port) && port > 0) {
        log(`Found plugin port: ${port}`);
        return port;
      }
    } catch {
      // File not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log("Plugin port file not found (plugin may not be installed)");
  return null;
}

async function main() {
  await ensureBroker();

  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();
  const terminalProgram = process.env.TERM_PROGRAM ?? null;

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);
  log(`TERM_PROGRAM: ${terminalProgram ?? "(unset)"}`);

  const pluginPort = await readPluginPort();

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
    runtime: "opencode" as const,
    plugin_port: pluginPort,
    terminal_program: terminalProgram,
    summary: initialSummary,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

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

  const pollTimer = setInterval(pollMessages, POLL_INTERVAL_MS);

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
      try {
        await Promise.race([
          brokerFetch("/clear-title", { id: myId }),
          new Promise((r) => setTimeout(r, 500)),
        ]);
      } catch {
        // Best effort
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
