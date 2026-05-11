import type { Plugin } from "@opencode-ai/plugin";

const BROKER_PORT = parseInt(process.env.OPENCODE_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

const startedAt = Date.now();
let lastDeliveryAt: string | null = null;
let lastDeliveryOk: boolean | null = null;
let lastDeliveryError: string | null = null;
let lastResetAt: string | null = null;
let lastResetOk: boolean | null = null;
let lastResetError: string | null = null;

export const OpenencodePeersPlugin: Plugin = async ({ client }) => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true });
      }

      if (req.method === "GET" && url.pathname === "/diagnose") {
        let conversations: Array<{ id: string; parent_id: string | null; title: string }> = [];
        try {
          const result = await client.session.list();
          if (result.data && Array.isArray(result.data)) {
            conversations = result.data.map((s: any) => ({
              id: s.id,
              parent_id: s.parentID ?? s.parent_id ?? null,
              title: s.title ?? "",
            }));
          }
        } catch (e) {
          return Response.json({
            ok: false,
            uptime_ms: Date.now() - startedAt,
            error: `session.list failed: ${e instanceof Error ? e.message : String(e)}`,
            last_delivery_at: lastDeliveryAt,
            last_delivery_ok: lastDeliveryOk,
            last_delivery_error: lastDeliveryError,
            last_reset_at: lastResetAt,
            last_reset_ok: lastResetOk,
            last_reset_error: lastResetError,
          });
        }
        return Response.json({
          ok: true,
          uptime_ms: Date.now() - startedAt,
          conversations,
          last_delivery_at: lastDeliveryAt,
          last_delivery_ok: lastDeliveryOk,
          last_delivery_error: lastDeliveryError,
          last_reset_at: lastResetAt,
          last_reset_ok: lastResetOk,
          last_reset_error: lastResetError,
        });
      }

      // POST /reset — runs the corresponding TUI slash command via the
      // opencode SDK. Called by broker /reset-context when this peer is the
      // target (whether the request came from another peer or from self).
      //
      //   mode: "compact" → session.compact (preserves session, summarizes)
      //   mode: "clear"   → session.new     (full reset; opencode has no
      //                     session.clear, so session.new is what we use)
      if (req.method === "POST" && url.pathname === "/reset") {
        let resetBody: { mode?: string };
        try {
          resetBody = (await req.json()) as { mode?: string };
        } catch {
          return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
        }
        const mode = resetBody.mode;
        if (mode !== "compact" && mode !== "clear") {
          return Response.json({ ok: false, error: `invalid mode: ${mode}` }, { status: 400 });
        }
        const command = mode === "compact" ? "session.compact" : "session.new";
        try {
          await client.tui.executeCommand({ body: { command } });
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          lastResetAt = new Date().toISOString();
          lastResetOk = false;
          lastResetError = err;
          return Response.json({ ok: false, error: err }, { status: 500 });
        }
        lastResetAt = new Date().toISOString();
        lastResetOk = true;
        lastResetError = null;
        return Response.json({ ok: true, mode });
      }

      if (req.method !== "POST" || url.pathname !== "/message") {
        return new Response("not found", { status: 404 });
      }

      let body: {
        from_id: string;
        text: string;
        from_summary?: string;
        from_cwd?: string;
        from_git_root?: string;
      };
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
      }

      const { from_id, text } = body;
      const formatted = `📧 FROM: ${from_id}\n${text}`;

      try {
        await client.tui.appendPrompt({ body: { text: formatted } });
        await client.tui.submitPrompt();
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        lastDeliveryAt = new Date().toISOString();
        lastDeliveryOk = false;
        lastDeliveryError = err;
        return Response.json({ ok: false, error: err }, { status: 500 });
      }

      lastDeliveryAt = new Date().toISOString();
      lastDeliveryOk = true;
      lastDeliveryError = null;
      return Response.json({ ok: true });
    },
  });

  const portFile = `/tmp/opencode-peers-plugin-${process.pid}.port`;
  try {
    await Bun.write(portFile, String(server.port));
  } catch (e) {
    console.error(`[opencode-peers plugin] Failed to write port file: ${e}`);
  }

  try {
    await fetch(`${BROKER_URL}/register-plugin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        opencode_pid: process.pid,
        plugin_port: server.port,
      }),
      signal: AbortSignal.timeout(3000),
    });
    console.error(`[opencode-peers plugin] Registered plugin port ${server.port} with broker`);
  } catch {
    console.error(`[opencode-peers plugin] Broker not reachable yet (will be registered when MCP server starts)`);
  }

  console.error(`[opencode-peers plugin] Listening on 127.0.0.1:${server.port}`);

  const cleanup = () => {
    try {
      const fs = require("fs");
      fs.unlinkSync(portFile);
    } catch {
      // Ignore
    }
    server.stop(true);
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  return {};
};
