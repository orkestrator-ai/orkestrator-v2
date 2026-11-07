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
import { writeRealmWorkspace } from "@/lib/portal/workspace-target-storage";
import { portalStore } from "@/lib/portal/portal-store";
import { FakeNodeClient } from "@/test/render-in-node-scope";

const originalNative = window.orkestrator;
const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
const originalHref = window.location.href;
const originalPortal = portalStore.getState();
const windows: WindowScope[] = [];

/** This document as the realm of a node's workspace, or (`null`) as the window. */
function realmOn(nodeId: string | null) {
  if (!nodeId) {
    happyDOM.setURL(originalHref);
    return;
  }
  writeRealmWorkspace({
    workspaceId: `w-${nodeId}`,
    nodeId: nodeId as never,
    nodeName: nodeId,
    path: "relay",
    baseUrl: "https://command.test/relay",
    expiresAt: Date.now() + 900000,
  });
  const url = new URL(originalHref);
  url.search = `?realm=workspace&workspace=w-${nodeId}`;
  happyDOM.setURL(url.toString());
}

/** A fresh document's command node UI state: a new window scope, hydrated from storage. */
function commandUI() {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  return windowScope.open({ role: "command", client: new FakeNodeClient() }).store(uiStore);
}

afterEach(() => {
  for (const windowScope of windows.splice(0)) windowScope.dispose();
  resetWindowScopeForTests();
  realmOn(null);
  window.orkestrator = originalNative;
  delete window.orkestratorWorkspaceTarget;
  localStorage.clear();
  sessionStorage.clear();
  portalStore.store.setState(originalPortal, true);
});

test("a realm hydrates its node's stores before gateway initialization, apart from its window's", () => {
  window.orkestrator = undefined;
  delete window.orkestratorWorkspaceTarget;
  localStorage.clear();
  const command = commandUI();
  command.getState().setProjectCollapsed("same-id", true);
  command.getState().selectProject("command-project");
  createUIChromeStore().getState().setSidebarWidth(345);
  createUIChromeStore().getState().setZoomLevel(120);
  const visit = (nodeId: string) => {
    realmOn(nodeId);
    return commandUI();
  };
  const a = visit("A");
  expect(a.getState().collapsedProjects).toEqual([]);
  expect(a.getState().projectCollapseChoices).toEqual([]);
  a.getState().setProjectCollapsed("explicit-expanded", false);
  expect(a.getState().recentProjectIds).toEqual([]);
  expect(createUIChromeStore().getState().sidebarWidth).toBe(345);
  a.getState().selectProject("same-id");
  a.getState().setProjectFolderCollapsed("Folder", true);
  const aKey = desktopConnectionStorageKey("ui-project-storage", COMMAND_STORAGE_NODE);
  const b = visit("B");
  b.getState().selectProject("b-project");
  b.getState().setProjectCollapsed("same-id", true);
  expect(b.getState().collapsedProjectFolders).toEqual([]);
  expect(b.getState().projectCollapseChoices).not.toContain("explicit-expanded");
  expect(visit("A").getState().projectCollapseChoices).toContain("explicit-expanded");
  expect(visit("A").getState().recentProjectIds).toEqual(["same-id"]);
  expect(visit("A").getState().collapsedProjects).toEqual([]);
  expect(visit("A").getState().collapsedProjectFolders).toEqual(["Folder"]);
  expect(localStorage.getItem(aKey)).toContain("same-id");
  realmOn(null);
  const back = commandUI();
  expect(back.getState().recentProjectIds).toEqual(["command-project"]);
  expect(back.getState().collapsedProjects).toEqual(["same-id"]);
  expect(createUIChromeStore().getState().zoomLevel).toBe(120);
});

test("a project opens on its coordinator, but on its home on a leaf node", () => {
  window.orkestrator = undefined;
  delete window.orkestratorWorkspaceTarget;
  resetWindowScopeForTests();
  const command = getWindowScope().commandScope().store(uiStore);
  command.getState().setProjectBoardTab("kanban");
  command.getState().selectProject("command-project");
  expect(command.getState().projectBoardTab).toBe("coordinator");

  // A workspace realm document: the page shows a leaf.
  window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "leaf", path: "relay" } as never;
  resetWindowScopeForTests();
  const leaf = getWindowScope().commandScope().store(uiStore);
  expect(leaf.getState().projectBoardTab).toBe("home");
  leaf.getState().setProjectBoardTab("kanban");
  leaf.getState().selectProject("leaf-project");
  expect(leaf.getState().projectBoardTab).toBe("home");
});

test("a leaf scope's projects open on their home by its role, whatever the page is", () => {
  delete window.orkestratorWorkspaceTarget;
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
  delete window.orkestratorWorkspaceTarget;
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
  delete window.orkestratorWorkspaceTarget;
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
  delete window.orkestratorWorkspaceTarget;
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
