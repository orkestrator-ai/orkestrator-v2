import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { stopLocalServerUnlocked } from "./commands-local-server-lifecycle.js";
import { startLocalServerUnlocked } from "./commands-servers.js";
import { CoordinatorService } from "./coordinator-service.js";
import { ensureOpenCode2HostServer, peekOpenCode2HostServer } from "./opencode2-host-server.js";
import { runCommand } from "./shell.js";
import { createProject, StorageService } from "./storage.js";

/**
 * An OpenCode coordinator's server is the conversation's `opencode` local
 * server, launched from a stand-in `opencode2` that reports the environment
 * it was given. Its scoped Control MCP credential is the only route to its
 * delegation tools: the supervisor issues it for the launch and holds it in
 * the backend, which attaches it per session (`opencode2/coordinator.ts`); it
 * never reaches the server's environment, where the agent's tools could read
 * it.
 */
describe("Coordinator OpenCode server", () => {
  const SCOPED_URL = "http://127.0.0.1:1234/mcp";
  const TAB_URL = "http://127.0.0.1:4321/agent-tools";
  let root: string;
  let storage: StorageService;
  let cleanup: { context: CommandContext; runtimeId: string } | null = null;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-coordinator-opencode-")));
    const checkout = path.join(root, "checkout");
    await fs.mkdir(checkout);
    await runCommand("git", ["init", "-b", "main"], { cwd: checkout });
    await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
    await runCommand("git", ["config", "user.name", "Coordinator Test"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "README.md"), "initial\n");
    await runCommand("git", ["add", "README.md"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: checkout });
    await fs.mkdir(path.join(root, "managed-bin"));
    await fs.writeFile(
      path.join(root, "managed-bin", "opencode2"),
      `#!${process.execPath}
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const expected = "Basic " + btoa("opencode:" + process.env.OPENCODE_PASSWORD);
const launched = {
  policy: process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY ?? null,
  protectedDataDir: process.env.ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR ?? null,
  research: process.env.ORKESTRATOR_COORDINATOR_WEB_RESEARCH ?? null,
  projectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
  mcpUrl: process.env.ORKESTRATOR_AGENT_MCP_URL ?? null,
  mcpToken: process.env.ORKESTRATOR_AGENT_MCP_TOKEN ?? null,
  cwd: process.cwd(),
};
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    if (request.headers.get("authorization") !== expected) return new Response("no", { status: 401 });
    if (new URL(request.url).pathname === "/api/credential") return Response.json({ data: [] });
    return Response.json({ version: "2.2.6", pid: process.pid, launched });
  },
});
process.on("SIGTERM", () => process.exit(0));
`,
      { mode: 0o755 },
    );
    storage = new StorageService(path.join(root, "data"));
    await storage.init();
  });

  afterEach(async () => {
    if (cleanup) {
      await stopLocalServerUnlocked(cleanup.runtimeId, cleanup.context, "opencode").catch(
        () => undefined,
      );
      cleanup.context.runtime.shutdown();
      cleanup = null;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  async function coordinatorContext(
    options: {
      mode?: "off" | "search";
      servers?: { name: string; url: string }[];
    } = {},
  ) {
    const { mode = "off", servers } = options;
    // Research off unless a test asks: a research server is contacted to list
    // its tools, and these tests never leave the machine.
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({
      ...config.global,
      coordinatorWebResearch: mode,
      ...(servers ? { coordinatorResearchMcpServers: servers } : {}),
    });
    const project = await storage.addProject(createProject("remote", path.join(root, "checkout")));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, conversation.id, "opencode");
    const settings = { enabled: true, running: true, url: SCOPED_URL, token: "", error: null };
    const tabConnection = mock(() => ({ url: TAB_URL, token: "tab-token" }));
    const context = {
      storage,
      coordinators: coordinator,
      appRoot: root,
      resourceRoot: root,
      toolchainBinDir: path.join(root, "managed-bin"),
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      runtime: new BackendRuntime({ emit: () => undefined }),
      // Present, as in production: an ordinary environment's ticket tools.
      agentTools: { connection: tabConnection } as unknown as CommandContext["agentTools"],
      controlMcp: {
        getSettings: () => settings,
        rotateToken: async () => settings,
        issueCoordinatorCredential: mock(() => ({ url: SCOPED_URL, token: "scoped-token" })),
        revokeCoordinatorCredentials: mock(() => undefined),
      },
    } as unknown as CommandContext;
    const runtimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    cleanup = { context, runtimeId };
    return { context, runtimeId, tabConnection, storageConfig: storage };
  }

  async function launched(port: number, password: string) {
    const response = await fetch(`http://127.0.0.1:${port}/api/info`, {
      headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` },
    });
    return ((await response.json()) as { launched: Record<string, unknown> }).launched;
  }

  test("is launched with the coordinator's authority; its Control MCP credential stays in the backend", async () => {
    const { context, runtimeId, tabConnection } = await coordinatorContext();
    const started = await startLocalServerUnlocked(runtimeId, context, "opencode");
    expect(started.wasRunning).toBe(false);
    const answer = await launched(started.port, started.authToken!);
    expect(answer).toMatchObject({
      policy: "coordinator-read-only",
      protectedDataDir: storage.getDataDir(),
      research: "off",
      projectConfig: "1",
      mcpUrl: null,
      mcpToken: null,
      cwd: path.join(root, "checkout"),
    });
    const connection = peekOpenCode2HostServer(context, runtimeId)!;
    expect(connection.coordinator?.policy.id).toBe("coordinator-read-only");
    expect(connection.coordinator?.controlConnection()).toEqual({
      url: SCOPED_URL,
      token: "scoped-token",
    });
    // Never the tab credential: it would leave the coordinator with mail and
    // ticket tools but none of its delegation tools.
    expect(tabConnection).not.toHaveBeenCalled();

    const reused = await startLocalServerUnlocked(runtimeId, context, "opencode");
    expect(reused.wasRunning).toBe(true);
    expect(reused.pid).toBe(started.pid);
  });

  test("stopping it revokes the credential and forgets the record", async () => {
    const { context, runtimeId } = await coordinatorContext();
    await startLocalServerUnlocked(runtimeId, context, "opencode");
    const revoke = (
      context.controlMcp as unknown as { revokeCoordinatorCredentials: ReturnType<typeof mock> }
    ).revokeCoordinatorCredentials;
    const before = revoke.mock.calls.length;
    await stopLocalServerUnlocked(runtimeId, context, "opencode");
    expect(revoke.mock.calls.length).toBeGreaterThan(before);
    expect(peekOpenCode2HostServer(context, runtimeId)).toBeUndefined();
    expect(context.runtime.localServers.process(`opencode:${runtimeId}`)).toBeUndefined();
  });

  test("a changed research setting replaces an idle server with one launched under it", async () => {
    const { context, runtimeId } = await coordinatorContext();
    context.nativeAgents = {
      hasObservedLiveWork: async () => false,
    } as unknown as CommandContext["nativeAgents"];
    const first = await startLocalServerUnlocked(runtimeId, context, "opencode");
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({ ...config.global, coordinatorWebResearch: "search" });
    const second = await startLocalServerUnlocked(runtimeId, context, "opencode");
    expect(second.wasRunning).toBe(false);
    expect(second.pid).not.toBe(first.pid);
    expect((await launched(second.port, second.authToken!)).research).toBe("search");
    expect(peekOpenCode2HostServer(context, runtimeId)?.coordinator?.research.mode).toBe("search");
  });

  test("a busy coordinator keeps its server across a research edit until its work settles", async () => {
    const { context, runtimeId } = await coordinatorContext();
    let busy = true;
    context.nativeAgents = {
      hasObservedLiveWork: async () => busy,
    } as unknown as CommandContext["nativeAgents"];
    const first = await ensureOpenCode2HostServer(context, runtimeId);
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({ ...config.global, coordinatorWebResearch: "search" });

    // Mid-turn: every provider read (snapshot, status, interactive state)
    // resolves the same generation under its original authority, rather than
    // asking the supervisor for a replacement it must refuse.
    const during = await ensureOpenCode2HostServer(context, runtimeId);
    expect(during.generation).toBe(first.generation);
    expect(during.coordinator?.research.mode).toBe("off");
    const again = await ensureOpenCode2HostServer(context, runtimeId);
    expect(again.generation).toBe(first.generation);

    // Settled: the next call goes through the supervisor and gets an idle
    // replacement launched under the new setting.
    busy = false;
    const after = await ensureOpenCode2HostServer(context, runtimeId);
    expect(after.generation).not.toBe(first.generation);
    expect(after.coordinator?.research.mode).toBe("search");
    const port = Number(new URL(after.baseUrl).port);
    expect((await launched(port, after.password)).research).toBe("search");
  });
});
