import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { uiStore } from "../../../apps/web/src/stores/uiStore";
import { createUIChromeStore } from "../../../apps/web/src/stores/uiChromeStore";
import {
  COMMAND_STORAGE_NODE,
  desktopConnectionStorageKey,
  windowStorageKey,
} from "../../../apps/web/src/lib/desktop-storage-key";
import { resetWindowScopeForTests } from "../../../apps/web/src/lib/node-scope/app-window-scope";
import { WindowScope } from "../../../apps/web/src/lib/node-scope/window-scope";
import { FakeNodeClient } from "../../../apps/web/src/test/render-in-node-scope";
import { appCommandStore } from "../../../apps/web/src/test/app-command-store";

// The window's chrome (sidebar, width, sort, zoom) is `uiChromeStore`, one per
// window and persisted under the window key; a node's selection, collapsed
// projects and recents are the scoped `uiStore`, persisted under the node's
// key (plan item 3006). `useUIStore`'s statics are the app command scope's.
const WINDOW_KEY = windowStorageKey("ui-storage");
const NODE_KEY = desktopConnectionStorageKey("ui-project-storage", COMMAND_STORAGE_NODE);
const windows: WindowScope[] = [];

/** A fresh document's command node UI state: a new window scope, hydrated from storage. */
function reloadedUI() {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  return windowScope.open({ role: "command", client: new FakeNodeClient() }).store(uiStore);
}

