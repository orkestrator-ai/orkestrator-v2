/**
 * The portal sidebar's cross-machine arrangement, kept on the command node.
 *
 * Every client of the command node shows the same order: which machine
 * comes first (the machine tiles, and the environment list ordered by
 * machine), where each machine's projects sit in the repository list, and the
 * hand-arranged ("Manual") environment order of each repository. Entries name
 * machines by node identity, projects and environments by their node-qualified
 * key, so identical IDs on two nodes never collide. A machine's own project,
 * folder and environment order stays with that machine; this only orders
 * things across machines.
 *
 * Entries for a node that is offline stay in place, so its projects return
 * to where they were when it reconnects.
 */

export const PORTAL_LAYOUT_CHANGED_EVENT = "portal-layout-changed";

export const MAX_PORTAL_LAYOUT_ENTRIES = 4096;
export const MAX_PORTAL_LAYOUT_ENTRY_LENGTH = 512;
/** Every repository's manual environment order together holds at most this many entries. */
export const MAX_ENVIRONMENT_ORDER_ENTRIES = 16384;
const MAX_FOLDER_NAME_LENGTH = 512;

export interface PortalLayout {
  /** Advances on every write. */
  revision: number;
  /** Node identities, first to last: the machine tiles and the by-machine environment order. */
  machineOrder: string[];
  /**
   * Project keys across machines, top to bottom; a folder sits at its first
   * member. The repository list's default order derives from it. Written by
   * the retired "by project" list (2.39), kept so its order is not lost.
   */
  projectOrder: string[];
  /**
   * A project's folder in `projectOrder` where it differs from the folder its
   * own machine files it under. `null` is the root level.
   */
  projectFolders: Record<string, string | null>;
  /** The repository list: project keys, top to bottom; a repository sits at its first member. */
  repositoryOrder: string[];
  /**
   * "Manual" environment order: per repository list entry (its repository
   * identity, or the project key of a project with none), environment keys top
   * to bottom. Absent from a layout written before 2.39.
   */
  environmentOrder: Record<string, string[]>;
  /** The command node supports saving one repository’s order. */
  manualOrderSupported?: true;
}

export type PortalLayoutUpdate = Partial<
  Omit<PortalLayout, "revision" | "environmentOrder" | "manualOrderSupported">
>;

export interface RepositoryEnvironmentOrderUpdate {
  repositoryKey: string;
  order: string[];
}

export function emptyPortalLayout(): PortalLayout {
  return {
    revision: 0,
    machineOrder: [],
    projectOrder: [],
    projectFolders: {},
    repositoryOrder: [],
    environmentOrder: {},
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

/** Lenient: bad keys and entries are dropped, and the total stays bounded. */
function readEnvironmentOrder(value: unknown): Record<string, string[]> {
  const order: Record<string, string[]> = {};
  if (!isRecord(value)) return order;
  let groups = 0;
  let total = 0;
  for (const [key, entries] of Object.entries(value)) {
    if (groups >= MAX_PORTAL_LAYOUT_ENTRIES || total >= MAX_ENVIRONMENT_ORDER_ENTRIES) break;
    if (!isEntry(key)) continue;
    const list = readEntries(entries).slice(0, MAX_ENVIRONMENT_ORDER_ENTRIES - total);
    if (list.length === 0) continue;
    Object.defineProperty(order, key, {
      value: list,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    groups += 1;
    total += list.length;
  }
  return order;
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
    environmentOrder: readEnvironmentOrder(value.environmentOrder),
    ...(value.manualOrderSupported === true ? { manualOrderSupported: true } : {}),
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

export function parseRepositoryEnvironmentOrderUpdate(
  value: unknown,
): RepositoryEnvironmentOrderUpdate {
  if (!isRecord(value) || !isEntry(value.repositoryKey)) {
    throw new Error("Expected a non-empty repository key.");
  }
  return {
    repositoryKey: value.repositoryKey,
    order: strictEntries(value.order, "environment order"),
  };
}

/** Apply one repository's order without evicting saved positions in any repository. */
export function applyRepositoryEnvironmentOrder(
  current: PortalLayout["environmentOrder"],
  { repositoryKey, order }: RepositoryEnvironmentOrderUpdate,
): PortalLayout["environmentOrder"] {
  const next = { ...current, [repositoryKey]: order };
  if (order.length === 0) delete next[repositoryKey];
  const groups = Object.values(next);
  if (
    groups.length > MAX_PORTAL_LAYOUT_ENTRIES ||
    groups.reduce((sum, entries) => sum + entries.length, 0) > MAX_ENVIRONMENT_ORDER_ENTRIES
  ) {
    throw new Error("The saved Manual order is full. Existing repository orders were kept.");
  }
  return next;
}
