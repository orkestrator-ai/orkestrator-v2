import { create } from "zustand";
import {
  addGitHubPullRequestComment,
  addGitHubPullRequestReviewComment,
  getGitHubPullRequest,
  getGitHubPullRequestFiles,
  getGitHubPullRequestTimeline,
  listGitHubPullRequests,
  mergeGitHubPullRequest,
  replyGitHubPullRequestReviewThread,
  setGitHubPullRequestFileViewed,
  setGitHubPullRequestLabels,
  setGitHubPullRequestReviewers,
  setGitHubPullRequestThreadResolved,
  submitGitHubPullRequestReview,
  updateGitHubPullRequestComment,
  updateGitHubPullRequestState,
  type GitHubPullRequestStateAction,
} from "@/lib/backend";
import {
  gitHubPullRequestKey,
  type GitHubPullRequestComment,
  type GitHubPullRequestDetail,
  type GitHubPullRequestFiles,
  type GitHubPullRequestInlineCommentInput,
  type GitHubPullRequestListFilter,
  type GitHubPullRequestListResult,
  type GitHubPullRequestMergeMethod,
  type GitHubPullRequestMergeResult,
  type GitHubPullRequestRef,
  type GitHubPullRequestReviewEvent,
  type GitHubPullRequestReviewThreadComment,
  type GitHubPullRequestTimeline,
} from "@orkestrator/protocol/github-pull-requests";

/**
 * Renderer cache for the in-app pull request viewer.
 *
 * GitHub is the source of truth: every resource here is a snapshot fetched on
 * demand, refreshed by polling while a view is visible, and re-fetched after
 * each mutation. Keys:
 * - pull request resources: `gitHubPullRequestKey(ref)`
 * - list results: `pullRequestListKey(projectId, filter, query)`
 * Loading and error state is keyed by `resourceKey(kind, key)`.
 */

export type PullRequestResourceKind = "detail" | "timeline" | "files" | "list";

export const PULL_REQUEST_DETAIL_POLL_MS = 60_000;
export const PULL_REQUEST_LIST_POLL_MS = 120_000;
/** Cap on cached per-PR resources; files can carry large diffs. */
export const MAX_CACHED_PULL_REQUESTS = 30;
export const MAX_CACHED_PULL_REQUEST_LISTS = 40;

export function pullRequestListKey(
  projectId: string,
  filter: GitHubPullRequestListFilter,
  query = "",
): string {
  return `${projectId}:${filter}:${query.trim()}`;
}

