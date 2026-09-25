import { useEffect, useMemo, useRef } from "react";
import type { WebAnnotationSummary } from "@orkestrator/protocol/web-annotations";
import {
  NO_WEB_ANNOTATION_FEATURES,
  webAnnotationFeatures,
  type WebAnnotationFeatureFlags,
} from "@/lib/web-annotations/client";
import {
  acquireWebAnnotationSync,
  registerWebAnnotationList,
  registerWebAnnotationThread,
} from "@/lib/web-annotations/sync";
import {
  EMPTY_WEB_ANNOTATION_CACHE,
  listQueryKey,
  useWebAnnotationStore,
  type ListQuery,
  type ListState,
  type ThreadState,
  type WebAnnotationEnvironmentCache,
} from "@/stores/webAnnotationStore";

/** The environment's cache (a stable empty snapshot until the first fetch). */
export function useWebAnnotationCache(environmentId: string | null): WebAnnotationEnvironmentCache {
  return useWebAnnotationStore((state) =>
    environmentId
      ? (state.environments.get(environmentId) ?? EMPTY_WEB_ANNOTATION_CACHE)
      : EMPTY_WEB_ANNOTATION_CACHE,
  );
}

/**
 * Observe an environment's annotations while mounted. Visible observers poll
 * the change cursor; hidden ones keep their subscription but stop polling.
 */
export function useWebAnnotationSync(environmentId: string | null, visible: boolean) {
  const handleRef = useRef<ReturnType<typeof acquireWebAnnotationSync> | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    if (!environmentId) return;
    const handle = acquireWebAnnotationSync(environmentId, { visible: visibleRef.current });
    handleRef.current = handle;
    return () => {
      handleRef.current = null;
      handle.release();
    };
  }, [environmentId]);
  useEffect(() => {
    handleRef.current?.setVisible(visible);
  }, [environmentId, visible]);
}

export interface ListView {
  key: string;
  state: ListState | null;
  items: WebAnnotationSummary[];
}

/** Register a list query and read its current page. */
export function useWebAnnotationList(
  environmentId: string | null,
  query: ListQuery | null,
): ListView {
  const key = query ? listQueryKey(query) : "";
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (!environmentId || !queryRef.current) return;
    const registration = registerWebAnnotationList(environmentId, queryRef.current);
    return registration.release;
  }, [environmentId, key]);
  const cache = useWebAnnotationCache(environmentId);
  const state = key ? (cache.lists.get(key) ?? null) : null;
  const items = useMemo(
    () =>
      (state?.ids ?? [])
        .map((id) => cache.summaries.get(id))
        .filter((item): item is WebAnnotationSummary => Boolean(item)),
    [cache.summaries, state?.ids],
  );
  return { key, state, items };
}

/** Keep a thread snapshot fresh while it is open. */
export function useWebAnnotationThread(
  environmentId: string | null,
  annotationId: string | null,
): ThreadState | null {
  useEffect(() => {
    if (!environmentId || !annotationId) return;
    return registerWebAnnotationThread(environmentId, annotationId);
  }, [annotationId, environmentId]);
  const cache = useWebAnnotationCache(environmentId);
  return annotationId ? (cache.threads.get(annotationId) ?? null) : null;
}

export function useWebAnnotationFeatures(
  environmentId: string | null,
  desktopCapture: boolean,
): WebAnnotationFeatureFlags {
  const cache = useWebAnnotationCache(environmentId);
  return useMemo(
    () =>
      cache.capabilityStatus === "available"
        ? webAnnotationFeatures(cache.capabilities, desktopCapture)
        : NO_WEB_ANNOTATION_FEATURES,
    [cache.capabilities, cache.capabilityStatus, desktopCapture],
  );
}
