import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { pathName, repositoryHint } from "@orkestrator/protocol/node-summaries";
import { compareActivityTimestampsDesc } from "@orkestrator/protocol/environment-activity-order";
import { ALL_MACHINES, type MachineView } from "@/lib/federation/aggregate";
import { isNodeEnvironmentReadyToMerge } from "@/lib/pr-merge-readiness";
import type { Environment, EnvironmentStatus, Project } from "@/types";

/**
 * The project search: one ranking for this machine's projects and
 * environments and every other machine's, shared by the ⌘K palette and the
 * sidebar's search field (which opens the same palette).
 *
 * Rows from every machine are first normalized into the same search records
 * (`localSearchSource`, `machineSearchSource`), built from the same fields
 * with the same helpers, so a row matches on exactly what it would match on
 * the machine that owns it. Remote rows stay keyed by their machine: nothing
 * here writes to, or reads IDs from, this window's workspace stores.
 */

export type ProjectSearchFilter = "all" | "projects" | "environments";

export const PROJECT_SEARCH_FILTERS: readonly ProjectSearchFilter[] = [
  "all",
  "projects",
  "environments",
];

/** Machine filter: every machine, the window's own machine, or one machine's connection ID. */
export const THIS_MACHINE = "this";
export type ProjectSearchMachineFilter = typeof ALL_MACHINES | typeof THIS_MACHINE | string;

export const PROJECT_SEARCH_RECENT_LIMIT = 8;
export const PROJECT_SEARCH_RESULT_LIMIT = 50;

/**
 * A row's machine as the search shows it: `live` rows act normally; the
 * others are last-known rows of a machine that is offline, stale or still
 * loading, shown greyed with that label.
 */
export type ProjectSearchAvailability = "live" | "offline" | "stale" | "loading";

/** A project, from any machine, as the search matches and shows it. */
export interface ProjectSearchProject {
  /** The project's ID on its own machine. */
  id: string;
  /** Unique across machines: the node-qualified key when the machine is known. */
  key: string;
  name: string;
  order: number;
  folder: string | null;
  /** Credential-free `host/owner/name`; the search matches its owner/name part. */
  repositoryHint: string | null;
  /** Last segment of the checkout path. */
  pathName: string | null;
  /** "main" when the machine did not say (unconfigured, or an older leaf). */
  defaultBranch: string;
}

/** An environment, from any machine, as the search matches and shows it. */
export interface ProjectSearchEnvironment {
  id: string;
  key: string;
  projectId: string;
  name: string;
  branch: string;
  status: EnvironmentStatus;
  environmentType: string | null;
  /** Last segment of the worktree path. */
  worktreeName: string | null;
  lastActivityAt?: string;
  createdAt?: string;
  order: number;
  /**
   * Another machine's PR is ready to merge, decided from its summary. This
   * machine's rows leave it unset: the row reads the live PR monitor instead.
   */
  readyToMerge?: boolean;
}

/** One machine's searchable rows. `machine` is null outside a multi-machine view. */
export interface ProjectSearchSource {
  machine: MachineView | null;
  projects: readonly ProjectSearchProject[];
  environments: readonly ProjectSearchEnvironment[];
}

export type ProjectSearchProjectHit = {
  type: "project";
  /** Unique across machines; this machine's rows keep their plain ID. */
  id: string;
  machine: MachineView | null;
  availability: ProjectSearchAvailability;
  project: ProjectSearchProject;
  environmentCount: number;
  score: number;
};

export type ProjectSearchEnvironmentHit = {
  type: "environment";
  id: string;
  machine: MachineView | null;
  availability: ProjectSearchAvailability;
  environment: ProjectSearchEnvironment;
  project: ProjectSearchProject;
  isPrimary: boolean;
  score: number;
};

export type ProjectSearchHit = ProjectSearchProjectHit | ProjectSearchEnvironmentHit;

export type ProjectSearchResults = {
  projects: ProjectSearchProjectHit[];
  environments: ProjectSearchEnvironmentHit[];
  /** A machine in scope is unavailable, still loading or truncated: rows may be missing. */
  incomplete: boolean;
  /** Projects in scope before matching, for the empty-state copy. */
  projectCount: number;
};

