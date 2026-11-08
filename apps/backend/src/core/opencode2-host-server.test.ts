/**
 * The host OpenCode 2.x server supervisor against a stand-in `opencode2`: a
 * small Bun server that answers `/api/info` as 2.x behind the launch's Basic
 * password and reports what it was launched with. Every process here is one
 * this test spawned, stopped through its recorded handle.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { stopLocalServerUnlocked } from "./commands-local-server-lifecycle.js";
import type { CommandContext } from "./commands-context.js";
import { LocalServerRuntime } from "./local-server-runtime.js";
import { ensureOpenCode2HostServer, peekOpenCode2HostServer } from "./opencode2-host-server.js";
import { openCode2ServerKey } from "./opencode2/host-server-state.js";

const FAKE_SERVER = `
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const expected = "Basic " + btoa("opencode:" + process.env.OPENCODE_PASSWORD);
const launched = {
  args,
  db: process.env.OPENCODE_DB,
  configDir: process.env.OPENCODE_CONFIG_DIR,
  flags: process.env.OPENCODE_FLAGS,
  autoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE,
  mcpToken: process.env.ORKESTRATOR_AGENT_MCP_TOKEN ?? null,
  cwd: process.cwd(),
};
process.on("SIGTERM", () => process.exit(0));
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    if (request.headers.get("authorization") !== expected) return new Response("no", { status: 401 });
    return Response.json({ version: "2.2.6", pid: process.pid, launched });
  },
});
`;

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

async function setup(
  options: { environmentType?: "local" | "containerized"; binary?: boolean } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "ork-opencode2-host-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const binDir = path.join(root, "bin");
  const scripts = path.join(root, "scripts");
  const dataDir = path.join(root, "data");
  const worktree = path.join(root, "worktree");
  await Promise.all([mkdir(binDir), mkdir(scripts), mkdir(dataDir), mkdir(worktree)]);
  await writeFile(path.join(scripts, "fake-opencode2.ts"), FAKE_SERVER);
  if (options.binary !== false) {
    const binary = path.join(binDir, "opencode2");
    await writeFile(
      binary,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(scripts, "fake-opencode2.ts"))} "$@"\n`,
    );
    await chmod(binary, 0o755);
  }
  const localServers = new LocalServerRuntime();
  cleanup.push(() => localServers.shutdown());
  const environment = {
    id: "env-1",
    environmentType: options.environmentType ?? "local",
    worktreePath: worktree,
  };
  const updates: Array<Record<string, unknown>> = [];
  const context = {
    runtime: {
      localServers,
      environments: { fence: { assertNotMoving() {} }, assertNotDeleting() {} },
    },
    storage: {
      getEnvironment: async () => environment,
      getDataDir: () => dataDir,
      updateEnvironment: async (_id: string, fields: Record<string, unknown>) => {
        updates.push(fields);
      },
    },
    toolchainBinDir: binDir,
    resourceRoot: path.join(root, "none"),
    appRoot: path.join(root, "none"),
  } as unknown as CommandContext;
  return { context, localServers, dataDir, worktree, environment };
}

async function info(connection: { baseUrl: string; password: string }) {
  const response = await fetch(`${connection.baseUrl}/api/info`, {
    headers: { authorization: `Basic ${btoa(`opencode:${connection.password}`)}` },
  });
  return (await response.json()) as { version: string; launched: Record<string, unknown> };
}

describe("host OpenCode 2.x server", () => {
  test("starts once per environment, isolated from the user's OpenCode, and is reused", async () => {
    const { context, localServers, dataDir, worktree } = await setup();
    const previous = process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
    process.env.ORKESTRATOR_AGENT_MCP_TOKEN = "backend-own-token";
    let connection;
    try {
      expect(peekOpenCode2HostServer(context, "env-1")).toBeUndefined();
      connection = await ensureOpenCode2HostServer(context, "env-1");
    } finally {
      if (previous === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
      else process.env.ORKESTRATOR_AGENT_MCP_TOKEN = previous;
    }
    expect(connection.directory).toBe(worktree);
    const answer = await info(connection);
    expect(answer.version).toBe("2.2.6");
    expect(answer.launched).toMatchObject({
      db: path.join(dataDir, "opencode2", "opencode.db"),
      configDir: path.join(dataDir, "opencode2", "config"),
      autoupdate: "1",
      mcpToken: null,
    });
    expect(answer.launched.args).toEqual(
      expect.arrayContaining(["serve", "--hostname", "127.0.0.1"]),
    );
    expect(String(answer.launched.flags)).toContain("-schedules");

    const again = await ensureOpenCode2HostServer(context, "env-1");
    expect(again).toEqual(connection);
    expect(peekOpenCode2HostServer(context, "env-1")).toEqual(connection);
    expect(localServers.process(openCode2ServerKey("env-1"))).toBeDefined();
  });

  test("stops with the environment's OpenCode server", async () => {
    const { context, localServers } = await setup();
    const connection = await ensureOpenCode2HostServer(context, "env-1");
    const child = localServers.process(openCode2ServerKey("env-1"))!;
    await stopLocalServerUnlocked("env-1", context, "opencode");
    expect(peekOpenCode2HostServer(context, "env-1")).toBeUndefined();
    expect(localServers.process(openCode2ServerKey("env-1"))).toBeUndefined();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await expect(info(connection)).rejects.toThrow();
  });

  test("a container environment is refused before anything is spawned", async () => {
    const { context, localServers } = await setup({ environmentType: "containerized" });
    await expect(ensureOpenCode2HostServer(context, "env-1")).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(localServers.processCount()).toBe(0);
  });

  test("a missing managed binary says so instead of trying PATH", async () => {
    const { context, localServers } = await setup({ binary: false });
    await expect(ensureOpenCode2HostServer(context, "env-1")).rejects.toThrow(
      /OpenCode 2 is not installed yet/,
    );
    expect(localServers.processCount()).toBe(0);
  });
});
