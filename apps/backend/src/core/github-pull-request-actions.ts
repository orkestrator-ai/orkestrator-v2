/**
 * Pull request mutations for the in-app viewer: merge, state, conversation
 * comments, reviews, review threads, viewed files, reviewers and labels.
 */
import type {
  GitHubPullRequestComment,
  GitHubPullRequestDetail,
  GitHubPullRequestInlineCommentInput,
  GitHubPullRequestLabel,
  GitHubPullRequestMergeMethod,
  GitHubPullRequestMergeResult,
  GitHubPullRequestRef,
  GitHubPullRequestReviewEvent,
  GitHubPullRequestReviewThreadComment,
  GitHubPullRequestViewedState,
  GitHubRepositoryMemberOption,
} from "@orkestrator/protocol/github-pull-requests";
import {
  GitHubApiError,
  commentBelongsToIssue,
  githubRequest,
  isRecord,
  numberValue,
  optionalString,
  stringValue,
} from "./github.js";
import {
  reviewThreadCommentFromGraphql,
  reviewThreadCommentFromRest,
} from "./github-pull-request-files.js";
import {
  assertPullRequestRef,
  assertRepositoryCoordinates,
  canEditComment,
  getGitHubPullRequest,
  getJson,
  getList,
  graphql,
  isCommitSha,
  isCrossRepositoryPull,
  issuePath,
  loadPullRequestRecord,
  loadViewerIdentity,
  prComment,
  prLabels,
  prUser,
  pullNodeId,
  pullPath,
  pullRequestClient,
  pullRequestState,
  repoPath,
  sendJson,
  type GitHubPullRequestClient,
  type GitHubPullRequestRequestOptions,
  type GitHubRepositoryCoordinates,
} from "./github-pull-requests.js";

export type GitHubPullRequestStateAction =
  "close" | "reopen" | "ready-for-review" | "convert-to-draft";

export const MAX_COMMENT_BODY_LENGTH = 65_536;
const MAX_PATH_LENGTH = 4_096;
const MAX_REVIEW_COMMENTS = 200;
const MAX_REVIEWER_CHANGES = 100;
const MAX_LABELS = 100;
const MAX_LABEL_NAME_LENGTH = 100;
const MAX_ASSIGNABLE_USERS = 300;
const MAX_REPOSITORY_LABELS = 1_000;
const USER_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TEAM_SLUG = /^[A-Za-z0-9_.-]{1,100}$/;
const NODE_ID = /^[A-Za-z0-9_=-]{1,200}$/;
const MERGE_METHODS = new Set<GitHubPullRequestMergeMethod>(["merge", "squash", "rebase"]);
const REVIEW_EVENTS = new Set<GitHubPullRequestReviewEvent>([
  "APPROVE",
  "REQUEST_CHANGES",
  "COMMENT",
]);

function validation(message: string): GitHubApiError {
  return new GitHubApiError(message, { code: "validation" });
}

function requireBody(body: string, what: string): string {
  if (typeof body !== "string" || !body.trim()) throw validation(`${what} cannot be empty.`);
  if (body.length > MAX_COMMENT_BODY_LENGTH) {
    throw validation(`${what} is longer than GitHub's ${MAX_COMMENT_BODY_LENGTH} character limit.`);
  }
  return body;
}

function requireCommitSha(value: string, name: string): string {
  if (typeof value !== "string" || !isCommitSha(value)) {
    throw validation(`${name} must be a full commit SHA.`);
  }
  return value;
}

function requireNodeId(value: string, name: string): string {
  if (typeof value !== "string" || !NODE_ID.test(value)) {
    throw validation(`${name} is not a valid GitHub id.`);
  }
  return value;
}

function requirePath(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_PATH_LENGTH) {
    throw validation("A valid file path is required.");
  }
  return value;
}

