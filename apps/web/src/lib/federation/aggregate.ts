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
import { compareActivity, type ActivitySortKey } from "@/lib/activity-order";
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
 * Every environment across the selected machines, in the activity order this
 * window's own list uses (`compareActivity`). Ties fall to machine ID, then
 * the machine's project order, environment order and ID.
 */
export function activityRows(
  machines: readonly MachineView[],
  order: ActivitySortOrder = "priority",
): ActivityRow[] {
  const rows: Array<ActivityRow & { key: ActivitySortKey }> = [];
  for (const machine of machines) {
    const projects = new Map(machine.projects.map((project) => [project.ref.projectId, project]));
    for (const [projectId, environments] of machine.environmentsByProject) {
      const project = projects.get(projectId) ?? null;
      for (const environment of environments) {
        if (environment.isProjectHome) continue;
        rows.push({
          machine,
          project,
          environment,
          key: {
            hasUnreadWork: environment.hasUnreadWork,
            activity: environment.activity,
            activityUpdatedAt: environment.activityUpdatedAt,
            lastActivityAt: environment.lastActivityAt,
            machineId: machine.backendId,
            projectOrder: project?.order,
            order: environment.order,
            id: environment.ref.environmentId,
          },
        });
      }
    }
  }
  return rows
    .sort((a, b) => compareActivity(a.key, b.key, order))
    .map(({ machine, project, environment }) => ({ machine, project, environment }));
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