export function resourceKey(kind: PullRequestResourceKind, key: string): string {
  return `${kind}:${key}`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function setCapped<T>(map: Map<string, T>, key: string, value: T, cap: number): Map<string, T> {
  const next = new Map(map);
  // Delete-then-set moves the key to the tail, so the head is always the stalest.
  next.delete(key);
  next.set(key, value);
  while (next.size > cap) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function withAdded(set: Set<string>, key: string): Set<string> {
  return new Set(set).add(key);
}

function without(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  next.delete(key);
  return next;
}

function mapWithout<T>(map: Map<string, T>, key: string): Map<string, T> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** Request sequence per resource: a response only lands if no newer read started. */
const requestSequence = new Map<string, number>();

function nextRequest(key: string): number {
  const id = (requestSequence.get(key) ?? 0) + 1;
  requestSequence.set(key, id);
  return id;
}

export interface PullRequestsState {
  details: Map<string, GitHubPullRequestDetail>;
  timelines: Map<string, GitHubPullRequestTimeline>;
  files: Map<string, GitHubPullRequestFiles>;
  lists: Map<string, GitHubPullRequestListResult>;
  /** Resource keys (`resourceKey(kind, key)`) with a read in flight. */
  loading: Set<string>;
  /** Last read error per resource key; cleared by the next successful read. */
  errors: Map<string, string>;
  /** Wall-clock ms of the last successful read per resource key. */
  loadedAt: Map<string, number>;
  /** Mutation keys in flight (`${action}:${prKey}[:${target}]`). */
  mutations: Set<string>;

  loadDetail: (ref: GitHubPullRequestRef) => Promise<void>;
  loadTimeline: (ref: GitHubPullRequestRef) => Promise<void>;
  loadFiles: (ref: GitHubPullRequestRef) => Promise<void>;
  loadList: (
    projectId: string,
    filter: GitHubPullRequestListFilter,
    query?: string,
  ) => Promise<void>;
  /** Re-fetch the detail plus any timeline/files already loaded for this PR. */
  refreshAll: (ref: GitHubPullRequestRef) => Promise<void>;

  merge: (
    ref: GitHubPullRequestRef,
    options: {
      method: GitHubPullRequestMergeMethod;
      deleteBranch: boolean;
      expectedHeadSha?: string;
    },
  ) => Promise<GitHubPullRequestMergeResult>;
  updateState: (ref: GitHubPullRequestRef, action: GitHubPullRequestStateAction) => Promise<void>;
  addComment: (ref: GitHubPullRequestRef, body: string) => Promise<GitHubPullRequestComment>;
  editComment: (
    ref: GitHubPullRequestRef,
    commentId: number,
    body: string,
  ) => Promise<GitHubPullRequestComment>;
  submitReview: (
    ref: GitHubPullRequestRef,
    review: { event: GitHubPullRequestReviewEvent; body: string; commitId?: string },
  ) => Promise<void>;
  addReviewComment: (
    ref: GitHubPullRequestRef,
    commitId: string,
    comment: GitHubPullRequestInlineCommentInput,
  ) => Promise<GitHubPullRequestReviewThreadComment>;
  replyToThread: (
    ref: GitHubPullRequestRef,
    threadId: string,
    body: string,
  ) => Promise<GitHubPullRequestReviewThreadComment>;
  setThreadResolved: (
    ref: GitHubPullRequestRef,
    threadId: string,
    resolved: boolean,
  ) => Promise<void>;
  setFileViewed: (ref: GitHubPullRequestRef, path: string, viewed: boolean) => Promise<void>;
  setReviewers: (
    ref: GitHubPullRequestRef,
    changes: { add: string[]; remove: string[] },
  ) => Promise<void>;
  setLabels: (ref: GitHubPullRequestRef, labels: string[]) => Promise<void>;
}

type SetState = (
  partial: Partial<PullRequestsState> | ((state: PullRequestsState) => Partial<PullRequestsState>),
) => void;

async function runLoad<T>(
  set: SetState,
  loadKey: string,
  fetcher: () => Promise<T>,
  apply: (state: PullRequestsState, data: T) => Partial<PullRequestsState>,
  fallback: string,
): Promise<void> {
  const requestId = nextRequest(loadKey);
  set((state) => ({ loading: withAdded(state.loading, loadKey) }));
  try {
    const data = await fetcher();
    if (requestSequence.get(loadKey) !== requestId) return;
    set((state) => ({
      ...apply(state, data),
      loading: without(state.loading, loadKey),
      errors: mapWithout(state.errors, loadKey),
      loadedAt: new Map(state.loadedAt).set(loadKey, Date.now()),
    }));
  } catch (error) {
    if (requestSequence.get(loadKey) !== requestId) return;
    set((state) => ({
      loading: without(state.loading, loadKey),
      errors: new Map(state.errors).set(loadKey, errorMessage(error, fallback)),
    }));
  }
}

async function runMutation<T>(
  set: SetState,
  get: () => PullRequestsState,
  mutationKey: string,
  action: () => Promise<T>,
): Promise<T> {
  if (get().mutations.has(mutationKey)) {
    throw new Error("This change is already in progress.");
  }
  set((state) => ({ mutations: withAdded(state.mutations, mutationKey) }));
  try {
    return await action();
  } finally {
    set((state) => ({ mutations: without(state.mutations, mutationKey) }));
  }
}

function patchDetail(
  state: PullRequestsState,
  key: string,
  patch: (detail: GitHubPullRequestDetail) => GitHubPullRequestDetail,
): Partial<PullRequestsState> {
  const detail = state.details.get(key);
  if (!detail) return {};
  return { details: new Map(state.details).set(key, patch(detail)) };
}

function patchFiles(
  state: PullRequestsState,
  key: string,
  patch: (files: GitHubPullRequestFiles) => GitHubPullRequestFiles,
): Partial<PullRequestsState> {
  const files = state.files.get(key);
  if (!files) return {};
  return { files: new Map(state.files).set(key, patch(files)) };
}

export const usePullRequestsStore = create<PullRequestsState>()((set, get) => {
  const reloadDetail = (ref: GitHubPullRequestRef) => get().loadDetail(ref);
  const reloadTimelineIfLoaded = (ref: GitHubPullRequestRef) =>
    get().timelines.has(gitHubPullRequestKey(ref)) ? get().loadTimeline(ref) : Promise.resolve();
  const reloadFilesIfLoaded = (ref: GitHubPullRequestRef) =>
    get().files.has(gitHubPullRequestKey(ref)) ? get().loadFiles(ref) : Promise.resolve();

  return {
    details: new Map(),
    timelines: new Map(),
    files: new Map(),
    lists: new Map(),
    loading: new Set(),
    errors: new Map(),
    loadedAt: new Map(),
    mutations: new Set(),

    loadDetail: (ref) => {
      const key = gitHubPullRequestKey(ref);
      return runLoad(
        set,
        resourceKey("detail", key),
        () => getGitHubPullRequest(ref),
        (state, detail) => ({
          details: setCapped(state.details, key, detail, MAX_CACHED_PULL_REQUESTS),
        }),
        "Could not load this pull request.",
      );
    },

    loadTimeline: (ref) => {
      const key = gitHubPullRequestKey(ref);
      return runLoad(
        set,
        resourceKey("timeline", key),
        () => getGitHubPullRequestTimeline(ref),
        (state, timeline) => ({
          timelines: setCapped(state.timelines, key, timeline, MAX_CACHED_PULL_REQUESTS),
        }),
        "Could not load the pull request timeline.",
      );
    },

    loadFiles: (ref) => {
      const key = gitHubPullRequestKey(ref);
      return runLoad(
        set,
        resourceKey("files", key),
        () => getGitHubPullRequestFiles(ref),
        (state, files) => ({
          files: setCapped(state.files, key, files, MAX_CACHED_PULL_REQUESTS),
        }),
        "Could not load the changed files.",
      );
    },

    loadList: (projectId, filter, query = "") => {
      const key = pullRequestListKey(projectId, filter, query);
      return runLoad(
        set,
        resourceKey("list", key),
        () => listGitHubPullRequests(projectId, filter, query),
        (state, list) => ({
          lists: setCapped(state.lists, key, list, MAX_CACHED_PULL_REQUEST_LISTS),
        }),
        "Could not load pull requests.",
      );
    },

    refreshAll: async (ref) => {
      await Promise.all([reloadDetail(ref), reloadTimelineIfLoaded(ref), reloadFilesIfLoaded(ref)]);
    },

    merge: (ref, options) =>
      runMutation(set, get, `merge:${gitHubPullRequestKey(ref)}`, async () => {
        const result = await mergeGitHubPullRequest(ref, options);
        void Promise.all([reloadDetail(ref), reloadTimelineIfLoaded(ref)]);
        return result;
      }),

    updateState: (ref, action) =>
      runMutation(set, get, `state:${gitHubPullRequestKey(ref)}`, async () => {
        const detail = await updateGitHubPullRequestState(ref, action);
        const key = gitHubPullRequestKey(ref);
        // Invalidate overlapping reads so a stale poll cannot overwrite this.
        nextRequest(resourceKey("detail", key));
        set((state) => ({
          details: setCapped(state.details, key, detail, MAX_CACHED_PULL_REQUESTS),
          loading: without(state.loading, resourceKey("detail", key)),
        }));
        void reloadTimelineIfLoaded(ref);
      }),

    addComment: (ref, body) =>
      runMutation(set, get, `comment-add:${gitHubPullRequestKey(ref)}`, async () => {
        const comment = await addGitHubPullRequestComment(ref, body);
        const key = gitHubPullRequestKey(ref);
        set((state) =>
          patchDetail(state, key, (detail) =>
            detail.comments.some((candidate) => candidate.id === comment.id)
              ? detail
              : {
                  ...detail,
                  comments: [...detail.comments, comment],
                  commentsCount: detail.commentsCount + 1,
                },
          ),
        );
        void Promise.all([reloadDetail(ref), reloadTimelineIfLoaded(ref)]);
        return comment;
      }),

    editComment: (ref, commentId, body) =>
      runMutation(set, get, `comment-edit:${gitHubPullRequestKey(ref)}:${commentId}`, async () => {
        const comment = await updateGitHubPullRequestComment(ref, commentId, body);
        const key = gitHubPullRequestKey(ref);
        set((state) =>
          patchDetail(state, key, (detail) => ({
            ...detail,
            comments: detail.comments.map((candidate) =>
              candidate.id === comment.id ? comment : candidate,
            ),
          })),
        );
        void Promise.all([reloadDetail(ref), reloadTimelineIfLoaded(ref)]);
        return comment;
      }),

    submitReview: (ref, review) =>
      runMutation(set, get, `review:${gitHubPullRequestKey(ref)}`, async () => {
        await submitGitHubPullRequestReview(ref, review);
        void get().refreshAll(ref);
      }),

    addReviewComment: (ref, commitId, comment) =>
      runMutation(
        set,
        get,
        `review-comment:${gitHubPullRequestKey(ref)}:${comment.side}:${comment.path}:${comment.line}`,
        async () => {
          const created = await addGitHubPullRequestReviewComment(ref, commitId, comment);
          void Promise.all([get().loadFiles(ref), reloadTimelineIfLoaded(ref)]);
          return created;
        },
      ),

    replyToThread: (ref, threadId, body) =>
      runMutation(set, get, `thread-reply:${gitHubPullRequestKey(ref)}:${threadId}`, async () => {
        const created = await replyGitHubPullRequestReviewThread(ref, threadId, body);
        const key = gitHubPullRequestKey(ref);
        set((state) =>
          patchFiles(state, key, (files) => ({
            ...files,
            threads: files.threads.map((thread) =>
              thread.id === threadId && !thread.comments.some((c) => c.id === created.id)
                ? { ...thread, comments: [...thread.comments, created] }
                : thread,
            ),
          })),
        );
        void get().loadFiles(ref);
        return created;
      }),

    setThreadResolved: (ref, threadId, resolved) =>
      runMutation(set, get, `thread-resolve:${gitHubPullRequestKey(ref)}:${threadId}`, async () => {
        const key = gitHubPullRequestKey(ref);
        const apply = (isResolved: boolean) =>
          set((state) =>
            patchFiles(state, key, (files) => ({
              ...files,
              threads: files.threads.map((thread) =>
                thread.id === threadId ? { ...thread, isResolved } : thread,
              ),
            })),
          );
        apply(resolved);
        try {
          const result = await setGitHubPullRequestThreadResolved(ref, threadId, resolved);
          apply(result.isResolved);
        } catch (error) {
          apply(!resolved);
          throw error;
        }
        void get().loadFiles(ref);
      }),

    setFileViewed: (ref, path, viewed) =>
      runMutation(set, get, `viewed:${gitHubPullRequestKey(ref)}:${path}`, async () => {
        const key = gitHubPullRequestKey(ref);
        const previous = get()
          .files.get(key)
          ?.files.find((file) => file.path === path)?.viewedState;
        const apply = (viewedState: GitHubPullRequestFiles["files"][number]["viewedState"]) =>
          set((state) =>
            patchFiles(state, key, (files) => ({
              ...files,
              files: files.files.map((file) =>
                file.path === path ? { ...file, viewedState } : file,
              ),
            })),
          );
        // Optimistic; the backend's answer is authoritative, so no file re-fetch.
        apply(viewed ? "viewed" : "unviewed");
        try {
          const result = await setGitHubPullRequestFileViewed(ref, path, viewed);
          apply(result.viewedState);
        } catch (error) {
          apply(previous ?? (viewed ? "unviewed" : "viewed"));
          throw error;
        }
      }),

    setReviewers: (ref, changes) =>
      runMutation(set, get, `reviewers:${gitHubPullRequestKey(ref)}`, async () => {
        const detail = await setGitHubPullRequestReviewers(ref, changes);
        const key = gitHubPullRequestKey(ref);
        nextRequest(resourceKey("detail", key));
        set((state) => ({
          details: setCapped(state.details, key, detail, MAX_CACHED_PULL_REQUESTS),
          loading: without(state.loading, resourceKey("detail", key)),
        }));
        void reloadTimelineIfLoaded(ref);
      }),

    setLabels: (ref, labels) =>
      runMutation(set, get, `labels:${gitHubPullRequestKey(ref)}`, async () => {
        const next = await setGitHubPullRequestLabels(ref, labels);
        const key = gitHubPullRequestKey(ref);
        set((state) => patchDetail(state, key, (detail) => ({ ...detail, labels: next })));
        void Promise.all([reloadDetail(ref), reloadTimelineIfLoaded(ref)]);
      }),
  };
});

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Runs `tick` every `intervalMs` while the document is visible. A tick that
 * falls due while hidden is deferred until the document becomes visible again.
 * Uses a re-armed timeout (not an interval) so a slow tick never stacks.
 */
export function startVisiblePolling(intervalMs: number, tick: () => void): () => void {
  let stopped = false;
  let lastRun = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer = setTimeout(run, intervalMs);
  };
  const run = () => {
    if (stopped) return;
    if (documentVisible()) {
      lastRun = Date.now();
      tick();
    }
    arm();
  };
  const onVisibilityChange = () => {
    if (stopped || !documentVisible() || Date.now() - lastRun < intervalMs) return;
    lastRun = Date.now();
    tick();
    if (timer !== undefined) clearTimeout(timer);
    arm();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  arm();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/** Polls the detail of one pull request. Returns the stop function. */
export function startPullRequestDetailPolling(ref: GitHubPullRequestRef): () => void {
  return startVisiblePolling(PULL_REQUEST_DETAIL_POLL_MS, () => {
    void usePullRequestsStore.getState().loadDetail(ref);
  });
}

/** Polls one list query. Returns the stop function. */
export function startPullRequestListPolling(
  projectId: string,
  filter: GitHubPullRequestListFilter,
  query = "",
): () => void {
  return startVisiblePolling(PULL_REQUEST_LIST_POLL_MS, () => {
    void usePullRequestsStore.getState().loadList(projectId, filter, query);
  });
}
