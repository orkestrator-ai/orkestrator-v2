import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import { StorageService } from "./storage.js";
import { terminalProcesses, terminalSessionConfigs } from "./commands-runtime-state.js";

describe("launch_control_job command", () => {
  test("reads and rotates the persistent control MCP credential through backend commands", async () => {
    const settings = {
      enabled: true,
      running: true,
      url: "http://127.0.0.1:34122/mcp",
      token: "persistent-token",
      error: null,
    };
    const rotated = { ...settings, token: "rotated-token" };
    const registry = createCommandRegistry();
    const getSettings = registry.get("get_control_mcp_settings");
    const rotateToken = registry.get("rotate_control_mcp_token");
    if (!getSettings || !rotateToken) throw new Error("Control MCP settings were not registered");
    const context = {
      controlMcp: {
        getSettings: () => settings,
        rotateToken: async () => rotated,
      },
    } as unknown as CommandContext;

    expect(await getSettings({}, context)).toEqual(settings);
    expect(await rotateToken({}, context)).toEqual(rotated);
  });

  test("creates a stable native tab and dispatches the requested prompt", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-command-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Ready environment",
      branch: "main",
      containerId: null,
      status: "running",
      setupPhase: "ready",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
    });
    const ensured: Array<Record<string, unknown>> = [];
    const dispatched: Array<Record<string, unknown>> = [];
    const context = {
      storage,
      emit: () => undefined,
      appRoot: "",
      resourceRoot: "",
      environmentLifecycleTasks: {},
      nativeAgents: {
        ensureSession: async (input: Record<string, unknown>) => {
          ensured.push(input);
          return { providerSessionId: "provider-session-1" };
        },
        dispatchIntent: async (input: Record<string, unknown>) => {
          dispatched.push(input);
          return { outcome: "accepted" };
        },
      },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("launch_control_job");
    if (!command) throw new Error("launch_control_job was not registered");

    try {
      const input = {
        requestId: "external-request-1",
        environmentId: "env-1",
        agent: "codex",
        title: "Independent job",
        prompt: "Fix the failing tests.",
      };
      const first = (await command(input, context)) as Record<string, unknown>;
      const second = (await command(input, context)) as Record<string, unknown>;

      expect(first).toMatchObject({
        environmentId: "env-1",
        agent: "codex",
        status: "accepted",
      });
      expect(second.tabId).toBe(first.tabId);
      expect(String(first.tabId)).toStartWith("agent-job-");
      expect(ensured[0]).toMatchObject({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: `env-env-1:${String(first.tabId)}`,
        sessionMode: "build",
      });
      expect(dispatched[0]).toMatchObject({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: `env-env-1:${String(first.tabId)}`,
        requestId: "external-request-1",
        prompt: "Fix the failing tests.",
        mode: "build",
      });
      const layout = await storage.getPaneLayout("env-1");
      expect(JSON.stringify(layout?.root).match(/"id":"agent-job-/g)).toHaveLength(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("launches renderer jobs entirely in the backend and arms PR refresh before dispatch", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-renderer-job-command-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Conflicting PR",
      branch: "feature/conflicts",
      containerId: null,
      status: "running",
      setupPhase: "ready",
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
    });
    const context = {
      storage,
      emit: () => undefined,
      appRoot: "",
      resourceRoot: "",
      environmentLifecycleTasks: {},
      nativeAgents: {
        ensureSession: async () => ({ providerSessionId: "provider-session-1" }),
        dispatchIntent: async () => {
          const environment = await storage.getEnvironment("env-1");
          expect(environment?.prRecheckAfterAgentCompletionArmedAt).toEqual(expect.any(String));
          const layout = await storage.getPaneLayout("env-1");
          expect(JSON.stringify(layout?.root)).toContain("provider-session-1");
          return { outcome: "accepted" as const };
        },
      },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("launch_native_agent_job");
    if (!command) throw new Error("launch_native_agent_job was not registered");

    try {
      const result = (await command(
        {
          requestId: "resolve-request-1",
          environmentId: "env-1",
          agent: "codex",
          modelId: "configured-resolved-model-id",
          reasoningId: "high",
          title: "Resolve",
          prompt: "Resolve the merge conflicts.",
          completionAction: "refresh-pr-after-agent-completion",
          activateTab: true,
        },
        context,
      )) as Record<string, unknown>;

      expect(result).toMatchObject({
        environmentId: "env-1",
        agent: "codex",
        status: "accepted",
      });
      const layout = await storage.getPaneLayout("env-1");
      expect(layout?.root).toMatchObject({
        kind: "leaf",
        activeTabId: result.tabId,
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rolls back the Resolve completion arm when backend dispatch is rejected", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-rejected-renderer-job-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Conflicting PR",
      branch: "feature/conflicts",
      containerId: null,
      status: "running",
      setupPhase: "ready",
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
    });
    const context = {
      storage,
      nativeAgents: {
        ensureSession: async () => ({ providerSessionId: "provider-session-1" }),
        dispatchIntent: async () => ({ outcome: "rejected" as const, error: "refused" }),
      },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("launch_native_agent_job");
    if (!command) throw new Error("launch_native_agent_job was not registered");

    try {
      await expect(
        command(
          {
            requestId: "resolve-request-1",
            environmentId: "env-1",
            agent: "codex",
            title: "Resolve",
            prompt: "Resolve the merge conflicts.",
            completionAction: "refresh-pr-after-agent-completion",
          },
          context,
        ),
      ).resolves.toMatchObject({ status: "rejected", error: "refused" });
      expect(
        (await storage.getEnvironment("env-1"))?.prRecheckAfterAgentCompletionArmedAt,
      ).toBeUndefined();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("launches Resolve when automatic PR refresh cannot be armed", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-unarmed-renderer-job-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Stale conflict state",
      branch: "feature/conflicts",
      containerId: null,
      status: "running",
      setupPhase: "ready",
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
      hasMergeConflicts: false,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
    });
    const dispatchIntent = mock(async () => ({ outcome: "accepted" as const }));
    const context = {
      storage,
      nativeAgents: {
        ensureSession: async () => ({ providerSessionId: "provider-session-1" }),
        dispatchIntent,
      },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("launch_native_agent_job");
    if (!command) throw new Error("launch_native_agent_job was not registered");

    try {
      await expect(
        command(
          {
            requestId: "resolve-request-1",
            environmentId: "env-1",
            agent: "codex",
            prompt: "Resolve the merge conflicts.",
            completionAction: "refresh-pr-after-agent-completion",
          },
          context,
        ),
      ).resolves.toMatchObject({
        status: "accepted",
        completionActionArmed: false,
        warning: expect.any(String),
      });
      expect(dispatchIntent).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects launches until an environment is running and setup-ready", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-command-state-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Stopped environment",
      branch: "main",
      containerId: null,
      status: "stopped",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
    });
    const command = createCommandRegistry().get("launch_control_job");
    if (!command) throw new Error("launch_control_job was not registered");

    try {
      await expect(
        command(
          {
            requestId: "external-request-1",
            environmentId: "env-1",
            agent: "codex",
            prompt: "Do work.",
          },
          {
            storage,
            nativeAgents: {},
          } as unknown as CommandContext,
        ),
      ).rejects.toThrow("Environment is not running with setup complete");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("preserves unknown and rejected dispatch outcomes for safe retries", async () => {
    const outcomes: Array<{
      outcome: "unknown" | "rejected";
      error: string;
    }> = [
      { outcome: "unknown", error: "Dispatch result could not be reconciled" },
      { outcome: "rejected", error: "Dispatch was refused" },
    ];
    const context = {
      storage: {
        getEnvironment: async () => ({
          id: "env-1",
          projectId: "project-1",
          status: "running",
          setupPhase: "ready",
        }),
        loadConfig: async () => ({ global: { enabledAgentPlatforms: ["codex"] } }),
        ensureNativeAgentJobTab: async () => ({}),
      },
      nativeAgents: {
        ensureSession: async () => ({ providerSessionId: "provider-session-1" }),
        dispatchIntent: async () => outcomes.shift()!,
      },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("launch_control_job");
    if (!command) throw new Error("launch_control_job was not registered");

    await expect(
      command(
        {
          requestId: "unknown-request",
          environmentId: "env-1",
          agent: "codex",
          prompt: "Do work.",
        },
        context,
      ),
    ).resolves.toMatchObject({
      status: "unknown",
      error: "Dispatch result could not be reconciled",
    });
    await expect(
      command(
        {
          requestId: "rejected-request",
          environmentId: "env-1",
          agent: "codex",
          prompt: "Do work.",
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "rejected", error: "Dispatch was refused" });
  });
});

describe("launch_terminal_job command", () => {
  test("publishes and starts a stable local terminal job without a renderer", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-terminal-job-command-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Ready environment",
      branch: "main",
      containerId: null,
      status: "running",
      setupPhase: "ready",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
    });
    const registry = createCommandRegistry();
    const launch = registry.get("launch_terminal_job");
    if (!launch) throw new Error("launch_terminal_job was not registered");
    const createSession = mock(async () => ({
      sessionId: "local-session-1",
      created: true,
      bootstrapped: false,
    }));
    const startSession = mock(async () => undefined);
    const bootstrap = mock(async () => ({
      bootstrapped: true,
      delivered: true,
      duplicate: false,
    }));
    registry.set("create_local_terminal_session", createSession);
    registry.set("start_local_terminal_session", startSession);
    registry.set("bootstrap_terminal_session", bootstrap);
    const ensureTerminalJobTab = spyOn(storage, "ensureTerminalJobTab");
    const context = { storage } as unknown as CommandContext;

    try {
      const input = {
        requestId: "run-command-1",
        environmentId: "env-1",
        tabType: "plain",
        title: "Run Commands",
        data: "bun test\n",
        activateTab: true,
      };
      const first = (await launch(input, context)) as Record<string, unknown>;
      expect(ensureTerminalJobTab).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          activate: false,
          existingOnly: true,
          terminalSessionId: "local-session-1",
        }),
      );
      const layoutAfterFirstLaunch = await storage.getPaneLayout("env-1");
      const second = (await launch(input, context)) as Record<string, unknown>;

      expect(first).toMatchObject({
        environmentId: "env-1",
        tabType: "plain",
        sessionId: "local-session-1",
        status: "started",
      });
      expect(second.tabId).toBe(first.tabId);
      expect(createSession).toHaveBeenLastCalledWith(
        expect.objectContaining({
          environmentId: "env-1",
          terminalKey: first.tabId,
          trackEnvironmentActivity: false,
        }),
        context,
      );
      expect(startSession).toHaveBeenCalledWith({ sessionId: "local-session-1" }, context);
      expect(bootstrap).toHaveBeenCalledWith(
        { sessionId: "local-session-1", data: "bun test\n" },
        context,
      );
      const layout = await storage.getPaneLayout("env-1");
      expect(layout?.root).toEqual(layoutAfterFirstLaunch?.root);
      expect(layout?.activePaneId).toBe(layoutAfterFirstLaunch?.activePaneId);
      expect(layout?.containerId).toBe(layoutAfterFirstLaunch?.containerId);
      expect(layout?.revision).toBe(layoutAfterFirstLaunch?.revision);
      expect(layout?.root).toMatchObject({
        kind: "leaf",
        activeTabId: first.tabId,
        tabs: [
          {
            id: "default",
            type: "plain",
            isSetupTab: true,
          },
          {
            id: first.tabId,
            type: "plain",
            displayTitle: "Run Commands",
            backendManagedTerminal: true,
            backendTerminalSessionId: "local-session-1",
          },
        ],
      });
      expect(JSON.stringify(layout?.root).match(/"id":"terminal-job-/g)).toHaveLength(1);
      expect(JSON.stringify(layout?.root)).not.toContain("initialCommands");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("does not reactivate the job tab when bootstrap finishes after the user moves focus", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-terminal-job-focus-race-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Ready environment",
      branch: "main",
      containerId: null,
      status: "running",
      setupPhase: "ready",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
    });
    const registry = createCommandRegistry();
    const launch = registry.get("launch_terminal_job");
    if (!launch) throw new Error("launch_terminal_job was not registered");
    let releaseBootstrap!: () => void;
    let signalBootstrap!: () => void;
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const bootstrapEntered = new Promise<void>((resolve) => {
      signalBootstrap = resolve;
    });
    registry.set("create_local_terminal_session", async () => ({
      sessionId: "local-session-1",
      created: true,
      bootstrapped: false,
    }));
    registry.set("start_local_terminal_session", async () => undefined);
    registry.set("bootstrap_terminal_session", async () => {
      signalBootstrap();
      await bootstrapGate;
      return { bootstrapped: true, delivered: true, duplicate: false };
    });
    const context = { storage } as unknown as CommandContext;

    try {
      const launching = launch(
        {
          requestId: "focus-race",
          environmentId: "env-1",
          tabId: "job-tab",
          tabType: "plain",
          data: "bun test\n",
          activateTab: true,
        },
        context,
      );
      await bootstrapEntered;
      const published = await storage.getPaneLayout("env-1");
      const publishedRoot = published?.root as
        | {
            kind: string;
            id: string;
            tabs: unknown[];
            activeTabId: string | null;
          }
        | undefined;
      if (!published || publishedRoot?.kind !== "leaf") throw new Error("Expected leaf layout");
      await storage.savePaneLayout(
        "env-1",
        {
          version: published.version,
          containerId: published.containerId,
          activePaneId: published.activePaneId,
          root: { ...publishedRoot, activeTabId: "default" },
        },
        published.revision,
      );
      releaseBootstrap();
      await launching;

      const completed = await storage.getPaneLayout("env-1");
      expect(completed?.root).toMatchObject({
        activeTabId: "default",
        tabs: expect.arrayContaining([
          expect.objectContaining({
            id: "job-tab",
            backendTerminalSessionId: "local-session-1",
          }),
        ]),
      });
    } finally {
      releaseBootstrap();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects a stable session bootstrapped with different launch data", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-terminal-job-duplicate-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Ready environment",
      branch: "main",
      containerId: null,
      status: "running",
      setupPhase: "ready",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
    });
    const registry = createCommandRegistry();
    const launch = registry.get("launch_terminal_job");
    if (!launch) throw new Error("launch_terminal_job was not registered");
    registry.set("create_local_terminal_session", async () => ({
      sessionId: "renderer-session",
      created: false,
      bootstrapped: true,
    }));
    registry.set("start_local_terminal_session", async () => undefined);
    registry.set("bootstrap_terminal_session", async () => ({
      bootstrapped: true,
      delivered: false,
      duplicate: true,
      matchesExisting: false,
    }));
    const context = { storage } as unknown as CommandContext;

    try {
      await expect(
        launch(
          {
            requestId: "startup-1",
            environmentId: "env-1",
            tabId: "startup-agent",
            tabType: "codex",
            data: 'codex "Fix it"\n',
          },
          context,
        ),
      ).rejects.toThrow("already bootstrapped by another owner");
      expect(JSON.stringify((await storage.getPaneLayout("env-1"))?.root)).toContain(
        '"backendManagedTerminal":true',
      );
      expect(JSON.stringify((await storage.getPaneLayout("env-1"))?.root)).not.toContain(
        "backendTerminalSessionId",
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("starts Claude tmux once and preserves its opening options", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-terminal-job-tmux-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Ready environment",
      branch: "main",
      containerId: null,
      status: "running",
      setupPhase: "ready",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
    });
    const registry = createCommandRegistry();
    const launch = registry.get("launch_terminal_job");
    if (!launch) throw new Error("launch_terminal_job was not registered");
    const status = mock()
      .mockResolvedValueOnce({ running: false })
      .mockResolvedValueOnce({ running: true });
    const start = mock(async () => undefined);
    registry.set("claude_tmux_status", status);
    registry.set("claude_tmux_start", start);
    const context = { storage } as unknown as CommandContext;

    try {
      await launch(
        {
          requestId: "tmux-1",
          environmentId: "env-1",
          tabId: "startup-agent",
          tabType: "claude-tmux",
          initialPrompt: "Fix it",
          model: "opus",
          reasoningEffort: "high",
          fastMode: true,
        },
        context,
      );
      await launch(
        {
          requestId: "tmux-1",
          environmentId: "env-1",
          tabId: "startup-agent",
          tabType: "claude-tmux",
          initialPrompt: "Fix it",
          model: "opus",
          reasoningEffort: "high",
          fastMode: true,
        },
        context,
      );
      expect(status).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith(
        {
          tabId: "startup-agent",
          environmentId: "env-1",
          initialPrompt: "Fix it",
          model: "opus",
          effort: "high",
          fastMode: true,
        },
        context,
      );
      expect((await storage.getPaneLayout("env-1"))?.root).toMatchObject({
        kind: "leaf",
        tabs: expect.arrayContaining([
          expect.objectContaining({
            id: "startup-agent",
            type: "claude-tmux",
            backendManagedTerminal: true,
          }),
        ]),
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("validates terminal job type, lifecycle, and container availability", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-terminal-job-validation-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Stopped environment",
      branch: "main",
      containerId: null,
      status: "stopped",
      setupPhase: "pending",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "containerized",
    });
    const registry = createCommandRegistry();
    const launch = registry.get("launch_terminal_job");
    if (!launch) throw new Error("launch_terminal_job was not registered");
    const context = { storage } as unknown as CommandContext;

    try {
      await expect(
        launch(
          {
            requestId: "invalid-type",
            environmentId: "env-1",
            tabType: "cursor",
            data: "cursor\n",
          },
          context,
        ),
      ).rejects.toThrow("tab type is invalid");
      await expect(
        launch(
          {
            requestId: "stopped",
            environmentId: "env-1",
            tabType: "plain",
            data: "bun test\n",
          },
          context,
        ),
      ).rejects.toThrow("setup complete");

      await storage.updateEnvironment("env-1", { status: "running", setupPhase: "ready" });
      await expect(
        launch(
          {
            requestId: "missing-container",
            environmentId: "env-1",
            tabType: "plain",
            data: "bun test\n",
          },
          context,
        ),
      ).rejects.toThrow("container is unavailable");
      expect(await storage.getPaneLayout("env-1")).toBeNull();

      await storage.updateEnvironment("env-1", { containerId: "container-1" });
      const createContainerSession = mock(async () => ({
        sessionId: "container-session-1",
        created: true,
        bootstrapped: false,
      }));
      registry.set("create_terminal_session", createContainerSession);
      registry.set("start_terminal_session", async () => undefined);
      registry.set("bootstrap_terminal_session", async () => ({
        bootstrapped: true,
        delivered: true,
        duplicate: false,
      }));
      await expect(
        launch(
          {
            requestId: "container-success",
            environmentId: "env-1",
            tabType: "codex",
            data: 'codex "Fix it"\n',
          },
          context,
        ),
      ).resolves.toMatchObject({ sessionId: "container-session-1", status: "started" });
      expect(createContainerSession).toHaveBeenCalledWith(
        expect.objectContaining({
          containerId: "container-1",
          environmentId: "env-1",
          trackEnvironmentActivity: true,
        }),
        context,
      );

      registry.set("bootstrap_terminal_session", async () => ({
        bootstrapped: false,
        delivered: false,
        duplicate: false,
      }));
      await expect(
        launch(
          {
            requestId: "bootstrap-failure",
            environmentId: "env-1",
            tabType: "codex",
            data: 'codex "Fix it"\n',
          },
          context,
        ),
      ).rejects.toThrow("could not be started");

      await storage.updateEnvironment("env-1", { lifecycleOperation: "deleting" });
      await expect(
        launch(
          {
            requestId: "deleting",
            environmentId: "env-1",
            tabType: "plain",
            data: "bun test\n",
          },
          context,
        ),
      ).rejects.toThrow("being deleted");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("bootstrap_terminal_session command", () => {
  test("distinguishes an idempotent replay from different launch data", async () => {
    const registry = createCommandRegistry();
    const bootstrap = registry.get("bootstrap_terminal_session");
    if (!bootstrap) throw new Error("bootstrap_terminal_session was not registered");
    const sessionId = `bootstrap-test-${randomUUID()}`;
    const write = mock((_data: string) => undefined);
    terminalProcesses.set(sessionId, { write } as never);
    terminalSessionConfigs.set(sessionId, {
      kind: "local",
      environmentId: "env-1",
      cols: 80,
      rows: 24,
      trackEnvironmentActivity: false,
    });

    try {
      expect(
        bootstrap({ sessionId, data: 'codex "Fix it"\n' }, {} as CommandContext),
      ).toMatchObject({ delivered: true, duplicate: false });
      expect(
        bootstrap({ sessionId, data: 'codex "Fix it"\n' }, {} as CommandContext),
      ).toMatchObject({ duplicate: true, matchesExisting: true });
      expect(bootstrap({ sessionId, data: "codex\n" }, {} as CommandContext)).toMatchObject({
        duplicate: true,
        matchesExisting: false,
      });
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      terminalProcesses.delete(sessionId);
      terminalSessionConfigs.delete(sessionId);
    }
  });
});
