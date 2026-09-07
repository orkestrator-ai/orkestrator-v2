import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "./commands-context.js";
import { stopLocalServerUnlocked } from "./commands-local-server-lifecycle.js";
import { __testing as commandTesting } from "./commands-testing.js";
import { CoordinatorService } from "./coordinator-service.js";
import { startLocalServerUnlocked } from "./commands-servers.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";
import { runCommand } from "./shell.js";

describe("Coordinator Codex server", () => {
  let root: string;
  let checkout: string;
  let storage: StorageService;
  let previousCodexHome: string | undefined;
  let previousClaudeConfigDir: string | undefined;
  let cleanupContext: CommandContext | null = null;
  let cleanupRuntimeId: string | null = null;
  let cleanupKind: "codex" | "claude" = "codex";

  beforeEach(async () => {
    commandTesting.resetLocalServerLifecycle();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-coordinator-server-"));
    checkout = path.join(root, "checkout");
    await fs.mkdir(checkout);
    await runCommand("git", ["init", "-b", "main"], { cwd: checkout });
    await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
    await runCommand("git", ["config", "user.name", "Coordinator Test"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "README.md"), "initial\n");
    await runCommand("git", ["add", "README.md"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: checkout });
    await fs.mkdir(path.join(root, "bin"));
    await fs.writeFile(path.join(root, "bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    storage = new StorageService(path.join(root, "data"));
    await storage.init();
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({
      ...config.global,
      agentSettings: { ...config.global.agentSettings, defaultAgent: "codex" },
    });
    previousCodexHome = process.env.CODEX_HOME;
    const sourceHome = path.join(root, "source-codex-home");
    await fs.mkdir(sourceHome);
    await fs.writeFile(path.join(sourceHome, "auth.json"), '{"token":"login"}\n');
    await fs.writeFile(path.join(sourceHome, "config.toml"), "developer_instructions='unsafe'\n");
    process.env.CODEX_HOME = sourceHome;
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const sourceClaudeHome = path.join(root, "source-claude-home");
    await fs.mkdir(path.join(sourceClaudeHome, "plugins"), { recursive: true });
    await fs.writeFile(
      path.join(sourceClaudeHome, ".credentials.json"),
      '{"claudeAiOauth":{"accessToken":"login"}}\n',
    );
    await fs.writeFile(
      path.join(sourceClaudeHome, "settings.json"),
      '{"hooks":{"PreToolUse":[{"hooks":[{"command":"unsafe"}]}]}}\n',
    );
    await fs.writeFile(path.join(sourceClaudeHome, "plugins", "evil.js"), "// unsafe\n");
    process.env.CLAUDE_CONFIG_DIR = sourceClaudeHome;
    cleanupKind = "codex";
  });

  afterEach(async () => {
    if (cleanupContext && cleanupRuntimeId) {
      await stopLocalServerUnlocked(cleanupRuntimeId, cleanupContext, cleanupKind).catch(
        () => undefined,
      );
    }
    commandTesting.resetLocalServerLifecycle();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  test("a Claude coordinator gets its credential, its policy, and none of the user's config", async () => {
    const bridge = path.join(root, "bridges", "claude-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(
      path.join(bridge, "index.js"),
      `await Bun.write(process.env.CLAUDE_CONFIG_DIR + "/captured.json", JSON.stringify({ policy: process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY, mcpUrl: process.env.ORKESTRATOR_AGENT_MCP_URL, mcpToken: process.env.ORKESTRATOR_AGENT_MCP_TOKEN }));
const server = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch() { return Response.json({ ok: true }); } });
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
`,
    );
    const project = await storage.addProject(createProject("remote", checkout));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, conversation.id, "claude");
    const issue = mock(() => ({ url: "http://127.0.0.1:1234/mcp", token: "scoped-token" }));
    const revoke = mock(() => undefined);
    const context = {
      storage,
      coordinators: coordinator,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      controlMcp: {
        getSettings: () => ({
          enabled: true,
          running: true,
          url: "http://127.0.0.1:1234/mcp",
          token: "",
          error: null,
        }),
        rotateToken: async () => ({
          enabled: true,
          running: true,
          url: "http://127.0.0.1:1234/mcp",
          token: "",
          error: null,
        }),
        issueCoordinatorCredential: issue,
        revokeCoordinatorCredentials: revoke,
      },
    } as CommandContext;
    const runtimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    cleanupContext = context;
    cleanupRuntimeId = runtimeId;
    cleanupKind = "claude";

    const started = await startLocalServerUnlocked(runtimeId, context, "claude");
    expect(started).toMatchObject({ wasRunning: false, port: expect.any(Number) });

    const isolatedHome = path.join(
      storage.getDataDir(),
      "coordinator-runtime",
      snapshot.workspace.id,
      "conversations",
      conversation.id,
      "claude-home",
    );
    expect(await fs.readFile(path.join(isolatedHome, ".credentials.json"), "utf8")).toContain(
      "login",
    );
    // `settings.json` can declare hooks and `plugins/` is arbitrary code. Both
    // would run inside a session pointed at the user's real checkout.
    await expect(fs.access(path.join(isolatedHome, "settings.json"))).rejects.toThrow();
    await expect(fs.access(path.join(isolatedHome, "plugins"))).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(isolatedHome, "captured.json"), "utf8"))).toEqual(
      {
        policy: "coordinator-read-only",
        mcpUrl: "http://127.0.0.1:1234/mcp",
        mcpToken: "scoped-token",
      },
    );
    // The conversation's bridge identity is stored in the neutral fields, not
    // Codex's, so the reaper can find a Claude coordinator child too.
    expect(await storage.getCoordinatorWorkspace(project.id)).toMatchObject({
      conversations: [{ bridgePort: started.port, bridgePid: started.pid }],
    });
  });

  test("starts with isolated auth and policy, persists lifecycle, and revokes on bridge exit", async () => {
    const bridge = path.join(root, "bridges", "codex-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(
      path.join(bridge, "index.js"),
      `await Bun.write(process.env.CODEX_HOME + "/captured.json", JSON.stringify({ policy: process.env.CODEX_BRIDGE_EXECUTION_POLICY, permissionProfile: process.env.CODEX_BRIDGE_PERMISSION_PROFILE, readableRuntimeRoot: process.env.CODEX_BRIDGE_READABLE_RUNTIME_ROOT, mcpUrl: process.env.ORKESTRATOR_AGENT_MCP_URL, mcpToken: process.env.ORKESTRATOR_AGENT_MCP_TOKEN }));
const server = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch() { return Response.json({ ok: true }); } });
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
`,
    );
    const project = await storage.addProject(createProject("remote", checkout));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, conversation.id, "codex");
    const issue = mock(() => ({ url: "http://127.0.0.1:1234/mcp", token: "scoped-token" }));
    const revoke = mock(() => undefined);
    const context = {
      storage,
      coordinators: coordinator,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      controlMcp: {
        getSettings: () => ({
          enabled: true,
          running: true,
          url: "http://127.0.0.1:1234/mcp",
          token: "",
          error: null,
        }),
        rotateToken: async () => ({
          enabled: true,
          running: true,
          url: "http://127.0.0.1:1234/mcp",
          token: "",
          error: null,
        }),
        issueCoordinatorCredential: issue,
        revokeCoordinatorCredentials: revoke,
      },
    } as CommandContext;
    const runtimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    cleanupContext = context;
    cleanupRuntimeId = runtimeId;

    const started = await startLocalServerUnlocked(runtimeId, context, "codex");
    expect(started).toMatchObject({ wasRunning: false, port: expect.any(Number) });
    expect(issue).toHaveBeenCalledTimes(1);
    const isolatedHome = path.join(
      storage.getDataDir(),
      "coordinator-runtime",
      snapshot.workspace.id,
      "conversations",
      conversation.id,
      "codex-home",
    );
    expect(await fs.readFile(path.join(isolatedHome, "auth.json"), "utf8")).toContain("login");
    await expect(fs.access(path.join(isolatedHome, "config.toml"))).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(isolatedHome, "captured.json"), "utf8"))).toEqual(
      {
        policy: "coordinator-read-only",
        permissionProfile: `coordinator-${conversation.id}`,
        readableRuntimeRoot: path.join(root, "bin"),
        mcpUrl: "http://127.0.0.1:1234/mcp",
        mcpToken: "scoped-token",
      },
    );
    expect(await storage.getCoordinatorWorkspace(project.id)).toMatchObject({
      lifecycleState: "ready",
      conversations: [{ bridgePort: started.port, bridgePid: started.pid }],
    });

    revoke.mockClear();
    commandTesting.getLocalServerProcess(`codex:${runtimeId}`)!.kill("SIGTERM");
    for (let attempt = 0; attempt < 100 && revoke.mock.calls.length === 0; attempt += 1) {
      await Bun.sleep(10);
    }
    cleanupContext = null;
    cleanupRuntimeId = null;
    expect(revoke).toHaveBeenCalledWith(snapshot.workspace.id, conversation.id);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = (await storage.getCoordinatorWorkspace(project.id))!.conversations[0]!;
      if (current.bridgePort === undefined && current.bridgePid === undefined) break;
      await Bun.sleep(10);
    }
    const stopped = (await storage.getCoordinatorWorkspace(project.id))!.conversations[0]!;
    expect(stopped.bridgePort).toBeUndefined();
    expect(stopped.bridgePid).toBeUndefined();
  });

  test("records a sanitized startup failure and revokes the unused credential", async () => {
    const bridge = path.join(root, "bridges", "codex-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(path.join(bridge, "index.js"), `throw new Error("startup exploded");\n`);
    const project = await storage.addProject(createProject("remote", checkout));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, conversation.id, "codex");
    const revoke = mock(() => undefined);
    const context = {
      storage,
      coordinators: coordinator,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      controlMcp: {
        getSettings: () => ({
          enabled: true,
          running: true,
          url: "http://127.0.0.1:1234/mcp",
          token: "",
          error: null,
        }),
        rotateToken: async () => ({
          enabled: true,
          running: true,
          url: "http://127.0.0.1:1234/mcp",
          token: "",
          error: null,
        }),
        issueCoordinatorCredential: () => ({
          url: "http://127.0.0.1:1234/mcp",
          token: "scoped-token",
        }),
        revokeCoordinatorCredentials: revoke,
      },
    } as CommandContext;
    const runtimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    await expect(startLocalServerUnlocked(runtimeId, context, "codex")).rejects.toThrow(
      "before becoming healthy",
    );
    expect(revoke).toHaveBeenCalledWith(snapshot.workspace.id, conversation.id);
    expect(await storage.getCoordinatorWorkspace(project.id)).toMatchObject({
      lifecycleState: "error",
      lastStartupError: expect.stringContaining("before becoming healthy"),
    });
  });

  test("revokes a coordinator credential when process spawn fails synchronously", async () => {
    const bridge = path.join(root, "bridges", "codex-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(path.join(bridge, "index.js"), "export {};\n");
    const project = await storage.addProject(createProject("remote", checkout));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, conversation.id, "codex");
    const revoke = mock(() => undefined);
    const context = {
      storage,
      coordinators: coordinator,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      controlMcp: {
        getSettings: () => ({
          enabled: true,
          running: true,
          url: "http://127.0.0.1:1234/mcp",
          token: "",
          error: null,
        }),
        rotateToken: async () => ({
          enabled: true,
          running: true,
          url: "http://127.0.0.1:1234/mcp",
          token: "",
          error: null,
        }),
        issueCoordinatorCredential: () => ({
          url: "http://127.0.0.1:1234/mcp",
          token: "scoped-token",
        }),
        revokeCoordinatorCredentials: revoke,
      },
    } as CommandContext;
    commandTesting.setSpawnLocalServerCommand(() => {
      throw new Error("spawn exploded");
    });

    await expect(
      startLocalServerUnlocked(
        coordinatorRuntimeId(snapshot.workspace.id, conversation.id),
        context,
        "codex",
      ),
    ).rejects.toThrow("spawn exploded");
    expect(revoke).toHaveBeenCalledWith(snapshot.workspace.id, conversation.id);
  });

  test("rejects a mismatched platform and starts the conversation agent without optional control MCP", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    await coordinator.assignConversationAgent(
      project.id,
      snapshot.workspace.conversations[0]!.id,
      "codex",
    );
    const runtimeId = coordinatorRuntimeId(
      snapshot.workspace.id,
      snapshot.workspace.conversations[0]!.id,
    );
    const context = {
      storage,
      coordinators: coordinator,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
    } as CommandContext;
    // The conversation belongs to Codex, so starting a Claude bridge against
    // its runtime id must be refused: it would inherit that conversation's
    // scoped credential and private runtime directory.
    await expect(startLocalServerUnlocked(runtimeId, context, "claude")).rejects.toThrow(
      "belongs to a different agent platform",
    );
    const bridge = path.join(root, "bridges", "codex-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(
      path.join(bridge, "index.js"),
      `await Bun.write(process.env.CODEX_HOME + "/no-mcp.json", JSON.stringify({ url: process.env.ORKESTRATOR_AGENT_MCP_URL ?? null, token: process.env.ORKESTRATOR_AGENT_MCP_TOKEN ?? null }));
const server = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch() { return Response.json({ ok: true }); } });
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
`,
    );
    cleanupContext = context;
    cleanupRuntimeId = runtimeId;
    await startLocalServerUnlocked(runtimeId, context, "codex");
    const isolatedHome = path.join(
      storage.getDataDir(),
      "coordinator-runtime",
      snapshot.workspace.id,
      "conversations",
      snapshot.workspace.conversations[0]!.id,
      "codex-home",
    );
    expect(JSON.parse(await fs.readFile(path.join(isolatedHome, "no-mcp.json"), "utf8"))).toEqual({
      url: null,
      token: null,
    });
  });

  test("restarts a healthy local bridge when its authoritative worktree changes", async () => {
    const bridge = path.join(root, "bridges", "codex-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(
      path.join(bridge, "index.js"),
      `await Bun.write(process.env.CWD + "/bridge-cwd.txt", process.env.CWD);
const server = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch() { return Response.json({ ok: true }); } });
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
`,
    );
    const secondCheckout = path.join(root, "second-checkout");
    await fs.mkdir(secondCheckout);
    const project = await storage.addProject(createProject("remote", checkout));
    const environment = createEnvironment(project.id, {
      name: "local worker",
      environmentType: "local",
    });
    environment.status = "running";
    environment.worktreePath = checkout;
    await storage.addEnvironment(environment);
    const context = {
      storage,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
    } as CommandContext;
    cleanupContext = context;
    cleanupRuntimeId = environment.id;
    const first = await startLocalServerUnlocked(environment.id, context, "codex");
    expect(await fs.readFile(path.join(checkout, "bridge-cwd.txt"), "utf8")).toBe(checkout);
    await storage.updateEnvironment(environment.id, { worktreePath: secondCheckout });
    const restarted = await startLocalServerUnlocked(environment.id, context, "codex");
    expect(restarted.wasRunning).toBe(false);
    expect(restarted.pid).not.toBe(first.pid);
    expect(await fs.readFile(path.join(secondCheckout, "bridge-cwd.txt"), "utf8")).toBe(
      secondCheckout,
    );
  });
});
