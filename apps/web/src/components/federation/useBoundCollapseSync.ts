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
  const adopted = useRef({ backendId, keys: new Set<string>() });

  useEffect(() => {
    if (!backendId || !loaded) return;
    if (adopted.current.backendId !== backendId) adopted.current = { backendId, keys: new Set() };
    const folderPrefix = sidebarFolderKey(backendId, "");
    const keyOf = (projectId: string) => projectKey(projectRef(backendId, projectId));
    const view = useMachineViewStore.getState();
    const ui = useUIStore.getState();
    const fresh = projects.filter((project) => !adopted.current.keys.has(keyOf(project.id)));
    const known = new Set([...view.knownProjectKeys, ...view.collapsedProjectKeys]);
    const adopting = fresh.filter((project) => known.has(keyOf(project.id)));
    for (const project of fresh) adopted.current.keys.add(keyOf(project.id));
    const ids = new Set(adopting.map((project) => project.id));
    const folders = new Set(
      [...view.knownFolderKeys, ...view.collapsedFolderKeys]
        .filter((key) => key.startsWith(folderPrefix))
        .map((key) => key.slice(folderPrefix.length)),
    );
    useUIStore.setState({
      projectCollapseChoices: Array.from(new Set([...ui.projectCollapseChoices, ...ids])),
      collapsedProjects: [
        ...ui.collapsedProjects.filter((id) => !ids.has(id)),
        ...adopting
          .filter((project) => view.collapsedProjectKeys.includes(keyOf(project.id)))
          .map((p) => p.id),
      ],
      collapsedProjectFolders: Array.from(
        new Set([
          ...ui.collapsedProjectFolders.filter((name) => !folders.has(projectFolderKey(name))),
          ...view.collapsedFolderKeys
            .filter((key) => key.startsWith(folderPrefix))
            .map((key) => key.slice(folderPrefix.length)),
        ]),
      ),
    });

    const record = () => {
      const ui = useUIStore.getState();
      const ids = new Set(
        projects
          .filter(
            (p) => ui.projectCollapseChoices.includes(p.id) || ui.collapsedProjects.includes(p.id),
          )
          .map((p) => p.id),
      );
      useMachineViewStore.getState().setMachineCollapseState(backendId, {
        projectKeys: Array.from(ids, keyOf),
        collapsedProjectKeys: ui.collapsedProjects.filter((id) => ids.has(id)).map(keyOf),
        folderPrefix,
        folderKeys: projects.flatMap((p) =>
          p.folder ? [sidebarFolderKey(backendId, projectFolderKey(p.folder))] : [],
        ),
        collapsedFolderKeys: ui.collapsedProjectFolders.map((name) =>
          sidebarFolderKey(backendId, projectFolderKey(name)),
        ),
      });
    };
    record();
    return useUIStore.subscribe((state, previous) => {
      if (
        state.collapsedProjects !== previous.collapsedProjects ||
        state.projectCollapseChoices !== previous.projectCollapseChoices ||
        state.collapsedProjectFolders !== previous.collapsedProjectFolders
      )
        record();
    });
  }, [backendId, loaded, projects]);
}
