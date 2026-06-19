import { afterEach, describe, expect, test } from "bun:test";
import { useFilesPanelStore } from "../../../src/stores/filesPanelStore";
import type { FileNode, GitFileChange } from "../../../src/lib/tauri";

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
    collapsedFolders: [],
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

  test("toggles collapsed folders idempotently by path", () => {
    const store = useFilesPanelStore.getState();

    store.toggleFolderCollapse("src");
    store.toggleFolderCollapse("tests");
    expect(useFilesPanelStore.getState().collapsedFolders).toEqual(["src", "tests"]);

    useFilesPanelStore.getState().toggleFolderCollapse("src");
    expect(useFilesPanelStore.getState().collapsedFolders).toEqual(["tests"]);
  });
});
