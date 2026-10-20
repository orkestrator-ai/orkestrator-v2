import { useCallback, useEffect, useRef, useState } from "react";
import {
  environmentChangeResourceKey,
  isChangeProjection,
  type ChangeFileRow,
  type ChangeProjection,
} from "@orkestrator/protocol/change-resources";
import * as backend from "@/lib/backend";
import { useEnvironmentChangeProjection } from "@/hooks/useChangeProjection";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";

/** Rows fetched past the projection's first page, all of one snapshot token. */
interface ExtraPages {
  resourceKey: string;
  snapshotToken: string;
  rows: ChangeFileRow[];
  nextCursor: string | null;
  totalRows: number | null;
}

export interface EnvironmentChangeRows {
  /** `undefined` when the backend has no projection (older backend): use the legacy list. */
  projection: ChangeProjection | undefined;
  resourceKey: string | null;
  rows: ChangeFileRow[];
  totalRows: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** The first page is being fetched (the projection arrived without one). */
  loadingFirstPage: boolean;
  loadMore: () => void;
}

/**
 * Re-reads a projection unconditionally so it arrives with its first file
 * page. Change events omit pages, so a new measurement can land without one.
 */
async function readProjectionWithPage(resourceKey: string): Promise<void> {
  const result = await backend.getChangeView(resourceKey);
  if (
    (result.kind === "projection" || result.kind === "reset") &&
    isChangeProjection(result.projection)
  ) {
    useChangeProjectionStore.getState().applyProjection(result.projection);
  } else if (result.kind === "deleted") {
    useChangeProjectionStore.getState().markDeleted(resourceKey);
  }
}

/**
 * The Files → Changes rows of an environment: the `environment-net`
 * projection's revision-pinned file pages — the same measurement the sidebar
 * badge shows. Pages are only ever joined when they share one snapshot token;
 * a `stale-cursor` answer re-reads the projection and paging restarts from its
 * first page. Freshness is event driven through the shared subscription; there
 * is no timer here.
 */
export function useEnvironmentChangeRows(
  environmentId: string | null | undefined,
): EnvironmentChangeRows {
  const projection = useEnvironmentChangeProjection(environmentId);
  const resourceKey = environmentId ? environmentChangeResourceKey(environmentId) : null;
  const [extra, setExtra] = useState<ExtraPages | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** The first-page read that last settled; a projection still without a page then shows as such. */
  const [settledPageRequest, setSettledPageRequest] = useState<string | null>(null);
  const pageRequestRef = useRef<string | null>(null);
  const loadMoreRef = useRef<string | null>(null);

  const firstPage = projection?.filePage ?? null;
  const token = firstPage?.snapshotToken ?? null;

  // A measurement without a page (delivered by an event) needs one read.
  const needsFirstPage = Boolean(resourceKey && projection?.measurementId && !firstPage);
  const pageRequestKey = needsFirstPage
    ? `${resourceKey}\0${projection!.ownerGeneration}\0${projection!.revision}`
    : null;
  useEffect(() => {
    if (!pageRequestKey || !resourceKey) return;
    if (pageRequestRef.current === pageRequestKey) return;
    pageRequestRef.current = pageRequestKey;
    void readProjectionWithPage(resourceKey)
      .catch(() => undefined)
      .finally(() => setSettledPageRequest(pageRequestKey));
  }, [pageRequestKey, resourceKey]);

  // Never stitch: pages of another token (or resource) are ignored, and the
  // next page request replaces them.
  const matched =
    extra && extra.resourceKey === resourceKey && extra.snapshotToken === token ? extra : null;

  const rows = firstPage ? (matched ? [...firstPage.rows, ...matched.rows] : firstPage.rows) : [];
  const nextCursor = firstPage ? (matched ? matched.nextCursor : firstPage.nextCursor) : null;
  const totalRows = matched ? matched.totalRows : (firstPage?.totalRows ?? null);

  const loadMore = useCallback(() => {
    if (!resourceKey || !token || !nextCursor) return;
    const requestKey = `${resourceKey}\0${token}\0${nextCursor}`;
    if (loadMoreRef.current === requestKey) return;
    loadMoreRef.current = requestKey;
    setLoadingMore(true);
    void backend
      .getChangeFiles(resourceKey, token, nextCursor)
      .then(async (result) => {
        if (result.kind === "page" && result.snapshotToken === token) {
          setExtra((current) => {
            const base =
              current && current.resourceKey === resourceKey && current.snapshotToken === token
                ? current.rows
                : [];
            return {
              resourceKey,
              snapshotToken: token,
              rows: [...base, ...result.rows],
              nextCursor: result.nextCursor,
              totalRows: result.totalRows,
            };
          });
          return;
        }
        // The measurement moved on (or the cursor is no longer valid):
        // discard what was paged and restart from the current first page.
        setExtra(null);
        await readProjectionWithPage(resourceKey);
      })
      .catch(() => undefined)
      .finally(() => {
        if (loadMoreRef.current === requestKey) loadMoreRef.current = null;
        setLoadingMore(false);
      });
  }, [resourceKey, token, nextCursor]);

  return {
    projection,
    resourceKey,
    rows,
    totalRows,
    hasMore: nextCursor !== null,
    loadingMore,
    loadingFirstPage: needsFirstPage && settledPageRequest !== pageRequestKey,
    loadMore,
  };
}
