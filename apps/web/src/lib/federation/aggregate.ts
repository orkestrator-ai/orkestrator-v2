/**
 * Presentation projections over several machines' summaries.
 *
 * Everything here is a view: grouping, filtering and sorting never merge
 * records, change ownership or touch workflow state. Projects with the same
 * name on two machines stay two project instances; a repository group is
 * only a visual heading over separately owned projects. Global activity
 * order is a presentation sort over backend-reported timestamps from
 * different clocks, with backend and resource IDs as the final tie-breakers.
 */

import type { ConnectionTransportState } from "@orkestrator/protocol/connections";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { FederatedEnvironment, FederatedProject, SummaryFreshness } from "./summaries";

export interface MachineView {
  connectionId: string;
  backendId: BackendId;
  name: string;
  /** Canonical backend profile colour token (or a labelled fallback). */
  colorToken: string;
  /** This renderer's own machine (its full workspace lives in this realm). */
  bound: boolean;
  freshness: SummaryFreshness;
  transport: ConnectionTransportState;
  transportDetail?: string;
  projects: readonly FederatedProject[];
  environmentsByProject: ReadonlyMap<string, readonly FederatedEnvironment[]>;
  truncated: boolean;
  loadedAt: number | null;
}

export type SidebarGrouping = "machine" | "project" | "repository" | "activity";
export const ALL_MACHINES = "all";
export type MachineFilter = typeof ALL_MACHINES | string;

export interface ProjectGroup {
  machine: MachineView;
  project: FederatedProject;
  environments: readonly FederatedEnvironment[];
}

export interface MachineGroup {
  machine: MachineView;
  projects: ProjectGroup[];
}

export interface RepositoryGroup {
  /** Repository hint or explicit mapping key; `null` for an ungrouped project. */
  repository: string | null;
  label: string;
  projects: ProjectGroup[];
}

export interface ActivityRow {
  machine: MachineView;
  project: FederatedProject | null;
  environment: FederatedEnvironment;
}

/** A machine can accept writes only while its live connection is up. */
export function isMachineWritable(machine: MachineView): boolean {
  return machine.bound || machine.transport === "connected";
}

export function filterMachines(
  machines: readonly MachineView[],
  filter: MachineFilter,
): MachineView[] {
  if (filter === ALL_MACHINES) return [...machines];
  return machines.filter((machine) => machine.connectionId === filter);
}

function projectGroups(machine: MachineView, includeProjectHomes = false): ProjectGroup[] {
  return machine.projects.map((project) => ({
    machine,
    project,
    environments: (machine.environmentsByProject.get(project.ref.projectId) ?? []).filter(
      (environment) => includeProjectHomes || !environment.isProjectHome,
    ),
  }));
}

/** Machine → project instances → environments, in each backend's own order. */
export function groupByMachine(machines: readonly MachineView[]): MachineGroup[] {
  return [...machines]
    .sort(compareMachines)
    .map((machine) => ({ machine, projects: projectGroups(machine) }));
}

/** Project instances with machine badges. Equal names stay separate rows. */
export function groupByProject(machines: readonly MachineView[]): ProjectGroup[] {
  return machines
    .flatMap((machine) => projectGroups(machine))
    .sort(
      (a, b) =>
        a.project.name.localeCompare(b.project.name, undefined, { sensitivity: "base" }) ||
        compareMachines(a.machine, b.machine) ||
        compareText(a.project.ref.projectId, b.project.ref.projectId),
    );
}

/**
 * Optional visual grouping. Only a backend-published repository hint or an
 * explicit user mapping groups projects; a matching name, path or branch
 * never does.
 */
