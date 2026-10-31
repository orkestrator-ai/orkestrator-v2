import type {
  GitHubPullRequestComment,
  GitHubPullRequestDetail,
  GitHubPullRequestFiles,
  GitHubPullRequestInlineCommentInput,
  GitHubPullRequestLabel,
  GitHubPullRequestListResult,
  GitHubPullRequestMergeMethod,
  GitHubPullRequestRef,
  GitHubPullRequestReviewThreadComment,
  GitHubPullRequestTimeline,
  GitHubRepositoryMemberOption,
} from "@orkestrator/protocol/github-pull-requests";
import { parseGitHubPullRequestLink } from "@orkestrator/protocol/github-pull-requests";
import type { PublicActionName } from "@orkestrator/protocol/public-api";
import {
  PUBLIC_PR_BODY_MAX_CHARS,
  PUBLIC_PR_LIST_FILTERS,
  PUBLIC_PR_MERGE_METHODS,
  PUBLIC_PR_REVIEW_COMMENTS_MAX,
  PUBLIC_PR_REVIEW_EVENTS,
  PUBLIC_PR_REVIEWERS_MAX,
  PUBLIC_PR_SIDES,
} from "@orkestrator/protocol/public-api-inputs-pr";
import type { MergeEnvironmentPrResult } from "../commands-review.js";
import { sanitizeGitHubError } from "../github.js";
import type { Environment } from "../models.js";
import {
  isProjectHomeEnvironment,
  reconcileProjectHomeEnvironment,
} from "../project-home-environment.js";
import { requireEnvironment } from "./actions-discovery.js";
import { assertNotDeleting } from "./actions-environments.js";
import { runWithContinuation } from "./background.js";
import { boundedMessage, PublicActionError } from "./errors.js";
import {
  invalid,
  oneOf,
  onlyActionKeys,
  onlyKeys,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requiredId,
  requiredOneOf,
  requiredString,
} from "./input.js";
import type { PublicOperationRecord } from "./operation-ledger.js";
import { registerReconciler, type ReconcileFunction } from "./reconciler.js";
import type {
  ExecuteOutcome,
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * Pull request management: the in-app viewer's reads and writes and the action
 * bar's Merge and Merge and Cleanup buttons, addressed by environment.
 *
 * Each runs the backend twin of the button: `merge_environment_pr` with its
 * lifecycle guard, PR-monitor reconciliation and cleanup, and the viewer's
 * `*_github_pull_request*` commands with the Settings GitHub credential. Only
 * the pull request attached to the named environment can be changed, so a
 * credential can never reach an arbitrary pull request through this surface.
 *
 * Bodies and comment text are request content: they stay out of receipts and
 * results, which carry IDs, URLs and states only.
 */

const FULL_SHA = /^[0-9a-f]{40}$/i;
const MERGE_PENDING_STAGE = "merge-pending";
const MERGE_UNCONFIRMED_STAGE = "merge-unconfirmed";
const MERGE_UNSETTLED_LIMIT_MS = 24 * 60 * 60 * 1000;

interface AttachedPullRequest {
  url: string;
  ref: GitHubPullRequestRef;
  /** `stored`: on the environment record. `detected`: found on GitHub by its branch. */
  attachment: "stored" | "detected";
  /** What the environment record or the lookup says; GitHub has the last word. */
  state: "open" | "merged" | "closed" | null;
}

interface PrDetection {
  url: string;
  state: "open" | "merged" | "closed";
  hasMergeConflicts?: boolean | null;
}

function refOf(url: string): GitHubPullRequestRef {
  const parsed = parseGitHubPullRequestLink(url);
  if (!parsed) {
    throw new PublicActionError(
      "capability-unavailable",
      "Only pull requests on github.com can be managed here",
      { details: { prUrl: url } },
    );
  }
  return { owner: parsed.owner, repo: parsed.repo, number: parsed.number };
}

function refArgs(ref: GitHubPullRequestRef): Record<string, unknown> {
  return { owner: ref.owner, repo: ref.repo, number: ref.number };
}

/** The branch's PR on GitHub, with the same commands the app's own detection runs. */
async function detectPullRequest(
  environment: Environment,
  context: PublicActionContext,
): Promise<PrDetection | null> {
  if (environment.environmentType === "local") {
    if (!environment.worktreePath) throw new Error("The environment has no worktree yet");
    return context.invoke<PrDetection | null>("detect_pr_local", {
      environmentId: environment.id,
      branch: environment.branch,
    });
  }
  if (!environment.containerId) throw new Error("The environment has no running container");
  return context.invoke<PrDetection | null>("detect_pr", {
    containerId: environment.containerId,
    branch: environment.branch,
  });
}

/** A project's home checkout can change branch underneath its stored PR. */
async function currentEnvironment(
  context: PublicActionContext,
  environmentId: string,
): Promise<Environment> {
  const environment = await requireEnvironment(context, environmentId);
  return isProjectHomeEnvironment(environment)
    ? reconcileProjectHomeEnvironment(environment, context.command.storage)
    : environment;
}

/** The PR a mutation or read acts on; a refusal when there is none or it cannot be told. */
async function requirePullRequest(
  environment: Environment,
  context: PublicActionContext,
): Promise<AttachedPullRequest> {
  if (environment.prUrl) {
    return {
      url: environment.prUrl,
      ref: refOf(environment.prUrl),
      attachment: "stored",
      state: environment.prState ?? null,
    };
  }
  let detected: PrDetection | null;
  try {
    detected = await detectPullRequest(environment, context);
  } catch (error) {
    throw new PublicActionError(
      "not-ready",
      `Could not look up this environment's pull request: ${boundedMessage(sanitizeGitHubError(error))}`,
      { retryable: true },
    );
  }
  if (!detected) {
    throw new PublicActionError(
      "not-found",
      "This environment's branch has no pull request; create_pr opens one",
    );
  }
  return {
    url: detected.url,
    ref: refOf(detected.url),
    attachment: "detected",
    state: detected.state,
  };
}

/** Run a viewer read, reporting GitHub's refusal as a failed operation with its reason. */
async function viewerRead<T>(
  context: PublicActionContext,
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  try {
    return await context.invoke<T>(command, args);
  } catch (error) {
    throw new PublicActionError("operation-failed", boundedMessage(sanitizeGitHubError(error)));
  }
}

/*
 * Reads
 */

function environmentRead<I extends { environmentId: string }>(
  action: PublicActionName,
  parseFields: (input: Record<string, unknown>) => Omit<I, "environmentId">,
  run: (
    input: I,
    pullRequest: AttachedPullRequest,
    context: PublicActionContext,
  ) => Promise<Record<string, unknown>>,
): ReadActionHandler<I> {
  return {
    kind: "read",
    action,
    parse(input) {
      onlyActionKeys(input, action);
      return { environmentId: requiredId(input, "environmentId"), ...parseFields(input) } as I;
    },
    async run(input, context) {
      const environment = await currentEnvironment(context, input.environmentId);
      const pullRequest = await requirePullRequest(environment, context);
      return {
        result: {
          environmentId: environment.id,
          url: pullRequest.url,
          ...(await run(input, pullRequest, context)),
        },
      };
    },
  };
}

/**
 * `pr.get` answers "no pull request" in the result rather than refusing, since
 * that is the common answer to the question. When GitHub cannot be read, what
 * the environment has stored is still returned, with the reason; a failed
 * lookup is `unknown`, never `none`.
 */
const prGet: ReadActionHandler<{ environmentId: string }> = {
  kind: "read",
  action: "pr.get",
  parse(input) {
    onlyActionKeys(input, "pr.get");
    return { environmentId: requiredId(input, "environmentId") };
  },
  async run(input, context) {
    const environment = await currentEnvironment(context, input.environmentId);
    const stored = {
      projectHome: isProjectHomeEnvironment(environment),
      branch: environment.branch,
      prUrl: environment.prUrl ?? null,
      prState: environment.prState ?? null,
      hasMergeConflicts: environment.hasMergeConflicts ?? null,
      prMergeability: environment.prMergeability ?? null,
      prBaseBranch: environment.prBaseBranch ?? null,
      cleanupAfterMergeRequested: Boolean(environment.cleanupAfterMergeRequestedAt),
    };
    const answer = (fields: Record<string, unknown>) => ({
      result: { environmentId: environment.id, environment: stored, pullRequest: null, ...fields },
    });
    let url = environment.prUrl ?? null;
    let attachment: "stored" | "detected" = "stored";
    if (!url) {
      let detected: PrDetection | null;
      try {
        detected = await detectPullRequest(environment, context);
      } catch (error) {
        return answer({
          attachment: "unknown",
          error: boundedMessage(sanitizeGitHubError(error)),
        });
      }
      if (!detected) return answer({ attachment: "none" });
      url = detected.url;
      attachment = "detected";
    }
    const ref = refOf(url);
    try {
      const pullRequest = await context.invoke<GitHubPullRequestDetail>(
        "get_github_pull_request",
        refArgs(ref),
      );
      return answer({ attachment, url, number: ref.number, pullRequest });
    } catch (error) {
      return answer({
        attachment,
        url,
        number: ref.number,
        error: boundedMessage(sanitizeGitHubError(error)),
      });
    }
  },
};

const prList: ReadActionHandler<{
  projectId: string;
  filter: (typeof PUBLIC_PR_LIST_FILTERS)[number];
  query?: string;
}> = {
  kind: "read",
  action: "pr.list",
  parse(input) {
    onlyActionKeys(input, "pr.list");
    const query = optionalString(input, "query", 256)?.trim();
    return {
      projectId: requiredId(input, "projectId"),
      filter: oneOf(input, "filter", PUBLIC_PR_LIST_FILTERS) ?? "open",
      ...(query ? { query } : {}),
    };
  },
  async run(input, context) {
    if (!(await context.command.storage.getProject(input.projectId))) {
      throw new PublicActionError("not-found", `Project not found: ${input.projectId}`);
    }
    return {
      result: await viewerRead<GitHubPullRequestListResult>(context, "list_github_pull_requests", {
        projectId: input.projectId,
        filter: input.filter,
        ...(input.query ? { query: input.query } : {}),
      }),
    };
  },
};

const prTimeline = environmentRead<{ environmentId: string }>(
  "pr.timeline",
  () => ({}),
  async (_input, pullRequest, context) => {
    const { items, truncated } = await viewerRead<GitHubPullRequestTimeline>(
      context,
      "get_github_pull_request_timeline",
      refArgs(pullRequest.ref),
    );
    return { number: pullRequest.ref.number, items, truncated };
  },
);

const prFiles = environmentRead<{ environmentId: string; path?: string }>(
  "pr.files",
  (input) => {
    const path = optionalString(input, "path", 4096);
    return path ? { path } : {};
  },
  async (input, pullRequest, context) => {
    const files = await viewerRead<GitHubPullRequestFiles>(
      context,
      "get_github_pull_request_files",
      refArgs(pullRequest.ref),
    );
    const { headSha, threads, truncated } = files;
    if (input.path) {
      const file = files.files.find((candidate) => candidate.path === input.path);
      if (!file) {
        throw new PublicActionError(
          "not-found",
          truncated
            ? `Could not find ${input.path.slice(0, 200)} in the truncated file list`
            : `This pull request does not change ${input.path.slice(0, 200)}`,
        );
      }
      return {
        number: pullRequest.ref.number,
        headSha,
        truncated,
        file,
        threads: threads.filter((thread) => thread.path === input.path),
      };
    }
    return {
      number: pullRequest.ref.number,
      headSha,
      truncated,
      // A large diff would not fit one result: hunks come one file at a time.
      files: files.files.map(({ hunks: _hunks, ...file }) => file),
      threads,
    };
  },
);

const prOptions = environmentRead<{ environmentId: string }>(
  "pr.options",
  () => ({}),
  async (_input, pullRequest, context) => {
    const repository = { owner: pullRequest.ref.owner, repo: pullRequest.ref.repo };
    const [labels, assignableUsers] = await Promise.all([
      viewerRead<GitHubPullRequestLabel[]>(context, "list_github_repository_labels", repository),
      viewerRead<GitHubRepositoryMemberOption[]>(
        context,
        "list_github_repository_assignable_users",
        repository,
      ),
    ]);
    return { labels, assignableUsers };
  },
);

/*
 * Merge
 */

interface MergeInput {
  environmentId: string;
  method?: GitHubPullRequestMergeMethod;
  deleteBranch?: boolean;
  cleanup?: boolean;
  expectedHeadSha?: string;
  expectedPrUrl?: string;
}

function optionalSha(input: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(input, key, 40);
  if (value !== undefined && !FULL_SHA.test(value)) {
    throw invalid(`${key} must be a full commit SHA`);
  }
  return value;
}

function mergeResult(
  environmentId: string,
  url: string,
  method: GitHubPullRequestMergeMethod,
  merged: boolean,
  outcome: "merged" | "pending" | "unknown",
  cleanup: MergeEnvironmentPrResult["cleanupOutcome"],
): Record<string, unknown> {
  return { environmentId, url, number: refOf(url).number, method, merged, outcome, cleanup };
}

/** What GitHub says now, when the merge command's own answer cannot be trusted. */
async function livePullRequestState(
  url: string,
  context: PublicActionContext,
): Promise<GitHubPullRequestDetail["state"] | null> {
  try {
    const detail = await context.invoke<GitHubPullRequestDetail>(
      "get_github_pull_request",
      refArgs(refOf(url)),
    );
    return detail.state;
  } catch {
    return null;
  }
}

function mergeOutcome(
  input: MergeInput,
  url: string,
  method: GitHubPullRequestMergeMethod,
  value: MergeEnvironmentPrResult,
): ExecuteOutcome {
  const result = mergeResult(
    input.environmentId,
    url,
    method,
    value.outcome === "merged",
    value.outcome,
    value.cleanupOutcome,
  );
  if (value.outcome === "pending") {
    return { state: "running", stage: MERGE_PENDING_STAGE, result };
  }
  if (value.outcome === "unknown") {
    return {
      state: "unknown",
      stage: MERGE_UNCONFIRMED_STAGE,
      result,
      error: {
        code: "run-unknown",
        message: "GitHub did not confirm the merge; check pr.get before merging again",
      },
    };
  }
  if (value.cleanupOutcome === "failed") {
    return {
      state: "partial",
      result: { ...result, ...(value.cleanupError ? { cleanupError: value.cleanupError } : {}) },
      error: {
        code: "partial-failure",
        message: boundedMessage(
          `Merged, but the environment could not be cleaned up: ${value.cleanupError ?? "unknown error"}`,
        ),
      },
    };
  }
  if (value.cleanupOutcome === "pending") {
    return { state: "running", stage: "cleanup-pending", result };
  }
  return { state: "succeeded", stage: "completed", result };
}

function settledMergeOutcome(
  input: MergeInput,
  url: string,
  method: GitHubPullRequestMergeMethod,
  cleanup: boolean,
  environment: Environment | null,
): ExecuteOutcome {
  return mergeOutcome(input, url, method, {
    outcome: "merged",
    cleanupOutcome: !cleanup
      ? "not-requested"
      : !environment
        ? "completed"
        : environment.cleanupAfterMergeError
          ? "failed"
          : "pending",
    ...(cleanup && environment?.cleanupAfterMergeError
      ? { cleanupError: boundedMessage(sanitizeGitHubError(environment.cleanupAfterMergeError)) }
      : {}),
  });
}

const prMerge: MutationActionHandler<MergeInput> = {
  kind: "mutation",
  action: "pr.merge",
  parse(input) {
    onlyActionKeys(input, "pr.merge");
    const environmentId = requiredId(input, "environmentId");
    const method = oneOf(input, "method", PUBLIC_PR_MERGE_METHODS);
    const deleteBranch = optionalBoolean(input, "deleteBranch");
    const cleanup = optionalBoolean(input, "cleanup");
    const expectedHeadSha = optionalSha(input, "expectedHeadSha");
    const expectedPrUrl = optionalString(input, "expectedPrUrl", 2048);
    if (cleanup && deleteBranch === false) {
      throw invalid("cleanup deletes the merged branch with the environment; omit deleteBranch");
    }
    const value: MergeInput = {
      environmentId,
      ...(method ? { method } : {}),
      ...(deleteBranch !== undefined ? { deleteBranch } : {}),
      ...(cleanup !== undefined ? { cleanup } : {}),
      ...(expectedHeadSha ? { expectedHeadSha: expectedHeadSha.toLowerCase() } : {}),
      ...(expectedPrUrl !== undefined ? { expectedPrUrl } : {}),
    };
    return { value, scope: `environment:${environmentId}`, intent: value };
  },
  async prepare(input, context) {
    const environment = await currentEnvironment(context, input.environmentId);
    assertNotDeleting(environment);
    if (context.command.runtime.environments.isMerging(environment.id)) {
      throw new PublicActionError("conflict", "This environment is already being merged");
    }
    const cleanup = input.cleanup === true || Boolean(environment.cleanupAfterMergeRequestedAt);
    const deleteBranch = !isProjectHomeEnvironment(environment) && (input.deleteBranch ?? true);
    if (cleanup && input.deleteBranch === false) {
      throw invalid("cleanup deletes the merged branch with the environment; omit deleteBranch");
    }
    if (cleanup && isProjectHomeEnvironment(environment)) {
      throw new PublicActionError(
        "unsupported",
        "A project's home checkout cannot be cleaned up after a merge",
      );
    }
    const pullRequest = await requirePullRequest(environment, context);
    if (
      input.expectedPrUrl !== undefined &&
      (input.expectedPrUrl !== pullRequest.url ||
        input.cleanup !== cleanup ||
        input.deleteBranch !== deleteBranch)
    ) {
      throw new PublicActionError(
        "target-mismatch",
        "The pull request or merge effects changed; confirm the merge again",
      );
    }
    if (pullRequest.state === "merged") {
      throw new PublicActionError(
        "conflict",
        "This pull request is already merged; environment.delete removes the environment",
        { details: { prUrl: pullRequest.url } },
      );
    }
    const method = input.method ?? "squash";
    // Refuse a moved branch before the merge can flip a draft to ready.
    // Unreadable is not a refusal: GitHub enforces the SHA itself.
    if (input.expectedHeadSha) {
      const detail = await context
        .invoke<GitHubPullRequestDetail>("get_github_pull_request", refArgs(pullRequest.ref))
        .catch(() => null);
      if (detail && detail.headSha.toLowerCase() !== input.expectedHeadSha) {
        throw new PublicActionError(
          "target-mismatch",
          "The pull request's branch has moved since expectedHeadSha; read it again with pr.get",
          { details: { headSha: detail.headSha } },
        );
      }
    }
    return {
      resources: { environmentId: environment.id, projectId: environment.projectId },
      resolved: { url: pullRequest.url, method, deleteBranch, cleanup },
      async execute(operation) {
        const url = pullRequest.url;
        const running = mergeResult(
          environment.id,
          url,
          method,
          false,
          "pending",
          cleanup ? "pending" : "not-requested",
        );
        await operation.update({ stage: "merging", result: running });
        const latest = await currentEnvironment(context, environment.id);
        if (latest.branch !== environment.branch || (latest.prUrl && latest.prUrl !== url)) {
          throw new PublicActionError(
            "target-mismatch",
            "The pull request changed before merge dispatch; confirm again",
          );
        }
        // The merge command acts on the stored pull request.
        if (pullRequest.attachment === "detected") {
          await context.command.storage.updateEnvironment(environment.id, {
            prUrl: url,
            prState: pullRequest.state,
          });
        }
        const task = context.invoke<MergeEnvironmentPrResult>("merge_environment_pr", {
          environmentId: environment.id,
          method,
          deleteBranch,
          cleanupAfterMerge: cleanup,
          expectedPrUrl: url,
          ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}),
        });
        return runWithContinuation(operation, task, {
          runningStage: "merging",
          runningResult: running,
          onSuccess: (value) => mergeOutcome(input, url, method, value),
          // A failed `gh` call does not prove nothing merged (a timeout can
          // lose the answer), so GitHub settles it.
          onFailure: async (error) => {
            const state = await livePullRequestState(url, context);
            const message = boundedMessage(sanitizeGitHubError(error));
            if (state === "merged") {
              return settledMergeOutcome(
                input,
                url,
                method,
                cleanup,
                await context.command.storage.getEnvironment(environment.id),
              );
            }
            if (state === null) {
              return {
                state: "unknown",
                stage: MERGE_UNCONFIRMED_STAGE,
                result: running,
                error: {
                  code: "run-unknown",
                  message: boundedMessage(
                    `The merge failed and GitHub could not be read to confirm it: ${message}`,
                  ),
                },
              };
            }
            return {
              state: "failed",
              result: { ...running, outcome: "unknown" },
              error: {
                code: "operation-failed",
                message: cleanup
                  ? boundedMessage(
                      `${message}. Cleanup stays requested: the environment is deleted when this pull request merges`,
                    )
                  : message,
              },
            };
          },
        });
      },
    };
  },
};

