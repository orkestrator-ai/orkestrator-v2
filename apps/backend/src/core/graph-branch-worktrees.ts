/**
 * Isolated branch worktrees of graph runs (item 403, D3, report §6.7): where
 * a replicated writer's branches write, and who removes them.
 *
 * - **Where.** One Git worktree per isolated activation, inside the
 *   environment root at `.orkestrator/graph-branches/<run>/<node>/i<n>/<branch>`
 *   on the branch `orkestrator-graph/<run>/<node>/i<n>/<branch>` (names in the
 *   protocol's `graphs/isolation.ts`). Git runs at the environment root
 *   through the backend's environment command runner: on the host in the
 *   worktree, in a container through `docker exec -w /workspace`, so one
 *   relative path serves both and a container's branches live under
 *   `/workspace/.orkestrator/graph-branches/`. `.orkestrator/` is Git-excluded
 *   first, so the run's own checkout never sees a branch as a change.
 * - **Create.** `git worktree add -B <branch> <path> <base>`, after removing
 *   whatever an earlier attempt of the same position left there (a restart
 *   starts from the input commit again, item 210).
 * - **Directories live while their activation does.** {@link GraphBranchWorktreeJanitor}
 *   removes the directory of every isolated activation that is terminal,
 *   unless a newer live attempt of the same position recorded its own.
 *   Consumers (a select, an agent merge) need the branch, never the
 *   directory.
 * - **Branches live while the run does.** When the run ends the janitor
 *   deletes the run's branches and anything left under its directory, then
 *   prunes. `select-workspace` removes its candidates' at once.
 * - **Environment deletion** removes every run's branch worktrees and
 *   branches first ({@link removeEnvironmentGraphBranchWorktrees}).
 *
 * Removal never follows a symbolic link: a registered worktree goes through
 * `git worktree remove --force`, anything else through the confined
 * removers the graph artifact store uses. Nothing here logs a path's
 * content; errors are one bounded line.
 */
import path from "node:path";
import {
  GRAPH_BRANCH_WORKTREE_DIRECTORY,
  GRAPH_COMMIT_PATTERN,
  graphBranchWorktreePath,
  graphBranchWorktreeRef,
  graphNodeIsolated,
  graphRunBranchRefPrefix,
  graphRunBranchWorktreeDirectory,
  isGraphActivationTerminal,
  isGraphRunTerminal,
  parseGraphBranchWorktreePath,
  type GraphActivationWorktree,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import { CONTAINER_PINNED_ATTACHMENT_REMOVE } from "./commands-files.js";
import {
  createGitEnvironmentCommandRunner,
  ensureWorkspaceArtifactIsGitExcluded,
  type EnvironmentCommandRunner,
} from "./commands-review.js";
import type { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import { graphCommandErrorLine } from "./graph-system-environment.js";
import type { Environment } from "./models.js";
import { removeConfinedDirectory } from "./path-safety.js";

/** The environment root a container's Git runs in. */
const CONTAINER_ROOT = "/workspace";
const GIT_TIMEOUT_MS = 60_000;
/** Worktrees one listing may hold before the janitor refuses to judge it. */
const MAX_LISTED_WORKTREES = 4_096;
/** Branch refs one run may hold; more than this is not ours to delete blindly. */
const MAX_RUN_BRANCHES = 1_024;

export interface GraphBranchWorktreeDependencies {
  storage: {
    getEnvironment(environmentId: string): Promise<Environment | null>;
  };
  fence: Pick<EnvironmentMutationFence, "beginMutation">;
  /** Runs commands at the environment root (tests pass a recording runner). */
  createRunner?: (
    environment: Environment,
    fence: Pick<EnvironmentMutationFence, "beginMutation">,
  ) => EnvironmentCommandRunner;
  /** Makes `.orkestrator/` Git-excluded; default the review package's helper. */
  ensureExcluded?: (
    environment: Environment,
    runner: EnvironmentCommandRunner,
    relativePath: string,
  ) => Promise<void>;
  /** Removes an unregistered leftover directory (default: the confined removers). */
  removeDirectory?: (
    environment: Environment,
    runner: EnvironmentCommandRunner,
    relativePath: string,
  ) => Promise<void>;
  now?: () => Date;
}

/** A branch worktree Git lists, relative to the environment root. */
export interface GraphListedBranchWorktree {
  path: string;
  /** `refs/heads/…` stripped; absent for a detached worktree. */
  branch?: string;
}

export class GraphBranchWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphBranchWorktreeError";
  }
}

/** The absolute path of an environment-relative path, as the agent sees it. */
export function graphBranchAbsolutePath(environment: Environment, relative: string): string {
  if (environment.environmentType === "local") {
    if (!environment.worktreePath)
      throw new GraphBranchWorktreeError("The worktree is unavailable");
    return path.join(environment.worktreePath, relative);
  }
  return relative === "" ? CONTAINER_ROOT : `${CONTAINER_ROOT}/${relative}`;
}

