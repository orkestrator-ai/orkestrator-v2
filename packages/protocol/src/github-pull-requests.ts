/**
 * Contract for the in-app pull request viewer.
 *
 * The backend reads and writes pull requests through the GitHub REST and
 * GraphQL APIs with the host's GitHub credential, so the viewer works the same
 * for worktree and container environments. Every command addresses a pull
 * request by `{ owner, repo, number }`; only the list command is project
 * scoped. This module is shared with the renderer and must stay free of Node
 * or Bun imports.
 */

import type { ChangeDiffHunk, ChangeFileStatus } from "./change-resources.js";

export type GitHubPullRequestRef = {
  owner: string;
  repo: string;
  number: number;
};

export type GitHubPullRequestUser = {
  login: string;
  avatarUrl?: string;
  htmlUrl?: string;
};

export type GitHubPullRequestLabel = {
  name: string;
  /** Hex colour without `#`, empty when unknown. */
  color: string;
  description?: string;
};

export type GitHubPullRequestState = "open" | "closed" | "merged";

/** Rolled-up CI state for the head commit. */
export type GitHubPullRequestChecksState = "success" | "failure" | "pending" | "neutral" | "none";

export type GitHubPullRequestListFilter = "open" | "mine" | "review-requested" | "closed";

export type GitHubPullRequestListItem = {
  number: number;
  title: string;
  htmlUrl: string;
  state: GitHubPullRequestState;
  isDraft: boolean;
  author: GitHubPullRequestUser | null;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
  labels: GitHubPullRequestLabel[];
  /** Absent when the list endpoint does not report it. */
  checksState?: GitHubPullRequestChecksState;
};

export type GitHubPullRequestListResult = {
  repository: { owner: string; repo: string; fullName: string; htmlUrl: string };
  viewer: GitHubPullRequestUser;
  filter: GitHubPullRequestListFilter;
  pullRequests: GitHubPullRequestListItem[];
  /** True when more results exist than were returned (the list is capped). */
  hasMore: boolean;
};

export type GitHubPullRequestReviewState =
  | "approved"
  | "changes-requested"
  | "commented"
  | "dismissed"
  | "pending";

export type GitHubPullRequestReviewer = {
  /** A user login, or `org/team-slug` for a team. */
  login: string;
  kind: "user" | "team";
  avatarUrl?: string;
  /** Latest submitted review state, absent when only requested. */
  state?: GitHubPullRequestReviewState;
  /** Still in `requested_reviewers` (review outstanding). */
  requested: boolean;
};

export type GitHubPullRequestCheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed-out"
  | "action-required"
  | "stale"
  | "pending";

export type GitHubPullRequestCheck = {
  name: string;
  /** Workflow or status context, when known. */
  context?: string;
  conclusion: GitHubPullRequestCheckConclusion;
  detailsUrl?: string;
  summary?: string;
};

export type GitHubPullRequestComment = {
  id: number;
  /** GraphQL node id; used for reactions and minimising. */
  nodeId?: string;
  body: string;
  htmlUrl: string;
  author: GitHubPullRequestUser | null;
  createdAt: string;
  updatedAt: string;
  isEdited: boolean;
  canEdit: boolean;
};

export type GitHubPullRequestMergeMethod = "merge" | "squash" | "rebase";

export type GitHubPullRequestMergeability =
  /** Mergeable and all requirements met. */
  | "clean"
  /** Mergeable but a requirement (review, check) is unmet. */
  | "blocked"
  /** Has conflicts with the base branch. */
  | "dirty"
  /** Head is behind base and the base requires up-to-date branches. */
  | "behind"
  /** Mergeable, but some checks are failing or pending. */
  | "unstable"
  /** GitHub is still computing mergeability. */
  | "unknown"
  /** Not applicable (closed, merged, or draft). */
  | "unavailable";

export type GitHubPullRequestDetail = {
  ref: GitHubPullRequestRef;
  /** GraphQL node id for mutations that only exist in GraphQL. */
  nodeId: string;
  title: string;
  body: string;
  htmlUrl: string;
  state: GitHubPullRequestState;
  isDraft: boolean;
  author: GitHubPullRequestUser | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  mergedBy: GitHubPullRequestUser | null;
  baseRef: string;
  headRef: string;
  headSha: string;
  /** `owner/repo` of the head when it lives in a fork. */
  headRepositoryFullName: string | null;
  isCrossRepository: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitsCount: number;
  commentsCount: number;
  reviewCommentsCount: number;
  labels: GitHubPullRequestLabel[];
  assignees: GitHubPullRequestUser[];
  reviewers: GitHubPullRequestReviewer[];
  checks: GitHubPullRequestCheck[];
  checksState: GitHubPullRequestChecksState;
  /** Top-level conversation comments (issue comments), oldest first. */
  comments: GitHubPullRequestComment[];
  /** Older loaded subset; GitHub contains additional comments. */
  commentsTruncated?: boolean;
  mergeability: GitHubPullRequestMergeability;
  /** Merge methods the repository allows. */
  allowedMergeMethods: GitHubPullRequestMergeMethod[];
  viewer: GitHubPullRequestUser;
  viewerPermissions: {
    /** Push, maintain or admin on the base repository. */
    canWrite: boolean;
    canMerge: boolean;
    /** The viewer authored the PR; GitHub refuses self-approval. */
    isAuthor: boolean;
  };
};

