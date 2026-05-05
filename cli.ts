#!/usr/bin/env bun
/**
 * unified-peers-mcp CLI
 *
 * Usage:
 *   bun cli.ts diagnose         Cross-runtime health check (recommended)
 *   bun cli.ts status           Brief broker + peer summary
 *   bun cli.ts peers            List all peers
 *   bun cli.ts send <id> <msg>  Send a message to a peer
 *   bun cli.ts clean-orphans    Remove /tmp/*.port files for dead PIDs
 *   bun cli.ts kill-broker      Stop the broker daemon
 */

import { RUNTIMES, type Runtime } from "./shared/runtimes.ts";

const BROKER_PORT = parseInt(
  process.env.PEERS_PORT ?? process.env.OPENCODE_PEERS_PORT ?? process.env.CLAUDE_PEERS_PORT ?? "7900",
  10,
);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const PORT_FILE_DIR = "/tmp";
const PORT_FILE_GLOB = "opencode-peers-plugin-*.port";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const OK = `${C.green}✓${C.reset}`;
const WARN = `${C.yellow}⚠${C.reset}`;
const FAIL = `${C.red}✗${C.reset}`;

const RUNTIME_COLORS: Record<Runtime, string> = {
  opencode: C.cyan,
  claude: C.magenta,
};

