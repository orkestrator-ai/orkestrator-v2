import type { Environment, Project } from "./models.js";
import { runCommand } from "./shell.js";
import { resolveProjectGitRoot } from "./project-git-root.js";
import type { StorageService } from "./storage.js";

/**
 * The project home is the one environment whose working directory is the
 * project's own checkout (`Project.localPath`) instead of a disposable
 * worktree or container. It exists so review, multi-review, fix and PR
 * sessions can run on the main checkout through the ordinary environment
 * machinery (pane layout, native sessions, PR monitor, files panel).
 *
 * The checkout belongs to the user, so every path that assumes it owns a
 * disposable workspace must consult `isProjectHomeEnvironment` and leave the
 * directory and its branches alone: deletion only removes the record, start
 * never creates a worktree or runs setup scripts, a rename never renames the
 * checked-out branch, and a coordinator credential cannot target it.
 */
export function isProjectHomeEnvironment(
  environment: Pick<Environment, "projectHome"> | null | undefined,
): boolean {
  return environment?.projectHome === true;
}

export const PROJECT_HOME_ENVIRONMENT_NAME = "project-home";

/** Branch label stored for a detached checkout, which has no branch name. */
export const PROJECT_HOME_DETACHED_BRANCH = "HEAD";

export type ProjectHomeStorage = Pick<
  StorageService,
  "getProject" | "getEnvironmentsByProject" | "addEnvironment" | "updateEnvironment"
>;

export interface ProjectHomeDependencies {
  storage: ProjectHomeStorage;
  /** Canonical repository root of `Project.localPath`; throws when unusable. */
  resolveRoot: (project: Project) => Promise<string>;
  /** Current branch of the checkout, or an empty string when detached. */
  readBranch: (root: string) => Promise<string>;
  /** Builds an unsaved local environment record for the project. */
  createRecord: (projectId: string, name: string) => Environment;
  /** Clears runtime ids that belong to a previous run before reuse. */
  clearTerminalSessions?: (environmentId: string) => Promise<void>;
}

export interface EnsureProjectHomeResult {
  environment: Environment;
  created: boolean;
}

const ensureTasks = new Map<string, Promise<EnsureProjectHomeResult>>();

/** The live project home of `projectId`, if one has been created. */
export function findProjectHomeEnvironment(
  environments: readonly Environment[],
): Environment | undefined {
  return environments.find(
    (environment) => isProjectHomeEnvironment(environment) && !environment.deletionRequestedAt,
  );
}

/**
 * Returns the project's home environment, creating it on first use.
 *
 * Idempotent and serialized per project so two windows cannot create two
 * homes. Every call re-reads the checkout root and its current branch, so a
 * branch switched outside the environment (from the coordinator toolbar or a
 * terminal) is reflected before review or PR work starts. A branch change
 * clears PR metadata that belonged to the previous branch.
 */
export function ensureProjectHomeEnvironment(
  projectId: string,
  dependencies: ProjectHomeDependencies,
): Promise<EnsureProjectHomeResult> {
  const pending = ensureTasks.get(projectId);
  if (pending) return pending;
  const task = ensureOnce(projectId, dependencies).finally(() => {
    if (ensureTasks.get(projectId) === task) ensureTasks.delete(projectId);
  });
  ensureTasks.set(projectId, task);
  return task;
}

