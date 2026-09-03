import {
  parseGitHubRepositoryRemote,
  type GitHubRepositoryRef,
} from "@orkestrator/protocol/github-repository";

export const GITHUB_STATUS_LABELS = {
  todo: "ork:todo",
  inprogress: "ork:inprogress",
  review: "ork:review",
} as const;

export type GitHubIssueStatus = "backlog" | keyof typeof GITHUB_STATUS_LABELS;

export type { GitHubRepositoryRef } from "@orkestrator/protocol/github-repository";

export type GitHubUser = {
  login: string;
  avatarUrl?: string;
  htmlUrl?: string;
};

export type GitHubLabel = {
  name: string;
  color: string;
  description?: string;
};

export type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  state: "open" | "closed";
  locked: boolean;
  author: GitHubUser | null;
  assignees: GitHubUser[];
  labels: GitHubLabel[];
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
  status: GitHubIssueStatus;
};

export type GitHubIssueComment = {
  id: number;
  body: string;
  htmlUrl: string;
  author: GitHubUser | null;
  createdAt: string;
  updatedAt: string;
  isEdited: boolean;
  canEdit: boolean;
};

export type GitHubRepository = GitHubRepositoryRef & {
  fullName: string;
  htmlUrl: string;
};

export type GitHubViewer = GitHubUser;

export type GitHubIssuesSnapshot = {
  repository: GitHubRepository;
  viewer: GitHubViewer;
  issues: GitHubIssue[];
};

export type GitHubIssueDetail = GitHubIssue & {
  comments: GitHubIssueComment[];
};

type GitHubFetch = typeof fetch;

type GitHubRepositoryIdentity = {
  repository: GitHubRepository;
  viewer: GitHubViewer;
  viewerCanManageIssueComments: boolean;
};

type GitHubApiErrorOptions = {
  status?: number;
  code?:
    | "authentication"
    | "permission"
    | "not-found"
    | "rate-limit"
    | "validation"
    | "network"
    | "github";
};

export class GitHubApiError extends Error {
  readonly status?: number;
  readonly code: NonNullable<GitHubApiErrorOptions["code"]>;

  constructor(message: string, options: GitHubApiErrorOptions = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = options.status;
    this.code = options.code ?? "github";
  }
}

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const STATUS_LABEL_NAMES = Object.values(GITHUB_STATUS_LABELS);
const ensureLabelLocks = new Map<string, Promise<void>>();
const issueStatusLocks = new Map<string, Promise<unknown>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubApiError(`${name} must be a positive integer.`, { code: "validation" });
  }
  return value;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function repositoryPath(ref: GitHubRepositoryRef): string {
  return `/repos/${encodePathSegment(ref.owner)}/${encodePathSegment(ref.name)}`;
}

/**
 * Resolve owner/name from the GitHub URL stored on a project. Only github.com
 * remotes are accepted so a project cannot accidentally query another host.
 */
export function resolveGitHubRepository(gitUrl: string): GitHubRepositoryRef {
  const result = parseGitHubRepositoryRemote(gitUrl);
  if (result.ok) return result.repository;

  if (result.reason === "missing") {
    throw new GitHubApiError(
      "This project does not have a GitHub repository URL. Update the project repository and try again.",
      { code: "validation" },
    );
  }
  if (result.reason === "unsupported-host-or-protocol") {
    throw new GitHubApiError("This project repository must use a github.com HTTPS or SSH URL.", {
      code: "validation",
    });
  }
  if (result.reason === "invalid-path") {
    throw new GitHubApiError(
      "Could not resolve the GitHub repository owner and name from the project URL.",
      { code: "validation" },
    );
  }
  throw new GitHubApiError(
    "Could not resolve the GitHub repository. Use an HTTPS or SSH GitHub repository URL.",
    { code: "validation" },
  );
}

export function sanitizeGitHubError(error: unknown, secret?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  let sanitized = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/gi, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/gi, "[redacted]");
  const token = secret?.trim();
  if (token) sanitized = sanitized.split(token).join("[redacted]");
  return sanitized.trim() || "GitHub request failed. Try again.";
}

function safePayloadMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const message = optionalString(payload.message);
  if (!message) return undefined;
  return message.replace(/https?:\/\/\S+/g, "GitHub documentation").slice(0, 300);
}

