/**
 * Pull request timeline from `GET /issues/{n}/timeline`, oldest first, with a
 * synthetic "opened" event at creation.
 */
import type {
  GitHubPullRequestRef,
  GitHubPullRequestTimeline,
  GitHubPullRequestTimelineItem,
  GitHubPullRequestUser,
} from "@orkestrator/protocol/github-pull-requests";
import { isRecord, numberValue, optionalString, stringValue } from "./github.js";
import {
  assertPullRequestRef,
  canEditComment,
  getList,
  issuePath,
  loadPullRequestRecord,
  loadViewerIdentity,
  prComment,
  prUser,
  pullPath,
  pullRequestClient,
  reviewStateFromApi,
  type GitHubPullRequestRequestOptions,
  type GitHubViewerIdentity,
} from "./github-pull-requests.js";

export const MAX_TIMELINE_ITEMS = 500;
/** `/pulls/{n}/commits` returns at most 250 commits. */
const MAX_COMMITS = 250;
const MAX_REVIEW_COMMENTS_COUNTED = 300;

/** Events the GitHub UI does not show, or that duplicate another item. */
const HIDDEN_EVENTS = new Set([
  "subscribed",
  "unsubscribed",
  "mentioned",
  "line-commented",
  "commit-commented",
  "comment_deleted",
]);

const EVENT_NAMES: Record<string, string> = {
  closed: "closed",
  reopened: "reopened",
  merged: "merged",
  ready_for_review: "ready-for-review",
  convert_to_draft: "converted-to-draft",
  head_ref_force_pushed: "head-ref-force-pushed",
  head_ref_deleted: "head-ref-deleted",
  base_ref_changed: "base-ref-changed",
  labeled: "labeled",
  unlabeled: "unlabeled",
  review_requested: "review-requested",
  review_request_removed: "review-request-removed",
  assigned: "assigned",
  unassigned: "unassigned",
  renamed: "renamed",
};

export type TimelineContext = {
  ref: GitHubPullRequestRef;
  identity: GitHubViewerIdentity;
  /** GitHub users for commit SHAs, from `/pulls/{n}/commits`. */
  commitAuthors: ReadonlyMap<string, GitHubPullRequestUser>;
  /** Inline comment count per review id. */
  reviewCommentCounts: ReadonlyMap<number, number>;
};

function eventDetail(event: string, value: Record<string, unknown>, ref: GitHubPullRequestRef) {
  switch (event) {
    case "labeled":
    case "unlabeled":
      return isRecord(value.label) ? optionalString(value.label.name) : undefined;
    case "review_requested":
    case "review_request_removed": {
      const user = prUser(value.requested_reviewer);
      if (user) return user.login;
      const team = isRecord(value.requested_team) ? optionalString(value.requested_team.slug) : "";
      return team ? `${ref.owner}/${team}` : undefined;
    }
    case "assigned":
    case "unassigned":
      return prUser(value.assignee)?.login;
    case "renamed": {
      const rename = isRecord(value.rename) ? value.rename : {};
      return `${stringValue(rename.from)} → ${stringValue(rename.to)}`;
    }
    default:
      return EVENT_NAMES[event] ? undefined : event.replace(/[_-]+/g, " ");
  }
}

