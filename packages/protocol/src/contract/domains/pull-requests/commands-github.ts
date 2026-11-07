/**
 * `pull-requests` commands of the GitHub API surface (plan item 7006): a
 * project's GitHub issues (the Kanban's GitHub source and the build
 * pipeline's completion comment) and the GitHub pull request viewer.
 *
 * Argument schemas declare every key the handler reads and decode tolerantly
 * (§11.4); the viewer's commands were strict (`assertOnlyKeys` on the
 * arguments) and now drop unknown keys. The nested inline review comments
 * stay strict: an unknown key there is part of a value the handler refuses
 * on purpose. A key read with `asString`/`asNumber`/`asRequiredBoolean` is
 * typed (same "Expected projectId to be a string" text). A key the handler
 * checks with its own sentence (the pull request reference, an enumeration,
 * the issue status) is typed and carries that sentence as its `message`, so
 * the text is unchanged; lists of strings and nested records stay
 * `optionalKey(Unknown)` with the handler's checks.
 *
 * Every command reads the GitHub credential from Settings on the node that
 * runs it; no test reaches GitHub.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { pullRequestsDomain } from "./domain.js";
import {
  GitHubCompletionCommentResultSchema,
  GitHubIssueCommentSchema,
  GitHubIssueDetailSchema,
  GitHubIssueSchema,
  GitHubIssueStatusSchema,
  GitHubIssuesSnapshotSchema,
  GitHubPullRequestCommentSchema,
  GitHubPullRequestDetailSchema,
  GitHubPullRequestFilesSchema,
  GitHubPullRequestFileViewedSchema,
  GitHubPullRequestLabelSchema,
  GitHubPullRequestListResultSchema,
  GitHubPullRequestMergeResultSchema,
  GitHubPullRequestReviewSubmittedSchema,
  GitHubPullRequestReviewThreadCommentSchema,
  GitHubPullRequestThreadResolutionSchema,
  GitHubPullRequestTimelineSchema,
  GitHubRepositoryMemberOptionSchema,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

function oneOf<const L extends readonly [string, ...string[]]>(name: string, literals: L) {
  return Schema.Literals(literals).annotate({
    message: `Expected ${name} to be one of ${literals.join(", ")}`,
  });
}

// --- GitHub issues -----------------------------------------------------------

const issueTarget = { projectId: Schema.String, issueNumber: Schema.Finite };

/** Posts (once) the build pipeline's completion comment on its GitHub issue. */
export const postGitHubCompletionCommentCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "post_github_completion_comment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    pipelineId: Schema.String,
    projectId: Schema.String,
    repositoryOwner: Schema.String,
    repositoryName: Schema.String,
    issueNumber: Schema.Finite,
    body: Schema.String,
  }),
  result: GitHubCompletionCommentResultSchema,
  critical: [],
});

export const getGitHubIssuesCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "get_github_issues",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String }),
  result: GitHubIssuesSnapshotSchema,
  critical: [],
});

export const getGitHubIssueCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "get_github_issue",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct(issueTarget),
  result: GitHubIssueDetailSchema,
  critical: [],
});

export const updateGitHubIssueCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "update_github_issue",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...issueTarget, title: Schema.String, body: Schema.String }),
  result: GitHubIssueSchema,
  critical: [],
});

export const updateGitHubIssueStatusCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "update_github_issue_status",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...issueTarget,
    status: GitHubIssueStatusSchema.annotate({
      message: "Expected status to be backlog, todo, inprogress, or review",
    }),
  }),
  result: GitHubIssueSchema,
  critical: [],
});

export const closeGitHubIssueCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "close_github_issue",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct(issueTarget),
  result: GitHubIssueSchema,
  critical: [],
});

export const addGitHubIssueCommentCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "add_github_issue_comment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...issueTarget, body: Schema.String }),
  result: GitHubIssueCommentSchema,
  critical: [],
});

export const updateGitHubIssueCommentCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "update_github_issue_comment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...issueTarget, commentId: Schema.Finite, body: Schema.String }),
  result: GitHubIssueCommentSchema,
  critical: [],
});

export const GITHUB_ISSUE_COMMANDS = [
  postGitHubCompletionCommentCommand,
  getGitHubIssuesCommand,
  getGitHubIssueCommand,
  updateGitHubIssueCommand,
  updateGitHubIssueStatusCommand,
  closeGitHubIssueCommand,
  addGitHubIssueCommentCommand,
  updateGitHubIssueCommentCommand,
] as const;

// --- GitHub pull requests ------------------------------------------------------

const REF_MESSAGE = "Expected owner, repo and number to identify a GitHub pull request";
/** `{ owner, repo, number }`; the handler also checks their shape (`isGitHubPullRequestRef`). */
const pullRequestRef = {
  owner: Schema.String.annotate({ message: REF_MESSAGE }),
  repo: Schema.String.annotate({ message: REF_MESSAGE }),
  number: Schema.Finite.annotate({ message: REF_MESSAGE }),
};
const REPOSITORY_MESSAGE = "Expected owner and repo to identify a GitHub repository";
const repositoryRef = {
  owner: Schema.String.annotate({ message: REPOSITORY_MESSAGE }),
  repo: Schema.String.annotate({ message: REPOSITORY_MESSAGE }),
};

export const listGitHubPullRequestsCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "list_github_pull_requests",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
    filter: oneOf("filter", ["open", "mine", "review-requested", "closed"]),
    // Trimmed and bounded (256 characters) by the handler.
    query: optionalUnknown,
  }),
  result: GitHubPullRequestListResultSchema,
  critical: [],
});