function rateLimitMessage(response: Response): string {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return `GitHub rate limit reached. Try again in ${Math.ceil(retryAfter)} seconds.`;
  }

  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const resetAt = new Date(reset * 1000);
    if (!Number.isNaN(resetAt.valueOf())) {
      return `GitHub rate limit reached. Try again after ${resetAt.toLocaleString()}.`;
    }
  }
  return "GitHub rate limit reached. Wait a moment and try again.";
}

function responseError(response: Response, payload: unknown, operation: string): GitHubApiError {
  const status = response.status;
  const apiMessage = safePayloadMessage(payload)?.toLowerCase() ?? "";
  const rateLimited =
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after") ||
    apiMessage.includes("rate limit");

  if ((status === 403 || status === 429) && rateLimited) {
    return new GitHubApiError(rateLimitMessage(response), { status, code: "rate-limit" });
  }
  if (status === 401) {
    return new GitHubApiError(
      "GitHub authentication failed. Update the global GitHub token in Settings and try again.",
      { status, code: "authentication" },
    );
  }
  if (status === 403) {
    return new GitHubApiError(
      `GitHub denied permission to ${operation}. Check that the global GitHub token has Issues write access.`,
      { status, code: "permission" },
    );
  }
  if (status === 404) {
    return new GitHubApiError(
      `GitHub could not find the requested repository, issue, or comment while trying to ${operation}. It may have been deleted, or the token may not have access.`,
      { status, code: "not-found" },
    );
  }
  if (status === 409) {
    return new GitHubApiError(
      `GitHub could not ${operation} because the repository state changed. Refresh and try again.`,
      { status, code: "github" },
    );
  }
  if (status === 422) {
    return new GitHubApiError(
      `GitHub rejected the request to ${operation}. Refresh the issue, check the entered values, and try again.`,
      { status, code: "validation" },
    );
  }
  return new GitHubApiError(`GitHub could not ${operation} (HTTP ${status}). Try again.`, {
    status,
    code: "github",
  });
}

function requestUrl(pathOrUrl: string): string {
  const url = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl, GITHUB_API_BASE);
  if (url.origin !== GITHUB_API_BASE) {
    throw new GitHubApiError("GitHub returned an unsafe pagination URL.", { code: "github" });
  }
  return url.toString();
}

async function githubRequest<T>(
  token: string,
  pathOrUrl: string,
  operation: string,
  init: RequestInit = {},
  fetchImpl: GitHubFetch = fetch,
): Promise<{ data: T; response: Response }> {
  const credential = token.trim();
  if (!credential) {
    throw new GitHubApiError(
      "GitHub is not configured. Add a global GitHub token in Settings and try again.",
      { code: "authentication" },
    );
  }

  let response: Response;
  const timeoutSignal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  try {
    response = await fetchImpl(requestUrl(pathOrUrl), {
      ...init,
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${credential}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
  } catch {
    if (timeoutSignal.aborted) {
      throw new GitHubApiError(
        `GitHub timed out while trying to ${operation}. Check your network connection and try again.`,
        { code: "network" },
      );
    }
    throw new GitHubApiError(
      "Unable to reach GitHub. Check your network connection and try again.",
      { code: "network" },
    );
  }

  let payload: unknown = null;
  if (response.status !== 204) {
    try {
      payload = await response.json();
    } catch {
      if (response.ok) {
        throw new GitHubApiError(
          `GitHub returned an invalid response while trying to ${operation}. Try again.`,
          { status: response.status, code: "github" },
        );
      }
    }
  }
  if (!response.ok) throw responseError(response, payload, operation);
  return { data: payload as T, response };
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/);
    if (match?.[1] && match[2]?.split(/\s+/).includes("next")) return match[1];
  }
  return null;
}

async function githubPaginatedArray(
  token: string,
  path: string,
  operation: string,
  fetchImpl: GitHubFetch = fetch,
): Promise<unknown[]> {
  const separator = path.includes("?") ? "&" : "?";
  let next: string | null = `${path}${separator}per_page=100&page=1`;
  const visited = new Set<string>();
  const values: unknown[] = [];

  while (next) {
    const url = requestUrl(next);
    if (visited.has(url)) {
      throw new GitHubApiError(
        `GitHub ${operation} pagination repeated a page. Refresh and try again.`,
      );
    }
    visited.add(url);
    const { data, response } = await githubRequest<unknown>(token, url, operation, {}, fetchImpl);
    if (!Array.isArray(data)) {
      throw new GitHubApiError(
        `GitHub returned an invalid list while trying to ${operation}. Try again.`,
      );
    }
    values.push(...data);
    next = nextLink(response.headers.get("link"));
  }
  return values;
}

