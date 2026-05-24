/**
 * End-to-end tests for `bun cli.ts retitle <id>`.
 *
 * Spawns cli.ts as a subprocess against a test broker and asserts:
 *   - exit 0 + success message + the title gets written
 *   - exit !=0 + a clear error message for unknown peer IDs
 *
 * Reuses spawnTestBroker / makeFakeTty / registerPeer from tests/harness.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  makeFakeTty,
  registerPeer,
  spawnTestBroker,
  waitForBytes,
  type TestBroker,
} from "./harness.ts";

const CLI_PATH = new URL("../cli.ts", import.meta.url).pathname;

async function runCli(broker: TestBroker, args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn({
    cmd: ["bun", CLI_PATH, ...args],
    env: { ...process.env, PEERS_PORT: String(broker.port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("cli.ts retitle", () => {
  let broker: TestBroker;

  beforeAll(async () => { broker = await spawnTestBroker(); });
  afterAll(async () => { await broker.kill(); });

  test("re-asserts the title for a known peer (exit 0)", async () => {
    const tty = makeFakeTty(broker);
    const { id } = await registerPeer(broker, {
      tty: tty.ttyName,
      terminal_program: "Ghostty",
      summary: "cli retitle test",
    });
    await waitForBytes(tty.getBytes, (s) => s.includes("cli retitle test"));
    await Bun.write(tty.ttyPath, ""); // clobber

    const result = await runCli(broker, ["retitle", id]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(id);
    expect(result.stdout.toLowerCase()).toContain("title");

    const bytes = await waitForBytes(tty.getBytes, (s) => s.includes("cli retitle test"));
    expect(bytes).toBe(`\x1b]2;working on cli retitle test [${id}]\x07`);
  });

  test("unknown peer ID exits non-zero with a clear error", async () => {
    const result = await runCli(broker, ["retitle", "definitely-not-a-peer"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("missing peer-id arg prints usage and exits non-zero", async () => {
    const result = await runCli(broker, ["retitle"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("usage");
  });
});