/**
 * A merge is never run again here. It settles only on evidence that this pull
 * request merged or closed: the PR monitor's record while the environment
 * lives, GitHub itself after a restart or once the environment is gone.
 */
const reconcileMerge: ReconcileFunction = async (record: PublicOperationRecord, context) => {
  const inFlight = record.stage === "merging" && record.generation === context.generation;
  if (inFlight) return null;
  const url = typeof record.resolved?.url === "string" ? record.resolved.url : null;
  if (!url) return null;
  const environmentId = record.resources.environmentId;
  const environment = environmentId
    ? await context.command.storage.getEnvironment(environmentId)
    : null;
  const previous = record.generation !== context.generation;
  let state: GitHubPullRequestDetail["state"] | null =
    record.result?.merged === true ? "merged" : null;
  if (
    environment?.prUrl === url &&
    (environment.prState === "merged" || environment.prState === "closed")
  ) {
    state = environment.prState;
  } else if (!state && (previous || !environment)) {
    state = await livePullRequestState(url, context);
  }
  if (state === "merged") {
    return settledMergeOutcome(
      { environmentId: environmentId! },
      url,
      (record.resolved?.method ?? "squash") as GitHubPullRequestMergeMethod,
      record.resolved?.cleanup === true,
      environment,
    );
  }
  if (state === "closed") {
    return {
      state: "failed",
      error: { code: "operation-failed", message: "The pull request was closed without merging" },
    };
  }
  if (record.stage === "merging" || !environment) {
    return {
      state: "interrupted",
      error: {
        code: "run-interrupted",
        message:
          "The backend restarted during this merge and it is not confirmed; check pr.get before merging again",
      },
    };
  }
  if (context.now() - Date.parse(record.createdAt) > MERGE_UNSETTLED_LIMIT_MS) {
    return {
      state: "interrupted",
      error: {
        code: "run-interrupted",
        message: "The pull request has not merged after a day; check pr.get",
      },
    };
  }
  return null;
};