export function groupByRepository(
  machines: readonly MachineView[],
  mapping: ReadonlyMap<string, string> = new Map(),
): RepositoryGroup[] {
  const groups = new Map<string, RepositoryGroup>();
  const ungrouped: RepositoryGroup[] = [];
  for (const group of groupByProject(machines)) {
    const key = mapping.get(group.project.key) ?? group.project.repositoryHint ?? null;
    if (!key) {
      ungrouped.push({ repository: null, label: group.project.name, projects: [group] });
      continue;
    }
    const existing = groups.get(key);
    if (existing) existing.projects.push(group);
    else groups.set(key, { repository: key, label: repositoryLabel(key), projects: [group] });
  }
  return [...Array.from(groups.values()), ...ungrouped].sort(
    (a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
      compareText(a.repository ?? "", b.repository ?? ""),
  );
}

function repositoryLabel(key: string): string {
  const parts = key.split("/");
  return parts.length >= 2 ? parts.slice(-2).join("/") : key;
}

const ACTIVITY_PRIORITY: Record<FederatedEnvironment["activity"], number> = {
  waiting: 0,
  working: 1,
  idle: 2,
};

/** Every environment across the selected machines, attention first. */
export function activityRows(machines: readonly MachineView[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const machine of machines) {
    const projects = new Map(machine.projects.map((project) => [project.ref.projectId, project]));
    for (const [projectId, environments] of machine.environmentsByProject) {
      for (const environment of environments) {
        if (environment.isProjectHome) continue;
        rows.push({ machine, project: projects.get(projectId) ?? null, environment });
      }
    }
  }
  return rows.sort(
    (a, b) =>
      Number(b.environment.hasUnreadWork) - Number(a.environment.hasUnreadWork) ||
      ACTIVITY_PRIORITY[a.environment.activity] - ACTIVITY_PRIORITY[b.environment.activity] ||
      compareTimestampsDesc(
        a.environment.activityUpdatedAt ?? a.environment.lastActivityAt,
        b.environment.activityUpdatedAt ?? b.environment.lastActivityAt,
      ) ||
      compareText(a.machine.backendId, b.machine.backendId) ||
      compareText(a.environment.ref.environmentId, b.environment.ref.environmentId),
  );
}

export interface ConnectivitySummary {
  total: number;
  connected: number;
  current: number;
  unavailable: number;
  /** e.g. "2 connected · 1 unavailable". Never "all caught up" while one is missing. */
  label: string;
  complete: boolean;
}

export function connectivitySummary(machines: readonly MachineView[]): ConnectivitySummary {
  const total = machines.length;
  const connected = machines.filter(
    (machine) => machine.bound || machine.transport === "connected",
  ).length;
  const current = machines.filter((machine) => machine.freshness === "current").length;
  const unavailable = total - connected;
  const parts = [`${connected} connected`];
  if (unavailable > 0) parts.push(`${unavailable} unavailable`);
  if (connected > 0 && current < connected) parts.push(`${current} of ${total} current`);
  return {
    total,
    connected,
    current,
    unavailable,
    label: parts.join(" · "),
    complete: current === total && !machines.some((machine) => machine.truncated),
  };
}

export interface SearchResult {
  rows: ActivityRow[];
  /** Some machine is unavailable, still loading or truncated: results may be missing. */
  incomplete: boolean;
}

export function searchMachines(machines: readonly MachineView[], query: string): SearchResult {
  const needle = query.trim().toLocaleLowerCase();
  const rows = activityRows(machines).filter(
    ({ environment, project, machine }) =>
      !needle ||
      environment.name.toLocaleLowerCase().includes(needle) ||
      (environment.branch ?? "").toLocaleLowerCase().includes(needle) ||
      (project?.name ?? "").toLocaleLowerCase().includes(needle) ||
      machine.name.toLocaleLowerCase().includes(needle),
  );
  return {
    rows,
    incomplete: machines.some((machine) => machine.freshness !== "current" || machine.truncated),
  };
}

/**
 * Machines sharing a colour. A finite palette cannot guarantee uniqueness
 * across independently configured machines; this only powers a suggestion
 * in Connections, never an automatic recolour.
 */
export function duplicateMachineColors(
  machines: ReadonlyArray<Pick<MachineView, "connectionId" | "colorToken" | "name">>,
): Map<string, string[]> {
  const byColor = new Map<string, string[]>();
  for (const machine of machines) {
    const list = byColor.get(machine.colorToken) ?? [];
    list.push(machine.connectionId);
    byColor.set(machine.colorToken, list);
  }
  for (const [color, ids] of Array.from(byColor)) if (ids.length < 2) byColor.delete(color);
  return byColor;
}

function compareMachines(a: MachineView, b: MachineView): number {
  return (
    Number(b.bound) - Number(a.bound) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
    compareText(a.backendId, b.backendId)
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTimestampsDesc(a: string | undefined, b: string | undefined): number {
  const left = a ? Date.parse(a) : Number.NaN;
  const right = b ? Date.parse(b) : Number.NaN;
  const leftValid = Number.isFinite(left);
  const rightValid = Number.isFinite(right);
  if (leftValid && rightValid) return right - left;
  if (leftValid) return -1;
  if (rightValid) return 1;
  return 0;
}
