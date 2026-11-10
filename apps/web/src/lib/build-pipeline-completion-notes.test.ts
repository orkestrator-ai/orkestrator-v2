import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_TABS_PER_ENVIRONMENT } from "@orkestrator/protocol/pane-layout";
import { mergePersistedPaneLayouts } from "./pane-layout-merge";
import { PANE_LAYOUT_VERSION, type PersistedPaneLayoutInput } from "@/types/paneLayout";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { type BuildPipeline, buildPipelineStore } from "@/stores/buildPipelineStore";
import { getAllLeaves, paneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneNode, TabInfo } from "@/types/paneLayout";
import { startBuildPipelineCompletionNotes } from "./build-pipeline-completion-notes";
import { appCommandStore } from "@/test/app-command-store";
import { clearCompletionNotesHandled } from "./pane-layout-authoritative";
import { appCommandScope } from "./node-scope-slots";
import { mockToastError } from "../../../../tests/mocks/sonner";

const ENVIRONMENT_ID = "env-1";

const buildTab: TabInfo = {
  id: "build",
  type: "claude-build",
  buildTabData: { environmentId: ENVIRONMENT_ID, pipelineId: "pipeline-1", taskId: "task-1" },
};
const chatTab: TabInfo = { id: "chat", type: "plain" };