registerReconciler("pr.merge", reconcileMerge);

/*
 * Viewer mutations
 */

function viewerMutation<I extends { environmentId: string }>(
  action: PublicActionName,
  parseFields: (input: Record<string, unknown>) => Omit<I, "environmentId">,
  run: (
    input: I,
    pullRequest: AttachedPullRequest,
    context: PublicActionContext,
  ) => Promise<Record<string, unknown>>,
): MutationActionHandler<I> {
  return {
    kind: "mutation",
    action,
    parse(input) {
      onlyActionKeys(input, action);
      const environmentId = requiredId(input, "environmentId");
      const value = { environmentId, ...parseFields(input) } as I;
      return { value, scope: `environment:${environmentId}`, intent: value };
    },
    async prepare(input, context) {
      const environment = await currentEnvironment(context, input.environmentId);
      assertNotDeleting(environment);
      const pullRequest = await requirePullRequest(environment, context);
      return {
        resources: { environmentId: environment.id, projectId: environment.projectId },
        resolved: { url: pullRequest.url },
        async execute() {
          try {
            return {
              state: "succeeded",
              result: {
                environmentId: environment.id,
                url: pullRequest.url,
                number: pullRequest.ref.number,
                ...(await run(input, pullRequest, context)),
              },
            };
          } catch (error) {
            return {
              state: "failed",
              error: {
                code: error instanceof PublicActionError ? error.code : "operation-failed",
                message: boundedMessage(sanitizeGitHubError(error)),
              },
            };
          }
        },
      };
    },
  };
}