export function nextProjectSearchFilter(current: ProjectSearchFilter): ProjectSearchFilter {
  const index = PROJECT_SEARCH_FILTERS.indexOf(current);
  return PROJECT_SEARCH_FILTERS[(index + 1) % PROJECT_SEARCH_FILTERS.length] ?? "all";
}

export function previousProjectSearchFilter(current: ProjectSearchFilter): ProjectSearchFilter {
  const index = PROJECT_SEARCH_FILTERS.indexOf(current);
  const previous = (index - 1 + PROJECT_SEARCH_FILTERS.length) % PROJECT_SEARCH_FILTERS.length;
  return PROJECT_SEARCH_FILTERS[previous] ?? "all";
}

export function parseProjectSearchQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** This machine's rows: full stores, projected through the summary helpers. */
export function localSearchSource({
  machine,
  backendId: knownBackendId = null,
  projects,
  environments,
  defaultBranches,
}: {
  /** This window's machine in a multi-machine view, else null. */
  machine: MachineView | null;
  /** This machine's identity when known, so its recents are node-qualified. */
  backendId?: BackendId | null;
  projects: readonly Project[];
  environments: readonly Environment[];
  defaultBranches: ReadonlyMap<string, string>;
}): ProjectSearchSource {
  const backendId = machine?.backendId ?? knownBackendId;
  return {
    machine,
    projects: projects.map((project) => ({
      id: project.id,
      key: backendId ? projectKey(projectRef(backendId, project.id)) : project.id,
      name: project.name,
      order: project.order,
      folder: project.folder ?? null,
      repositoryHint: repositoryHint(project.gitUrl) ?? null,
      pathName: pathName(project.localPath) ?? null,
      defaultBranch: defaultBranches.get(project.id) ?? "main",
    })),
    environments: environments.map((environment) => ({
      id: environment.id,
      key: backendId
        ? environmentKey(environmentRef(backendId, environment.id))
        : localEnvironmentSearchKey(environment.id),
      projectId: environment.projectId,
      name: environment.name,
      branch: environment.branch,
      status: environment.status,
      environmentType: environment.environmentType ?? null,
      worktreeName: pathName(environment.worktreePath) ?? null,
      ...(environment.lastActivityAt ? { lastActivityAt: environment.lastActivityAt } : {}),
      ...(environment.createdAt ? { createdAt: environment.createdAt } : {}),
      order: environment.order,
    })),
  };
}

/** Recency key of an environment outside a multi-machine view. */
export function localEnvironmentSearchKey(environmentId: string): string {
  return `environment:${environmentId}`;
}

const ENVIRONMENT_STATUSES: ReadonlySet<string> = new Set<EnvironmentStatus>([
  "running",
  "stopped",
  "error",
  "creating",
  "stopping",
]);

/** A summary's status is the owner's free text; an unknown one shows as stopped. */
function summaryStatus(status: string): EnvironmentStatus {
  return ENVIRONMENT_STATUSES.has(status) ? (status as EnvironmentStatus) : "stopped";
}

/**
 * Another machine's rows, from its summaries. A summary from a leaf that
 * predates a search field simply lacks it; the row matches on what is there.
 */
export function machineSearchSource(machine: MachineView): ProjectSearchSource {
  const environments: ProjectSearchEnvironment[] = [];
  for (const list of machine.environmentsByProject.values()) {
    for (const environment of list) {
      // A project home has no row of its own, as in this machine's sidebar.
      if (environment.isProjectHome) continue;
      environments.push({
        id: environment.ref.environmentId,
        key: environment.key,
        projectId: environment.projectId,
        name: environment.name,
        branch: environment.branch ?? "",
        status: summaryStatus(environment.status),
        environmentType: environment.environmentType ?? null,
        worktreeName: environment.worktreeName ?? null,
        ...(environment.lastActivityAt ? { lastActivityAt: environment.lastActivityAt } : {}),
        ...(environment.createdAt ? { createdAt: environment.createdAt } : {}),
        order: environment.order,
        ...(isNodeEnvironmentReadyToMerge(environment, machine) ? { readyToMerge: true } : {}),
      });
    }
  }
  return {
    machine,
    projects: machine.projects.map((project) => ({
      id: project.ref.projectId,
      key: project.key,
      name: project.name,
      order: project.order,
      folder: project.folder ?? null,
      repositoryHint: project.repositoryHint ?? null,
      pathName: project.pathName ?? null,
      defaultBranch: project.defaultBranch ?? "main",
    })),
    environments,
  };
}

