import { useEffect, useState, useCallback, useRef } from "react";
import type { VirtuosoHandle, StateSnapshot } from "react-virtuoso";
import { useUIStore } from "@/stores/uiStore";

/** Pixels from bottom to consider "at bottom" */
const AT_BOTTOM_THRESHOLD = 50;

/** Maximum persisted scroll states to retain (LRU eviction) */
const MAX_PERSISTED_STATES = 200;

/**
 * Large value used with scrollTo({ top }) to scroll past the last data item
 * into the footer. The browser clamps this to scrollHeight - clientHeight.
 */
const SCROLL_TO_ABSOLUTE_BOTTOM = 10_000_000;

/** Maximum scrollToIndex retries when correcting estimated virtual heights */
const SCROLL_TO_BOTTOM_MAX_ATTEMPTS = 10;

/** Delay between retry attempts; ~one frame, gives Virtuoso time to fire atBottomStateChange */
const SCROLL_TO_BOTTOM_RETRY_INTERVAL_MS = 16;

/**
 * After landing at the bottom we keep watching scrollHeight for a short window
 * to catch late-rendering footer content (async-measured cards, images) and
 * re-issue the smooth scroll so it stays in view.
 */
const POST_SCROLL_WATCH_MS = 400;

interface PersistedEntry {
  snapshot: StateSnapshot;
  wantsStick: boolean;
}

const persistedStates = new Map<string, PersistedEntry>();

function setPersistedState(key: string, entry: PersistedEntry) {
  persistedStates.delete(key);
  persistedStates.set(key, entry);

  if (persistedStates.size > MAX_PERSISTED_STATES) {
    const oldestKey = persistedStates.keys().next().value;
    if (oldestKey) {
      persistedStates.delete(oldestKey);
    }
  }
}

export function clearPersistedVirtuosoState(persistKey: string) {
  persistedStates.delete(persistKey);
}

interface UseVirtuosoScrollStateOptions {
  /** Whether the host view is currently active/visible */
  isActive?: boolean;
  /** Optional persistence key for retaining scroll state across tab switches */
  persistKey?: string;
  /**
   * Environment this view belongs to. When provided, the hook watches the
   * globally selected environment while the view is inactive; if it changed
   * (i.e. the user switched environments), the next activation jumps to the
   * absolute bottom regardless of prior scroll position. Within-environment
   * tab switches are unaffected and keep the user's scroll position.
   */
  environmentId?: string;
}

interface UseVirtuosoScrollStateReturn {
  /** Whether the user is currently at the bottom of the scroll area */
  isAtBottom: boolean;
  /** Ref that tracks at-bottom state without triggering re-renders (for use in effects) */
  isAtBottomRef: React.RefObject<boolean>;
  /** Scroll to bottom and re-enable stick mode */
  scrollToBottom: () => void;
  /** Ref to attach to the Virtuoso component */
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  /** Props to spread onto the Virtuoso component */
  scrollProps: {
    followOutput: (isAtBottom: boolean) => "smooth" | false;
    atBottomStateChange: (atBottom: boolean) => void;
    atBottomThreshold: number;
    totalListHeightChanged: (height: number) => void;
    restoreStateFrom: StateSnapshot | undefined;
    scrollerRef: (el: HTMLElement | Window | null) => void;
  };
}

/**
 * Hook to manage scroll state for a react-virtuoso Virtuoso component.
 *
 * Provides:
 * - Auto-follow when user is sticky to bottom (via followOutput + ResizeObserver)
 * - Intent-based "stick" that survives transient content growth (new footer
 *   content pushing the viewport off-bottom doesn't disengage stick — only
 *   a user-initiated scroll up does)
 * - "At bottom" state tracking for UI affordances (via atBottomStateChange)
 * - Scroll position persistence across tab switches; if the user was sticky
 *   when leaving, returning snaps them to the new bottom instead of the old
 *   scroll position
 * - Environment-switch handling (when environmentId is provided): returning
 *   to a view after the selected environment changed always jumps to the
 *   absolute bottom, even if the user had scrolled up before leaving
 * - Smooth animated scroll-to-bottom that keeps pace with late-rendering
 *   footer content (thinking indicator, question/approval cards)
 */
