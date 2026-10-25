import { createContext, useLayoutEffect, useState, type RefObject } from "react";

/**
 * Live arrivals: rows (and tool calls inside a group) that a streaming update
 * appends grow in by their real layout height instead of appearing at full
 * size, so a following transcript glides up rather than jumping a row at a
 * time. Only a small append to a list already on screen counts: history
 * pages, rehydration, gap refills, renamed or replaced rows and virtualized
 * remounts all render at once.
 */

/** Most keys one update may append and still animate; more is a refill, not a stream. */
export const MAX_LIVE_ARRIVALS = 3;

/**
 * An arrival not mounted within this long of its update (the reader was
 * scrolled away, the pane hidden) renders at once when it does mount.
 */
export const LIVE_ARRIVAL_WINDOW_MS = 1000;

/** The attribute the entrance animation runs under (`index.css`). */
export const LIVE_ARRIVAL_ATTRIBUTE = "data-transcript-arrival";

/** Whether the enclosing transcript animates live arrivals (tool calls inside a group read it). */
export const LiveArrivalsContext = createContext(false);

/** Previous keys checked in order in front of the arrivals before they are trusted. */
const VERIFIED_KEYS = 8;

/**
 * Keys `next` adds to `previous` when the change is a small append: the same
 * first key, every previous key kept in order, and at most
 * `MAX_LIVE_ARRIVALS` new keys after it (normally at the end). Anything else —
 * a prepend, a removal, a replaced streaming tail, a first fill — is empty.
 *
 * Walks from the end, so a streaming update costs a few comparisons.
 */
export function liveArrivals<T>(
  previous: readonly T[],
  next: readonly T[],
  keyAt: (list: readonly T[], index: number) => string,
): string[] {
  const added = next.length - previous.length;
  if (previous.length === 0 || added <= 0 || added > MAX_LIVE_ARRIVALS) return [];
  if (keyAt(previous, 0) !== keyAt(next, 0)) return [];
  const arrivals: string[] = [];
  let p = previous.length - 1;
  let n = next.length - 1;
  let verified = 0;
  while (n > 0 && p >= 0) {
    const key = keyAt(next, n);
    n -= 1;
    if (key === keyAt(previous, p)) {
      p -= 1;
      if (arrivals.length === added && ++verified >= VERIFIED_KEYS) break;
      continue;
    }
    // More new keys than the count grew by: a previous key was replaced.
    if (arrivals.length === added) return [];
    arrivals.push(key);
  }
  return arrivals.length === added ? arrivals : [];
}

/**
 * One update's arrivals. Stamped on first use after the commit (whichever of
 * the list or an arriving row's layout effect runs first). A key whose
 * entrance ran to the end never animates again, so a virtualized remount
 * inside the window renders at once.
 */
export interface LiveArrivalBatch {
  readonly keys: ReadonlySet<string>;
  stampedAt: number | null;
  readonly taken: Set<string>;
}

const NO_ARRIVALS: LiveArrivalBatch = Object.freeze({
  keys: new Set<string>(),
  stampedAt: 0,
  taken: new Set<string>(),
}) as LiveArrivalBatch;

function stamp(batch: LiveArrivalBatch, now: number): number {
  if (batch.stampedAt === null) batch.stampedAt = now;
  return batch.stampedAt;
}

/** Whether `key` should animate in now; consumes it. */
export function takeLiveArrival(batch: LiveArrivalBatch, key: string, now: number): boolean {
  if (!batch.keys.has(key) || batch.taken.has(key)) return false;
  if (now - stamp(batch, now) > LIVE_ARRIVAL_WINDOW_MS) return false;
  batch.taken.add(key);
  return true;
}

/**
 * The arrivals of the update this render shows, derived from the previous
 * render's list. Disabled, or on the first render, there are none.
 */
export function useLiveArrivals<T>(
  items: readonly T[],
  keyAt: (list: readonly T[], index: number) => string,
  enabled: boolean,
): LiveArrivalBatch {
  const [tracked, setTracked] = useState({ items, batch: NO_ARRIVALS });
  let batch = tracked.batch;
  if (tracked.items !== items) {
    const keys = enabled ? liveArrivals(tracked.items, items, keyAt) : [];
    batch =
      keys.length > 0 ? { keys: new Set(keys), stampedAt: null, taken: new Set() } : NO_ARRIVALS;
    // Derived from the previous render's data; React re-renders before commit.
    setTracked({ items, batch });
  }
  // Start the window at the commit even when no arriving row mounts in it.
  useLayoutEffect(() => {
    if (batch !== NO_ARRIVALS) stamp(batch, performance.now());
  }, [batch]);
  return batch;
}

function prefersReducedMotion(view: Window | null): boolean {
  return view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Grows `ref`'s element in when it mounts as one of `batch`'s arrivals. Runs
 * before paint, so the element is never drawn at full size first. Skipped
 * under reduced motion, while hidden (the animation would only start when
 * shown), and inside a parent that already scrolls (the growth would land
 * out of view).
 */
export function useLiveArrivalEntrance(
  ref: RefObject<HTMLElement | null>,
  batch: LiveArrivalBatch | null,
  key: string,
): void {
  // The batch the element mounted in: a later update must not restart or
  // cut short its entrance.
  const [mountBatch] = useState(batch);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !mountBatch || !takeLiveArrival(mountBatch, key, performance.now())) return;
    const parent = element.parentElement;
    if (
      prefersReducedMotion(element.ownerDocument.defaultView) ||
      element.getClientRects().length === 0 ||
      (parent && parent.scrollHeight > parent.clientHeight + 1)
    ) {
      return;
    }
    element.setAttribute(LIVE_ARRIVAL_ATTRIBUTE, "");
    let finished = false;
    const finish = (event: Event) => {
      if (event.target !== element) return;
      finished = true;
      element.removeAttribute(LIVE_ARRIVAL_ATTRIBUTE);
    };
    element.addEventListener("animationend", finish);
    element.addEventListener("animationcancel", finish);
    return () => {
      element.removeEventListener("animationend", finish);
      element.removeEventListener("animationcancel", finish);
      element.removeAttribute(LIVE_ARRIVAL_ATTRIBUTE);
      // An entrance cut short (a re-run effect, a remount inside the window)
      // may start again.
      if (!finished) mountBatch.taken.delete(key);
    };
  }, [ref, mountBatch, key]);
}