/** Validate one inline comment and convert it to GitHub's REST shape. */
export function inlineCommentPayload(comment: GitHubPullRequestInlineCommentInput) {
  if (!isRecord(comment)) throw validation("Each inline comment must be an object.");
  const path = requirePath(comment.path);
  if (!Number.isSafeInteger(comment.line) || comment.line <= 0) {
    throw validation("Inline comment line must be a positive integer.");
  }
  if (comment.side !== "LEFT" && comment.side !== "RIGHT") {
    throw validation("Inline comment side must be LEFT or RIGHT.");
  }
  if (
    comment.startLine !== undefined &&
    (!Number.isSafeInteger(comment.startLine) ||
      comment.startLine <= 0 ||
      comment.startLine >= comment.line)
  ) {
    throw validation("Inline comment start line must be a positive integer below its line.");
  }
  return {
    path,
    line: comment.line,
    side: comment.side,
    ...(comment.startLine !== undefined
      ? { start_line: comment.startLine, start_side: comment.side }
      : {}),
    body: requireBody(comment.body, "Inline comment"),
  };
}

/** Surface GitHub's own reason (e.g. "Head branch was modified") for refused merges. */
function mergeError(error: unknown, ref: GitHubPullRequestRef): unknown {
  if (
    error instanceof GitHubApiError &&
    error.detail &&
    (error.status === 405 || error.status === 409 || error.status === 422)
  ) {
    return new GitHubApiError(
      `GitHub could not merge pull request #${ref.number}: ${error.detail}`,
      {
        status: error.status,
        code: error.status === 422 ? "validation" : "github",
        detail: error.detail,
      },
    );
  }
  return error;
}

function encodeGitRef(ref: string): string | null {
  const segments = ref.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments.map(encodeURIComponent).join("/");
}

async function deleteHeadBranch(
  client: GitHubPullRequestClient,
  ref: GitHubPullRequestRef,
  headRef: string,
): Promise<boolean> {
  const encoded = encodeGitRef(headRef);
  if (!encoded) return false;
  try {
    await githubRequest(
      client.token,
      `${repoPath(ref)}/git/refs/heads/${encoded}`,
      `delete the head branch of pull request #${ref.number}`,
      { method: "DELETE" },
      client.fetchImpl,
      { subject: "pull-request" },
    );
    return true;
  } catch (error) {
    // Auto-delete or a concurrent cleanup already removed it.
    if (error instanceof GitHubApiError && (error.status === 404 || error.status === 422)) {
      try {
        // A refusal (including default-branch protection) is not proof of absence.
        await githubRequest(
          client.token,
          `${repoPath(ref)}/git/ref/heads/${encoded}`,
          "verify the head branch was deleted",
          {},
          client.fetchImpl,
          { subject: "pull-request" },
        );
      } catch (lookupError) {
        if (lookupError instanceof GitHubApiError && lookupError.status === 404) return true;
        throw lookupError;
      }
    }
    throw error;
  }
}

