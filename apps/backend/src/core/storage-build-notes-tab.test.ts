import { describe, expect, test } from "bun:test";
import { keyInformationTabId, MAX_TABS_PER_ENVIRONMENT } from "@orkestrator/protocol/pane-layout";
import type { PaneLayoutNode } from "@orkestrator/protocol/pane-layout-merge";
import { createEnvironment, type PersistedPaneLayout, type StorageService } from "./storage.js";
import { withTemporaryStorage } from "./storage-test-support.js";

type Leaf = {
  kind: "leaf";
  id: string;
  tabs: Array<Record<string, unknown> & { id: string; type: string }>;
  activeTabId: string;
};

const NOTES_ID = (environmentId: string) =>
  keyInformationTabId(environmentId, "pipeline-1", "notes");

// Storage accepts unknown persisted roots; these fixtures build valid pane trees.
function mergeableLayout(layout: PersistedPaneLayout) {
  return { ...layout, root: layout.root as PaneLayoutNode };
}

async function seedBuildLayout(storage: StorageService, root?: unknown) {
  const environment = createEnvironment("project-1");
  environment.id = "env-notes";
  environment.containerId = "container-1";
  await storage.addEnvironment(environment);
  const built = await storage.ensureBuildPipelineTab({
    pipelineId: "pipeline-1",
    taskId: "task-1",
    environmentId: environment.id,
    isLocal: false,
  });
  if (!root) return built;
  return storage.savePaneLayout(environment.id, { ...built, root }, built.revision);
}

