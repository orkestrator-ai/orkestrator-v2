import type { Environment, Project } from "@/types";

export type ProjectSearchFilter = "all" | "projects" | "environments";

export const PROJECT_SEARCH_FILTERS: readonly ProjectSearchFilter[] = [
  "all",
  "projects",
  "environments",
];

export const PROJECT_SEARCH_RECENT_LIMIT = 8;
export const PROJECT_SEARCH_RESULT_LIMIT = 50;

export type ProjectSearchProjectHit = {
  type: "project";
  id: string;
  project: Project;
  environmentCount: number;
  score: number;
};

export type ProjectSearchEnvironmentHit = {
  type: "environment";
  id: string;
  environment: Environment;
  project: Project;
  isPrimary: boolean;
  score: number;
};

export type ProjectSearchHit = ProjectSearchProjectHit | ProjectSearchEnvironmentHit;

export type ProjectSearchResults = {
  projects: ProjectSearchProjectHit[];
  environments: ProjectSearchEnvironmentHit[];
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

function parseActivityTime(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function pathBasename(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * Owner/repo (or deeper SSH path) without scheme or host, so tokens like
 * `git`, `https`, and `github` do not match every remote.
 */
function parseRepoSlug(gitUrl: string): string | null {
  const url = gitUrl.trim();
  if (!url) return null;
  const withoutGit = url.endsWith(".git") ? url.slice(0, -4) : url;

  const sshMatch = withoutGit.match(/^git@[^:]+:(.+)$/i);
  if (sshMatch?.[1]) {
    const path = sshMatch[1].replace(/^\/+/, "");
    return path.includes("/") ? path : null;
  }

  try {
    if (/^(https?|ssh):\/\//i.test(withoutGit)) {
      const parsed = new URL(withoutGit);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return parts.slice(0, 2).join("/");
    }
  } catch {
    return null;
  }
  return null;
}

function projectRepoHaystacks(gitUrl: string): string[] {
  const slug = parseRepoSlug(gitUrl);
  if (!slug) return [];
  const repoName = pathBasename(slug);
  return repoName && repoName !== slug ? [repoName, slug] : [slug];
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

function environmentActivityTime(environment: Environment): number {
  const activity = parseActivityTime(environment.lastActivityAt);
  if (Number.isFinite(activity) && activity !== Number.NEGATIVE_INFINITY) return activity;
  return parseActivityTime(environment.createdAt);
}

function compareProjectsByRecency(
  left: Project,
  right: Project,
  recentIndex: ReadonlyMap<string, number>,
): number {
  const leftRecent = recentIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
  const rightRecent = recentIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
  if (leftRecent !== rightRecent) return leftRecent - rightRecent;
  if (left.order !== right.order) return left.order - right.order;
  return left.name.localeCompare(right.name);
}

function compareEnvironmentsByRecency(left: Environment, right: Environment): number {
  const leftActivity = environmentActivityTime(left);
  const rightActivity = environmentActivityTime(right);
  if (leftActivity !== rightActivity) return rightActivity - leftActivity;
  if (left.order !== right.order) return left.order - right.order;
  return left.id.localeCompare(right.id);
}

/**
 * Rank projects and environments for the sidebar search palette.
 *
 * An empty query returns recents (recent project IDs, then sidebar order;
 * environments by last activity). A query matches names, branches, project
 * names, and environment types so containerized environments appear alongside
 * local worktrees.
 */
export function buildProjectSearchResults({
  query,
  filter,
  projects,
  environments,
  recentProjectIds,
  defaultBranches,
  recentLimit = PROJECT_SEARCH_RECENT_LIMIT,
  resultLimit = PROJECT_SEARCH_RESULT_LIMIT,
}: {
  query: string;
  filter: ProjectSearchFilter;
  projects: Project[];
  environments: Environment[];
  recentProjectIds: string[];
  defaultBranches: ReadonlyMap<string, string>;
  recentLimit?: number;
  resultLimit?: number;
}): ProjectSearchResults {
  const tokens = parseProjectSearchQuery(query);
  const limit = tokens.length === 0 ? recentLimit : resultLimit;
  const recentIndex = new Map(recentProjectIds.map((id, index) => [id, index]));
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const includeProjects = filter !== "environments";
  const includeEnvironments = filter !== "projects";

  const environmentCountByProject = new Map<string, number>();
  for (const environment of environments) {
    environmentCountByProject.set(
      environment.projectId,
      (environmentCountByProject.get(environment.projectId) ?? 0) + 1,
    );
  }

  const projectHits: ProjectSearchProjectHit[] = [];
  if (includeProjects) {
    for (const project of projects) {
      const score = scoreHaystacks(
        [
          project.name,
          ...projectRepoHaystacks(project.gitUrl),
          pathBasename(project.localPath ?? ""),
        ],
        tokens,
      );
      if (score === null) continue;
      projectHits.push({
        type: "project",
        id: project.id,
        project,
        environmentCount: environmentCountByProject.get(project.id) ?? 0,
        score,
      });
    }
    projectHits.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return compareProjectsByRecency(left.project, right.project, recentIndex);
    });
  }

  const environmentHits: ProjectSearchEnvironmentHit[] = [];
  if (includeEnvironments) {
    for (const environment of environments) {
      const project = projectsById.get(environment.projectId);
      if (!project) continue;
      const score = scoreHaystacks(
        [
          environment.name,
          environment.branch,
          project.name,
          ...projectRepoHaystacks(project.gitUrl),
          environment.environmentType,
          pathBasename(environment.worktreePath ?? ""),
        ],
        tokens,
      );
      if (score === null) continue;
      const defaultBranch = defaultBranches.get(project.id) ?? "main";
      environmentHits.push({
        type: "environment",
        id: environment.id,
        environment,
        project,
        isPrimary: environment.branch === defaultBranch,
        score,
      });
    }
    environmentHits.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return compareEnvironmentsByRecency(left.environment, right.environment);
    });
  }

  return {
    projects: projectHits.slice(0, limit),
    environments: environmentHits.slice(0, limit),
  };
}

export function flattenProjectSearchResults(results: ProjectSearchResults): ProjectSearchHit[] {
  return [...results.projects, ...results.environments];
}