function stateMutation(
  action: PublicActionName,
  stateAction: "close" | "reopen" | "ready-for-review" | "convert-to-draft",
) {
  return viewerMutation<{ environmentId: string }>(
    action,
    () => ({}),
    async (_input, pullRequest, context) => {
      const detail = await context.invoke<GitHubPullRequestDetail>(
        "update_github_pull_request_state",
        { ...refArgs(pullRequest.ref), action: stateAction },
      );
      return { state: detail.state, isDraft: detail.isDraft };
    },
  );
}

function requiredBody(input: Record<string, unknown>, key = "body"): string {
  return requiredString(input, key, PUBLIC_PR_BODY_MAX_CHARS);
}

function requiredPositiveInteger(input: Record<string, unknown>, key: string): number {
  const value = optionalInteger(input, key, 1, Number.MAX_SAFE_INTEGER);
  if (value === undefined) throw invalid(`${key} is required`);
  return value;
}

function inlineComment(value: unknown, name: string): GitHubPullRequestInlineCommentInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  onlyKeys(record, ["path", "line", "side", "startLine", "body"]);
  const line = requiredPositiveInteger(record, "line");
  const startLine = optionalInteger(record, "startLine", 1, Number.MAX_SAFE_INTEGER);
  if (startLine !== undefined && startLine >= line) throw invalid("startLine must be below line");
  return {
    path: requiredString(record, "path", 4096),
    line,
    side: requiredOneOf(record, "side", PUBLIC_PR_SIDES),
    ...(startLine !== undefined ? { startLine } : {}),
    body: requiredBody(record),
  };
}

