import {
  listProjectFolderNames,
  normalizeProjectFolderName,
  projectFolderKey,
  resolveProjectFolderName,
} from "@orkestrator/protocol/project-folders";
import type { Project } from "@/types";

export {
  listProjectFolderNames,
  normalizeProjectFolderName,
  projectFolderKey,
  resolveProjectFolderName,
};

/**
 * Sidebar grouping for projects.
 *
 * Folders are derived from the `folder` name each project carries rather than
 * stored as records of their own, so everything here is a pure function of the
 * project list. That is what lets a drag be resolved, previewed and persisted
 * as a single arrangement — an order plus the memberships that changed — with
 * no intermediate state for a client to observe.
 */

export interface ProjectFolderEntry {
  kind: "folder";
  /** Display name, spelled the way the folder's first member spells it. */
  name: string;
  /** Case-insensitive identity, and the suffix of this folder's drag id. */
  key: string;
  projects: Project[];
}

export interface ProjectLeafEntry {
  kind: "project";
  project: Project;
}

export type ProjectTreeEntry = ProjectFolderEntry | ProjectLeafEntry;

/** Drag ids for folders are namespaced so they cannot collide with a project id. */
export const PROJECT_FOLDER_ID_PREFIX = "project-folder:";

/**
 * Droppable covering the empty space below the list. Dropping here is the
 * gesture for "out of every folder, at the end" — without it, a sidebar whose
 * last entry is a folder would have no target that means the root level.
 */
export const PROJECT_ROOT_DROP_ID = "project-folder-root";

export function projectFolderDragId(name: string): string {
  return `${PROJECT_FOLDER_ID_PREFIX}${projectFolderKey(name)}`;
}

/** The folder key a drag id refers to, or null when the id is not a folder. */
export function parseProjectFolderDragId(id: string): string | null {
  return id.startsWith(PROJECT_FOLDER_ID_PREFIX) ? id.slice(PROJECT_FOLDER_ID_PREFIX.length) : null;
}

/**
 * Groups projects into the ordered sidebar tree.
 *
 * A folder appears at the position of its first member and collects every
 * later member, so members that are not adjacent in `order` still render as
 * one group. Input order is preserved otherwise.
 */
export function buildProjectTree(projects: readonly Project[]): ProjectTreeEntry[] {
  const entries: ProjectTreeEntry[] = [];
  const foldersByKey = new Map<string, ProjectFolderEntry>();
  for (const project of projects) {
    const folder = normalizeProjectFolderName(project.folder);
    if (!folder) {
      entries.push({ kind: "project", project });
      continue;
    }
    const key = projectFolderKey(folder);
    const existing = foldersByKey.get(key);
    if (existing) {
      existing.projects.push(project);
      continue;
    }
    const entry: ProjectFolderEntry = { kind: "folder", name: folder, key, projects: [project] };
    foldersByKey.set(key, entry);
    entries.push(entry);
  }
  return entries;
}

/**
 * The project order the tree actually renders.
 *
 * Grouping can move a project relative to its stored `order`, so every
 * arrangement is computed against this list rather than the raw one. Persisting
 * it also converges the stored order onto what the user sees.
 */
export function flattenProjectTree(entries: readonly ProjectTreeEntry[]): Project[] {
  const projects: Project[] = [];
  for (const entry of entries) {
    if (entry.kind === "project") projects.push(entry.project);
    else projects.push(...entry.projects);
  }
  return projects;
}

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
export function projectSortableIds(
  entries: readonly ProjectTreeEntry[],
  collapsedFolders: readonly string[],
): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "project") {
      ids.push(entry.project.id);
      continue;
    }
    ids.push(projectFolderDragId(entry.name));
    if (isProjectFolderCollapsed(collapsedFolders, entry.name)) continue;
    for (const project of entry.projects) ids.push(project.id);
  }
  return ids;
}

/** A full sidebar arrangement: the new order, plus memberships that changed. */
export interface ProjectArrangement {
  projectIds: string[];
  folders: Record<string, string | null>;
}

function folderOf(project: Project): string | null {
  return normalizeProjectFolderName(project.folder);
}

/** Case-insensitive folder identity, or null for a root-level project. */
function folderKeyOf(project: Project): string | null {
  const folder = folderOf(project);
  return folder === null ? null : projectFolderKey(folder);
}

