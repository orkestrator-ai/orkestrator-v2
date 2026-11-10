import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mergePersistedPaneLayouts } from "@orkestrator/protocol/pane-layout-merge";
import { keyInformationTabId } from "@orkestrator/protocol/pane-layout";
import type { Environment } from "@/types";
import {
  clearCompletionNotesHandled,
  reconcileAuthoritativePaneLayout,
} from "./pane-layout-authoritative";
import { startBuildPipelineCompletionNotes } from "./build-pipeline-completion-notes";
import {
  createPersistedPaneLayoutInput,
  flushPaneLayoutNow,
  startPaneLayoutPersistence,
} from "./pane-layout-persistence";
import { appCommandScope } from "./node-scope-slots";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { appCommandStore } from "@/test/app-command-store";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore, type EnvironmentPaneState } from "@/stores/paneLayoutStore";
import {
  PANE_LAYOUT_VERSION,
  type PaneNode,
  type PersistedPaneLayout,
  type TabInfo,
} from "@/types/paneLayout";

const NOTES_ID = keyInformationTabId("env-1", "pipeline-1", "notes");
const buildTab: TabInfo = {
  id: "build-pipeline-1",
  type: "claude-build",
  buildTabData: { environmentId: "env-1", pipelineId: "pipeline-1", taskId: "task-1" },
};
const notesTab: TabInfo = {
  id: NOTES_ID,
  type: "key-information",
  keyInformationTabData: {
    environmentId: "env-1",
    pipelineId: "pipeline-1",
    view: "notes",
    completionPublished: true,
  },
};
const chatTab: TabInfo = { id: "chat", type: "plain" };

function leaf(id: string, tabs: TabInfo[], activeTabId: string): PaneNode {
  return { kind: "leaf", id, tabs, activeTabId };
}

function split(left: PaneNode, right: PaneNode): PaneNode {
  return {
    kind: "split",
    id: "split",
    direction: "horizontal",
    children: [left, right],
    sizes: [50, 50],
    depth: 1,
  };
}

function persisted(root: PaneNode, activePaneId: string): PersistedPaneLayout & { root: PaneNode } {
  return {
    version: PANE_LAYOUT_VERSION,
    environmentId: "env-1",
    containerId: "container-1",
    activePaneId,
    root,
    updatedAt: "2026-11-09T00:00:00.000Z",
    revision: 7,
  };
}

function current(root: PaneNode, activePaneId: string): EnvironmentPaneState {
  return { root, activePaneId, containerId: "container-1" };
}

function selection(state: EnvironmentPaneState | null) {
  const leaves: Array<{ id: string; activeTabId: string | null }> = [];
  const visit = (node: PaneNode) => {
    if (node.kind === "leaf") leaves.push({ id: node.id, activeTabId: node.activeTabId });
    else node.children.forEach(visit);
  };
  if (state) visit(state.root);
  return { activePaneId: state?.activePaneId, leaves };
}

let descriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  localStorage.clear();
  clearCompletionNotesHandled("pipeline-1", appCommandScope());
  appCommandStore(environmentStore).setState({
    environments: [
      {
        id: "env-1",
        name: "env-1",
        projectId: "project-1",
        status: "running",
        environmentType: "docker",
        containerId: "container-1",
        branch: "main",
        createdAt: "2026-11-09T00:00:00.000Z",
      } as unknown as Environment,
    ],
  });
  appCommandStore(buildPipelineStore).setState({
    pipelines: new Map([["pipeline-1", buildPipelineFixture({ phase: "complete" })]]),
    buildEnvironmentIds: new Set(),
  });
  appCommandStore(paneLayoutStore).setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
  // An Electron window keeps its own pane and tab selection.
  Object.defineProperty(window, "orkestrator", {
    configurable: true,
    value: { isolatedViewState: true },
  });
});

afterEach(() => {
  if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
  else delete window.orkestrator;
});