function seedLayout(root: PaneNode, activePaneId: string, hydrated = true) {
  appCommandStore(paneLayoutStore).setState({
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
  appCommandStore(buildPipelineStore).getState().replacePipeline(pipeline);
}

function notesTabs(): TabInfo[] {
  return appCommandStore(paneLayoutStore)
    .getState()
    .getAllTabs(ENVIRONMENT_ID)
    .filter((tab) => tab.type === "key-information" && tab.keyInformationTabData?.view === "notes");
}

function paneOf(tabId: string) {
  const root = appCommandStore(paneLayoutStore).getState().environments.get(ENVIRONMENT_ID)!.root;
  return getAllLeaves(root).find((leaf) => leaf.tabs.some((tab) => tab.id === tabId))!;
}

let stop: (() => void) | undefined;

beforeEach(() => {
  clearCompletionNotesHandled("pipeline-1", appCommandScope());
  mockToastError.mockClear();
  appCommandStore(buildPipelineStore).setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
  });
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
    expect(appCommandStore(paneLayoutStore).getState().getActivePaneId(ENVIRONMENT_ID)).toBe(
      "pane-build",
    );
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

  test("a retained completion marker does not suppress a later run of the same pipeline", () => {
    install(buildPipelineFixture({ phase: "verifying", backendRevision: 1 }));
    install(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));
    const store = appCommandStore(paneLayoutStore);
    const published = structuredClone(store.getState().environments.get(ENVIRONMENT_ID)!);
    const notes = getAllLeaves(published.root)
      .flatMap((leaf) => leaf.tabs)
      .find((tab) => tab.keyInformationTabData?.view === "notes")!;
    notes.keyInformationTabData!.completionPublished = true;
    store.getState().applyAuthoritativeLayout(ENVIRONMENT_ID, published);
    install(buildPipelineFixture({ phase: "verifying", backendRevision: 3 }));
    appCommandStore(paneLayoutStore).getState().setActivePane("pane-chat", ENVIRONMENT_ID);
    install(buildPipelineFixture({ phase: "complete", backendRevision: 4 }));
    expect(appCommandStore(paneLayoutStore).getState().getActivePaneId(ENVIRONMENT_ID)).toBe(
      "pane-build",
    );
    expect(notesTabs()).toHaveLength(1);
  });

  test("a completed snapshot with a new completion revision opens Notes once after a missed rerun", () => {
    install(buildPipelineFixture({ phase: "complete", backendRevision: 3, completionRevision: 2 }));
    install(
      buildPipelineFixture({ phase: "complete", backendRevision: 10, completionRevision: 8 }),
    );
    expect(notesTabs()).toHaveLength(1);
    expect(paneOf(notesTabs()[0]!.id).activeTabId).toBe(notesTabs()[0]!.id);
    appCommandStore(paneLayoutStore).getState().setActiveTab("pane-build", "build", ENVIRONMENT_ID);
    install(
      buildPipelineFixture({ phase: "complete", backendRevision: 11, completionRevision: 8 }),
    );
    expect(paneOf("build").activeTabId).toBe("build");
  });

  test("waits for the environment's layout before opening the notes", () => {
    seedLayout(splitLayout(), "pane-chat", false);
    install(buildPipelineFixture({ phase: "verifying", backendRevision: 1 }));
    install(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));
    expect(notesTabs()).toHaveLength(0);

    appCommandStore(paneLayoutStore).getState().finishHydration(ENVIRONMENT_ID);

    expect(notesTabs()).toHaveLength(1);
  });

  test("opens nothing when the run fails", () => {
    install(buildPipelineFixture({ phase: "resolving-conflicts", backendRevision: 1 }));
    install(buildPipelineFixture({ phase: "failed", backendRevision: 2 }));
    expect(notesTabs()).toHaveLength(0);
  });
  test("independent clients completing the same pipeline merge into one notes tab", () => {
    const snapshot = (): PersistedPaneLayoutInput => ({
      version: PANE_LAYOUT_VERSION,
      ...structuredClone(
        appCommandStore(paneLayoutStore).getState().environments.get(ENVIRONMENT_ID)!,
      ),
    });
    const base = snapshot();
    const complete = () => {
      install(buildPipelineFixture({ phase: "verifying", backendRevision: 1 }));
      install(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));
      return snapshot();
    };
    const local = complete();
    // A second client starts from the common base with a different active pane.
    seedLayout(structuredClone(base.root), "pane-build");
    appCommandStore(buildPipelineStore).setState({ pipelines: new Map() });
    const remote = complete();
    for (const [left, right] of [
      [local, remote],
      [remote, local],
    ]) {
      const merged = mergePersistedPaneLayouts(base, left!, right!);
      const leaves = getAllLeaves(merged.root);
      const notes = leaves
        .flatMap((leaf) => leaf.tabs)
        .filter((tab) => tab.keyInformationTabData?.view === "notes");
      expect(notes).toHaveLength(1);
      expect(merged.activePaneId).toBe("pane-build");
      expect(leaves.find((leaf) => leaf.id === "pane-build")?.activeTabId).toBe(notes[0]!.id);
    }
  });

  test.each(["removed", "restarted", "moved"])(
    "discards a queued completion when its pipeline is %s before hydration",
    (change) => {
      seedLayout(splitLayout(), "pane-chat", false);
      install(buildPipelineFixture({ phase: "verifying", backendRevision: 1 }));
      install(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));
      if (change === "removed") {
        appCommandStore(buildPipelineStore).getState().removePipeline("pipeline-1");
      } else {
        install(
          buildPipelineFixture({
            phase: change === "restarted" ? "verifying" : "complete",
            environmentId: change === "moved" ? "env-2" : ENVIRONMENT_ID,
            backendRevision: 3,
          }),
        );
      }
      appCommandStore(paneLayoutStore).getState().finishHydration(ENVIRONMENT_ID);
      expect(notesTabs()).toHaveLength(0);
      expect(appCommandStore(paneLayoutStore).getState().getActivePaneId(ENVIRONMENT_ID)).toBe(
        "pane-chat",
      );
      expect(paneOf("build").activeTabId).toBe("build");
      expect(paneOf("chat").activeTabId).toBe("chat");
    },
  );

  test("uses the environment's active pane when the build tab is absent", () => {
    seedLayout(
      { kind: "leaf", id: "pane-chat", tabs: [chatTab], activeTabId: "chat" },
      "pane-chat",
    );
    install(buildPipelineFixture({ phase: "verifying", backendRevision: 1 }));
    install(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));
    expect(notesTabs()).toHaveLength(1);
    expect(paneOf(notesTabs()[0]!.id).id).toBe("pane-chat");
    expect(paneOf(notesTabs()[0]!.id).activeTabId).toBe(notesTabs()[0]!.id);
  });

  test("leaves tabs and selections unchanged at the environment tab limit", () => {
    const root = splitLayout();
    if (root.kind !== "split" || root.children[1].kind !== "leaf")
      throw new Error("expected split");
    root.children[1].tabs.push(
      ...Array.from({ length: MAX_TABS_PER_ENVIRONMENT - 2 }, (_, i): TabInfo => ({
        id: `extra-${i}`,
        type: "plain",
      })),
    );
    seedLayout(root, "pane-chat");
    const before = structuredClone(
      appCommandStore(paneLayoutStore).getState().environments.get(ENVIRONMENT_ID),
    );
    install(buildPipelineFixture({ phase: "verifying", backendRevision: 1 }));
    install(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));
    expect(notesTabs()).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith("Tab limit reached", {
      description: `You can have up to ${MAX_TABS_PER_ENVIRONMENT} tabs open. Close a tab and try again.`,
      id: "tab-limit-reached",
    });
    expect(appCommandStore(paneLayoutStore).getState().environments.get(ENVIRONMENT_ID)).toEqual(
      before,
    );
  });

  test.each([0, 64])(
    "bounds pending completions, retaining newest but evicting oldest (intent %s)",
    (remaining) => {
      seedLayout(splitLayout(), "pane-chat", false);
      for (let i = 0; i < 65; i++) {
        install(
          buildPipelineFixture({ id: `queued-${i}`, phase: "verifying", backendRevision: 1 }),
        );
        install(buildPipelineFixture({ id: `queued-${i}`, phase: "complete", backendRevision: 2 }));
      }
      expect(notesTabs()).toHaveLength(0);
      expect(appCommandStore(paneLayoutStore).getState().getActivePaneId(ENVIRONMENT_ID)).toBe(
        "pane-chat",
      );
      // Isolate each end of the queue to prove both eviction and retention.
      for (let i = 0; i < 65; i++) {
        if (i !== remaining)
          appCommandStore(buildPipelineStore).getState().removePipeline(`queued-${i}`);
      }
      appCommandStore(paneLayoutStore).getState().finishHydration(ENVIRONMENT_ID);
      if (remaining === 64) {
        expect(notesTabs()).toHaveLength(1);
        expect(notesTabs()[0]!.keyInformationTabData?.pipelineId).toBe("queued-64");
        return;
      }
      expect(notesTabs()).toHaveLength(0);
      expect(appCommandStore(paneLayoutStore).getState().getActivePaneId(ENVIRONMENT_ID)).toBe(
        "pane-chat",
      );
      expect(paneOf("build").activeTabId).toBe("build");
      expect(paneOf("chat").activeTabId).toBe("chat");
    },
  );
});
