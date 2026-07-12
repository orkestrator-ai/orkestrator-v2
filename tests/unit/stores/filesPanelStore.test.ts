import { afterEach, describe, expect, test } from "bun:test";
import { useFilesPanelStore } from "../../../apps/web/src/stores/filesPanelStore";
import type { FileNode, GitFileChange } from "../../../apps/web/src/lib/backend";

const change: GitFileChange = {
  path: "src/App.tsx",
  filename: "App.tsx",
  directory: "src",
  status: "M",
  additions: 5,
  deletions: 2,
};

const tree: FileNode[] = [
  {
    name: "src",
    path: "src",
    isDirectory: true,
    children: [{ name: "App.tsx", path: "src/App.tsx", isDirectory: false }],
  },
];

function resetStore() {
  useFilesPanelStore.setState({
    isOpen: false,
    panelWidth: 320,
    activeTab: "changes",
    expandedFolders: [],
    changes: [],
    isLoadingChanges: false,
    fileTree: [],
    isLoadingTree: false,
    targetBranch: "main",
  });
}

describe("filesPanelStore", () => {
  afterEach(() => {
    resetStore();
  });

  test("toggles and explicitly opens or closes the panel", () => {
    const store = useFilesPanelStore.getState();

    store.togglePanel();
    expect(useFilesPanelStore.getState().isOpen).toBe(true);

    useFilesPanelStore.getState().closePanel();
    expect(useFilesPanelStore.getState().isOpen).toBe(false);

    useFilesPanelStore.getState().openPanel();
    expect(useFilesPanelStore.getState().isOpen).toBe(true);
  });

  test("updates tab, panel width, loading flags, target branch, and loaded data", () => {
    const store = useFilesPanelStore.getState();

    store.setActiveTab("all-files");
    store.setPanelWidth(480);
    store.setChanges([change]);
    store.setFileTree(tree);
    store.setLoadingChanges(true);
    store.setLoadingTree(true);
    store.setTargetBranch("release");

    expect(useFilesPanelStore.getState()).toMatchObject({
      activeTab: "all-files",
      panelWidth: 480,
      changes: [change],
      fileTree: tree,
      isLoadingChanges: true,
      isLoadingTree: true,
      targetBranch: "release",
    });
  });

  test("sets expanded folders idempotently by path", () => {
    const store = useFilesPanelStore.getState();

    store.setFolderExpanded("src", true);
    store.setFolderExpanded("tests", true);
    store.setFolderExpanded("src", true);
    expect(useFilesPanelStore.getState().expandedFolders).toEqual(["src", "tests"]);

    useFilesPanelStore.getState().setFolderExpanded("src", false);
    expect(useFilesPanelStore.getState().expandedFolders).toEqual(["tests"]);
  });

  test("collapsing an already-collapsed folder is a no-op and preserves order", () => {
    const store = useFilesPanelStore.getState();

    store.setFolderExpanded("a", true);
    store.setFolderExpanded("b", true);
    store.setFolderExpanded("c", true);

    // Removing a path that is not expanded leaves the list untouched.
    useFilesPanelStore.getState().setFolderExpanded("missing", false);
    expect(useFilesPanelStore.getState().expandedFolders).toEqual(["a", "b", "c"]);

    // Removing from the middle keeps the remaining order stable.
    useFilesPanelStore.getState().setFolderExpanded("b", false);
    expect(useFilesPanelStore.getState().expandedFolders).toEqual(["a", "c"]);
  });

  test("ignores legacy persisted collapsedFolders so folders default to collapsed", async () => {
    // Simulate an existing user whose persisted payload predates the
    // expanded-by-exception model (it only recorded collapsed folders).
    localStorage.setItem(
      "files-panel-storage",
      JSON.stringify({
        state: { panelWidth: 400, collapsedFolders: ["src", "tests"] },
        version: 0,
      }),
    );

    try {
      await useFilesPanelStore.persist.rehydrate();
      const state = useFilesPanelStore.getState();

      // Persisted width still restores.
      expect(state.panelWidth).toBe(400);
      // No expandedFolders were persisted, so everything starts collapsed.
      expect(state.expandedFolders).toEqual([]);
    } finally {
      localStorage.removeItem("files-panel-storage");
    }
  });
});
