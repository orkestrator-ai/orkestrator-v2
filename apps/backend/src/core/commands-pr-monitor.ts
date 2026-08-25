import { PrMonitorService, runCommand } from "./commands-dependencies.js";
import type {
  Environment,
  PrDetection,
  PrMonitorKanbanTask,
  PrMonitorTarget,
  StorageService,
} from "./commands-dependencies.js";
import { withContainerRuntimeCredential } from "./commands-runtime-state.js";
import { quoteShell } from "./commands-agent-support.js";
import {
  parsePrDetectionOutput,
  parseKnownPrDetectionOutput,
  validatePrDetectionBranch,
} from "./commands-review.js";
import { dockerExec } from "./commands-container-exec.js";
import type { PrDetectionResult } from "./commands-review.js";
import type { CommandContext, BackendEmit } from "./commands-context.js";

/**
 * Merge cleanup is owned by `commands-servers` (it ends in
 * `deleteEnvironmentTask`), but it is triggered here, when the monitor first
 * observes a merged PR. Importing it directly made this module a back-edge into
 * `commands-servers`, which imports the monitor service in turn.
 *
 * `commands-servers` registers the scheduler at its own module scope, so the
 * only window in which one can arrive unregistered is before that module has
 * finished evaluating. Requests in that window are held and replayed on
 * registration rather than dropped - `scheduleMergeCleanupRecovery` already
 * de-duplicates per environment, so a replay is a no-op if it also ran later.
 */
type MergeCleanupScheduler = (environmentId: string, context: CommandContext) => void;

let mergeCleanupScheduler: MergeCleanupScheduler | undefined;
/** Keyed by environment id, so a repeated observation cannot grow this. */
const deferredMergeCleanups = new Map<string, CommandContext>();
const MAX_DEFERRED_MERGE_CLEANUPS = 256;

export function setMergeCleanupScheduler(scheduler: MergeCleanupScheduler): void {
  mergeCleanupScheduler = scheduler;
  const deferred = [...deferredMergeCleanups];
  deferredMergeCleanups.clear();
  for (const [environmentId, context] of deferred) scheduler(environmentId, context);
}

export function requestMergeCleanupRecovery(environmentId: string, context: CommandContext): void {
  if (mergeCleanupScheduler) {
    mergeCleanupScheduler(environmentId, context);
    return;
  }
  if (
    deferredMergeCleanups.size >= MAX_DEFERRED_MERGE_CLEANUPS &&
    !deferredMergeCleanups.has(environmentId)
  ) {
    console.warn(
      "[pr-monitor] Dropping merge cleanup request: no scheduler registered and the deferred set is full",
    );
    return;
  }
  deferredMergeCleanups.set(environmentId, context);
}

/** Test seam: forget the registration so a suite can observe the deferred path. */
export function resetMergeCleanupSchedulerForTesting(): void {
  mergeCleanupScheduler = undefined;
  deferredMergeCleanups.clear();
}

export function deferredMergeCleanupCountForTesting(): number {
  return deferredMergeCleanups.size;
}

export let prMonitorEmit: BackendEmit | undefined;
export let prMonitorStorage: StorageService | undefined;
export let prMonitorContext: CommandContext | undefined;
export let prMonitorSyncGeneration = 0;
export let prMonitorSyncQueue: Promise<void> = Promise.resolve();

export function setPrMonitorRuntime(context: CommandContext): void {
  prMonitorEmit = context.emit;
  prMonitorStorage = context.storage;
  prMonitorContext = context;
}

export function requirePrMonitorStorage(): StorageService {
  if (!prMonitorStorage) throw new Error("PR monitor storage is not initialised");
  return prMonitorStorage;
}

export type StoredKanbanTask = Awaited<ReturnType<StorageService["getKanbanTasks"]>>[number];

/**
 * Finds the kanban task linked to an environment: directly via the task's
 * `environmentId`, or through a persisted build pipeline for tasks launched by
 * the build flow (which associates the pipeline, not the task, with the
 * environment). Mirrors the renderer's `findTaskForEnvironment`.
 */
