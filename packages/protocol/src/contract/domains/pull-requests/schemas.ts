/**
 * Result shapes of the `pull-requests` commands (plan item 7006): GitHub
 * issues (the Kanban's GitHub source), the GitHub pull request viewer, and an
 * environment's PR lifecycle (detection, verification, merge, monitor,
 * auto-merge, review packages).
 *
 * - **GitHub issues** are defined here field for field ({@link
 *   GitHubIssueSchema} and its parts), and the backend (`github.ts`) and the
 *   renderer (`types/github.ts`) take their types from these schemas instead
 *   of keeping two hand-written copies (plan item 7010's direction). A new
 *   literal in `state` or `status` is a change an older client cannot
 *   decode, so it bumps the domain.
 * - **GitHub pull request** records (`@orkestrator/protocol/github-pull-requests`)
 *   are large and keep growing; they are model records (`modelRecord`): the
 *   fields a reader routes on are declared and checked, every other key
 *   passes through, and the TypeScript type is the protocol type itself.
 * - The environment PR results are small closed shapes.
 *
 * Values a newer backend may extend on model records (states, checks,
 * mergeability) are `Schema.String`. Optional result fields use
 * `Schema.optional` (handlers spread `undefined` values, which the wire
 * drops but `optionalKey` refuses in tests).
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  GitHubPullRequestComment,
  GitHubPullRequestDetail,
  GitHubPullRequestFiles,
  GitHubPullRequestLabel,
  GitHubPullRequestListResult,
  GitHubPullRequestMergeResult,
  GitHubPullRequestReviewThreadComment,
  GitHubPullRequestTimeline,
  GitHubRepositoryMemberOption,
} from "../../../github-pull-requests.js";
import type { PrMonitorEnvironmentState, PrMonitorSnapshot } from "../../../pr-monitor.js";
import type { ReviewPackageReference } from "../../../review-workflow.js";
import { modelRecord, mutableArray, openRecord } from "../../model-schema.js";

const optionalString = Schema.optional(Schema.String);
const optionalBoolean = Schema.optional(Schema.Boolean);
const optionalNumber = Schema.optional(Schema.Finite);

// --- GitHub issues ------------------------------------------------------------

export const GitHubIssueStatusSchema = Schema.Literals(["backlog", "todo", "inprogress", "review"]);
export type GitHubIssueStatus = typeof GitHubIssueStatusSchema.Type;

export const GitHubUserSchema = Schema.Struct({
  login: Schema.String,
  avatarUrl: optionalString,
  htmlUrl: optionalString,
}).annotate({ identifier: "GitHubUser" });
export type GitHubUser = typeof GitHubUserSchema.Type;

export const GitHubLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
  description: optionalString,
}).annotate({ identifier: "GitHubLabel" });
export type GitHubLabel = typeof GitHubLabelSchema.Type;

const gitHubIssueFields = {
  id: Schema.Finite,
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  htmlUrl: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  locked: Schema.Boolean,
  author: Schema.NullOr(GitHubUserSchema),
  assignees: mutableArray(GitHubUserSchema),
  labels: mutableArray(GitHubLabelSchema),
  commentsCount: Schema.Finite,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  status: GitHubIssueStatusSchema,
};

export const GitHubIssueSchema = Schema.Struct(gitHubIssueFields).annotate({
  identifier: "GitHubIssue",
});
export type GitHubIssue = typeof GitHubIssueSchema.Type;

export const GitHubIssueCommentSchema = Schema.Struct({
  id: Schema.Finite,
  body: Schema.String,
  htmlUrl: Schema.String,
  author: Schema.NullOr(GitHubUserSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  isEdited: Schema.Boolean,
  canEdit: Schema.Boolean,
}).annotate({ identifier: "GitHubIssueComment" });
export type GitHubIssueComment = typeof GitHubIssueCommentSchema.Type;

/** The repository a project's GitHub issues come from (`GitHubRepositoryRef` plus display fields). */
export const GitHubRepositorySchema = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  fullName: Schema.String,
  htmlUrl: Schema.String,
}).annotate({ identifier: "GitHubRepository" });
export type GitHubRepository = typeof GitHubRepositorySchema.Type;

/** `get_github_issues`: the repository, the token's user and the open issues. */
export const GitHubIssuesSnapshotSchema = Schema.Struct({
  repository: GitHubRepositorySchema,
  viewer: GitHubUserSchema,
  issues: mutableArray(GitHubIssueSchema),
}).annotate({ identifier: "GitHubIssuesSnapshot" });
export type GitHubIssuesSnapshot = typeof GitHubIssuesSnapshotSchema.Type;

/** `get_github_issue`: one issue with its comments. */
export const GitHubIssueDetailSchema = Schema.Struct({
  ...gitHubIssueFields,
  comments: mutableArray(GitHubIssueCommentSchema),
}).annotate({ identifier: "GitHubIssueDetail" });
export type GitHubIssueDetail = typeof GitHubIssueDetailSchema.Type;