function reviewerList(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw invalid(`${key} must be a list of logins or org/team-slug entries`);
  }
  if (value.length > PUBLIC_PR_REVIEWERS_MAX) {
    throw new PublicActionError(
      "input-too-large",
      `${key} takes at most ${PUBLIC_PR_REVIEWERS_MAX} entries`,
    );
  }
  return value as string[];
}

/** The current head, for an inline comment that does not name its commit. */
async function headSha(
  pullRequest: AttachedPullRequest,
  context: PublicActionContext,
): Promise<string> {
  const detail = await context.invoke<GitHubPullRequestDetail>(
    "get_github_pull_request",
    refArgs(pullRequest.ref),
  );
  return detail.headSha;
}

const prComment = viewerMutation<{ environmentId: string; body: string }>(
  "pr.comment",
  (input) => ({ body: requiredBody(input) }),
  async (input, pullRequest, context) => {
    const comment = await context.invoke<GitHubPullRequestComment>(
      "add_github_pull_request_comment",
      { ...refArgs(pullRequest.ref), body: input.body },
    );
    return { commentId: comment.id, commentUrl: comment.htmlUrl };
  },
);

const prCommentEdit = viewerMutation<{ environmentId: string; commentId: number; body: string }>(
  "pr.comment.edit",
  (input) => ({
    commentId: requiredPositiveInteger(input, "commentId"),
    body: requiredBody(input),
  }),
  async (input, pullRequest, context) => {
    const comment = await context.invoke<GitHubPullRequestComment>(
      "update_github_pull_request_comment",
      { ...refArgs(pullRequest.ref), commentId: input.commentId, body: input.body },
    );
    return { commentId: comment.id, commentUrl: comment.htmlUrl };
  },
);

