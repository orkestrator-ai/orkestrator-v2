import { describe, expect, spyOn, test } from "bun:test";
import { createEnvironment, StorageService } from "./storage.js";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { PaneLayoutMergeInput } from "@orkestrator/protocol/pane-layout-merge";
import { storageDatabase, withTemporaryStorage } from "./storage-test-support.js";

describe("pane layout intent persistence", () => {
  const layout = (activeTabId: string | null, tabs = ["tab-a", "tab-b"]): PaneLayoutMergeInput => ({
    version: PANE_LAYOUT_VERSION,
    containerId: null,
    activePaneId: "pane-1",
    root: {
      kind: "leaf",
      id: "pane-1",
      tabs: tabs.map((id) => ({ id, type: "plain" })),
      activeTabId,
    },
  });

  const persistedInput = (saved: {
    version: number;
    containerId: string | null;
    activePaneId: string;
    root: unknown;
  }): PaneLayoutMergeInput => ({
    version: saved.version,
    containerId: saved.containerId,
    activePaneId: saved.activePaneId,
    root: saved.root as PaneLayoutMergeInput["root"],
  });

  test("removes Multi Review tabs across split leaves without unnecessary revisions", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-remove-multi-review-tabs";
      await storage.addEnvironment(environment);

      await expect(storage.removeMultiReviewTabs(environment.id, "workflow-1")).resolves.toEqual(
        [],
      );
      const saved = await storage.savePaneLayout(
        environment.id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "left",
          root: {
            kind: "split",
            id: "split",
            direction: "horizontal",
            sizes: [50, 50],
            depth: 1,
            children: [
              {
                kind: "leaf",
                id: "left",
                tabs: [
                  {
                    id: "parent",
                    type: "multi-review",
                    multiReviewTabData: {
                      environmentId: environment.id,
                      workflowId: "workflow-1",
                    },
                  },
                  { id: "unrelated", type: "plain" },
                ],
                activeTabId: "parent",
              },
              {
                kind: "leaf",
                id: "right",
                tabs: [
                  {
                    id: "reviewer",
                    type: "multi-review",
                    multiReviewTabData: {
                      environmentId: environment.id,
                      workflowId: "workflow-1",
                      reviewerId: "reviewer-1",
                    },
                  },
                  { id: "multi-review-fix:workflow-1", type: "agent-native" },
                ],
                activeTabId: "reviewer",
              },
            ],
          },
        },
        0,
      );

      expect(new Set(await storage.removeMultiReviewTabs(environment.id, "workflow-1"))).toEqual(
        new Set(["parent", "reviewer", "multi-review-fix:workflow-1"]),
      );
      const pruned = await storage.getPaneLayout(environment.id);
      expect(pruned?.revision).toBe(saved.revision + 1);
      expect(pruned?.root).toMatchObject({
        kind: "split",
        children: [
          { kind: "leaf", tabs: [{ id: "unrelated" }], activeTabId: "unrelated" },
          { kind: "leaf", tabs: [], activeTabId: null },
        ],
      });

      await expect(storage.removeMultiReviewTabs(environment.id, "workflow-1")).resolves.toEqual(
        [],
      );
      expect((await storage.getPaneLayout(environment.id))?.revision).toBe(pruned?.revision);
    });
  });

  test("creates an initial local layout and applies explicit selection intent", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-layout-intent";
      await storage.addEnvironment(environment);
      const base = layout("tab-a");

      const initial = await storage.applyPaneLayoutIntent(environment.id, base, base);
      expect(initial).toMatchObject({
        environmentId: environment.id,
        containerId: null,
        revision: 1,
        root: base.root,
      });

      const selected = await storage.applyPaneLayoutIntent(environment.id, base, base, {
        activePaneId: "pane-1",
        activeTabIds: { "pane-1": "tab-b" },
      });
      expect(selected.revision).toBe(2);
      expect((selected.root as { activeTabId: string }).activeTabId).toBe("tab-b");
    });
  });

  test("prevents a delayed setup-tab addition from reclaiming focus after setup", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-late-setup-tab";
      await storage.addEnvironment(environment);
      const initial = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const staleBase = persistedInput(initial);
      const staleDesired = structuredClone(staleBase);
      if (staleDesired.root.kind !== "leaf") throw new Error("expected a leaf layout");
      const staleSetupTab = {
        id: "setup-terminal",
        type: "plain",
        isSetupTab: true,
      };
      staleDesired.root.tabs.push(staleSetupTab);
      staleDesired.root.activeTabId = "setup-terminal";

      await storage.updateEnvironment(environment.id, {
        setupScriptsComplete: true,
        setupPhase: "ready",
      });
      const buildSelected = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const saved = await storage.applyPaneLayoutIntent(environment.id, staleBase, staleDesired, {
        activePaneId: "default",
        activeTabIds: { default: "setup-terminal" },
      });

      expect(saved.revision).toBe(buildSelected.revision + 1);
      expect(saved.root).toMatchObject({
        kind: "leaf",
        activeTabId: "build-pipeline-1",
      });
      expect((saved.root as { tabs: Array<{ id: string }> }).tabs).not.toContainEqual(
        expect.objectContaining({ id: "setup-terminal" }),
      );
    });
  });

  test("allows completed setup output that was already durable to be selected", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-durable-setup-tab";
      await storage.addEnvironment(environment);
      const initial = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const beforeSetup = persistedInput(initial);
      const withSetup = structuredClone(beforeSetup);
      if (withSetup.root.kind !== "leaf") throw new Error("expected a leaf layout");
      const setupTab = {
        id: "setup-terminal",
        type: "plain",
        isSetupTab: true,
      };
      withSetup.root.tabs.push(setupTab);
      withSetup.root.activeTabId = "setup-terminal";
      await storage.applyPaneLayoutIntent(environment.id, beforeSetup, withSetup, {
        activeTabIds: { default: "setup-terminal" },
      });

      await storage.updateEnvironment(environment.id, {
        setupScriptsComplete: true,
        setupPhase: "ready",
      });
      const buildSelected = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const manualBase = persistedInput(buildSelected);
      const manuallySelected = structuredClone(manualBase);
      if (manuallySelected.root.kind !== "leaf") throw new Error("expected a leaf layout");
      manuallySelected.root.activeTabId = "setup-terminal";
      const saved = await storage.applyPaneLayoutIntent(
        environment.id,
        manualBase,
        manuallySelected,
        { activeTabIds: { default: "setup-terminal" } },
      );

      expect(saved.root).toMatchObject({
        kind: "leaf",
        activeTabId: "setup-terminal",
        tabs: expect.arrayContaining([
          expect.objectContaining({ id: "setup-terminal", isSetupTab: true }),
        ]),
      });
    });
  });

  test("prevents a stale durable setup selection from overriding the build handoff", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-stale-durable-setup-focus";
      await storage.addEnvironment(environment);
      const initial = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const beforeSetup = persistedInput(initial);
      const withSetup = structuredClone(beforeSetup);
      if (withSetup.root.kind !== "leaf") throw new Error("expected a leaf layout");
      const setupTab = {
        id: "setup-terminal",
        type: "plain",
        isSetupTab: true,
      };
      withSetup.root.tabs.push(setupTab);
      withSetup.root.activeTabId = "setup-terminal";
      const setupSelected = await storage.applyPaneLayoutIntent(
        environment.id,
        beforeSetup,
        withSetup,
        { activeTabIds: { default: "setup-terminal" } },
      );

      await storage.updateEnvironment(environment.id, {
        setupScriptsComplete: true,
        setupPhase: "ready",
      });
      const buildSelected = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const staleSetupSelection = persistedInput(setupSelected);
      const saved = await storage.applyPaneLayoutIntent(
        environment.id,
        staleSetupSelection,
        staleSetupSelection,
        { activeTabIds: { default: "setup-terminal" } },
      );

      expect(saved.revision).toBe(buildSelected.revision + 1);
      expect(saved.root).toMatchObject({
        kind: "leaf",
        activeTabId: "build-pipeline-1",
        tabs: expect.arrayContaining([
          expect.objectContaining({ id: "setup-terminal", isSetupTab: true }),
        ]),
      });
    });
  });

  test("prevents stale setup focus from overriding an agent-tab handoff", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-agent-setup-handoff";
      await storage.addEnvironment(environment);
      const setupLayout = layout("setup-terminal", ["setup-terminal"]);
      if (setupLayout.root.kind !== "leaf") throw new Error("expected a leaf layout");
      const setupTab = {
        id: "setup-terminal",
        type: "plain",
        isSetupTab: true,
      };
      setupLayout.root.tabs[0] = setupTab;
      const setupSelected = await storage.applyPaneLayoutIntent(
        environment.id,
        setupLayout,
        setupLayout,
        { activeTabIds: { "pane-1": "setup-terminal" } },
      );

      await storage.updateEnvironment(environment.id, {
        setupScriptsComplete: true,
        setupPhase: "ready",
      });
      const agentBase = persistedInput(setupSelected);
      const agentDesired = structuredClone(agentBase);
      if (agentDesired.root.kind !== "leaf") throw new Error("expected a leaf layout");
      agentDesired.root.tabs.push({
        id: "startup-agent",
        type: "codex-native",
      });
      agentDesired.root.activeTabId = "startup-agent";
      const agentSelected = await storage.applyPaneLayoutIntent(
        environment.id,
        agentBase,
        agentDesired,
        { activeTabIds: { "pane-1": "startup-agent" } },
      );
      const staleSetupSelection = persistedInput(setupSelected);
      const saved = await storage.applyPaneLayoutIntent(
        environment.id,
        staleSetupSelection,
        staleSetupSelection,
        { activeTabIds: { "pane-1": "setup-terminal" } },
      );

      expect(saved.revision).toBe(agentSelected.revision + 1);
      expect(saved.root).toMatchObject({
        kind: "leaf",
        activeTabId: "startup-agent",
        tabs: expect.arrayContaining([
          expect.objectContaining({ id: "setup-terminal", isSetupTab: true }),
          expect.objectContaining({ id: "startup-agent", type: "codex-native" }),
        ]),
      });
    });
  });

  test("rejects malformed and stale generations without consuming a revision", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-layout-generation";
      environment.containerId = "container-new";
      await storage.addEnvironment(environment);
      const current = {
        ...layout("tab-a"),
        containerId: "container-new",
      };
      await storage.savePaneLayout(environment.id, current, 0);
      const stale = { ...current, containerId: "container-old" };
      await expect(storage.applyPaneLayoutIntent(environment.id, stale, stale)).rejects.toThrow(
        "stale environment generation",
      );

      const cyclicRoot: Record<string, unknown> = { kind: "leaf" };
      cyclicRoot.self = cyclicRoot;
      await expect(
        storage.applyPaneLayoutIntent(environment.id, current, {
          ...current,
          root: cyclicRoot,
        } as unknown as PaneLayoutMergeInput),
      ).rejects.toThrow("JSON serializable");

      await expect(
        storage.applyPaneLayoutIntent(environment.id, current, current, {
          activeTabIds: Object.fromEntries(
            Array.from({ length: 1_025 }, (_, index) => [`pane-${index}`, null]),
          ),
        }),
      ).rejects.toThrow("1024 entry limit");
      await expect(
        storage.applyPaneLayoutIntent(environment.id, current, current, {
          activePaneId: "p".repeat(64 * 1024),
        }),
      ).rejects.toThrow("64 KB limit");
      expect((await storage.getPaneLayout(environment.id))?.revision).toBe(1);
    });
  });

  test("rejects a stale merge ancestor even when the desired generation is current", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-layout-base-generation";
      environment.containerId = "container-new";
      await storage.addEnvironment(environment);
      const current = { ...layout("tab-a"), containerId: "container-new" };
      await storage.savePaneLayout(environment.id, current, 0);

      // Both sides of the merge come from the renderer. A dead ancestor still
      // merges against the durable tree, which resurrects the tabs it carried.
      await expect(
        storage.applyPaneLayoutIntent(
          environment.id,
          { ...current, containerId: "container-old" },
          current,
        ),
      ).rejects.toThrow("stale environment generation");
      expect((await storage.getPaneLayout(environment.id))?.revision).toBe(1);
    });
  });

  test("preserves a concurrently replaced layout during revision-guarded deletion", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-layout-guarded-delete";
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(environment.id, layout("tab-a"), 0);
      const newer = await storage.savePaneLayout(environment.id, layout("tab-b"), 1);

      await expect(storage.deletePaneLayout(environment.id, 1)).rejects.toThrow(
        "expected 1, current 2",
      );
      expect(await storage.getPaneLayout(environment.id)).toEqual(newer);

      await storage.deletePaneLayout(environment.id, 2);
      expect(await storage.getPaneLayout(environment.id)).toBeNull();
    });
  });

  test("rejects a container generation on a local environment from both write paths", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-layout-local-generation";
      // A local environment has no container, so only null is a live generation
      // - even if a stale containerId is still recorded on the environment.
      environment.containerId = "container-ghost";
      await storage.addEnvironment(environment);
      const containerLayout = { ...layout("tab-a"), containerId: "container-ghost" };

      await expect(storage.savePaneLayout(environment.id, containerLayout, 0)).rejects.toThrow(
        "stale environment generation",
      );
      await expect(
        storage.applyPaneLayoutIntent(environment.id, containerLayout, containerLayout),
      ).rejects.toThrow("stale environment generation");
      expect(await storage.getPaneLayout(environment.id)).toBeNull();

      await expect(
        storage.savePaneLayout(environment.id, layout("tab-a"), 0),
      ).resolves.toMatchObject({ revision: 1, containerId: null });
    });
  });

  test("replaces rather than merges when the persisted layout version differs", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-layout-version-generation";
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        { ...layout("tab-a", ["tab-a", "tab-b"]), version: PANE_LAYOUT_VERSION - 1 },
        0,
      );

      // The persisted record is a different layout version, so there is no
      // common ancestor to rebase onto: the intent replaces it wholesale.
      const desired = layout("tab-c", ["tab-c"]);
      const saved = await storage.applyPaneLayoutIntent(environment.id, desired, desired);
      expect(saved).toMatchObject({
        version: PANE_LAYOUT_VERSION,
        revision: 2,
        root: desired.root,
      });
    });
  });

  test("recovers the mutation queue after a storage write failure", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-layout-write-recovery";
      await storage.addEnvironment(environment);
      const database = storageDatabase(storage);
      const writeStore = database.writeStoreInTransaction.bind(database);
      let failNext = true;
      const spy = spyOn(database, "writeStoreInTransaction").mockImplementation(
        (store, value, options) => {
          if (store === "pane-layouts" && failNext) {
            failNext = false;
            throw new Error("disk full");
          }
          return writeStore(store, value, options);
        },
      );

      try {
        await expect(
          storage.applyPaneLayoutIntent(environment.id, layout("tab-a"), layout("tab-a")),
        ).rejects.toThrow("disk full");
      } finally {
        spy.mockRestore();
      }
      expect(failNext).toBe(false);
      await expect(
        storage.applyPaneLayoutIntent(environment.id, layout("tab-a"), layout("tab-b")),
      ).resolves.toMatchObject({ revision: 1 });
    });
  });
});

