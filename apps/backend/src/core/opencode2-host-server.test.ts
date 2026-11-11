/**
 * The host OpenCode server (the `opencode` local server, through the
 * supervisor) against a stand-in `opencode2`: a small Bun server that answers
 * `/api/info` as 2.x behind the launch's Basic password and reports what it
 * was launched with. Every process here is one this test spawned, stopped
 * through its recorded handle. Coordinator launches are covered with the
 * coordinator supervisor (`commands-servers-coordinator-opencode.test.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  config: process.env.OPENCODE_CONFIG ?? null,
  flags: process.env.OPENCODE_FLAGS,
  autoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE,
  filewatcher: process.env.OPENCODE_DISABLE_FILEWATCHER ?? null,
  relay: process.env.ORKESTRATOR_BRIDGE_LOG_RELAY ?? null,
  mcpToken: process.env.ORKESTRATOR_AGENT_MCP_TOKEN ?? null,
  policy: process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY ?? null,
  protectedDataDir: process.env.ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR ?? null,
  attachmentRoot: process.env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT ?? null,
  research: process.env.ORKESTRATOR_COORDINATOR_WEB_RESEARCH ?? null,
  projectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
  cwd: process.cwd(),
};
process.on("SIGTERM", () => process.exit(0));
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    if (request.headers.get("authorization") !== expected) return new Response("no", { status: 401 });
    // The credential reconcile at start: this server holds no logins.
    if (request.method === "GET" && new URL(request.url).pathname === "/api/credential")
      return Response.json({ data: [] });
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
  options: {
    environmentType?: "local" | "containerized";
    binary?: boolean;
    research?: () => string;
    busy?: () => boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "ork-opencode2-host-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const binDir = path.join(root, "bin");
  const scripts = path.join(root, "scripts");
  const dataDir = path.join(root, "data");
  const worktree = path.join(root, "worktree");
  await Promise.all([mkdir(binDir), mkdir(scripts), mkdir(dataDir), mkdir(worktree)]);
  // The server mirrors the user's global OpenCode configuration: point it at a fixture.
  const userConfigDir = path.join(root, "xdg", "opencode");
  await mkdir(userConfigDir, { recursive: true });
  const saved = {
    xdg: process.env.XDG_CONFIG_HOME,
    xdgData: process.env.XDG_DATA_HOME,
    config: process.env.OPENCODE_CONFIG,
  };
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  // An agent-test start reconciles the 2.x logins from
  // `$XDG_DATA_HOME/opencode/auth.json`: give it an empty store of its own,
  // never the developer's (a host that sets XDG_DATA_HOME would otherwise
  // hand the fake their real OpenCode logins).
  process.env.XDG_DATA_HOME = path.join(root, "xdg-data");
  delete process.env.OPENCODE_CONFIG;
  cleanup.push(async () => {
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.xdg;
    if (saved.xdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved.xdgData;
    if (saved.config === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = saved.config;
  });
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
    runtimeFlavor: "agent-test",
    runtime: {
      localServers,
      environments: { fence: { assertNotMoving() {} }, assertNotDeleting() {} },
    },
    nativeAgents: {
      hasObservedLiveWork: async () => options.busy?.() ?? false,
      runtimeStopRequested: async () => undefined,
    },
    storage: {
      getEnvironment: async () => environment,
      getDataDir: () => dataDir,
      loadConfig: async () => ({
        global: { coordinatorWebResearch: options.research?.() ?? "off" },
      }),
      coordinators: {
        coordinatorAttachmentDirectory: (coordinatorId: string, conversationId: string) =>
          path.join(dataDir, "attachments", coordinatorId, conversationId),
      },
      updateEnvironment: async (_id: string, fields: Record<string, unknown>) => {
        updates.push(fields);
      },
    },
    toolchainBinDir: binDir,
    resourceRoot: path.join(root, "none"),
    appRoot: path.join(root, "none"),
  } as unknown as CommandContext;
  return { context, localServers, dataDir, worktree, environment, userConfigDir, updates };
}

async function info(connection: { baseUrl: string; password: string }) {
  const response = await fetch(`${connection.baseUrl}/api/info`, {
    headers: { authorization: `Basic ${btoa(`opencode:${connection.password}`)}` },
  });
  return (await response.json()) as { version: string; launched: Record<string, unknown> };
}

describe("host OpenCode server", () => {
  test("starts once per environment, isolated from the user's OpenCode, and is reused", async () => {
    const { context, localServers, dataDir, worktree, updates } = await setup();
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
      filewatcher: "1",
      mcpToken: null,
      relay: null,
    });
    expect(answer.launched.args).toEqual(
      expect.arrayContaining(["serve", "--hostname", "127.0.0.1"]),
    );
    expect(String(answer.launched.flags)).toContain("-schedules");

    const identity = (value: { baseUrl: string; password: string; generation: string }) => ({
      baseUrl: value.baseUrl,
      password: value.password,
      generation: value.generation,
    });
    const again = await ensureOpenCode2HostServer(context, "env-1");
    expect(identity(again)).toEqual(identity(connection));
    expect(identity(peekOpenCode2HostServer(context, "env-1")!)).toEqual(identity(connection));
    expect(localServers.process(openCode2ServerKey("env-1"))).toBeDefined();
    // The supervisor's bookkeeping: the reaper and previews read these.
    expect(updates).toContainEqual({
      localOpencodePort: Number(new URL(connection.baseUrl).port),
      opencodePid: localServers.process("opencode:env-1")!.pid,
    });
  });

  test("starts with the user's global configuration mirrored, never writing theirs", async () => {
    const { context, dataDir, userConfigDir } = await setup();
    const userFile = path.join(userConfigDir, "opencode.json");
    const original = JSON.stringify({
      plugin: ["opencode-v1-plugin"],
      mcp: { mine: { type: "local", command: ["mine"] } },
    });
    await writeFile(userFile, original);
    const answer = await info(await ensureOpenCode2HostServer(context, "env-1"));
    expect(answer.launched.config).toBeNull();
    const mirror = await readFile(
      path.join(dataDir, "opencode2", "config", "opencode.jsonc"),
      "utf8",
    );
    expect(mirror).toContain('"mine"');
    expect(mirror).not.toContain("opencode-v1-plugin");
    expect(await readFile(userFile, "utf8")).toBe(original);
    expect(await readdir(userConfigDir)).toEqual(["opencode.json"]);
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
      /OpenCode .*not installed yet/,
    );
    expect(localServers.processCount()).toBe(0);
  });
});