export async function mergeGitHubPullRequest(
  token: string,
  ref: GitHubPullRequestRef,
  input: {
    method: GitHubPullRequestMergeMethod;
    deleteBranch: boolean;
    expectedHeadSha?: string;
  },
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestMergeResult> {
  assertPullRequestRef(ref);
  if (!MERGE_METHODS.has(input.method))
    throw validation("Merge method must be merge, squash or rebase.");
  const expectedHeadSha =
    input.expectedHeadSha === undefined
      ? undefined
      : requireCommitSha(input.expectedHeadSha, "Expected head SHA");
  const client = pullRequestClient(token, options);
  const pull = input.deleteBranch ? await loadPullRequestRecord(client, ref) : null;

  let data: unknown;
  try {
    data = await sendJson(
      client,
      `${pullPath(ref)}/merge`,
      `merge pull request #${ref.number}`,
      "PUT",
      { merge_method: input.method, ...(expectedHeadSha ? { sha: expectedHeadSha } : {}) },
    );
  } catch (error) {
    throw mergeError(error, ref);
  }
  const record = isRecord(data) ? data : {};
  const merged = record.merged === true;
  const result: GitHubPullRequestMergeResult = {
    merged,
    sha: optionalString(record.sha),
    message: optionalString(record.message),
  };
  if (!merged || !pull) return result;
  if (isCrossRepositoryPull(pull)) return { ...result, branchDeleted: false };
  const head = isRecord(pull.head) ? pull.head : {};
  try {
    return { ...result, branchDeleted: await deleteHeadBranch(client, ref, stringValue(head.ref)) };
  } catch {
    return {
      ...result,
      branchDeleted: false,
      message: "Merged, but GitHub could not delete the head branch.",
    };
  }
}

const READY_FOR_REVIEW_MUTATION = `mutation MarkReady($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id isDraft } }
}`;

const CONVERT_TO_DRAFT_MUTATION = `mutation ConvertToDraft($id: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id isDraft } }
}`;

export async function updateGitHubPullRequestState(
  token: string,
  ref: GitHubPullRequestRef,
  action: GitHubPullRequestStateAction,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestDetail> {
  assertPullRequestRef(ref);
  const client = pullRequestClient(token, options);
  switch (action) {
    case "close":
    case "reopen":
      await sendJson(client, pullPath(ref), `${action} pull request #${ref.number}`, "PATCH", {
        state: action === "close" ? "closed" : "open",
      });
      break;
    case "ready-for-review":
    case "convert-to-draft": {
      const pull = await loadPullRequestRecord(client, ref);
      if (pullRequestState(pull) !== "open") {
        throw validation(`Pull request #${ref.number} is not open.`);
      }
      await graphql(
        client,
        action === "ready-for-review" ? READY_FOR_REVIEW_MUTATION : CONVERT_TO_DRAFT_MUTATION,
        { id: pullNodeId(pull, ref) },
        action === "ready-for-review"
          ? `mark pull request #${ref.number} ready for review`
          : `convert pull request #${ref.number} to a draft`,
      );
      break;
    }
    default:
      throw validation("Unknown pull request state action.");
  }
  return getGitHubPullRequest(token, ref, options);
}

export async function addGitHubPullRequestComment(
  token: string,
  ref: GitHubPullRequestRef,
  body: string,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestComment> {
  assertPullRequestRef(ref);
  requireBody(body, "Comment");
  const client = pullRequestClient(token, options);
  const data = await sendJson(
    client,
    `${issuePath(ref)}/comments`,
    `add a comment to pull request #${ref.number}`,
    "POST",
    { body },
  );
  const comment = prComment(data, true);
  if (!comment) {
    throw new GitHubApiError(
      `GitHub returned an invalid comment for pull request #${ref.number}. Refresh and try again.`,
    );
  }
  return comment;
}

export async function updateGitHubPullRequestComment(
  token: string,
  ref: GitHubPullRequestRef,
  commentId: number,
  body: string,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestComment> {
  assertPullRequestRef(ref);
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    throw validation("Comment ID must be a positive integer.");
  }
  requireBody(body, "Comment");
  const client = pullRequestClient(token, options);
  const commentPath = `${repoPath(ref)}/issues/comments/${commentId}`;
  const [current, identity] = await Promise.all([
    getJson(client, commentPath, `load comment ${commentId}`, { cached: false }),
    loadViewerIdentity(client, ref),
  ]);
  if (!commentBelongsToIssue(current.data, { owner: ref.owner, name: ref.repo }, ref.number)) {
    throw validation(
      `Comment ${commentId} does not belong to pull request #${ref.number}. Refresh the conversation and try again.`,
    );
  }
  const existing = prComment(current.data);
  if (!existing) {
    throw new GitHubApiError(
      `GitHub returned an invalid comment ${commentId}. Refresh and try again.`,
    );
  }
  if (!canEditComment(existing, identity)) {
    throw new GitHubApiError(
      "The authenticated GitHub user does not have permission to edit this comment.",
      { code: "permission", status: 403 },
    );
  }
  const data = await sendJson(client, commentPath, `edit comment ${commentId}`, "PATCH", { body });
  const comment = prComment(data, true);
  if (!comment) {
    throw new GitHubApiError(
      `GitHub returned an invalid comment update for ${commentId}. Refresh and try again.`,
    );
  }
  return comment;
}

export async function submitGitHubPullRequestReview(
  token: string,
  ref: GitHubPullRequestRef,
  review: {
    event: GitHubPullRequestReviewEvent;
    body: string;
    commitId?: string;
    comments?: GitHubPullRequestInlineCommentInput[];
  },
  options: GitHubPullRequestRequestOptions = {},
): Promise<{ reviewId: number }> {
  assertPullRequestRef(ref);
  if (!REVIEW_EVENTS.has(review.event)) {
    throw validation("Review event must be APPROVE, REQUEST_CHANGES or COMMENT.");
  }
  if (typeof review.body !== "string") throw validation("Review body must be text.");
  const comments = review.comments ?? [];
  if (!Array.isArray(comments)) throw validation("Review comments must be a list.");
  if (comments.length > MAX_REVIEW_COMMENTS) {
    throw validation(`A review can include at most ${MAX_REVIEW_COMMENTS} inline comments.`);
  }
  const hasBody = review.body.trim().length > 0;
  if (review.event === "REQUEST_CHANGES" && !hasBody) {
    throw validation("Requesting changes needs a review comment explaining what to change.");
  }
  if (review.event === "COMMENT" && !hasBody && comments.length === 0) {
    throw validation("A comment review needs a summary or at least one inline comment.");
  }
  if (hasBody) requireBody(review.body, "Review body");
  const payloadComments = comments.map(inlineCommentPayload);
  const commitId =
    review.commitId === undefined ? undefined : requireCommitSha(review.commitId, "Commit ID");
  const client = pullRequestClient(token, options);
  const data = await sendJson(
    client,
    `${pullPath(ref)}/reviews`,
    `submit a review on pull request #${ref.number}`,
    "POST",
    {
      event: review.event,
      ...(hasBody ? { body: review.body } : {}),
      ...(commitId ? { commit_id: commitId } : {}),
      ...(payloadComments.length > 0 ? { comments: payloadComments } : {}),
    },
  );
  const reviewId = isRecord(data) ? numberValue(data.id) : 0;
  if (!reviewId) {
    throw new GitHubApiError(
      `GitHub returned an invalid review for pull request #${ref.number}. Refresh and try again.`,
    );
  }
  return { reviewId };
}

export async function addGitHubPullRequestReviewComment(
  token: string,
  ref: GitHubPullRequestRef,
  commitId: string,
  comment: GitHubPullRequestInlineCommentInput,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestReviewThreadComment> {
  assertPullRequestRef(ref);
  const sha = requireCommitSha(commitId, "Commit ID");
  const payload = inlineCommentPayload(comment);
  const client = pullRequestClient(token, options);
  const data = await sendJson(
    client,
    `${pullPath(ref)}/comments`,
    `add a review comment to pull request #${ref.number}`,
    "POST",
    { ...payload, commit_id: sha },
  );
  const created = reviewThreadCommentFromRest(data);
  if (!created) {
    throw new GitHubApiError(
      `GitHub returned an invalid review comment for pull request #${ref.number}. Refresh and try again.`,
    );
  }
  return created;
}

const THREAD_OWNER_QUERY = `query ReviewThreadOwner($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } }
  }
}`;

/** Thread ids are global; refuse to act on a thread from another pull request. */
async function assertThreadBelongsToPullRequest(
  client: GitHubPullRequestClient,
  ref: GitHubPullRequestRef,
  threadId: string,
): Promise<void> {
  const data = await graphql<Record<string, unknown>>(
    client,
    THREAD_OWNER_QUERY,
    { id: threadId },
    "load the review thread",
  );
  const node = isRecord(data.node) ? data.node : null;
  const pullRequest = node && isRecord(node.pullRequest) ? node.pullRequest : null;
  const repository =
    pullRequest && isRecord(pullRequest.repository) ? pullRequest.repository : null;
  if (
    !pullRequest ||
    numberValue(pullRequest.number) !== ref.number ||
    stringValue(repository?.nameWithOwner).toLowerCase() !==
      `${ref.owner}/${ref.repo}`.toLowerCase()
  ) {
    throw validation(
      `The review thread does not belong to pull request #${ref.number}. Refresh and try again.`,
    );
  }
}

const THREAD_REPLY_MUTATION = `mutation ReplyToThread($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { databaseId id body author { login avatarUrl url } createdAt updatedAt url }
  }
}`;

export async function replyGitHubPullRequestReviewThread(
  token: string,
  ref: GitHubPullRequestRef,
  threadId: string,
  body: string,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestReviewThreadComment> {
  assertPullRequestRef(ref);
  requireNodeId(threadId, "Thread ID");
  requireBody(body, "Reply");
  const client = pullRequestClient(token, options);
  await assertThreadBelongsToPullRequest(client, ref, threadId);
  const data = await graphql<Record<string, unknown>>(
    client,
    THREAD_REPLY_MUTATION,
    { threadId, body },
    `reply to a review thread on pull request #${ref.number}`,
  );
  const payload = isRecord(data.addPullRequestReviewThreadReply)
    ? data.addPullRequestReviewThreadReply
    : {};
  const comment = reviewThreadCommentFromGraphql(payload.comment, false);
  if (!comment) {
    throw new GitHubApiError("GitHub returned an invalid reply. Refresh and try again.");
  }
  return comment;
}

const RESOLVE_THREAD_MUTATION = `mutation ResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`;

const UNRESOLVE_THREAD_MUTATION = `mutation UnresolveThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`;

export async function setGitHubPullRequestThreadResolved(
  token: string,
  ref: GitHubPullRequestRef,
  threadId: string,
  resolved: boolean,
  options: GitHubPullRequestRequestOptions = {},
): Promise<{ isResolved: boolean }> {
  assertPullRequestRef(ref);
  requireNodeId(threadId, "Thread ID");
  const client = pullRequestClient(token, options);
  await assertThreadBelongsToPullRequest(client, ref, threadId);
  const field = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const data = await graphql<Record<string, unknown>>(
    client,
    resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION,
    { threadId },
    `${resolved ? "resolve" : "unresolve"} a review thread on pull request #${ref.number}`,
  );
  const payload = isRecord(data[field]) ? data[field] : {};
  const thread = isRecord(payload.thread) ? payload.thread : {};
  return { isResolved: typeof thread.isResolved === "boolean" ? thread.isResolved : resolved };
}

const MARK_VIEWED_MUTATION = `mutation MarkFileViewed($id: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $id, path: $path }) { pullRequest { id } }
}`;

const UNMARK_VIEWED_MUTATION = `mutation UnmarkFileViewed($id: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { pullRequest { id } }
}`;

export async function setGitHubPullRequestFileViewed(
  token: string,
  ref: GitHubPullRequestRef,
  path: string,
  viewed: boolean,
  options: GitHubPullRequestRequestOptions = {},
): Promise<{ viewedState: GitHubPullRequestViewedState }> {
  assertPullRequestRef(ref);
  requirePath(path);
  const client = pullRequestClient(token, options);
  const pull = await loadPullRequestRecord(client, ref);
  await graphql(
    client,
    viewed ? MARK_VIEWED_MUTATION : UNMARK_VIEWED_MUTATION,
    { id: pullNodeId(pull, ref), path },
    `mark a file as ${viewed ? "viewed" : "not viewed"} on pull request #${ref.number}`,
  );
  return { viewedState: viewed ? "viewed" : "unviewed" };
}

/** Split `login` / `org/team-slug` entries into REST's reviewers and team_reviewers. */
export function reviewerPayload(
  ref: GitHubPullRequestRef,
  entries: readonly string[],
): { reviewers: string[]; team_reviewers: string[] } {
  if (!Array.isArray(entries) || entries.length > MAX_REVIEWER_CHANGES) {
    throw validation(`Reviewer changes must be a list of at most ${MAX_REVIEWER_CHANGES} entries.`);
  }
  const reviewers = new Set<string>();
  const teams = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") throw validation("Reviewer entries must be text.");
    const value = entry.trim();
    const slash = value.indexOf("/");
    if (slash >= 0) {
      const org = value.slice(0, slash);
      const slug = value.slice(slash + 1);
      if (org.toLowerCase() !== ref.owner.toLowerCase() || !TEAM_SLUG.test(slug)) {
        throw validation(`Team reviewer "${value}" must be a team in ${ref.owner}.`);
      }
      teams.add(slug);
    } else {
      if (!USER_LOGIN.test(value)) throw validation(`"${value}" is not a valid GitHub login.`);
      reviewers.add(value);
    }
  }
  return { reviewers: Array.from(reviewers), team_reviewers: Array.from(teams) };
}

export async function setGitHubPullRequestReviewers(
  token: string,
  ref: GitHubPullRequestRef,
  changes: { add: string[]; remove: string[] },
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestDetail> {
  assertPullRequestRef(ref);
  const add = reviewerPayload(ref, changes.add);
  const remove = reviewerPayload(ref, changes.remove);
  const client = pullRequestClient(token, options);
  const path = `${pullPath(ref)}/requested_reviewers`;
  if (remove.reviewers.length > 0 || remove.team_reviewers.length > 0) {
    await sendJson(
      client,
      path,
      `remove reviewers from pull request #${ref.number}`,
      "DELETE",
      remove,
    );
  }
  if (add.reviewers.length > 0 || add.team_reviewers.length > 0) {
    await sendJson(client, path, `request reviewers on pull request #${ref.number}`, "POST", add);
  }
  return getGitHubPullRequest(token, ref, options);
}

export async function setGitHubPullRequestLabels(
  token: string,
  ref: GitHubPullRequestRef,
  labels: string[],
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestLabel[]> {
  assertPullRequestRef(ref);
  if (!Array.isArray(labels) || labels.length > MAX_LABELS) {
    throw validation(`Labels must be a list of at most ${MAX_LABELS} names.`);
  }
  const names = new Set<string>();
  for (const label of labels) {
    const name = typeof label === "string" ? label.trim() : "";
    if (!name || name.length > MAX_LABEL_NAME_LENGTH)
      throw validation("Label names must be non-empty text.");
    names.add(name);
  }
  const client = pullRequestClient(token, options);
  const data = await sendJson(
    client,
    `${issuePath(ref)}/labels`,
    `set labels on pull request #${ref.number}`,
    "PUT",
    { labels: Array.from(names) },
  );
  if (!Array.isArray(data)) {
    throw new GitHubApiError(
      `GitHub returned invalid labels for pull request #${ref.number}. Refresh and try again.`,
    );
  }
  return prLabels(data);
}

/** Change only one label, leaving concurrent edits to other labels intact. */
export async function changeGitHubPullRequestLabel(
  token: string,
  ref: GitHubPullRequestRef,
  name: string,
  present: boolean,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestLabel[]> {
  assertPullRequestRef(ref);
  if (typeof name !== "string" || !name.trim() || name.length > MAX_LABEL_NAME_LENGTH) {
    throw validation("Label names must be non-empty text.");
  }
  const client = pullRequestClient(token, options);
  const path = `${issuePath(ref)}/labels`;
  const data = await sendJson(
    client,
    present ? path : `${path}/${encodeURIComponent(name)}`,
    "change a pull request label",
    present ? "POST" : "DELETE",
    present ? { labels: [name] } : undefined,
  );
  if (!Array.isArray(data))
    throw new GitHubApiError("GitHub returned invalid labels. Refresh and try again.");
  return prLabels(data);
}

export async function listGitHubRepositoryAssignableUsers(
  token: string,
  repository: GitHubRepositoryCoordinates,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubRepositoryMemberOption[]> {
  assertRepositoryCoordinates(repository);
  const client = pullRequestClient(token, options);
  const { values } = await getList(
    client,
    `${repoPath(repository)}/assignees`,
    "load assignable users",
    MAX_ASSIGNABLE_USERS,
  );
  return values
    .map(prUser)
    .filter((user) => user !== null)
    .map((user) => ({
      login: user.login,
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    }));
}

export async function listGitHubRepositoryLabels(
  token: string,
  repository: GitHubRepositoryCoordinates,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestLabel[]> {
  assertRepositoryCoordinates(repository);
  const client = pullRequestClient(token, options);
  const { values } = await getList(
    client,
    `${repoPath(repository)}/labels`,
    "load repository labels",
    MAX_REPOSITORY_LABELS,
  );
  return prLabels(values);
}
