/**
 * GitHub pull request viewer backend: list and detail reads plus the shared
 * request client used by the files, timeline and action modules.
 *
 * Reads use REST where it is enough and GraphQL where REST has no equivalent
 * (search with head/base refs, viewed state, review threads, draft toggles).
 * Polled REST GETs go through a bounded conditional-request cache: GitHub does
 * not charge a 304 against the rate limit. The cache key is a hash of the
 * credential and URL; the raw token is never stored or logged.
 */
import { createHash } from "node:crypto";
import {
  isGitHubPullRequestRef,
  type GitHubPullRequestCheck,
  type GitHubPullRequestCheckConclusion,
  type GitHubPullRequestChecksState,
  type GitHubPullRequestComment,
  type GitHubPullRequestDetail,
  type GitHubPullRequestLabel,
  type GitHubPullRequestListFilter,
  type GitHubPullRequestListItem,
  type GitHubPullRequestListResult,
  type GitHubPullRequestMergeability,
  type GitHubPullRequestMergeMethod,
  type GitHubPullRequestRef,
  type GitHubPullRequestReviewer,
  type GitHubPullRequestReviewState,
  type GitHubPullRequestState,
  type GitHubPullRequestUser,
} from "@orkestrator/protocol/github-pull-requests";
import { githubGraphql } from "./github-graphql.js";
import {
  GitHubApiError,
  encodePathSegment,
  githubPaginate,
  githubRequest,
  isRecord,
  labelFromApi,
  nextLink,
  numberValue,
  optionalString,
  requestUrl,
  stringValue,
  userFromApi,
  viewerCanEditComment,
  type GitHubFetch,
} from "./github.js";

// ---------------------------------------------------------------------------
// Conditional-request cache

export type GitHubConditionalCacheEntry = {
  etag: string;
  data: unknown;
  link: string | null;
  size: number;
};

export type GitHubConditionalCache = {
  get(key: string): GitHubConditionalCacheEntry | undefined;
  set(key: string, entry: GitHubConditionalCacheEntry): void;
  clear(): void;
  readonly size: number;
};

export type GitHubConditionalCacheLimits = {
  maxEntries: number;
  /** Approximate JSON bytes retained across all entries. */
  maxBytes: number;
  /** Larger responses are not cached at all. */
  maxEntryBytes: number;
};

export const DEFAULT_CONDITIONAL_CACHE_LIMITS: GitHubConditionalCacheLimits = {
  maxEntries: 200,
  maxBytes: 16 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024,
};

/** LRU map of ETag + parsed body, bounded by entry count and bytes. */
export function createGitHubConditionalCache(
  limits: Partial<GitHubConditionalCacheLimits> = {},
): GitHubConditionalCache {
  const bounds = { ...DEFAULT_CONDITIONAL_CACHE_LIMITS, ...limits };
  const entries = new Map<string, GitHubConditionalCacheEntry>();
  let bytes = 0;
  const remove = (key: string) => {
    const existing = entries.get(key);
    if (!existing) return;
    bytes -= existing.size;
    entries.delete(key);
  };
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    set(key, entry) {
      remove(key);
      if (entry.size > bounds.maxEntryBytes) return;
      entries.set(key, entry);
      bytes += entry.size;
      for (const oldest of Array.from(entries.keys())) {
        if (entries.size <= bounds.maxEntries && bytes <= bounds.maxBytes) break;
        remove(oldest);
      }
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    get size() {
      return entries.size;
    },
  };
}

const sharedConditionalCache = createGitHubConditionalCache();

/** Drops every cached response; for tests and credential changes. */
export function resetGitHubPullRequestCache(): void {
  sharedConditionalCache.clear();
}

function conditionalCacheKey(token: string, url: string): string {
  return createHash("sha256").update(token).update("\0").update(url).digest("hex");
}

// ---------------------------------------------------------------------------
// Request client

export type GitHubPullRequestRequestOptions = {
  fetchImpl?: GitHubFetch;
  /** Conditional GET cache; `null` disables it. Defaults to the shared cache. */
  cache?: GitHubConditionalCache | null;
};

export type GitHubPullRequestClient = {
  token: string;
  fetchImpl: GitHubFetch;
  cache: GitHubConditionalCache | null;
};