/** `post_github_completion_comment`: posted now, or found from an earlier attempt. */
export const GitHubCompletionCommentResultSchema = Schema.Struct({
  status: Schema.Literals(["posted", "already-posted"]),
  commentId: Schema.String,
  postedAt: optionalString,
}).annotate({ identifier: "GitHubCompletionCommentResult" });
export type GitHubCompletionCommentResult = typeof GitHubCompletionCommentResultSchema.Type;

// --- GitHub pull requests -----------------------------------------------------

const PullRequestRefSchema = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Finite,
});

const PullRequestUserSchema = openRecord({ login: Schema.String });

export const GitHubPullRequestLabelSchema = modelRecord<GitHubPullRequestLabel>()({
  name: Schema.String,
  color: Schema.String,
}).annotate({ identifier: "GitHubPullRequestLabel" });

export const GitHubPullRequestListResultSchema = modelRecord<GitHubPullRequestListResult>()({
  filter: Schema.String,
  hasMore: Schema.Boolean,
  pullRequests: Schema.Array(
    openRecord({
      number: Schema.Finite,
      title: Schema.String,
      htmlUrl: Schema.String,
      state: Schema.String,
      isDraft: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "GitHubPullRequestListResult" });

export const GitHubPullRequestCommentSchema = modelRecord<GitHubPullRequestComment>()({
  id: Schema.Finite,
  body: Schema.String,
  htmlUrl: Schema.String,
  author: Schema.NullOr(PullRequestUserSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  isEdited: Schema.Boolean,
  canEdit: Schema.Boolean,
}).annotate({ identifier: "GitHubPullRequestComment" });

export const GitHubPullRequestDetailSchema = modelRecord<GitHubPullRequestDetail>()({
  ref: PullRequestRefSchema,
  nodeId: Schema.String,
  title: Schema.String,
  htmlUrl: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  baseRef: Schema.String,
  headRef: Schema.String,
  headSha: Schema.String,
  labels: Schema.Array(GitHubPullRequestLabelSchema),
  checksState: Schema.String,
  mergeability: Schema.String,
  allowedMergeMethods: Schema.Array(Schema.String),
  viewerPermissions: Schema.Struct({
    canWrite: Schema.Boolean,
    canMerge: Schema.Boolean,
    isAuthor: Schema.Boolean,
  }),
}).annotate({ identifier: "GitHubPullRequestDetail" });

export const GitHubPullRequestTimelineSchema = modelRecord<GitHubPullRequestTimeline>()({
  ref: PullRequestRefSchema,
  items: Schema.Array(openRecord({ kind: Schema.String, id: Schema.String })),
  truncated: Schema.Boolean,
}).annotate({ identifier: "GitHubPullRequestTimeline" });

export const GitHubPullRequestReviewThreadCommentSchema =
  modelRecord<GitHubPullRequestReviewThreadComment>()({
    id: Schema.Finite,
    nodeId: Schema.String,
    body: Schema.String,
    createdAt: Schema.String,
    htmlUrl: Schema.String,
  }).annotate({ identifier: "GitHubPullRequestReviewThreadComment" });

export const GitHubPullRequestFilesSchema = modelRecord<GitHubPullRequestFiles>()({
  ref: PullRequestRefSchema,
  headSha: Schema.String,
  files: Schema.Array(
    openRecord({
      path: Schema.String,
      previousPath: Schema.NullOr(Schema.String),
      status: Schema.String,
      additions: Schema.Finite,
      deletions: Schema.Finite,
      patchAvailable: Schema.Boolean,
      viewedState: Schema.String,
    }),
  ),
  threads: Schema.Array(
    openRecord({
      id: Schema.String,
      path: Schema.String,
      isResolved: Schema.Boolean,
      comments: Schema.Array(GitHubPullRequestReviewThreadCommentSchema),
    }),
  ),
  truncated: Schema.Boolean,
}).annotate({ identifier: "GitHubPullRequestFiles" });

export const GitHubPullRequestMergeResultSchema = modelRecord<GitHubPullRequestMergeResult>()({
  merged: Schema.Boolean,
  sha: optionalString,
  message: optionalString,
  branchDeleted: optionalBoolean,
}).annotate({ identifier: "GitHubPullRequestMergeResult" });

export const GitHubRepositoryMemberOptionSchema = modelRecord<GitHubRepositoryMemberOption>()({
  login: Schema.String,
  avatarUrl: optionalString,
}).annotate({ identifier: "GitHubRepositoryMemberOption" });

export const GitHubPullRequestReviewSubmittedSchema = Schema.Struct({
  reviewId: Schema.Finite,
}).annotate({ identifier: "GitHubPullRequestReviewSubmitted" });

export const GitHubPullRequestThreadResolutionSchema = Schema.Struct({
  isResolved: Schema.Boolean,
}).annotate({ identifier: "GitHubPullRequestThreadResolution" });

export const GitHubPullRequestFileViewedSchema = Schema.Struct({
  viewedState: Schema.Literals(["viewed", "unviewed", "dismissed"]),
}).annotate({ identifier: "GitHubPullRequestFileViewed" });

// --- An environment's pull request --------------------------------------------

export const PrStateSchema = Schema.Literals(["open", "merged", "closed"]);

/** `PrCheckSummary` (`pr-monitor.ts`). */
export const PrCheckSummarySchema = Schema.Struct({
  passed: Schema.Finite,
  total: Schema.Finite,
  pending: Schema.Finite,
  requiredFailed: optionalNumber,
}).annotate({ identifier: "PrCheckSummary" });

/** `detect_pr` / `detect_pr_local`: the branch's PR, or `null` when it has none. */
export const PrDetectionSchema = Schema.NullOr(
  Schema.Struct({
    url: Schema.String,
    state: PrStateSchema,
    hasMergeConflicts: Schema.NullOr(Schema.Boolean),
    checkSummary: Schema.optional(Schema.NullOr(PrCheckSummarySchema)),
  }),
).annotate({ identifier: "PrDetection" });
export type PrDetection = typeof PrDetectionSchema.Type;

/** `verify_environment_pr`: the attached PR is open and belongs to this branch. */
export const VerifiedEnvironmentPrSchema = Schema.Struct({
  url: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  state: Schema.Literal("OPEN"),
}).annotate({ identifier: "VerifiedEnvironmentPr" });
export type VerifiedEnvironmentPr = typeof VerifiedEnvironmentPrSchema.Type;

const MergeOutcomeSchema = Schema.Literals(["merged", "pending", "unknown"]);

/** `merge_pr` / `merge_pr_local`: merged, accepted but not yet merged, or unknown. */
export const MergePrResultSchema = Schema.Struct({ outcome: MergeOutcomeSchema }).annotate({
  identifier: "MergePrResult",
});
export type MergePrResult = typeof MergePrResultSchema.Type;

/** `merge_environment_pr`: the merge outcome and what happened to the requested cleanup. */
export const MergeEnvironmentPrResultSchema = Schema.Struct({
  outcome: MergeOutcomeSchema,
  cleanupOutcome: Schema.Literals(["not-requested", "pending", "completed", "failed"]),
  cleanupError: optionalString,
}).annotate({ identifier: "MergeEnvironmentPrResult" });
export type MergeEnvironmentPrResult = typeof MergeEnvironmentPrResultSchema.Type;

/** `PrMonitorEnvironmentState`: one environment's monitored PR. */
export const PrMonitorEnvironmentStateSchema = modelRecord<PrMonitorEnvironmentState>()({
  environmentId: Schema.String,
  mode: Schema.String,
  checkInProgress: Schema.Boolean,
  consecutiveErrors: Schema.Finite,
  lastCheckAt: Schema.NullOr(Schema.String),
  prUrl: Schema.NullOr(Schema.String),
  prState: Schema.NullOr(Schema.String),
  hasMergeConflicts: Schema.NullOr(Schema.Boolean),
  checkSummary: Schema.NullOr(PrCheckSummarySchema),
}).annotate({ identifier: "PrMonitorEnvironmentState" });

export const PrMonitorSnapshotSchema = modelRecord<PrMonitorSnapshot>()({
  generation: optionalString,
  revision: optionalNumber,
  entries: Schema.Array(PrMonitorEnvironmentStateSchema),
}).annotate({ identifier: "PrMonitorSnapshot" });

const viewStamp = { generation: Schema.String, revision: Schema.Finite };

/**
 * `get_pr_monitor_state`: the whole snapshot without known revision
 * arguments, the conditional `ViewSnapshotOutcome` (`view-sync.ts`) with
 * them.
 */
export const PrMonitorReadSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unchanged"), ...viewStamp }),
  Schema.Struct({
    status: Schema.Literal("snapshot"),
    ...viewStamp,
    snapshot: PrMonitorSnapshotSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("reset"),
    ...viewStamp,
    snapshot: PrMonitorSnapshotSchema,
    reason: Schema.Literals(["generation", "ahead", "invalid-request"]),
  }),
  Schema.Struct({ status: Schema.Literal("deleted"), ...viewStamp }),
  PrMonitorSnapshotSchema,
]).annotate({ identifier: "PrMonitorRead" });

/** `generate_review_package`: the file-backed package's reference (`ReviewPackageReference`). */
export const ReviewPackageReferenceSchema = modelRecord<ReviewPackageReference>()({
  kind: Schema.Literal("file"),
  id: Schema.String,
  round: Schema.Finite,
  preparedAt: Schema.String,
  targetBranch: Schema.String,
  baseRef: Schema.String,
  headRef: Schema.String,
  filePath: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Finite,
  changedFileCount: Schema.Finite,
  limitations: Schema.Array(Schema.String),
}).annotate({ identifier: "ReviewPackageReference" });

/** `verify_review_package`: whether the package on disk still matches its reference. */
export const ReviewPackageVerificationSchema = Schema.Struct({
  valid: Schema.Boolean,
  reason: optionalString,
  artifacts: optionalNumber,
  artifactBytes: optionalNumber,
}).annotate({ identifier: "ReviewPackageVerification" });

/** `arm_pr_refresh_after_agent_completion`: the arm's token, or `null` when nothing was armed. */
export const PrRefreshArmSchema = Schema.NullOr(Schema.String).annotate({
  identifier: "PrRefreshArm",
});
