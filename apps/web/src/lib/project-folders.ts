import {
  listProjectFolderNames,
  normalizeProjectFolderName,
  projectFolderKey,
  resolveProjectFolderName,
} from "@orkestrator/protocol/project-folders";
import {
  PROJECT_FOLDER_ID_PREFIX,
  PROJECT_ROOT_DROP_ID,
  buildProjectTree,
  flattenProjectTree,
  mapProjectArrangementIntentIds,
  parseProjectFolderDragId,
  projectFolderDragId,
  resolveAddProjectToFolder,
  resolveProjectArrangement,
  resolveProjectArrangementIntent,
  resolveRemoveProjectFromFolder,
  resolveRenameProjectFolder,
  resolveSortProjectFolder,
  resolveUngroupProjectFolder,
  type ArrangeableProject,
  type ProjectArrangement,
  type ProjectArrangementIntent,
  type ProjectFolderEntry as GenericFolderEntry,
  type ProjectLeafEntry as GenericLeafEntry,
} from "@orkestrator/protocol/project-arrangement";
import type { Project } from "@/types";

export {
  PROJECT_FOLDER_ID_PREFIX,
  PROJECT_ROOT_DROP_ID,
  buildProjectTree,
  flattenProjectTree,
  listProjectFolderNames,
  mapProjectArrangementIntentIds,
  normalizeProjectFolderName,
  parseProjectFolderDragId,
  projectFolderDragId,
  projectFolderKey,
  resolveAddProjectToFolder,
  resolveProjectArrangement,
  resolveProjectArrangementIntent,
  resolveProjectFolderName,
  resolveRemoveProjectFromFolder,
  resolveRenameProjectFolder,
  resolveSortProjectFolder,
  resolveUngroupProjectFolder,
};
export type { ArrangeableProject, ProjectArrangement, ProjectArrangementIntent };

/**
 * Sidebar grouping for projects.
 *
 * Folders are derived from the `folder` name each project carries rather than
 * stored as records of their own, so everything here is a pure function of the
 * project list. The arrangement logic itself lives in
 * `@orkestrator/protocol/project-arrangement`, shared with the backend that
 * resolves a gesture against its current projects.
 */

export type ProjectFolderEntry<P = Project> = GenericFolderEntry<P>;
export type ProjectLeafEntry<P = Project> = GenericLeafEntry<P>;
export type ProjectTreeEntry<P = Project> = ProjectFolderEntry<P> | ProjectLeafEntry<P>;

export function isProjectFolderCollapsed(
  collapsedFolders: readonly string[],
  name: string,
): boolean {
  const key = projectFolderKey(name);
  return collapsedFolders.some((candidate) => projectFolderKey(candidate) === key);
}

/**
 * Drag ids in visible order.
 *
 * A collapsed folder contributes only its own id: its members are not
 * rendered, so offering them as sortable targets would let a drop resolve
 * against a row the user cannot see.
 */
export function projectSortableIds<P extends Pick<Project, "id"> = Project>(
  entries: readonly ProjectTreeEntry<P>[],
  collapsedFolders: readonly string[],
  isCollapsed: (name: string) => boolean = (name) =>
    isProjectFolderCollapsed(collapsedFolders, name),
): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "project") {
      ids.push(entry.project.id);
      continue;
    }
    ids.push(projectFolderDragId(entry.name));
    if (isCollapsed(entry.name)) continue;
    for (const project of entry.projects) ids.push(project.id);
  }
  return ids;
}
