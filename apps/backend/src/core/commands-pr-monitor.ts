import { gitHubCli } from "./github-cli-binary.js";
import { gitHubCliEnv } from "./github-credentials.js";
import { runCommand } from "./shell.js";
import type { Environment } from "./models.js";
import type { PrDetection, PrMonitorKanbanTask, PrMonitorTarget } from "./pr-monitor.js";
import type { KanbanStorage, StorageService } from "./storage.js";
import { withContainerRuntimeCredential } from "./container-scripts.js";
import { quoteShell } from "./commands-agent-support.js";
import {
  parsePrCheckSummary,
  parsePrDetectionOutput,
  parseKnownPrDetectionOutput,
  validatePrDetectionBranch,
} from "./commands-review.js";
import { dockerExec } from "./commands-container-exec.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import type { PrDetectionResult } from "./commands-review.js";
import { readCheckoutBranch, reconcileProjectHomeEnvironment } from "./project-home-environment.js";
import {
  parsePrViewerPermission,
  PR_VIEWER_PERMISSION_TIMEOUT_MS,
  prViewerPermissionArgs,
  prViewerPermissionScope,
  prViewerRepository,
  type PrViewerPermissionCache,
} from "./pr-viewer-permission.js";

export type StoredKanbanTask = Awaited<ReturnType<KanbanStorage["getKanbanTasks"]>>[number];

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
  const tasks = await storage.kanban.getKanbanTasks(environment.projectId);
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
  homeBase?: string;
}

export interface PrMonitorCheckRequest {
  args: string[];
  shellCommand: string;
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
    const args = [
      "pr",
      "view",
      target.prUrl,
      "--json",
      target.projectHome
        ? "url,state,headRefOid,mergeable,mergeStateStatus,isDraft,headRefName,baseRefName,isCrossRepository"
        : "url,state,headRefOid,mergeable,mergeStateStatus,isDraft,baseRefName",
    ];
    return {
      args,
      shellCommand: `gh pr view ${quoteShell(target.prUrl)} --json ${args.at(-1)}`,
      knownPrUrl: target.prUrl,
      branch: headBranch,
      homeBase: target.projectHome ? target.defaultBranch : undefined,
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
    target.projectHome
      ? "url,state,headRefOid,mergeable,mergeStateStatus,isDraft,updatedAt,headRefName,baseRefName,isCrossRepository"
      : "url,state,headRefOid,mergeable,mergeStateStatus,isDraft,updatedAt,baseRefName,isCrossRepository",
  ];
  return {
    args,
    shellCommand: `gh pr list --head ${quoteShell(headBranch)} --state all --limit 30 --json ${args.at(-1)}`,
    knownPrUrl: null,
    branch: headBranch,
    homeBase: target.projectHome ? target.defaultBranch : undefined,
  };
}

/**
 * CI checks are intentionally fetched separately from authoritative PR
 * metadata. Some tokens can read pull requests but not check rollups; a badge
 * permission must never stop merge/close detection or linked-task updates.
 */
export function getPrMonitorCheckRequest(prUrl: string): PrMonitorCheckRequest {
  const args = ["pr", "view", prUrl, "--json", "statusCheckRollup,headRefOid"];
  return {
    args,
    shellCommand: `gh pr view ${quoteShell(prUrl)} --json statusCheckRollup,headRefOid`,
  };
}

export function parsePrMonitorCheckResponse(stdout: string, expectedHeadSha?: string | null) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Failed to parse gh PR check output");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Failed to parse gh PR check output");
  }
  if (expectedHeadSha && (parsed as Record<string, unknown>).headRefOid !== expectedHeadSha) {
    throw new Error("PR head changed while reading checks");
  }
  return parsePrCheckSummary((parsed as Record<string, unknown>).statusCheckRollup);
}

export function parsePrMonitorDetectionResponse(
  request: PrMonitorDetectionRequest,
  stdout: string,
): PrDetectionResult | null {
  if (request.homeBase || !request.knownPrUrl) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(
        request.knownPrUrl
          ? "Failed to parse gh pr view output"
          : "Failed to parse gh pr list output",
      );
    }
    if (!request.knownPrUrl && !Array.isArray(parsed))
      throw new Error("Failed to parse gh pr list output");
    const matches = (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).isCrossRepository === false &&
      (!request.homeBase ||
        ((entry as Record<string, unknown>).headRefName === request.branch &&
          (entry as Record<string, unknown>).baseRefName === request.homeBase));
    if (request.knownPrUrl) {
      if (!matches(parsed)) return null;
    } else {
      stdout = JSON.stringify(Array.isArray(parsed) ? parsed.filter(matches) : []);
    }
  }
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

