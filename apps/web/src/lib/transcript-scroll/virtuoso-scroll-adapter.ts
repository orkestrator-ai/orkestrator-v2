import type { RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";

/**
 * Scrolls past the last data item into the footer; the browser clamps it to
 * `scrollHeight - clientHeight`.
 */
const SCROLL_TO_ABSOLUTE_BOTTOM = 10_000_000;

/** The imperative surface the controller needs from the virtualizer. */
export type TranscriptVirtualizerHandle = Pick<VirtuosoHandle, "scrollToIndex" | "scrollTo"> &
  Partial<Pick<VirtuosoHandle, "cancelPendingNavigation">>;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  maxScrollTop: number;
  /** Distance from the true end, footer included; never negative. */
  distanceFromEnd: number;
}

export function readScrollMetrics(scroller: HTMLElement): ScrollMetrics {
  const scrollTop = scroller.scrollTop;
  const scrollHeight = scroller.scrollHeight;
  const clientHeight = scroller.clientHeight;
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    maxScrollTop,
    distanceFromEnd: Math.max(0, maxScrollTop - scrollTop),
  };
}

/**
 * The only code that touches the raw Virtuoso handle and writes the scroller.
 *
 * Index navigation takes Virtuoso's *local* data index (pinned 4.18.19:
 * `scrollToIndex` does not add `firstItemIndex`, unlike the indices it passes
 * to `itemContent`, `computeItemKey` and `rangeChanged`).
 *
 * `cancelPendingNavigation` comes from `patches/react-virtuoso@4.18.19.patch`:
 * it retires the library's list-refresh retry window, smooth-target listener
 * and cleanup timer, and its queued automatic-follow work, all synchronously.
 * Bumping an application generation alone cannot stop those.
 */
export class VirtuosoScrollAdapter {
  /** Positioning writes issued (handle commands and direct scroller writes). */
  writes = 0;
  /** Library cancellations issued. */
  cancellations = 0;
  /** Last scrollTop this adapter wrote, to tell its own scroll events apart. */
  lastWrittenTop: number | null = null;

  constructor(
    private readonly handleRef: RefObject<TranscriptVirtualizerHandle | null>,
    private readonly scroller: () => HTMLElement | null,
  ) {}

  private handle(): TranscriptVirtualizerHandle | null {
    const handle = this.handleRef.current;
    if (!handle || typeof handle.scrollToIndex !== "function") return null;
    if (typeof handle.scrollTo !== "function") return null;
    return handle;
  }

  get ready(): boolean {
    return this.handle() !== null;
  }

  /** Index navigation through the virtualizer, for a target it has not rendered. */
  scrollToIndex(location: {
    index: number | "LAST";
    align: "start" | "center" | "end";
    offset?: number;
  }): boolean {
    const handle = this.handle();
    if (!handle) return false;
    this.writes += 1;
    // Index navigation is always instant (Virtuoso's default); it corrects
    // estimates, and smoothing each correction would read as jitter.
    handle.scrollToIndex({
      index: location.index,
      align: location.align,
      ...(location.index === "LAST" ? {} : { behavior: "auto" as const }),
      ...(location.offset !== undefined && location.offset !== 0
        ? { offset: location.offset }
        : {}),
    });
    return true;
  }

  /** Scroll into the footer through the handle (used for a smooth journey). */
  scrollToEnd(behavior: "auto" | "smooth"): boolean {
    const handle = this.handle();
    if (!handle) return false;
    this.writes += 1;
    handle.scrollTo({ top: SCROLL_TO_ABSOLUTE_BOTTOM, behavior });
    return true;
  }

  /** One instant write to the scroller; bypasses any inherited smooth-scroll CSS. */
  writeScrollTop(top: number): boolean {
    const scroller = this.scroller();
    if (!scroller) return false;
    this.writes += 1;
    this.lastWrittenTop = top;
    if (inheritsSmoothScrolling(scroller)) scroller.scrollTo({ top, behavior: "instant" });
    else scroller.scrollTop = top;
    return true;
  }

  /** Retire the virtualizer's own pending positioning work. */
  cancelPendingNavigation(): void {
    const handle = this.handleRef.current;
    if (!handle || typeof handle.cancelPendingNavigation !== "function") return;
    this.cancellations += 1;
    handle.cancelPendingNavigation();
  }

  /**
   * Stop a native smooth scroll in flight with a same-position instant write.
   * This is the one write a cancellation is allowed; the retired operation
   * writes nothing afterwards.
   */
  stopMotion(): void {
    const scroller = this.scroller();
    if (!scroller) return;
    this.writeScrollTop(scroller.scrollTop);
  }
}

const smoothScrolling = new WeakMap<HTMLElement, boolean>();

/**
 * A `scrollTop` assignment animates under `scroll-behavior: smooth`; an
 * explicit instant `scrollTo` does not. Read once per scroller.
 */
function inheritsSmoothScrolling(scroller: HTMLElement): boolean {
  let smooth = smoothScrolling.get(scroller);
  if (smooth === undefined) {
    smooth =
      typeof scroller.scrollTo === "function" &&
      getComputedStyle(scroller).scrollBehavior === "smooth";
    smoothScrolling.set(scroller, smooth);
  }
  return smooth;
}
