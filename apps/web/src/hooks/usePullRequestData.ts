/**
 * Hooks over `usePullRequestsStore` for the in-app pull request viewer.
 *
 * Not to be confused with `usePullRequest.ts`, which mirrors the backend PR
 * monitor for an environment. These read GitHub pull requests directly.
 */
import { useCallback, useEffect, useMemo } from "react";
import {
  gitHubPullRequestKey,
  type GitHubPullRequestListFilter,
  type GitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import {
  pullRequestListKey,
  resourceKey,
  startPullRequestDetailPolling,
  startPullRequestListPolling,
  usePullRequestsStore,
} from "@/stores/pullRequestsStore";

/** A visible view re-reads on activation unless its snapshot is this fresh. */
const ACTIVATION_FRESHNESS_MS = 15_000;

function isFresh(loadKey: string): boolean {
  const loadedAt = usePullRequestsStore.getState().loadedAt.get(loadKey);
  return loadedAt !== undefined && Date.now() - loadedAt < ACTIVATION_FRESHNESS_MS;
}

/** Stable ref object keyed by value, so effects do not re-run on every render. */
export function useStablePullRequestRef(ref: GitHubPullRequestRef): GitHubPullRequestRef {
  const { owner, repo, number } = ref;
  return useMemo(() => ({ owner, repo, number }), [owner, repo, number]);
}

/**
 * The detail snapshot. While `active`, loads on activation (unless fresh) and
 * polls every 60s while the document is visible.
 */
export function usePullRequestDetail(pullRequest: GitHubPullRequestRef, active: boolean) {
  const ref = useStablePullRequestRef(pullRequest);
  const key = gitHubPullRequestKey(ref);
  const loadKey = resourceKey("detail", key);
  const detail = usePullRequestsStore((state) => state.details.get(key));
  const loading = usePullRequestsStore((state) => state.loading.has(loadKey));
  const error = usePullRequestsStore((state) => state.errors.get(loadKey));
  const loadDetail = usePullRequestsStore((state) => state.loadDetail);

  useEffect(() => {
    if (!active) return;
    const state = usePullRequestsStore.getState();
    if (!state.loading.has(loadKey) && !isFresh(loadKey)) void loadDetail(ref);
    return startPullRequestDetailPolling(ref);
  }, [active, loadDetail, loadKey, ref]);

  const reload = useCallback(() => loadDetail(ref), [loadDetail, ref]);
  return { detail, loading, error, reload };
}

/** The timeline; loads the first time `enabled` becomes true. */
export function usePullRequestTimeline(pullRequest: GitHubPullRequestRef, enabled: boolean) {
  const ref = useStablePullRequestRef(pullRequest);
  const key = gitHubPullRequestKey(ref);
  const loadKey = resourceKey("timeline", key);
  const timeline = usePullRequestsStore((state) => state.timelines.get(key));
  const loading = usePullRequestsStore((state) => state.loading.has(loadKey));
  const error = usePullRequestsStore((state) => state.errors.get(loadKey));
  const loadTimeline = usePullRequestsStore((state) => state.loadTimeline);

  useEffect(() => {
    if (!enabled) return;
    const state = usePullRequestsStore.getState();
    if (!state.timelines.has(key) && !state.loading.has(loadKey)) void loadTimeline(ref);
  }, [enabled, key, loadKey, loadTimeline, ref]);

  const reload = useCallback(() => loadTimeline(ref), [loadTimeline, ref]);
  return { timeline, loading, error, reload };
}

/** Changed files and review threads; loads the first time `enabled` becomes true. */
export function usePullRequestFiles(pullRequest: GitHubPullRequestRef, enabled: boolean) {
  const ref = useStablePullRequestRef(pullRequest);
  const key = gitHubPullRequestKey(ref);
  const loadKey = resourceKey("files", key);
  const files = usePullRequestsStore((state) => state.files.get(key));
  const loading = usePullRequestsStore((state) => state.loading.has(loadKey));
  const error = usePullRequestsStore((state) => state.errors.get(loadKey));
  const loadFiles = usePullRequestsStore((state) => state.loadFiles);

  useEffect(() => {
    if (!enabled) return;
    const state = usePullRequestsStore.getState();
    if (!state.files.has(key) && !state.loading.has(loadKey)) void loadFiles(ref);
  }, [enabled, key, loadKey, loadFiles, ref]);

  const reload = useCallback(() => loadFiles(ref), [loadFiles, ref]);
  return { files, loading, error, reload };
}

/** One list query. While `active`, loads on activation and polls every 2 min. */
export function usePullRequestList(
  projectId: string,
  filter: GitHubPullRequestListFilter,
  query: string,
  active: boolean,
) {
  const trimmed = query.trim();
  const key = pullRequestListKey(projectId, filter, trimmed);
  const loadKey = resourceKey("list", key);
  const list = usePullRequestsStore((state) => state.lists.get(key));
  const loading = usePullRequestsStore((state) => state.loading.has(loadKey));
  const error = usePullRequestsStore((state) => state.errors.get(loadKey));
  const loadList = usePullRequestsStore((state) => state.loadList);

  useEffect(() => {
    if (!active) return;
    const state = usePullRequestsStore.getState();
    if (!state.loading.has(loadKey) && !isFresh(loadKey)) {
      void loadList(projectId, filter, trimmed);
    }
    return startPullRequestListPolling(projectId, filter, trimmed);
  }, [active, filter, loadKey, loadList, projectId, trimmed]);

  const reload = useCallback(
    () => loadList(projectId, filter, trimmed),
    [filter, loadList, projectId, trimmed],
  );
  return { list, loading, error, reload };
}