export function pullRequestClient(
  token: string,
  options: GitHubPullRequestRequestOptions = {},
): GitHubPullRequestClient {
  return {
    token,
    fetchImpl: options.fetchImpl ?? fetch,
    cache: options.cache === undefined ? sharedConditionalCache : options.cache,
  };
}

/** GET returning the parsed body and `Link` header, revalidated through the cache. */
export async function getJson(
  client: GitHubPullRequestClient,
  pathOrUrl: string,
  operation: string,
  { cached = true }: { cached?: boolean } = {},
): Promise<{ data: unknown; link: string | null }> {
  const url = requestUrl(pathOrUrl);
  const cache = cached ? client.cache : null;
  const key = cache ? conditionalCacheKey(client.token, url) : "";
  const entry = cache?.get(key);
  const { data, response } = await githubRequest<unknown>(
    client.token,
    url,
    operation,
    entry ? { headers: { "If-None-Match": entry.etag } } : {},
    client.fetchImpl,
    { subject: "pull-request", allowNotModified: entry !== undefined },
  );
  if (response.status === 304 && entry) return { data: entry.data, link: entry.link };
  const link = response.headers.get("link");
  const etag = response.headers.get("etag");
  if (cache && etag) {
    const size = (JSON.stringify(data) ?? "").length + (link?.length ?? 0);
    cache.set(key, { etag, data, link, size });
  }
  return { data, link };
}

export async function getList(
  client: GitHubPullRequestClient,
  path: string,
  operation: string,
  maxItems: number,
  options: { cached?: boolean } = {},
): Promise<{ values: unknown[]; truncated: boolean }> {
  return githubPaginate(
    path,
    operation,
    (url) => getJson(client, url, operation, options),
    maxItems,
  );
}

export async function sendJson(
  client: GitHubPullRequestClient,
  path: string,
  operation: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  const { data } = await githubRequest<unknown>(
    client.token,
    path,
    operation,
    { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    client.fetchImpl,
    { subject: "pull-request" },
  );
  return data;
}

export function graphql<T>(
  client: GitHubPullRequestClient,
  query: string,
  variables: Record<string, unknown>,
  operation: string,
): Promise<T> {
  return githubGraphql<T>(client.token, query, variables, operation, client.fetchImpl);
}

// ---------------------------------------------------------------------------
// Paths and validation

export type GitHubRepositoryCoordinates = { owner: string; repo: string };

export function assertPullRequestRef(ref: GitHubPullRequestRef): void {
  if (!isGitHubPullRequestRef(ref)) {
    throw new GitHubApiError(
      "A valid GitHub owner, repository and pull request number is required.",
      {
        code: "validation",
      },
    );
  }
}

export function assertRepositoryCoordinates(repository: GitHubRepositoryCoordinates): void {
  if (!isGitHubPullRequestRef({ ...repository, number: 1 })) {
    throw new GitHubApiError("A valid GitHub owner and repository is required.", {
      code: "validation",
    });
  }
}

export function repoPath(repository: GitHubRepositoryCoordinates): string {
  return `/repos/${encodePathSegment(repository.owner)}/${encodePathSegment(repository.repo)}`;
}

export function pullPath(ref: GitHubPullRequestRef): string {
  return `${repoPath(ref)}/pulls/${ref.number}`;
}

export function issuePath(ref: GitHubPullRequestRef): string {
  return `${repoPath(ref)}/issues/${ref.number}`;
}

const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export function isCommitSha(value: string): boolean {
  return COMMIT_SHA.test(value);
}

// ---------------------------------------------------------------------------
// Mappers

export function prUser(value: unknown): GitHubPullRequestUser | null {
  return userFromApi(value);
}

/** GraphQL actor `{ login avatarUrl url }`. */
export function graphqlUser(value: unknown): GitHubPullRequestUser | null {
  if (!isRecord(value)) return null;
  const login = stringValue(value.login);
  if (!login) return null;
  return {
    login,
    avatarUrl: optionalString(value.avatarUrl),
    htmlUrl: optionalString(value.url),
  };
}

export function prLabels(values: unknown): GitHubPullRequestLabel[] {
  return (Array.isArray(values) ? values : [])
    .map(labelFromApi)
    .filter((label): label is GitHubPullRequestLabel => label !== null);
}

export function prUsers(values: unknown): GitHubPullRequestUser[] {
  return (Array.isArray(values) ? values : [])
    .map(prUser)
    .filter((user): user is GitHubPullRequestUser => user !== null);
}

/** REST issue comment → viewer comment; `canEdit` is resolved by the caller. */
export function prComment(value: unknown, canEdit = false): GitHubPullRequestComment | null {
  if (!isRecord(value)) return null;
  const id = numberValue(value.id);
  const createdAt = stringValue(value.created_at);
  if (!id || !createdAt) return null;
  const updatedAt = stringValue(value.updated_at, createdAt);
  return {
    id,
    nodeId: optionalString(value.node_id),
    body: stringValue(value.body),
    htmlUrl: stringValue(value.html_url),
    author: prUser(value.user ?? value.actor),
    createdAt,
    updatedAt,
    isEdited: updatedAt !== createdAt,
    canEdit,
  };
}

export function reviewStateFromApi(value: unknown): GitHubPullRequestReviewState | null {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
    default:
      return null;
  }
}