export async function findKanbanTaskForEnvironment(
  storage: StorageService,
  environmentId: string,
): Promise<PrMonitorKanbanTask | null> {
  const environment = await storage.getEnvironment(environmentId);
  if (!environment) return null;
  const tasks = await storage.getKanbanTasks(environment.projectId);
  let task: StoredKanbanTask | undefined = tasks.find(
    (candidate) => candidate.environmentId === environmentId,
  );
  if (!task) {
    const pipelines = await storage.listBuildPipelines(environment.projectId);
    for (const pipeline of pipelines) {
      if (pipeline.environmentId !== environmentId) continue;
      const snapshot = pipeline.snapshot as Record<string, unknown> | null | undefined;
      if (typeof snapshot?.taskId !== "string" || !snapshot.taskId) continue;
      const source = snapshot.source as Record<string, unknown> | undefined;
      if (source !== undefined && source?.type !== "kanban") continue;
      task = tasks.find((candidate) => candidate.id === snapshot.taskId);
      if (task) break;
      // The pipeline knows the task id but the task body is not in this
      // project's board (or was pruned); operate on the id alone.
      return {
        taskId: snapshot.taskId,
        status: null,
        prUrl: null,
        prState: null,
        prMergeCommented: false,
        hasCommentText: () => false,
      };
    }
  }
  if (!task) return null;
  const located = task;
  return {
    taskId: located.id,
    status: located.status,
    prUrl: located.prUrl ?? null,
    prState: located.prState ?? null,
    prMergeCommented: located.prMergeCommented === true,
    hasCommentText: (text) => located.comments.some((comment) => comment.text === text),
  };
}

export interface PrMonitorDetectionRequest {
  args: string[];
  shellCommand: string;
  knownPrUrl: string | null;
  branch: string;
}

/**
 * Selects immutable-URL lookup while a known PR is nonterminal. A branch
 * lookup is suitable for discovery but GitHub commonly deletes the head branch
 * as part of merging, at which point it can no longer find the open PR whose
 * terminal state the monitor still needs to observe. Once terminal, branch
 * discovery resumes so a replacement PR on the same branch can be found.
 */
export function getPrMonitorDetectionRequest(target: PrMonitorTarget): PrMonitorDetectionRequest {
  const headBranch = validatePrDetectionBranch(target.branch);
  if (target.prUrl && target.prState !== "merged" && target.prState !== "closed") {
    const args = ["pr", "view", target.prUrl, "--json", "url,state,mergeable"];
    return {
      args,
      shellCommand: `gh pr view ${quoteShell(target.prUrl)} --json url,state,mergeable`,
      knownPrUrl: target.prUrl,
      branch: headBranch,
    };
  }
  const args = [
    "pr",
    "list",
    "--head",
    headBranch,
    "--state",
    "all",
    "--limit",
    "30",
    "--json",
    "url,state,mergeable,updatedAt",
  ];
  return {
    args,
    shellCommand: `gh pr list --head ${quoteShell(headBranch)} --state all --limit 30 --json url,state,mergeable,updatedAt`,
    knownPrUrl: null,
    branch: headBranch,
  };
}

export function parsePrMonitorDetectionResponse(
  request: PrMonitorDetectionRequest,
  stdout: string,
): PrDetectionResult | null {
  return request.knownPrUrl
    ? parseKnownPrDetectionOutput(stdout, request.knownPrUrl)
    : parsePrDetectionOutput(stdout, request.branch);
}

/**
 * Resolve the branch from the live checkout when possible.
 *
 * Stored environment data from versions with the manual-rename bug can name a
 * branch that Git never adopted. PR discovery must follow the branch an agent
 * can actually push, while a stopped/unavailable/detached checkout safely falls
 * back to the stored value.
 */
export async function resolvePrDetectionBranch(target: PrMonitorTarget): Promise<string> {
  const fallback = validatePrDetectionBranch(target.branch);
  let stdout: string | null = null;
  if (target.kind === "local") {
    if (!target.worktreePath) return fallback;
    stdout = await runCommand("git", ["-C", target.worktreePath, "branch", "--show-current"], {
      timeoutMs: 10_000,
    }).then(
      (result) => result.stdout,
      () => null,
    );
  } else {
    if (!target.containerId) return fallback;
    stdout = await dockerExec(
      target.containerId,
      "git -C /workspace branch --show-current",
      10_000,
    ).then(
      (result) => result,
      () => null,
    );
  }
  const liveBranch = stdout?.trim();
  return liveBranch ? validatePrDetectionBranch(liveBranch) : fallback;
}

