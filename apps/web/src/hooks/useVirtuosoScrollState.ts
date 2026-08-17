import { useEffect, useState, useCallback, useRef } from "react";
import type { VirtuosoHandle, StateSnapshot } from "react-virtuoso";
import { useUIStore } from "@/stores/uiStore";

/** Pixels from bottom to consider "at bottom" */
const AT_BOTTOM_THRESHOLD = 50;

/**
 * Upward movement a raw scroll event must exceed before it counts as the user
 * pulling away from the bottom. Sub-pixel scroll positions and elastic
 * overscroll both produce tiny negative deltas that are not intent.
 */
const USER_SCROLL_UP_TOLERANCE_PX = 2;

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

/** Readiness retries for activation scrolls after the scroller has mounted */
const ACTIVATION_SCROLL_READY_MAX_ATTEMPTS = 30;

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

/**
 * Whether a persisted snapshot is safe to hand back to Virtuoso.
 *
 * `restoreStateFrom` feeds these numbers straight into Virtuoso's size and
 * offset trees, whose binary search throws from inside a render for values it
 * cannot order (negative indices, NaN, inverted ranges). A snapshot is captured
 * by `getState` and should always be well-formed, but a malformed one is not a
 * recoverable degradation: the throw reaches the view's error boundary, and
 * because this map outlives the remount, every retry replays the same crash.
 * Restoring nothing merely costs the scroll position.
 *
 * Only the ranges are checked for orderability, because only they reach that
 * binary search. `scrollTop` is validated for finiteness alone: `getState`
 * records it as `scrollTop - headerHeight`, and restore feeds it straight back
 * as `{ align: "start", index: 0, offset }` — so a view with a Virtuoso Header
 * legitimately persists a *negative* value whenever the viewport sits inside
 * that header, and rejecting the sign would forfeit the position it encodes.
 */
export function isRestorableStateSnapshot(
  snapshot: StateSnapshot | undefined,
): snapshot is StateSnapshot {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (!Number.isFinite(snapshot.scrollTop)) return false;
  if (!Array.isArray(snapshot.ranges)) return false;
  return snapshot.ranges.every((range, index, ranges) => {
    const endIndexIsValid = Number.isInteger(range?.endIndex)
      || (
        range?.endIndex === Number.POSITIVE_INFINITY
        && index === ranges.length - 1
      );
    const previous = ranges[index - 1];
    return Number.isInteger(range?.startIndex)
      && endIndexIsValid
      && Number.isFinite(range?.size)
      && range.startIndex >= 0
      && range.endIndex >= range.startIndex
      && range.size >= 0
      && (
        previous === undefined
        || range.startIndex > previous.endIndex
      );
  });
}

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
   * Force every activation to jump to the current bottom and re-enable
   * stick intent, even if the user had previously scrolled up in this view.
   */
  stickToBottomOnActivation?: boolean;
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
    followOutput: (isAtBottom: boolean) => "auto" | false;
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
 * - Jitter-free streaming follow: content growth pins the viewport to the
 *   bottom synchronously (pre-paint), so the tail of the transcript and the
 *   thinking indicator hold a fixed position while tokens arrive
 * - Smooth animated scroll-to-bottom for the *user-initiated* jump (the
 *   scroll-down button), which keeps pace with late-rendering footer content
 */
