/**
 * A warm or live node scope's own rows, overlaid on that node's summary in
 * the window's presentation path (plan item 5007, report §9's Sidebar row:
 * "full scope stores overlay warm/live nodes").
 *
 * Summaries are the floor for every node. While the window holds a node's
 * scope `warm` or `live`, that scope hears the node's own stream, so its
 * project and environment stores are at least as fresh as the command node's
 * summary of it: an environment renamed on the node shows without waiting
 * for the next summary. The scope's records go through the same projection
 * the command node applies to the node's summary reads
 * (`toNodeProjectSummary`, `toNodeEnvironmentSummary`), with the same bounds
 * and the same order, so a row drawn from either source is the same row
 * (`scope-overlay.test.ts`, `sidebar-parity.test.tsx`). Only the fields a
 * summary read adds to the ordinary records (PR monitor health, pipeline
 * markers, agent mail, Docker availability, a project's default branch) are
 * not in the scope's stores; they are kept from the summary.
 *
 * The scope is used only once its stores hold the node's authoritative
 * projects and environments (not a snapshot, plan item 4003) and while its
 * client hears the node; otherwise, and for `summary` and `suspended`
 * scopes, the node's rows are its summary's. The machine-level fields of a
 * view (connection, freshness, release) always come from the command node,
 * which decides whether a machine accepts writes.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import {
  MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT,
  MAX_SUMMARY_PROJECTS,
  toNodeEnvironmentSummary,
  toNodeProjectSummary,
  type NodeEnvironmentSummary,
  type NodeSummary,
} from "@orkestrator/protocol/node-summaries";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { scopeAuthoritativeReads } from "@/lib/node-scope/snapshot-sync";
import type { WindowScope } from "@/lib/node-scope/window-scope";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import type { Environment, Project } from "@/types";
import type { MachineView } from "./aggregate";
import type { FederatedEnvironment, FederatedProject } from "./summaries";

/** One node's records as its scope's stores hold them. */
export interface ScopeRows {
  readonly projects: readonly Project[];
  readonly environments: readonly Environment[];
}

/**
 * What a summary read (`NODE_SUMMARY_ENVIRONMENT_READ_ARGS`) adds to an
 * ordinary environment record (`EnvironmentSnapshotRowSchema`): the scope's
 * stores never hold these, so the overlay keeps the summary's.
 */
const SUMMARY_ONLY_ENVIRONMENT_FIELDS = [
  "dockerAvailable",
  "buildPipeline",
  "buildActive",
  "agentMailUnread",
  "agentMailFailed",
  "prMonitorConfirmed",
  "prViewerCanMerge",
  "prCheckSummary",
] as const satisfies ReadonlyArray<keyof NodeEnvironmentSummary>;

/** Whether `scope`'s stores may stand in for its node's summary rows. */
export function scopeRowsReady(scope: NodeScope): boolean {
  if (scope.disposed || scope.role !== "leaf") return false;
  const tier = scope.tier.get();
  if (tier !== "warm" && tier !== "live") return false;
  const connection = scope.client.connection.get();
  if (connection !== "live" && connection !== "resyncing") return false;
  // `hasLoaded` stays false while the stores hold only a snapshot (4003).
  if (!scope.store(projectStore).getState().hasLoaded) return false;
  return scopeAuthoritativeReads(scope).get().has("environment");
}

/** `scope`'s rows while they may stand in for its summary, else `null`. */
export function readScopeRows(scope: NodeScope): ScopeRows | null {
  if (!scopeRowsReady(scope)) return null;
  return {
    projects: scope.store(projectStore).getState().projects,
    environments: scope.store(environmentStore).getState().environments,
  };
}

const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;

/**
 * `view` (the node's summary view, `viewFromNodeSummary(summary)`) with its
 * projects and environments taken from the scope's `rows`.
 */
