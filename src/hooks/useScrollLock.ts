import { useEffect, useState, useCallback, useRef, type RefObject } from "react";

/** Pixels from bottom to consider "at bottom" */
const SCROLL_THRESHOLD = 50;

/** Maximum attempts to find viewport element (total wait: 20 * 50ms = 1 second) */
const VIEWPORT_POLL_MAX_ATTEMPTS = 20;
/** Interval between viewport polling attempts in milliseconds */
const VIEWPORT_POLL_INTERVAL_MS = 50;

interface UseScrollLockOptions {
  /** Dependency array that triggers auto-scroll when changed (e.g., messages array) */
  scrollTrigger?: unknown;
  /** Optional trigger to re-search for viewport when changed (e.g., when component conditionally renders the scroll area) */
  mountTrigger?: unknown;
  /** Whether the host view is currently active/visible */
  isActive?: boolean;
  /** Optional persistence key for retaining scroll position/lock across tab switches */
  persistKey?: string;
}

interface UseScrollLockReturn {
  /** Whether the user is currently at the bottom of the scroll area */
  isAtBottom: boolean;
  /** Whether auto-scroll is enabled (user is following new content) */
  isScrollLocked: boolean;
  /** Scroll to bottom and re-enable scroll lock */
  scrollToBottom: () => void;
}

interface PersistedScrollState {
  scrollTop: number;
  isAtBottom: boolean;
  isScrollLocked: boolean;
}

const MAX_PERSISTED_SCROLL_STATES = 200;
const persistedScrollState = new Map<string, PersistedScrollState>();

function setPersistedScrollState(persistKey: string, state: PersistedScrollState) {
  persistedScrollState.delete(persistKey);
  persistedScrollState.set(persistKey, state);

  if (persistedScrollState.size > MAX_PERSISTED_SCROLL_STATES) {
    const oldestKey = persistedScrollState.keys().next().value;
    if (oldestKey) {
      persistedScrollState.delete(oldestKey);
    }
  }
}

export function clearPersistedScrollState(persistKey: string) {
  persistedScrollState.delete(persistKey);
}

/**
 * Hook to manage scroll lock behavior for chat-like interfaces.
 *
 * When the user is at the bottom, new content will auto-scroll into view.
 * When the user scrolls up to read history, auto-scroll is disabled.
 * A "scroll to bottom" action re-enables auto-scroll.
 *
 * Works with Radix ScrollArea components by querying for the viewport element.
 */
