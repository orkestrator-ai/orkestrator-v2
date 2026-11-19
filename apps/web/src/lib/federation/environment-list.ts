/**
 * The multi-machine sidebar's environment list (design EL01): one entry per
 * repository, its environments listed flat beneath it whichever machine they
 * are on, ordered by machine or by hand. Everything here is pure.
 *
 * - **By machine** (the default): each machine's environments together, in
 *   machine order, each machine's own environment order within its run. A
 *   drag stays within the dragged environment's project on its machine, and
 *   is written to that machine (`reorderEnvironments`).
 * - **Manual**: one order per repository, kept on the command node
 *   (`PortalLayout.environmentOrder`). Until the user arranges a repository
 *   it is the by-machine order. An environment the stored order does not name
 *   yet goes after the last one of its own machine there. A drag rearranges
 *   only the environments shown, in the slots they occupy, so a filtered-out
 *   machine's environments keep their places.
 */

import type { PortalLayout } from "@orkestrator/protocol/portal-layout";
import { parseEnvironmentKey } from "@orkestrator/protocol/federation";
import {
  buildRepositoryTree,
  isMachineShown,
  moveEntry,
  placeShown,
  repositoryArrangementUpdate,
  repositoryLabel,
  repositoryProjectList,
  type MergedList,
  type MergedProject,
} from "./sidebar-layout";
import { projectFolderDragId } from "@/lib/project-folders";
import type { MachineView } from "./aggregate";
import type { FederatedEnvironment, FederatedProject } from "./summaries";

export type EnvironmentOrdering = "machine" | "manual";

/** One environment row of the list. */
export interface ListedEnvironment {
  /** The environment's node-qualified key: its drag id and its manual-order entry. */
  id: string;
  machine: MachineView;
  project: FederatedProject;
  environment: FederatedEnvironment;
}

/** One repository of the list (or a project that reports no repository). */
export interface RepositoryEntry {
  /** The repository identity, or the project key of a project with none. */
  key: string;
  /** Its heading's drag id. */
  dragId: string;
  /** The repository identity (`host/owner/name`), when it has one. */
  repository: string | null;
  /** `owner/name`, or the project's name. */
  label: string;
  /** Its projects on the machines shown, in list order. */
  members: MergedProject[];
  /** Its projects on every known machine, shown or not, in list order. */
  allMembers: MergedProject[];
}

/** Environments of a project in their machine's own order (pending drags included). */
export type EnvironmentsOf = (
  machine: MachineView,
  project: FederatedProject,
) => readonly FederatedEnvironment[];

export interface RepositoryList {
  /** The repository order this list was built from (for a heading drag). */
  list: MergedList;
  entries: RepositoryEntry[];
}

/**
 * The repositories with at least one project on a shown machine, in the order
 * the command node keeps (`repositoryOrder`). `machines` are every known
 * machine in machine order; `shownIds` the connected ones the filter shows.
 */
export function repositoryEntries(
  machines: readonly MachineView[],
  shownIds: ReadonlySet<string>,
  layout: Pick<PortalLayout, "projectOrder" | "projectFolders" | "repositoryOrder">,
  commandNodeId: string | null,
): RepositoryList {
  const list = repositoryProjectList(machines, shownIds, layout, commandNodeId);
  const everywhere = repositoryProjectList(
    machines,
    new Set(machines.map((machine) => machine.connectionId)),
    layout,
    commandNodeId,
  );
  const allByGroup = new Map<string, MergedProject[]>();
  for (const project of everywhere.shown) {
    const key = project.folder ?? project.id;
    allByGroup.set(key, [...(allByGroup.get(key) ?? []), project]);
  }
  const entries = buildRepositoryTree(list.shown).map((entry): RepositoryEntry => {
    if (entry.kind === "folder") {
      return {
        key: entry.name,
        dragId: projectFolderDragId(entry.name),
        repository: entry.name,
        label: repositoryLabel(entry.name),
        members: entry.projects,
        allMembers: allByGroup.get(entry.name) ?? entry.projects,
      };
    }
    return {
      key: entry.project.id,
      dragId: projectFolderDragId(entry.project.id),
      repository: null,
      label: entry.project.name,
      members: [entry.project],
      allMembers: [entry.project],
    };
  });
  return { list, entries };
}

/**
 * The next stored repository order after a heading is dropped on another, or
 * null for a no-op. Hidden machines' projects keep their slots.
 */
export function repositoryOrderAfterMove(
  repositories: RepositoryList,
  machines: readonly MachineView[],
  activeDragId: string,
  overDragId: string,
): Pick<PortalLayout, "repositoryOrder"> | null {
  const ids = repositories.entries.map((entry) => entry.dragId);
  const next = moveEntry(ids, activeDragId, overDragId);
  if (!next) return null;
  const byId = new Map(repositories.entries.map((entry) => [entry.dragId, entry]));
  const projectIds = next.flatMap((id) => byId.get(id)!.members.map((member) => member.id));
  return repositoryArrangementUpdate(repositories.list, machines, { projectIds, folders: {} });
}

function machineRank(machines: readonly MachineView[]): Map<string, number> {
  return new Map(machines.map((machine, index) => [machine.connectionId, index]));
}

/**
 * A repository's environments by machine: machine order first, then the
 * repository's projects on that machine in list order, then each project's
 * own environment order.
 */