export function pullRequestState(pull: Record<string, unknown>): GitHubPullRequestState {
  if (pull.merged === true || optionalString(pull.merged_at)) return "merged";
  return pull.state === "closed" ? "closed" : "open";
}

// ---------------------------------------------------------------------------
// Shared loads

export type GitHubViewerIdentity = {
  viewer: GitHubPullRequestUser;
  /** Push, maintain or admin on the repository. */
  canWrite: boolean;
  repository: Record<string, unknown>;
};

export async function loadViewerIdentity(
  client: GitHubPullRequestClient,
  repository: GitHubRepositoryCoordinates,
): Promise<GitHubViewerIdentity> {
  const [viewerResult, repositoryResult] = await Promise.all([
    getJson(client, "/user", "load the authenticated GitHub user"),
    getJson(client, repoPath(repository), "load the repository"),
  ]);
  const viewer = prUser(viewerResult.data);
  if (!viewer) {
    throw new GitHubApiError(
      "GitHub returned an invalid authenticated user. Update the token and try again.",
    );
  }
  if (!isRecord(repositoryResult.data)) {
    throw new GitHubApiError("GitHub returned invalid repository information. Try again.");
  }
  const permissions = isRecord(repositoryResult.data.permissions)
    ? repositoryResult.data.permissions
    : {};
  return {
    viewer,
    canWrite:
      permissions.admin === true || permissions.maintain === true || permissions.push === true,
    repository: repositoryResult.data,
  };
}

export function canEditComment(
  comment: GitHubPullRequestComment,
  identity: GitHubViewerIdentity,
): boolean {
  return viewerCanEditComment(comment, identity.viewer, identity.canWrite);
}

export async function loadPullRequestRecord(
  client: GitHubPullRequestClient,
  ref: GitHubPullRequestRef,
): Promise<Record<string, unknown>> {
  const { data } = await getJson(client, pullPath(ref), `load pull request #${ref.number}`);
  if (!isRecord(data) || numberValue(data.number) !== ref.number) {
    throw new GitHubApiError(
      `GitHub returned an invalid pull request #${ref.number}. Refresh and try again.`,
    );
  }
  return data;
}

export function pullHeadSha(pull: Record<string, unknown>): string {
  const head = isRecord(pull.head) ? pull.head : {};
  return stringValue(head.sha);
}

export function pullNodeId(pull: Record<string, unknown>, ref: GitHubPullRequestRef): string {
  const nodeId = stringValue(pull.node_id);
  if (!nodeId) {
    throw new GitHubApiError(
      `GitHub did not return an id for pull request #${ref.number}. Refresh and try again.`,
    );
  }
  return nodeId;
}

// ---------------------------------------------------------------------------
// List

const MAX_LIST_RESULTS = 100;
/** Qualifiers that would widen or reorder the search beyond this repository. */
const SCOPE_QUALIFIER = /^-?(?:repo|org|user|owner|sort):/i;