const prReview = viewerMutation<{
  environmentId: string;
  event: (typeof PUBLIC_PR_REVIEW_EVENTS)[number];
  body?: string;
  commitId?: string;
  comments?: GitHubPullRequestInlineCommentInput[];
}>(
  "pr.review",
  (input) => {
    const event = requiredOneOf(input, "event", PUBLIC_PR_REVIEW_EVENTS);
    const body = optionalString(input, "body", PUBLIC_PR_BODY_MAX_CHARS);
    const commitId = optionalSha(input, "commitId");
    const rawComments = input.comments;
    if (rawComments !== undefined && !Array.isArray(rawComments)) {
      throw invalid("comments must be a list");
    }
    if (rawComments && rawComments.length > PUBLIC_PR_REVIEW_COMMENTS_MAX) {
      throw new PublicActionError(
        "input-too-large",
        `comments takes at most ${PUBLIC_PR_REVIEW_COMMENTS_MAX} entries`,
      );
    }
    return {
      event,
      ...(body !== undefined ? { body } : {}),
      ...(commitId ? { commitId } : {}),
      ...(rawComments
        ? {
            comments: rawComments.map((comment, index) =>
              inlineComment(comment, `comments[${index}]`),
            ),
          }
        : {}),
    };
  },
  async (input, pullRequest, context) => {
    const { reviewId } = await context.invoke<{ reviewId: number }>(
      "submit_github_pull_request_review",
      {
        ...refArgs(pullRequest.ref),
        event: input.event,
        body: input.body ?? "",
        ...(input.commitId ? { commitId: input.commitId } : {}),
        ...(input.comments ? { comments: input.comments } : {}),
      },
    );
    return { reviewId, event: input.event };
  },
);

