import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How far above the viewport the transcript's head may be and still count as
 * reached: the next page starts loading about a screen before the reader gets
 * there, so the "Load earlier messages" control is rarely seen.
 */
export const AUTO_LOAD_EARLIER_ROOT_MARGIN_PX = 800;

let automaticPagingDisabled = false;

/**
 * Turns automatic paging off for this page load. For fixtures that exercise
 * the "Load earlier messages" button itself, which automatic paging would
 * otherwise use up before the test clicks it.
 */
export function disableAutoLoadEarlier(): void {
  automaticPagingDisabled = true;
}

/** Automatic pages that may be requested from one head before paging stops. */
export const AUTO_LOAD_EARLIER_MAX_MISSES = 2;
/** Heads remembered per session; only a head the list keeps returning to matters. */
const AUTO_LOAD_EARLIER_MAX_HEADS = 64;

export interface AutoLoadEarlierInput {
  /** The conversation; a new one gets its own opening page. */
  sessionKey: string;
  isActive: boolean;
  /** The first read has settled, so the window on screen is the real one. */
  settled: boolean;
  /** The transcript offers earlier history. */
  canLoadEarlier: boolean;
  /** Id of the oldest transcript row; it changes when a page prepends rows. */
  headId: string | undefined;
  /** A page (automatic or clicked) is in flight. */
  loading: boolean;
  /** Whether an automatic page would be served cheaply (a direct cursor). */
  available: () => boolean;
  /**
   * Load one page. The caller holds the reader's place and owns `loading`;
   * `scroller` is the transcript's scroll container when the head is on screen.
   */
  load: (scroller: HTMLElement | null) => Promise<unknown>;
}

/**
 * Pages earlier history in without a click: once when a tab opens on a
 * transcript whose start is not loaded, so it opens with the live window plus
 * one history page (about 300 rows rather than 100), and again whenever the
 * reader scrolls near the top. Returns the ref for a sentinel rendered at the
 * transcript's head.
 *
 * A page can come back with nothing new: a poll that lands while it is in
 * flight supersedes it, or it fails. One retry covers the first; after a
 * second page from the same head automatic paging stops until the head changes
 * some other way (a clicked page), and the button stays for that case.
 *
 * Pages from a head count for as long as the session lasts, even if the head
 * moved in between. A transcript that keeps collapsing back to its live tail
 * returns to the same head each time, and restarting the count there would
 * load the page and lose it again, forever, in front of the reader.
 */
export function useAutoLoadEarlier({
  sessionKey,
  isActive,
  settled,
  canLoadEarlier,
  headId,
  loading,
  available,
  load,
}: AutoLoadEarlierInput): (element: HTMLElement | null) => void {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const [headInView, setHeadInView] = useState(false);
  /** The head the session opened at: the opening page is owed until it moves. */
  const openedAtRef = useRef<{ sessionKey: string; headId: string | undefined } | null>(null);
  const inFlightRef = useRef(false);
  const lifecycleRef = useRef<object | null>(null);
  // A completion from a hidden, replaced or unmounted view cannot settle a
  // request started by its successor, even if it has the same head id.
  useEffect(() => {
    const lifecycle = {};
    lifecycleRef.current = lifecycle;
    inFlightRef.current = false;
    return () => {
      lifecycleRef.current = null;
    };
  }, [sessionKey, isActive]);
  /** Where automatic pages were requested from, once they settled. */
  const [finished, setFinished] = useState<{
    sessionKey: string;
    /** Settled pages requested from each head, least recent first. */
    pagesByHead: ReadonlyMap<string | undefined, number>;
  } | null>(null);
  const stalled =
    !loading &&
    finished?.sessionKey === sessionKey &&
    (finished.pagesByHead.get(headId) ?? 0) >= AUTO_LOAD_EARLIER_MAX_MISSES;

  useEffect(() => {
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const root = sentinel.closest<HTMLElement>("[data-virtuoso-scroller]");
    const observer = new IntersectionObserver(
      // One batch can hold several crossings of the one target (the list
      // mounts at its top, then jumps to the latest row): the last is current.
      (entries) => setHeadInView(entries.at(-1)?.isIntersecting === true),
      { root, rootMargin: `${AUTO_LOAD_EARLIER_ROOT_MARGIN_PX}px 0px 0px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel]);

  useEffect(() => {
    if (automaticPagingDisabled || !isActive || !settled || loading || inFlightRef.current) {
      return;
    }
    if (openedAtRef.current?.sessionKey !== sessionKey)
      openedAtRef.current = { sessionKey, headId };
    const opening = openedAtRef.current.headId === headId;
    if (!canLoadEarlier || stalled || !(opening || (sentinel && headInView)) || !available()) {
      return;
    }
    inFlightRef.current = true;
    const lifecycle = lifecycleRef.current;
    const finish = () => {
      if (lifecycleRef.current !== lifecycle) return;
      inFlightRef.current = false;
      setFinished((previous) => {
        const pagesByHead = new Map(
          previous?.sessionKey === sessionKey ? previous.pagesByHead : undefined,
        );
        const pages = (pagesByHead.get(headId) ?? 0) + 1;
        pagesByHead.delete(headId);
        pagesByHead.set(headId, pages);
        if (pagesByHead.size > AUTO_LOAD_EARLIER_MAX_HEADS) {
          pagesByHead.delete(pagesByHead.keys().next().value);
        }
        return { sessionKey, pagesByHead };
      });
    };
    // A failure needs no report here: the button is still there to retry by hand.
    void load(sentinel?.closest<HTMLElement>("[data-virtuoso-scroller]") ?? null).then(
      finish,
      finish,
    );
  }, [
    available,
    canLoadEarlier,
    // A settled page re-runs this even when nothing else changed, to retry.
    finished,
    headId,
    headInView,
    isActive,
    load,
    loading,
    sentinel,
    sessionKey,
    settled,
    stalled,
  ]);

  return useCallback((element: HTMLElement | null) => setSentinel(element), []);
}
