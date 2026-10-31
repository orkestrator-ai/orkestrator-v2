/**
 * Input contracts of the pull request management actions: the in-app viewer's
 * reads and writes and the action bar's Merge and Merge and Cleanup buttons.
 * Every action but `pr.list` addresses the pull request attached to one
 * environment's branch. Split from `public-api-inputs.ts`, which composes them
 * into `PUBLIC_ACTION_INPUTS`; the same portable JSON Schema subset applies.
 *
 * `pr.create` and `pr.resolve` are agent runs and stay in that table.
 */

import { PUBLIC_API_LIMITS } from "./public-api.js";
import type {
  PublicActionInputContract,
  PublicActionInputSchema,
  PublicJsonSchema,
} from "./public-api-inputs.js";

/** GitHub's own limit on a comment or review body. */
export const PUBLIC_PR_BODY_MAX_CHARS = 65_536;
/** Inline comments one `pr.review` may carry. */
export const PUBLIC_PR_REVIEW_COMMENTS_MAX = 200;
/** Reviewers one `pr.reviewers` may add or remove, each. */
export const PUBLIC_PR_REVIEWERS_MAX = 100;

export const PUBLIC_PR_MERGE_METHODS = Object.freeze(["squash", "merge", "rebase"] as const);
export const PUBLIC_PR_LIST_FILTERS = Object.freeze([
  "open",
  "mine",
  "review-requested",
  "closed",
] as const);
export const PUBLIC_PR_REVIEW_EVENTS = Object.freeze([
  "APPROVE",
  "REQUEST_CHANGES",
  "COMMENT",
] as const);
export const PUBLIC_PR_SIDES = Object.freeze(["LEFT", "RIGHT"] as const);

function schema(
  properties: Record<string, PublicJsonSchema>,
  required: readonly string[] = [],
): PublicActionInputSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const environmentId: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: PUBLIC_API_LIMITS.idMaxChars,
  description: "Environment ID, from environment.list. Its attached pull request is the target.",
};
const projectId: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: PUBLIC_API_LIMITS.idMaxChars,
  description: "Project ID, from project.list.",
};
const body: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: PUBLIC_PR_BODY_MAX_CHARS,
  description: "Markdown text, posted as the GitHub user configured in Settings.",
};
const filePath: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: PUBLIC_API_LIMITS.pathMaxChars,
  description: "Repository-relative path of a changed file, from pr.files.",
};
const threadId: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: PUBLIC_API_LIMITS.idMaxChars,
  description: "Review thread ID, from pr.files.",
};
const commitSha: PublicJsonSchema = {
  type: "string",
  minLength: 40,
  maxLength: 40,
};
const line: PublicJsonSchema = {
  type: "integer",
  minimum: 1,
  description: "Line in the new file (RIGHT) or the old file (LEFT).",
};
const side: PublicJsonSchema = {
  type: "string",
  enum: PUBLIC_PR_SIDES,
  description: "RIGHT: the new file. LEFT: the old file.",
};
const startLine: PublicJsonSchema = {
  type: "integer",
  minimum: 1,
  description: "First line of a multi-line comment; below line.",
};
const reviewerList: PublicJsonSchema = {
  type: "array",
  maxItems: PUBLIC_PR_REVIEWERS_MAX,
  items: { type: "string", minLength: 1, maxLength: PUBLIC_API_LIMITS.nameMaxChars },
};

const environmentOnly = schema({ environmentId }, ["environmentId"]);
const environmentExamples = [{ environmentId: "env-1" }];

type PrActionName =
  | "pr.get"
  | "pr.list"
  | "pr.timeline"
  | "pr.files"
  | "pr.options"
  | "pr.merge"
  | "pr.close"
  | "pr.reopen"
  | "pr.ready"
  | "pr.draft"
  | "pr.comment"
  | "pr.comment.edit"
  | "pr.review"
  | "pr.review.comment"
  | "pr.thread.reply"
  | "pr.thread.resolve"
  | "pr.file.viewed"
  | "pr.reviewers"
  | "pr.label";