/** The environment root as the agent sees it. */
export function graphBranchRoot(environment: Environment): string {
  return graphBranchAbsolutePath(environment, "");
}

/** `git worktree list --porcelain` → our branch worktrees, relative to the root. */
export function parseGraphBranchWorktreeList(output: string): GraphListedBranchWorktree[] {
  const listed: GraphListedBranchWorktree[] = [];
  let current: GraphListedBranchWorktree | null = null;
  const marker = `/${GRAPH_BRANCH_WORKTREE_DIRECTORY}/`;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (listed.length >= MAX_LISTED_WORKTREES) {
        throw new GraphBranchWorktreeError("Git lists too many worktrees to check");
      }
      const absolute = line.slice("worktree ".length).replaceAll("\\", "/");
      const at = absolute.lastIndexOf(marker);
      current = null;
      if (at < 0) continue;
      const relative = absolute.slice(at + 1);
      if (!parseGraphBranchWorktreePath(relative)) continue;
      current = { path: relative };
      listed.push(current);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return listed;
}

function errorLine(what: string, error: unknown): GraphBranchWorktreeError {
  return new GraphBranchWorktreeError(`${what}: ${graphCommandErrorLine(error)}`);
}

/** Creates, lists and removes branch worktrees in an environment. */
export class GraphBranchWorktrees {
  private readonly now: () => Date;