function userFromApi(value: unknown): GitHubUser | null {
  if (!isRecord(value)) return null;
  const login = stringValue(value.login);
  if (!login) return null;
  return {
    login,
    avatarUrl: optionalString(value.avatar_url),
    htmlUrl: optionalString(value.html_url),
  };
}

function labelFromApi(value: unknown): GitHubLabel | null {
  if (typeof value === "string") return { name: value, color: "" };
  if (!isRecord(value)) return null;
  const name = stringValue(value.name);
  if (!name) return null;
  return {
    name,
    color: stringValue(value.color),
    description: optionalString(value.description),
  };
}

export function getGitHubIssueStatus(labels: readonly GitHubLabel[]): GitHubIssueStatus {
  const names = new Set(labels.map((label) => label.name.toLowerCase()));
  if (names.has(GITHUB_STATUS_LABELS.todo)) return "todo";
  if (names.has(GITHUB_STATUS_LABELS.inprogress)) return "inprogress";
  if (names.has(GITHUB_STATUS_LABELS.review)) return "review";
  return "backlog";
}

function issueFromApi(value: unknown): GitHubIssue | null {
  if (!isRecord(value) || "pull_request" in value) return null;
  const id = numberValue(value.id);
  const issueNumber = numberValue(value.number);
  const title = stringValue(value.title);
  const htmlUrl = stringValue(value.html_url);
  const createdAt = stringValue(value.created_at);
  const updatedAt = stringValue(value.updated_at);
  if (!id || !issueNumber || !title || !htmlUrl || !createdAt || !updatedAt) return null;

  const labelValues = Array.isArray(value.labels) ? value.labels : [];
  const labels = labelValues
    .map(labelFromApi)
    .filter((label): label is GitHubLabel => label !== null);
  const assigneeValues = Array.isArray(value.assignees) ? value.assignees : [];
  return {
    id,
    number: issueNumber,
    title,
    body: stringValue(value.body),
    htmlUrl,
    state: value.state === "closed" ? "closed" : "open",
    locked: value.locked === true,
    author: userFromApi(value.user),
    assignees: assigneeValues.map(userFromApi).filter((user): user is GitHubUser => user !== null),
    labels,
    commentsCount: numberValue(value.comments),
    createdAt,
    updatedAt,
    status: getGitHubIssueStatus(labels),
  };
}

function commentFromApi(value: unknown, canEdit = false): GitHubIssueComment | null {
  if (!isRecord(value)) return null;
  const id = numberValue(value.id);
  const htmlUrl = stringValue(value.html_url);
  const createdAt = stringValue(value.created_at);
  const updatedAt = stringValue(value.updated_at, createdAt);
  if (!id || !createdAt) return null;
  return {
    id,
    body: stringValue(value.body),
    htmlUrl,
    author: userFromApi(value.user),
    createdAt,
    updatedAt,
    isEdited: updatedAt !== createdAt,
    canEdit,
  };
}

function viewerCanEditComment(
  comment: GitHubIssueComment,
  viewer: GitHubViewer,
  viewerCanManageIssueComments: boolean,
): boolean {
  return (
    viewerCanManageIssueComments ||
    comment.author?.login.toLowerCase() === viewer.login.toLowerCase()
  );
}

async function loadRepositoryIdentity(
  token: string,
  ref: GitHubRepositoryRef,
  fetchImpl: GitHubFetch = fetch,
): Promise<GitHubRepositoryIdentity> {
  const base = repositoryPath(ref);
  const [viewerResult, repositoryResult] = await Promise.all([
    githubRequest<unknown>(token, "/user", "load the authenticated GitHub user", {}, fetchImpl),
    githubRequest<unknown>(token, base, "load the project repository", {}, fetchImpl),
  ]);
  const viewer = userFromApi(viewerResult.data);
  if (!viewer)
    throw new GitHubApiError(
      "GitHub returned an invalid authenticated user. Update the token and try again.",
    );
  if (!isRecord(repositoryResult.data)) {
    throw new GitHubApiError("GitHub returned invalid repository information. Try again.");
  }
  const fullName = stringValue(repositoryResult.data.full_name, `${ref.owner}/${ref.name}`);
  const htmlUrl = stringValue(
    repositoryResult.data.html_url,
    `https://github.com/${ref.owner}/${ref.name}`,
  );
  const permissions = isRecord(repositoryResult.data.permissions)
    ? repositoryResult.data.permissions
    : {};
  return {
    viewer,
    repository: { ...ref, fullName, htmlUrl },
    viewerCanManageIssueComments:
      permissions.admin === true || permissions.maintain === true || permissions.push === true,
  };
}