const prReviewComment = viewerMutation<{
  environmentId: string;
  comment: GitHubPullRequestInlineCommentInput;
  commitId?: string;
}>(
  "pr.review.comment",
  (input) => {
    const commitId = optionalSha(input, "commitId");
    const { commitId: _commitId, environmentId: _environmentId, ...fields } = input;
    return { comment: inlineComment(fields, "comment"), ...(commitId ? { commitId } : {}) };
  },
  async (input, pullRequest, context) => {
    const comment = await context.invoke<GitHubPullRequestReviewThreadComment>(
      "add_github_pull_request_review_comment",
      {
        ...refArgs(pullRequest.ref),
        commitId: input.commitId ?? (await headSha(pullRequest, context)),
        comment: input.comment,
      },
    );
    return { commentId: comment.id, commentUrl: comment.htmlUrl };
  },
);

const prThreadReply = viewerMutation<{ environmentId: string; threadId: string; body: string }>(
  "pr.thread.reply",
  (input) => ({ threadId: requiredId(input, "threadId"), body: requiredBody(input) }),
  async (input, pullRequest, context) => {
    const comment = await context.invoke<GitHubPullRequestReviewThreadComment>(
      "reply_github_pull_request_review_thread",
      { ...refArgs(pullRequest.ref), threadId: input.threadId, body: input.body },
    );
    return { commentId: comment.id, commentUrl: comment.htmlUrl };
  },
);