  constructor(private readonly dependencies: GraphBranchWorktreeDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  private runner(environment: Environment): EnvironmentCommandRunner {
    return (this.dependencies.createRunner ?? createGitEnvironmentCommandRunner)(
      environment,
      this.dependencies.fence,
    );
  }

  private git(runner: EnvironmentCommandRunner, args: string[]): Promise<string> {
    return runner("git", args, GIT_TIMEOUT_MS);
  }

  /**
   * The worktree of `activation` (an isolated branch), created fresh from
   * `baseRef`. Whatever an earlier attempt of the position left is removed
   * first. Throws {@link GraphBranchWorktreeError}.
   */
  async create(
    environment: Environment,
    run: Pick<GraphRun, "id">,
    activation: Pick<NodeActivation, "nodeId" | "iteration" | "branchKey">,
    baseRef: string,
  ): Promise<GraphActivationWorktree> {
    if (activation.branchKey === undefined) {
      throw new GraphBranchWorktreeError("Only a replicated node's branches get worktrees");
    }
    if (!GRAPH_COMMIT_PATTERN.test(baseRef)) {
      throw new GraphBranchWorktreeError("The branch's base is not a full commit SHA");
    }
    const position = {
      nodeId: activation.nodeId,
      iteration: activation.iteration,
      branchKey: activation.branchKey,
    };
    const relative = graphBranchWorktreePath(run.id, position);
    const branch = graphBranchWorktreeRef(run.id, position);
    const runner = this.runner(environment);
    try {
      await (this.dependencies.ensureExcluded ?? defaultEnsureExcluded)(
        environment,
        runner,
        relative,
      );
    } catch (error) {
      throw errorLine("The branch worktree directory is not Git-excluded", error);
    }
    try {
      await this.git(runner, ["cat-file", "-e", `${baseRef}^{commit}`]);
    } catch {
      throw new GraphBranchWorktreeError(
        `Commit ${baseRef.slice(0, 12)} is not in the environment's repository`,
      );
    }
    await this.removeOne(environment, runner, relative, await this.list(environment, runner));
    try {
      await this.git(runner, ["worktree", "add", "--quiet", "-B", branch, relative, baseRef]);
    } catch (error) {
      throw errorLine("Could not create the branch worktree", error);
    }
    return { path: relative, branch, baseRef, createdAt: this.now().toISOString() };
  }

  /** Every branch worktree Git lists in the environment (or of one run). */
  async list(
    environment: Environment,
    runner = this.runner(environment),
    runId?: string,
  ): Promise<GraphListedBranchWorktree[]> {
    let output: string;
    try {
      output = await this.git(runner, ["worktree", "list", "--porcelain"]);
    } catch (error) {
      throw errorLine("Could not list the worktrees", error);
    }
    const listed = parseGraphBranchWorktreeList(output);
    if (runId === undefined) return listed;
    const prefix = `${graphRunBranchWorktreeDirectory(runId)}/`;
    return listed.filter((entry) => entry.path.startsWith(prefix));
  }

  /** Removes one worktree directory: Git's registration, or a confined leftover. */
  private async removeOne(
    environment: Environment,
    runner: EnvironmentCommandRunner,
    relative: string,
    listed: readonly GraphListedBranchWorktree[],
  ): Promise<void> {
    if (listed.some((entry) => entry.path === relative)) {
      try {
        await this.git(runner, ["worktree", "remove", "--force", "--force", relative]);
      } catch (error) {
        throw errorLine("Could not remove the branch worktree", error);
      }
    } else {
      // An unregistered leftover (a crash between `add` and its record, or a
      // registration pruned by hand) would make `worktree add` refuse.
      await (this.dependencies.removeDirectory ?? defaultRemoveDirectory)(
        environment,
        runner,
        relative,
      ).catch((error: unknown) => {
        throw errorLine("Could not remove a leftover branch directory", error);
      });
    }
    await this.git(runner, ["worktree", "prune"]).catch(() => undefined);
  }

  /** Removes worktree directories (idempotent); returns how many failed. */
  async removeWorktrees(environment: Environment, paths: readonly string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const runner = this.runner(environment);
    const listed = await this.list(environment, runner);
    let failed = 0;
    for (const relative of paths) {
      if (!parseGraphBranchWorktreePath(relative)) {
        failed++;
        continue;
      }
      try {
        await this.removeOne(environment, runner, relative, listed);
      } catch {
        failed++;
      }
    }
    return failed;
  }

  /** Deletes branches of one run (idempotent); returns how many failed. */
  async deleteBranches(
    environment: Environment,
    runId: string,
    branches: readonly string[],
  ): Promise<number> {
    const prefix = graphRunBranchRefPrefix(runId);
    const ours = branches.filter((branch) => branch.startsWith(prefix));
    if (ours.length === 0) return branches.length;
    const runner = this.runner(environment);
    let failed = branches.length - ours.length;
    for (const branch of ours) {
      try {
        await this.git(runner, ["branch", "-D", "--quiet", branch]);
      } catch (error) {
        if (!/not found|no branch named/i.test(graphCommandErrorLine(error))) failed++;
      }
    }
    return failed;
  }

  /**
   * Everything a run left: its worktrees, its directory and its branches.
   * Idempotent; returns how many steps failed.
   */
  async removeRun(environment: Environment, runId: string): Promise<number> {
    const runner = this.runner(environment);
    let failed = 0;
    try {
      const listed = await this.list(environment, runner, runId);
      for (const entry of listed) {
        try {
          await this.removeOne(environment, runner, entry.path, listed);
        } catch {
          failed++;
        }
      }
    } catch {
      failed++;
    }
    await (this.dependencies.removeDirectory ?? defaultRemoveDirectory)(
      environment,
      runner,
      graphRunBranchWorktreeDirectory(runId),
    ).catch(() => {
      failed++;
    });
    let branches: string[] = [];
    try {
      branches = (
        await this.git(runner, [
          "for-each-ref",
          "--format=%(refname:short)",
          `refs/heads/${graphRunBranchRefPrefix(runId)}`,
        ])
      )
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      failed++;
    }
    if (branches.length > MAX_RUN_BRANCHES) return failed + 1;
    failed += branches.length > 0 ? await this.deleteBranches(environment, runId, branches) : 0;
    await this.git(runner, ["worktree", "prune"]).catch(() => undefined);
    return failed;
  }
}

async function defaultEnsureExcluded(
  environment: Environment,
  runner: EnvironmentCommandRunner,
  relativePath: string,
): Promise<void> {
  await ensureWorkspaceArtifactIsGitExcluded(
    environment,
    runner,
    relativePath,
    "The branch worktree directory",
  );
}

/** The confined removers the graph artifact store uses (never follow a link). */
async function defaultRemoveDirectory(
  environment: Environment,
  runner: EnvironmentCommandRunner,
  relativePath: string,
): Promise<void> {
  if (environment.environmentType === "local") {
    if (!environment.worktreePath) return;
    await removeConfinedDirectory(environment.worktreePath, relativePath);
    return;
  }
  await runner(
    "node",
    ["-e", CONTAINER_PINNED_ATTACHMENT_REMOVE, CONTAINER_ROOT, relativePath],
    30_000,
  );
}

// ---------------------------------------------------------------- the janitor

/** The worktrees an isolated run no longer needs, from its record alone. */
export function graphBranchWorktreesToRemove(run: GraphRun): GraphActivationWorktree[] {
  const isolated = new Set(run.plan.nodes.filter(graphNodeIsolated).map((node) => node.id));
  if (isolated.size === 0) return [];
  const live = new Set<string>();
  for (const activation of run.activations) {
    if (activation.worktree && !isGraphActivationTerminal(activation.state)) {
      live.add(activation.worktree.path);
    }
  }
  const removable = new Map<string, GraphActivationWorktree>();
  for (const activation of run.activations) {
    const worktree = activation.worktree;
    if (!worktree || !isolated.has(activation.nodeId)) continue;
    if (!isGraphActivationTerminal(activation.state) || live.has(worktree.path)) continue;
    removable.set(worktree.path, worktree);
  }
  return [...removable.values()];
}

export interface GraphBranchWorktreeJanitorDependencies {
  worktrees: GraphBranchWorktrees;
  storage: { getEnvironment(environmentId: string): Promise<Environment | null> };
}

/** How many runs' cleanup state one process keeps (oldest forgotten first). */
const MAX_TRACKED_RUNS = 512;

/**
 * Removes what isolated branches no longer need, after each saved record of
 * their run (the service calls it under the run's lock). Remembers per run
 * what it already removed, so a pass without news costs no Git call; a
 * removal that failed is tried again after the next save.
 */
export class GraphBranchWorktreeJanitor {
  private readonly removed = new Map<string, Set<string>>();
  private readonly finished = new Set<string>();

