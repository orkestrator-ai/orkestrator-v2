/**
 * The portal sidebar's cross-machine order.
 *
 * The command node stores where machines and their projects sit
 * (`@orkestrator/protocol/portal-layout`); this module turns that stored
 * order and the machines' own orders into what the sidebar shows (the
 * machine tiles, the repository list, compact), and a drag back into the next
 * stored order. The repository list's environment order is in
 * `environment-list.ts`. Everything here is pure.
 *
 * - Anything the stored order does not name yet (a new machine, a new
 *   project) goes after whatever precedes it in the default order, so the
 *   command node comes first and every other machine's projects follow below
 *   it, each in its own machine's order with its folders intact.
 * - A machine that is not connected, or filtered out, keeps its entries: a
 *   drag only rearranges the entries that are shown, in the slots they
 *   occupy, so hidden projects return to where they were.
 */

import { MAX_PORTAL_LAYOUT_ENTRIES, type PortalLayout } from "@orkestrator/protocol/portal-layout";
import { parseProjectKey } from "@orkestrator/protocol/federation";
import {
  buildProjectTree,
  flattenProjectTree,
  normalizeProjectFolderName,
  type ProjectTreeEntry,
  type ProjectArrangement,
} from "@/lib/project-folders";
import type { MachineView } from "./aggregate";
import type { FederatedProject } from "./summaries";

/**
 * `stored` with every entry of `defaults` it lacks, each placed right after
 * the entry that precedes it in `defaults` (or first, when nothing does).
 * Stored entries keep their order, including ones `defaults` no longer has.
 */
export function mergeOrder(stored: readonly string[], defaults: readonly string[]): string[] {
  const result = [...stored];
  const present = new Set(stored);
  let anchor = -1;
  for (const id of defaults) {
    if (present.has(id)) {
      anchor = result.indexOf(id);
      continue;
    }
    anchor += 1;
    result.splice(anchor, 0, id);
    present.add(id);
  }
  return result;
}

/**
 * `full` with the entries of `shownNext` rearranged, in that order, into the
 * slots the shown entries occupy. Every other entry keeps its slot. Entries of
 * `shownNext` that `full` lacks go at the end.
 */
export function placeShown(full: readonly string[], shownNext: readonly string[]): string[] {
  const shown = new Set(shownNext);
  const queue = [...shownNext];
  const result: string[] = [];
  for (const id of full) result.push(shown.has(id) ? queue.shift()! : id);
  return Array.from(new Set([...result, ...queue]));
}

