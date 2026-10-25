/**
 * Pull request "Files changed": REST file list with parsed hunks, merged with
 * GraphQL-only data (per-file viewed state and review threads).
 */
import type { ChangeDiffHunk, ChangeFileStatus } from "@orkestrator/protocol/change-resources";
import type {
  GitHubPullRequestFile,
  GitHubPullRequestFiles,
  GitHubPullRequestRef,
  GitHubPullRequestReviewThread,
  GitHubPullRequestReviewThreadComment,
  GitHubPullRequestViewedState,
} from "@orkestrator/protocol/github-pull-requests";
import { parseUnifiedPatch } from "@orkestrator/protocol/node/change-tracking/unified-patch";
import { GitHubApiError, isRecord, numberValue, optionalString, stringValue } from "./github.js";
import {
  assertPullRequestRef,
  getList,
  getJson,
  graphql,
  graphqlUser,
  prUser,
  pullHeadSha,
  pullPath,
  pullRequestClient,
  type GitHubPullRequestClient,
  type GitHubPullRequestRequestOptions,
} from "./github-pull-requests.js";

/** GitHub's own cap on `/pulls/{n}/files`. */
export const MAX_PULL_REQUEST_FILES = 3_000;
/** A file whose patch renders more rows than this links to GitHub instead. */
export const MAX_FILE_RENDERED_LINES = 3_000;
/** Rendered rows across the whole response; later files link to GitHub. */
export const MAX_TOTAL_RENDERED_LINES = 40_000;
export const MAX_REVIEW_THREADS = 1_000;
const MAX_GRAPHQL_PAGES = 40;

export function fileStatusFromApi(status: unknown): ChangeFileStatus {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    case "changed":
      return "mode-changed";
    case "modified":
    case "unchanged":
      return "modified";
    default:
      return "unknown";
  }
}

/**
 * Parse GitHub's bare-hunk `patch` (no file headers). Returns null when the
 * patch is malformed or renders more than `maxLines` rows.
 */
export function parsePullRequestFilePatch(
  patch: string,
  maxLines = MAX_FILE_RENDERED_LINES,
): ChangeDiffHunk[] | null {
  const parsed = parseUnifiedPatch(patch, { maxFiles: 1, maxOutputLines: maxLines });
  if (parsed.kind !== "parsed" || parsed.bodyTruncated || parsed.files.length !== 1) return null;
  return parsed.files[0]!.hunks;
}

function renderedLines(hunks: readonly ChangeDiffHunk[]): number {
  return hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
}

export function viewedStateFromGraphql(value: unknown): GitHubPullRequestViewedState {
  switch (value) {
    case "VIEWED":
      return "viewed";
    case "DISMISSED":
      return "dismissed";
    default:
      return "unviewed";
  }
}

/**
 * Map REST files to viewer files. `budget` is shared across files so one
 * response never carries more than `MAX_TOTAL_RENDERED_LINES` rows.
 */
export function mapPullRequestFiles(
  values: readonly unknown[],
  viewedStates: ReadonlyMap<string, GitHubPullRequestViewedState>,
  budget = MAX_TOTAL_RENDERED_LINES,
): GitHubPullRequestFile[] {
  let remaining = budget;
  const files: GitHubPullRequestFile[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const path = stringValue(value.filename);
    if (!path) continue;
    const status = fileStatusFromApi(value.status);
    const additions = numberValue(value.additions);
    const deletions = numberValue(value.deletions);
    const patch = optionalString(value.patch);
    let hunks: ChangeDiffHunk[] = [];
    let patchAvailable: boolean;
    if (patch) {
      const parsed = remaining > 0 ? parsePullRequestFilePatch(patch) : null;
      const rows = parsed ? renderedLines(parsed) : 0;
      if (parsed && rows <= remaining) {
        hunks = parsed;
        remaining -= rows;
        patchAvailable = true;
      } else {
        patchAvailable = false;
      }
    } else {
      // GitHub omits `patch` for binary and oversized files. A pure rename or
      // copy has no content change, so an empty body is the full story.
      patchAvailable =
        (status === "renamed" || status === "copied") && additions === 0 && deletions === 0;
    }
    files.push({
      path,
      previousPath: optionalString(value.previous_filename) ?? null,
      status,
      additions,
      deletions,
      hunks,
      patchAvailable,
      viewedState: viewedStates.get(path) ?? "unviewed",
      blobUrl: optionalString(value.blob_url),
    });
  }
  return files;
}