async function ensureWorkflowLabelsUnlocked(
  token: string,
  ref: GitHubRepositoryRef,
  fetchImpl: GitHubFetch,
): Promise<void> {
  const base = repositoryPath(ref);
  const labelValues = await githubPaginatedArray(
    token,
    `${base}/labels`,
    "load repository labels",
    fetchImpl,
  );
  const existing = new Set(
    labelValues
      .map(labelFromApi)
      .filter((label): label is GitHubLabel => label !== null)
      .map((label) => label.name.toLowerCase()),
  );
  const definitions: Array<{ name: string; color: string; description: string }> = [
    {
      name: GITHUB_STATUS_LABELS.todo,
      color: "D4C5F9",
      description: "Ready to start in Orkestrator",
    },
    {
      name: GITHUB_STATUS_LABELS.inprogress,
      color: "FBCA04",
      description: "In progress in Orkestrator",
    },
    {
      name: GITHUB_STATUS_LABELS.review,
      color: "0E8A16",
      description: "Ready for review in Orkestrator",
    },
  ];

  for (const label of definitions) {
    if (existing.has(label.name)) continue;
    try {
      await githubRequest(
        token,
        `${base}/labels`,
        `create the ${label.name} workflow label`,
        { method: "POST", body: JSON.stringify(label) },
        fetchImpl,
      );
    } catch (error) {
      // A concurrent refresh may have created it between the list and POST.
      if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
      await githubRequest(
        token,
        `${base}/labels/${encodePathSegment(label.name)}`,
        `verify the ${label.name} workflow label`,
        {},
        fetchImpl,
      );
    }
    existing.add(label.name);
  }
}

export async function ensureGitHubWorkflowLabels(
  token: string,
  ref: GitHubRepositoryRef,
  fetchImpl: GitHubFetch = fetch,
): Promise<void> {
  const key = `${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}`;
  const existing = ensureLabelLocks.get(key);
  if (existing) return existing;
  const task = ensureWorkflowLabelsUnlocked(token, ref, fetchImpl);
  ensureLabelLocks.set(key, task);
  try {
    await task;
  } finally {
    if (ensureLabelLocks.get(key) === task) ensureLabelLocks.delete(key);
  }
}

export async function listGitHubIssues(
  token: string,
  ref: GitHubRepositoryRef,
  fetchImpl: GitHubFetch = fetch,
): Promise<GitHubIssuesSnapshot> {
  await ensureGitHubWorkflowLabels(token, ref, fetchImpl);
  const [identity, issueValues] = await Promise.all([
    loadRepositoryIdentity(token, ref, fetchImpl),
    githubPaginatedArray(
      token,
      `${repositoryPath(ref)}/issues?state=open`,
      "load open issues",
      fetchImpl,
    ),
  ]);
  const issues = issueValues
    .map(issueFromApi)
    .filter((issue): issue is GitHubIssue => issue !== null && issue.state === "open");
  return { repository: identity.repository, viewer: identity.viewer, issues };
}

async function getIssue(
  token: string,
  ref: GitHubRepositoryRef,
  issueNumber: number,
  fetchImpl: GitHubFetch,
): Promise<GitHubIssue> {
  requirePositiveInteger(issueNumber, "Issue number");
  const { data } = await githubRequest<unknown>(
    token,
    `${repositoryPath(ref)}/issues/${issueNumber}`,
    `load issue #${issueNumber}`,
    {},
    fetchImpl,
  );
  const issue = issueFromApi(data);
  if (!issue) {
    throw new GitHubApiError(
      `GitHub issue #${issueNumber} was invalid or is a pull request. Refresh the issue list and try again.`,
      { code: "validation" },
    );
  }
  return issue;
}

