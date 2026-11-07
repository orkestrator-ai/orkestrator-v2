import {
  gitHubPullRequestKey,
  isGitHubPullRequestRef,
  parseGitHubPullRequestLink,
  type GitHubPullRequestInlineCommentInput,
  type GitHubPullRequestListFilter,
  type GitHubPullRequestMergeMethod,
  type GitHubPullRequestRef,
  type GitHubPullRequestReviewEvent,
} from "@orkestrator/protocol/github-pull-requests";
import type { AnyCommandDef } from "@orkestrator/protocol/contract/command";
import {
  addGitHubPullRequestCommentCommand,
  addGitHubPullRequestReviewCommentCommand,
  changeGitHubPullRequestLabelCommand,
  getGitHubPullRequestCommand,
  getGitHubPullRequestFilesCommand,
  getGitHubPullRequestTimelineCommand,
  listGitHubPullRequestsCommand,
  listGitHubRepositoryAssignableUsersCommand,
  listGitHubRepositoryLabelsCommand,
  mergeGitHubPullRequestCommand,
  replyGitHubPullRequestReviewThreadCommand,
  setGitHubPullRequestFileViewedCommand,
  setGitHubPullRequestLabelsCommand,
  setGitHubPullRequestReviewersCommand,
  setGitHubPullRequestThreadResolvedCommand,
  submitGitHubPullRequestReviewCommand,
  updateGitHubPullRequestCommentCommand,
  updateGitHubPullRequestStateCommand,
} from "@orkestrator/protocol/contract/domains/pull-requests";
import type { CommandContext } from "./commands-context.js";
import {
  asNumber,
  asRecord,
  asRequiredBoolean,
  asString,
  assertOnlyKeys,
  requireGitHubProject,
  requireGitHubToken,
} from "./commands-helpers.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import type {
  CommandRegistrar,
  DefinedCommandHandler,
  RegistryDependencies,
} from "./commands-registry-types.js";
import { sanitizeGitHubError } from "./github.js";
import {
  addGitHubPullRequestComment,
  addGitHubPullRequestReviewComment,
  listGitHubRepositoryAssignableUsers,
  listGitHubRepositoryLabels,
  mergeGitHubPullRequest,
  replyGitHubPullRequestReviewThread,
  setGitHubPullRequestFileViewed,
  setGitHubPullRequestLabels,
  changeGitHubPullRequestLabel,
  setGitHubPullRequestReviewers,
  setGitHubPullRequestThreadResolved,
  submitGitHubPullRequestReview,
  updateGitHubPullRequestComment,
  updateGitHubPullRequestState,
  type GitHubPullRequestStateAction,
} from "./github-pull-request-actions.js";
import { getGitHubPullRequestFiles } from "./github-pull-request-files.js";
import { getGitHubPullRequestTimeline } from "./github-pull-request-timeline.js";
import { getGitHubPullRequest, listGitHubPullRequests } from "./github-pull-requests.js";

type Args = Readonly<Record<string, unknown>>;

const LIST_FILTERS: readonly GitHubPullRequestListFilter[] = [
  "open",
  "mine",
  "review-requested",
  "closed",
];
const MERGE_METHODS: readonly GitHubPullRequestMergeMethod[] = ["merge", "squash", "rebase"];
const STATE_ACTIONS: readonly GitHubPullRequestStateAction[] = [
  "close",
  "reopen",
  "ready-for-review",
  "convert-to-draft",
];
const REVIEW_EVENTS: readonly GitHubPullRequestReviewEvent[] = [
  "APPROVE",
  "REQUEST_CHANGES",
  "COMMENT",
];
const MAX_SEARCH_QUERY_LENGTH = 256;

/**
 * The pull request the arguments name. The commands were strict (unknown
 * argument keys refused); with their definitions they drop unknown keys
 * (plan item 7006), so only the reference itself is checked here.
 */
function refArgs(args: Args): GitHubPullRequestRef {
  const ref = { owner: args.owner, repo: args.repo, number: args.number };
  if (!isGitHubPullRequestRef(ref)) {
    throw new Error("Expected owner, repo and number to identify a GitHub pull request");
  }
  return { owner: ref.owner, repo: ref.repo, number: ref.number };
}

