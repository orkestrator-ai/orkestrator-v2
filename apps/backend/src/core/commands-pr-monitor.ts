import { PrMonitorService, runCommand } from "./commands-dependencies.js";
import type { Environment, PrDetection, PrMonitorKanbanTask, PrMonitorTarget, StorageService } from "./commands-dependencies.js";
import { withContainerRuntimeCredential } from "./commands-runtime-state.js";
import { quoteShell } from "./commands-agent-support.js";
import { parsePrDetectionOutput, parseKnownPrDetectionOutput, validatePrDetectionBranch } from "./commands-review.js";
import { dockerExec } from "./commands-environment.js";
import { scheduleMergeCleanupRecovery } from "./commands-servers.js";
import type { PrDetectionResult } from "./commands-review.js";
import type { CommandContext, BackendEmit } from "./commands-context.js";

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
export function getPrMonitorDetectionRequest(
  target: PrMonitorTarget,
): PrMonitorDetectionRequest {
  const headBranch = validatePrDetectionBranch(target.branch);
  if (target.prUrl && target.prState !== "merged" && target.prState !== "closed") {
    const args = [
      "pr",
      "view",
      target.prUrl,
      "--json",
      "url,state,mergeable",
    ];
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

/** Runs immutable lookup for known PRs and branch discovery for unknown PRs. */
export async function detectEnvironmentPullRequest(
  target: PrMonitorTarget,
): Promise<PrDetection | null> {
  const request = getPrMonitorDetectionRequest(target);
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
        ...(
          detection.state !== "open" || detection.hasMergeConflicts === false
            ? { prRecheckAfterAgentCompletionArmedAt: undefined }
            : {}
        ),
      });
      if (detection.state === "merged" && prMonitorContext) {
        scheduleMergeCleanupRecovery(environmentId, prMonitorContext);
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
  const kind = environment.environmentType === "local" ? "local" as const : "container" as const;
  return {
    environmentId: environment.id,
    branch: environment.branch,
    kind,
    worktreePath: environment.worktreePath,
    containerId: environment.containerId ?? undefined,
    ready: kind === "local"
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
  await prMonitorService.reconcileTerminal(
    environmentToPrMonitorTarget(confirmedEnvironment),
    {
      url: environment.prUrl,
      state: "merged",
      hasMergeConflicts: false,
    },
  );
}

/** Releases every PR polling timer; called on backend shutdown. */
export function shutdownPrMonitorTracking(): void {
  invalidatePendingPrMonitorSync();
  prMonitorService.shutdown();
}

/** Untracked files whose lines are counted at once during a local git status. */