describe("completion notes arriving in an Electron window", () => {
  test.each(["select-chat", "close-notes"])(
    "live completion followed by backend publication preserves a newer %s through persistence",
    async (action) => {
      const panes = appCommandStore(paneLayoutStore);
      const pipelines = appCommandStore(buildPipelineStore);
      const before = current(
        split(leaf("pane-build", [buildTab], buildTab.id), leaf("pane-chat", [chatTab], "chat")),
        "pane-chat",
      );
      panes.setState({
        environments: new Map([["env-1", before]]),
        hydration: new Map([["env-1", "done"]]),
      });
      pipelines
        .getState()
        .replacePipeline(buildPipelineFixture({ phase: "verifying", backendRevision: 1 }));
      const stopObserver = startBuildPipelineCompletionNotes();
      let backend = persisted(before.root, before.activePaneId);
      const save = mock(
        async (
          _environmentId: string,
          input: ReturnType<typeof createPersistedPaneLayoutInput>,
          revision?: number,
        ) => {
          if (revision !== backend.revision) {
            throw new Error(
              `Pane layout revision conflict: expected ${revision}, current ${backend.revision}`,
            );
          }
          backend = {
            ...backend,
            ...input,
            root: input.root as PaneNode,
            revision: backend.revision + 1,
          };
          return backend;
        },
      );
      const stopPersistence = startPaneLayoutPersistence({
        save,
        load: async () => backend,
        hydrateDependencies: async () => undefined,
        debounceMs: 60_000,
        selectionDebounceMs: 60_000,
      });
      const flush = () =>
        flushPaneLayoutNow(
          "env-1",
          createPersistedPaneLayoutInput(panes.getState().environments.get("env-1")!),
        );
      try {
        pipelines
          .getState()
          .replacePipeline(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));
        expect(
          panes
            .getState()
            .getAllTabs("env-1")
            .find((tab) => tab.id === NOTES_ID)?.keyInformationTabData?.completionPublished,
        ).toBeUndefined();
        expect(panes.getState().getActivePaneId("env-1")).toBe("pane-build");
        await flush();

        if (action === "close-notes") panes.getState().removeTab("pane-build", NOTES_ID, "env-1");
        panes.getState().setActivePane("pane-chat", "env-1");
        // Publication races the next renderer save. Exercise the real conflict
        // rebase and authoritative install, rather than only the arrival helper.
        backend = persisted(
          split(
            leaf("pane-build", [buildTab, notesTab], NOTES_ID),
            leaf("pane-chat", [chatTab], "chat"),
          ),
          "pane-build",
        );
        backend.revision = 20;
        await flush();
        const chosen = panes.getState().environments.get("env-1")!;
        expect(chosen.activePaneId).toBe("pane-chat");
        expect(
          panes
            .getState()
            .getAllTabs("env-1")
            .some((tab) => tab.id === NOTES_ID),
        ).toBe(action !== "close-notes");
        expect(selection(reconcileAuthoritativePaneLayout("env-1", backend, chosen))).toEqual(
          selection(chosen),
        );
        expect(save.mock.calls.length).toBeGreaterThanOrEqual(3);
      } finally {
        stopPersistence();
        stopObserver();
      }
    },
  );

  test.each(["select-chat", "close-notes"])(
    "backend publication before the completion event preserves %s",
    (action) => {
      const panes = appCommandStore(paneLayoutStore);
      const pipelines = appCommandStore(buildPipelineStore);
      pipelines
        .getState()
        .replacePipeline(buildPipelineFixture({ phase: "verifying", backendRevision: 1 }));
      const stop = startBuildPipelineCompletionNotes();
      try {
        const before = current(leaf("pane-build", [buildTab], buildTab.id), "pane-build");
        const after = persisted(
          leaf("pane-build", [buildTab, chatTab, notesTab], NOTES_ID),
          "pane-build",
        );
        const landed = reconcileAuthoritativePaneLayout("env-1", after, before)!;
        panes.setState({
          environments: new Map([["env-1", landed]]),
          hydration: new Map([["env-1", "done"]]),
        });
        panes.getState().setActiveTab("pane-build", "chat", "env-1");
        if (action === "close-notes") panes.getState().removeTab("pane-build", NOTES_ID, "env-1");
        pipelines
          .getState()
          .replacePipeline(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));
        expect(panes.getState().environments.get("env-1")!.root).toMatchObject({
          activeTabId: "chat",
        });
        expect(
          panes
            .getState()
            .getAllTabs("env-1")
            .some((tab) => tab.id === NOTES_ID),
        ).toBe(action !== "close-notes");
      } finally {
        stop();
      }
    },
  );

  test("a window that did not see the run finish follows the backend onto the new notes tab", () => {
    // The window was on the chat pane; the backend published the notes beside
    // the pipeline tab and selected them when the run completed.
    const before = current(
      split(leaf("pane-build", [buildTab], buildTab.id), leaf("pane-chat", [chatTab], "chat")),
      "pane-chat",
    );
    const after = persisted(
      split(
        leaf("pane-build", [buildTab, notesTab], NOTES_ID),
        leaf("pane-chat", [chatTab], "chat"),
      ),
      "pane-build",
    );

    const reconciled = reconcileAuthoritativePaneLayout("env-1", after, before);

    expect(selection(reconciled)).toEqual({
      activePaneId: "pane-build",
      leaves: [
        { id: "pane-build", activeTabId: NOTES_ID },
        { id: "pane-chat", activeTabId: "chat" },
      ],
    });
  });

  test("an existing manual Notes tab follows its first completion marker only once", () => {
    const manualNotes: TabInfo = {
      ...notesTab,
      keyInformationTabData: { environmentId: "env-1", pipelineId: "pipeline-1", view: "notes" },
    };
    const before = current(
      split(
        leaf("pane-build", [buildTab, manualNotes], buildTab.id),
        leaf("pane-chat", [chatTab], "chat"),
      ),
      "pane-chat",
    );
    const after = persisted(
      split(
        leaf("pane-build", [buildTab, notesTab], NOTES_ID),
        leaf("pane-chat", [chatTab], "chat"),
      ),
      "pane-build",
    );
    const landed = reconcileAuthoritativePaneLayout("env-1", after, before)!;
    expect(selection(landed)).toEqual({
      activePaneId: "pane-build",
      leaves: [
        { id: "pane-build", activeTabId: NOTES_ID },
        { id: "pane-chat", activeTabId: "chat" },
      ],
    });

    // Install the publication, then let the user return to chat. A repeated
    // snapshot must retain that choice now the marker has been consumed.
    const store = appCommandStore(paneLayoutStore);
    store.setState({ environments: new Map([["env-1", landed]]) });
    store.getState().setActivePane("pane-chat", "env-1");
    const chosen = store.getState().environments.get("env-1")!;
    expect(selection(reconcileAuthoritativePaneLayout("env-1", after, chosen))).toEqual(
      selection(chosen),
    );
  });

  test("a browser adopts the backend completion selection across panes", () => {
    Object.defineProperty(window, "orkestrator", { configurable: true, value: undefined });
    const before = current(
      split(leaf("pane-build", [buildTab], buildTab.id), leaf("pane-chat", [chatTab], "chat")),
      "pane-chat",
    );
    const after = persisted(
      split(
        leaf("pane-build", [buildTab, notesTab], NOTES_ID),
        leaf("pane-chat", [chatTab], "chat"),
      ),
      "pane-build",
    );
    const expected = {
      activePaneId: "pane-build",
      leaves: [
        { id: "pane-build", activeTabId: NOTES_ID },
        { id: "pane-chat", activeTabId: "chat" },
      ],
    };
    expect(selection(reconcileAuthoritativePaneLayout("env-1", after, before))).toEqual(expected);
  });

  test.each(["backend-first", "renderer-first"])(
    "a second window follows the completion after concurrent additions: %s",
    (order) => {
      const base = persisted(
        split(leaf("pane-build", [buildTab], buildTab.id), leaf("pane-chat", [chatTab], "chat")),
        "pane-chat",
      );
      const backend = persisted(
        split(
          leaf("pane-build", [buildTab, notesTab], NOTES_ID),
          leaf("pane-chat", [chatTab], "chat"),
        ),
        "pane-build",
      );
      const renderer = structuredClone(backend);
      if (renderer.root.kind !== "split" || renderer.root.children[0].kind !== "leaf")
        throw new Error("expected build pane");
      delete renderer.root.children[0].tabs[1]!.keyInformationTabData!.completionPublished;
      const merged =
        order === "backend-first"
          ? mergePersistedPaneLayouts(base, renderer, backend)
          : mergePersistedPaneLayouts(base, backend, renderer);
      // This window first loaded the pipeline already complete (beforeEach),
      // and has only the pre-publication layout; no transition observer ran.
      const reconciled = reconcileAuthoritativePaneLayout(
        "env-1",
        { ...backend, ...merged },
        current(base.root, "pane-chat"),
      );
      expect(selection(reconciled)).toEqual({
        activePaneId: "pane-build",
        leaves: [
          { id: "pane-build", activeTabId: NOTES_ID },
          { id: "pane-chat", activeTabId: "chat" },
        ],
      });
    },
  );

  test.each(["open", "reopen"])(
    "another window's manual Notes %s preserves chat selection",
    (action) => {
      const manualNotes: TabInfo = {
        ...notesTab,
        keyInformationTabData: { environmentId: "env-1", pipelineId: "pipeline-1", view: "notes" },
      };
      let before = current(
        split(leaf("pane-build", [buildTab], buildTab.id), leaf("pane-chat", [chatTab], "chat")),
        "pane-chat",
      );
      if (action === "reopen") {
        // Receive completion, then close Notes and return to chat before the
        // other window uses the ordinary manual-open action to recreate it.
        const landed = reconcileAuthoritativePaneLayout(
          "env-1",
          persisted(
            split(
              leaf("pane-build", [buildTab, notesTab], NOTES_ID),
              leaf("pane-chat", [chatTab], "chat"),
            ),
            "pane-build",
          ),
          before,
        );
        expect(selection(landed).activePaneId).toBe("pane-build");
        const store = appCommandStore(paneLayoutStore);
        store.setState({ environments: new Map([["env-1", landed!]]) });
        store.getState().removeTab("pane-build", NOTES_ID, "env-1");
        store.getState().setActivePane("pane-chat", "env-1");
        before = store.getState().environments.get("env-1")!;
      }
      const after = persisted(
        split(
          leaf("pane-build", [buildTab, manualNotes], NOTES_ID),
          leaf("pane-chat", [chatTab], "chat"),
        ),
        "pane-build",
      );
      const reconciled = reconcileAuthoritativePaneLayout("env-1", after, before);
      expect(selection(reconciled)).toEqual({
        activePaneId: "pane-chat",
        leaves: [
          { id: "pane-build", activeTabId: buildTab.id },
          { id: "pane-chat", activeTabId: "chat" },
        ],
      });
    },
  );

  test("a notes tab the window already holds does not pull the user back", () => {
    // The user has returned to the pipeline tab after the notes landed.
    const before = current(leaf("pane-build", [buildTab, notesTab], buildTab.id), "pane-build");
    const after = persisted(leaf("pane-build", [buildTab, notesTab], NOTES_ID), "pane-build");

    const reconciled = reconcileAuthoritativePaneLayout("env-1", after, before);

    expect(selection(reconciled).leaves).toEqual([{ id: "pane-build", activeTabId: buildTab.id }]);
  });

  test("a notes tab the backend did not select does not take focus", () => {
    const before = current(leaf("pane-build", [buildTab], buildTab.id), "pane-build");
    const after = persisted(leaf("pane-build", [buildTab, notesTab], buildTab.id), "pane-build");

    const reconciled = reconcileAuthoritativePaneLayout("env-1", after, before);

    expect(selection(reconciled).leaves).toEqual([{ id: "pane-build", activeTabId: buildTab.id }]);
  });
});