export function useVirtuosoScrollState(
  options: UseVirtuosoScrollStateOptions = {}
): UseVirtuosoScrollStateReturn {
  const {
    isActive = true,
    persistKey,
    environmentId,
    stickToBottomOnActivation = false,
  } = options;

  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  // Resolve persisted state once on mount. A snapshot that fails validation is
  // dropped from the map as well: it would fail identically on every future
  // mount, and retaining it keeps a crash-then-retry cycle deterministic.
  const [persisted] = useState<PersistedEntry | undefined>(() => {
    if (!persistKey) return undefined;
    const entry = persistedStates.get(persistKey);
    if (!entry) return undefined;
    if (!isRestorableStateSnapshot(entry.snapshot)) {
      persistedStates.delete(persistKey);
      return undefined;
    }
    return entry;
  });

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
  /**
   * Scroll position as of the last `scroll` event, used to derive direction.
   * Kept separate from lastScrollTopRef, which the touch handlers own and
   * sample only between touchstart/touchmove.
   */
  const lastObservedScrollTopRef = useRef(0);
  const mountedRef = useRef(true);
  const scrollInFlightRef = useRef(false);
  const hasBeenActiveRef = useRef(false);
  const envChangedWhileInactiveRef = useRef(false);
  const pendingActivationScrollRef = useRef(false);
  const activationScrollRafRef = useRef<number | null>(null);
  const activationScrollReadyAttemptsRef = useRef(0);

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

  // Always "auto", never "smooth". Virtuoso re-invokes followOutput on every
  // item change, and a native smooth scroll restarts its easing from scratch
  // each time it is re-issued — so against a target that keeps moving (tokens
  // streaming in) it never converges. The tail drifts progressively lower,
  // then snaps back up when the stream pauses and the animation finally lands.
  // Instant follow is what actually *reads* as smooth: content grows, the
  // viewport stays pinned to the bottom, nothing bobs.
  const followOutput = useCallback(
    (atBottom: boolean): "auto" | false => {
      return atBottom || wantsStickRef.current ? "auto" : false;
    },
    []
  );

  const scrollerRef = useCallback((el: HTMLElement | Window | null) => {
    const next = el instanceof HTMLElement ? el : null;
    scrollerElRef.current = next;
    setScrollerEl(next);
  }, []);

  // Core retry loop, shared by the public scrollToBottom (smooth), the
  // activation jump (instant — animating on every env/tab switch reads as
  // jank) and followContentGrowth's pre-mount fallback (instant).
  // `behavior` only affects the final footer scroll; the scrollToIndex
  // retries are always instant since they correct virtual-height estimates.
  const performScrollToBottom = useCallback((behavior: "smooth" | "auto"): boolean => {
    const handle = virtuosoRef.current;
    if (!handle) return false;
    if (
      typeof handle.scrollToIndex !== "function" ||
      typeof handle.scrollTo !== "function"
    ) {
      return false;
    }
    // Clicking the scroll-down button (or any programmatic call) is an
    // explicit stick signal.
    wantsStickRef.current = true;
    // Guard against overlapping invocations — a second call while the
    // retry loop is still mid-flight would fire a duplicate footer scroll.
    if (scrollInFlightRef.current) return false;
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
    return true;
    // Deps intentionally empty: reads only refs (virtuosoRef, scrollerElRef,
    // mountedRef, scrollInFlightRef, isAtBottomRef, wantsStickRef). Adding
    // scrollerEl here would recreate the callback whenever the scroller
    // mounts, which in turn would retrigger the ResizeObserver effect and
    // reobserve from scratch on each mount.
  }, []);

  const scrollToBottom = useCallback(
    () => {
      performScrollToBottom("smooth");
    },
    [performScrollToBottom]
  );

  /**
   * Pin the scroller to the bottom in one synchronous write.
   *
   * Called from the Resize/Mutation observers, which run after layout but
   * *before paint*, so growing content never gets a frame at the displaced
   * position — the previous rAF hop always cost one visible frame of drift.
   *
   * Returns false only when there is no scroller yet, so callers can fall back
   * to the handle-driven retry loop.
   */
  const pinToBottom = useCallback((): boolean => {
    const el = scrollerElRef.current;
    if (!el) return false;
    // Only ever move down. Content shrinking is clamped by the browser, and
    // pulling the viewport *up* here would fight a user mid-scroll.
    const target = el.scrollHeight - el.clientHeight;
    if (target > el.scrollTop) {
      el.scrollTop = target;
    }
    return true;
  }, []);

  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  /**
   * Follow content that grew on its own (streaming tokens, the thinking
   * indicator, a late-measuring question card).
   *
   * Deliberately does *not* go through performScrollToBottom: that loop holds
   * scrollInFlightRef for the length of its retries plus a 400ms watch window,
   * which swallowed every growth event in between and left the tail to drift
   * until the flag cleared. A direct pin is both cheaper and exact.
   */
  const followContentGrowth = useCallback(() => {
    if (!isActiveRef.current) return;
    if (!wantsStickRef.current) return;
    if (scrollInFlightRef.current) return;
    if (pinToBottom()) return;
    // No scroller mounted yet — fall back to the handle. "auto", not "smooth":
    // this is content catching up, not a user-requested journey.
    performScrollToBottom("auto");
  }, [pinToBottom, performScrollToBottom]);

  const totalListHeightChanged = useCallback(
    (_height: number) => {
      followContentGrowth();
    },
    [followContentGrowth]
  );

  const growthPinRafRef = useRef<number | null>(null);

  const cancelScheduledGrowthPin = useCallback(() => {
    if (growthPinRafRef.current !== null) {
      cancelAnimationFrame(growthPinRafRef.current);
      growthPinRafRef.current = null;
    }
  }, []);

  /**
   * Pin now, and drop any pin a MutationObserver had queued for this frame.
   *
   * This is the ResizeObserver's callback. The browser delivers it after
   * layout is computed and before paint, so reading scrollHeight here is free
   * and the correction is still invisible.
   */
  const pinForResize = useCallback(() => {
    cancelScheduledGrowthPin();
    followContentGrowth();
  }, [cancelScheduledGrowthPin, followContentGrowth]);

  /**
   * Defer a mutation-driven pin to the ResizeObserver delivery for this frame.
   *
   * Both observers see the same growth, but a MutationObserver callback runs
   * at a microtask checkpoint while layout is still dirty from the commit that
   * just mutated the DOM — so measuring there forces a synchronous reflow, once
   * per checkpoint. Anything that grows scrollHeight also resizes an observed
   * element, so the ResizeObserver will pin within the same frame anyway.
   *
   * The rAF is only a backstop for growth that produces no resize notification
   * (margin-only growth, which ResizeObserver does not report). It costs the
   * one frame of drift the synchronous pin exists to avoid, which is why
   * pinForResize cancels it the moment a real resize lands.
   */
  const scheduleGrowthPin = useCallback(() => {
    if (growthPinRafRef.current !== null) return;
    if (typeof requestAnimationFrame === "undefined") {
      followContentGrowth();
      return;
    }
    growthPinRafRef.current = requestAnimationFrame(() => {
      growthPinRafRef.current = null;
      followContentGrowth();
    });
  }, [followContentGrowth]);

  // User-scroll-up detection: only a user action can release stick intent.
  // Virtuoso's own programmatic scrolls (followOutput, scrollToIndex) do not
  // fire wheel/touch/keydown events, so this cleanly separates the two.
  //
  // Dragging the scrollbar is the gap those three leave: it fires no wheel,
  // touch or key event, so without the drag listener below the user stays
  // flagged sticky and is pinned straight back to the bottom on the next token.
  //
  // The drag is detected as "scrolled up while a pointer is held down" rather
  // than from the scroll event alone. A bare scroll listener cannot tell a
  // drag from Virtuoso correcting an over-estimated height after restoring a
  // snapshot, and mistaking that for intent would silently stop auto-follow
  // on mount — a worse failure than the one being fixed.
  //
  // The trade-off is that this only sees drags for which the engine dispatches
  // pointer events on the scroller. Where it does not, we simply fall back to
  // the previous behaviour (stick stays engaged) rather than guessing.
  useEffect(() => {
    if (!scrollerEl) return;

    lastObservedScrollTopRef.current = scrollerEl.scrollTop;
    let pointerHeld = false;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) wantsStickRef.current = false;
    };
    const handlePointerDown = () => {
      pointerHeld = true;
    };
    const handlePointerRelease = () => {
      pointerHeld = false;
    };
    const handleScroll = () => {
      const st = scrollerEl.scrollTop;
      const previous = lastObservedScrollTopRef.current;
      lastObservedScrollTopRef.current = st;

      if (!pointerHeld) return;
      if (st >= previous - USER_SCROLL_UP_TOLERANCE_PX) return;
      // A shrinking scrollHeight or a growing viewport also lowers scrollTop
      // while leaving the user at the bottom. Only a move that actually ends
      // away from the bottom is intent to stop following.
      const distanceFromBottom =
        scrollerEl.scrollHeight - scrollerEl.clientHeight - st;
      if (distanceFromBottom > AT_BOTTOM_THRESHOLD) {
        wantsStickRef.current = false;
      }
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
    scrollerEl.addEventListener("scroll", handleScroll, { passive: true });
    scrollerEl.addEventListener("pointerdown", handlePointerDown, {
      passive: true,
    });
    // The pointer is often released outside the scroller (or over the
    // scrollbar gutter), so the release has to be watched globally.
    window.addEventListener("pointerup", handlePointerRelease, {
      passive: true,
    });
    window.addEventListener("pointercancel", handlePointerRelease, {
      passive: true,
    });
    scrollerEl.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    scrollerEl.addEventListener("touchmove", handleTouchMove, {
      passive: true,
    });
    scrollerEl.addEventListener("keydown", handleKeyDown);

    return () => {
      scrollerEl.removeEventListener("wheel", handleWheel);
      scrollerEl.removeEventListener("scroll", handleScroll);
      scrollerEl.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerRelease);
      window.removeEventListener("pointercancel", handlePointerRelease);
      scrollerEl.removeEventListener("touchstart", handleTouchStart);
      scrollerEl.removeEventListener("touchmove", handleTouchMove);
      scrollerEl.removeEventListener("keydown", handleKeyDown);
    };
  }, [scrollerEl]);

  // ResizeObserver fallback: when content grows (e.g. footer gains a thinking
  // indicator or question card) and the user still wants stick, pin to the new
  // bottom. followOutput only fires on data-item changes.
  //
  // Note: we deliberately do NOT skip when isAtBottomRef.current is true.
  // followOutput only fires on data-item changes, so footer-only growth
  // (thinking indicator, late-rendering cards) leaves Virtuoso reporting
  // atBottom=true while the new content sits below the viewport.
  //
  // The pin runs synchronously inside the ResizeObserver callback rather than
  // on a scheduled rAF: it fires within the frame that produced the growth,
  // before it is painted, so the correction is invisible instead of one frame
  // late. Mutation-driven growth is folded into that same delivery — see
  // scheduleGrowthPin for why it does not measure inline.
  useEffect(() => {
    if (!scrollerEl || typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(pinForResize);
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
            scheduleGrowthPin();
          })
        : null;
    mutationObserver?.observe(scrollerEl, {
      childList: true,
      subtree: true,
    });

    return () => {
      cancelScheduledGrowthPin();
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
    };
  }, [scrollerEl, pinForResize, scheduleGrowthPin, cancelScheduledGrowthPin]);

  const cancelActivationScrollFrame = useCallback(() => {
    if (activationScrollRafRef.current !== null) {
      cancelAnimationFrame(activationScrollRafRef.current);
      activationScrollRafRef.current = null;
    }
  }, []);

  const schedulePendingActivationScroll = useCallback(() => {
    if (activationScrollRafRef.current !== null) return;
    activationScrollRafRef.current = requestAnimationFrame(() => {
      activationScrollRafRef.current = null;
      if (
        !mountedRef.current ||
        !isActiveRef.current ||
        !pendingActivationScrollRef.current
      ) {
        return;
      }

      const started = performScrollToBottom("auto");
      if (started) {
        pendingActivationScrollRef.current = false;
        activationScrollReadyAttemptsRef.current = 0;
        return;
      }

      // If the scroller exists but the Virtuoso handle is not ready yet,
      // retry briefly. If the scroller is absent (e.g. the native tab is
      // still connecting), keep the pending flag and wait for scrollerRef to
      // fire, which triggers the effect below.
      if (scrollerElRef.current) {
        if (
          activationScrollReadyAttemptsRef.current <
          ACTIVATION_SCROLL_READY_MAX_ATTEMPTS
        ) {
          activationScrollReadyAttemptsRef.current += 1;
          schedulePendingActivationScroll();
        } else {
          // The scroller mounted but the handle never became ready within the
          // retry budget. Give up and clear the pending flag so a later
          // scroller remount can't re-fire this stale activation scroll and
          // yank a user who has since scrolled up back to the bottom.
          pendingActivationScrollRef.current = false;
          activationScrollReadyAttemptsRef.current = 0;
        }
      }
    });
  }, [performScrollToBottom]);

  // Tab re-activation: jump to the new bottom on return when the user was
  // sticky when they left, when the selected environment changed while the
  // view was away, or when the caller explicitly wants every activation to
  // re-lock to the bottom. The jump uses the instant retry loop — animating
  // on every env/tab switch reads as jank, and a one-shot scrollToIndex can
  // land short while Virtuoso re-measures items that were outside the
  // rendered window. Reset scrollInFlightRef first so a stale flag from a
  // prior activation cycle (e.g. a smooth scroll interrupted by switching
  // away) can't deadlock subsequent scroll attempts.
  //
  // By default, skip on the very first activation: Virtuoso handles initial
  // position via restoreStateFrom. If the persisted snapshot is stale
  // (content grew while the tab was inactive), the user lands at the *old*
  // bottom on mount; totalListHeightChanged and the ResizeObserver fallback
  // then catch up to the new bottom as items measure. Callers using
  // stickToBottomOnActivation opt out of that preservation and intentionally
  // force the bottom lock even on first activation.
  useEffect(() => {
    if (!isActive) return;
    const isFirstActivation = !hasBeenActiveRef.current;
    hasBeenActiveRef.current = true;
    const envChanged = envChangedWhileInactiveRef.current;
    envChangedWhileInactiveRef.current = false;
    if (stickToBottomOnActivation) {
      wantsStickRef.current = true;
    }
    if (isFirstActivation && !stickToBottomOnActivation) return;
    scrollInFlightRef.current = false;
    if (
      !stickToBottomOnActivation &&
      !envChanged &&
      !wantsStickRef.current
    ) {
      return;
    }
    pendingActivationScrollRef.current = true;
    activationScrollReadyAttemptsRef.current = 0;
    schedulePendingActivationScroll();
    return cancelActivationScrollFrame;
  }, [
    isActive,
    stickToBottomOnActivation,
    schedulePendingActivationScroll,
    cancelActivationScrollFrame,
  ]);

  useEffect(() => {
    if (!isActive) {
      pendingActivationScrollRef.current = false;
      activationScrollReadyAttemptsRef.current = 0;
      cancelActivationScrollFrame();
      return;
    }

    if (pendingActivationScrollRef.current) {
      activationScrollReadyAttemptsRef.current = 0;
      schedulePendingActivationScroll();
    }
  }, [
    isActive,
    scrollerEl,
    schedulePendingActivationScroll,
    cancelActivationScrollFrame,
  ]);

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
