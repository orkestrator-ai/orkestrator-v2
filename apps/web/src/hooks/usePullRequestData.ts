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
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useNodeScope } from "@/lib/node-scope/providers";
import {
  pullRequestListKey,
  pullRequestsStore,
  resourceKey,
  startPullRequestDetailPolling,
  startPullRequestListPolling,
  usePullRequestsStore,
} from "@/stores/pullRequestsStore";

/** A visible view re-reads on activation unless its snapshot is this fresh. */
const ACTIVATION_FRESHNESS_MS = 15_000;

function isFresh(scope: NodeScope, loadKey: string): boolean {
  const loadedAt = scope.store(pullRequestsStore).getState().loadedAt.get(loadKey);
  return loadedAt !== undefined && Date.now() - loadedAt < ACTIVATION_FRESHNESS_MS;
}

/** The node scope this view's pull requests are read from (the nearest provider). */
function usePullRequestScope(): NodeScope {
  return useNodeScope();
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
  const scope = usePullRequestScope();

  useEffect(() => {
    if (!active) return;
    const state = scope.store(pullRequestsStore).getState();
    if (!state.loading.has(loadKey) && !isFresh(scope, loadKey)) void loadDetail(ref);
    return startPullRequestDetailPolling(ref, scope);
  }, [active, loadDetail, loadKey, ref, scope]);

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
  const scope = usePullRequestScope();

  useEffect(() => {
    if (!enabled) return;
    const state = scope.store(pullRequestsStore).getState();
    if (!state.timelines.has(key) && !state.loading.has(loadKey)) void loadTimeline(ref);
  }, [enabled, key, loadKey, loadTimeline, ref, scope]);

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
  const scope = usePullRequestScope();

  useEffect(() => {
    if (!enabled) return;
    const state = scope.store(pullRequestsStore).getState();
    if (!state.files.has(key) && !state.loading.has(loadKey)) void loadFiles(ref);
  }, [enabled, key, loadKey, loadFiles, ref, scope]);

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
  const scope = usePullRequestScope();

  useEffect(() => {
    if (!active) return;
    const state = scope.store(pullRequestsStore).getState();
    if (!state.loading.has(loadKey) && !isFresh(scope, loadKey)) {
      void loadList(projectId, filter, trimmed);
    }
    return startPullRequestListPolling(projectId, filter, trimmed, scope);
  }, [active, filter, loadKey, loadList, projectId, scope, trimmed]);

  const reload = useCallback(
    () => loadList(projectId, filter, trimmed),
    [filter, loadList, projectId, trimmed],
  );
  return { list, loading, error, reload };
}