export function buildPullRequestSearchQuery(
  repository: GitHubRepositoryCoordinates,
  filter: GitHubPullRequestListFilter,
  query?: string,
): string {
  const parts = [`repo:${repository.owner}/${repository.repo}`, "is:pr"];
  switch (filter) {
    case "open":
      parts.push("is:open");
      break;
    case "closed":
      parts.push("is:closed");
      break;
    case "mine":
      parts.push("is:open", "author:@me");
      break;
    case "review-requested":
      parts.push("is:open", "review-requested:@me");
      break;
  }
  const text = (query ?? "")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !SCOPE_QUALIFIER.test(token));
  parts.push(...text, "sort:updated-desc");
  return parts.join(" ");
}

const LIST_QUERY = `query PullRequestList($owner: String!, $name: String!, $query: String!, $first: Int!) {
  viewer { login avatarUrl url }
  repository(owner: $owner, name: $name) { nameWithOwner url }
  search(query: $query, type: ISSUE, first: $first) {
    issueCount
    nodes {
      __typename
      ... on PullRequest {
        number
        title
        url
        state
        isDraft
        createdAt
        updatedAt
        headRefName
        baseRefName
        author { login avatarUrl url }
        repository { nameWithOwner }
        comments { totalCount }
        labels(first: 20) { nodes { name color description } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

function rollupState(value: unknown): GitHubPullRequestChecksState {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

function listItemFromGraphql(node: unknown, fullName: string): GitHubPullRequestListItem | null {
  if (!isRecord(node) || node.__typename !== "PullRequest") return null;
  const repository = isRecord(node.repository) ? node.repository : {};
  if (stringValue(repository.nameWithOwner).toLowerCase() !== fullName.toLowerCase()) return null;
  const number = numberValue(node.number);
  const title = stringValue(node.title);
  const htmlUrl = stringValue(node.url);
  if (!number || !htmlUrl) return null;
  const rawState = stringValue(node.state).toUpperCase();
  const state: GitHubPullRequestState =
    rawState === "MERGED" ? "merged" : rawState === "CLOSED" ? "closed" : "open";
  const labels = isRecord(node.labels) ? node.labels.nodes : [];
  const comments = isRecord(node.comments) ? node.comments : {};
  const commits =
    isRecord(node.commits) && Array.isArray(node.commits.nodes) ? node.commits.nodes : [];
  const lastCommit: unknown = commits[0];
  const commit = isRecord(lastCommit) && isRecord(lastCommit.commit) ? lastCommit.commit : null;
  const item: GitHubPullRequestListItem = {
    number,
    title,
    htmlUrl,
    state,
    isDraft: node.isDraft === true,
    author: graphqlUser(node.author),
    headRef: stringValue(node.headRefName),
    baseRef: stringValue(node.baseRefName),
    createdAt: stringValue(node.createdAt),
    updatedAt: stringValue(node.updatedAt),
    commentsCount: numberValue(comments.totalCount),
    labels: prLabels(labels),
  };
  if (commit) {
    item.checksState = rollupState(
      isRecord(commit.statusCheckRollup) ? commit.statusCheckRollup.state : null,
    );
  }
  return item;
}

/**
 * One GraphQL search: pull requests in the repository matching the filter and
 * free text, most recently updated first, capped at 100.
 */
export async function listGitHubPullRequests(
  token: string,
  repository: GitHubRepositoryCoordinates,
  filter: GitHubPullRequestListFilter,
  query?: string,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestListResult> {
  assertRepositoryCoordinates(repository);
  const client = pullRequestClient(token, options);
  const data = await graphql<Record<string, unknown>>(
    client,
    LIST_QUERY,
    {
      owner: repository.owner,
      name: repository.repo,
      query: buildPullRequestSearchQuery(repository, filter, query),
      first: MAX_LIST_RESULTS,
    },
    "load pull requests",
  );
  const viewer = graphqlUser(data.viewer);
  if (!viewer) {
    throw new GitHubApiError(
      "GitHub returned an invalid authenticated user. Update the token and try again.",
    );
  }
  if (!isRecord(data.repository)) {
    throw new GitHubApiError(
      `GitHub could not find ${repository.owner}/${repository.repo}, or the token may not have access.`,
      { code: "not-found", status: 404 },
    );
  }
  const fullName = stringValue(
    data.repository.nameWithOwner,
    `${repository.owner}/${repository.repo}`,
  );
  const [owner = repository.owner, repo = repository.repo] = fullName.split("/");
  const search = isRecord(data.search) ? data.search : {};
  const nodes = Array.isArray(search.nodes) ? search.nodes : [];
  const pullRequests = nodes
    .map((node) => listItemFromGraphql(node, fullName))
    .filter((item): item is GitHubPullRequestListItem => item !== null);
  return {
    repository: {
      owner,
      repo,
      fullName,
      htmlUrl: stringValue(data.repository.url, `https://github.com/${fullName}`),
    },
    viewer,
    filter,
    pullRequests,
    hasMore: numberValue(search.issueCount) > nodes.length,
  };
}

