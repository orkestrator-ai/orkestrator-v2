import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEnvironment, StorageService } from "./storage.js";
import { MAX_TABS_PER_ENVIRONMENT, PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { seedStore, seedUnreadableStore, withTemporaryStorage } from "./storage-test-support.js";

describe("backend-owned setup and build surfaces", () => {
  test("normalizes pre-setupPhase environment records on every read", async () => {
    await withTemporaryStorage(async (_storage, dataDir) => {
      const completed = createEnvironment("project-1");
      completed.id = "ready-legacy";
      completed.setupScriptsComplete = true;
      const incomplete = createEnvironment("project-1");
      incomplete.id = "pending-legacy";
      const legacy = [completed, incomplete].map((environment) => {
        const record = { ...environment };
        delete record.setupPhase;
        delete record.setupOverride;
        return record;
      });
      seedStore(dataDir, "environments.json", legacy);

      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect((await restarted.getEnvironment("ready-legacy"))?.setupPhase).toBe("ready");
      expect((await restarted.getEnvironment("pending-legacy"))?.setupPhase).toBe("pending");
    });
  });

  test("persists the branch revision used to avoid historical head reuse", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      await storage.updateEnvironment(environment.id, { branchRevision: 2 });

      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect((await restarted.getEnvironment(environment.id))?.branchRevision).toBe(2);
    });
  });

  test("creates and refreshes the build tab in the authoritative pane layout", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-build-tab";
      environment.containerId = "container-1";
      await storage.addEnvironment(environment);

      const first = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: false,
      });
      expect(first.root).toMatchObject({
        kind: "leaf",
        activeTabId: "build-pipeline-1",
        tabs: [
          {
            type: "claude-build",
            buildTabData: { pipelineId: "pipeline-1", taskId: "task-1" },
          },
        ],
      });

      const second = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-2",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: false,
      });
      expect(second.version).toBe(PANE_LAYOUT_VERSION);
      expect(second.revision).toBe(first.revision + 1);
      const root = second.root as {
        kind?: unknown;
        tabs?: Array<Record<string, unknown>>;
      };
      if (root.kind !== "leaf" || !Array.isArray(root.tabs)) {
        throw new Error("expected a leaf layout");
      }
      expect(root.tabs).toHaveLength(1);
      expect(root.tabs[0]).toMatchObject({
        id: "build-pipeline-1",
        buildTabData: { pipelineId: "pipeline-2", taskId: "task-1" },
      });
    });
  });

  test("publishes a backend-owned native startup tab beside the setup terminal", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-cursor-startup";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);

      const layout = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        providerSessionId: "cursor-session-1",
      });

      expect(layout?.root).toMatchObject({
        kind: "leaf",
        activeTabId: "startup-agent",
        tabs: [
          { id: "default", type: "plain", isSetupTab: true },
          {
            id: "startup-agent",
            type: "agent-native",
            nativeAgentData: {
              platform: "cursor",
              environmentId: environment.id,
              sessionId: "cursor-session-1",
              isLocal: true,
            },
          },
        ],
      });
    });
  });

  test("publishes a backend-managed terminal job beside the setup terminal", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-terminal-startup";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);

      const layout = await storage.ensureTerminalJobTab({
        environmentId: environment.id,
        tabId: "startup-agent",
        type: "codex",
        activate: true,
        terminalSessionId: "backend-session-1",
      });

      expect(layout.root).toMatchObject({
        kind: "leaf",
        activeTabId: "startup-agent",
        tabs: [
          { id: "default", type: "plain", isSetupTab: true },
          {
            id: "startup-agent",
            type: "codex",
            backendManagedTerminal: true,
            backendTerminalSessionId: "backend-session-1",
          },
        ],
      });

      const pendingLayout = await storage.ensureTerminalJobTab({
        environmentId: environment.id,
        tabId: "startup-agent",
        type: "codex",
        terminalSessionId: null,
      });
      expect(JSON.stringify(pendingLayout.root)).not.toContain("backendTerminalSessionId");
    });
  });

  test("invalidates backend terminal identities from a previous process", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-stale-terminal-session";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      const otherEnvironment = createEnvironment("project-1");
      otherEnvironment.id = "env-live-terminal-session";
      otherEnvironment.environmentType = "local";
      otherEnvironment.containerId = null;
      await storage.addEnvironment(otherEnvironment);

      const published = await storage.ensureTerminalJobTab({
        environmentId: environment.id,
        tabId: "job-tab",
        type: "plain",
        activate: true,
        terminalSessionId: "previous-process-session",
      });
      await storage.ensureTerminalJobTab({
        environmentId: otherEnvironment.id,
        tabId: "live-job-tab",
        type: "plain",
        terminalSessionId: "current-process-session",
      });
      expect(await storage.clearBackendTerminalSessionIds(environment.id)).toBe(1);

      const cleared = await storage.getPaneLayout(environment.id);
      expect(JSON.stringify(cleared?.root)).not.toContain("backendTerminalSessionId");
      expect(cleared?.activePaneId).toBe(published.activePaneId);
      expect(cleared?.root).toMatchObject({ activeTabId: "job-tab" });
      expect(cleared?.revision).toBe(published.revision + 1);
      expect(JSON.stringify((await storage.getPaneLayout(otherEnvironment.id))?.root)).toContain(
        "current-process-session",
      );
      expect(await storage.clearBackendTerminalSessionIds()).toBe(1);
      expect(await storage.clearBackendTerminalSessionIds()).toBe(0);
      expect((await storage.getPaneLayout(environment.id))?.revision).toBe(cleared?.revision);
    });
  });

  test("does not recreate a terminal tab during an existing-only identity publish", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-closed-terminal-job";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);

      const existing = await storage.ensureTerminalJobTab({
        environmentId: environment.id,
        tabId: "job-tab",
        type: "plain",
        activate: true,
      });
      const withoutJob = await storage.savePaneLayout(
        environment.id,
        {
          version: existing.version,
          containerId: existing.containerId,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{ id: "default", type: "plain", isSetupTab: true }],
            activeTabId: "default",
          },
        },
        existing.revision,
      );

      const result = await storage.ensureTerminalJobTab({
        environmentId: environment.id,
        tabId: "job-tab",
        type: "plain",
        activate: false,
        terminalSessionId: "late-session",
        existingOnly: true,
      });

      expect(result).toEqual(withoutJob);
      expect(JSON.stringify(result.root)).not.toContain("job-tab");
    });
  });

  test("publishes Claude tmux metadata for local and container environments", async () => {
    await withTemporaryStorage(async (storage) => {
      const local = createEnvironment("project-1");
      local.id = "env-local-tmux";
      local.environmentType = "local";
      local.containerId = null;
      await storage.addEnvironment(local);

      const container = createEnvironment("project-1");
      container.id = "env-container-tmux";
      container.environmentType = "containerized";
      container.containerId = "container-1";
      await storage.addEnvironment(container);

      const localLayout = await storage.ensureTerminalJobTab({
        environmentId: local.id,
        tabId: "startup-agent",
        type: "claude-tmux",
      });
      const containerLayout = await storage.ensureTerminalJobTab({
        environmentId: container.id,
        tabId: "startup-agent",
        type: "claude-tmux",
      });

      expect(localLayout.root).toMatchObject({
        tabs: expect.arrayContaining([
          expect.objectContaining({
            id: "startup-agent",
            claudeTmuxData: { environmentId: local.id, isLocal: true },
          }),
        ]),
      });
      expect(containerLayout.root).toMatchObject({
        tabs: expect.arrayContaining([
          expect.objectContaining({
            id: "startup-agent",
            claudeTmuxData: {
              environmentId: container.id,
              isLocal: false,
              containerId: "container-1",
            },
          }),
        ]),
      });
    });
  });

  test("terminal job republication removes stale one-shot launch payloads", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-terminal-republish";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              {
                id: "startup-agent",
                type: "codex",
                initialPrompt: "stale",
                initialCommands: ["echo stale"],
                initialAgentModel: "stale-model",
                initialReasoningEffort: "high",
                initialConversationMode: "plan",
                initialFastMode: true,
                nativeAgentData: { platform: "codex" },
                claudeTmuxData: { environmentId: environment.id, isLocal: true },
              },
            ],
            activeTabId: "startup-agent",
          },
        },
        0,
      );

      const layout = await storage.ensureTerminalJobTab({
        environmentId: environment.id,
        tabId: "startup-agent",
        type: "codex",
      });
      const serialized = JSON.stringify(layout.root);
      expect(serialized).not.toContain("initialPrompt");
      expect(serialized).not.toContain("initialCommands");
      expect(serialized).not.toContain("initialAgentModel");
      expect(serialized).not.toContain("initialReasoningEffort");
      expect(serialized).not.toContain("initialConversationMode");
      expect(serialized).not.toContain("initialFastMode");
      expect(serialized).not.toContain("nativeAgentData");
      expect(serialized).not.toContain("claudeTmuxData");
    });
  });

  test("terminal job publication rejects tab identity collisions and the layout cap", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-terminal-bounds";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: Array.from({ length: MAX_TABS_PER_ENVIRONMENT }, (_, index) => ({
              id: index === 0 ? "collision" : `tab-${index}`,
              type: index === 0 ? "browser" : "plain",
            })),
            activeTabId: "collision",
          },
        },
        0,
      );

      await expect(
        storage.ensureTerminalJobTab({
          environmentId: environment.id,
          tabId: "collision",
          type: "plain",
        }),
      ).rejects.toThrow("Tab ID is already in use");
      await expect(
        storage.ensureTerminalJobTab({
          environmentId: environment.id,
          tabId: "one-too-many",
          type: "plain",
        }),
      ).rejects.toThrow(`maximum of ${MAX_TABS_PER_ENVIRONMENT} tabs`);
    });
  });

  test("does not steal setup focus when republishing the startup tab during setup", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-during-setup-focus";
      environment.environmentType = "local";
      environment.containerId = null;
      environment.setupPhase = "running";
      await storage.addEnvironment(environment);
      await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
      });
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              {
                id: "startup-agent",
                type: "agent-native",
                nativeAgentData: {
                  platform: "codex",
                  environmentId: environment.id,
                  isLocal: true,
                },
              },
            ],
            activeTabId: "default",
          },
        },
        1,
      );

      const republished = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
      });

      expect(republished?.root).toMatchObject({ activeTabId: "default" });

      // Binding a session is what unlocks the handoff, but only after setup.
      // While setup runs the user is still watching the terminal.
      const bound = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });

      expect(bound?.root).toMatchObject({ activeTabId: "default" });
    });
  });

  test("hands focus from the setup terminal to the startup agent once setup is ready", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-setup-handoff";
      environment.environmentType = "local";
      environment.containerId = null;
      environment.setupPhase = "running";
      await storage.addEnvironment(environment);
      await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
      });
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              {
                id: "startup-agent",
                type: "agent-native",
                nativeAgentData: {
                  platform: "codex",
                  environmentId: environment.id,
                  isLocal: true,
                },
              },
            ],
            activeTabId: "default",
          },
        },
        1,
      );
      await storage.updateEnvironment(environment.id, {
        setupPhase: "ready",
        setupScriptsComplete: true,
      });

      const handedOff = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });

      expect(handedOff?.root).toMatchObject({
        activeTabId: "startup-agent",
        tabs: [
          { id: "default", type: "plain", isSetupTab: true },
          { id: "startup-agent", type: "agent-native" },
        ],
      });
    });
  });

  test("does not steal a non-setup tab when republishing the startup agent after setup", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-keep-user-focus";
      environment.environmentType = "local";
      environment.containerId = null;
      environment.setupPhase = "ready";
      environment.setupScriptsComplete = true;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              { id: "notes", type: "file" },
              {
                id: "startup-agent",
                type: "agent-native",
                nativeAgentData: {
                  platform: "codex",
                  environmentId: environment.id,
                  isLocal: true,
                },
              },
            ],
            activeTabId: "notes",
          },
        },
        0,
      );

      const republished = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });

      expect(republished?.root).toMatchObject({ activeTabId: "notes" });
    });
  });

  test("does not re-steal the setup terminal once the startup tab is already bound", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-no-resteal";
      environment.environmentType = "local";
      environment.containerId = null;
      environment.setupPhase = "ready";
      environment.setupScriptsComplete = true;
      await storage.addEnvironment(environment);
      // The state a launch retry loop republishes against: the handoff already
      // happened, the user has since gone back to the setup terminal, and the
      // tab already carries this provider session.
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              {
                id: "startup-agent",
                type: "agent-native",
                nativeAgentData: {
                  platform: "codex",
                  environmentId: environment.id,
                  isLocal: true,
                  sessionId: "codex-session-1",
                },
              },
            ],
            activeTabId: "default",
          },
        },
        0,
      );

      const before = await storage.getPaneLayout(environment.id);

      const rebound = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });
      expect(rebound?.root).toMatchObject({ activeTabId: "default" });

      // A sweep that republishes without provider identity at all — the
      // every-two-seconds call the reconciler makes before the session exists —
      // must not activate either.
      const swept = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
      });
      expect(swept?.root).toMatchObject({ activeTabId: "default" });
      // Neither call changed anything, so neither burns a revision — the sweep
      // must not announce a layout the renderer would then re-adopt.
      expect(rebound?.revision).toBe(before!.revision);
      expect(swept?.revision).toBe(before!.revision);
    });
  });

  test("keeps a split layout's user selection when only the other pane shows setup", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-split-focus";
      environment.environmentType = "local";
      environment.containerId = null;
      environment.setupPhase = "ready";
      environment.setupScriptsComplete = true;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "left",
          root: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            sizes: [0.5, 0.5],
            children: [
              {
                kind: "leaf",
                id: "left",
                tabs: [{ id: "default", type: "plain", isSetupTab: true }],
                activeTabId: "default",
              },
              {
                kind: "leaf",
                id: "right",
                tabs: [
                  { id: "notes", type: "plain" },
                  {
                    id: "startup-agent",
                    type: "agent-native",
                    nativeAgentData: {
                      platform: "codex",
                      environmentId: environment.id,
                      isLocal: true,
                    },
                  },
                ],
                activeTabId: "notes",
              },
            ],
          },
        },
        0,
      );

      const republished = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });

      // The focused pane is on setup, but the startup agent's own pane holds a
      // tab the user chose. Neither that selection nor pane focus may move.
      expect(republished?.root).toMatchObject({
        children: [
          { id: "left", activeTabId: "default" },
          { id: "right", activeTabId: "notes" },
        ],
      });
      expect(republished?.activePaneId).toBe("left");
    });
  });

  test("hands off from a setup override that never reported a ready phase", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-setup-override";
      environment.environmentType = "local";
      environment.containerId = null;
      environment.setupPhase = "running";
      environment.setupScriptsComplete = false;
      environment.setupOverride = true;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              {
                id: "startup-agent",
                type: "agent-native",
                nativeAgentData: {
                  platform: "codex",
                  environmentId: environment.id,
                  isLocal: true,
                },
              },
            ],
            activeTabId: "default",
          },
        },
        0,
      );

      const handedOff = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });

      expect(handedOff?.root).toMatchObject({ activeTabId: "startup-agent" });
    });
  });

  test("repairs a malformed Cursor startup tab in place without resurrecting a closed tab", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-cursor-repair";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              { id: "startup-agent", type: "cursor" },
            ],
            activeTabId: "startup-agent",
          },
        },
        0,
      );

      const repaired = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        providerSessionId: "cursor-session-1",
        existingOnly: true,
      });
      expect(repaired?.revision).toBe(2);
      expect(repaired?.root).toMatchObject({
        tabs: [
          { id: "default", type: "plain", isSetupTab: true },
          {
            id: "startup-agent",
            type: "agent-native",
            nativeAgentData: { platform: "cursor", sessionId: "cursor-session-1" },
          },
        ],
      });

      const withoutStartup = createEnvironment("project-1");
      withoutStartup.id = "env-closed-startup";
      withoutStartup.environmentType = "local";
      withoutStartup.containerId = null;
      await storage.addEnvironment(withoutStartup);
      await storage.savePaneLayout(
        withoutStartup.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{ id: "default", type: "plain" }],
            activeTabId: "default",
          },
        },
        0,
      );
      await expect(
        storage.ensureStartupNativeAgentTab({
          environmentId: withoutStartup.id,
          agent: "cursor",
          providerSessionId: "closed-session",
          existingOnly: true,
        }),
      ).resolves.toBeNull();
      expect((await storage.getPaneLayout(withoutStartup.id))?.revision).toBe(1);
    });
  });

  test("preserves the user's own tab state when publishing provider identity", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-merge";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              {
                id: "startup-agent",
                type: "cursor",
                displayTitle: "Reviewer",
                agentHandoffId: "handoff-1",
                consumedAgentHandoffId: "handoff-0",
                initialAgentModel: "chosen-model",
                initialReasoningEffort: "high",
                initialConversationMode: "plan",
                initialFastMode: true,
                isReviewTab: true,
                // Payload for a tab kind this tab definitively is not.
                initialCommands: ["echo stale"],
                nativeAgentData: {
                  platform: "cursor",
                  environmentId: environment.id,
                  hostPort: 4321,
                },
              },
            ],
            activeTabId: "startup-agent",
          },
        },
        0,
      );

      const published = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        providerSessionId: "cursor-session-1",
      });

      const startupTab = (
        published!.root as {
          tabs: Array<Record<string, unknown>>;
        }
      ).tabs[1]!;
      // Everything the backend does not own survives; only the native identity
      // is authored here. A wholesale rewrite silently dropped all of this.
      expect(startupTab).toMatchObject({
        id: "startup-agent",
        type: "agent-native",
        displayTitle: "Reviewer",
        agentHandoffId: "handoff-1",
        consumedAgentHandoffId: "handoff-0",
        initialAgentModel: "chosen-model",
        initialReasoningEffort: "high",
        initialConversationMode: "plan",
        initialFastMode: true,
        isReviewTab: true,
        nativeAgentData: {
          platform: "cursor",
          environmentId: environment.id,
          hostPort: 4321,
          sessionId: "cursor-session-1",
          isLocal: true,
        },
      });
      expect(startupTab.initialCommands).toBeUndefined();
    });
  });

  test("leaves a healthy native startup tab untouched when only upgrading", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-upgrade-only";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              {
                id: "startup-agent",
                type: "agent-native",
                displayTitle: "Renamed by the user",
                nativeAgentData: {
                  platform: "cursor",
                  environmentId: environment.id,
                  sessionId: "resumed-elsewhere",
                  isLocal: true,
                },
              },
            ],
            activeTabId: "startup-agent",
          },
        },
        0,
      );

      // The repair runs on every backend start, so a tab that already holds the
      // native identity must not be rewritten toward a different session.
      const result = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        providerSessionId: "cursor-session-1",
        existingOnly: true,
        upgradeOnly: true,
      });

      expect(result?.revision).toBe(1);
      expect((await storage.getPaneLayout(environment.id))?.root).toMatchObject({
        tabs: [
          { id: "default" },
          {
            id: "startup-agent",
            displayTitle: "Renamed by the user",
            nativeAgentData: { sessionId: "resumed-elsewhere" },
          },
        ],
      });
    });
  });

  test("republishing an unchanged startup tab does not bump the layout revision", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-idempotent";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);

      const first = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });
      // The two-second launch sweep republishes while setup runs, so a repeat
      // call must be a read, not a write.
      const second = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });

      expect(second?.revision).toBe(first?.revision);
      expect(second?.updatedAt).toBe(first?.updatedAt);
    });
  });

  test("publishes the startup tab into the pane that already holds it in a split", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-split";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "left",
          root: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            sizes: [0.5, 0.5],
            children: [
              {
                kind: "leaf",
                id: "left",
                tabs: [{ id: "default", type: "plain", isSetupTab: true }],
                activeTabId: "default",
              },
              {
                kind: "leaf",
                id: "right",
                tabs: [{ id: "startup-agent", type: "cursor" }],
                activeTabId: "startup-agent",
              },
            ],
          },
        },
        0,
      );

      const published = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        providerSessionId: "cursor-session-1",
      });

      // The walk must find the tab in the non-active leaf rather than appending
      // a duplicate into the active one.
      expect(published?.root).toMatchObject({
        kind: "split",
        children: [
          { id: "left", tabs: [{ id: "default" }] },
          {
            id: "right",
            tabs: [
              {
                id: "startup-agent",
                type: "agent-native",
                nativeAgentData: { sessionId: "cursor-session-1" },
              },
            ],
          },
        ],
      });
    });
  });

  test("omits a container id the environment does not have yet", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-precontainer";
      environment.environmentType = "containerized";
      environment.containerId = null;
      await storage.addEnvironment(environment);

      // Published while the environment is still `creating`, so there is no
      // container to name yet.
      const published = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
      });
      const startupTab = (
        published!.root as {
          tabs: Array<Record<string, unknown>>;
        }
      ).tabs[1]!;
      expect(startupTab.nativeAgentData).toEqual({
        environmentId: environment.id,
        isLocal: false,
      });

      await storage.updateEnvironment(environment.id, { containerId: "container-1" });
      const rebound = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });
      expect(
        (
          rebound!.root as {
            tabs: Array<Record<string, unknown>>;
          }
        ).tabs[1]!.nativeAgentData,
      ).toEqual({
        platform: "codex",
        environmentId: environment.id,
        isLocal: false,
        containerId: "container-1",
        sessionId: "codex-session-1",
      });
    });
  });

  test("publishes a prompt-less startup tab unlocked with the create-dialog model", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-unlocked-preselect";
      environment.environmentType = "local";
      environment.containerId = null;
      environment.setupPhase = "ready";
      environment.setupScriptsComplete = true;
      await storage.addEnvironment(environment);

      const published = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        initialAgentPlatform: "cursor",
        initialAgentModel: "composer-1.5",
        initialReasoningEffort: "high",
        initialFastMode: true,
      });
      const startupTab = (
        published!.root as {
          tabs: Array<Record<string, unknown>>;
        }
      ).tabs[1]!;
      expect(startupTab).toMatchObject({
        id: "startup-agent",
        type: "agent-native",
        initialAgentPlatform: "cursor",
        initialAgentModel: "composer-1.5",
        initialReasoningEffort: "high",
        initialFastMode: true,
        nativeAgentData: {
          environmentId: environment.id,
          isLocal: true,
        },
      });
      expect((startupTab.nativeAgentData as { platform?: string }).platform).toBeUndefined();

      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            ...(published!.root as Record<string, unknown>),
            activeTabId: "default",
          },
        },
        published!.revision,
      );

      const handedOff = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        activateOnSetupHandoff: true,
        initialAgentModel: "composer-1.5",
      });
      expect(handedOff?.root).toMatchObject({ activeTabId: "startup-agent" });
      expect(
        (
          handedOff!.root as {
            tabs: Array<{ nativeAgentData?: { platform?: string } }>;
          }
        ).tabs[1]?.nativeAgentData?.platform,
      ).toBeUndefined();
    });
  });

  test("clears a stale platform lock when republishing an unlocked startup tab", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-stale-lock";
      environment.environmentType = "local";
      environment.containerId = null;
      environment.setupPhase = "ready";
      environment.setupScriptsComplete = true;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              {
                id: "startup-agent",
                type: "agent-native",
                displayTitle: "Reviewer",
                nativeAgentData: {
                  platform: "cursor",
                  environmentId: environment.id,
                  isLocal: true,
                  hostPort: 4321,
                },
              },
            ],
            activeTabId: "startup-agent",
          },
        },
        0,
      );

      const published = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        initialAgentPlatform: "codex",
        initialAgentModel: "gpt-5.4",
      });
      const startupTab = (
        published!.root as {
          tabs: Array<Record<string, unknown>>;
        }
      ).tabs[1]!;
      expect(startupTab).toMatchObject({
        id: "startup-agent",
        type: "agent-native",
        displayTitle: "Reviewer",
        initialAgentPlatform: "codex",
        initialAgentModel: "gpt-5.4",
        nativeAgentData: {
          environmentId: environment.id,
          isLocal: true,
          hostPort: 4321,
        },
      });
      expect((startupTab.nativeAgentData as { platform?: string }).platform).toBeUndefined();
      expect((startupTab.nativeAgentData as { sessionId?: string }).sessionId).toBeUndefined();
    });
  });

  test("preserves a committed platform when republishing without lockPlatform", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-keep-locked";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        lockPlatform: true,
      });
      const locked = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });
      expect(
        (
          locked!.root as {
            tabs: Array<{ nativeAgentData?: { platform?: string; sessionId?: string } }>;
          }
        ).tabs[1]?.nativeAgentData,
      ).toMatchObject({
        platform: "codex",
        sessionId: "codex-session-1",
      });

      const republished = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
      });
      expect(
        (
          republished!.root as {
            tabs: Array<{ nativeAgentData?: { platform?: string; sessionId?: string } }>;
          }
        ).tabs[1]?.nativeAgentData,
      ).toMatchObject({
        platform: "codex",
        sessionId: "codex-session-1",
      });
    });
  });

  test("does not re-steal focus on a repeated prompt-less setup handoff", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-handoff-once";
      environment.environmentType = "local";
      environment.containerId = null;
      environment.setupPhase = "ready";
      environment.setupScriptsComplete = true;
      await storage.addEnvironment(environment);

      const handedOff = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        activateOnSetupHandoff: true,
        initialAgentPlatform: "codex",
      });
      expect(handedOff?.root).toMatchObject({ activeTabId: "startup-agent" });

      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            ...(handedOff!.root as Record<string, unknown>),
            tabs: [
              { id: "default", type: "plain", isSetupTab: true },
              { id: "notes", type: "file" },
              (
                handedOff!.root as {
                  tabs: Array<Record<string, unknown>>;
                }
              ).tabs.find((tab) => tab.id === "startup-agent"),
            ],
            activeTabId: "notes",
          },
        },
        handedOff!.revision,
      );

      const republished = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        activateOnSetupHandoff: true,
        initialAgentPlatform: "codex",
      });
      expect(republished?.root).toMatchObject({ activeTabId: "notes" });
    });
  });

  test("refuses a backend-owned build tab that would exceed the layout bound", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-build-tab-bound";
      await storage.addEnvironment(environment);
      const root = {
        kind: "leaf",
        id: "default",
        tabs: [] as Array<Record<string, unknown>>,
        activeTabId: null,
        padding: "",
      };
      const baseBytes = Buffer.byteLength(JSON.stringify(root), "utf8");
      root.padding = "x".repeat(256 * 1024 - baseBytes - 32);
      await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root,
        },
        0,
      );

      await expect(
        storage.ensureBuildPipelineTab({
          pipelineId: "pipeline-overflow",
          taskId: "task-overflow",
          environmentId: environment.id,
          isLocal: true,
        }),
      ).rejects.toThrow("Pane layout root exceeds the 256 KB limit");
      expect((await storage.getPaneLayout(environment.id))?.revision).toBe(1);
    });
  });

  test("distinguishes an unreadable pane-layout store from a valid empty store", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await expect(storage.loadPaneLayoutsForReconciliation()).resolves.toEqual({
        available: true,
        layouts: {},
      });
      seedUnreadableStore(dataDir, "pane-layouts.json", "{truncated");
      await expect(storage.loadPaneLayoutsForReconciliation()).resolves.toEqual({
        available: false,
        layouts: {},
      });
    });
  });

  test("recovers pane layouts from a valid legacy backup during reconciliation", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-layout-backup";
      await storage.addEnvironment(environment);
      const saved = await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
        },
        0,
      );
      // Backups exist only in a directory that predates the database: the
      // one-time import takes the newest readable one over a torn primary.
      const legacyDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-legacy-layouts-"));
      try {
        const filePath = path.join(legacyDir, "pane-layouts.json");
        await fs.writeFile(
          `${filePath}.bak.1`,
          `${JSON.stringify({ [environment.id]: saved })}\n`,
          "utf8",
        );
        await fs.writeFile(filePath, "{truncated", "utf8");

        const imported = new StorageService(legacyDir);
        await imported.init();
        await expect(imported.loadPaneLayoutsForReconciliation()).resolves.toEqual({
          available: true,
          layouts: { [environment.id]: saved },
        });
        imported.close();
      } finally {
        await fs.rm(legacyDir, { recursive: true, force: true });
      }
    });
  });
});