/** Moves `activeId` to where `overId` is, or null for a no-op drop. */
export function moveEntry(
  ids: readonly string[],
  activeId: string,
  overId: string,
): string[] | null {
  if (activeId === overId) return null;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

/** Projects of a machine that is not connected are hidden from the merged lists. */
export function isMachineShown(machine: MachineView): boolean {
  return machine.bound || machine.transport === "connected";
}

/** Its summaries are complete, so a missing project really is gone. */
function isMachineComplete(machine: MachineView): boolean {
  return isMachineShown(machine) && !machine.truncated && machine.loadedAt !== null;
}

/** The command node first, then every other machine in the order given. */
export function defaultMachineOrder(
  machines: readonly Pick<MachineView, "connectionId">[],
  commandNodeId: string | null,
): string[] {
  const ids = machines.map((machine) => machine.connectionId);
  if (!commandNodeId || !ids.includes(commandNodeId)) return ids;
  return [commandNodeId, ...ids.filter((id) => id !== commandNodeId)];
}

/** Machines in the command node's registry order, so which one is this window's never moves it. */
export function registryOrder<M extends MachineView>(
  machines: readonly M[],
  registry: readonly string[],
): M[] {
  const position = new Map(registry.map((id, index) => [id, index]));
  return [...machines].sort(
    (left, right) =>
      (position.get(left.connectionId) ?? Number.MAX_SAFE_INTEGER) -
      (position.get(right.connectionId) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Every machine's entry in the stored machine order, plus any not stored yet. */
export function machineOrder(
  machines: readonly Pick<MachineView, "connectionId">[],
  layout: Pick<PortalLayout, "machineOrder">,
  commandNodeId: string | null,
): string[] {
  return mergeOrder(layout.machineOrder, defaultMachineOrder(machines, commandNodeId));
}

/**
 * `items` as the machine lists outside the sidebar show them: the command node
 * always first, then the stored machine order. Anything the stored order does
 * not name yet goes after whatever precedes it in `items`.
 */
export function inMachineOrder<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  stored: readonly string[],
  commandNodeId: string | null,
): T[] {
  const position = new Map(mergeOrder(stored, items.map(idOf)).map((id, index) => [id, index]));
  const rank = (item: T) => {
    const id = idOf(item);
    return id === commandNodeId ? -1 : (position.get(id) ?? Number.MAX_SAFE_INTEGER);
  };
  return [...items].sort((left, right) => rank(left) - rank(right));
}

/** `machines` in the stored machine order. */
export function orderMachines<M extends MachineView>(
  machines: readonly M[],
  layout: Pick<PortalLayout, "machineOrder">,
  commandNodeId: string | null,
): M[] {
  const position = new Map(
    machineOrder(machines, layout, commandNodeId).map((id, index) => [id, index]),
  );
  return [...machines].sort(
    (left, right) =>
      (position.get(left.connectionId) ?? Number.MAX_SAFE_INTEGER) -
      (position.get(right.connectionId) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** The next stored machine order after dragging one shown machine (a tile, or a Settings row) onto another. */
export function arrangeMachines(
  machines: readonly Pick<MachineView, "connectionId">[],
  shown: readonly Pick<MachineView, "connectionId">[],
  layout: Pick<PortalLayout, "machineOrder">,
  commandNodeId: string | null,
  activeId: string,
  overId: string,
): string[] | null {
  const next = moveEntry(
    shown.map((machine) => machine.connectionId),
    activeId,
    overId,
  );
  if (!next) return null;
  const known = new Set(machines.map((machine) => machine.connectionId));
  // A forgotten machine's entry goes with it.
  return bounded(
    placeShown(machineOrder(machines, layout, commandNodeId), next).filter((id) => known.has(id)),
  );
}

/** One project in a merged list, with the folder or group it sits under there. */
export interface MergedProject {
  /** The node-qualified project key; also its drag id. */
  id: string;
  name: string;
  folder: string | null;
  machine: MachineView;
  project: FederatedProject;
}

/** A machine's projects in its own sidebar order, folders kept together. */
function machineProjectsInOrder(machine: MachineView): FederatedProject[] {
  return flattenProjectTree(
    buildProjectTree([...machine.projects].sort((left, right) => left.order - right.order)),
  );
}

function projectsByKey(machines: readonly MachineView[]): Map<string, MergedProject> {
  const byKey = new Map<string, MergedProject>();
  for (const machine of machines) {
    for (const project of machine.projects) {
      byKey.set(project.key, {
        id: project.key,
        name: project.name,
        folder: normalizeProjectFolderName(project.folder),
        machine,
        project,
      });
    }
  }
  return byKey;
}

export interface MergedList {
  /** The whole stored order this list was built from, hidden entries included. */
  full: string[];
  /** The shown projects, in order. */
  shown: MergedProject[];
}

/**
 * Every machine's projects in one list (`projectOrder`, last arranged by the
 * retired "by project" list), which the repository order defaults to.
 * `machines` are all known machines in machine order; `shownIds` are those
 * whose projects are shown (connected and not filtered out). Until the user
 * arranges the list, the command node's projects come first and the others
 * follow in machine order.
 */
export function mergedProjectList(
  machines: readonly MachineView[],
  shownIds: ReadonlySet<string>,
  layout: Pick<PortalLayout, "projectOrder" | "projectFolders">,
  commandNodeId: string | null,
): MergedList {
  const first = machines.filter((machine) => machine.backendId === commandNodeId);
  const defaults = [
    ...first,
    ...machines.filter((machine) => machine.backendId !== commandNodeId),
  ].flatMap((machine) => machineProjectsInOrder(machine).map((project) => project.key));
  const full = mergeOrder(layout.projectOrder, defaults);
  const byKey = projectsByKey(machines);
  const shown: MergedProject[] = [];
  for (const id of full) {
    const entry = byKey.get(id);
    if (!entry || !shownIds.has(entry.machine.connectionId)) continue;
    shown.push(
      Object.hasOwn(layout.projectFolders, id)
        ? { ...entry, folder: normalizeProjectFolderName(layout.projectFolders[id]) }
        : entry,
    );
  }
  return { full, shown };
}

/**
 * The repository list: the same projects, grouped by the repository their own
 * machine reports, in the default project order until the user arranges them.
 */
export function repositoryProjectList(
  machines: readonly MachineView[],
  shownIds: ReadonlySet<string>,
  layout: Pick<PortalLayout, "projectOrder" | "projectFolders" | "repositoryOrder">,
  commandNodeId: string | null,
): MergedList {
  const everything = mergedProjectList(
    machines,
    new Set(machines.map((machine) => machine.connectionId)),
    layout,
    commandNodeId,
  );
  // The default project order: a folder's members sit together.
  const defaults = flattenProjectTree(buildProjectTree(everything.shown)).map(
    (project) => project.id,
  );
  const full = mergeOrder(layout.repositoryOrder, defaults);
  const byKey = projectsByKey(machines);
  const shown: MergedProject[] = [];
  for (const id of full) {
    const entry = byKey.get(id);
    if (!entry || !shownIds.has(entry.machine.connectionId)) continue;
    shown.push({ ...entry, folder: entry.project.repositoryHint ?? null });
  }
  return { full, shown };
}

/** Drops entries of forgotten machines and of projects their (complete) machine no longer has. */
function prune(ids: readonly string[], machines: readonly MachineView[]): string[] {
  const byId = new Map<string, MachineView>(
    machines.map((machine) => [machine.backendId, machine]),
  );
  const existing = new Set(machines.flatMap((machine) => machine.projects.map((p) => p.key)));
  return ids.filter((id) => {
    const ref = parseProjectKey(id);
    const machine = ref ? byId.get(ref.backendId) : undefined;
    if (!machine) return false;
    return existing.has(id) || !isMachineComplete(machine);
  });
}

function bounded(ids: string[]): string[] {
  return ids.length > MAX_PORTAL_LAYOUT_ENTRIES ? ids.slice(0, MAX_PORTAL_LAYOUT_ENTRIES) : ids;
}

/**
 * The next stored repository order after a drag, or null for a no-op.
 * A project's group is its repository, so a drop that would move it into
 * another group is a no-op.
 */
export function repositoryArrangementUpdate(
  list: MergedList,
  machines: readonly MachineView[],
  arrangement: ProjectArrangement | null,
): Pick<PortalLayout, "repositoryOrder"> | null {
  if (!arrangement || Object.keys(arrangement.folders).length > 0) return null;
  return {
    repositoryOrder: bounded(prune(placeShown(list.full, arrangement.projectIds), machines)),
  };
}

/** Shorten a repository hint by dropping only its host, preserving every namespace. */
export function repositoryLabel(hint: string): string {
  const parts = hint.split("/");
  return parts.length > 2 ? parts.slice(1).join("/") : hint;
}

/** Repository hints are identities, not user-entered folder names. */
export function buildRepositoryTree(
  projects: readonly MergedProject[],
): ProjectTreeEntry<MergedProject>[] {
  const entries: ProjectTreeEntry<MergedProject>[] = [];
  const groups = new Map<string, Extract<ProjectTreeEntry<MergedProject>, { kind: "folder" }>>();
  for (const project of projects) {
    const name = project.folder;
    if (!name) {
      entries.push({ kind: "project", project });
      continue;
    }
    const existing = groups.get(name);
    if (existing) existing.projects.push(project);
    else {
      const entry = { kind: "folder" as const, name, key: name, projects: [project] };
      groups.set(name, entry);
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * The default project list or the repository list, with the tree of folders
 * (or repository groups) it is drawn as; compact draws the repository tree.
 */
export function mergedProjectView(
  machines: readonly MachineView[],
  shownIds: ReadonlySet<string>,
  mode: "project" | "repository",
  layout: Pick<PortalLayout, "projectOrder" | "projectFolders" | "repositoryOrder">,
  commandNodeId: string | null,
): { list: MergedList; tree: ProjectTreeEntry<MergedProject>[] } {
  const list =
    mode === "project"
      ? mergedProjectList(machines, shownIds, layout, commandNodeId)
      : repositoryProjectList(machines, shownIds, layout, commandNodeId);
  return {
    list,
    tree: mode === "repository" ? buildRepositoryTree(list.shown) : buildProjectTree(list.shown),
  };
}

/** What a repository group's heading opens: the command node's project, else the first shown. */
export function repositoryOpenTarget(
  group: readonly MergedProject[],
  commandNodeId: string | null,
): MergedProject | null {
  return group.find((member) => member.machine.backendId === commandNodeId) ?? group[0] ?? null;
}

/**
 * The colour of a repository's home tile: the command node's while it has a
 * copy of the repository, shown or not, else that of the machine the heading
 * opens the coordinator on.
 */
export function repositoryTileColor(
  commandNode: MachineView | undefined,
  repository: string,
  opens: MergedProject | null,
): string | undefined {
  const onCommandNode = commandNode?.projects.some(
    (project) => project.repositoryHint === repository,
  );
  return (onCommandNode ? commandNode : opens?.machine)?.colorToken;
}

/**
 * The icon on a repository's home tile: the command node's for its copy of the
 * repository, shown or not. A repository the command node has no copy of takes
 * the first icon in machine order, so it does not lose its icon to the house.
 */
export function repositoryIcon(
  machines: readonly MachineView[],
  commandNode: MachineView | undefined,
  repository: string,
): string | undefined {
  const copies = (machine: MachineView) =>
    machine.projects.filter((project) => project.repositoryHint === repository);
  if (commandNode && copies(commandNode).length > 0) {
    return copies(commandNode).find((project) => project.icon)?.icon ?? undefined;
  }
  for (const machine of machines) {
    const icon = copies(machine).find((project) => project.icon)?.icon;
    if (icon) return icon;
  }
  return undefined;
}