// ---------------------------------------------------------------------------
// Detail

const MAX_REVIEWS = 300;
const MAX_DETAIL_COMMENTS = 500;
const MAX_CHECK_RUN_PAGES = 3;

const FAILING_CONCLUSIONS = new Set<GitHubPullRequestCheckConclusion>([
  "failure",
  "timed-out",
  "action-required",
  "cancelled",
]);

function checkRunConclusion(run: Record<string, unknown>): GitHubPullRequestCheckConclusion {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "startup_failure":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "timed_out":
      return "timed-out";
    case "action_required":
      return "action-required";
    case "stale":
      return "stale";
    default:
      return "neutral";
  }
}

function statusConclusion(state: unknown): GitHubPullRequestCheckConclusion {
  switch (state) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    default:
      return "pending";
  }
}

/**
 * Check runs and legacy commit statuses for one commit, one entry per name
 * (check runs win over a status with the same context), sorted by name.
 */
export function mergeChecks(checkRuns: unknown[], statuses: unknown[]): GitHubPullRequestCheck[] {
  const byName = new Map<string, GitHubPullRequestCheck & { at: string }>();
  for (const value of checkRuns) {
    if (!isRecord(value)) continue;
    const name = stringValue(value.name);
    if (!name) continue;
    const at = stringValue(value.started_at) || stringValue(value.completed_at);
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing && existing.at >= at) continue;
    const app = isRecord(value.app) ? value.app : {};
    const output = isRecord(value.output) ? value.output : {};
    byName.set(key, {
      name,
      context: optionalString(app.name),
      conclusion: checkRunConclusion(value),
      detailsUrl: optionalString(value.details_url) ?? optionalString(value.html_url),
      summary: optionalString(output.title),
      at,
    });
  }
  for (const value of statuses) {
    if (!isRecord(value)) continue;
    const name = stringValue(value.context);
    if (!name || byName.has(name.toLowerCase())) continue;
    byName.set(name.toLowerCase(), {
      name,
      conclusion: statusConclusion(value.state),
      detailsUrl: optionalString(value.target_url),
      summary: optionalString(value.description),
      at: "",
    });
  }
  return Array.from(byName.values())
    .map(({ at: _at, ...check }) => check)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function rollUpChecks(
  checks: readonly GitHubPullRequestCheck[],
): GitHubPullRequestChecksState {
  if (checks.length === 0) return "none";
  if (checks.some((check) => FAILING_CONCLUSIONS.has(check.conclusion))) return "failure";
  if (checks.some((check) => check.conclusion === "pending")) return "pending";
  if (checks.some((check) => check.conclusion === "success")) return "success";
  return "neutral";
}