function sameFolder(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return projectFolderKey(left) === projectFolderKey(right);
}

function arrangementOrNull(
  current: readonly Project[],
  next: readonly Project[],
  folders: Record<string, string | null>,
): ProjectArrangement | null {
  const orderChanged =
    current.length !== next.length ||
    current.some((project, index) => project.id !== next[index]?.id);
  if (!orderChanged && Object.keys(folders).length === 0) return null;
  return { projectIds: next.map((project) => project.id), folders };
}

function moveWithin(projects: readonly Project[], from: number, to: number): Project[] {
  const next = [...projects];
  const [removed] = next.splice(from, 1);
  if (!removed) return next;
  next.splice(to, 0, removed);
  return next;
}

/**
 * Resolves a sidebar drag into one arrangement.
 *
 * Returns null when the drop is a no-op, which is also how an unknown or
 * self-referential id is reported — the caller persists nothing rather than
 * writing an order it did not mean to change.
 */
export function resolveProjectArrangement(
  activeId: string,
  overId: string,
  projects: readonly Project[],
): ProjectArrangement | null {
  if (activeId === overId) return null;
  const entries = buildProjectTree(projects);
  const ordered = flattenProjectTree(entries);
  const activeFolderKey = parseProjectFolderDragId(activeId);

  if (activeFolderKey !== null) {
    return resolveFolderDrag(activeFolderKey, overId, entries, ordered);
  }

  const activeIndex = ordered.findIndex((project) => project.id === activeId);
  if (activeIndex === -1) return null;
  const active = ordered[activeIndex]!;

  if (overId === PROJECT_ROOT_DROP_ID) {
    const next = moveWithin(ordered, activeIndex, ordered.length - 1);
    const folders = sameFolder(folderOf(active), null) ? {} : { [activeId]: null };
    return arrangementOrNull(ordered, next, folders);
  }

  const overFolderKey = parseProjectFolderDragId(overId);
  if (overFolderKey !== null) {
    const folder = entries.find(
      (entry): entry is ProjectFolderEntry =>
        entry.kind === "folder" && entry.key === overFolderKey,
    );
    if (!folder) return null;
    // Land at the head of the folder. Dropping on the header is the gesture
    // for "into this folder" and must work while it is collapsed, when there
    // is no member row to aim at.
    const withoutActive = ordered.filter((project) => project.id !== activeId);
    const firstMember = folder.projects.find((project) => project.id !== activeId);
    const insertAt = firstMember
      ? withoutActive.findIndex((project) => project.id === firstMember.id)
      : withoutActive.length;
    const next = [...withoutActive];
    next.splice(insertAt === -1 ? next.length : insertAt, 0, active);
    const folders = sameFolder(folderOf(active), folder.name) ? {} : { [activeId]: folder.name };
    return arrangementOrNull(ordered, next, folders);
  }

  const overIndex = ordered.findIndex((project) => project.id === overId);
  if (overIndex === -1) return null;
  const over = ordered[overIndex]!;
  const next = moveWithin(ordered, activeIndex, overIndex);
  // The dragged project adopts the folder of the row it displaced, which is
  // what makes dropping onto a root project the way back out of a folder.
  const targetFolder = folderOf(over);
  const folders = sameFolder(folderOf(active), targetFolder) ? {} : { [activeId]: targetFolder };
  return arrangementOrNull(ordered, next, folders);
}

/** A folder moves as one block; its members keep their membership and order. */
function resolveFolderDrag(
  activeFolderKey: string,
  overId: string,
  entries: readonly ProjectTreeEntry[],
  ordered: readonly Project[],
): ProjectArrangement | null {
  const activeUnitIndex = entries.findIndex(
    (entry) => entry.kind === "folder" && entry.key === activeFolderKey,
  );
  if (activeUnitIndex === -1) return null;

  let overUnitIndex: number;
  if (overId === PROJECT_ROOT_DROP_ID) {
    overUnitIndex = entries.length - 1;
  } else {
    const overFolderKey = parseProjectFolderDragId(overId);
    overUnitIndex = entries.findIndex((entry) =>
      entry.kind === "folder"
        ? overFolderKey !== null && entry.key === overFolderKey
        : overFolderKey === null && entry.project.id === overId,
    );
    // A member of the dragged folder is not a position outside it.
    if (overUnitIndex === activeUnitIndex) return null;
  }
  if (overUnitIndex === -1) return null;

  const nextEntries = [...entries];
  const [removed] = nextEntries.splice(activeUnitIndex, 1);
  if (!removed) return null;
  nextEntries.splice(overUnitIndex, 0, removed);
  return arrangementOrNull(ordered, flattenProjectTree(nextEntries), {});
}