function runtimeTag(rt: string): string {
  const color = RUNTIME_COLORS[rt as Runtime] ?? C.dim;
  return `${color}[${rt}]${C.reset}`;
}

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, { ...opts, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function listPortFiles(): Promise<{ pid: number; port: number; path: string }[]> {
  const files = Array.from(new Bun.Glob(PORT_FILE_GLOB).scanSync({ cwd: PORT_FILE_DIR }));
  const result: { pid: number; port: number; path: string }[] = [];
  for (const f of files) {
    const pidMatch = f.match(/plugin-(\d+)\.port/);
    if (!pidMatch) continue;
    const pid = parseInt(pidMatch[1]!, 10);
    const portText = (await Bun.file(`${PORT_FILE_DIR}/${f}`).text()).trim();
    const port = parseInt(portText, 10);
    if (isNaN(port)) continue;
    result.push({ pid, port, path: `${PORT_FILE_DIR}/${f}` });
  }
  return result;
}

type BrokerDiagnose = {
  broker: { port: number; db_path: string; peers_count: number; runtimes: readonly string[] };
  peers: Array<{
    id: string; pid: number; pid_alive: boolean; cwd: string; git_root: string | null;
    runtime: string; summary: string; plugin_port: number | null;
    last_seen: string; last_delivery_at: string | null; last_delivery_via: string | null;
  }>;
};

type HelperDiagnose = {
  ok: boolean;
  uptime_ms?: number;
  conversations?: Array<{ id: string; parent_id: string | null; title: string }>;
  last_delivery_at?: string | null;
  last_delivery_ok?: boolean | null;
  last_delivery_error?: string | null;
  error?: string;
};

async function probeOpencodeHelper(port: number): Promise<
  | { ok: true; latency_ms: number; data: HelperDiagnose }
  | { ok: false; error: string }
> {
  const start = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/diagnose`, { signal: AbortSignal.timeout(2000) });
    const latency_ms = Date.now() - start;
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, latency_ms, data: (await res.json()) as HelperDiagnose };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return iso;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} hr ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}

function shortId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

async function cmdDiagnose() {
  console.log(`${C.bold}unified-peers-mcp diagnostic${C.reset} — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`);
  console.log("");

  console.log(`${C.bold}MESSENGER DAEMON${C.reset}`);
  let brokerData: BrokerDiagnose | null = null;
  try {
    brokerData = await brokerFetch<BrokerDiagnose>("/diagnose");
    console.log(`  ${OK} Running on 127.0.0.1:${brokerData.broker.port}`);
    console.log(`  ${OK} DB: ${brokerData.broker.db_path} (${brokerData.broker.peers_count} peer${brokerData.broker.peers_count === 1 ? "" : "s"})`);
    console.log(`  ${OK} Runtimes registered: ${brokerData.broker.runtimes.map((r) => runtimeTag(r)).join(" ")}`);
  } catch (e) {
    console.log(`  ${FAIL} Daemon not reachable on port ${BROKER_PORT}`);
    console.log(`     ${C.dim}${e instanceof Error ? e.message : String(e)}${C.reset}`);
    console.log("");
    console.log(`Without the daemon, no peer messaging works. Start any opencode/Claude window to auto-launch it,`);
    console.log(`or run: bun broker.ts (from ${process.cwd()})`);
    process.exit(1);
  }
  console.log("");

  console.log(`${C.bold}PEERS${C.reset}`);
  let healthyCount = 0;
  let degradedCount = 0;
  const byRuntime = new Map<string, number>();

  if (brokerData.peers.length === 0) {
    console.log(`  ${C.dim}(no peers registered — start an opencode window or Claude Code instance)${C.reset}`);
  }

  for (const p of brokerData.peers) {
    byRuntime.set(p.runtime, (byRuntime.get(p.runtime) ?? 0) + 1);
    const lines: string[] = [];
    let icon = OK;
    let degraded = false;

    const cwdShort = p.cwd.replace(process.env.HOME ?? "", "~");
    lines.push(`${C.bold}${p.id}${C.reset} ${runtimeTag(p.runtime)} (PID ${p.pid}, in ${cwdShort})`);
    if (p.summary) lines.push(`     ${C.dim}${p.summary}${C.reset}`);

    if (!p.pid_alive) {
      icon = FAIL;
      degraded = true;
      lines.push(`     status:           ${FAIL} ${C.red}DEAD${C.reset} (PID gone — daemon will clean up shortly)`);
    } else if (p.runtime === "opencode") {
      // Show helper status + conversation tree
      if (p.plugin_port == null) {
        icon = WARN;
        degraded = true;
        lines.push(`     in-app helper:    ${WARN} no port registered (instant delivery disabled, polling only)`);
      } else {
        const probe = await probeOpencodeHelper(p.plugin_port);
        if (probe.ok) {
          lines.push(`     in-app helper:    port ${p.plugin_port} — reachable in ${probe.latency_ms}ms ${OK}`);
          const convos = probe.data.conversations ?? [];
          if (convos.length === 0) {
            lines.push(`     conversations:    ${C.dim}(none open)${C.reset}`);
          } else {
            lines.push(`     conversations:`);
            const roots = convos.filter((c) => !c.parent_id);
            const childrenByParent = new Map<string, typeof convos>();
            for (const c of convos) {
              if (c.parent_id) {
                if (!childrenByParent.has(c.parent_id)) childrenByParent.set(c.parent_id, []);
                childrenByParent.get(c.parent_id)!.push(c);
              }
            }
            const activeRoot = roots[roots.length - 1];
            for (const root of roots) {
              const isActive = root === activeRoot;
              const marker = isActive ? `${C.cyan}▸${C.reset}` : " ";
              const tag = isActive ? `  ${C.cyan}(root, USER LIKELY HERE)${C.reset}` : "  (root)";
              const title = root.title ? ` "${root.title}"` : "";
              lines.push(`       ${marker} ${shortId(root.id)}${title}${tag}`);
              for (const kid of childrenByParent.get(root.id) ?? []) {
                const ktitle = kid.title ? ` "${kid.title}"` : "";
                lines.push(`         └ ${shortId(kid.id)}${ktitle}  ${C.dim}(child of ${shortId(root.id)})${C.reset}`);
              }
            }
            for (const [parentId, kids] of childrenByParent) {
              if (!roots.find((r) => r.id === parentId)) {
                for (const kid of kids) {
                  const ktitle = kid.title ? ` "${kid.title}"` : "";
                  lines.push(`       ${WARN} ${shortId(kid.id)}${ktitle}  ${C.dim}(orphan child — parent ${shortId(parentId)} not in list)${C.reset}`);
                }
              }
            }
          }
        } else {
          icon = WARN;
          degraded = true;
          lines.push(`     in-app helper:    port ${p.plugin_port} — ${C.red}UNREACHABLE${C.reset} (${probe.error})`);
          lines.push(`     conversations:    ${C.dim}(cannot list — helper not responding)${C.reset}`);
        }
      }
    } else if (p.runtime === "claude") {
      lines.push(`     delivery:         MCP channel push (claude-peers polls broker every 1s, pushes via mcp.notification)`);
    } else {
      lines.push(`     delivery:         ${C.dim}(runtime "${p.runtime}" — see shared/runtimes.ts)${C.reset}`);
    }

    if (p.last_delivery_at) {
      const via = p.last_delivery_via ?? "?";
      const viaLabel = via === "opencode" ? "in-app helper" :
                       via === "claude" ? "MCP channel" :
                       via === "poll" ? "polling fallback" : via;
      lines.push(`     last message:     ${relativeTime(p.last_delivery_at)} via ${viaLabel}`);
    } else {
      lines.push(`     last message:     ${C.dim}none yet${C.reset}`);
    }

    if (degraded) degradedCount++; else healthyCount++;
    console.log(`  ${icon} ${lines[0]}`);
    for (const line of lines.slice(1)) console.log(`  ${line}`);
    console.log("");
  }

  console.log(`${C.bold}ORPHAN FILES${C.reset}`);
  const portFiles = await listPortFiles();
  const orphans = portFiles.filter((f) => !pidAlive(f.pid));
  const livePidUnknown = portFiles.filter(
    (f) => pidAlive(f.pid) && !brokerData!.peers.find((p) => p.plugin_port === f.port),
  );

  if (orphans.length === 0 && livePidUnknown.length === 0) {
    console.log(`  ${OK} No stale port files`);
  } else {
    if (orphans.length > 0) {
      console.log(`  ${WARN} ${orphans.length} stale port file${orphans.length === 1 ? "" : "s"} from dead opencode processes:`);
      for (const o of orphans) console.log(`     ${C.dim}${o.path}${C.reset} (PID ${o.pid}, port ${o.port})`);
      console.log(`     Run: ${C.bold}bun cli.ts clean-orphans${C.reset}   to remove them.`);
    }
    if (livePidUnknown.length > 0) {
      console.log(`  ${WARN} ${livePidUnknown.length} port file${livePidUnknown.length === 1 ? "" : "s"} for live processes the daemon doesn't know about:`);
      for (const u of livePidUnknown) console.log(`     ${C.dim}${u.path}${C.reset} (PID ${u.pid}, port ${u.port})`);
    }
  }
  console.log("");

  const total = brokerData.peers.length;
  const breakdown = Array.from(byRuntime.entries())
    .map(([rt, n]) => `${n} ${runtimeTag(rt)}`)
    .join(", ");

  if (total === 0) {
    console.log(`${C.bold}OVERALL:${C.reset} no peers running`);
  } else if (degradedCount === 0) {
    console.log(`${C.bold}OVERALL:${C.reset} ${C.green}all ${total} peer${total === 1 ? "" : "s"} healthy${C.reset}  (${breakdown})`);
  } else {
    console.log(`${C.bold}OVERALL:${C.reset} ${healthyCount} healthy, ${C.yellow}${degradedCount} degraded${C.reset}  (${breakdown})`);
  }
}