describe("ensureBuildPipelineNotesTab", () => {
  test("adds the notes tab beside the pipeline tab and selects it", async () => {
    await withTemporaryStorage(async (storage) => {
      const root = {
        kind: "split",
        id: "split",
        direction: "horizontal",
        sizes: [50, 50],
        depth: 1,
        children: [
          {
            kind: "leaf",
            id: "pane-chat",
            tabs: [{ id: "chat", type: "plain" }],
            activeTabId: "chat",
          },
          {
            kind: "leaf",
            id: "pane-build",
            tabs: [
              {
                id: "build-pipeline-1",
                type: "claude-build",
                buildTabData: { environmentId: "env-notes", pipelineId: "pipeline-1" },
              },
            ],
            activeTabId: "build-pipeline-1",
          },
        ],
      };
      const before = await seedBuildLayout(storage, { ...root });
      const saved = await storage.ensureBuildPipelineNotesTab({
        pipelineId: "pipeline-1",
        environmentId: "env-notes",
      });

      expect(saved?.revision).toBe(before.revision + 1);
      expect(saved?.activePaneId).toBe("pane-build");
      expect(saved?.containerId).toBe("container-1");
      const buildLeaf = (saved!.root as { children: Leaf[] }).children[1]!;
      expect(buildLeaf.activeTabId).toBe(NOTES_ID("env-notes"));
      expect(buildLeaf.tabs.at(-1)).toEqual({
        id: NOTES_ID("env-notes"),
        type: "key-information",
        keyInformationTabData: {
          environmentId: "env-notes",
          pipelineId: "pipeline-1",
          view: "notes",
          completionPublished: true,
        },
      });
      expect(await storage.getPaneLayout("env-notes")).toEqual(saved);
    });
  });

  test("selects an open notes tab instead of adding a second one, and is idempotent", async () => {
    await withTemporaryStorage(async (storage) => {
      await seedBuildLayout(storage, {
        kind: "leaf",
        id: "default",
        tabs: [
          { id: "build-pipeline-1", type: "claude-build" },
          {
            id: "notes-opened-by-hand",
            type: "key-information",
            keyInformationTabData: {
              environmentId: "env-notes",
              pipelineId: "pipeline-1",
              view: "notes",
            },
          },
        ],
        activeTabId: "build-pipeline-1",
      });
      const saved = await storage.ensureBuildPipelineNotesTab({
        pipelineId: "pipeline-1",
        environmentId: "env-notes",
      });
      const leaf = saved!.root as Leaf;
      expect(leaf.tabs.map((tab) => tab.id)).toEqual(["build-pipeline-1", "notes-opened-by-hand"]);
      expect(leaf.activeTabId).toBe("notes-opened-by-hand");
      expect(leaf.tabs[1]?.keyInformationTabData).toMatchObject({ completionPublished: true });

      // Already selected: nothing to write, so no revision churn.
      expect(
        await storage.ensureBuildPipelineNotesTab({
          pipelineId: "pipeline-1",
          environmentId: "env-notes",
        }),
      ).toBeNull();
      expect((await storage.getPaneLayout("env-notes"))?.revision).toBe(saved!.revision);
    });
  });

  test.each(["backend-first", "renderer-first"])(
    "preserves completion publication for concurrent same-ID additions: %s",
    async (order) => {
      await withTemporaryStorage(async (storage) => {
        const base = mergeableLayout(await seedBuildLayout(storage));
        const desired = structuredClone(base);
        const leaf = desired.root as Leaf;
        leaf.tabs.push({
          id: NOTES_ID("env-notes"),
          type: "key-information",
          keyInformationTabData: {
            environmentId: "env-notes",
            pipelineId: "pipeline-1",
            view: "notes",
          },
        });
        leaf.activeTabId = NOTES_ID("env-notes");
        const publish = () =>
          storage.ensureBuildPipelineNotesTab({
            environmentId: "env-notes",
            pipelineId: "pipeline-1",
          });
        const renderer = () => storage.applyPaneLayoutIntent("env-notes", base, desired);
        if (order === "backend-first") {
          await publish();
          await renderer();
        } else {
          await renderer();
          await publish();
        }
        const saved = (await storage.getPaneLayout("env-notes"))!;
        const notes = (saved.root as Leaf).tabs.filter((tab) => tab.id === NOTES_ID("env-notes"));
        expect(notes).toHaveLength(1);
        expect(notes[0]?.keyInformationTabData).toMatchObject({ completionPublished: true });
        expect((saved.root as Leaf).activeTabId).toBe(NOTES_ID("env-notes"));
      });
    },
  );

  test("full saves preserve the marker until Notes is closed, and manual reopen stays unmarked", async () => {
    await withTemporaryStorage(async (storage) => {
      await seedBuildLayout(storage);
      const published = (await storage.ensureBuildPipelineNotesTab({
        environmentId: "env-notes",
        pipelineId: "pipeline-1",
      }))!;
      const unmarked = structuredClone(published);
      const notes = (unmarked.root as Leaf).tabs.find((tab) => tab.id === NOTES_ID("env-notes"))!;
      delete (notes.keyInformationTabData as Record<string, unknown>).completionPublished;
      const saved = await storage.savePaneLayout("env-notes", unmarked, published.revision);
      expect(
        (saved.root as Leaf).tabs.find((tab) => tab.id === notes.id)?.keyInformationTabData,
      ).toMatchObject({ completionPublished: true });
      const closed = structuredClone(saved);
      (closed.root as Leaf).tabs = (closed.root as Leaf).tabs.filter((tab) => tab.id !== notes.id);
      (closed.root as Leaf).activeTabId = (closed.root as Leaf).tabs[0]!.id as string;
      const removed = await storage.savePaneLayout("env-notes", closed, saved.revision);
      const reopened = await storage.applyPaneLayoutIntent(
        "env-notes",
        mergeableLayout(removed),
        mergeableLayout(unmarked),
      );
      expect(
        (reopened.root as Leaf).tabs.find((tab) => tab.id === notes.id)?.keyInformationTabData,
      ).not.toHaveProperty("completionPublished");
    });
  });

  test("places Notes in the active pane when no pane holds the pipeline tab", async () => {
    await withTemporaryStorage(async (storage) => {
      const before = await seedBuildLayout(storage, {
        kind: "split",
        id: "split",
        direction: "horizontal",
        sizes: [50, 50],
        depth: 1,
        children: [
          { kind: "leaf", id: "first", tabs: [{ id: "one", type: "plain" }], activeTabId: "one" },
          { kind: "leaf", id: "active", tabs: [{ id: "two", type: "plain" }], activeTabId: "two" },
        ],
      });
      await storage.savePaneLayout(
        "env-notes",
        { ...before, activePaneId: "active" },
        before.revision,
      );
      const saved = (await storage.ensureBuildPipelineNotesTab({
        environmentId: "env-notes",
        pipelineId: "pipeline-1",
      }))!;
      const leaves = (saved.root as { children: Leaf[] }).children;
      expect(saved.activePaneId).toBe("active");
      expect(leaves[0]?.tabs).toEqual([{ id: "one", type: "plain" }]);
      expect(leaves[1]?.activeTabId).toBe(NOTES_ID("env-notes"));
      expect(leaves[1]?.tabs.map((tab) => tab.id)).toEqual(["two", NOTES_ID("env-notes")]);
    });
  });

  test("leaves a full layout unchanged", async () => {
    await withTemporaryStorage(async (storage) => {
      const tabs = Array.from({ length: MAX_TABS_PER_ENVIRONMENT }, (_, index) => ({
        id: `tab-${index}`,
        type: "plain",
      }));
      const before = await seedBuildLayout(storage, {
        kind: "leaf",
        id: "default",
        tabs,
        activeTabId: "tab-0",
      });
      expect(
        await storage.ensureBuildPipelineNotesTab({
          pipelineId: "pipeline-1",
          environmentId: "env-notes",
        }),
      ).toBeNull();
      expect(await storage.getPaneLayout("env-notes")).toEqual(before);
    });
  });

  test("does not create a layout for an environment that has none", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      expect(
        await storage.ensureBuildPipelineNotesTab({
          pipelineId: "pipeline-1",
          environmentId: environment.id,
        }),
      ).toBeNull();
      expect(await storage.getPaneLayout(environment.id)).toBeNull();
      expect(
        await storage.ensureBuildPipelineNotesTab({
          pipelineId: "pipeline-1",
          environmentId: "missing",
        }),
      ).toBeNull();
    });
  });
});
