import { useCallback } from "react";
import { projectFolderKey } from "@/lib/project-folders";
import { ALL_MACHINES, type MachineView } from "@/lib/federation/aggregate";
import {
  isMachineShown,
  mergedProjectList,
  repositoryProjectList,
} from "@/lib/federation/sidebar-layout";
import { usePortalLayout } from "@/lib/portal/portal-layout";
import { sidebarFolderKey, useMachineViewStore } from "@/stores/machineViewStore";
import { useUIStore } from "@/stores/uiStore";
import { useFederation } from "./FederationProvider";
import { useMachineViews } from "./useMachineViews";

/**
 * Selects another machine's project in the sidebar, as choosing one of this
 * machine's projects in the search does: it is recorded as recently used,
 * its machine section, folder and project are expanded wherever the sidebar
 * shows it, a machine filter that hides it is cleared, and the row is
 * highlighted and scrolled into view. Nothing is opened, and nothing is
 * written to the machine or to this window's workspace stores.
 *
 * Where the current layout cannot show the project (sorted by activity, or a
 * merged list hiding its disconnected machine), selection switches to the
 * by-machine project view, which keeps a machine's last-known projects.
 */
export function useRevealMachineProject(): (machine: MachineView, projectId: string) => void {
  const machines = useMachineViews();
  const layout = usePortalLayout();
  const { portalState } = useFederation();
  const selfId = portalState.selfId;

  return useCallback(
    (machine: MachineView, projectId: string) => {
      const project = machine.projects.find((entry) => entry.ref.projectId === projectId);
      if (!project) return;
      const views = useMachineViewStore.getState();
      views.recordRecent([project.key]);
      if (views.machineFilter !== ALL_MACHINES && views.machineFilter !== machine.connectionId) {
        views.setMachineFilter(ALL_MACHINES);
      }
      views.setMachineCollapsed(machine.connectionId, false);
      views.setProjectKeyCollapsed(project.key, false);
      if (project.folder) {
        views.setFolderKeyCollapsed(
          sidebarFolderKey(machine.backendId, projectFolderKey(project.folder)),
          false,
        );
      }
      // The merged lists keep their own folders (and repository groups).
      const shownIds = new Set(
        machines.filter(isMachineShown).map((candidate) => candidate.connectionId),
      );
      const merged = mergedProjectList(machines, shownIds, layout, selfId).shown.find(
        (item) => item.id === project.key,
      );
      if (merged?.folder) {
        views.setFolderKeyCollapsed(
          sidebarFolderKey("project", projectFolderKey(merged.folder)),
          false,
        );
      }
      const repository = repositoryProjectList(machines, shownIds, layout, selfId).shown.find(
        (item) => item.id === project.key,
      );
      if (repository?.folder) {
        views.setFolderKeyCollapsed(sidebarFolderKey("repository", repository.folder), false);
      }
      views.revealProject(project.key);

      const ui = useUIStore.getState();
      const shownHere =
        ui.environmentSortMode !== "activity" &&
        (views.grouping === "machine" || isMachineShown(machine));
      if (!shownHere) {
        ui.setEnvironmentSortMode("project");
        views.setGrouping("machine");
      }
    },
    [layout, machines, selfId],
  );
}