export function reviewThreadCommentFromGraphql(
  value: unknown,
  includeDiffHunk: boolean,
): GitHubPullRequestReviewThreadComment | null {
  if (!isRecord(value)) return null;
  const id = numberValue(value.databaseId);
  const nodeId = stringValue(value.id);
  if (!id || !nodeId) return null;
  const createdAt = stringValue(value.createdAt);
  const diffHunk = includeDiffHunk ? optionalString(value.diffHunk) : undefined;
  return {
    id,
    nodeId,
    body: stringValue(value.body),
    author: graphqlUser(value.author),
    createdAt,
    updatedAt: stringValue(value.updatedAt, createdAt),
    htmlUrl: stringValue(value.url),
    ...(diffHunk ? { diffHunk } : {}),
  };
}

export function reviewThreadCommentFromRest(
  value: unknown,
): GitHubPullRequestReviewThreadComment | null {
  if (!isRecord(value)) return null;
  const id = numberValue(value.id);
  const nodeId = stringValue(value.node_id);
  if (!id || !nodeId) return null;
  const createdAt = stringValue(value.created_at);
  const diffHunk = optionalString(value.diff_hunk);
  return {
    id,
    nodeId,
    body: stringValue(value.body),
    author: prUser(value.user),
    createdAt,
    updatedAt: stringValue(value.updated_at, createdAt),
    htmlUrl: stringValue(value.html_url),
    ...(diffHunk ? { diffHunk } : {}),
  };
}

function nullableLine(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function reviewThreadFromGraphql(value: unknown): GitHubPullRequestReviewThread | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const path = stringValue(value.path);
  if (!id || !path) return null;
  const commentNodes =
    isRecord(value.comments) && Array.isArray(value.comments.nodes) ? value.comments.nodes : [];
  const comments = commentNodes
    .map((node, index) => reviewThreadCommentFromGraphql(node, index === 0))
    .filter((comment): comment is GitHubPullRequestReviewThreadComment => comment !== null);
  return {
    id,
    path,
    line: nullableLine(value.line),
    startLine: nullableLine(value.startLine),
    side: value.diffSide === "LEFT" ? "LEFT" : "RIGHT",
    isResolved: value.isResolved === true,
    isOutdated: value.isOutdated === true,
    viewerCanResolve: value.viewerCanResolve === true,
    comments,
    commentsTruncated:
      isRecord(value.comments) &&
      isRecord(value.comments.pageInfo) &&
      value.comments.pageInfo.hasNextPage === true,
  };
}

export const REVIEW_THREAD_FIELDS = `id
  isResolved
  isOutdated
  path
  line
  startLine
  diffSide
  viewerCanResolve
  comments(first: 100) {
    pageInfo { hasNextPage }
    nodes { databaseId id body author { login avatarUrl url } createdAt updatedAt url diffHunk }
  }`;

const REVIEW_STATE_QUERY = `query PullRequestReviewState(
  $owner: String!
  $name: String!
  $number: Int!
  $filesAfter: String
  $threadsAfter: String
  $withFiles: Boolean!
  $withThreads: Boolean!
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $filesAfter) @include(if: $withFiles) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
      reviewThreads(first: 50, after: $threadsAfter) @include(if: $withThreads) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REVIEW_THREAD_FIELDS} }
      }
    }
  }
}`;

type Connection = { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null };

function connection(value: unknown): Connection | null {
  if (!isRecord(value)) return null;
  const pageInfo = isRecord(value.pageInfo) ? value.pageInfo : {};
  return {
    nodes: Array.isArray(value.nodes) ? value.nodes : [],
    hasNextPage: pageInfo.hasNextPage === true,
    endCursor: optionalString(pageInfo.endCursor) ?? null,
  };
}