/** Budget for one PR lookup at the `gh` boundary; the rollup has its own 10 s. */
export const PR_DETECTION_TIMEOUT_MS = 30_000;

/**
 * Host/auth scope for sharing a rate-limit cooldown.
 *
 * Every local environment runs the host's `gh` with the backend's own process
 * environment and the user's single `gh` configuration, and `gh` selects its
 * credential by GitHub host. Two local lookups against the same host therefore
 * provably share one credential and one rate-limit budget. The host is only
 * known from a stored PR URL; branch discovery without one has no provable
 * scope. Containers source their own runtime credential inside the container,
 * which the backend cannot prove equal across containers, so they never share.
 * Tokens are never read, hashed or logged for this.
 */
export function prMonitorCooldownScope(target: PrMonitorTarget): string | null {
  if (target.kind !== "local" || !target.prUrl) return null;
  try {
    const host = new URL(target.prUrl).host.toLowerCase();
    return host ? `local-gh:${host}` : null;
  } catch {
    return null;
  }
}

/**
 * Adds the cached merge permission to an open PR's detection, asking GitHub
 * through the same runner only when the cache has no current answer. Never
 * fails the detection: a lookup error leaves the permission unknown.
 */
async function withViewerPermission<T extends PrDetectionResult>(
  detection: T,
  target: PrMonitorTarget,
  cache: PrViewerPermissionCache | undefined,
  runGh: (args: string[]) => Promise<string>,
): Promise<T & Pick<PrDetection, "viewerCanMerge">> {
  if (!cache || detection.state !== "open") return detection;
  const repository = prViewerRepository(detection.url);
  const scope = prViewerPermissionScope(target);
  if (!repository || !scope) return { ...detection, viewerCanMerge: null };
  const viewerCanMerge = await cache.resolve(scope, repository, async () =>
    parsePrViewerPermission(await runGh(prViewerPermissionArgs(repository))),
  );
  return { ...detection, viewerCanMerge };
}

