import { useEffect, useRef } from "react";
import { projectKey, projectRef, type BackendId } from "@orkestrator/protocol/federation";
import { projectFolderKey } from "@/lib/project-folders";
import { sidebarFolderKey, useMachineViewStore } from "@/stores/machineViewStore";
import { useUIStore } from "@/stores/uiStore";
import type { Project } from "@/types";

/**
 * Keeps this window's own machine's collapsed projects and folders (the
 * workspace's `uiStore`, by local ID and folder name) in step with the
 * multi-machine sidebar's record (by machine-qualified key, kept with the
 * window). When the window moves to another node, the node it left is drawn
 * from that record and the node it arrives on adopts it, so nothing in the
 * sidebar opens or closes because of the move.
 */
export function useBoundCollapseSync(
  backendId: BackendId | null,
  projects: readonly Project[],
  loaded: boolean,
): void {
  const adopted = useRef<string | null>(null);

  useEffect(() => {
    if (!backendId || !loaded) return;
    const folderPrefix = sidebarFolderKey(backendId, "");
    const keyOf = (projectId: string) => projectKey(projectRef(backendId, projectId));

    if (adopted.current !== backendId) {
      adopted.current = backendId;
      const view = useMachineViewStore.getState();
      // A machine never recorded yet keeps the state it already has.
      if (view.seededMachines.includes(backendId)) {
        const collapsed = new Set(view.collapsedProjectKeys);
        const ids = new Set(projects.map((project) => project.id));
        const ui = useUIStore.getState();
        useUIStore.setState({
          collapsedProjects: [
            ...ui.collapsedProjects.filter((id) => !ids.has(id)),
            ...projects.filter((project) => collapsed.has(keyOf(project.id))).map((p) => p.id),
          ],
          collapsedProjectFolders: view.collapsedFolderKeys
            .filter((key) => key.startsWith(folderPrefix))
            .map((key) => key.slice(folderPrefix.length)),
        });
      }
    }

    const record = () => {
      const ui = useUIStore.getState();
      const ids = new Set(projects.map((project) => project.id));
      useMachineViewStore.getState().setMachineCollapseState(backendId, {
        projectKeys: projects.map((project) => keyOf(project.id)),
        collapsedProjectKeys: ui.collapsedProjects.filter((id) => ids.has(id)).map(keyOf),
        folderPrefix,
        collapsedFolderKeys: ui.collapsedProjectFolders.map((name) =>
          sidebarFolderKey(backendId, projectFolderKey(name)),
        ),
      });
    };
    record();
    return useUIStore.subscribe((state, previous) => {
      if (
        state.collapsedProjects !== previous.collapsedProjects ||
        state.collapsedProjectFolders !== previous.collapsedProjectFolders
      ) {
        record();
      }
    });
  }, [backendId, loaded, projects]);
}