export function useVirtuosoScrollState(
  options: UseVirtuosoScrollStateOptions = {}
): UseVirtuosoScrollStateReturn {
  const { isActive = true, persistKey, environmentId } = options;

  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  // Resolve persisted state once on mount.
  const [persisted] = useState<PersistedEntry | undefined>(() =>
    persistKey ? persistedStates.get(persistKey) : undefined
  );

  /**
   * Intent: the user wants new content to auto-scroll into view. Only
   * flipped false by a user-initiated scroll up (wheel/touch/keyboard);
   * content growth that pushes the viewport off-bottom leaves it true.
   *
   * Lazy-init from persisted state so we seed exactly once. A render-time
   * conditional write would re-clear the ref on every rerender after the
   * user reaches bottom (atBottomStateChange sets true → rerender → render
   * sees persisted.wantsStick=false → clears again).
   */
  const wantsStickRef = useRef<boolean>(persisted?.wantsStick ?? true);
  const lastScrollTopRef = useRef(0);
  const mountedRef = useRef(true);
  const scrollInFlightRef = useRef(false);
  const hasBeenActiveRef = useRef(false);
  const envChangedWhileInactiveRef = useRef(false);

  // While inactive, watch the globally selected environment. If it ever
  // differs from this view's environment, the user switched environments —
  // flag it so the next activation jumps to the absolute bottom. A
  // within-environment tab switch never trips this (the selected environment
  // stays equal to ours for the whole inactive period).
  useEffect(() => {
    if (isActive || !environmentId) return;
    const check = (selectedId: string | null) => {
      if (selectedId !== environmentId) {
        envChangedWhileInactiveRef.current = true;
      }
    };
    // The deactivation itself may have been caused by an environment switch
    // that already happened — check the current value, then watch for more.
    check(useUIStore.getState().selectedEnvironmentId);
    return useUIStore.subscribe((state) => check(state.selectedEnvironmentId));
  }, [isActive, environmentId]);

  // Always restore the snapshot when one exists. For sticky users this lands
  // them at their previous bottom (avoiding a flash from the top), then the
  // activation effect nudges to the *new* bottom if content grew while away.
  const restoreStateFrom = persisted?.snapshot;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Persist state when tab becomes inactive.
  useEffect(() => {
    if (isActive || !persistKey) return;

    virtuosoRef.current?.getState((snapshot) => {
      setPersistedState(persistKey, {
        snapshot,
        wantsStick: wantsStickRef.current,
      });
    });
  }, [isActive, persistKey]);

  const atBottomStateChange = useCallback((atBottom: boolean) => {
    setIsAtBottom(atBottom);
    isAtBottomRef.current = atBottom;
    // Reaching bottom re-engages stick intent. We intentionally do NOT flip
    // intent false when atBottom becomes false — that transition is usually
    // caused by content growing below the viewport, not by user action.
    if (atBottom) {
      wantsStickRef.current = true;
    }
  }, []);

  const followOutput = useCallback(
    (atBottom: boolean): "smooth" | false => {
      return atBottom || wantsStickRef.current ? "smooth" : false;
    },
    []
  );

  const scrollerRef = useCallback((el: HTMLElement | Window | null) => {
    const next = el instanceof HTMLElement ? el : null;
    scrollerElRef.current = next;
    setScrollerEl(next);
  }, []);

  // Core retry loop, shared by the public scrollToBottom (smooth) and the
  // activation jump (instant — animating on every env/tab switch reads as
  // jank). `behavior` only affects the final footer scroll; the scrollToIndex
  // retries are always instant since they correct virtual-height estimates.
  const performScrollToBottom = useCallback((behavior: "smooth" | "auto") => {
    const handle = virtuosoRef.current;
    if (!handle) return;
    if (
      typeof handle.scrollToIndex !== "function" ||
      typeof handle.scrollTo !== "function"
    ) {
      return;
    }
    // Clicking the scroll-down button (or any programmatic call) is an
    // explicit stick signal.
    wantsStickRef.current = true;
    // Guard against overlapping invocations — a second call while the
    // retry loop is still mid-flight would fire a duplicate footer scroll.
    if (scrollInFlightRef.current) return;
    scrollInFlightRef.current = true;

    let attempts = 0;

    const watchScrollHeight = () => {
      const el = scrollerElRef.current;
      if (!el || !mountedRef.current) {
        scrollInFlightRef.current = false;
        return;
      }
      const start = performance.now();
      let lastScrollHeight = el.scrollHeight;
      const tick = () => {
        if (!mountedRef.current) {
          scrollInFlightRef.current = false;
          return;
        }
        const currentHeight = el.scrollHeight;
        if (currentHeight !== lastScrollHeight) {
          lastScrollHeight = currentHeight;
          // Footer grew after we landed — re-issue the scroll so the
          // new content (thinking indicator, cards) stays in view.
          handle.scrollTo({
            top: SCROLL_TO_ABSOLUTE_BOTTOM,
            behavior,
          });
        }
        if (performance.now() - start < POST_SCROLL_WATCH_MS) {
          requestAnimationFrame(tick);
        } else {
          scrollInFlightRef.current = false;
        }
      };
      requestAnimationFrame(tick);
    };

    const finish = () => {
      // Scroll past the last data item to reveal footer content.
      // The browser clamps to scrollHeight - clientHeight.
      handle.scrollTo({
        top: SCROLL_TO_ABSOLUTE_BOTTOM,
        behavior,
      });
      watchScrollHeight();
    };

    const attempt = () => {
      if (!mountedRef.current) {
        scrollInFlightRef.current = false;
        return;
      }
      attempts += 1;

      // Instant (not smooth) on retries — we're correcting virtual-height
      // estimates; smoothing each retry would look jittery. The final
      // scrollTo in finish() moves into the footer with `behavior`.
      handle.scrollToIndex({
        index: "LAST",
        align: "end",
      });

      // setTimeout (rather than rAF) gives Virtuoso time to fire
      // atBottomStateChange after rendering/measuring the tail items.
      setTimeout(() => {
        if (!mountedRef.current) {
          scrollInFlightRef.current = false;
          return;
        }
        if (
          !isAtBottomRef.current &&
          attempts < SCROLL_TO_BOTTOM_MAX_ATTEMPTS
        ) {
          attempt();
          return;
        }
        finish();
      }, SCROLL_TO_BOTTOM_RETRY_INTERVAL_MS);
    };

    attempt();
    // Deps intentionally empty: reads only refs (virtuosoRef, scrollerElRef,
    // mountedRef, scrollInFlightRef, isAtBottomRef, wantsStickRef). Adding
    // scrollerEl here would recreate the callback whenever the scroller
    // mounts, which in turn would retrigger the ResizeObserver effect and
    // reobserve from scratch on each mount.
  }, []);

  const scrollToBottom = useCallback(
    () => performScrollToBottom("smooth"),
    [performScrollToBottom]
  );

  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  const totalListHeightChanged = useCallback(
    (_height: number) => {
      if (!isActiveRef.current) return;
      if (wantsStickRef.current && !scrollInFlightRef.current) {
        scrollToBottom();
      }
    },
    [scrollToBottom]
  );

  // User-scroll-up detection: only a user action can release stick intent.
  // Virtuoso's own programmatic scrolls (followOutput, scrollToIndex) do not
  // fire wheel/touch/keydown events, so this cleanly separates the two.
  useEffect(() => {
    if (!scrollerEl) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) wantsStickRef.current = false;
    };
    const handleTouchStart = () => {
      lastScrollTopRef.current = scrollerEl.scrollTop;
    };
    const handleTouchMove = () => {
      const st = scrollerEl.scrollTop;
      if (st < lastScrollTopRef.current - 2) {
        wantsStickRef.current = false;
      }
      lastScrollTopRef.current = st;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") {
        wantsStickRef.current = false;
      }
    };

    scrollerEl.addEventListener("wheel", handleWheel, { passive: true });
    scrollerEl.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    scrollerEl.addEventListener("touchmove", handleTouchMove, {
      passive: true,
    });
    scrollerEl.addEventListener("keydown", handleKeyDown);

    return () => {
      scrollerEl.removeEventListener("wheel", handleWheel);
      scrollerEl.removeEventListener("touchstart", handleTouchStart);
      scrollerEl.removeEventListener("touchmove", handleTouchMove);
      scrollerEl.removeEventListener("keydown", handleKeyDown);
    };
  }, [scrollerEl]);

  // ResizeObserver fallback: when content grows (e.g. footer gains a thinking
  // indicator or question card) and the user still wants stick, scroll to
  // the new bottom. followOutput only fires on data-item changes.
  useEffect(() => {
    if (!scrollerEl || typeof ResizeObserver === "undefined") return;

    let rafId: number | null = null;
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!isActiveRef.current) return;
        // Note: we deliberately do NOT skip when isAtBottomRef.current is true.
        // followOutput only fires on data-item changes, so footer-only growth
        // (thinking indicator, late-rendering cards) leaves Virtuoso reporting
        // atBottom=true while the new content sits below the viewport. The
        // scrollInFlightRef guard prevents stacking with an in-flight retry.
        if (wantsStickRef.current && !scrollInFlightRef.current) {
          scrollToBottom();
        }
      });
    };

    const resizeObserver = new ResizeObserver(schedule);
    const observed = new WeakSet<Element>();
    const observeChildren = () => {
      for (const child of Array.from(scrollerEl.children)) {
        if (!observed.has(child)) {
          resizeObserver.observe(child);
          observed.add(child);
        }
      }
    };
    observeChildren();

    // Watch the subtree because footer content is nested inside Virtuoso's
    // internal viewport/list wrappers, not always added as a direct child of
    // the scroller. Only re-walk direct children when a direct child was
    // actually added — deep-subtree mutations can't change the direct-child
    // set, so `observeChildren()` would be wasted work in that case.
    const mutationObserver =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver((records) => {
            const directChildAdded = records.some(
              (r) => r.target === scrollerEl && r.addedNodes.length > 0
            );
            if (directChildAdded) observeChildren();
            schedule();
          })
        : null;
    mutationObserver?.observe(scrollerEl, {
      childList: true,
      subtree: true,
    });

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
    };
  }, [scrollerEl, scrollToBottom]);

  // Tab re-activation: jump to the new bottom on return when either the user
  // was sticky when they left, or the selected environment changed while the
  // view was away (an environment switch always lands at the absolute bottom,
  // regardless of prior scroll position). The jump uses the instant retry
  // loop — animating on every env switch reads as jank, and a one-shot
  // scrollToIndex can land short while Virtuoso re-measures items that were
  // outside the rendered window. Reset scrollInFlightRef first so a stale
  // flag from a prior activation cycle (e.g. a smooth scroll interrupted by
  // switching away) can't deadlock subsequent scroll attempts.
  //
  // Skip on the very first activation: Virtuoso handles initial position
  // via restoreStateFrom. If the persisted snapshot is stale (content grew
  // while the tab was inactive), the user lands at the *old* bottom on
  // mount; totalListHeightChanged and the ResizeObserver fallback then
  // catch up to the new bottom as items measure. (followOutput alone is
  // not enough — it only fires on data-item appends *after* mount.)
  useEffect(() => {
    if (!isActive) return;
    const isFirstActivation = !hasBeenActiveRef.current;
    hasBeenActiveRef.current = true;
    const envChanged = envChangedWhileInactiveRef.current;
    envChangedWhileInactiveRef.current = false;
    if (isFirstActivation) return;
    scrollInFlightRef.current = false;
    if (!envChanged && !wantsStickRef.current) return;
    const id = requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      performScrollToBottom("auto");
    });
    return () => cancelAnimationFrame(id);
  }, [isActive, performScrollToBottom]);

  return {
    isAtBottom,
    isAtBottomRef,
    scrollToBottom,
    virtuosoRef,
    scrollProps: {
      followOutput,
      atBottomStateChange,
      atBottomThreshold: AT_BOTTOM_THRESHOLD,
      totalListHeightChanged,
      restoreStateFrom,
      scrollerRef,
    },
  };
}