/** Viewed state per path and every review thread, paged together in one query. */
export async function loadReviewState(
  client: GitHubPullRequestClient,
  ref: GitHubPullRequestRef,
): Promise<{
  viewedStates: Map<string, GitHubPullRequestViewedState>;
  threads: GitHubPullRequestReviewThread[];
}> {
  const viewedStates = new Map<string, GitHubPullRequestViewedState>();
  const threads: GitHubPullRequestReviewThread[] = [];
  let filesAfter: string | null = null;
  let threadsAfter: string | null = null;
  let withFiles = true;
  let withThreads = true;
  for (let page = 0; (withFiles || withThreads) && page < MAX_GRAPHQL_PAGES; page++) {
    const data: Record<string, unknown> = await graphql<Record<string, unknown>>(
      client,
      REVIEW_STATE_QUERY,
      {
        owner: ref.owner,
        name: ref.repo,
        number: ref.number,
        filesAfter,
        threadsAfter,
        withFiles,
        withThreads,
      },
      `load review state for pull request #${ref.number}`,
    );
    const repository = isRecord(data.repository) ? data.repository : null;
    const pullRequest =
      repository && isRecord(repository.pullRequest) ? repository.pullRequest : null;
    if (!pullRequest) {
      throw new GitHubApiError(
        `GitHub could not find pull request #${ref.number}, or the token may not have access.`,
        { code: "not-found", status: 404 },
      );
    }
    if (withFiles) {
      const files = connection(pullRequest.files);
      for (const node of files?.nodes ?? []) {
        if (!isRecord(node)) continue;
        const path = stringValue(node.path);
        if (path) viewedStates.set(path, viewedStateFromGraphql(node.viewerViewedState));
      }
      withFiles = Boolean(
        files?.hasNextPage && files.endCursor && viewedStates.size < MAX_PULL_REQUEST_FILES,
      );
      filesAfter = files?.endCursor ?? null;
    }
    if (withThreads) {
      const page = connection(pullRequest.reviewThreads);
      for (const node of page?.nodes ?? []) {
        const thread = reviewThreadFromGraphql(node);
        if (thread) threads.push(thread);
      }
      withThreads = Boolean(
        page?.hasNextPage && page.endCursor && threads.length < MAX_REVIEW_THREADS,
      );
      threadsAfter = page?.endCursor ?? null;
    }
  }
  return { viewedStates, threads };
}

export async function getGitHubPullRequestFiles(
  token: string,
  ref: GitHubPullRequestRef,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestFiles> {
  assertPullRequestRef(ref);
  const client = pullRequestClient(token, options);
  // Bracket every paginated read with uncached head reads. Never expose mixed
  // revision coordinates as an inline-comment target.
  const readHead = async () => {
    const { data } = await getJson(client, pullPath(ref), "validate pull request head", {
      cached: false,
    });
    if (!isRecord(data) || !pullHeadSha(data))
      throw new GitHubApiError("GitHub returned an invalid pull request head.");
    return data;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readHead();
    const [fileList, reviewState] = await Promise.all([
      // File pages can be large; they bypass the conditional cache.
      getList(
        client,
        `${pullPath(ref)}/files`,
        `load files for pull request #${ref.number}`,
        MAX_PULL_REQUEST_FILES,
        { cached: false },
      ),
      loadReviewState(client, ref),
    ]);
    const pull = await readHead();
    if (pullHeadSha(before) !== pullHeadSha(pull)) continue;
    const files = mapPullRequestFiles(fileList.values, reviewState.viewedStates);
    return {
      ref: { owner: ref.owner, repo: ref.repo, number: ref.number },
      headSha: pullHeadSha(pull),
      files,
      threads: reviewState.threads,
      truncated: fileList.truncated || numberValue(pull.changed_files) > files.length,
    };
  }
  throw new GitHubApiError("The pull request changed while loading files. Refresh and try again.");
}