/** Map one REST timeline entry; null for hidden or malformed entries. */
export function timelineItemFromApi(
  value: unknown,
  index: number,
  context: TimelineContext,
): GitHubPullRequestTimelineItem | null {
  if (!isRecord(value)) return null;
  const event = stringValue(value.event);
  if (!event || HIDDEN_EVENTS.has(event)) return null;

  if (event === "committed") {
    const sha = stringValue(value.sha);
    if (!sha) return null;
    const author = isRecord(value.author) ? value.author : {};
    const committer = isRecord(value.committer) ? value.committer : {};
    const authorName = optionalString(author.name);
    return {
      kind: "commit",
      id: `commit-${sha}`,
      sha,
      message: stringValue(value.message),
      author: context.commitAuthors.get(sha) ?? null,
      ...(authorName ? { authorName } : {}),
      createdAt: stringValue(committer.date) || stringValue(author.date),
      htmlUrl: optionalString(value.html_url),
    };
  }

  if (event === "opened") return null; // The authoritative PR record supplies the opened row.

  if (event === "commented") {
    const comment = prComment(value);
    if (!comment) return null;
    return {
      kind: "comment",
      id: `comment-${comment.id}`,
      comment: { ...comment, canEdit: canEditComment(comment, context.identity) },
    };
  }

  if (event === "reviewed") {
    const state = reviewStateFromApi(value.state);
    const reviewId = numberValue(value.id);
    if (!state || state === "pending" || !reviewId) return null;
    return {
      kind: "review",
      id: `review-${reviewId}`,
      reviewId,
      state,
      body: stringValue(value.body),
      author: prUser(value.user),
      createdAt: stringValue(value.submitted_at),
      htmlUrl: optionalString(value.html_url),
      inlineCommentsCount: context.reviewCommentCounts.get(reviewId) ?? 0,
    };
  }

  const detail = eventDetail(event, value, context.ref);
  const rawId = value.id ?? value.node_id;
  return {
    kind: "event",
    id: `event-${typeof rawId === "number" || typeof rawId === "string" ? rawId : `${event}-${index}`}`,
    event: EVENT_NAMES[event] ?? "other",
    actor: prUser(value.actor),
    createdAt: stringValue(value.created_at),
    ...(detail ? { detail } : {}),
  };
}

export async function getGitHubPullRequestTimeline(
  token: string,
  ref: GitHubPullRequestRef,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestTimeline> {
  assertPullRequestRef(ref);
  const client = pullRequestClient(token, options);
  // Inline comment counts and commit authors are best-effort decorations.
  const optional = <T>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
  const [pull, timeline, identity, commits, reviewComments] = await Promise.all([
    loadPullRequestRecord(client, ref),
    getList(
      client,
      `${issuePath(ref)}/timeline`,
      `load the timeline for pull request #${ref.number}`,
      MAX_TIMELINE_ITEMS,
    ),
    loadViewerIdentity(client, ref),
    optional(
      getList(client, `${pullPath(ref)}/commits`, "load pull request commits", MAX_COMMITS),
      { values: [], truncated: false },
    ),
    optional(
      getList(
        client,
        `${pullPath(ref)}/comments`,
        "load pull request review comments",
        MAX_REVIEW_COMMENTS_COUNTED,
      ),
      { values: [], truncated: false },
    ),
  ]);

  const commitAuthors = new Map<string, GitHubPullRequestUser>();
  for (const commit of commits.values) {
    if (!isRecord(commit)) continue;
    const user = prUser(commit.author);
    const sha = stringValue(commit.sha);
    if (user && sha) commitAuthors.set(sha, user);
  }
  const reviewCommentCounts = new Map<number, number>();
  for (const comment of reviewComments.values) {
    if (!isRecord(comment)) continue;
    const reviewId = numberValue(comment.pull_request_review_id);
    if (reviewId) reviewCommentCounts.set(reviewId, (reviewCommentCounts.get(reviewId) ?? 0) + 1);
  }

  const context: TimelineContext = { ref, identity, commitAuthors, reviewCommentCounts };
  const items: GitHubPullRequestTimelineItem[] = [
    {
      kind: "event",
      id: `opened-${ref.number}`,
      event: "opened",
      actor: prUser(pull.user),
      createdAt: stringValue(pull.created_at),
    },
  ];
  timeline.values.forEach((value, index) => {
    const item = timelineItemFromApi(value, index, context);
    if (item) items.push(item);
  });
  return {
    ref: { owner: ref.owner, repo: ref.repo, number: ref.number },
    items,
    truncated: timeline.truncated,
  };
}
