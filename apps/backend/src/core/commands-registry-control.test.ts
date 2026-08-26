import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import { StorageService } from "./storage.js";

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