/**
 * Arrangement for the "Add to Folder" flow.
 *
 * A brand-new folder keeps the project exactly where it is, so the folder
 * appears in the slot the project occupied. Joining an existing folder moves
 * the project to the end of that folder's members instead, because a group's
 * rows have to be contiguous to be one group.
 */
export function resolveAddProjectToFolder(
  projects: readonly Project[],
  projectId: string,
  folderInput: string,
): ProjectArrangement | null {
  const name = resolveProjectFolderName(folderInput, projects);
  if (!name) return null;
  const ordered = flattenProjectTree(buildProjectTree(projects));
  const activeIndex = ordered.findIndex((project) => project.id === projectId);
  if (activeIndex === -1) return null;
  const active = ordered[activeIndex]!;

  const key = projectFolderKey(name);
  const members = ordered.filter(
    (project) => project.id !== projectId && folderKeyOf(project) === key,
  );
  const folders = sameFolder(folderOf(active), name) ? {} : { [projectId]: name };

  // A brand-new folder needs no move at all: the tree places it exactly where
  // its only member already sits, which is the "same location" the sidebar
  // showed the project in before.
  if (members.length === 0) return arrangementOrNull(ordered, ordered, folders);

  const withoutActive = ordered.filter((project) => project.id !== projectId);
  const lastMember = members[members.length - 1]!;
  const insertAt = withoutActive.findIndex((project) => project.id === lastMember.id) + 1;
  const next = [...withoutActive];
  next.splice(insertAt, 0, active);
  return arrangementOrNull(ordered, next, folders);
}

/** Arrangement that lifts one project back out to the root level. */
export function resolveRemoveProjectFromFolder(
  projects: readonly Project[],
  projectId: string,
): ProjectArrangement | null {
  const ordered = flattenProjectTree(buildProjectTree(projects));
  const active = ordered.find((project) => project.id === projectId);
  if (!active || folderOf(active) === null) return null;
  const next = buildProjectTree(
    ordered.map((project) => (project.id === projectId ? { ...project, folder: null } : project)),
  );
  return {
    projectIds: flattenProjectTree(next).map((project) => project.id),
    folders: { [projectId]: null },
  };
}

/** Arrangement that renames a folder by rewriting every member's name. */
export function resolveRenameProjectFolder(
  projects: readonly Project[],
  folderName: string,
  nextName: string,
): ProjectArrangement | null {
  const normalized = normalizeProjectFolderName(nextName);
  if (!normalized) return null;
  const fromKey = projectFolderKey(folderName);
  const members = projects.filter((project) => folderKeyOf(project) === fromKey);
  if (members.length === 0) return null;
  if (members.every((project) => project.folder === normalized)) return null;
  const folders: Record<string, string | null> = {};
  for (const project of members) folders[project.id] = normalized;
  const ordered = flattenProjectTree(
    buildProjectTree(
      projects.map((project) =>
        project.id in folders ? { ...project, folder: normalized } : project,
      ),
    ),
  );
  return { projectIds: ordered.map((project) => project.id), folders };
}

/** Arrangement that dissolves a folder, returning every member to the root. */
export function resolveUngroupProjectFolder(
  projects: readonly Project[],
  folderName: string,
): ProjectArrangement | null {
  const key = projectFolderKey(folderName);
  const folders: Record<string, string | null> = {};
  for (const project of projects) {
    if (folderKeyOf(project) === key) folders[project.id] = null;
  }
  if (Object.keys(folders).length === 0) return null;
  const ordered = flattenProjectTree(
    buildProjectTree(
      projects.map((project) => (project.id in folders ? { ...project, folder: null } : project)),
    ),
  );
  return { projectIds: ordered.map((project) => project.id), folders };
}