const prThreadResolve = viewerMutation<{
  environmentId: string;
  threadId: string;
  resolved: boolean;
}>(
  "pr.thread.resolve",
  (input) => ({
    threadId: requiredId(input, "threadId"),
    resolved: optionalBoolean(input, "resolved") ?? true,
  }),
  async (input, pullRequest, context) => {
    const { isResolved } = await context.invoke<{ isResolved: boolean }>(
      "set_github_pull_request_thread_resolved",
      { ...refArgs(pullRequest.ref), threadId: input.threadId, resolved: input.resolved },
    );
    return { threadId: input.threadId, isResolved };
  },
);

const prFileViewed = viewerMutation<{ environmentId: string; path: string; viewed: boolean }>(
  "pr.file.viewed",
  (input) => ({
    path: requiredString(input, "path", 4096),
    viewed: optionalBoolean(input, "viewed") ?? true,
  }),
  async (input, pullRequest, context) => {
    const { viewedState } = await context.invoke<{ viewedState: string }>(
      "set_github_pull_request_file_viewed",
      { ...refArgs(pullRequest.ref), path: input.path, viewed: input.viewed },
    );
    return { viewedState };
  },
);

const prReviewers = viewerMutation<{ environmentId: string; add: string[]; remove: string[] }>(
  "pr.reviewers",
  (input) => {
    const add = reviewerList(input, "add");
    const remove = reviewerList(input, "remove");
    if (add.length === 0 && remove.length === 0) throw invalid("Name reviewers to add or remove");
    return { add, remove };
  },
  async (input, pullRequest, context) => {
    const detail = await context.invoke<GitHubPullRequestDetail>(
      "set_github_pull_request_reviewers",
      { ...refArgs(pullRequest.ref), add: input.add, remove: input.remove },
    );
    return {
      reviewers: detail.reviewers.map(({ login, kind, requested, state }) => ({
        login,
        kind,
        requested,
        ...(state ? { state } : {}),
      })),
    };
  },
);

const prLabel = viewerMutation<{ environmentId: string; name: string; present: boolean }>(
  "pr.label",
  (input) => ({
    name: requiredString(input, "name", 100),
    present: optionalBoolean(input, "present") ?? true,
  }),
  async (input, pullRequest, context) => {
    const labels = await context.invoke<GitHubPullRequestLabel[]>(
      "change_github_pull_request_label",
      { ...refArgs(pullRequest.ref), name: input.name, present: input.present },
    );
    return { labels: labels.map((label) => label.name) };
  },
);

export const PULL_REQUEST_HANDLERS: PublicActionHandler[] = [
  prGet,
  prList,
  prTimeline,
  prFiles,
  prOptions,
  prMerge,
  stateMutation("pr.close", "close"),
  stateMutation("pr.reopen", "reopen"),
  stateMutation("pr.ready", "ready-for-review"),
  stateMutation("pr.draft", "convert-to-draft"),
  prComment,
  prCommentEdit,
  prReview,
  prReviewComment,
  prThreadReply,
  prThreadResolve,
  prFileViewed,
  prReviewers,
  prLabel,
];
