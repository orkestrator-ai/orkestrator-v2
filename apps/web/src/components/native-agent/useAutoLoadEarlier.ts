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

/** Automatic pages that may leave the head unchanged before paging stops. */
export const AUTO_LOAD_EARLIER_MAX_MISSES = 2;

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
 * second miss at the same head automatic paging stops until the head changes
 * some other way (a clicked page), and the button stays for that case.
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
  /** Where the last automatic pages were requested from, once they settled. */
  const [finished, setFinished] = useState<{
    sessionKey: string;
    headId: string | undefined;
    /** Settled pages requested from this same head. */
    count: number;
  } | null>(null);
  // Settled pages that left the head where it was brought nothing (or failed).
  const stalled =
    !loading &&
    finished?.sessionKey === sessionKey &&
    finished.headId === headId &&
    finished.count >= AUTO_LOAD_EARLIER_MAX_MISSES;

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
    const requested = { sessionKey, headId };
    const finish = () => {
      inFlightRef.current = false;
      setFinished((previous) => ({
        ...requested,
        count:
          previous?.sessionKey === requested.sessionKey && previous.headId === requested.headId
            ? previous.count + 1
            : 1,
      }));
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