  constructor(private readonly dependencies: GraphBranchWorktreeJanitorDependencies) {}

  /** Whether {@link reconcile} would do anything for this record (cheap, no I/O). */
  wants(run: GraphRun): boolean {
    if (run.mock || !run.environmentId) return false;
    if (!run.plan.nodes.some(graphNodeIsolated)) return false;
    if (isGraphRunTerminal(run.status)) {
      // A run whose branches never started made nothing to remove.
      return !this.finished.has(run.id) && run.activations.some((entry) => entry.worktree);
    }
    // A restart reopened a finished run: its new branches are owed a cleanup.
    this.finished.delete(run.id);
    const done = this.removed.get(run.id);
    return graphBranchWorktreesToRemove(run).some((worktree) => !done?.has(worktree.path));
  }

  async reconcile(run: GraphRun): Promise<void> {
    if (!this.wants(run)) return;
    const environment = await this.dependencies.storage.getEnvironment(run.environmentId!);
    if (!environment) return;
    if (environment.environmentType !== "local" && environment.status !== "running") return;
    if (isGraphRunTerminal(run.status)) {
      const failed = await this.dependencies.worktrees.removeRun(environment, run.id);
      if (failed === 0) {
        this.finished.add(run.id);
        this.removed.delete(run.id);
        this.bound();
      }
      return;
    }
    const done = this.removed.get(run.id) ?? new Set<string>();
    const due = graphBranchWorktreesToRemove(run).filter((worktree) => !done.has(worktree.path));
    for (const worktree of due) {
      const failed = await this.dependencies.worktrees.removeWorktrees(environment, [
        worktree.path,
      ]);
      if (failed === 0) done.add(worktree.path);
    }
    this.removed.set(run.id, done);
    this.bound();
  }

  /** A newer attempt of a position reuses its path: forget that it was removed. */
  forgetPath(runId: string, relative: string): void {
    this.removed.get(runId)?.delete(relative);
  }

  private bound(): void {
    while (this.removed.size > MAX_TRACKED_RUNS) {
      this.removed.delete(this.removed.keys().next().value!);
    }
    while (this.finished.size > MAX_TRACKED_RUNS) {
      this.finished.delete(this.finished.values().next().value!);
    }
  }
}

/**
 * Environment deletion's branch step: every run's branch worktrees and
 * branches, while the worktree and container still exist. A stopped
 * container is skipped (its storage goes with it). Never throws.
 */
export async function removeEnvironmentGraphBranchWorktrees(
  environment: Environment,
  dependencies: Pick<GraphBranchWorktreeDependencies, "fence" | "createRunner"> & {
    storage: {
      graphRuns: {
        listGraphRunIds(environmentId: string): Promise<string[]>;
        getGraphRun(runId: string): Promise<GraphRun | null>;
      };
    };
  },
): Promise<{ removed: number; failed: number }> {
  try {
    const runIds: string[] = [];
    for (const runId of await dependencies.storage.graphRuns.listGraphRunIds(environment.id)) {
      // Only runs with isolated nodes ever made branches (an unreadable one may have).
      const run = await dependencies.storage.graphRuns.getGraphRun(runId).catch(() => null);
      if (!run || (!run.mock && run.plan.nodes.some(graphNodeIsolated))) runIds.push(runId);
    }
    if (runIds.length === 0) return { removed: 0, failed: 0 };
    if (environment.environmentType !== "local" && environment.status !== "running") {
      return { removed: 0, failed: 0 };
    }
    const worktrees = new GraphBranchWorktrees({
      storage: { getEnvironment: async () => environment },
      fence: dependencies.fence,
      ...(dependencies.createRunner ? { createRunner: dependencies.createRunner } : {}),
    });
    let removed = 0;
    let failed = 0;
    for (const runId of runIds) {
      const failures = await worktrees.removeRun(environment, runId).catch(() => 1);
      if (failures === 0) removed++;
      else failed++;
    }
    return { removed, failed };
  } catch {
    return { removed: 0, failed: 1 };
  }
}
