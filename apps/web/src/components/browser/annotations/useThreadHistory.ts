/**
 * Thread history with backward paging (`web_annotation_entries` with
 * `beforeSequence`).
 *
 * The synchronized snapshot carries the newest entry page. Older pages are
 * fetched on request and kept alongside every snapshot seen while the thread
 * is open, so a moving newest window never leaves a gap. The set is bounded
 * by the thread's own entry limit. Supersession is recomputed across the
 * merged set because a snapshot only marks entries inside its own window.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
  type WebAnnotationEntry,
  type WebAnnotationGetResult,
} from "@orkestrator/protocol/web-annotations";
import { describeWebAnnotationError, webAnnotationCommand } from "@/lib/web-annotations/client";

export function useThreadHistory(environmentId: string, data: WebAnnotationGetResult | null) {
  const annotationId = data?.annotation.id ?? null;
  const [known, setKnown] = useState<Map<string, WebAnnotationEntry>>(new Map());
  /** `beforeSequence` for the next older page; null when the first entry is loaded. */
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  /** Forward cursor for backends that only return the oldest window. */
  const [newerCursor, setNewerCursor] = useState<number | null>(null);
  const [pagedOlder, setPagedOlder] = useState(false);
  const [pagedNewer, setPagedNewer] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Invalidate every completion, including errors/finally, on identity changes
  // and unmount. A generation also fences a switch away and back to the same note.
  const generationRef = useRef(0);
  useLayoutEffect(() => {
    return () => {
      generationRef.current += 1;
    };
  }, [environmentId, annotationId]);

  // Each snapshot is merged while rendering; a different note starts again.
  const [historyFor, setHistoryFor] = useState({ environmentId, annotationId });
  const [mergedData, setMergedData] = useState<WebAnnotationGetResult | null>(null);
  const identityChanged =
    environmentId !== historyFor.environmentId || annotationId !== historyFor.annotationId;
  if (identityChanged || data !== mergedData) {
    if (identityChanged) {
      setHistoryFor({ environmentId, annotationId });
      setKnown(new Map());
      setOlderCursor(null);
      setNewerCursor(null);
      setPagedOlder(false);
      setPagedNewer(false);
      setLoading(false);
      setError(null);
    }
    setMergedData(data);
    if (data) {
      setKnown((current) => {
        const next = new Map(current);
        for (const entry of data.entries) next.set(entry.id, entry);
        return bound(next);
      });
      if (identityChanged || !pagedOlder) setOlderCursor(data.previousEntrySequence ?? null);
      if (identityChanged || !pagedNewer) setNewerCursor(data.nextEntrySequence);
    }
  }

  const loadPage = useCallback(
    async (direction: "older" | "newer") => {
      if (!annotationId || loading) return;
      const cursor = direction === "older" ? olderCursor : newerCursor;
      if (cursor === null) return;
      const generation = generationRef.current;
      setLoading(true);
      setError(null);
      try {
        const page = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.entries, {
          environmentId,
          annotationId,
          ...(direction === "older"
            ? { afterSequence: 0, beforeSequence: cursor }
            : { afterSequence: cursor }),
          limit: WEB_ANNOTATION_LIMITS.entryPageItems,
        });
        if (generationRef.current !== generation) return;
        if (page.resetRequired) {
          // History moved under us: start again from the current snapshot.
          setKnown(new Map((data?.entries ?? []).map((entry) => [entry.id, entry])));
          setPagedOlder(false);
          setPagedNewer(false);
          setOlderCursor(data?.previousEntrySequence ?? null);
          setNewerCursor(data?.nextEntrySequence ?? null);
          return;
        }
        setKnown((current) => {
          const next = new Map(current);
          for (const entry of page.entries) next.set(entry.id, entry);
          return bound(next);
        });
        if (direction === "older") {
          setPagedOlder(true);
          setOlderCursor(page.previousSequence ?? null);
        } else {
          setPagedNewer(true);
          setNewerCursor(page.nextSequence);
        }
      } catch (pageError) {
        if (generationRef.current === generation) setError(describeWebAnnotationError(pageError));
      } finally {
        if (generationRef.current === generation) setLoading(false);
      }
    },
    [annotationId, data, environmentId, loading, newerCursor, olderCursor],
  );

  const entries = useMemo(() => {
    const list = Array.from(known.values()).sort((a, b) => a.sequence - b.sequence);
    const superseded = new Map<string, string>();
    for (const entry of list) if (entry.supersedes) superseded.set(entry.supersedes, entry.id);
    return list.map((entry) =>
      !entry.supersededBy && superseded.has(entry.id)
        ? { ...entry, supersededBy: superseded.get(entry.id) }
        : entry,
    );
  }, [known]);

  return {
    entries,
    hasOlder: olderCursor !== null,
    hasNewer: newerCursor !== null,
    loading,
    error,
    loadOlder: () => loadPage("older"),
    loadNewer: () => loadPage("newer"),
  };
}

function bound(map: Map<string, WebAnnotationEntry>): Map<string, WebAnnotationEntry> {
  if (map.size <= WEB_ANNOTATION_LIMITS.threadEntries) return map;
  const kept = Array.from(map.values())
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, WEB_ANNOTATION_LIMITS.threadEntries);
  return new Map(kept.map((entry) => [entry.id, entry]));
}