export function useScrollLock(
  scrollRef: RefObject<HTMLDivElement | null>,
  options: UseScrollLockOptions = {}
): UseScrollLockReturn {
  const { scrollTrigger, mountTrigger, isActive = true, persistKey } = options;

  const initialPersistedState = persistKey ? persistedScrollState.get(persistKey) : undefined;
  const [isScrollLocked, setIsScrollLocked] = useState(initialPersistedState?.isScrollLocked ?? true);
  const [isAtBottom, setIsAtBottom] = useState(initialPersistedState?.isAtBottom ?? true);
  // Track the viewport element in state to trigger re-renders when it becomes available
  const [viewportElement, setViewportElement] = useState<HTMLElement | null>(null);

  // Use a ref to track scroll lock for sync access in effects
  // This prevents race conditions where state hasn't updated yet
  const isScrollLockedRef = useRef(initialPersistedState?.isScrollLocked ?? true);

  // Guard flag: when true, the scroll handler won't reset isScrollLocked.
  // This prevents smooth-scroll animations (from scrollToBottom) from
  // triggering intermediate scroll events that incorrectly disable scroll lock
  // and cause the scroll-to-bottom button to flicker.
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistCurrentState = useCallback(() => {
    if (!persistKey || !viewportElement) return;

    setPersistedScrollState(persistKey, {
      scrollTop: viewportElement.scrollTop,
      isAtBottom,
      isScrollLocked: isScrollLockedRef.current,
    });
  }, [persistKey, viewportElement, isAtBottom]);

  // Find the viewport element when the ref changes or mountTrigger changes
  useEffect(() => {
    // Clear previous viewport when ref/mountTrigger changes to handle remounts
    setViewportElement(null);

    const findViewport = (): HTMLElement | null => {
      const root = scrollRef.current;
      if (!root) return null;
      if (
        root.matches('[data-slot="scroll-area-viewport"]') ||
        root.matches('[data-scroll-viewport="true"]')
      ) {
        return root;
      }
      // Try Radix's internal attribute first, then fall back to data-slot
      return (
        root.querySelector("[data-radix-scroll-area-viewport]") ||
        root.querySelector('[data-slot="scroll-area-viewport"]') ||
        root.querySelector('[data-scroll-viewport="true"]')
      ) as HTMLElement | null;
    };

    // Try immediately
    const viewport = findViewport();
    if (viewport) {
      setViewportElement(viewport);
      return;
    }

    // If not found, poll a few times (handles async rendering)
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const vp = findViewport();
      if (vp) {
        setViewportElement(vp);
        clearInterval(interval);
      } else if (attempts >= VIEWPORT_POLL_MAX_ATTEMPTS) {
        // Only warn if we're searching after a mountTrigger change (i.e., when we expect to find it)
        // mountTrigger is used to indicate the scroll area should be available
        if (mountTrigger !== undefined) {
          console.warn(
            "[useScrollLock] Failed to find viewport after",
            VIEWPORT_POLL_MAX_ATTEMPTS,
            "attempts"
          );
        }
        clearInterval(interval);
      }
    }, VIEWPORT_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mountTrigger intentionally re-runs search when it changes
  }, [scrollRef, mountTrigger]);

  // Check initial scroll position when viewport becomes available
  useEffect(() => {
    if (!viewportElement) return;

    if (persistKey) {
      const persisted = persistedScrollState.get(persistKey);
      if (persisted) {
        if (persisted.isScrollLocked || persisted.isAtBottom) {
          viewportElement.scrollTop = viewportElement.scrollHeight;
        } else {
          viewportElement.scrollTop = persisted.scrollTop;
        }

        setIsAtBottom(persisted.isAtBottom);
        setIsScrollLocked(persisted.isScrollLocked);
        isScrollLockedRef.current = persisted.isScrollLocked;
        return;
      }
    }

    const { scrollTop, scrollHeight, clientHeight } = viewportElement;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const atBottom = distanceFromBottom <= SCROLL_THRESHOLD;

    setIsAtBottom(atBottom);
    setIsScrollLocked(atBottom);
    isScrollLockedRef.current = atBottom;
  }, [viewportElement, persistKey]);

  // Track scroll position to manage scroll lock
  useEffect(() => {
    if (!viewportElement) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewportElement;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const atBottom = distanceFromBottom <= SCROLL_THRESHOLD;

      // During a programmatic scroll-to-bottom animation, don't let
      // intermediate positions reset scroll lock or isAtBottom state.
      // The smooth scroll will eventually reach the bottom; only update
      // state once it arrives (atBottom === true clears the guard).
      if (isProgrammaticScrollRef.current) {
        if (atBottom) {
          isProgrammaticScrollRef.current = false;
          if (programmaticScrollTimerRef.current) {
            clearTimeout(programmaticScrollTimerRef.current);
            programmaticScrollTimerRef.current = null;
          }
          setIsAtBottom(true);
          setIsScrollLocked(true);
          isScrollLockedRef.current = true;
        }
        // Still persist scrollTop for tab-switch restore
        if (persistKey) {
          setPersistedScrollState(persistKey, {
            scrollTop: viewportElement.scrollTop,
            isAtBottom: true,
            isScrollLocked: true,
          });
        }
        return;
      }

      setIsAtBottom(atBottom);

      // Auto-enable scroll lock when user scrolls to bottom manually
      if (atBottom) {
        setIsScrollLocked(true);
        isScrollLockedRef.current = true;
      } else {
        // User scrolled up - disable scroll lock
        setIsScrollLocked(false);
        isScrollLockedRef.current = false;
      }

      if (persistKey) {
        setPersistedScrollState(persistKey, {
          scrollTop: viewportElement.scrollTop,
          isAtBottom: atBottom,
          isScrollLocked: isScrollLockedRef.current,
        });
      }
    };

    viewportElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      viewportElement.removeEventListener("scroll", handleScroll);
      // Clean up the safety timer on unmount / viewport change
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
        programmaticScrollTimerRef.current = null;
      }
    };
  }, [viewportElement, persistKey]);

  useEffect(() => {
    if (!viewportElement || !persistKey) return;
    persistCurrentState();
  }, [isAtBottom, isScrollLocked, viewportElement, persistKey, persistCurrentState]);

  useEffect(() => {
    if (!viewportElement || !persistKey) return;

    if (!isActive) {
      persistCurrentState();
      return;
    }

    const persisted = persistedScrollState.get(persistKey);
    if (!persisted) {
      if (isScrollLockedRef.current) {
        viewportElement.scrollTop = viewportElement.scrollHeight;
      }
      return;
    }

    if (persisted.isScrollLocked || persisted.isAtBottom) {
      viewportElement.scrollTop = viewportElement.scrollHeight;
    } else {
      viewportElement.scrollTop = persisted.scrollTop;
    }

    setIsAtBottom(persisted.isAtBottom);
    setIsScrollLocked(persisted.isScrollLocked);
    isScrollLockedRef.current = persisted.isScrollLocked;
  }, [isActive, viewportElement, persistKey, persistCurrentState]);

  // Auto-scroll to bottom when trigger changes (only if scroll-locked)
  // Uses instant scrolling to keep up with rapid message streaming
  // Uses ref instead of state to avoid race conditions with scroll events
  useEffect(() => {
    if (!isActive || !isScrollLockedRef.current || !viewportElement) return;

    viewportElement.scrollTop = viewportElement.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Using ref instead of state to avoid race condition
  }, [scrollTrigger, viewportElement, isActive]);

  // Handle scroll to bottom button click
  const scrollToBottom = useCallback(() => {
    if (!viewportElement) return;

    // Set guard flag to prevent the scroll handler from resetting
    // isScrollLocked during the smooth scroll animation. The flag
    // is cleared when the scroll actually reaches the bottom.
    isProgrammaticScrollRef.current = true;

    // Safety timeout: clear the guard if the smooth scroll never reaches
    // the bottom (e.g., user interrupts, content resizes, or animation
    // gets stuck). Without this, the guard would stay set forever.
    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = setTimeout(() => {
      isProgrammaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, 2000);

    viewportElement.scrollTo({
      top: viewportElement.scrollHeight,
      behavior: "smooth",
    });
    // Update both state and ref immediately for sync behavior
    setIsAtBottom(true);
    setIsScrollLocked(true);
    isScrollLockedRef.current = true;
    if (persistKey) {
      setPersistedScrollState(persistKey, {
        scrollTop: viewportElement.scrollHeight,
        isAtBottom: true,
        isScrollLocked: true,
      });
    }
  }, [viewportElement, persistKey]);

  return {
    isAtBottom,
    isScrollLocked,
    scrollToBottom,
  };
}
