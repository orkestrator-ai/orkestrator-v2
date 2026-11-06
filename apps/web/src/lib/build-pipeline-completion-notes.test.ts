import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { getAllLeaves, usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneNode, TabInfo } from "@/types/paneLayout";
import { startBuildPipelineCompletionNotes } from "./build-pipeline-completion-notes";

const ENVIRONMENT_ID = "env-1";

const buildTab: TabInfo = {
  id: "build",
  type: "claude-build",
  buildTabData: { environmentId: ENVIRONMENT_ID, pipelineId: "pipeline-1", taskId: "task-1" },
};
const chatTab: TabInfo = { id: "chat", type: "plain" };

function seedLayout(root: PaneNode, activePaneId: string, hydrated = true) {
  usePaneLayoutStore.setState({
    environments: new Map([[ENVIRONMENT_ID, { root, activePaneId, containerId: null }]]),
    hydration: new Map(hydrated ? [[ENVIRONMENT_ID, "done" as const]] : []),
  });
}

function splitLayout(): PaneNode {
  return {
    kind: "split",
    id: "split",
    direction: "horizontal",
    sizes: [50, 50],
    depth: 1,
    children: [
      { kind: "leaf", id: "pane-build", tabs: [buildTab], activeTabId: "build" },
      { kind: "leaf", id: "pane-chat", tabs: [chatTab], activeTabId: "chat" },
    ],
  };
}

function install(pipeline: BuildPipeline) {
  useBuildPipelineStore.getState().replacePipeline(pipeline);
}

function notesTabs(): TabInfo[] {
  return usePaneLayoutStore
    .getState()
    .getAllTabs(ENVIRONMENT_ID)
    .filter((tab) => tab.type === "key-information" && tab.keyInformationTabData?.view === "notes");
}

function paneOf(tabId: string) {
  const root = usePaneLayoutStore.getState().environments.get(ENVIRONMENT_ID)!.root;
  return getAllLeaves(root).find((leaf) => leaf.tabs.some((tab) => tab.id === tabId))!;
}

let stop: (() => void) | undefined;

beforeEach(() => {
  useBuildPipelineStore.setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });
  seedLayout(splitLayout(), "pane-chat");
  stop = startBuildPipelineCompletionNotes();
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("startBuildPipelineCompletionNotes", () => {
  test("opens the notes beside the pipeline tab and activates them when the run completes", () => {
    install(buildPipelineFixture({ phase: "resolving-conflicts", backendRevision: 1 }));
    expect(notesTabs()).toHaveLength(0);

    install(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));

    const [notes] = notesTabs();
    expect(notes?.keyInformationTabData).toEqual({
      environmentId: ENVIRONMENT_ID,
      pipelineId: "pipeline-1",
      view: "notes",
    });
    const pane = paneOf(notes!.id);
    expect(pane.id).toBe("pane-build");
    expect(pane.activeTabId).toBe(notes!.id);
    expect(usePaneLayoutStore.getState().getActivePaneId(ENVIRONMENT_ID)).toBe("pane-build");
  });

  test("opens nothing for a run that was already complete when first loaded", () => {
    install(buildPipelineFixture({ phase: "complete", backendRevision: 1 }));
    install(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));
    expect(notesTabs()).toHaveLength(0);
  });

  test("focuses an open notes tab instead of adding a second one", () => {
    const existing: TabInfo = {
      id: "notes-open",
      type: "key-information",
      keyInformationTabData: {
        environmentId: ENVIRONMENT_ID,
        pipelineId: "pipeline-1",
        view: "notes",
      },
    };
    seedLayout(
      { kind: "leaf", id: "pane-1", tabs: [buildTab, existing], activeTabId: "build" },
      "pane-1",
    );
    install(buildPipelineFixture({ phase: "creating-pr", backendRevision: 1 }));
    install(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));

    expect(notesTabs().map((tab) => tab.id)).toEqual(["notes-open"]);
    expect(paneOf("notes-open").activeTabId).toBe("notes-open");
  });

  test("waits for the environment's layout before opening the notes", () => {
    seedLayout(splitLayout(), "pane-chat", false);
    install(buildPipelineFixture({ phase: "verifying", backendRevision: 1 }));
    install(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));
    expect(notesTabs()).toHaveLength(0);

    usePaneLayoutStore.getState().finishHydration(ENVIRONMENT_ID);

    expect(notesTabs()).toHaveLength(1);
  });

  test("opens nothing when the run fails", () => {
    install(buildPipelineFixture({ phase: "resolving-conflicts", backendRevision: 1 }));
    install(buildPipelineFixture({ phase: "failed", backendRevision: 2 }));
    expect(notesTabs()).toHaveLength(0);
  });
});