export type GitHubPullRequestTimelineItem =
  | {
      kind: "commit";
      id: string;
      sha: string;
      message: string;
      author: GitHubPullRequestUser | null;
      /** Display name when the commit author has no GitHub account. */
      authorName?: string;
      createdAt: string;
      htmlUrl?: string;
    }
  | {
      kind: "comment";
      id: string;
      comment: GitHubPullRequestComment;
    }
  | {
      kind: "review";
      id: string;
      reviewId: number;
      state: GitHubPullRequestReviewState;
      body: string;
      author: GitHubPullRequestUser | null;
      createdAt: string;
      htmlUrl?: string;
      /** Number of inline comments submitted with the review. */
      inlineCommentsCount: number;
    }
  | {
      kind: "event";
      id: string;
      /**
       * opened | closed | reopened | merged | ready-for-review |
       * converted-to-draft | head-ref-force-pushed | head-ref-deleted |
       * base-ref-changed | labeled | unlabeled | review-requested |
       * review-request-removed | assigned | unassigned | renamed | other
       */
      event: string;
      actor: GitHubPullRequestUser | null;
      createdAt: string;
      /** Short human detail, e.g. a label name, reviewer or new title. */
      detail?: string;
    };

export type GitHubPullRequestTimeline = {
  ref: GitHubPullRequestRef;
  /** Oldest first. */
  items: GitHubPullRequestTimelineItem[];
  /** The timeline was capped before its end. */
  truncated: boolean;
};

export type GitHubPullRequestViewedState = "viewed" | "unviewed" | "dismissed";

export type GitHubPullRequestFile = {
  path: string;
  previousPath: string | null;
  status: ChangeFileStatus;
  additions: number;
  deletions: number;
  /** Parsed hunks with old/new line numbers. Empty when `patchAvailable` is false. */
  hunks: ChangeDiffHunk[];
  /**
   * False for binary files and for patches GitHub omits because they are too
   * large; the UI links to GitHub instead.
   */
  patchAvailable: boolean;
  viewedState: GitHubPullRequestViewedState;
  blobUrl?: string;
};

export type GitHubPullRequestReviewThreadComment = {
  id: number;
  nodeId: string;
  body: string;
  author: GitHubPullRequestUser | null;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  /** Unified diff context GitHub stored with the first comment. */
  diffHunk?: string;
};

export type GitHubPullRequestReviewThread = {
  /** GraphQL node id, used to resolve/unresolve and to reply. */
  id: string;
  path: string;
  /** Line in the new file (RIGHT) or old file (LEFT); null when outdated. */
  line: number | null;
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  comments: GitHubPullRequestReviewThreadComment[];
  commentsTruncated?: boolean;
};

export type GitHubPullRequestFiles = {
  ref: GitHubPullRequestRef;
  headSha: string;
  files: GitHubPullRequestFile[];
  threads: GitHubPullRequestReviewThread[];
  /** GitHub caps the file list (3000 files); true when the PR exceeds it. */
  truncated: boolean;
};

export type GitHubPullRequestReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export type GitHubPullRequestInlineCommentInput = {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  /** Set for a multi-line comment; must be below `line`. */
  startLine?: number;
  body: string;
};

export type GitHubPullRequestMergeResult = {
  merged: boolean;
  sha?: string;
  message?: string;
  branchDeleted?: boolean;
};

export type GitHubRepositoryMemberOption = {
  login: string;
  avatarUrl?: string;
};

/** Values for `?tab=` style deep links into the viewer. */
export type GitHubPullRequestViewTab = "summary" | "timeline" | "code";

export type ParsedGitHubPullRequestUrl = GitHubPullRequestRef & {
  view: GitHubPullRequestViewTab;
};

const VALID_REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

/** `.` and `..` match the character class but would traverse API paths. */
function isRepositoryPart(value: string): boolean {
  return VALID_REPOSITORY_PART.test(value) && value !== "." && value !== "..";
}

/**
 * Recognises github.com pull request links, including sub-pages such as
 * `/files`, `/commits` or `/checks` and comment anchors. Returns null for
 * anything else so callers can fall back to opening the link externally.
 */
export function parseGitHubPullRequestLink(href: string): ParsedGitHubPullRequestUrl | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (host !== "github.com" && host !== "www.github.com")) {
    return null;
  }
  if (url.username || url.password) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repo, pull, numberPart, subPage, ...rest] = parts;
  if (!owner || !repo || pull !== "pull" || !numberPart || rest.length > 1) return null;
  if (!isRepositoryPart(owner) || !isRepositoryPart(repo)) return null;
  if (!/^[1-9]\d*$/.test(numberPart)) return null;
  const number = Number(numberPart);
  if (!Number.isSafeInteger(number)) return null;
  let view: GitHubPullRequestViewTab = "summary";
  if (subPage === "files" || subPage === "changes") view = "code";
  else if (subPage === "commits") view = "timeline";
  else if (subPage !== undefined && subPage !== "checks") return null;
  return { owner, repo, number, view };
}

export function gitHubPullRequestKey(ref: GitHubPullRequestRef): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

export function gitHubPullRequestUrl(ref: GitHubPullRequestRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

export function isGitHubPullRequestRef(value: unknown): value is GitHubPullRequestRef {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.owner === "string" &&
    isRepositoryPart(record.owner) &&
    typeof record.repo === "string" &&
    isRepositoryPart(record.repo) &&
    typeof record.number === "number" &&
    Number.isSafeInteger(record.number) &&
    record.number > 0
  );
}