export function machineAvailability(machine: MachineView | null): ProjectSearchAvailability {
  if (!machine || machine.bound) return "live";
  if (machine.transport !== "connected") return "offline";
  if (machine.freshness === "initializing" || machine.freshness === "catching-up") {
    return "loading";
  }
  return machine.freshness === "current" ? "live" : "stale";
}

function inMachineScope(source: ProjectSearchSource, filter: ProjectSearchMachineFilter): boolean {
  if (filter === ALL_MACHINES) return true;
  if (filter === THIS_MACHINE) return !source.machine || source.machine.bound;
  return source.machine?.connectionId === filter;
}

function pathBasename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Repository name and owner/name (or a deeper namespace) without the host,
 * so tokens like `git`, `https`, and `github` do not match every remote.
 */
function repositoryHaystacks(hint: string | null): string[] {
  if (!hint) return [];
  const slug = hint.split("/").slice(1).join("/");
  if (!slug.includes("/")) return [];
  const repoName = pathBasename(slug);
  return repoName && repoName !== slug ? [repoName, slug] : [slug];
}

function projectHaystacks(project: ProjectSearchProject): string[] {
  return [project.name, ...repositoryHaystacks(project.repositoryHint), project.pathName ?? ""];
}

function environmentHaystacks(
  environment: ProjectSearchEnvironment,
  project: ProjectSearchProject,
): string[] {
  return [
    environment.name,
    environment.branch,
    project.name,
    ...repositoryHaystacks(project.repositoryHint),
    environment.environmentType ?? "",
    environment.worktreeName ?? "",
  ];
}

function scoreHaystacks(haystacks: string[], tokens: string[]): number | null {
  if (tokens.length === 0) return 0;

  let total = 0;
  for (const token of tokens) {
    let best = -1;
    for (const hay of haystacks) {
      const haystack = hay.toLowerCase();
      if (!haystack) continue;
      if (haystack === token) best = Math.max(best, 100);
      else if (haystack.startsWith(token)) best = Math.max(best, 80);
      else if (haystack.includes(token)) best = Math.max(best, 40);
    }
    if (best < 0) return null;
    total += best;
  }
  return total;
}

/** Last activity, or creation for an environment with no usable activity time. */
function environmentActivityTimestamp(environment: ProjectSearchEnvironment): string | undefined {
  const { lastActivityAt } = environment;
  return lastActivityAt && Number.isFinite(Date.parse(lastActivityAt))
    ? lastActivityAt
    : environment.createdAt;
}

function hitId(machine: MachineView | null, id: string): string {
  return machine && !machine.bound ? `${machine.connectionId}:${id}` : id;
}

/**
 * Rank projects and environments across machines.
 *
 * Both lists put the most recently used rows first (`recentKeys`, newest
 * first, node-qualified so a project used on one machine does not lift its
 * namesake on another), then the best match, then: projects by machine and
 * sidebar order; environments by last activity. An empty query lists recents
 * the same way. A query matches project names, repository owner/name and
 * checkout directory; environments also match their name, branch, type and
 * worktree directory.
 */
