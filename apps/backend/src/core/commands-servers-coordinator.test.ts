import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "./commands-context.js";
import * as commandFiles from "./commands-files.js";
import { stopLocalServerUnlocked } from "./commands-local-server-lifecycle.js";
import { CoordinatorService } from "./coordinator-service.js";
import { startLocalServerUnlocked } from "./commands-servers.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";
import { runCommand } from "./shell.js";
import { BackendRuntime, type BackendRuntimeOptions } from "./backend-runtime.js";

const runtimes: BackendRuntime[] = [];

/** One backend's runtime, released after the test like the backend would. */
function trackedRuntime(options: Omit<BackendRuntimeOptions, "emit"> = {}): BackendRuntime {
  const runtime = new BackendRuntime({ emit: () => undefined, ...options });
  runtimes.push(runtime);
  return runtime;
}

/** A Codex ChatGPT login whose access token lasts an hour. Never a real credential. */
function codexAuth(marker: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (claims: Record<string, unknown>) =>
    `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: token({ marker: `${marker}-id` }),
      access_token: token({ marker }),
      refresh_token: `refresh-${marker}`,
      account_id: marker,
    },
  });
}

describe("Coordinator Codex server", () => {
  let root: string;
  let checkout: string;
  let managedBin: string;
  let storage: StorageService;
  let previousCodexHome: string | undefined;
  let previousClaudeConfigDir: string | undefined;
  let cleanupContext: CommandContext | null = null;
  let cleanupRuntimeId: string | null = null;
  let cleanupKind: "codex" | "claude" | "cursor" = "codex";
  let restoreHostCredentialRead: (() => void) | undefined;

  beforeEach(async () => {
    cleanupContext = null;
    cleanupRuntimeId = null;
    // Spawned processes canonicalize macOS's /var temporary-directory alias.
    // Build expected paths from the same canonical root they report.
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-coordinator-server-")));
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
    // Production resolves managed tools through a stable activation directory
    // of symlinks into the version-pinned toolchain directory. Only a test
    // that puts this in `toolchainBinDir` can tell a launch of the link apart
    // from a launch of its target.
    managedBin = path.join(root, "managed-bin");
    await fs.mkdir(managedBin);
    await fs.symlink(path.join(root, "bin", "codex"), path.join(managedBin, "codex"));
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
    await fs.writeFile(path.join(sourceHome, "auth.json"), codexAuth("login"));
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
    for (const runtime of runtimes.splice(0)) {
      expect(runtime.localServers.hasEnvironmentOperations()).toBe(false);
      runtime.shutdown();
    }
    restoreHostCredentialRead?.();
    restoreHostCredentialRead = undefined;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  test("records loginless launches, clears them on release, and replaces an idle bridge after login", async () => {
    const bridge = path.join(root, "bridges", "claude-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(
      path.join(bridge, "index.js"),
      `
const server = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch() { return Response.json({ ok: true }); } });
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
`,
    );
    await fs.rm(path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"));
    const project = await storage.addProject(createProject("remote", checkout));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, conversation.id, "claude");
    let busy = false;
    const context = {
      storage,
      coordinators: coordinator,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      runtimeFlavor: "production",
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      runtime: trackedRuntime(),
      nativeAgents: { hasObservedLiveWork: async () => busy },
    } as unknown as CommandContext;
    const runtimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    const key = `claude:${runtimeId}`;
    cleanupContext = context;
    cleanupRuntimeId = runtimeId;
    cleanupKind = "claude";
    // Keep inherited credentials from disguising the fixture's signed-out state.
    const credentials = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
    const savedCredentials = credentials.map((name) => [name, process.env[name]] as const);
    for (const name of credentials) delete process.env[name];
    // Keep host credential discovery deterministic and away from the real Keychain.
    const hostCredentialRead = spyOn(
      commandFiles,
      "readRuntimeHostClaudeCredentials",
    ).mockImplementation(() =>
      fs
        .readFile(path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "utf8")
        .catch(() => undefined),
    );
    try {
      const first = await startLocalServerUnlocked(runtimeId, context, "claude");
      expect(first.wasRunning).toBe(false);
      expect(context.runtime.localServers.isLoginless(key)).toBe(true);
      expect(context.runtime.localServers.launchedAccountId(key)).toBe("default");
      await stopLocalServerUnlocked(runtimeId, context, "claude");
      expect(context.runtime.localServers.process(key)).toBeUndefined();
      expect(context.runtime.localServers.isLoginless(key)).toBe(false);
      expect(context.runtime.localServers.launchedAccountId(key)).toBeUndefined();

      const signedOut = await startLocalServerUnlocked(runtimeId, context, "claude");
      expect(context.runtime.localServers.isLoginless(key)).toBe(true);
      // A terminal login creates the file without sending a refresh event.
      await fs.writeFile(
        path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: { accessToken: "new-login", expiresAt: Date.now() + 60 * 60_000 },
        }),
      );
      busy = true;
      const retained = await startLocalServerUnlocked(runtimeId, context, "claude");
      expect(retained).toMatchObject({ pid: signedOut.pid, wasRunning: true });
      expect(context.runtime.localServers.isLoginless(key)).toBe(true);
      busy = false;
      const signedIn = await startLocalServerUnlocked(runtimeId, context, "claude");
      expect(signedIn.wasRunning).toBe(false);
      expect(signedIn.pid).not.toBe(signedOut.pid);
      expect(context.runtime.localServers.isLoginless(key)).toBe(false);
      expect(context.runtime.localServers.hasStaleLogin(key)).toBe(false);
      const coordinatorHome = path.join(
        storage.getDataDir(),
        "coordinator-runtime",
        snapshot.workspace.id,
        "conversations",
        conversation.id,
        "claude-home",
      );
      // The login is handed over as an access token; no credential file is copied in.
      await expect(fs.access(path.join(coordinatorHome, ".credentials.json"))).rejects.toThrow();
      expect(context.runtime.localServers.launchedTokenExpiry(key)).toBeGreaterThan(Date.now());
      await stopLocalServerUnlocked(runtimeId, context, "claude");
      expect(context.runtime.localServers.process(key)).toBeUndefined();
      expect(context.runtime.localServers.isLoginless(key)).toBe(false);
    } finally {
      hostCredentialRead.mockRestore();
      for (const [name, value] of savedCredentials) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test.each([undefined, "off", "search"] as const)(
    "a Claude coordinator isolates config and launches stored research mode %s",
    async (researchMode) => {
      const config = await storage.loadConfig();
      await storage.updateGlobalConfig({ ...config.global, coordinatorWebResearch: researchMode });
      const bridge = path.join(root, "bridges", "claude-bridge", "dist");
      await fs.mkdir(bridge, { recursive: true });
      await fs.writeFile(
        path.join(bridge, "index.js"),
        `await Bun.write(process.env.CLAUDE_CONFIG_DIR + "/captured.json", JSON.stringify({ policy: process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY, attachmentRoot: process.env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT, mcpUrl: process.env.ORKESTRATOR_AGENT_MCP_URL, mcpToken: process.env.ORKESTRATOR_AGENT_MCP_TOKEN, research: process.env.ORKESTRATOR_COORDINATOR_WEB_RESEARCH, researchMcp: process.env.ORKESTRATOR_COORDINATOR_RESEARCH_MCP, oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN }));
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
        runtime: trackedRuntime(),
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

      // Keep host credential discovery on the fixture, away from the real Keychain.
      const hostCredentialRead = spyOn(
        commandFiles,
        "readRuntimeHostClaudeCredentials",
      ).mockImplementation(() =>
        fs.readFile(path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "utf8"),
      );
      restoreHostCredentialRead = () => hostCredentialRead.mockRestore();
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
      // Only the access token reaches the coordinator; no credential file is copied in.
      await expect(fs.access(path.join(isolatedHome, ".credentials.json"))).rejects.toThrow();
      // `settings.json` can declare hooks and `plugins/` is arbitrary code. Both
      // would run inside a session pointed at the user's real checkout.
      await expect(fs.access(path.join(isolatedHome, "settings.json"))).rejects.toThrow();
      await expect(fs.access(path.join(isolatedHome, "plugins"))).rejects.toThrow();
      expect(
        JSON.parse(await fs.readFile(path.join(isolatedHome, "captured.json"), "utf8")),
      ).toEqual({
        policy: "coordinator-read-only",
        // Attachments are staged outside the checkout, so the bridge is told
        // the one directory besides the workspace it may read them from.
        attachmentRoot: storage.coordinatorAttachmentDirectory(
          snapshot.workspace.id,
          conversation.id,
        ),
        mcpUrl: "http://127.0.0.1:1234/mcp",
        mcpToken: "scoped-token",
        oauthToken: "login",
        // The research setting is process authority too; absent in the
        // stored config means the default: search plus Context7.
        research: researchMode ?? "search-and-mcp",
        ...(researchMode === undefined
          ? {
              researchMcp: JSON.stringify([
                { name: "context7", url: "https://mcp.context7.com/mcp" },
              ]),
            }
          : {}),
      });
      const attachmentRootStats = await fs.stat(
        storage.coordinatorAttachmentDirectory(snapshot.workspace.id, conversation.id),
      );
      expect(attachmentRootStats.isDirectory()).toBe(true);
      expect(attachmentRootStats.mode & 0o777).toBe(0o700);
      // The conversation's bridge identity is stored in the neutral fields, not
      // Codex's, so the reaper can find a Claude coordinator child too.
      expect(await storage.getCoordinatorWorkspace(project.id)).toMatchObject({
        conversations: [{ bridgePort: started.port, bridgePid: started.pid }],
      });
      // A renewed login must retain busy work, then replace an idle bridge and
      // acknowledge the refresh only after the replacement has launched.
      const key = `claude:${runtimeId}`;
      context.runtime.localServers.markLoginStale("claude");
      expect(context.runtime.localServers.hasStaleLogin(key)).toBe(true);
      let busy = true;
      context.nativeAgents = {
        hasObservedLiveWork: async () => busy,
      } as unknown as CommandContext["nativeAgents"];
      const retained = await startLocalServerUnlocked(runtimeId, context, "claude");
      expect(retained.pid).toBe(started.pid);
      expect(context.runtime.localServers.hasStaleLogin(key)).toBe(true);
      busy = false;
      const replaced = await startLocalServerUnlocked(runtimeId, context, "claude");
      expect(replaced.pid).not.toBe(started.pid);
      expect(context.runtime.localServers.hasStaleLogin(key)).toBe(false);
      const current = await storage.loadConfig();
      const nextMode = researchMode === "off" ? "search" : "off";
      await storage.updateGlobalConfig({ ...current.global, coordinatorWebResearch: nextMode });
      busy = true;
      await expect(startLocalServerUnlocked(runtimeId, context, "claude")).rejects.toThrow(
        "current work finishes",
      );
      expect(context.runtime.localServers.process(key)?.pid).toBe(replaced.pid);
      busy = false;
      const changed = await startLocalServerUnlocked(runtimeId, context, "claude");
      expect(changed.pid).not.toBe(replaced.pid);
      expect(
        JSON.parse(await fs.readFile(path.join(isolatedHome, "captured.json"), "utf8")),
      ).toMatchObject({ research: nextMode });
    },
  );

  test("a Cursor coordinator launch carries the coordinator process policy", async () => {
    const bridge = path.join(root, "bridges", "cursor-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(
      path.join(bridge, "index.js"),
      `import { mkdir } from "node:fs/promises";
const captured = {
  policy: process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY,
  mcpUrl: process.env.ORKESTRATOR_AGENT_MCP_URL,
  mcpToken: process.env.ORKESTRATOR_AGENT_MCP_TOKEN,
};
await mkdir(process.env.CURSOR_BRIDGE_STATE_DIR, { recursive: true });
await Bun.write(process.env.CURSOR_BRIDGE_STATE_DIR + "/captured.json", JSON.stringify(captured));
const server = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch() { return Response.json({ ok: true }); } });
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
`,
    );
    const project = await storage.addProject(createProject("remote", checkout));
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({
      ...config.global,
      enabledAgentPlatforms: [...(config.global.enabledAgentPlatforms ?? []), "cursor"],
    });
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, conversation.id, "cursor");
    const issue = mock(() => ({ url: "http://127.0.0.1:1234/mcp", token: "scoped-token" }));
    const context = {
      storage,
      coordinators: coordinator,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      runtime: trackedRuntime(),
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
        revokeCoordinatorCredentials: () => undefined,
      },
    } as CommandContext;
    const runtimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    cleanupContext = context;
    cleanupRuntimeId = runtimeId;
    cleanupKind = "cursor";

    const started = await startLocalServerUnlocked(runtimeId, context, "cursor");
    expect(started).toMatchObject({ wasRunning: false, port: expect.any(Number) });

    const capturedPath = path.join(
      storage.getDataDir(),
      "cursor-bridge-state",
      createHash("sha256").update(runtimeId).digest("hex").slice(0, 32),
      "captured.json",
    );
    expect(JSON.parse(await fs.readFile(capturedPath, "utf8"))).toEqual({
      policy: "coordinator-read-only",
      mcpUrl: "http://127.0.0.1:1234/mcp",
      mcpToken: "scoped-token",
    });
  });

  test("starts with isolated auth and policy, persists lifecycle, and revokes on bridge exit", async () => {
    const bridge = path.join(root, "bridges", "codex-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(
      path.join(bridge, "index.js"),
      `if (JSON.stringify(process.env).includes("refresh-sentinel")) throw new Error("Refresh token leaked to environment");
await Bun.write(process.env.CODEX_HOME + "/captured.json", JSON.stringify({ codexPath: process.env.CODEX_PATH, policy: process.env.CODEX_BRIDGE_EXECUTION_POLICY, permissionProfile: process.env.CODEX_BRIDGE_PERMISSION_PROFILE, readableRuntimeRoot: process.env.CODEX_BRIDGE_READABLE_RUNTIME_ROOT, attachmentRoot: process.env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT, mcpUrl: process.env.ORKESTRATOR_AGENT_MCP_URL, mcpToken: process.env.ORKESTRATOR_AGENT_MCP_TOKEN }));
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
      toolchainBinDir: managedBin,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      runtime: trackedRuntime(),
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
    const handedOver = JSON.parse(await fs.readFile(path.join(isolatedHome, "auth.json"), "utf8"));
    expect(handedOver.tokens.account_id).toBe("login");
    // Access-only: a coordinator's refresh would retire the account's own login.
    expect(handedOver.tokens.refresh_token).toBe("");
    expect(context.runtime.localServers.launchedTokenExpiry(`codex:${runtimeId}`)).toBeGreaterThan(
      Date.now(),
    );
    await expect(fs.access(path.join(isolatedHome, "config.toml"))).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(isolatedHome, "captured.json"), "utf8"))).toEqual(
      {
        // Codex re-execs argv[0] inside its macOS sandbox helper, so the
        // bridge is handed the activation link's canonical target: the same
        // directory the deny-by-default permission profile allowlists below.
        codexPath: path.join(root, "bin", "codex"),
        policy: "coordinator-read-only",
        permissionProfile: `coordinator-${conversation.id}`,
        readableRuntimeRoot: path.join(root, "bin"),
        attachmentRoot: storage.coordinatorAttachmentDirectory(
          snapshot.workspace.id,
          conversation.id,
        ),
        mcpUrl: "http://127.0.0.1:1234/mcp",
        mcpToken: "scoped-token",
      },
    );
    expect(await storage.getCoordinatorWorkspace(project.id)).toMatchObject({
      lifecycleState: "ready",
      conversations: [{ bridgePort: started.port, bridgePid: started.pid }],
    });

    const addedId = "11111111-2222-4333-8444-555555555555";
    const addedHome = path.join(storage.agentAccountsDirectory(), "codex", addedId);
    await fs.mkdir(addedHome, { recursive: true });
    await fs.writeFile(path.join(addedHome, "auth.json"), codexAuth("replacement"));
    await storage.mutateAgentAccounts((store) => ({
      store: {
        ...store,
        accounts: [
          { id: addedId, platform: "codex", label: "Second", createdAt: "2026-09-28T00:00:00Z" },
        ],
        active: { codex: addedId },
      },
      result: undefined,
    }));
    const replacement = await startLocalServerUnlocked(runtimeId, context, "codex");
    expect(replacement.wasRunning).toBe(false);
    expect(replacement.pid).not.toBe(started.pid);
    expect(await fs.readFile(path.join(isolatedHome, "auth.json"), "utf8")).toContain(
      "replacement",
    );
    expect(context.runtime.localServers.launchedAccountId(`codex:${runtimeId}`)).toBe(addedId);

    revoke.mockClear();
    context.runtime.localServers.process(`codex:${runtimeId}`)!.kill("SIGTERM");
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
      runtime: trackedRuntime(),
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
      runtime: trackedRuntime({
        localServers: {
          spawn: () => {
            throw new Error("spawn exploded");
          },
        },
      }),
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
      runtime: trackedRuntime(),
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
      runtime: trackedRuntime(),
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

  test("restarts an idle worker on the selected account without inherited API keys", async () => {
    const bridge = path.join(root, "bridges", "codex-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(
      path.join(bridge, "index.js"),
      `
await Bun.write(process.env.CWD + "/account-launch.json", JSON.stringify({
  home: process.env.CODEX_HOME, openaiKey: process.env.OPENAI_API_KEY ?? null,
  codexKey: process.env.CODEX_API_KEY ?? null,
}));
const server = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch() { return Response.json({ ok: true }); } });
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
`,
    );
    const project = await storage.addProject(createProject("remote", checkout));
    const environment = createEnvironment(project.id, {
      name: "account worker",
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
      runtime: trackedRuntime(),
      nativeAgents: { hasObservedLiveWork: async () => false },
    } as unknown as CommandContext;
    cleanupContext = context;
    cleanupRuntimeId = environment.id;
    const first = await startLocalServerUnlocked(environment.id, context, "codex");
    const accountId = "11111111-2222-4333-8444-555555555555";
    const home = path.join(storage.agentAccountsDirectory(), "codex", accountId);
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "auth.json"), '{"account":"selected"}');
    await storage.mutateAgentAccounts((store) => ({
      store: {
        ...store,
        accounts: [
          {
            id: accountId,
            platform: "codex",
            label: "Selected",
            createdAt: "2026-09-28T00:00:00Z",
          },
        ],
        active: { codex: accountId },
      },
      result: undefined,
    }));
    const previousOpenaiKey = process.env.OPENAI_API_KEY;
    const previousCodexKey = process.env.CODEX_API_KEY;
    process.env.OPENAI_API_KEY = "inherited";
    process.env.CODEX_API_KEY = "inherited";
    try {
      const second = await startLocalServerUnlocked(environment.id, context, "codex");
      expect(second.wasRunning).toBe(false);
      expect(second.pid).not.toBe(first.pid);
      expect(
        JSON.parse(await fs.readFile(path.join(checkout, "account-launch.json"), "utf8")),
      ).toEqual({
        home,
        openaiKey: null,
        codexKey: null,
      });
      expect(context.runtime.localServers.launchedAccountId(`codex:${environment.id}`)).toBe(
        accountId,
      );
    } finally {
      if (previousOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenaiKey;
      if (previousCodexKey === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = previousCodexKey;
    }
  });

  test("a worker bridge never inherits an attachment root or research setting from the backend's own environment", async () => {
    // The variable widens where a bridge may read attachments from, so an
    // inherited one would quietly extend a worker's boundary too.
    const bridge = path.join(root, "bridges", "codex-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(
      path.join(bridge, "index.js"),
      `await Bun.write(process.env.CWD + "/captured.json", JSON.stringify({ attachmentRoot: process.env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT ?? null, research: process.env.ORKESTRATOR_COORDINATOR_WEB_RESEARCH ?? null, researchMcp: process.env.ORKESTRATOR_COORDINATOR_RESEARCH_MCP ?? null }));
const server = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch() { return Response.json({ ok: true }); } });
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
`,
    );
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
      runtime: trackedRuntime(),
    } as CommandContext;
    cleanupContext = context;
    cleanupRuntimeId = environment.id;
    const inherited = {
      ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT: path.join(root, "inherited"),
      // Read-only review turns in a worker consult these, so an inherited
      // research setting would hand them search and research servers.
      ORKESTRATOR_COORDINATOR_WEB_RESEARCH: "search-and-mcp",
      ORKESTRATOR_COORDINATOR_RESEARCH_MCP: JSON.stringify([
        { name: "context7", url: "https://mcp.context7.com/mcp" },
      ]),
    };
    const previous = Object.fromEntries(
      Object.keys(inherited).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, inherited);
    try {
      await startLocalServerUnlocked(environment.id, context, "codex");
      expect(JSON.parse(await fs.readFile(path.join(checkout, "captured.json"), "utf8"))).toEqual({
        attachmentRoot: null,
        research: null,
        researchMcp: null,
      });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("a worker Codex bridge keeps the managed activation link rather than its target", async () => {
    // Canonicalizing the executable is a coordinator-only concession to its
    // deny-by-default permission profile. A worker must keep the activation
    // link, because Codex resolves the `codex-code-mode-host` companion from
    // the directory it was launched from and the toolchain symlinks that
    // companion next to the link, not only next to the pinned binary.
    const bridge = path.join(root, "bridges", "codex-bridge", "dist");
    await fs.mkdir(bridge, { recursive: true });
    await fs.writeFile(
      path.join(bridge, "index.js"),
      `await Bun.write(process.env.CWD + "/captured.json", JSON.stringify({ codexPath: process.env.CODEX_PATH ?? null, policy: process.env.CODEX_BRIDGE_EXECUTION_POLICY ?? null, permissionProfile: process.env.CODEX_BRIDGE_PERMISSION_PROFILE ?? null, readableRuntimeRoot: process.env.CODEX_BRIDGE_READABLE_RUNTIME_ROOT ?? null }));