export function environmentsByMachine(
  members: readonly MergedProject[],
  machines: readonly MachineView[],
  environmentsOf: EnvironmentsOf,
): ListedEnvironment[] {
  const rank = machineRank(machines);
  const ordered = members
    .map((member, index) => ({ member, index }))
    .sort(
      (left, right) =>
        (rank.get(left.member.machine.connectionId) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(right.member.machine.connectionId) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    );
  return ordered.flatMap(({ member }) =>
    environmentsOf(member.machine, member.project).map((environment) => ({
      id: environment.key,
      machine: member.machine,
      project: member.project,
      environment,
    })),
  );
}

/** The node an environment key names, or null. */
function nodeOf(id: string): string | null {
  return parseEnvironmentKey(id)?.backendId ?? null;
}

/**
 * `stored` with every entry of `defaults` it lacks. A new entry goes after the
 * last stored entry of its own machine; with none, after the entry that
 * precedes it in `defaults` (or first). Stored entries keep their order,
 * including ones `defaults` no longer has.
 */
export function mergeManualOrder(stored: readonly string[], defaults: readonly string[]): string[] {
  const result = [...stored];
  const present = new Set(stored);
  for (let index = 0; index < defaults.length; index++) {
    const id = defaults[index]!;
    if (present.has(id)) continue;
    const node = nodeOf(id);
    let at = -1;
    if (node !== null) {
      for (let slot = result.length - 1; slot >= 0; slot--) {
        if (nodeOf(result[slot]!) === node) {
          at = slot + 1;
          break;
        }
      }
    }
    if (at === -1) {
      at = 0;
      for (let before = index - 1; before >= 0; before--) {
        const slot = result.indexOf(defaults[before]!);
        if (slot !== -1) {
          at = slot + 1;
          break;
        }
      }
    }
    result.splice(at, 0, id);
    present.add(id);
  }
  return result;
}

export interface OrderedRepository {
  /** The rows shown, in order. */
  rows: ListedEnvironment[];
  /** The whole manual order this was built from, hidden entries included (Manual only). */
  full: string[];
}

/**
 * A repository's rows in the chosen ordering. `machines` are every known
 * machine in machine order; only `entry.members` (shown machines) give rows.
 */
export function orderRepository(
  entry: RepositoryEntry,
  machines: readonly MachineView[],
  ordering: EnvironmentOrdering,
  layout: Pick<PortalLayout, "environmentOrder">,
  environmentsOf: EnvironmentsOf,
): OrderedRepository {
  const shown = environmentsByMachine(entry.members, machines, environmentsOf);
  if (ordering === "machine") return { rows: shown, full: shown.map((row) => row.id) };
  const everywhere = environmentsByMachine(entry.allMembers, machines, environmentsOf);
  const defaultIds = everywhere.map((row) => row.id);
  const stored = Object.hasOwn(layout.environmentOrder, entry.key)
    ? layout.environmentOrder[entry.key]!
    : [];
  const full = mergeManualOrder(pruneEnvironmentOrder(stored, machines, defaultIds), defaultIds);
  const byId = new Map(shown.map((row) => [row.id, row]));
  return { rows: full.flatMap((id) => byId.get(id) ?? []), full };
}

/**
 * Whether a by-machine drop of `activeId` on `overId` stays within the
 * dragged environment's own run: the same project on the same machine.
 */
export function byMachineDropTarget(
  rows: readonly ListedEnvironment[],
  activeId: string,
  overId: string,
): { active: ListedEnvironment; over: ListedEnvironment } | null {
  if (activeId === overId) return null;
  const active = rows.find((row) => row.id === activeId);
  const over = rows.find((row) => row.id === overId);
  if (!active || !over) return null;
  if (active.machine.connectionId !== over.machine.connectionId) return null;
  if (active.project.key !== over.project.key) return null;
  return { active, over };
}

/** Its summaries are complete, so a missing environment really is gone. */
function isMachineComplete(machine: MachineView): boolean {
  return machine.bound
    ? machine.boundEnvironmentsComplete === true
    : isMachineShown(machine) &&
        machine.freshness === "current" &&
        !machine.truncated &&
        machine.loadedAt !== null;
}

/** Drops entries of forgotten machines and of environments their (complete) machine no longer has. */
export function pruneEnvironmentOrder(
  ids: readonly string[],
  machines: readonly MachineView[],
  knownRepositoryRows: readonly string[],
): string[] {
  if (ids.length === 0) return [];
  const byNode = new Map(machines.map((machine) => [machine.backendId as string, machine]));
  const existing = new Set(knownRepositoryRows);
  return ids.filter((id) => {
    const node = nodeOf(id);
    const machine = node === null ? undefined : byNode.get(node);
    if (!machine) return false;
    return existing.has(id) || !isMachineComplete(machine);
  });
}

/** The next order for this repository, changing only the slots of shown rows. */
export function manualOrderAfterDrop(
  ordered: OrderedRepository,
  activeId: string,
  overId: string,
): string[] | null {
  const next = moveEntry(
    ordered.rows.map((row) => row.id),
    activeId,
    overId,
  );
  return next ? placeShown(ordered.full, next) : null;
}

/** The repository list entry a project belongs to (`RepositoryEntry.key`). */
export function repositoryGroupKey(
  project: Pick<FederatedProject, "key" | "repositoryHint">,
): string {
  return project.repositoryHint ?? project.key;
}