export function searchProjectsAndEnvironments({
  query,
  filter,
  machineFilter = ALL_MACHINES,
  sources,
  recentKeys,
  recentLimit = PROJECT_SEARCH_RECENT_LIMIT,
  resultLimit = PROJECT_SEARCH_RESULT_LIMIT,
}: {
  query: string;
  filter: ProjectSearchFilter;
  machineFilter?: ProjectSearchMachineFilter;
  /** This machine first, then the others in sidebar order (the final tie-break). */
  sources: readonly ProjectSearchSource[];
  recentKeys: readonly string[];
  recentLimit?: number;
  resultLimit?: number;
}): ProjectSearchResults {
  const tokens = parseProjectSearchQuery(query);
  const limit = tokens.length === 0 ? recentLimit : resultLimit;
  const recentIndex = new Map<string, number>();
  recentKeys.forEach((key, index) => {
    if (!recentIndex.has(key)) recentIndex.set(key, index);
  });
  const recency = (key: string) => recentIndex.get(key) ?? Number.MAX_SAFE_INTEGER;
  const includeProjects = filter !== "environments";
  const includeEnvironments = filter !== "projects";
  const scoped = sources.filter((source) => inMachineScope(source, machineFilter));
  const sourceIndex = new Map<MachineView | null, number>(
    scoped.map((source, index) => [source.machine, index]),
  );
  const machineOrder = (machine: MachineView | null) => sourceIndex.get(machine) ?? 0;

  const projectHits: ProjectSearchProjectHit[] = [];
  const environmentHits: ProjectSearchEnvironmentHit[] = [];
  let incomplete = false;
  let projectCount = 0;

  for (const source of scoped) {
    const { machine } = source;
    if (
      machine &&
      !machine.bound &&
      (machine.transport !== "connected" || machine.freshness !== "current" || machine.truncated)
    ) {
      incomplete = true;
    }
    const availability = machineAvailability(machine);
    projectCount += source.projects.length;
    const projectsById = new Map(source.projects.map((project) => [project.id, project]));

    if (includeProjects) {
      const environmentCount = new Map<string, number>();
      for (const environment of source.environments) {
        environmentCount.set(
          environment.projectId,
          (environmentCount.get(environment.projectId) ?? 0) + 1,
        );
      }
      for (const project of source.projects) {
        const score = scoreHaystacks(projectHaystacks(project), tokens);
        if (score === null) continue;
        projectHits.push({
          type: "project",
          id: hitId(machine, project.id),
          machine,
          availability,
          project,
          environmentCount: environmentCount.get(project.id) ?? 0,
          score,
        });
      }
    }

    if (includeEnvironments) {
      for (const environment of source.environments) {
        const project = projectsById.get(environment.projectId);
        if (!project) continue;
        const score = scoreHaystacks(environmentHaystacks(environment, project), tokens);
        if (score === null) continue;
        environmentHits.push({
          type: "environment",
          id: hitId(machine, environment.id),
          machine,
          availability,
          environment,
          project,
          isPrimary: environment.branch === project.defaultBranch,
          score,
        });
      }
    }
  }

  projectHits.sort(
    (left, right) =>
      recency(left.project.key) - recency(right.project.key) ||
      right.score - left.score ||
      machineOrder(left.machine) - machineOrder(right.machine) ||
      left.project.order - right.project.order ||
      left.project.name.localeCompare(right.project.name) ||
      compareText(left.id, right.id),
  );
  environmentHits.sort((left, right) => {
    const byRecency = recency(left.environment.key) - recency(right.environment.key);
    if (byRecency !== 0) return byRecency;
    if (left.score !== right.score) return right.score - left.score;
    return (
      // The shared activity-order timestamp rule: newest first, undated last.
      compareActivityTimestampsDesc(
        environmentActivityTimestamp(left.environment),
        environmentActivityTimestamp(right.environment),
      ) ||
      machineOrder(left.machine) - machineOrder(right.machine) ||
      left.environment.order - right.environment.order ||
      compareText(left.id, right.id)
    );
  });

  return {
    projects: projectHits.slice(0, limit),
    environments: environmentHits.slice(0, limit),
    incomplete,
    projectCount,
  };
}

export function flattenProjectSearchResults(results: ProjectSearchResults): ProjectSearchHit[] {
  return [...results.projects, ...results.environments];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
