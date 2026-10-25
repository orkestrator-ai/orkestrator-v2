/**
 * Presentation projections over several machines' summaries.
 *
 * Everything here is a view: filtering and sorting never merge records,
 * change ownership or touch workflow state. Projects with the same name on
 * two machines stay two project instances (`sidebar-layout.ts` orders the
 * merged lists). Global activity order is a presentation sort over
 * backend-reported timestamps from different clocks, with backend and
 * resource IDs as the final tie-breakers.
 */

import type { ConnectionTransportState } from "@orkestrator/protocol/connections";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { ActivitySortOrder } from "@/stores/uiStore";
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

const ACTIVITY_PRIORITY: Record<FederatedEnvironment["activity"], number> = {
  waiting: 0,
  working: 1,
  idle: 2,
};

/**
 * Every environment across the selected machines. "priority" puts attention
 * first and newest first within it; "newest" and "oldest" go by activity time
 * alone. Machine and environment IDs break ties the same way in every order.
 */
export function activityRows(
  machines: readonly MachineView[],
  order: ActivitySortOrder = "priority",
): ActivityRow[] {
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
  const attention = (a: ActivityRow, b: ActivityRow) =>
    order === "priority"
      ? Number(b.environment.hasUnreadWork) - Number(a.environment.hasUnreadWork) ||
        ACTIVITY_PRIORITY[a.environment.activity] - ACTIVITY_PRIORITY[b.environment.activity]
      : 0;
  const recency = (a: ActivityRow, b: ActivityRow) => {
    const newestFirst = compareTimestampsDesc(
      a.environment.activityUpdatedAt ?? a.environment.lastActivityAt,
      b.environment.activityUpdatedAt ?? b.environment.lastActivityAt,
    );
    return order === "oldest" ? -newestFirst : newestFirst;
  };
  return rows.sort(
    (a, b) =>
      attention(a, b) ||
      recency(a, b) ||
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