function repositoryArgs(args: Args): { owner: string; repo: string } {
  const candidate = { owner: args.owner, repo: args.repo, number: 1 };
  if (!isGitHubPullRequestRef(candidate)) {
    throw new Error("Expected owner and repo to identify a GitHub repository");
  }
  return { owner: candidate.owner, repo: candidate.repo };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Expected ${name} to be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : asString(value, name);
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Expected ${name} to be a list of strings`);
  }
  return value as string[];
}

function inlineComment(value: unknown, name: string): GitHubPullRequestInlineCommentInput {
  const record = asRecord(value, name);
  assertOnlyKeys(record, ["path", "line", "side", "startLine", "body"], name);
  return {
    path: asString(record.path, `${name}.path`),
    line: asNumber(record.line, `${name}.line`),
    side: oneOf(record.side, ["LEFT", "RIGHT"] as const, `${name}.side`),
    ...(record.startLine === undefined
      ? {}
      : { startLine: asNumber(record.startLine, `${name}.startLine`) }),
    body: asString(record.body, `${name}.body`),
  };
}

function inlineComments(value: unknown): GitHubPullRequestInlineCommentInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Expected comments to be a list");
  return value.map((comment, index) => inlineComment(comment, `comments[${index}]`));
}

/** Run with the Settings credential; GitHub errors never echo the token. */
async function withGitHubToken<T>(
  context: CommandContext,
  run: (token: string) => Promise<T>,
): Promise<T> {
  const token = await requireGitHubToken(context);
  try {
    return await run(token);
  } catch (error) {
    throw new Error(sanitizeGitHubError(error, token));
  }
}

/**
 * Ask the PR monitor to re-check every environment whose stored PR is this
 * one, so its badge follows a merge or close made from the viewer. Best
 * effort and detached: it never delays or fails the GitHub action.
 */
export function refreshMonitoredPullRequest(
  ref: GitHubPullRequestRef,
  context: CommandContext,
  refresh: (environmentId: string, context: CommandContext) => Promise<void> = (
    environmentId,
    context,
  ) => context.runtime.prMonitor.requestRefresh(environmentId, context),
): Promise<void> {
  const key = gitHubPullRequestKey(ref);
  return (async () => {
    const environments = await context.storage.loadEnvironments();
    for (const environment of environments) {
      const parsed = environment.prUrl ? parseGitHubPullRequestLink(environment.prUrl) : null;
      if (parsed && gitHubPullRequestKey(parsed) === key) {
        await refresh(environment.id, context);
      }
    }
  })().catch(() => undefined);
}

/**
 * The GitHub pull request viewer's commands, registered with their
 * `pull-requests` definitions (plan item 7006). The handlers are `async`, so
 * a refused argument is still a rejection.
 */
export function registerGitHubPullRequestCommands(
  registerCommand: CommandRegistrar,
  _dependencies: RegistryDependencies,
): void {
  const register = <C extends AnyCommandDef>(def: C, handler: DefinedCommandHandler<C>) =>
    registerCommand(def, handler, ASYNC_HANDLER);
  register(listGitHubPullRequestsCommand, async (args, context) => {
    const projectId = asString(args.projectId, "projectId");
    const filter = oneOf(args.filter, LIST_FILTERS, "filter");
    const query = optionalString(args.query, "query")?.trim();
    if (query && query.length > MAX_SEARCH_QUERY_LENGTH) {
      throw new Error(`Search text must be at most ${MAX_SEARCH_QUERY_LENGTH} characters`);
    }
    const target = await requireGitHubProject(context, projectId);
    try {
      return await listGitHubPullRequests(
        target.token,
        { owner: target.repository.owner, repo: target.repository.name },
        filter,
        query || undefined,
      );
    } catch (error) {
      throw new Error(sanitizeGitHubError(error, target.token));
    }
  });

  register(getGitHubPullRequestCommand, async (args, context) => {
    const ref = refArgs(args);
    return withGitHubToken(context, (token) => getGitHubPullRequest(token, ref));
  });

  register(getGitHubPullRequestTimelineCommand, async (args, context) => {
    const ref = refArgs(args);
    return withGitHubToken(context, (token) => getGitHubPullRequestTimeline(token, ref));
  });

  register(getGitHubPullRequestFilesCommand, async (args, context) => {
    const ref = refArgs(args);
    return withGitHubToken(context, (token) => getGitHubPullRequestFiles(token, ref));
  });

  register(mergeGitHubPullRequestCommand, async (args, context) => {
    const ref = refArgs(args);
    const input = {
      method: oneOf(args.method, MERGE_METHODS, "method"),
      deleteBranch: asRequiredBoolean(args.deleteBranch, "deleteBranch"),
      expectedHeadSha: optionalString(args.expectedHeadSha, "expectedHeadSha"),
    };
    const result = await withGitHubToken(context, (token) =>
      mergeGitHubPullRequest(token, ref, input),
    );
    if (result.merged) void refreshMonitoredPullRequest(ref, context);
    return result;
  });

  register(updateGitHubPullRequestStateCommand, async (args, context) => {
    const ref = refArgs(args);
    const action = oneOf(args.action, STATE_ACTIONS, "action");
    const detail = await withGitHubToken(context, (token) =>
      updateGitHubPullRequestState(token, ref, action),
    );
    if (action === "close" || action === "reopen") void refreshMonitoredPullRequest(ref, context);
    return detail;
  });

  register(addGitHubPullRequestCommentCommand, async (args, context) => {
    const ref = refArgs(args);
    const body = asString(args.body, "body");
    return withGitHubToken(context, (token) => addGitHubPullRequestComment(token, ref, body));
  });

  register(updateGitHubPullRequestCommentCommand, async (args, context) => {
    const ref = refArgs(args);
    const commentId = asNumber(args.commentId, "commentId");
    const body = asString(args.body, "body");
    return withGitHubToken(context, (token) =>
      updateGitHubPullRequestComment(token, ref, commentId, body),
    );
  });

  register(submitGitHubPullRequestReviewCommand, async (args, context) => {
    const ref = refArgs(args);
    const review = {
      event: oneOf(args.event, REVIEW_EVENTS, "event"),
      body: asString(args.body, "body"),
      commitId: optionalString(args.commitId, "commitId"),
      comments: inlineComments(args.comments),
    };
    return withGitHubToken(context, (token) => submitGitHubPullRequestReview(token, ref, review));
  });

  register(addGitHubPullRequestReviewCommentCommand, async (args, context) => {
    const ref = refArgs(args);
    const commitId = asString(args.commitId, "commitId");
    const comment = inlineComment(args.comment, "comment");
    return withGitHubToken(context, (token) =>
      addGitHubPullRequestReviewComment(token, ref, commitId, comment),
    );
  });

  register(replyGitHubPullRequestReviewThreadCommand, async (args, context) => {
    const ref = refArgs(args);
    const threadId = asString(args.threadId, "threadId");
    const body = asString(args.body, "body");
    return withGitHubToken(context, (token) =>
      replyGitHubPullRequestReviewThread(token, ref, threadId, body),
    );
  });

  register(setGitHubPullRequestThreadResolvedCommand, async (args, context) => {
    const ref = refArgs(args);
    const threadId = asString(args.threadId, "threadId");
    const resolved = asRequiredBoolean(args.resolved, "resolved");
    return withGitHubToken(context, (token) =>
      setGitHubPullRequestThreadResolved(token, ref, threadId, resolved),
    );
  });

  register(setGitHubPullRequestFileViewedCommand, async (args, context) => {
    const ref = refArgs(args);
    const path = asString(args.path, "path");
    const viewed = asRequiredBoolean(args.viewed, "viewed");
    return withGitHubToken(context, (token) =>
      setGitHubPullRequestFileViewed(token, ref, path, viewed),
    );
  });

  register(setGitHubPullRequestReviewersCommand, async (args, context) => {
    const ref = refArgs(args);
    const changes = { add: stringList(args.add, "add"), remove: stringList(args.remove, "remove") };
    return withGitHubToken(context, (token) => setGitHubPullRequestReviewers(token, ref, changes));
  });

  register(changeGitHubPullRequestLabelCommand, async (args, context) => {
    const ref = refArgs(args);
    const name = asString(args.name, "name");
    const present = asRequiredBoolean(args.present, "present");
    return withGitHubToken(context, (token) =>
      changeGitHubPullRequestLabel(token, ref, name, present),
    );
  });

  register(setGitHubPullRequestLabelsCommand, async (args, context) => {
    const ref = refArgs(args);
    const labels = stringList(args.labels, "labels");
    return withGitHubToken(context, (token) => setGitHubPullRequestLabels(token, ref, labels));
  });

  register(listGitHubRepositoryAssignableUsersCommand, async (args, context) => {
    const repository = repositoryArgs(args);
    return withGitHubToken(context, (token) =>
      listGitHubRepositoryAssignableUsers(token, repository),
    );
  });

  register(listGitHubRepositoryLabelsCommand, async (args, context) => {
    const repository = repositoryArgs(args);
    return withGitHubToken(context, (token) => listGitHubRepositoryLabels(token, repository));
  });
}