async function cmdCleanOrphans() {
  const portFiles = await listPortFiles();
  const orphans = portFiles.filter((f) => !pidAlive(f.pid));
  if (orphans.length === 0) {
    console.log("No orphan port files to clean.");
    return;
  }
  console.log(`Removing ${orphans.length} orphan port file${orphans.length === 1 ? "" : "s"}:`);
  const fs = await import("node:fs/promises");
  for (const o of orphans) {
    try {
      await fs.unlink(o.path);
      console.log(`  ${OK} ${o.path}`);
    } catch (e) {
      console.log(`  ${FAIL} ${o.path} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

const cmd = process.argv[2];

switch (cmd) {
  case "diagnose": await cmdDiagnose(); break;

  case "clean-orphans": await cmdCleanOrphans(); break;

  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);
      console.log(`Runtimes: ${RUNTIMES.join(", ")}`);
      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{ id: string; pid: number; cwd: string; runtime: string; plugin_port: number | null; summary: string; last_seen: string }>
        >("/list-peers", { scope: "machine", cwd: "/", git_root: null });
        console.log("\nPeers:");
        for (const p of peers) {
          console.log(`  ${p.id}  ${runtimeTag(p.runtime)}  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{ id: string; pid: number; cwd: string; runtime: string; summary: string; plugin_port: number | null }>
      >("/list-peers", { scope: "machine", cwd: "/", git_root: null });
      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const parts = [`${p.id}  ${runtimeTag(p.runtime)}  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          if (p.plugin_port) parts.push(`  Helper port: ${p.plugin_port}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string; delivered_via?: string; latency_ms?: number }>(
        "/send-message",
        { from_id: "cli", to_id: toId, text: msg },
      );
      if (result.ok) {
        const v = result.delivered_via;
        const latency = result.latency_ms != null ? ` in ${result.latency_ms}ms` : "";
        if (v === "instant") {
          console.log(`${OK} Delivered to ${toId} via instant push${latency}`);
        } else if (v === "poll_after_failure") {
          console.log(`${WARN} Instant delivery to ${toId} failed; queued for polling${latency}`);
        } else {
          console.log(`${WARN} Queued for ${toId} (no instant handler for runtime); will arrive on next poll${latency}`);
        }
      } else {
        console.error(`${FAIL} ${result.error}`);
      }
    } catch (e) {
      console.error(`${FAIL} ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
      const pids = new TextDecoder().decode(proc.stdout).trim().split("\n").filter((p) => p);
      for (const pid of pids) process.kill(parseInt(pid), "SIGTERM");
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`unified-peers-mcp CLI

Usage:
  bun cli.ts diagnose         Cross-runtime health check (recommended first stop)
  bun cli.ts status           Brief broker + peer summary
  bun cli.ts peers            List all peers
  bun cli.ts send <id> <msg>  Send a message to a peer
  bun cli.ts clean-orphans    Remove /tmp/*.port files for dead PIDs
  bun cli.ts kill-broker      Stop the broker daemon

Runtimes: ${RUNTIMES.join(", ")}`);
}