describe("durable tab teardown intents", () => {
  test("captures a resume identity durably without replacing a newer intent or captured identity", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-resume-capture";
      await storage.addEnvironment(environment);
      const intent = {
        tabId: "tab-capture",
        kind: "codex-native" as const,
        createdAt: "2026-10-24T00:00:00Z",
      };
      await storage.setTabTeardownIntent(environment.id, intent);
      await storage.recordTabTeardownSessionId(
        environment.id,
        intent.tabId,
        intent.createdAt,
        "thread-verified",
      );
      await storage.recordTabTeardownSessionId(
        environment.id,
        intent.tabId,
        intent.createdAt,
        "bridge-unverified",
      );
      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect(
        (await restarted.getEnvironment(environment.id))?.tabTeardownIntents?.[intent.tabId]
          ?.resumableSessionId,
      ).toBe("thread-verified");
      const newer = { ...intent, createdAt: "2026-10-24T00:00:01Z" };
      await restarted.setTabTeardownIntent(environment.id, newer);
      await expect(
        storage.recordTabTeardownSessionId(
          environment.id,
          intent.tabId,
          intent.createdAt,
          "stale-thread",
        ),
      ).rejects.toThrow("changed");
      expect(
        (await restarted.getEnvironment(environment.id))?.tabTeardownIntents?.[intent.tabId],
      ).toEqual(newer);
    });
  });

  test("atomically preserves concurrent intents and clears only the completed generation", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-teardown-intents";
      await storage.addEnvironment(environment);
      const first = {
        tabId: "tab-1",
        kind: "terminal" as const,
        createdAt: "2026-08-04T10:00:00.000Z",
      };
      const second = {
        tabId: "tab-2",
        kind: "codex-native" as const,
        createdAt: "2026-08-04T10:00:01.000Z",
      };

      await Promise.all([
        storage.setTabTeardownIntent(environment.id, first),
        storage.setTabTeardownIntent(environment.id, second),
      ]);
      expect((await storage.getEnvironment(environment.id))?.tabTeardownIntents).toEqual({
        "tab-1": first,
        "tab-2": second,
      });

      await storage.setTabTeardownIntent(environment.id, {
        ...first,
        createdAt: "2026-08-04T10:00:02.000Z",
      });
      await storage.clearTabTeardownIntent(environment.id, first.tabId, first.createdAt);
      expect((await storage.getEnvironment(environment.id))?.tabTeardownIntents).toHaveProperty(
        "tab-1.createdAt",
        "2026-08-04T10:00:02.000Z",
      );
    });
  });
});