export function machineViewWithScopeRows(
  view: MachineView,
  summary: Pick<NodeSummary, "projects" | "environments">,
  rows: ScopeRows,
): MachineView {
  const nodeId = view.backendId;
  const summaryProjects = new Map(
    summary.projects.map((project) => [project.ref.projectId, project]),
  );
  const summaryEnvironments = new Map(
    summary.environments.map((environment) => [environment.ref.environmentId, environment]),
  );
  // A machine-level fact a summary repeats on each row; a row created since
  // the last summary gets it too.
  const dockerAvailable = summary.environments.find(
    (environment) => environment.dockerAvailable !== undefined,
  )?.dockerAvailable;

  const projects: FederatedProject[] = rows.projects
    .slice(0, MAX_SUMMARY_PROJECTS)
    .flatMap((record, index) => {
      const project = toNodeProjectSummary(nodeId, recordOf(record), index);
      if (!project) return [];
      const defaultBranch = summaryProjects.get(project.ref.projectId)?.defaultBranch;
      return [
        project.defaultBranch === undefined && defaultBranch !== undefined
          ? { ...project, defaultBranch }
          : project,
      ];
    })
    .sort(byOrder);
  let truncated = rows.projects.length > MAX_SUMMARY_PROJECTS;

  const recordsByProject = new Map<string, Environment[]>();
  for (const environment of rows.environments) {
    const list = recordsByProject.get(environment.projectId) ?? [];
    list.push(environment);
    recordsByProject.set(environment.projectId, list);
  }
  // As a summary read does: only listed projects' environments, per project
  // in the node's own sidebar order.
  const environmentsByProject = new Map<string, FederatedEnvironment[]>();
  for (const project of projects) {
    const records = recordsByProject.get(project.ref.projectId);
    if (!records?.length) continue;
    const environments = records
      .flatMap((record, index) => {
        const environment = toNodeEnvironmentSummary(nodeId, recordOf(record), index);
        if (!environment) return [];
        return [
          withSummaryOnlyFields(
            environment,
            summaryEnvironments.get(environment.ref.environmentId),
            dockerAvailable,
          ),
        ];
      })
      .sort(byOrder);
    if (environments.length > MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT) truncated = true;
    environmentsByProject.set(
      project.ref.projectId,
      environments.slice(0, MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT),
    );
  }
  return { ...view, projects, environmentsByProject, truncated };
}

function recordOf(record: Project | Environment): Record<string, unknown> {
  return record as unknown as Record<string, unknown>;
}

function withSummaryOnlyFields(
  environment: FederatedEnvironment,
  summary: FederatedEnvironment | undefined,
  dockerAvailable: boolean | undefined,
): FederatedEnvironment {
  const carried: Partial<Record<(typeof SUMMARY_ONLY_ENVIRONMENT_FIELDS)[number], unknown>> = {};
  if (summary) {
    for (const field of SUMMARY_ONLY_ENVIRONMENT_FIELDS) {
      if (environment[field] === undefined && summary[field] !== undefined) {
        carried[field] = summary[field];
      }
    }
  }
  if (
    environment.dockerAvailable === undefined &&
    carried.dockerAvailable === undefined &&
    dockerAvailable !== undefined
  ) {
    carried.dockerAvailable = dockerAvailable;
  }
  return Object.keys(carried).length > 0
    ? ({ ...environment, ...carried } as FederatedEnvironment)
    : environment;
}

/** Every leaf scope's rows that may stand in for its summary, by node. */
export interface ScopeRowsSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReadonlyMap<BackendId, ScopeRows>;
}

const EMPTY_ROWS: ReadonlyMap<BackendId, ScopeRows> = new Map();
const sources = new WeakMap<WindowScope, ScopeRowsSource>();

/**
 * The window's scope rows as an external store (`useSyncExternalStore`):
 * it notifies when a scope opens or closes, changes tier or connection,
 * gets its first authoritative environment read, or its project or
 * environment store changes. The snapshot keeps its identity while no
 * node's rows changed.
 */
export function scopeRowsSource(windowScope: WindowScope): ScopeRowsSource {
  const existing = sources.get(windowScope);
  if (existing) return existing;
  let cached = EMPTY_ROWS;
  const source: ScopeRowsSource = {
    subscribe(listener) {
      const watched = new Map<NodeScope, () => void>();
      const sync = () => {
        const open = windowScope.nodeScopes
          .get()
          .filter((scope) => scope.role === "leaf" && !scope.disposed);
        for (const [scope, stop] of Array.from(watched)) {
          if (open.includes(scope)) continue;
          stop();
          watched.delete(scope);
        }
        for (const scope of open) {
          if (!watched.has(scope)) watched.set(scope, watchScope(scope, listener));
        }
      };
      sync();
      const stopScopes = windowScope.nodeScopes.subscribe(() => {
        sync();
        listener();
      });
      return () => {
        stopScopes();
        for (const stop of watched.values()) stop();
        watched.clear();
      };
    },
    getSnapshot() {
      const next = new Map<BackendId, ScopeRows>();
      for (const scope of windowScope.nodeScopes.get()) {
        const rows = readScopeRows(scope);
        if (rows) next.set(scope.nodeId, rows);
      }
      if (sameRows(cached, next)) return cached;
      cached = next.size === 0 ? EMPTY_ROWS : next;
      return cached;
    },
  };
  sources.set(windowScope, source);
  return source;
}

function watchScope(scope: NodeScope, listener: () => void): () => void {
  const stops = [
    scope.tier.subscribe(listener),
    scope.client.connection.subscribe(listener),
    scopeAuthoritativeReads(scope).subscribe(listener),
    scope.store(projectStore).subscribe(listener),
    scope.store(environmentStore).subscribe(listener),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

function sameRows(
  a: ReadonlyMap<BackendId, ScopeRows>,
  b: ReadonlyMap<BackendId, ScopeRows>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [nodeId, rows] of b) {
    const other = a.get(nodeId);
    if (!other || other.projects !== rows.projects || other.environments !== rows.environments) {
      return false;
    }
  }
  return true;
}
