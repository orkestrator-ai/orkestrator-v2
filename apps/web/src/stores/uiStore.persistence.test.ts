import { afterEach, expect, test } from "bun:test";
import { createUIStore } from "./uiStore";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";
import { writeRealmWorkspace } from "@/lib/portal/workspace-target-storage";

const originalNative = window.orkestrator;
const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
const originalHref = window.location.href;

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
