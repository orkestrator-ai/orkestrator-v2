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
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import {
  compareEnvironmentsByActivity,
  type ActivitySortOrder,
} from "@orkestrator/protocol/environment-activity-order";
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

/**
 * Every environment across the selected machines, in the shared activity order
 * (`compareEnvironmentsByActivity`). Machine and environment IDs break ties the
 * same way in every order.
 *
 * `boundActivity` is the activity the bound machine's own rows display: those
 * render as this window's `EnvironmentItem`, which can show runtime observations
 * and active builds its summary does not carry. Other machines' rows display
 * their summary's activity, so that is what they sort on.
 */
export function activityRows(
  machines: readonly MachineView[],
  order: ActivitySortOrder = "priority",
  boundActivity?: (environmentId: string) => AgentActivityState | undefined,
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
  const sortFields = (row: ActivityRow) => {
    const shown = row.machine.bound
      ? boundActivity?.(row.environment.ref.environmentId)
      : undefined;
    return shown ? { ...row.environment, activity: shown } : row.environment;
  };
  return rows
    .map((row) => ({ row, fields: sortFields(row) }))
    .sort(
      (a, b) =>
        compareEnvironmentsByActivity(a.fields, b.fields, order) ||
        compareText(a.row.machine.backendId, b.row.machine.backendId) ||
        compareText(a.row.environment.ref.environmentId, b.row.environment.ref.environmentId),
    )
    .map(({ row }) => row);
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