export async function listGitHubIssueComments(
  token: string,
  ref: GitHubRepositoryRef,
  issueNumber: number,
  fetchImpl: GitHubFetch = fetch,
): Promise<GitHubIssueComment[]> {
  requirePositiveInteger(issueNumber, "Issue number");
  const values = await githubPaginatedArray(
    token,
    `${repositoryPath(ref)}/issues/${issueNumber}/comments`,
    `load comments for issue #${issueNumber}`,
    fetchImpl,
  );
  return values
    .map((value) => commentFromApi(value))
    .filter((comment): comment is GitHubIssueComment => comment !== null);
}

export async function getGitHubIssue(
  token: string,
  ref: GitHubRepositoryRef,
  issueNumber: number,
  fetchImpl: GitHubFetch = fetch,
): Promise<GitHubIssueDetail> {
  const [issue, comments, identity] = await Promise.all([
    getIssue(token, ref, issueNumber, fetchImpl),
    listGitHubIssueComments(token, ref, issueNumber, fetchImpl),
    loadRepositoryIdentity(token, ref, fetchImpl),
  ]);
  return {
    ...issue,
    comments: comments.map((comment) => ({
      ...comment,
      canEdit: viewerCanEditComment(
        comment,
        identity.viewer,
        identity.viewerCanManageIssueComments,
      ),
    })),
  };
}

export async function updateGitHubIssue(
  token: string,
  ref: GitHubRepositoryRef,
  issueNumber: number,
  updates: { title: string; body: string },
  fetchImpl: GitHubFetch = fetch,
): Promise<GitHubIssue> {
  requirePositiveInteger(issueNumber, "Issue number");
  const title = updates.title.trim();
  if (!title) throw new GitHubApiError("Issue title cannot be empty.", { code: "validation" });
  if (typeof updates.body !== "string") {
    throw new GitHubApiError("Issue body must be text.", { code: "validation" });
  }
  const { data } = await githubRequest<unknown>(
    token,
    `${repositoryPath(ref)}/issues/${issueNumber}`,
    `update issue #${issueNumber}`,
    { method: "PATCH", body: JSON.stringify({ title, body: updates.body }) },
    fetchImpl,
  );
  const issue = issueFromApi(data);
  if (!issue)
    throw new GitHubApiError(
      `GitHub returned an invalid update for issue #${issueNumber}. Refresh and try again.`,
    );
  return issue;
}

export async function updateGitHubIssueStatus(
  token: string,
  ref: GitHubRepositoryRef,
  issueNumber: number,
  status: GitHubIssueStatus,
  fetchImpl: GitHubFetch = fetch,
): Promise<GitHubIssue> {
  if (status !== "backlog" && !(status in GITHUB_STATUS_LABELS)) {
    throw new GitHubApiError("Unknown GitHub issue status.", { code: "validation" });
  }
  requirePositiveInteger(issueNumber, "Issue number");
  const key = `${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}#${issueNumber}`;
  const previous = issueStatusLocks.get(key) ?? Promise.resolve();
  const update = async () => {
    const base = `${repositoryPath(ref)}/issues/${issueNumber}/labels`;
    for (const label of STATUS_LABEL_NAMES) {
      try {
        await githubRequest<unknown>(
          token,
          `${base}/${encodePathSegment(label)}`,
          `remove the ${label} workflow label from issue #${issueNumber}`,
          { method: "DELETE" },
          fetchImpl,
        );
      } catch (error) {
        // Removing an already-absent label is idempotent. Other failures are
        // surfaced so the renderer can reload the authoritative issue state.
        if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
      }
    }
    if (status !== "backlog") {
      await githubRequest<unknown>(
        token,
        base,
        `apply the ${GITHUB_STATUS_LABELS[status]} workflow label to issue #${issueNumber}`,
        {
          method: "POST",
          body: JSON.stringify({ labels: [GITHUB_STATUS_LABELS[status]] }),
        },
        fetchImpl,
      );
    }
    return getIssue(token, ref, issueNumber, fetchImpl);
  };
  // A failed queued update must not poison the next user attempt.
  const current = previous.then(update, update);
  issueStatusLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (issueStatusLocks.get(key) === current) issueStatusLocks.delete(key);
  }
}

