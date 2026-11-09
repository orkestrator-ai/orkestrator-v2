import { describe, expect, test } from "bun:test";
import { keyInformationTabId, MAX_TABS_PER_ENVIRONMENT } from "@orkestrator/protocol/pane-layout";
import { createEnvironment, type StorageService } from "./storage.js";
import { withTemporaryStorage } from "./storage-test-support.js";

type Leaf = { kind: "leaf"; id: string; tabs: Array<Record<string, unknown>>; activeTabId: string };

const NOTES_ID = (environmentId: string) =>
  keyInformationTabId(environmentId, "pipeline-1", "notes");

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
