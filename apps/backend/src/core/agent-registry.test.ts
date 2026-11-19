import { registrarFrom } from "./commands-registry-contracts.js";
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
import { goalStatusSummary } from "@orkestrator/protocol/native-agent-goal";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { encodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import { ManualClock } from "@orkestrator/protocol/testing/manual-clock";
import { AgentRegistry } from "./agent-registry.js";
import { StorageService } from "./storage.js";

async function fixture(extraNativeTabs = 0) {
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
            ...Array.from({ length: extraNativeTabs }, (_, index) => ({
              id: `native-${index}`,
              type: "agent-native",
              nativeAgentData: { platform: "codex" },
            })),
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
  test("a tab between a goal's iterations reads idle, with the goal saying it will continue", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const summary = goalStatusSummary({
        goalId: "g1",
        status: "active",
        iterations: 4,
        maxIterations: 20,
        updatedAt: new Date(0).toISOString(),
      });
      const asked: string[] = [];
      const registry = new AgentRegistry(storage, {
        native: () => "idle",
        goal: async (environmentId, _agent, logicalSessionKey) => {
          asked.push(logicalSessionKey);
          return environmentId === "running-env" ? summary : undefined;
        },
      });
      const { entries } = await registry.snapshot({ projectId: "p1" });
      const running = entries.find(
        (entry) => entry.environmentId === "running-env" && entry.tabId === "native",
      );
      expect(running).toMatchObject({
        state: "idle",
        goal: { status: "active", running: true, iterations: 4, maxIterations: 20 },
      });
      // Only native tabs can hold a goal; a coordinator conversation never does.
      expect(asked.toSorted()).toEqual(["env-running-env:native", "env-stopped-env:native"]);
      expect(entries.filter((entry) => entry.goal)).toHaveLength(1);
    } finally {
      storage.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a coordinator conversation that failed to start reads stopped, and only that one", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await storage.coordinators.mutateCoordinatorWorkspace("p1", (current) => ({
        ...current!,
        conversations: [
          ...current!.conversations,
          {
            ...current!.conversations[0]!,
            id: "side",
            tabId: "coordinator-side",
            logicalSessionKey: "coordinator-coordinator-1:side",
            role: "side",
            sideOrdinal: 1,
            startupError: "bridge failed",
          },
        ],
      }));
      const registry = new AgentRegistry(storage, {
        native: () => "idle",
        tmux: () => undefined,
      });
      const states = Object.fromEntries(
        (await registry.snapshot({ projectId: "p1" })).entries
          .filter((entry) => entry.ownerKind === "coordinator")
          .map((entry) => [entry.tabId, entry.state]),
      );
      expect(states).toEqual({ "coordinator-main": "idle", "coordinator-side": "stopped" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

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
      registerAgentMailCommands(
        registrarFrom((name, handler) => {
          commands.set(name, handler);
        }),
      );
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
        sessionId: encodePublicSessionId(
          coordinatorRuntimeId("coordinator-1", "main"),
          "coordinator-main",
        ),
      });

      const one = await registry.snapshot({ environmentId: "stopped-env" });
      expect(one.environments).toEqual([
        expect.objectContaining({ environmentId: "stopped-env", tabs: 3, stopped: 3 }),
      ]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("names what a waiting native tab waits on only when asked, and only for that tab", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const asked: string[] = [];
      const pending = {
        interactionId: "approval-1",
        kind: "command-approval" as const,
        label: "Needs approval",
        detail: "Run bun install",
        since: 1_000,
        count: 1,
      };
      const registry = new AgentRegistry(storage, {
        native: (environmentId) => (environmentId === "running-env" ? "waiting" : "idle"),
        tmux: () => "waiting",
        pending: async (environmentId, _agent, logicalSessionKey) => {
          asked.push(`${environmentId}/${logicalSessionKey}`);
          return pending;
        },
      });
      // A plain snapshot never reaches a provider.
      const plain = await registry.snapshot({ projectId: "p1" });
      expect(asked).toEqual([]);
      expect(plain.entries.some((entry) => entry.pending)).toBe(false);

      const withPending = await registry.snapshot({ projectId: "p1" }, { includePending: true });
      // Only the waiting native tab is read: not tmux, not a stopped environment.
      expect(asked).toEqual(["running-env/env-running-env:native"]);
      expect(
        withPending.entries
          .filter((entry) => entry.pending)
          .map((entry) => [entry.environmentId, entry.tabId, entry.pending]),
      ).toEqual([["running-env", "native", pending]]);

      // The command passes the flag through, and only a literal `true` counts.
      const commands = new Map<string, CommandHandler>();
      registerAgentMailCommands(
        registrarFrom((name, handler) => {
          commands.set(name, handler);
        }),
      );
      const command = commands.get("get_agent_registry")!;
      const context = { agentRegistry: registry } as CommandContext;
      asked.length = 0;
      await command({ environmentId: "running-env", includePending: "yes" }, context);
      expect(asked).toEqual([]);
      const viaCommand = (await command(
        { environmentId: "running-env", includePending: true },
        context,
      )) as Awaited<ReturnType<AgentRegistry["snapshot"]>>;
      expect(viaCommand.entries.find((entry) => entry.tabId === "native")?.pending).toEqual(
        pending,
      );
    } finally {
      storage.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("one deadline bounds stalled tabs without dropping faster siblings", async () => {
    const { storage, dataDir } = await fixture(2);
    const clock = new ManualClock();
    const slow = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<void>();
    try {
      const registry = new AgentRegistry(
        storage,
        {
          native: () => "waiting",
          pending: async (_environmentId, _agent, key) => {
            if (key.endsWith(":native-1")) started.resolve();
            if (key.endsWith(":native") || key.endsWith(":native-1")) return slow.promise;
            return {
              interactionId: "request",
              kind: "question",
              label: "Question",
              since: 1,
              count: 1,
            };
          },
        },
        clock,
      );
      let returned = false;
      const reading = registry
        .snapshot({ environmentId: "running-env" }, { includePending: true })
        .then((result) => {
          returned = true;
          return result;
        });
      await started.promise;
      await clock.advanceAsync(1_999);
      expect(returned).toBe(false);
      await clock.advanceAsync(1);
      const result = await reading;
      expect(result.entries.filter((entry) => entry.pending).map((entry) => entry.tabId)).toEqual([
        "native-0",
      ]);
      expect(clock.pendingCount()).toBe(0);
    } finally {
      slow.resolve(undefined);
      storage.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a pending read that fails leaves the tab without a summary", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const registry = new AgentRegistry(storage, {
        native: () => "waiting",
        pending: async () => {
          throw new Error("bridge unreachable");
        },
      });
      const snapshot = await registry.snapshot(
        { environmentId: "running-env" },
        { includePending: true },
      );
      expect(snapshot.entries.find((entry) => entry.tabId === "native")).toMatchObject({
        state: "waiting",
      });
      expect(snapshot.entries.some((entry) => entry.pending)).toBe(false);
    } finally {
      storage.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