export async function closeGitHubIssue(
  token: string,
  ref: GitHubRepositoryRef,
  issueNumber: number,
  fetchImpl: GitHubFetch = fetch,
): Promise<GitHubIssue> {
  requirePositiveInteger(issueNumber, "Issue number");
  const { data } = await githubRequest<unknown>(
    token,
    `${repositoryPath(ref)}/issues/${issueNumber}`,
    `close issue #${issueNumber}`,
    { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
    fetchImpl,
  );
  const issue = issueFromApi(data);
  if (!issue)
    throw new GitHubApiError(
      `GitHub returned an invalid result while closing issue #${issueNumber}. Refresh and try again.`,
    );
  return issue;
}

export async function postGitHubIssueComment(
  token: string,
  ref: GitHubRepositoryRef,
  issueNumber: number,
  body: string,
  fetchImpl: GitHubFetch = fetch,
): Promise<GitHubIssueComment> {
  requirePositiveInteger(issueNumber, "Issue number");
  if (!body.trim()) throw new GitHubApiError("Comment cannot be empty.", { code: "validation" });
  const { data } = await githubRequest<unknown>(
    token,
    `${repositoryPath(ref)}/issues/${issueNumber}/comments`,
    `add a comment to issue #${issueNumber}`,
    { method: "POST", body: JSON.stringify({ body }) },
    fetchImpl,
  );
  const comment = commentFromApi(data, true);
  if (!comment)
    throw new GitHubApiError(
      `GitHub returned an invalid comment for issue #${issueNumber}. Refresh and try again.`,
    );
  return comment;
}

function commentBelongsToIssue(
  value: unknown,
  ref: GitHubRepositoryRef,
  issueNumber: number,
): boolean {
  if (!isRecord(value)) return false;
  const issueUrl = optionalString(value.issue_url);
  if (!issueUrl) return false;
  try {
    const url = new URL(issueUrl);
    const parts = url.pathname.split("/");
    if (
      url.origin !== GITHUB_API_BASE ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length !== 6 ||
      parts[1] !== "repos" ||
      parts[4] !== "issues"
    ) {
      return false;
    }
    const owner = decodeURIComponent(parts[2] ?? "");
    const name = decodeURIComponent(parts[3] ?? "");
    const issueNumberPart = parts[5] ?? "";
    const targetIssueNumber = Number(issueNumberPart);
    return (
      owner.toLowerCase() === ref.owner.toLowerCase() &&
      name.toLowerCase() === ref.name.toLowerCase() &&
      /^[1-9]\d*$/.test(issueNumberPart) &&
      Number.isSafeInteger(targetIssueNumber) &&
      targetIssueNumber === issueNumber
    );
  } catch {
    return false;
  }
}

export async function updateGitHubIssueComment(
  token: string,
  ref: GitHubRepositoryRef,
  issueNumber: number,
  commentId: number,
  body: string,
  fetchImpl: GitHubFetch = fetch,
): Promise<GitHubIssueComment> {
  requirePositiveInteger(issueNumber, "Issue number");
  requirePositiveInteger(commentId, "Comment ID");
  if (!body.trim()) throw new GitHubApiError("Comment cannot be empty.", { code: "validation" });

  const base = repositoryPath(ref);
  const [currentResult, identity] = await Promise.all([
    githubRequest<unknown>(
      token,
      `${base}/issues/comments/${commentId}`,
      `load comment ${commentId}`,
      {},
      fetchImpl,
    ),
    loadRepositoryIdentity(token, ref, fetchImpl),
  ]);
  if (!commentBelongsToIssue(currentResult.data, ref, issueNumber)) {
    throw new GitHubApiError(
      `Comment ${commentId} does not belong to issue #${issueNumber}. Refresh the discussion and try again.`,
      { code: "validation" },
    );
  }
  const current = commentFromApi(currentResult.data);
  if (!current)
    throw new GitHubApiError(
      `GitHub returned an invalid comment ${commentId}. Refresh and try again.`,
    );
  if (!viewerCanEditComment(current, identity.viewer, identity.viewerCanManageIssueComments)) {
    throw new GitHubApiError(
      "The authenticated GitHub user does not have permission to edit this comment.",
      { code: "permission", status: 403 },
    );
  }

  const { data } = await githubRequest<unknown>(
    token,
    `${base}/issues/comments/${commentId}`,
    `edit comment ${commentId}`,
    { method: "PATCH", body: JSON.stringify({ body }) },
    fetchImpl,
  );
  const comment = commentFromApi(data, true);
  if (!comment)
    throw new GitHubApiError(
      `GitHub returned an invalid comment update for ${commentId}. Refresh and try again.`,
    );
  return comment;
}
