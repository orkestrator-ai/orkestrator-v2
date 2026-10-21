import { afterEach, expect, test } from "bun:test";
import { createUIStore } from "./uiStore";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";
import { writeStoredWorkspace } from "@/lib/portal/workspace-target-storage";

const originalNative = window.orkestrator;
afterEach(() => {
  window.orkestrator = originalNative;
  delete window.orkestratorWorkspaceTarget;
  localStorage.clear();
  sessionStorage.clear();
});

test("cold stored leaf hydrates actual stores before gateway initialization and round trips independently", () => {
  window.orkestrator = undefined;
  delete window.orkestratorWorkspaceTarget;
  localStorage.clear();
  const command = createUIStore();
  command.getState().setProjectCollapsed("same-id", true);
  command.getState().selectProject("command-project");
  command.getState().setSidebarWidth(345);
  command.getState().setZoomLevel(120);
  const visit = (nodeId: string) => {
    writeStoredWorkspace({
      workspaceId: nodeId,
      nodeId: nodeId as never,
      nodeName: nodeId,
      path: "relay",
      baseUrl: "https://command.test/relay",
      expiresAt: Date.now() + 900000,
    });
    return createUIStore();
  };
  const a = visit("A");
  expect(a.getState().collapsedProjects).toEqual([]);
  expect(a.getState().recentProjectIds).toEqual([]);
  expect(a.getState().sidebarWidth).toBe(345);
  a.getState().selectProject("same-id");
  a.getState().setProjectFolderCollapsed("Folder", true);
  const aKey = desktopConnectionStorageKey("ui-project-storage");
  const b = visit("B");
  b.getState().selectProject("b-project");
  b.getState().setProjectCollapsed("same-id", true);
  expect(b.getState().collapsedProjectFolders).toEqual([]);
  expect(visit("A").getState().recentProjectIds).toEqual(["same-id"]);
  expect(visit("A").getState().collapsedProjects).toEqual([]);
  expect(visit("A").getState().collapsedProjectFolders).toEqual(["Folder"]);
  expect(localStorage.getItem(aKey)).toContain("same-id");
  writeStoredWorkspace(null);
  const back = createUIStore();
  expect(back.getState().recentProjectIds).toEqual(["command-project"]);
  expect(back.getState().collapsedProjects).toEqual(["same-id"]);
  expect(back.getState().zoomLevel).toBe(120);
});