export const getGitHubPullRequestCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "get_github_pull_request",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct(pullRequestRef),
  result: GitHubPullRequestDetailSchema,
  critical: [],
});

export const getGitHubPullRequestTimelineCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "get_github_pull_request_timeline",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct(pullRequestRef),
  result: GitHubPullRequestTimelineSchema,
  critical: [],
});

export const getGitHubPullRequestFilesCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "get_github_pull_request_files",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct(pullRequestRef),
  result: GitHubPullRequestFilesSchema,
  critical: [],
});

export const mergeGitHubPullRequestCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "merge_github_pull_request",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...pullRequestRef,
    method: oneOf("method", ["merge", "squash", "rebase"]),
    deleteBranch: Schema.Boolean,
    expectedHeadSha: optionalUnknown,
  }),
  result: GitHubPullRequestMergeResultSchema,
  // The compare-and-swap guard: ignored, a head pushed after the review merges.
  critical: ["expectedHeadSha"],
});

export const updateGitHubPullRequestStateCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "update_github_pull_request_state",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...pullRequestRef,
    action: oneOf("action", ["close", "reopen", "ready-for-review", "convert-to-draft"]),
  }),
  result: GitHubPullRequestDetailSchema,
  critical: [],
});

export const addGitHubPullRequestCommentCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "add_github_pull_request_comment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...pullRequestRef, body: Schema.String }),
  result: GitHubPullRequestCommentSchema,
  critical: [],
});

export const updateGitHubPullRequestCommentCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "update_github_pull_request_comment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...pullRequestRef, commentId: Schema.Finite, body: Schema.String }),
  result: GitHubPullRequestCommentSchema,
  critical: [],
});

export const submitGitHubPullRequestReviewCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "submit_github_pull_request_review",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...pullRequestRef,
    event: oneOf("event", ["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
    body: Schema.String,
    commitId: optionalUnknown,
    // Inline comments, each checked strictly by the handler.
    comments: optionalUnknown,
  }),
  result: GitHubPullRequestReviewSubmittedSchema,
  // `comments`: ignored, the review posts without its inline comments.
  // `commitId`: ignored, the comments anchor to whatever the head is now.
  critical: ["comments", "commitId"],
});

export const addGitHubPullRequestReviewCommentCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "add_github_pull_request_review_comment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...pullRequestRef,
    commitId: Schema.String,
    // `{ path, line, side, startLine?, body }`, checked strictly by the handler.
    comment: optionalUnknown,
  }),
  result: GitHubPullRequestReviewThreadCommentSchema,
  critical: [],
});

export const replyGitHubPullRequestReviewThreadCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "reply_github_pull_request_review_thread",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...pullRequestRef, threadId: Schema.String, body: Schema.String }),
  result: GitHubPullRequestReviewThreadCommentSchema,
  critical: [],
});

export const setGitHubPullRequestThreadResolvedCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "set_github_pull_request_thread_resolved",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...pullRequestRef, threadId: Schema.String, resolved: Schema.Boolean }),
  result: GitHubPullRequestThreadResolutionSchema,
  critical: [],
});

export const setGitHubPullRequestFileViewedCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "set_github_pull_request_file_viewed",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...pullRequestRef, path: Schema.String, viewed: Schema.Boolean }),
  result: GitHubPullRequestFileViewedSchema,
  critical: [],
});

export const setGitHubPullRequestReviewersCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "set_github_pull_request_reviewers",
  since: 1,
  access: "workspace",
  read: false,
  // Lists of strings, with the handler's "Expected add to be a list of strings".
  args: Schema.Struct({ ...pullRequestRef, add: optionalUnknown, remove: optionalUnknown }),
  result: GitHubPullRequestDetailSchema,
  critical: [],
});

export const changeGitHubPullRequestLabelCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "change_github_pull_request_label",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...pullRequestRef, name: Schema.String, present: Schema.Boolean }),
  result: Schema.mutable(Schema.Array(GitHubPullRequestLabelSchema)),
  critical: [],
});

export const setGitHubPullRequestLabelsCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "set_github_pull_request_labels",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...pullRequestRef, labels: optionalUnknown }),
  result: Schema.mutable(Schema.Array(GitHubPullRequestLabelSchema)),
  critical: [],
});

export const listGitHubRepositoryAssignableUsersCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "list_github_repository_assignable_users",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct(repositoryRef),
  result: Schema.mutable(Schema.Array(GitHubRepositoryMemberOptionSchema)),
  critical: [],
});

export const listGitHubRepositoryLabelsCommand = defineCommand({
  domain: pullRequestsDomain,
  name: "list_github_repository_labels",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct(repositoryRef),
  result: Schema.mutable(Schema.Array(GitHubPullRequestLabelSchema)),
  critical: [],
});

export const GITHUB_PULL_REQUEST_COMMANDS = [
  listGitHubPullRequestsCommand,
  getGitHubPullRequestCommand,
  getGitHubPullRequestTimelineCommand,
  getGitHubPullRequestFilesCommand,
  mergeGitHubPullRequestCommand,
  updateGitHubPullRequestStateCommand,
  addGitHubPullRequestCommentCommand,
  updateGitHubPullRequestCommentCommand,
  submitGitHubPullRequestReviewCommand,
  addGitHubPullRequestReviewCommentCommand,
  replyGitHubPullRequestReviewThreadCommand,
  setGitHubPullRequestThreadResolvedCommand,
  setGitHubPullRequestFileViewedCommand,
  setGitHubPullRequestReviewersCommand,
  changeGitHubPullRequestLabelCommand,
  setGitHubPullRequestLabelsCommand,
  listGitHubRepositoryAssignableUsersCommand,
  listGitHubRepositoryLabelsCommand,
] as const;