async function loadChecks(
  client: GitHubPullRequestClient,
  ref: GitHubPullRequestRef,
  sha: string,
): Promise<GitHubPullRequestCheck[]> {
  if (!isCommitSha(sha)) return [];
  const commitPath = `${repoPath(ref)}/commits/${encodePathSegment(sha)}`;
  const loadRuns = async (): Promise<unknown[]> => {
    const runs: unknown[] = [];
    let next: string | null = `${commitPath}/check-runs?per_page=100`;
    for (let page = 0; next && page < MAX_CHECK_RUN_PAGES; page++) {
      const { data, link } = await getJson(client, next, "load check runs");
      if (!isRecord(data) || !Array.isArray(data.check_runs)) break;
      runs.push(...data.check_runs);
      next = nextLink(link);
    }
    return runs;
  };
  const loadStatuses = async (): Promise<unknown[]> => {
    const { data } = await getJson(
      client,
      `${commitPath}/status?per_page=100`,
      "load commit statuses",
    );
    return isRecord(data) && Array.isArray(data.statuses) ? data.statuses : [];
  };
  // A token without checks/statuses read access still shows the rest of the PR.
  const tolerate = (error: unknown): unknown[] => {
    if (
      error instanceof GitHubApiError &&
      (error.code === "permission" || error.code === "not-found")
    ) {
      return [];
    }
    throw error;
  };
  const [runs, statuses] = await Promise.all([
    loadRuns().catch(tolerate),
    loadStatuses().catch(tolerate),
  ]);
  return mergeChecks(runs, statuses);
}

/**
 * Reviewers in first-review order, then outstanding requests. A user's state
 * is their latest approval, change request or dismissal; failing that,
 * "commented" (or "pending" for an unsubmitted review). The author is skipped.
 */
export function buildReviewers(
  ref: GitHubPullRequestRef,
  pull: Record<string, unknown>,
  reviews: readonly unknown[],
): GitHubPullRequestReviewer[] {
  const authorLogin = prUser(pull.user)?.login.toLowerCase();
  type Entry = {
    reviewer: GitHubPullRequestReviewer;
    decisive?: GitHubPullRequestReviewState;
    commented: boolean;
    pending: boolean;
  };
  const entries = new Map<string, Entry>();
  const entryFor = (user: GitHubPullRequestUser): Entry => {
    const key = user.login.toLowerCase();
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        reviewer: { login: user.login, kind: "user", avatarUrl: user.avatarUrl, requested: false },
        commented: false,
        pending: false,
      };
      entries.set(key, entry);
    }
    return entry;
  };
  for (const review of reviews) {
    if (!isRecord(review)) continue;
    const user = prUser(review.user);
    if (!user || user.login.toLowerCase() === authorLogin) continue;
    const state = reviewStateFromApi(review.state);
    if (!state) continue;
    const entry = entryFor(user);
    if (state === "commented") entry.commented = true;
    else if (state === "pending") entry.pending = true;
    else entry.decisive = state;
  }
  for (const user of prUsers(pull.requested_reviewers)) {
    entryFor(user).reviewer.requested = true;
  }
  const reviewers = Array.from(entries.values()).map((entry) => {
    const state =
      entry.decisive ?? (entry.commented ? "commented" : entry.pending ? "pending" : undefined);
    return state ? { ...entry.reviewer, state } : entry.reviewer;
  });
  for (const team of Array.isArray(pull.requested_teams) ? pull.requested_teams : []) {
    if (!isRecord(team)) continue;
    const slug = stringValue(team.slug);
    if (!slug) continue;
    reviewers.push({ login: `${ref.owner}/${slug}`, kind: "team", requested: true });
  }
  return reviewers;
}

export function mergeabilityFromApi(
  pull: Record<string, unknown>,
  state: GitHubPullRequestState,
  isDraft: boolean,
): GitHubPullRequestMergeability {
  if (state !== "open" || isDraft) return "unavailable";
  switch (pull.mergeable_state) {
    case "clean":
    case "has_hooks":
      return "clean";
    case "blocked":
      return "blocked";
    case "dirty":
      return "dirty";
    case "behind":
      return "behind";
    case "unstable":
      return "unstable";
    case "draft":
      return "unavailable";
    default:
      return "unknown";
  }
}

export function allowedMergeMethods(
  repository: Record<string, unknown>,
): GitHubPullRequestMergeMethod[] {
  const methods: GitHubPullRequestMergeMethod[] = [];
  if (repository.allow_merge_commit !== false) methods.push("merge");
  if (repository.allow_squash_merge !== false) methods.push("squash");
  if (repository.allow_rebase_merge !== false) methods.push("rebase");
  return methods;
}

