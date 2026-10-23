/**
 * Fixtures and a backend fake for the pull request viewer tests. Tests drive
 * the real `@/lib/backend` functions through the `invoke` mock that
 * `tests/setup.ts` installs for `@/lib/native/backend`.
 */
import type { mock } from "bun:test";
import type {
  GitHubPullRequestDetail,
  GitHubPullRequestFile,
  GitHubPullRequestFiles,
  GitHubPullRequestListItem,
  GitHubPullRequestListResult,
  GitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { usePullRequestsStore } from "@/stores/pullRequestsStore";

export const prRef: GitHubPullRequestRef = { owner: "acme", repo: "widget", number: 42 };

export function makeDetail(
  overrides: Partial<GitHubPullRequestDetail> = {},
): GitHubPullRequestDetail {
  return {
    ref: prRef,
    nodeId: "PR_node",
    title: "feat: add usage history tab",
    body: "Adds a **usage** tab.",
    htmlUrl: "https://github.com/acme/widget/pull/42",
    state: "open",
    isDraft: false,
    author: { login: "ada" },
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    mergedAt: null,
    closedAt: null,
    mergedBy: null,
    baseRef: "main",
    headRef: "feature/usage",
    headSha: "abc1234def5678",
    headRepositoryFullName: null,
    isCrossRepository: false,
    additions: 3831,
    deletions: 4,
    changedFiles: 56,
    commitsCount: 8,
    commentsCount: 1,
    reviewCommentsCount: 0,
    labels: [{ name: "enhancement", color: "84b6eb" }],
    assignees: [],
    reviewers: [
      { login: "grace", kind: "user", state: "approved", requested: false },
      { login: "linus", kind: "user", requested: true },
    ],
    checks: [
      { name: "build", context: "CI", conclusion: "success" },
      { name: "lint", context: "CI", conclusion: "failure", detailsUrl: "https://ci/lint" },
    ],
    checksState: "failure",
    comments: [
      {
        id: 7,
        body: "This is great.",
        htmlUrl: "https://github.com/acme/widget/pull/42#issuecomment-7",
        author: { login: "grace" },
        createdAt: "2026-10-22T10:00:00.000Z",
        updatedAt: "2026-10-22T10:00:00.000Z",
        isEdited: false,
        canEdit: false,
      },
    ],
    mergeability: "clean",
    allowedMergeMethods: ["merge", "squash", "rebase"],
    viewer: { login: "ada" },
    viewerPermissions: { canWrite: true, canMerge: true, isAuthor: false },
    ...overrides,
  };
}

export function makeFile(overrides: Partial<GitHubPullRequestFile> = {}): GitHubPullRequestFile {
  return {
    path: "src/app.ts",
    previousPath: null,
    status: "modified",
    additions: 1,
    deletions: 1,
    patchAvailable: true,
    viewedState: "unviewed",
    hunks: [
      {
        header: "@@ -1,3 +1,3 @@",
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          { type: "context", text: "first", oldLine: 1, newLine: 1 },
          { type: "remove", text: "old second", oldLine: 2, newLine: null },
          { type: "add", text: "new second", oldLine: null, newLine: 2 },
          { type: "context", text: "third", oldLine: 3, newLine: 3 },
        ],
      },
    ],
    ...overrides,
  };
}

export function makeFiles(overrides: Partial<GitHubPullRequestFiles> = {}): GitHubPullRequestFiles {
  return {
    ref: prRef,
    headSha: "abc1234def5678",
    files: [makeFile()],
    threads: [],
    truncated: false,
    ...overrides,
  };
}

export function makeListItem(
  number: number,
  overrides: Partial<GitHubPullRequestListItem> = {},
): GitHubPullRequestListItem {
  return {
    number,
    title: `Pull request ${number}`,
    htmlUrl: `https://github.com/acme/widget/pull/${number}`,
    state: "open",
    isDraft: false,
    author: { login: "ada" },
    headRef: `branch-${number}`,
    baseRef: "main",
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    commentsCount: 0,
    labels: [],
    ...overrides,
  };
}

export function makeList(
  items: GitHubPullRequestListItem[],
  overrides: Partial<GitHubPullRequestListResult> = {},
): GitHubPullRequestListResult {
  return {
    repository: {
      owner: "acme",
      repo: "widget",
      fullName: "acme/widget",
      htmlUrl: "https://github.com/acme/widget",
    },
    viewer: { login: "ada" },
    filter: "open",
    pullRequests: items,
    hasMore: false,
    ...overrides,
  };
}

type Handler = (args: Record<string, unknown>) => unknown;

export const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

/** Routes backend commands to handlers; unknown commands resolve undefined. */
export function installBackend(handlers: Record<string, Handler>) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command];
    return handler ? handler(args) : undefined;
  });
  return invokeMock;
}

export function resetBackend() {
  invokeMock.mockClear();
  invokeMock.mockImplementation(() => Promise.resolve());
}

export function callsFor(command: string): Record<string, unknown>[] {
  return invokeMock.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => (args ?? {}) as Record<string, unknown>);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/**
 * Empties every cache in the pull request store. Tests must not snapshot
 * `getState()` at import: files sharing a process would capture a sibling's
 * leftovers.
 */
export function resetPullRequestsStore() {
  usePullRequestsStore.setState({
    details: new Map(),
    timelines: new Map(),
    files: new Map(),
    lists: new Map(),
    loading: new Set(),
    errors: new Map(),
    loadedAt: new Map(),
    mutations: new Set(),
  });
}
