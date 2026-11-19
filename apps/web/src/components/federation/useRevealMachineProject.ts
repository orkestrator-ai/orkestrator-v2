import { useCallback } from "react";
import { shownMachineIds, type MachineView } from "@/lib/federation/aggregate";
import { repositoryGroupKey } from "@/lib/federation/environment-list";
import { sidebarFolderKey, useMachineViewStore } from "@/stores/machineViewStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { useMachineViews } from "./useMachineViews";

/** Where the repository list keeps a repository's collapsed state. */
export function repositoryCollapseKey(groupKey: string): string {
  return sidebarFolderKey("repository", groupKey);
}

/** Expands a project's repository and clears a filter that hides its machine, without changing the view or selection. */
export function useExpandMachineProject(): (machine: MachineView, projectId: string) => void {
  const machines = useMachineViews();
  return useCallback(
    (machine: MachineView, projectId: string) => {
      const project = machine.projects.find((entry) => entry.ref.projectId === projectId);
      if (!project) return;
      const views = useMachineViewStore.getState();
      if (!shownMachineIds(machines, views.machineFilter).has(machine.connectionId)) {
        views.setMachineFilter([]);
      }
      views.setFolderKeyCollapsed(repositoryCollapseKey(repositoryGroupKey(project)), false);
    },
    [machines],
  );
}

/**
 * Selects another machine's project in the sidebar, as choosing one of this
 * machine's projects in the search does: it is recorded as recently used, its
 * repository is expanded, a machine filter that hides it is cleared, and its
 * repository heading is highlighted and scrolled into view (the list hides a
 * machine that is not connected, so its projects have no heading to
 * highlight until it reconnects). Nothing is opened, and nothing is written
 * to the machine or to this window's workspace stores.
 *
 * Sorted by activity, or in compact, the sidebar returns to the repository
 * list, where the heading is.
 */
export function useRevealMachineProject(): (machine: MachineView, projectId: string) => void {
  const expand = useExpandMachineProject();
  return useCallback(
    (machine: MachineView, projectId: string) => {
      const project = machine.projects.find((entry) => entry.ref.projectId === projectId);
      if (!project) return;
      expand(machine, projectId);
      const views = useMachineViewStore.getState();
      views.recordRecent([project.key]);
      views.revealProject(project.key);
      const chrome = useUIChromeStore.getState();
      if (chrome.environmentSortMode === "activity") chrome.setEnvironmentSortMode("project");
      if (views.grouping === "compact") views.setGrouping("repository");
    },
    [expand],
  );
}
