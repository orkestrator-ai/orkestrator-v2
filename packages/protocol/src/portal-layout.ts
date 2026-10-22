/**
 * The portal sidebar's cross-machine arrangement, kept on the command node.
 *
 * Every client of the command node shows the same order: which machine
 * comes first ("by machine"), and where each machine's projects sit in the
 * merged "by project" and "by repository" lists. Entries name machines by
 * node identity and projects by their node-qualified key, so identical IDs on
 * two nodes never collide. A machine's own project, folder and environment
 * order stays with that machine; this only orders things across machines.
 *
 * Entries for a node that is offline stay in place, so its projects return
 * to where they were when it reconnects.
 */

export const PORTAL_LAYOUT_CHANGED_EVENT = "portal-layout-changed";

export const MAX_PORTAL_LAYOUT_ENTRIES = 4096;
export const MAX_PORTAL_LAYOUT_ENTRY_LENGTH = 512;
const MAX_FOLDER_NAME_LENGTH = 512;

export interface PortalLayout {
  /** Advances on every write. */
  revision: number;
  /** "By machine": node identities, top to bottom. */
  machineOrder: string[];
  /** "By project": project keys, top to bottom; a folder sits at its first member. */
  projectOrder: string[];
  /**
   * "By project": a project's folder in the merged list where it differs from
   * the folder its own machine files it under. `null` is the root level.
   */
  projectFolders: Record<string, string | null>;
  /** "By repository": project keys, top to bottom; a group sits at its first member. */
  repositoryOrder: string[];
}

export type PortalLayoutUpdate = Partial<Omit<PortalLayout, "revision">>;

export function emptyPortalLayout(): PortalLayout {
  return {
    revision: 0,
    machineOrder: [],
    projectOrder: [],
    projectFolders: {},
    repositoryOrder: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEntry(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_PORTAL_LAYOUT_ENTRY_LENGTH
  );
}

/** Unique, bounded entries; anything else is dropped rather than failing the list. */
function readEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (seen.size >= MAX_PORTAL_LAYOUT_ENTRIES) break;
    if (isEntry(entry)) seen.add(entry);
  }
  return Array.from(seen);
}

function readFolders(value: unknown): Record<string, string | null> {
  const folders: Record<string, string | null> = {};
  if (!isRecord(value)) return folders;
  let count = 0;
  for (const [key, folder] of Object.entries(value)) {
    if (count >= MAX_PORTAL_LAYOUT_ENTRIES) break;
    if (!isEntry(key)) continue;
    if (
      folder === null ||
      (typeof folder === "string" && folder.length <= MAX_FOLDER_NAME_LENGTH)
    ) {
      folders[key] = folder;
      count += 1;
    }
  }
  return folders;
}

/** Lenient reader for a stored or served layout. */
export function parsePortalLayout(value: unknown): PortalLayout {
  if (!isRecord(value)) return emptyPortalLayout();
  return {
    revision:
      typeof value.revision === "number" &&
      Number.isSafeInteger(value.revision) &&
      value.revision > 0
        ? value.revision
        : 0,
    machineOrder: readEntries(value.machineOrder),
    projectOrder: readEntries(value.projectOrder),
    projectFolders: readFolders(value.projectFolders),
    repositoryOrder: readEntries(value.repositoryOrder),
  };
}

function strictEntries(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} to be an array.`);
  if (value.length > MAX_PORTAL_LAYOUT_ENTRIES) {
    throw new Error(`Expected at most ${MAX_PORTAL_LAYOUT_ENTRIES} ${label} entries.`);
  }
  for (const entry of value) {
    if (!isEntry(entry)) throw new Error(`Expected ${label} entries to be non-empty strings.`);
  }
  return Array.from(new Set(value as string[]));
}

/** Strict reader for an `update_portal_layout` request. */
export function parsePortalLayoutUpdate(value: unknown): PortalLayoutUpdate {
  if (!isRecord(value)) throw new Error("Expected the layout update to be an object.");
  const allowed = new Set(["machineOrder", "projectOrder", "projectFolders", "repositoryOrder"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unexpected layout field: ${key.slice(0, 64)}`);
  }
  const update: PortalLayoutUpdate = {};
  if (value.machineOrder !== undefined) {
    update.machineOrder = strictEntries(value.machineOrder, "machineOrder");
  }
  if (value.projectOrder !== undefined) {
    update.projectOrder = strictEntries(value.projectOrder, "projectOrder");
  }
  if (value.repositoryOrder !== undefined) {
    update.repositoryOrder = strictEntries(value.repositoryOrder, "repositoryOrder");
  }
  if (value.projectFolders !== undefined) {
    if (!isRecord(value.projectFolders))
      throw new Error("Expected projectFolders to be an object.");
    const entries = Object.entries(value.projectFolders);
    if (entries.length > MAX_PORTAL_LAYOUT_ENTRIES) {
      throw new Error(`Expected at most ${MAX_PORTAL_LAYOUT_ENTRIES} projectFolders entries.`);
    }
    const folders: Record<string, string | null> = {};
    for (const [key, folder] of entries) {
      if (!isEntry(key)) throw new Error("Expected projectFolders keys to be project keys.");
      if (
        folder !== null &&
        (typeof folder !== "string" || folder.length > MAX_FOLDER_NAME_LENGTH)
      ) {
        throw new Error("Expected projectFolders values to be folder names or null.");
      }
      folders[key] = folder;
    }
    update.projectFolders = folders;
  }
  return update;
}
