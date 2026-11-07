import { afterEach, describe, expect, test } from "bun:test";
import { filesPanelStore } from "../../../apps/web/src/stores/filesPanelStore";
import {
  FILES_PANEL_DEFAULT_WIDTH_PX,
  legacyFilesPanelWidth,
  useFilesPanelChromeStore,
} from "../../../apps/web/src/stores/filesPanelChromeStore";
import { WindowScope } from "../../../apps/web/src/lib/node-scope/window-scope";
import { FakeNodeClient } from "../../../apps/web/src/test/render-in-node-scope";
import type { FileNode, GitFileChange } from "../../../apps/web/src/lib/backend";
import { appCommandStore } from "../../../apps/web/src/test/app-command-store";

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
  useFilesPanelChromeStore.setState({ isOpen: false, panelWidth: FILES_PANEL_DEFAULT_WIDTH_PX });
  appCommandStore(filesPanelStore).setState({
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

  test("toggles and explicitly opens or closes the window's panel", () => {
    const chrome = useFilesPanelChromeStore.getState();

    chrome.togglePanel();
    expect(useFilesPanelChromeStore.getState().isOpen).toBe(true);

    useFilesPanelChromeStore.getState().closePanel();
    expect(useFilesPanelChromeStore.getState().isOpen).toBe(false);

    useFilesPanelChromeStore.getState().openPanel();
    expect(useFilesPanelChromeStore.getState().isOpen).toBe(true);
  });

  test("updates tab, panel width, loading flags, target branch, and loaded data", () => {
    const store = appCommandStore(filesPanelStore).getState();

    store.setActiveTab("all-files");
    useFilesPanelChromeStore.getState().setPanelWidth(480);
    store.setChanges([change]);
    store.setFileTree(tree);
    store.setLoadingChanges(true);
    store.setLoadingTree(true);
    store.setTargetBranch("release");

    expect(useFilesPanelChromeStore.getState().panelWidth).toBe(480);
    expect(appCommandStore(filesPanelStore).getState()).toMatchObject({
      activeTab: "all-files",
      changes: [change],
      fileTree: tree,
      isLoadingChanges: true,
      isLoadingTree: true,
      targetBranch: "release",
    });
  });

  test("sets expanded folders idempotently by path", () => {
    const store = appCommandStore(filesPanelStore).getState();

    store.setFolderExpanded("src", true);
    store.setFolderExpanded("tests", true);
    store.setFolderExpanded("src", true);
    expect(appCommandStore(filesPanelStore).getState().expandedFolders).toEqual(["src", "tests"]);

    appCommandStore(filesPanelStore).getState().setFolderExpanded("src", false);
    expect(appCommandStore(filesPanelStore).getState().expandedFolders).toEqual(["tests"]);
  });

  test("collapsing an already-collapsed folder is a no-op and preserves order", () => {
    const store = appCommandStore(filesPanelStore).getState();

    store.setFolderExpanded("a", true);
    store.setFolderExpanded("b", true);
    store.setFolderExpanded("c", true);

    // Removing a path that is not expanded leaves the list untouched.
    appCommandStore(filesPanelStore).getState().setFolderExpanded("missing", false);
    expect(appCommandStore(filesPanelStore).getState().expandedFolders).toEqual(["a", "b", "c"]);

    // Removing from the middle keeps the remaining order stable.
    appCommandStore(filesPanelStore).getState().setFolderExpanded("b", false);
    expect(appCommandStore(filesPanelStore).getState().expandedFolders).toEqual(["a", "c"]);
  });

  test("ignores legacy persisted collapsedFolders so folders default to collapsed", () => {
    // Simulate an existing user whose persisted payload predates the
    // expanded-by-exception model (it only recorded collapsed folders).
    localStorage.setItem(
      "files-panel-storage",
      JSON.stringify({
        state: { panelWidth: 400, collapsedFolders: ["src", "tests"] },
        version: 0,
      }),
    );
    const windowScope = new WindowScope();
    try {
      const state = windowScope
        .open({ role: "command", client: new FakeNodeClient() })
        .store(filesPanelStore)
        .getState();

      // The width there is now the window's, read while it has none of its own.
      expect(legacyFilesPanelWidth()).toBe(400);
      // No expandedFolders were persisted, so everything starts collapsed.
      expect(state.expandedFolders).toEqual([]);
    } finally {
      windowScope.dispose();
      localStorage.removeItem("files-panel-storage");
    }
  });
});