/** Runs immutable lookup for known PRs and branch discovery for unknown PRs. */
export async function detectEnvironmentPullRequest(
  target: PrMonitorTarget,
): Promise<PrDetection | null> {
  const detectionTarget =
    target.prUrl && target.prState !== "merged" && target.prState !== "closed"
      ? target
      : { ...target, branch: await resolvePrDetectionBranch(target) };
  const request = getPrMonitorDetectionRequest(detectionTarget);
  if (target.kind === "local") {
    if (!target.worktreePath) throw new Error("Local environment has no worktree path");
    const { stdout } = await runCommand("gh", request.args, {
      cwd: target.worktreePath,
      timeoutMs: 30_000,
    });
    return parsePrMonitorDetectionResponse(request, stdout);
  }
  if (!target.containerId) throw new Error("Container environment has no container id");
  const output = await dockerExec(
    target.containerId,
    withContainerRuntimeCredential(request.shellCommand),
  );
  return parsePrMonitorDetectionResponse(request, output);
}

export const prMonitorService = new PrMonitorService({
  emit: (event, payload) => prMonitorEmit?.(event, payload),
  effects: {
    detect: (target) => detectEnvironmentPullRequest(target),
    persistPr: async (environmentId, detection) => {
      await requirePrMonitorStorage().updateEnvironment(environmentId, {
        prUrl: detection.url,
        prState: detection.state,
        hasMergeConflicts: detection.hasMergeConflicts,
        ...(detection.state !== "open" || detection.hasMergeConflicts === false
          ? { prRecheckAfterAgentCompletionArmedAt: undefined }
          : {}),
      });
      if (detection.state === "merged" && prMonitorContext) {
        requestMergeCleanupRecovery(environmentId, prMonitorContext);
      }
    },
    clearPr: async (environmentId) => {
      await requirePrMonitorStorage().updateEnvironment(environmentId, {
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        prRecheckAfterAgentCompletionArmedAt: undefined,
      });
    },
    findTaskForEnvironment: (environmentId) =>
      findKanbanTaskForEnvironment(requirePrMonitorStorage(), environmentId),
    moveTaskToReview: async (taskId) => {
      await requirePrMonitorStorage().updateKanbanTask(taskId, { status: "review" });
    },
    addTaskComment: async (taskId, text) => {
      await requirePrMonitorStorage().addKanbanComment(taskId, text);
    },
    updateTaskPrMetadata: async (taskId, updates) => {
      await requirePrMonitorStorage().updateKanbanTask(taskId, updates);
    },
  },
  onWarning: (message, error) => {
    console.warn(`[pr-monitor] ${message}:`, error instanceof Error ? error.message : error);
  },
});

export function environmentToPrMonitorTarget(environment: Environment): PrMonitorTarget {
  const kind =
    environment.environmentType === "local" ? ("local" as const) : ("container" as const);
  return {
    environmentId: environment.id,
    branch: environment.branch,
    kind,
    worktreePath: environment.worktreePath,
    containerId: environment.containerId ?? undefined,
    ready:
      kind === "local"
        ? !!environment.worktreePath
        : environment.status === "running" && !!environment.containerId,
    prUrl: environment.prUrl ?? null,
    prState: environment.prState ?? null,
    hasMergeConflicts: environment.hasMergeConflicts ?? null,
  };
}

export function invalidatePendingPrMonitorSync(): void {
  prMonitorSyncGeneration += 1;
}

export async function syncPrMonitorTracking(context: CommandContext): Promise<void> {
  prMonitorEmit = context.emit;
  prMonitorStorage = context.storage;
  prMonitorContext = context;
  const generation = prMonitorSyncGeneration;
  const operation = prMonitorSyncQueue
    .catch(() => undefined)
    .then(async () => {
      const environments = await context.storage.loadEnvironments();
      // A stop, delete, shutdown, or newer reconciliation may have happened
      // while storage was loading; applying this older snapshot would recreate
      // a poller the later lifecycle action deliberately removed.
      if (generation !== prMonitorSyncGeneration) return;
      prMonitorService.sync(environments.map(environmentToPrMonitorTarget));
    });
  prMonitorSyncQueue = operation;
  await operation;
}

export async function reconcileConfirmedMerge(
  environment: Environment,
  context: CommandContext,
): Promise<void> {
  if (!environment.prUrl) return;
  prMonitorEmit = context.emit;
  prMonitorStorage = context.storage;
  prMonitorContext = context;
  const confirmedEnvironment: Environment = {
    ...environment,
    prState: "merged",
    hasMergeConflicts: false,
  };
  await prMonitorService.reconcileTerminal(environmentToPrMonitorTarget(confirmedEnvironment), {
    url: environment.prUrl,
    state: "merged",
    hasMergeConflicts: false,
  });
}

/** Releases every PR polling timer; called on backend shutdown. */
export function shutdownPrMonitorTracking(): void {
  invalidatePendingPrMonitorSync();
  prMonitorService.shutdown();
}

/** Untracked files whose lines are counted at once during a local git status. */