export const PR_ACTION_INPUTS: Readonly<Record<PrActionName, PublicActionInputContract>> =
  Object.freeze({
    "pr.get": {
      capability: "sessions.read",
      confirmation: "never",
      input: environmentOnly,
      examples: environmentExamples,
    },
    "pr.list": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema(
        {
          projectId,
          filter: {
            type: "string",
            enum: PUBLIC_PR_LIST_FILTERS,
            description: "Which pull requests (default open).",
          },
          query: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            description: "Search text, as in the pull request list's search box.",
          },
        },
        ["projectId"],
      ),
      examples: [{ projectId: "project-1" }, { projectId: "project-1", filter: "closed" }],
    },
    "pr.timeline": {
      capability: "sessions.read",
      confirmation: "never",
      input: environmentOnly,
      examples: environmentExamples,
    },
    "pr.files": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema(
        {
          environmentId,
          path: {
            ...filePath,
            description:
              "Return only this file, with its diff hunks. Omitted: every file without hunks, to keep the result small.",
          },
        },
        ["environmentId"],
      ),
      examples: [{ environmentId: "env-1" }, { environmentId: "env-1", path: "src/index.ts" }],
    },
    "pr.options": {
      capability: "sessions.read",
      confirmation: "never",
      input: environmentOnly,
      examples: environmentExamples,
    },
    // Merging cannot be taken back and cleanup deletes the environment, so
    // both sit behind the destructive grant rather than `sessions.control`.
    "pr.merge": {
      capability: "environments.destructive",
      confirmation: "always",
      input: schema(
        {
          environmentId,
          method: {
            type: "string",
            enum: PUBLIC_PR_MERGE_METHODS,
            description: "How to merge (default squash, as on the Merge button).",
          },
          deleteBranch: {
            type: "boolean",
            description:
              "Delete the head branch after merging (default true). A project's home checkout keeps its branch.",
          },
          cleanup: {
            type: "boolean",
            description:
              "Merge and Cleanup: delete this environment and its worktree once the merge is confirmed. Cannot be combined with deleteBranch false.",
          },
          expectedPrUrl: {
            type: "string",
            description:
              "Refuse if the attached PR or the explicit cleanup/branch effects changed since confirmation.",
          },
          expectedHeadSha: {
            ...commitSha,
            description:
              "headSha from pr.get. The merge is refused if the branch has moved since, so what merges is what was read.",
          },
        },
        ["environmentId"],
      ),
      examples: [
        { environmentId: "env-1" },
        { environmentId: "env-1", method: "rebase", deleteBranch: false },
        { environmentId: "env-1", cleanup: true },
        { environmentId: "env-1", expectedHeadSha: "0123456789abcdef0123456789abcdef01234567" },
      ],
    },
    "pr.close": {
      capability: "sessions.control",
      confirmation: "always",
      input: environmentOnly,
      examples: environmentExamples,
    },
    "pr.reopen": {
      capability: "sessions.control",
      confirmation: "voice",
      input: environmentOnly,
      examples: environmentExamples,
    },
    "pr.ready": {
      capability: "sessions.control",
      confirmation: "voice",
      input: environmentOnly,
      examples: environmentExamples,
    },
    "pr.draft": {
      capability: "sessions.control",
      confirmation: "voice",
      input: environmentOnly,
      examples: environmentExamples,
    },
    "pr.comment": {
      capability: "sessions.control",
      confirmation: "voice",
      input: schema({ environmentId, body }, ["environmentId", "body"]),
      examples: [{ environmentId: "env-1", body: "Merging once CI is green." }],
    },
    "pr.comment.edit": {
      capability: "sessions.control",
      confirmation: "voice",
      input: schema(
        {
          environmentId,
          commentId: {
            type: "integer",
            minimum: 1,
            description: "Comment ID, from pr.get or a pr.comment result.",
          },
          body,
        },
        ["environmentId", "commentId", "body"],
      ),
      examples: [{ environmentId: "env-1", commentId: 123, body: "Merged after the fix." }],
    },
    "pr.review": {
      capability: "sessions.control",
      confirmation: "always",
      input: schema(
        {
          environmentId,
          event: {
            type: "string",
            enum: PUBLIC_PR_REVIEW_EVENTS,
            description:
              "The verdict. REQUEST_CHANGES needs body; COMMENT needs body or comments. GitHub refuses approving your own pull request.",
          },
          body: { ...body, description: "Review summary." },
          commitId: {
            ...commitSha,
            description: "The commit reviewed (headSha from pr.get). Omitted: the current head.",
          },
          comments: {
            type: "array",
            maxItems: PUBLIC_PR_REVIEW_COMMENTS_MAX,
            description: "Inline comments submitted with the review.",
            items: {
              type: "object",
              properties: { path: filePath, line, side, startLine, body },
              required: ["path", "line", "side", "body"],
              additionalProperties: false,
            },
          },
        },
        ["environmentId", "event"],
      ),
      examples: [
        { environmentId: "env-1", event: "APPROVE" },
        {
          environmentId: "env-1",
          event: "COMMENT",
          comments: [{ path: "src/index.ts", line: 12, side: "RIGHT", body: "Is this bounded?" }],
        },
      ],
    },
    "pr.review.comment": {
      capability: "sessions.control",
      confirmation: "voice",
      input: schema(
        {
          environmentId,
          path: filePath,
          line,
          side,
          startLine,
          body,
          commitId: {
            ...commitSha,
            description: "The commit commented on. Omitted: the pull request's current head.",
          },
        },
        ["environmentId", "path", "line", "side", "body"],
      ),
      examples: [
        { environmentId: "env-1", path: "src/index.ts", line: 12, side: "RIGHT", body: "Why?" },
      ],
    },
    "pr.thread.reply": {
      capability: "sessions.control",
      confirmation: "voice",
      input: schema({ environmentId, threadId, body }, ["environmentId", "threadId", "body"]),
      examples: [{ environmentId: "env-1", threadId: "PRRT_1", body: "Fixed." }],
    },
    "pr.thread.resolve": {
      capability: "sessions.control",
      confirmation: "voice",
      input: schema(
        {
          environmentId,
          threadId,
          resolved: { type: "boolean", description: "False to unresolve (default true)." },
        },
        ["environmentId", "threadId"],
      ),
      examples: [
        { environmentId: "env-1", threadId: "PRRT_1" },
        { environmentId: "env-1", threadId: "PRRT_1", resolved: false },
      ],
    },
    "pr.file.viewed": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema(
        {
          environmentId,
          path: filePath,
          viewed: { type: "boolean", description: "False to clear it (default true)." },
        },
        ["environmentId", "path"],
      ),
      examples: [{ environmentId: "env-1", path: "src/index.ts" }],
    },
    "pr.reviewers": {
      capability: "sessions.control",
      confirmation: "voice",
      input: schema(
        {
          environmentId,
          add: {
            ...reviewerList,
            description: "Logins or org/team-slug entries to request a review from.",
          },
          remove: {
            ...reviewerList,
            description: "Logins or org/team-slug entries whose request to remove.",
          },
        },
        ["environmentId"],
      ),
      examples: [{ environmentId: "env-1", add: ["octocat"] }],
    },
    "pr.label": {
      capability: "sessions.control",
      confirmation: "voice",
      input: schema(
        {
          environmentId,
          name: {
            type: "string",
            minLength: 1,
            maxLength: 100,
            description: "Label name, from pr.options.",
          },
          present: { type: "boolean", description: "False to remove the label (default true)." },
        },
        ["environmentId", "name"],
      ),
      examples: [{ environmentId: "env-1", name: "bug" }],
    },
  });
