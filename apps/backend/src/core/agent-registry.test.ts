import { registerAgentMailCommands } from "./commands-registry-mail.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { describeAgentRegistrySummary } from "@orkestrator/protocol/agent-registry";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { AgentRegistry } from "./agent-registry.js";
import { StorageService } from "./storage.js";

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-agent-registry-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addProject({
    id: "p1",
    name: "p1",
    gitUrl: "https://example.invalid/p1.git",
    localPath: null,
    addedAt: new Date(0).toISOString(),
    order: 0,
  });
  for (const [id, status] of [
    ["running-env", "running"],
    ["stopped-env", "stopped"],
  ] as const) {
    await storage.addEnvironment({
      id,
      projectId: "p1",
      name: id,
      branch: "main",
      containerId: null,
      status,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
    });
    await storage.savePaneLayout(
      id,
      {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane",
        root: {
          kind: "leaf",
          id: "pane",
          tabs: [
            { id: "native", type: "agent-native", nativeAgentData: { platform: "claude" } },
            { id: "tmux", type: "claude-tmux" },
            { id: "terminal", type: "codex" },
            { id: "shell", type: "plain" },
            { id: "review", type: "multi-review" },
          ],
          activeTabId: "native",
        },
      },
      0,
    );
  }
  const now = new Date(0).toISOString();
  await storage.coordinators.mutateCoordinatorWorkspace("p1", () => ({
    version: COORDINATOR_WORKSPACE_VERSION,
    id: "coordinator-1",
    projectId: "p1",
    executionPolicy: COORDINATOR_EXECUTION_POLICY,
    lifecycleState: "ready",
    conversations: [
      {
        id: "main",
        tabId: "coordinator-main",
        logicalSessionKey: "coordinator-coordinator-1:main",
        agent: "codex",
        title: "Coordinator",
        createdAt: now,
        mailboxIncarnationId: "incarnation-main",
        role: "main",
      },
    ],
    selectedConversationId: "main",
    repositoryContextRevision: 0,
    createdAt: now,
    updatedAt: now,
  }));
  return { storage, dataDir };
}

describe("AgentRegistry", () => {
  test("lists every agent tab and coordinator with live state and counts", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const registry = new AgentRegistry(storage, {
        native: (environmentId) =>
          environmentId === "running-env"
            ? "working"
            : environmentId.startsWith("coordinator:")
              ? "idle"
              : "unknown",
        tmux: () => "waiting",
      });
      const commands = new Map<string, CommandHandler>();
      registerAgentMailCommands((name, handler) => {
        commands.set(name, handler);
      });
      const context = { agentRegistry: registry } as CommandContext;
      const command = commands.get("get_agent_registry")!;
      // Two snapshots taken in turn can straddle a millisecond, so their clock
      // stamps may differ; everything else must match.
      const anyStamp = { generatedAt: expect.any(String) };
      const viaCommand = await command({ projectId: "p1", environmentId: "stopped-env" }, context);
      expect(viaCommand).toEqual({
        ...(await registry.snapshot({ projectId: "p1", environmentId: "stopped-env" })),
        ...anyStamp,
      });
      const unfiltered = await command({ projectId: 1, environmentId: null }, context);
      expect(unfiltered).toEqual({ ...(await registry.snapshot({})), ...anyStamp });
      await expect(command({}, {} as CommandContext)).rejects.toThrow(
        "Agent registry is unavailable",
      );
      const snapshot = await registry.snapshot({ projectId: "p1" });
      const states = Object.fromEntries(
        snapshot.entries.map((entry) => [`${entry.environmentId}/${entry.tabId}`, entry.state]),
      );
      expect(states).toEqual({
        "running-env/native": "working",
        "running-env/tmux": "waiting",
        // A terminal CLI reports no per-tab activity.
        "running-env/terminal": "unknown",
        "stopped-env/native": "stopped",
        "stopped-env/tmux": "stopped",
        "stopped-env/terminal": "stopped",
        [`${coordinatorRuntimeId("coordinator-1", "main")}/coordinator-main`]: "idle",
      });
      const running = snapshot.environments.find((item) => item.environmentId === "running-env")!;
      expect(running).toMatchObject({ tabs: 3, working: 1, waiting: 1, unknown: 1 });
      expect(describeAgentRegistrySummary(running)).toBe("3 agent tabs · 1 working · 1 waiting");
      expect(snapshot.entries.find((entry) => entry.ownerKind === "coordinator")).toMatchObject({
        coordinatorRole: "main",
        agent: "codex",
      });

      const one = await registry.snapshot({ environmentId: "stopped-env" });
      expect(one.environments).toEqual([
        expect.objectContaining({ environmentId: "stopped-env", tabs: 3, stopped: 3 }),
      ]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