/** Runs immutable lookup for known PRs and branch discovery for unknown PRs. */
export async function detectEnvironmentPullRequest(
  target: PrMonitorTarget,
  options: {
    includeCheckSummary?: boolean;
    /**
     * Rereads a project home's durable record first, so a lookup follows the
     * home's current checkout rather than the target captured when it was queued.
     * Also supplies the selected GitHub credential for local `gh` runs;
     * omitting storage uses the host login.
     */
    storage?: StorageService;
    /** Fills `viewerCanMerge` for an open PR; omitted, it stays absent. */
    viewerPermissions?: PrViewerPermissionCache;
  } = {},
): Promise<PrDetection | null> {
  if (target.projectHome) {
    if (options.storage) {
      const current = await options.storage.getEnvironment(target.environmentId);
      if (!current) return null;
      target = await projectHomePrTarget(current, options.storage);
    }
    if (!target.ready) return null;
    const branch = target.worktreePath ? await readCheckoutBranch(target.worktreePath) : "";
    if (!branch || !target.defaultBranch || branch === target.defaultBranch) return null;
    target = {
      ...target,
      branch,
      ...(branch !== target.branch ? { prUrl: null, prState: null } : {}),
    };
  }
  const detectionTarget =
    target.prUrl && target.prState !== "merged" && target.prState !== "closed"
      ? target
      : { ...target, branch: await resolvePrDetectionBranch(target) };
  const request = getPrMonitorDetectionRequest(detectionTarget);
  if (target.kind === "local") {
    if (!target.worktreePath) throw new Error("Local environment has no worktree path");
    const { stdout } = await runCommand(gitHubCli(), request.args, {
      cwd: target.worktreePath,
      timeoutMs: PR_DETECTION_TIMEOUT_MS,
      env: await gitHubCliEnv(options.storage),
    });
    const worktreePath = target.worktreePath;
    const parsed = parsePrMonitorDetectionResponse(request, stdout);
    if (!parsed) return null;
    const detection = await withViewerPermission(
      parsed,
      target,
      options.viewerPermissions,
      async (args) =>
        (
          await runCommand(gitHubCli(), args, {
            cwd: worktreePath,
            timeoutMs: PR_VIEWER_PERMISSION_TIMEOUT_MS,
            env: await gitHubCliEnv(options.storage),
          })
        ).stdout,
    );
    if (detection.state !== "open" || options.includeCheckSummary !== true) {
      return { ...detection, checkSummaryStatus: "skipped" };
    }
    const checkRequest = getPrMonitorCheckRequest(detection.url);
    try {
      recurringWorkMetrics.requested("pr-check-rollup");
      const checkSummary = await recurringWorkMetrics.observe("pr-check-rollup", async () =>
        parsePrMonitorCheckResponse(
          (
            await runCommand(gitHubCli(), checkRequest.args, {
              cwd: worktreePath,
              timeoutMs: 10_000,
              env: await gitHubCliEnv(options.storage),
            })
          ).stdout,
          detection.headSha,
        ),
      );
      return {
        ...detection,
        checkSummary,
        checkSummaryStatus: "succeeded",
      };
    } catch {
      return { ...detection, checkSummaryStatus: "failed" };
    }
  }
  if (!target.containerId) throw new Error("Container environment has no container id");
  // Same budget as the local `gh` call. The generic docker exec default is two
  // minutes, which would hold one of the two shared detection slots that long.
  const output = await dockerExec(
    target.containerId,
    withContainerRuntimeCredential(request.shellCommand),
    PR_DETECTION_TIMEOUT_MS,
  );
  const containerId = target.containerId;
  const parsed = parsePrMonitorDetectionResponse(request, output);
  if (!parsed) return null;
  const detection = await withViewerPermission(parsed, target, options.viewerPermissions, (args) =>
    dockerExec(
      containerId,
      withContainerRuntimeCredential(["gh", ...args].map(quoteShell).join(" ")),
      PR_VIEWER_PERMISSION_TIMEOUT_MS,
    ),
  );
  if (detection.state !== "open" || options.includeCheckSummary !== true) {
    return { ...detection, checkSummaryStatus: "skipped" };
  }
  const checkRequest = getPrMonitorCheckRequest(detection.url);
  try {
    recurringWorkMetrics.requested("pr-check-rollup");
    const checkSummary = await recurringWorkMetrics.observe("pr-check-rollup", async () =>
      parsePrMonitorCheckResponse(
        await dockerExec(
          containerId,
          withContainerRuntimeCredential(checkRequest.shellCommand),
          10_000,
        ),
        detection.headSha,
      ),
    );
    return {
      ...detection,
      checkSummary,
      checkSummaryStatus: "succeeded",
    };
  } catch {
    return { ...detection, checkSummaryStatus: "failed" };
  }
}

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
    prBaseBranch: environment.prBaseBranch ?? null,
    prState: environment.prState ?? null,
    hasMergeConflicts: environment.hasMergeConflicts ?? null,
    prMergeability: environment.prMergeability ?? null,
    projectHome: environment.projectHome,
  };
}

/** A home is eligible only on a live feature branch of its configured checkout. */
export async function projectHomePrTarget(
  environment: Environment,
  storage: StorageService,
): Promise<PrMonitorTarget> {
  if (!environment.projectHome) return environmentToPrMonitorTarget(environment);
  const current = await reconcileProjectHomeEnvironment(environment, storage);
  const { defaultBranch, prBaseBranch } = await storage.getRepositoryConfig(current.projectId);
  const baseBranch = prBaseBranch?.trim() || defaultBranch;
  const eligible =
    current.branch !== "HEAD" && current.branch !== defaultBranch && current.branch !== baseBranch;
  if (!eligible && current.prUrl) {
    await storage.updateEnvironment(current.id, {
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    });
  }
  return {
    ...environmentToPrMonitorTarget(current),
    defaultBranch: baseBranch,
    ready: eligible,
    ...(!eligible ? { prUrl: null, prState: null } : {}),
  };
}

/** Untracked files whose lines are counted at once during a local git status. */
