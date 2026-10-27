import { afterEach, expect, test } from "bun:test";
import { createUIStore } from "./uiStore";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";
import { writeRealmWorkspace } from "@/lib/portal/workspace-target-storage";
import { portalStore } from "@/lib/portal/portal-store";

const originalNative = window.orkestrator;
const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
const originalHref = window.location.href;
const originalPortal = portalStore.getState();

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

afterEach(() => {
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
  const command = createUIStore();
  command.getState().setProjectCollapsed("same-id", true);
  command.getState().selectProject("command-project");
  command.getState().setSidebarWidth(345);
  command.getState().setZoomLevel(120);
  const visit = (nodeId: string) => {
    realmOn(nodeId);
    return createUIStore();
  };
  const a = visit("A");
  expect(a.getState().collapsedProjects).toEqual([]);
  expect(a.getState().projectCollapseChoices).toEqual([]);
  a.getState().setProjectCollapsed("explicit-expanded", false);
  expect(a.getState().recentProjectIds).toEqual([]);
  expect(a.getState().sidebarWidth).toBe(345);
  a.getState().selectProject("same-id");
  a.getState().setProjectFolderCollapsed("Folder", true);
  const aKey = desktopConnectionStorageKey("ui-project-storage");
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
  const back = createUIStore();
  expect(back.getState().recentProjectIds).toEqual(["command-project"]);
  expect(back.getState().collapsedProjects).toEqual(["same-id"]);
  expect(back.getState().zoomLevel).toBe(120);
});

test("a project opens on its coordinator, but on its home on a leaf node", () => {
  window.orkestrator = undefined;
  delete window.orkestratorWorkspaceTarget;
  const command = createUIStore();
  command.getState().setProjectBoardTab("kanban");
  command.getState().selectProject("command-project");
  expect(command.getState().projectBoardTab).toBe("coordinator");

  window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "leaf", path: "relay" } as never;
  const leaf = createUIStore();
  expect(leaf.getState().projectBoardTab).toBe("home");
  leaf.getState().setProjectBoardTab("kanban");
  leaf.getState().selectProject("leaf-project");
  expect(leaf.getState().projectBoardTab).toBe("home");
});

test("directly connected leaf nodes default to Home when a project is selected", () => {
  delete window.orkestratorWorkspaceTarget;
  const direct = createUIStore();
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
  const initial = createUIStore();
  expect(initial.getState().multiReviewGraphHeight).toBeNull();
  initial.getState().setMultiReviewGraphHeight(420);
  const reloaded = createUIStore();
  expect(reloaded.getState().multiReviewGraphHeight).toBe(420);
  reloaded.getState().setMultiReviewGraphHeight(null);
  expect(createUIStore().getState().multiReviewGraphHeight).toBeNull();
});

test("the data-saving preference is off by default and survives a reload", () => {
  localStorage.clear();
  const initial = createUIStore();
  expect(initial.getState().dataSaving).toBe(false);
  initial.getState().setDataSaving(true);
  expect(createUIStore().getState().dataSaving).toBe(true);
  createUIStore().getState().setDataSaving(false);
  expect(createUIStore().getState().dataSaving).toBe(false);
});