async function ensureOnce(
  projectId: string,
  {
    storage,
    resolveRoot,
    readBranch,
    createRecord,
    clearTerminalSessions,
  }: ProjectHomeDependencies,
): Promise<EnsureProjectHomeResult> {
  const project = await storage.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (!project.localPath?.trim()) {
    throw new Error("This project has no local checkout configured");
  }
  const root = await resolveRoot(project);
  const branch = (await readBranch(root)).trim() || PROJECT_HOME_DETACHED_BRANCH;

  const existing = findProjectHomeEnvironment(await storage.getEnvironmentsByProject(projectId));
  if (existing) {
    const updates: Record<string, unknown> = {};
    if (existing.worktreePath !== root) {
      updates.worktreePath = root;
      Object.assign(updates, { prUrl: null, prState: null, hasMergeConflicts: null });
    }
    Object.assign(updates, projectHomeBranchUpdates(existing, branch));
    if (existing.status !== "running") {
      await clearTerminalSessions?.(existing.id);
      updates.status = "running";
      updates.lifecycleError = null;
    }
    if (!existing.setupScriptsComplete || existing.setupPhase !== "ready") {
      updates.setupScriptsComplete = true;
      updates.setupPhase = "ready";
    }
    if (Object.keys(updates).length === 0) return { environment: existing, created: false };
    return {
      environment: await storage.updateEnvironment(existing.id, updates),
      created: false,
    };
  }

  const record = createRecord(projectId, PROJECT_HOME_ENVIRONMENT_NAME);
  const environment: Environment = {
    ...record,
    projectHome: true,
    environmentType: "local",
    networkAccessMode: "full",
    branch,
    worktreePath: root,
    // No creation commit: the checkout predates Orkestrator, so diffs compare
    // against the repository's PR base branch like any legacy environment.
    createdFromCommit: undefined,
    status: "running",
    setupScriptsComplete: true,
    setupPhase: "ready",
    setupOverride: false,
    pendingAgentLaunch: false,
    pendingRenamePrompt: undefined,
    initialPrompt: undefined,
  };
  return { environment: await storage.addEnvironment(environment), created: true };
}

/** Current branch of a checkout; an empty string when HEAD is detached. */
export async function readCheckoutBranch(root: string): Promise<string> {
  const { stdout } = await runCommand("git", ["-C", root, "branch", "--show-current"], {
    timeoutMs: 10_000,
  });
  return stdout.trim();
}

/** Update that records `branch` as the home's current branch, if it moved. */
export function projectHomeBranchUpdates(
  environment: Pick<Environment, "branch">,
  liveBranch: string,
): Record<string, unknown> | null {
  const branch = liveBranch.trim() || PROJECT_HOME_DETACHED_BRANCH;
  if (environment.branch === branch) return null;
  // A pull request is a fact about a branch; the old branch's PR no longer
  // describes what the checkout has checked out.
  return {
    branch,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    prRecheckAfterAgentCompletionArmedAt: undefined,
    cleanupAfterMergeRequestedAt: null,
    cleanupAfterMergeError: null,
  };
}

/**
 * Re-reads the checkout's current branch for a project home. A PR session in
 * the main checkout typically switches to a new branch before pushing, and PR
 * discovery searches by the stored branch, so the record must follow it.
 * Returns the environment unchanged for anything that is not a project home
 * or when the branch cannot be read.
 */
export async function refreshProjectHomeBranch(
  environment: Environment,
  storage: Pick<StorageService, "updateEnvironment">,
  readBranch: (root: string) => Promise<string>,
): Promise<Environment> {
  if (!isProjectHomeEnvironment(environment) || !environment.worktreePath) return environment;
  let liveBranch: string;
  try {
    liveBranch = await readBranch(environment.worktreePath);
  } catch {
    return environment;
  }
  const updates = projectHomeBranchUpdates(environment, liveBranch);
  return updates ? storage.updateEnvironment(environment.id, updates) : environment;
}

export const projectHomeTesting = {
  reset(): void {
    ensureTasks.clear();
  },
};

/** Reconcile against the configured checkout before exposing home actions. */
export async function reconcileProjectHomeEnvironment(
  environment: Environment,
  storage: StorageService,
): Promise<Environment> {
  if (!isProjectHomeEnvironment(environment)) return environment;
  const root = await resolveProjectGitRoot(storage, environment.projectId);
  const branch = await readCheckoutBranch(root);
  const updates = {
    ...(environment.worktreePath !== root
      ? {
          worktreePath: root,
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          cleanupAfterMergeRequestedAt: null,
          cleanupAfterMergeError: null,
        }
      : {}),
    ...projectHomeBranchUpdates(environment, branch),
  };
  return Object.keys(updates).length
    ? storage.updateEnvironment(environment.id, updates)
    : environment;
}