const server = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch() { return Response.json({ ok: true }); } });
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
`,
    );
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
      toolchainBinDir: managedBin,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      runtime: trackedRuntime(),
    } as CommandContext;
    cleanupContext = context;
    cleanupRuntimeId = environment.id;

    await startLocalServerUnlocked(environment.id, context, "codex");
    expect(JSON.parse(await fs.readFile(path.join(checkout, "captured.json"), "utf8"))).toEqual({
      codexPath: path.join(managedBin, "codex"),
      // The coordinator boundary is the only thing that sets these, so a
      // worker that started reporting one would be running under a policy the
      // backend never issued for it.
      policy: null,
      permissionProfile: null,
      readableRuntimeRoot: null,
    });
  });

  test("a coordinator runtime refuses a bridge that is not its own platform", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    const runtimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    const context = {
      storage,
      coordinators: coordinator,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      runtime: trackedRuntime(),
    } as CommandContext;

    // Unassigned: nothing has been chosen yet, so there is no bridge to start.
    // This has to say so rather than surface as a retryable missing worktree,
    // which would be retried for good.
    await expect(startLocalServerUnlocked(runtimeId, context, "codex")).rejects.toThrow(
      "no agent yet",
    );

    await coordinator.assignConversationAgent(project.id, conversation.id, "codex");
    // The conversation's own provider is the authority. Starting some other
    // bridge here would hand that platform this conversation's scoped
    // credential and its private runtime directory.
    await expect(startLocalServerUnlocked(runtimeId, context, "claude")).rejects.toThrow(
      "belongs to a different agent platform",
    );
    await expect(startLocalServerUnlocked(runtimeId, context, "opencode")).rejects.toThrow(
      "belongs to a different agent platform",
    );
  });
});
