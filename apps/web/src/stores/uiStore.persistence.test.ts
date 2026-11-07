import { afterEach, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { uiStore } from "./uiStore";
import { createUIChromeStore } from "./uiChromeStore";
import {
  COMMAND_STORAGE_NODE,
  desktopConnectionStorageKey,
  windowStorageKey,
} from "@/lib/desktop-storage-key";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { portalStore } from "@/lib/portal/portal-store";
import { FakeNodeClient } from "@/test/render-in-node-scope";

const originalNative = window.orkestrator;
const originalPortal = portalStore.getState();
const windows: WindowScope[] = [];

/** A fresh document's command node UI state: a new window scope, hydrated from storage. */
function commandUI() {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  return windowScope.open({ role: "command", client: new FakeNodeClient() }).store(uiStore);
}

/** A fresh document's UI state of another node shown in its tree, hydrated from storage. */
function leafUI(nodeId: string) {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  windowScope.open({ role: "command", client: new FakeNodeClient() });
  return windowScope
    .open({ role: "leaf", client: new FakeNodeClient({ nodeId: nodeId as BackendId }) })
    .store(uiStore);
}

afterEach(() => {
  for (const windowScope of windows.splice(0)) windowScope.dispose();
  resetWindowScopeForTests();
  window.orkestrator = originalNative;
  localStorage.clear();
  sessionStorage.clear();
  portalStore.store.setState(originalPortal, true);
});

test("each node's UI state hydrates under its own key, apart from the window's chrome", () => {
  window.orkestrator = undefined;
  localStorage.clear();
  const command = commandUI();
  command.getState().setProjectCollapsed("same-id", true);
  command.getState().selectProject("command-project");
  createUIChromeStore().getState().setSidebarWidth(345);
  createUIChromeStore().getState().setZoomLevel(120);
  const a = leafUI("bk_a");
  expect(a.getState().collapsedProjects).toEqual([]);
  expect(a.getState().projectCollapseChoices).toEqual([]);
  a.getState().setProjectCollapsed("explicit-expanded", false);
  a.getState().setProjectFolderCollapsed("Folder", true);
  const b = leafUI("bk_b");
  b.getState().setProjectCollapsed("same-id", true);
  expect(b.getState().collapsedProjectFolders).toEqual([]);
  expect(b.getState().projectCollapseChoices).not.toContain("explicit-expanded");
  expect(leafUI("bk_a").getState().projectCollapseChoices).toContain("explicit-expanded");
  expect(leafUI("bk_a").getState().collapsedProjects).toEqual([]);
  expect(leafUI("bk_a").getState().collapsedProjectFolders).toEqual(["Folder"]);
  // The window's chrome is the window's, whichever node it shows.
  expect(createUIChromeStore().getState().sidebarWidth).toBe(345);
  const back = commandUI();
  expect(back.getState().recentProjectIds).toEqual(["command-project"]);
  expect(back.getState().collapsedProjects).toEqual(["same-id"]);
  expect(createUIChromeStore().getState().zoomLevel).toBe(120);
});

test("a command node's project opens on its coordinator", () => {
  window.orkestrator = undefined;
  resetWindowScopeForTests();
  const command = getWindowScope().commandScope().store(uiStore);
  command.getState().setProjectBoardTab("kanban");
  command.getState().selectProject("command-project");
  expect(command.getState().projectBoardTab).toBe("coordinator");
});

test("a leaf scope's projects open on their home by its role, whatever the page is", () => {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  windowScope.open({ role: "command", client: new FakeNodeClient() });
  const leaf = windowScope
    .open({ role: "leaf", client: new FakeNodeClient({ nodeId: "bk_leaf" as BackendId }) })
    .store(uiStore);
  expect(leaf.getState().projectBoardTab).toBe("home");
  leaf.getState().setProjectBoardTab("kanban");
  leaf.getState().selectProject("leaf-project");
  expect(leaf.getState().projectBoardTab).toBe("home");
  // The page's leaf-mode facts are the app window's command scope's only.
  portalStore.store.setState({ status: { mode: "leaf" } as never, loaded: true });
  const command = windowScope.commandScope().store(uiStore);
  command.getState().selectProject("command-project");
  expect(command.getState().projectBoardTab).toBe("coordinator");
});

test("directly connected leaf nodes default to Home when a project is selected", () => {
  resetWindowScopeForTests();
  const direct = getWindowScope().commandScope().store(uiStore);
  // Status loads asynchronously after the UI store is created.
  portalStore.store.setState({ status: { mode: "leaf" } as never, loaded: true });
  direct.getState().selectProject("leaf-project");
  expect(direct.getState().projectBoardTab).toBe("home");
  direct.getState().setProjectBoardTab("kanban");
  direct.getState().selectProject("another-project");
  expect(direct.getState().projectBoardTab).toBe("home");
});

test("graph height survives fresh-store hydration and resetting restores automatic sizing", () => {
  localStorage.clear();
  const initial = createUIChromeStore();
  expect(initial.getState().multiReviewGraphHeight).toBeNull();
  initial.getState().setMultiReviewGraphHeight(420);
  const reloaded = createUIChromeStore();
  expect(reloaded.getState().multiReviewGraphHeight).toBe(420);
  reloaded.getState().setMultiReviewGraphHeight(null);
  expect(createUIChromeStore().getState().multiReviewGraphHeight).toBeNull();
});

test("the build pipeline graph keeps a height of its own", () => {
  localStorage.clear();
  const initial = createUIChromeStore();
  initial.getState().setPipelineGraphHeight(300);
  const reloaded = createUIChromeStore();
  expect(reloaded.getState().pipelineGraphHeight).toBe(300);
  expect(reloaded.getState().multiReviewGraphHeight).toBeNull();
});

test("the data-saving preference is off by default and survives a reload", () => {
  localStorage.clear();
  const initial = createUIChromeStore();
  expect(initial.getState().dataSaving).toBe(false);
  initial.getState().setDataSaving(true);
  expect(createUIChromeStore().getState().dataSaving).toBe(true);
  createUIChromeStore().getState().setDataSaving(false);
  expect(createUIChromeStore().getState().dataSaving).toBe(false);
});

test("a dismissed coordinator first-run card stays dismissed for the window, in every project", () => {
  window.orkestrator = undefined;
  localStorage.clear();
  const first = createUIChromeStore();
  expect(first.getState().coordinatorIntroDismissed).toBe(false);
  commandUI().getState().selectProject("project-a");
  first.getState().setCoordinatorIntroDismissed(true);
  const next = createUIChromeStore();
  expect(next.getState().coordinatorIntroDismissed).toBe(true);
  commandUI().getState().selectProject("project-b");
  expect(next.getState().coordinatorIntroDismissed).toBe(true);
});

test("the removed Work panel's saved sections are ignored and dropped on the next write", () => {
  localStorage.clear();
  const key = windowStorageKey("ui-storage");
  localStorage.setItem(
    key,
    JSON.stringify({
      state: { sidebarWidth: 333, collapsedWorkBuckets: ["finished"] },
      version: 0,
    }),
  );
  const store = createUIChromeStore();
  expect(store.getState().sidebarWidth).toBe(333);
  expect("collapsedWorkBuckets" in store.getState()).toBe(false);
  store.getState().setZoomLevel(110);
  const saved = JSON.parse(localStorage.getItem(key) ?? "null");
  expect(saved.state.sidebarWidth).toBe(333);
  expect("collapsedWorkBuckets" in saved.state).toBe(false);
});

test("an earlier release's project fields in the window record move to the node's key", () => {
  window.orkestrator = undefined;
  localStorage.clear();
  const windowKey = windowStorageKey("ui-storage");
  const projectKey = desktopConnectionStorageKey("ui-project-storage", COMMAND_STORAGE_NODE);
  localStorage.setItem(
    windowKey,
    JSON.stringify({
      state: { sidebarWidth: 300, collapsedProjects: ["old"], recentProjectIds: ["recent"] },
      version: 0,
    }),
  );
  // A chrome write first keeps them for the node to adopt.
  createUIChromeStore().getState().setZoomLevel(130);
  expect(JSON.parse(localStorage.getItem(windowKey) ?? "null").state.collapsedProjects).toEqual([
    "old",
  ]);
  const ui = commandUI();
  expect(ui.getState().collapsedProjects).toEqual(["old"]);
  expect(ui.getState().recentProjectIds).toEqual(["recent"]);
  ui.getState().setProjectCollapsed("new", true);
  expect(JSON.parse(localStorage.getItem(projectKey) ?? "null").state.collapsedProjects).toEqual([
    "old",
    "new",
  ]);
  const windowRecord = JSON.parse(localStorage.getItem(windowKey) ?? "null");
  expect("collapsedProjects" in windowRecord.state).toBe(false);
  expect(windowRecord.state.zoomLevel).toBe(130);
});
