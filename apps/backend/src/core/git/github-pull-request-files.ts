/**
 * Pull request "Files changed": REST file list with parsed hunks, merged with
 * GraphQL-only data (per-file viewed state and review threads).
 */
import type { ChangeDiffHunk, ChangeFileStatus } from "@orkestrator/protocol/change-resources";
import type {
  GitHubPullRequestFile,
  GitHubPullRequestFilePatch,
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
  isCommitSha,
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
/**
 * Rendered rows of a file loaded on its own. Larger than the list's per-file
 * cap, which shares one response with every other file.
 */
export const MAX_SINGLE_FILE_RENDERED_LINES = 10_000;
/** `/pulls/{n}/files` page size; a file's list index names its page. */
export const FILE_PAGE_SIZE = 100;
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

/** Upper bound on a patch's rendered rows without parsing it (hunk headers count too). */
function patchRowEstimate(patch: string): number {
  let rows = 1;
  for (let index = patch.indexOf("\n"); index !== -1; index = patch.indexOf("\n", index + 1)) {
    rows++;
  }
  return rows;
}

/** A pure rename or copy has no content change, so an empty body is the full story. */
function unchangedRenameOrCopy(status: ChangeFileStatus, additions: number, deletions: number) {
  return (status === "renamed" || status === "copied") && additions === 0 && deletions === 0;
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
    let patchDeferred = false;
    if (patch) {
      const parsed = remaining > 0 ? parsePullRequestFilePatch(patch) : null;
      const rows = parsed ? renderedLines(parsed) : 0;
      if (parsed && rows <= remaining) {
        hunks = parsed;
        remaining -= rows;
        patchAvailable = true;
      } else {
        patchAvailable = false;
        // Left out to bound this response, not because GitHub cannot show
        // it: the file can still be loaded on its own.
        patchDeferred = patchRowEstimate(patch) <= MAX_SINGLE_FILE_RENDERED_LINES;
      }
    } else {
      // GitHub omits `patch` for binary and oversized files.
      patchAvailable = unchangedRenameOrCopy(status, additions, deletions);
    }
    files.push({
      path,
      previousPath: optionalString(value.previous_filename) ?? null,
      status,
      additions,
      deletions,
      hunks,
      patchAvailable,
      ...(patchDeferred ? { patchDeferred } : {}),
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

/** The `/pulls/{n}/files` pages to read for a file, its hinted page first. */
export function filePatchPageOrder(index: number | undefined): number[] {
  const pages = Math.ceil(MAX_PULL_REQUEST_FILES / FILE_PAGE_SIZE);
  const hint =
    index !== undefined && Number.isSafeInteger(index) && index >= 0
      ? Math.floor(index / FILE_PAGE_SIZE) + 1
      : null;
  const order: number[] = [];
  if (hint !== null && hint <= pages) order.push(hint);
  for (let page = 1; page <= pages; page++) if (page !== hint) order.push(page);
  return order;
}

/** One REST file entry's patch, parsed with the single-file row cap. */
export function singleFilePatch(value: Record<string, unknown>): {
  patchAvailable: boolean;
  hunks: ChangeDiffHunk[];
} {
  const patch = optionalString(value.patch);
  if (!patch) {
    const status = fileStatusFromApi(value.status);
    return {
      patchAvailable: unchangedRenameOrCopy(
        status,
        numberValue(value.additions),
        numberValue(value.deletions),
      ),
      hunks: [],
    };
  }
  const hunks = parsePullRequestFilePatch(patch, MAX_SINGLE_FILE_RENDERED_LINES);
  return hunks ? { patchAvailable: true, hunks } : { patchAvailable: false, hunks: [] };
}

/**
 * One file's patch at `headSha`, for a file the list left out to bound its
 * response. Reads the page `index` names first and falls back to the others,
 * between two uncached head reads: a head other than `headSha` on either side
 * answers `head-moved`, so a patch never mixes revisions with the list it
 * belongs to.
 */
export async function getGitHubPullRequestFilePatch(
  token: string,
  ref: GitHubPullRequestRef,
  input: { path: string; headSha: string; index?: number },
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestFilePatch> {
  assertPullRequestRef(ref);
  if (!input.path) throw new Error("Expected path to name a file of the pull request");
  if (!isCommitSha(input.headSha)) throw new Error("Expected headSha to be a commit SHA");
  const client = pullRequestClient(token, options);
  const result = (
    headSha: string,
    outcome: GitHubPullRequestFilePatch["outcome"],
    patch: { patchAvailable: boolean; hunks: ChangeDiffHunk[] } = {
      patchAvailable: false,
      hunks: [],
    },
  ): GitHubPullRequestFilePatch => ({
    ref: { owner: ref.owner, repo: ref.repo, number: ref.number },
    path: input.path,
    headSha,
    outcome,
    ...patch,
  });
  const readHead = async () => {
    const { data } = await getJson(client, pullPath(ref), "validate pull request head", {
      cached: false,
    });
    const sha = isRecord(data) ? pullHeadSha(data) : "";
    if (!sha) throw new GitHubApiError("GitHub returned an invalid pull request head.");
    return sha;
  };
  const before = await readHead();
  if (before !== input.headSha) return result(before, "head-moved");
  let found: Record<string, unknown> | null = null;
  // A short page is the last one: every page after it is empty.
  let lastPage = Number.POSITIVE_INFINITY;
  for (const page of filePatchPageOrder(input.index)) {
    if (page > lastPage) continue;
    const { data } = await getJson(
      client,
      `${pullPath(ref)}/files?per_page=${FILE_PAGE_SIZE}&page=${page}`,
      `load a file of pull request #${ref.number}`,
      { cached: false },
    );
    if (!Array.isArray(data)) {
      throw new GitHubApiError("GitHub returned an invalid file list. Try again.");
    }
    found =
      data.find(
        (value): value is Record<string, unknown> =>
          isRecord(value) && stringValue(value.filename) === input.path,
      ) ?? null;
    if (found) break;
    if (data.length < FILE_PAGE_SIZE) lastPage = Math.min(lastPage, page);
  }
  const after = await readHead();
  if (after !== input.headSha) return result(after, "head-moved");
  return found ? result(after, "loaded", singleFilePatch(found)) : result(after, "not-found");
}