export function isCrossRepositoryPull(pull: Record<string, unknown>): boolean {
  const head = isRecord(pull.head) ? pull.head : {};
  const base = isRecord(pull.base) ? pull.base : {};
  const headRepo = isRecord(head.repo) ? stringValue(head.repo.full_name) : "";
  const baseRepo = isRecord(base.repo) ? stringValue(base.repo.full_name) : "";
  // A deleted fork leaves `head.repo` null: still not this repository.
  return !headRepo || !baseRepo || headRepo.toLowerCase() !== baseRepo.toLowerCase();
}

export async function getGitHubPullRequest(
  token: string,
  ref: GitHubPullRequestRef,
  options: GitHubPullRequestRequestOptions = {},
): Promise<GitHubPullRequestDetail> {
  assertPullRequestRef(ref);
  const client = pullRequestClient(token, options);
  const pullPromise = loadPullRequestRecord(client, ref);
  const checksPromise = pullPromise.then((pull) => loadChecks(client, ref, pullHeadSha(pull)));
  const [pull, reviews, commentValues, identity, checks] = await Promise.all([
    pullPromise,
    getList(client, `${pullPath(ref)}/reviews`, "load pull request reviews", MAX_REVIEWS),
    getList(
      client,
      `${issuePath(ref)}/comments`,
      "load pull request comments",
      MAX_DETAIL_COMMENTS,
    ),
    loadViewerIdentity(client, ref),
    checksPromise,
  ]);
  return buildPullRequestDetail(ref, pull, {
    reviews: reviews.values,
    comments: commentValues.values,
    identity,
    checks,
  });
}

export function buildPullRequestDetail(
  ref: GitHubPullRequestRef,
  pull: Record<string, unknown>,
  parts: {
    reviews: readonly unknown[];
    comments: readonly unknown[];
    identity: GitHubViewerIdentity;
    checks: GitHubPullRequestCheck[];
  },
): GitHubPullRequestDetail {
  const { identity } = parts;
  const head = isRecord(pull.head) ? pull.head : {};
  const base = isRecord(pull.base) ? pull.base : {};
  const state = pullRequestState(pull);
  const isDraft = pull.draft === true;
  const author = prUser(pull.user);
  const isCrossRepository = isCrossRepositoryPull(pull);
  const headRepositoryFullName =
    isCrossRepository && isRecord(head.repo) ? (optionalString(head.repo.full_name) ?? null) : null;
  const comments = parts.comments
    .map((value) => prComment(value))
    .filter((comment): comment is GitHubPullRequestComment => comment !== null)
    .map((comment) => ({ ...comment, canEdit: canEditComment(comment, identity) }));
  return {
    ref: { owner: ref.owner, repo: ref.repo, number: ref.number },
    nodeId: pullNodeId(pull, ref),
    title: stringValue(pull.title),
    body: stringValue(pull.body),
    htmlUrl: stringValue(
      pull.html_url,
      `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    ),
    state,
    isDraft,
    author,
    createdAt: stringValue(pull.created_at),
    updatedAt: stringValue(pull.updated_at),
    mergedAt: optionalString(pull.merged_at) ?? null,
    closedAt: optionalString(pull.closed_at) ?? null,
    mergedBy: prUser(pull.merged_by),
    baseRef: stringValue(base.ref),
    headRef: stringValue(head.ref),
    headSha: stringValue(head.sha),
    headRepositoryFullName,
    isCrossRepository,
    additions: numberValue(pull.additions),
    deletions: numberValue(pull.deletions),
    changedFiles: numberValue(pull.changed_files),
    commitsCount: numberValue(pull.commits),
    commentsCount: numberValue(pull.comments),
    reviewCommentsCount: numberValue(pull.review_comments),
    labels: prLabels(pull.labels),
    assignees: prUsers(pull.assignees),
    reviewers: buildReviewers(ref, pull, parts.reviews),
    checks: parts.checks,
    checksState: rollUpChecks(parts.checks),
    comments,
    mergeability: mergeabilityFromApi(pull, state, isDraft),
    allowedMergeMethods: allowedMergeMethods(identity.repository),
    viewer: identity.viewer,
    viewerPermissions: {
      canWrite: identity.canWrite,
      canMerge: identity.canWrite && state === "open",
      isAuthor:
        author !== null && author.login.toLowerCase() === identity.viewer.login.toLowerCase(),
    },
  };
}