describe("uiStore", () => {
  let chrome: ReturnType<typeof createUIChromeStore>;

  beforeEach(() => {
    localStorage.clear();
    resetWindowScopeForTests();
    chrome = createUIChromeStore();
    // Reset store between tests
    appCommandStore(uiStore).setState({
      selectedProjectId: null,
      selectedEnvironmentId: null,
      recentProjectIds: [],
      projectBoardTab: "kanban",
      collapsedProjects: [],
      projectCollapseChoices: [],
      selectedEnvironmentIds: [],
      expandedSessionsEnvironments: [],
    });
  });

  afterEach(() => {
    for (const windowScope of windows.splice(0)) windowScope.dispose();
    resetWindowScopeForTests();
    localStorage.clear();
  });

  test("initial state has correct defaults", () => {
    const state = appCommandStore(uiStore).getState();
    expect(state.selectedProjectId).toBeNull();
    expect(state.selectedEnvironmentId).toBeNull();
    expect(state.recentProjectIds).toEqual([]);
    expect(state.projectBoardTab).toBe("kanban");
    expect(state.collapsedProjects).toEqual([]);
    expect(state.selectedEnvironmentIds).toEqual([]);
    expect(state.expandedSessionsEnvironments).toEqual([]);
    const window = chrome.getState();
    expect(window.sidebarWidth).toBe(280);
    expect(window.environmentSortMode).toBe("project");
    expect(window.activitySortOrder).toBe("priority");
    expect(window.zoomLevel).toBe(100);
    expect(window.sidebarOpen).toBe(true);
  });

  test("toggleSidebar flips and persists the left panel visibility", async () => {
    expect(chrome.getState().sidebarOpen).toBe(true);

    chrome.getState().toggleSidebar();
    expect(chrome.getState().sidebarOpen).toBe(false);

    const persistedRaw = localStorage.getItem(WINDOW_KEY) ?? "{}";
    expect((JSON.parse(persistedRaw) as { state?: Record<string, unknown> }).state).toMatchObject({
      sidebarOpen: false,
    });

    chrome.setState({ sidebarOpen: true });
    localStorage.setItem(WINDOW_KEY, persistedRaw);
    await chrome.persist.rehydrate();

    expect(chrome.getState().sidebarOpen).toBe(false);

    chrome.getState().toggleSidebar();
    expect(chrome.getState().sidebarOpen).toBe(true);
  });

  test("selectProject sets project and clears environment and multi-selection", () => {
    appCommandStore(uiStore).setState({
      selectedEnvironmentId: "env-1",
      selectedEnvironmentIds: ["env-1", "env-2"],
    });

    appCommandStore(uiStore).getState().selectProject("project-1");

    const state = appCommandStore(uiStore).getState();
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBeNull();
    expect(state.selectedEnvironmentIds).toEqual([]);
    expect(state.recentProjectIds).toEqual(["project-1"]);
  });

  test("selectProject with null clears selection", () => {
    appCommandStore(uiStore).setState({
      selectedProjectId: "project-1",
      selectedEnvironmentId: "env-1",
    });

    appCommandStore(uiStore).getState().selectProject(null);

    const state = appCommandStore(uiStore).getState();
    expect(state.selectedProjectId).toBeNull();
    expect(state.selectedEnvironmentId).toBeNull();
  });

  test("selectEnvironment sets environment id", () => {
    appCommandStore(uiStore).getState().selectEnvironment("env-1");
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env-1");
  });

  test("selectEnvironment with null clears environment", () => {
    appCommandStore(uiStore).setState({ selectedEnvironmentId: "env-1" });

    appCommandStore(uiStore).getState().selectEnvironment(null);
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBeNull();
  });

  test("setProjectBoardTab updates the board tab", () => {
    appCommandStore(uiStore).setState({ projectBoardTab: "kanban" });

    appCommandStore(uiStore).getState().setProjectBoardTab("notes");

    expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("notes");
  });

  test("setSidebarWidth updates the width", () => {
    chrome.getState().setSidebarWidth(350);
    expect(chrome.getState().sidebarWidth).toBe(350);

    chrome.getState().setSidebarWidth(200);
    expect(chrome.getState().sidebarWidth).toBe(200);
  });

  test("selectProjectAndEnvironment sets both", () => {
    appCommandStore(uiStore).getState().selectProjectAndEnvironment("project-1", "env-1");

    const state = appCommandStore(uiStore).getState();
    expect(state.selectedProjectId).toBe("project-1");
    expect(state.selectedEnvironmentId).toBe("env-1");
    expect(state.recentProjectIds).toEqual(["project-1"]);
  });

  test("keeps the five most recently opened projects without duplicates", () => {
    for (const projectId of ["p1", "p2", "p3", "p4", "p5", "p6", "p3"]) {
      appCommandStore(uiStore).getState().selectProject(projectId);
    }

    expect(appCommandStore(uiStore).getState().recentProjectIds).toEqual([
      "p3",
      "p6",
      "p5",
      "p4",
      "p2",
    ]);

    appCommandStore(uiStore).getState().selectProject(null);
    expect(appCommandStore(uiStore).getState().recentProjectIds).toEqual([
      "p3",
      "p6",
      "p5",
      "p4",
      "p2",
    ]);
  });

  test("toggleProjectCollapse adds and removes", () => {
    appCommandStore(uiStore).getState().toggleProjectCollapse("project-1");
    expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual(["project-1"]);

    appCommandStore(uiStore).getState().toggleProjectCollapse("project-1");
    expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual([]);
  });

  test("setProjectCollapsed sets collapsed state", () => {
    appCommandStore(uiStore).getState().setProjectCollapsed("project-1", true);
    expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual(["project-1"]);

    // No duplicate when already collapsed
    appCommandStore(uiStore).getState().setProjectCollapsed("project-1", true);
    expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual(["project-1"]);

    appCommandStore(uiStore).getState().setProjectCollapsed("project-1", false);
    expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual([]);
  });

  test("toggleEnvironmentSelection adds and removes", () => {
    appCommandStore(uiStore).getState().toggleEnvironmentSelection("env-1");
    expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual(["env-1"]);

    appCommandStore(uiStore).getState().toggleEnvironmentSelection("env-2");
    expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual(["env-1", "env-2"]);

    appCommandStore(uiStore).getState().toggleEnvironmentSelection("env-1");
    expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual(["env-2"]);
  });

  test("setMultiSelection and clearMultiSelection", () => {
    appCommandStore(uiStore).getState().setMultiSelection(["env-1", "env-2", "env-3"]);
    expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual([
      "env-1",
      "env-2",
      "env-3",
    ]);

    appCommandStore(uiStore).getState().clearMultiSelection();
    expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual([]);
  });

  test("toggleSessionsExpanded and isSessionsExpanded", () => {
    expect(appCommandStore(uiStore).getState().isSessionsExpanded("env-1")).toBe(false);

    appCommandStore(uiStore).getState().toggleSessionsExpanded("env-1");
    expect(appCommandStore(uiStore).getState().isSessionsExpanded("env-1")).toBe(true);

    appCommandStore(uiStore).getState().toggleSessionsExpanded("env-1");
    expect(appCommandStore(uiStore).getState().isSessionsExpanded("env-1")).toBe(false);
  });

  test("sets and persists the environment sort mode", () => {
    chrome.getState().setEnvironmentSortMode("activity");

    expect(chrome.getState().environmentSortMode).toBe("activity");
    const persisted = JSON.parse(localStorage.getItem(WINDOW_KEY) ?? "{}") as {
      state?: Record<string, unknown>;
    };
    expect(persisted.state?.environmentSortMode).toBe("activity");
  });

  test("sets and persists the activity sort order", () => {
    chrome.getState().setActivitySortOrder("oldest");

    expect(chrome.getState().activitySortOrder).toBe("oldest");
    const persisted = JSON.parse(localStorage.getItem(WINDOW_KEY) ?? "{}") as {
      state?: Record<string, unknown>;
    };
    expect(persisted.state?.activitySortOrder).toBe("oldest");
  });

  for (const order of ["priority", "newest", "oldest"] as const) {
    test(`rehydrates ${order} activity order in a new store`, () => {
      chrome.getState().setEnvironmentSortMode("activity");
      chrome.getState().setActivitySortOrder(order);
      const persisted = localStorage.getItem(WINDOW_KEY)!;

      // Restore the serialized settings as a fresh renderer would read them.
      localStorage.clear();
      localStorage.setItem(WINDOW_KEY, persisted);
      const reloaded = createUIChromeStore();

      expect(reloaded.getState().environmentSortMode).toBe("activity");
      expect(reloaded.getState().activitySortOrder).toBe(order);
    });
  }

  test("rehydrates older settings without an activity order using priority", () => {
    localStorage.setItem(
      WINDOW_KEY,
      JSON.stringify({ state: { environmentSortMode: "activity" }, version: 0 }),
    );
    const reloaded = createUIChromeStore();
    expect(reloaded.getState().activitySortOrder).toBe("priority");
  });

  test("no longer persists unread activity, which the environment record owns", () => {
    appCommandStore(uiStore).getState().selectEnvironment("env-1");
    appCommandStore(uiStore).getState().setProjectCollapsed("project-1", true);
    chrome.getState().setZoomLevel(110);

    // Unread state moved onto the Environment record so every connected client
    // agrees on it. Leaving a copy in localStorage would resurrect the stale
    // per-window badge this store used to keep.
    for (const key of [WINDOW_KEY, NODE_KEY]) {
      const persisted = JSON.parse(localStorage.getItem(key) ?? "{}") as {
        state?: Record<string, unknown>;
      };
      expect(persisted.state).toBeDefined();
      expect(persisted.state).not.toHaveProperty("unreadEnvironmentIds");
    }
    expect(appCommandStore(uiStore).getState()).not.toHaveProperty("unreadEnvironmentIds");
    expect(chrome.getState()).not.toHaveProperty("unreadEnvironmentIds");
  });

  test("setZoomLevel clamps to 50-200", () => {
    chrome.getState().setZoomLevel(150);
    expect(chrome.getState().zoomLevel).toBe(150);

    chrome.getState().setZoomLevel(10);
    expect(chrome.getState().zoomLevel).toBe(50);

    chrome.getState().setZoomLevel(300);
    expect(chrome.getState().zoomLevel).toBe(200);
  });

  test("zoomIn and zoomOut step by 10", () => {
    chrome.getState().zoomIn();
    expect(chrome.getState().zoomLevel).toBe(110);

    chrome.getState().zoomOut();
    expect(chrome.getState().zoomLevel).toBe(100);
  });

  test("zoomIn caps at 200 and zoomOut caps at 50", () => {
    chrome.getState().setZoomLevel(200);
    chrome.getState().zoomIn();
    expect(chrome.getState().zoomLevel).toBe(200);

    chrome.getState().setZoomLevel(50);
    chrome.getState().zoomOut();
    expect(chrome.getState().zoomLevel).toBe(50);
  });

  test("resetZoom sets zoom to 100", () => {
    chrome.getState().setZoomLevel(150);
    chrome.getState().resetZoom();
    expect(chrome.getState().zoomLevel).toBe(100);
  });

  test("collapseEmptyProjects collapses only empty projects", () => {
    const projectsWithEnvs = new Set(["project-2"]);
    appCommandStore(uiStore)
      .getState()
      .collapseEmptyProjects(["project-1", "project-2", "project-3"], projectsWithEnvs);

    const collapsed = appCommandStore(uiStore).getState().collapsedProjects;
    expect(collapsed).toContain("project-1");
    expect(collapsed).toContain("project-3");
    expect(collapsed).not.toContain("project-2");
  });

  test("collapseEmptyProjects is a no-op when every empty project is already collapsed", () => {
    appCommandStore(uiStore).setState({ collapsedProjects: ["project-1"] });
    const before = appCommandStore(uiStore).getState();

    appCommandStore(uiStore)
      .getState()
      .collapseEmptyProjects(["project-1", "project-2"], new Set(["project-2"]));

    expect(appCommandStore(uiStore).getState()).toBe(before);
    expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual(["project-1"]);
  });

  test("persists and rehydrates recent project history without transient selection", () => {
    appCommandStore(uiStore).getState().selectProject("project-1");
    appCommandStore(uiStore).getState().selectProject("project-2");
    chrome.getState().setEnvironmentSortMode("activity");

    const persistedRaw = localStorage.getItem(NODE_KEY) ?? "{}";
    const presentationRaw = localStorage.getItem(WINDOW_KEY) ?? "{}";
    const persisted = JSON.parse(persistedRaw) as {
      state?: Record<string, unknown>;
    };
    expect(persisted.state).toMatchObject({
      recentProjectIds: ["project-2", "project-1"],
    });
    expect(JSON.parse(presentationRaw).state.environmentSortMode).toBe("activity");
    expect(JSON.parse(presentationRaw).state).not.toHaveProperty("recentProjectIds");
    expect(persisted.state).not.toHaveProperty("selectedProjectId");

    // A fresh document reads both records back; the selection is not among them.
    localStorage.clear();
    localStorage.setItem(NODE_KEY, persistedRaw);
    localStorage.setItem(WINDOW_KEY, presentationRaw);
    const reloaded = reloadedUI();

    expect(reloaded.getState().recentProjectIds).toEqual(["project-2", "project-1"]);
    expect(reloaded.getState().selectedProjectId).toBeNull();
    expect(createUIChromeStore().getState().environmentSortMode).toBe("activity");
  });

  test("toggles and sets folder collapse independently of project collapse", () => {
    appCommandStore(uiStore).setState({ collapsedProjectFolders: [], collapsedProjects: [] });

    appCommandStore(uiStore).getState().toggleProjectFolderCollapse("Work");
    expect(appCommandStore(uiStore).getState().collapsedProjectFolders).toEqual(["Work"]);
    expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual([]);

    appCommandStore(uiStore).getState().toggleProjectFolderCollapse("Work");
    expect(appCommandStore(uiStore).getState().collapsedProjectFolders).toEqual([]);

    appCommandStore(uiStore).getState().setProjectFolderCollapsed("Work", true);
    appCommandStore(uiStore).getState().setProjectFolderCollapsed("Work", true);
    expect(appCommandStore(uiStore).getState().collapsedProjectFolders).toEqual(["Work"]);

    appCommandStore(uiStore).getState().setProjectFolderCollapsed("Work", false);
    expect(appCommandStore(uiStore).getState().collapsedProjectFolders).toEqual([]);
  });

  test("matches a collapsed folder by identity, not by how the name is spelled", () => {
    appCommandStore(uiStore).setState({ collapsedProjectFolders: ["Work"] });

    appCommandStore(uiStore).getState().setProjectFolderCollapsed("work", true);
    expect(appCommandStore(uiStore).getState().collapsedProjectFolders).toEqual(["Work"]);

    appCommandStore(uiStore).getState().setProjectFolderCollapsed("WORK", false);
    expect(appCommandStore(uiStore).getState().collapsedProjectFolders).toEqual([]);

    appCommandStore(uiStore).setState({ collapsedProjectFolders: ["Work"] });
    appCommandStore(uiStore).getState().toggleProjectFolderCollapse("work");
    expect(appCommandStore(uiStore).getState().collapsedProjectFolders).toEqual([]);
  });

  test("persists collapsed folders so a reload reopens the same tree", () => {
    appCommandStore(uiStore).getState().setProjectFolderCollapsed("Work", true);

    const persistedRaw = localStorage.getItem(NODE_KEY) ?? "{}";
    expect((JSON.parse(persistedRaw) as { state?: Record<string, unknown> }).state).toMatchObject({
      collapsedProjectFolders: ["Work"],
    });

    appCommandStore(uiStore).setState({ collapsedProjectFolders: [] });
    localStorage.setItem(NODE_KEY, persistedRaw);

    expect(reloadedUI().getState().collapsedProjectFolders).toEqual(["Work"]);
  });
});
