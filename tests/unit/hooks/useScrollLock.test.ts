import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import {
  useScrollLock,
  clearPersistedScrollState,
} from "@/hooks/useScrollLock";
import { createRef, type RefObject } from "react";

// Track containers for cleanup (avoids wiping all of document.body)
const containers: HTMLElement[] = [];

/**
 * Creates a mock container div with a child viewport element that simulates
 * a Radix ScrollArea. Returns the container ref and the viewport element
 * for direct manipulation in tests.
 */
function createMockScrollContainer(opts: {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  selector?: string;
  trackScrollTopSets?: number[];
} = {}) {
  const {
    scrollTop = 0,
    scrollHeight = 1000,
    clientHeight = 500,
    selector = "data-radix-scroll-area-viewport",
    trackScrollTopSets,
  } = opts;

  const container = document.createElement("div");
  const viewport = document.createElement("div");
  viewport.setAttribute(selector, "");

  // happy-dom doesn't compute layout, so we define getters
  Object.defineProperty(viewport, "scrollHeight", {
    get: () => scrollHeight,
    configurable: true,
  });
  Object.defineProperty(viewport, "clientHeight", {
    get: () => clientHeight,
    configurable: true,
  });

  if (trackScrollTopSets) {
    Object.defineProperty(viewport, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => trackScrollTopSets.push(v),
      configurable: true,
    });
  } else {
    Object.defineProperty(viewport, "scrollTop", {
      get: () => scrollTop,
      set: () => {},
      configurable: true,
    });
  }

  // Track scrollTo calls
  const scrollToCalls: ScrollToOptions[] = [];
  viewport.scrollTo = ((opts: ScrollToOptions) => {
    scrollToCalls.push(opts);
  }) as any;

  container.appendChild(viewport);
  document.body.appendChild(container);
  containers.push(container);

  const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
  ref.current = container as HTMLDivElement;

  return { ref: ref as RefObject<HTMLDivElement | null>, viewport, scrollToCalls, container };
}

function fireScroll(viewport: HTMLElement) {
  viewport.dispatchEvent(new Event("scroll"));
}

function setScrollPosition(
  viewport: HTMLElement,
  scrollTop: number,
  scrollHeight = 1000,
  clientHeight = 500
) {
  Object.defineProperty(viewport, "scrollTop", {
    get: () => scrollTop,
    set: () => {},
    configurable: true,
  });
  Object.defineProperty(viewport, "scrollHeight", {
    get: () => scrollHeight,
    configurable: true,
  });
  Object.defineProperty(viewport, "clientHeight", {
    get: () => clientHeight,
    configurable: true,
  });
}

describe("useScrollLock", () => {
  beforeEach(() => {
    clearPersistedScrollState("test-key");
    clearPersistedScrollState("key-a");
    clearPersistedScrollState("key-b");
    clearPersistedScrollState("no-state");
  });

  afterEach(() => {
    // Only remove containers we created, not everything in document.body
    for (const c of containers) {
      c.remove();
    }
    containers.length = 0;
  });

  describe("initial state", () => {
    test("starts with isScrollLocked true and isAtBottom true", () => {
      const ref = createRef<HTMLDivElement>() as RefObject<HTMLDivElement | null>;
      const { result } = renderHook(() => useScrollLock(ref));

      expect(result.current.isScrollLocked).toBe(true);
      expect(result.current.isAtBottom).toBe(true);
    });

    test("returns a scrollToBottom function", () => {
      const ref = createRef<HTMLDivElement>() as RefObject<HTMLDivElement | null>;
      const { result } = renderHook(() => useScrollLock(ref));

      expect(typeof result.current.scrollToBottom).toBe("function");
    });
  });

  describe("viewport discovery", () => {
    test("finds viewport with data-radix-scroll-area-viewport attribute", () => {
      const { ref, viewport } = createMockScrollContainer();
      // Position at bottom so initial check sets atBottom=true
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      // The hook should have found the viewport and computed initial state
      expect(result.current.isAtBottom).toBe(true);
    });

    test("finds viewport with data-slot=scroll-area-viewport attribute", () => {
      const { ref } = createMockScrollContainer({
        scrollTop: 500,
        selector: "data-slot",
      });
      // Override the selector — the helper uses setAttribute with the key
      // We need to create manually for data-slot="scroll-area-viewport"
      const container = document.createElement("div");
      const viewport = document.createElement("div");
      viewport.setAttribute("data-slot", "scroll-area-viewport");
      Object.defineProperty(viewport, "scrollHeight", { get: () => 1000, configurable: true });
      Object.defineProperty(viewport, "clientHeight", { get: () => 500, configurable: true });
      Object.defineProperty(viewport, "scrollTop", { get: () => 500, set: () => {}, configurable: true });

      container.appendChild(viewport);
      document.body.appendChild(container);
      containers.push(container);

      const ref2 = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
      ref2.current = container as HTMLDivElement;

      const { result } = renderHook(() =>
        useScrollLock(ref2 as RefObject<HTMLDivElement | null>)
      );

      expect(result.current.isAtBottom).toBe(true);
    });

    test("finds a nested viewport with the data-scroll-viewport marker", () => {
      // The non-Radix ScrollArea/div replacement tags its scrollable element
      // with data-scroll-viewport="true" instead of the Radix attributes.
      const { ref } = createMockScrollContainer({
        scrollTop: 500,
        selector: "data-scroll-viewport",
      });

      const { result } = renderHook(() => useScrollLock(ref));

      expect(result.current.isAtBottom).toBe(true);
    });

    test("uses the root element itself when it is the scroll viewport", () => {
      // BuildChatTab passes the scrollRef directly to the scrollable <div
      // data-scroll-viewport="true">, so the ref *is* the viewport (no child).
      const root = document.createElement("div");
      root.setAttribute("data-scroll-viewport", "true");
      Object.defineProperty(root, "scrollHeight", { get: () => 1000, configurable: true });
      Object.defineProperty(root, "clientHeight", { get: () => 500, configurable: true });
      Object.defineProperty(root, "scrollTop", { get: () => 500, set: () => {}, configurable: true });
      document.body.appendChild(root);
      containers.push(root);

      const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
      ref.current = root as HTMLDivElement;

      const { result } = renderHook(() =>
        useScrollLock(ref as RefObject<HTMLDivElement | null>)
      );

      // Root is treated as the viewport: scrollTop 500 of 1000 with 500 client
      // height is exactly at the bottom.
      expect(result.current.isAtBottom).toBe(true);
    });

    test("uses the root element when it carries the scroll-area-viewport data-slot", () => {
      const root = document.createElement("div");
      root.setAttribute("data-slot", "scroll-area-viewport");
      Object.defineProperty(root, "scrollHeight", { get: () => 1000, configurable: true });
      Object.defineProperty(root, "clientHeight", { get: () => 500, configurable: true });
      // Scrolled up to the top — should report not at bottom.
      Object.defineProperty(root, "scrollTop", { get: () => 0, set: () => {}, configurable: true });
      document.body.appendChild(root);
      containers.push(root);

      const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
      ref.current = root as HTMLDivElement;

      const { result } = renderHook(() =>
        useScrollLock(ref as RefObject<HTMLDivElement | null>)
      );

      expect(result.current.isAtBottom).toBe(false);
    });
  });

  describe("scroll event handling", () => {
    test("sets isAtBottom false when scrolled away from bottom", () => {
      const { ref, viewport } = createMockScrollContainer();
      // Start at bottom
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      // Now scroll away from bottom (distance > 50px threshold)
      act(() => {
        setScrollPosition(viewport, 100, 1000, 500);
        fireScroll(viewport);
      });

      expect(result.current.isAtBottom).toBe(false);
    });

    test("sets isScrollLocked false when user scrolls up", () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      act(() => {
        setScrollPosition(viewport, 100, 1000, 500);
        fireScroll(viewport);
      });

      expect(result.current.isScrollLocked).toBe(false);
    });

    test("re-enables scroll lock when user scrolls back to bottom", () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      // Scroll up
      act(() => {
        setScrollPosition(viewport, 100, 1000, 500);
        fireScroll(viewport);
      });
      expect(result.current.isScrollLocked).toBe(false);

      // Scroll back to bottom (within 50px threshold)
      act(() => {
        setScrollPosition(viewport, 480, 1000, 500);
        fireScroll(viewport);
      });
      expect(result.current.isScrollLocked).toBe(true);
      expect(result.current.isAtBottom).toBe(true);
    });

    test("considers within SCROLL_THRESHOLD (50px) as at bottom", () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      // Distance from bottom = 1000 - 460 - 500 = 40, which is <= 50
      act(() => {
        setScrollPosition(viewport, 460, 1000, 500);
        fireScroll(viewport);
      });

      expect(result.current.isAtBottom).toBe(true);
    });

    test("considers beyond SCROLL_THRESHOLD (50px) as not at bottom", () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      // Distance from bottom = 1000 - 440 - 500 = 60, which is > 50
      act(() => {
        setScrollPosition(viewport, 440, 1000, 500);
        fireScroll(viewport);
      });

      expect(result.current.isAtBottom).toBe(false);
    });
  });

  describe("scrollToBottom", () => {
    test("calls scrollTo with smooth behavior", () => {
      const { ref, viewport, scrollToCalls } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      act(() => {
        result.current.scrollToBottom();
      });

      expect(scrollToCalls).toHaveLength(1);
      expect(scrollToCalls[0]).toEqual({
        top: 1000, // scrollHeight
        behavior: "smooth",
      });
    });

    test("sets isAtBottom and isScrollLocked to true immediately", () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      // Scroll away first
      act(() => {
        setScrollPosition(viewport, 100, 1000, 500);
        fireScroll(viewport);
      });
      expect(result.current.isScrollLocked).toBe(false);

      // Now scroll to bottom
      act(() => {
        result.current.scrollToBottom();
      });
      expect(result.current.isScrollLocked).toBe(true);
      expect(result.current.isAtBottom).toBe(true);
    });

    test("is a no-op when viewport element is not found", () => {
      const ref = createRef<HTMLDivElement>() as RefObject<HTMLDivElement | null>;
      const { result } = renderHook(() => useScrollLock(ref));

      // Should not throw
      act(() => {
        result.current.scrollToBottom();
      });

      expect(result.current.isScrollLocked).toBe(true);
    });
  });

  describe("programmatic scroll guard", () => {
    test("suppresses scroll lock reset during programmatic smooth scroll", () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      // Trigger scrollToBottom to set the guard
      act(() => {
        result.current.scrollToBottom();
      });

      // Simulate intermediate scroll event mid-animation (not at bottom)
      act(() => {
        setScrollPosition(viewport, 300, 1000, 500);
        fireScroll(viewport);
      });

      // Should still report locked because the guard is active
      expect(result.current.isScrollLocked).toBe(true);
      expect(result.current.isAtBottom).toBe(true);
    });

    test("clears guard when scroll reaches bottom", () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      act(() => {
        result.current.scrollToBottom();
      });

      // Intermediate event
      act(() => {
        setScrollPosition(viewport, 300, 1000, 500);
        fireScroll(viewport);
      });

      // Scroll reaches bottom
      act(() => {
        setScrollPosition(viewport, 500, 1000, 500);
        fireScroll(viewport);
      });

      expect(result.current.isScrollLocked).toBe(true);
      expect(result.current.isAtBottom).toBe(true);

      // Now a user scroll up should be detected normally (guard cleared)
      act(() => {
        setScrollPosition(viewport, 100, 1000, 500);
        fireScroll(viewport);
      });

      expect(result.current.isScrollLocked).toBe(false);
      expect(result.current.isAtBottom).toBe(false);
    });

    test("safety timeout clears stale guard after 2 seconds", async () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      act(() => {
        result.current.scrollToBottom();
      });

      // Simulate intermediate scroll that never reaches bottom
      act(() => {
        setScrollPosition(viewport, 300, 1000, 500);
        fireScroll(viewport);
      });

      // Guard is still active, scroll lock is not reset
      expect(result.current.isScrollLocked).toBe(true);

      // Wait for the safety timeout (2 seconds)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2100));
      });

      // Now a scroll event should be handled normally
      act(() => {
        setScrollPosition(viewport, 100, 1000, 500);
        fireScroll(viewport);
      });

      expect(result.current.isScrollLocked).toBe(false);
      expect(result.current.isAtBottom).toBe(false);
    });

    test("repeated scrollToBottom resets the safety timer", () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      const { result } = renderHook(() => useScrollLock(ref));

      // First scrollToBottom
      act(() => {
        result.current.scrollToBottom();
      });

      // Second scrollToBottom should not throw (timer is re-created)
      act(() => {
        result.current.scrollToBottom();
      });

      // Guard should still be active
      act(() => {
        setScrollPosition(viewport, 300, 1000, 500);
        fireScroll(viewport);
      });

      expect(result.current.isScrollLocked).toBe(true);
    });
  });

  describe("persistence", () => {
    test("persists scroll state when persistKey is provided", () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      renderHook(() =>
        useScrollLock(ref, { persistKey: "test-key" })
      );

      // Scroll away to trigger persistence
      act(() => {
        setScrollPosition(viewport, 100, 1000, 500);
        fireScroll(viewport);
      });

      // Mount a new hook instance — it should start with the persisted state.
      // No viewport needed; initial state comes from the persisted Map.
      const ref2 = createRef<HTMLDivElement>() as RefObject<HTMLDivElement | null>;
      const { result: result2 } = renderHook(() =>
        useScrollLock(ref2, { persistKey: "test-key" })
      );

      expect(result2.current.isScrollLocked).toBe(false);
      expect(result2.current.isAtBottom).toBe(false);
    });

    test("does not persist when no persistKey is provided", () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      renderHook(() => useScrollLock(ref));

      act(() => {
        setScrollPosition(viewport, 100, 1000, 500);
        fireScroll(viewport);
      });

      // A new hook with a fresh key should not have persisted state
      const ref2 = createRef<HTMLDivElement>() as RefObject<HTMLDivElement | null>;
      const { result: result2 } = renderHook(() =>
        useScrollLock(ref2, { persistKey: "no-state" })
      );

      // Defaults to true when no persisted state exists
      expect(result2.current.isScrollLocked).toBe(true);
      expect(result2.current.isAtBottom).toBe(true);
    });
  });

  describe("clearPersistedScrollState", () => {
    test("clears persisted state for a given key", () => {
      const { ref, viewport } = createMockScrollContainer();
      setScrollPosition(viewport, 500, 1000, 500);

      renderHook(() =>
        useScrollLock(ref, { persistKey: "test-key" })
      );

      // Scroll away to persist non-default state
      act(() => {
        setScrollPosition(viewport, 100, 1000, 500);
        fireScroll(viewport);
      });

      // Verify it was persisted by mounting a second hook
      const refCheck = createRef<HTMLDivElement>() as RefObject<HTMLDivElement | null>;
      const { result: check } = renderHook(() =>
        useScrollLock(refCheck, { persistKey: "test-key" })
      );
      expect(check.current.isScrollLocked).toBe(false);

      // Clear the persisted state
      clearPersistedScrollState("test-key");

      // New hook should get defaults (no viewport needed — testing the Map)
      const ref2 = createRef<HTMLDivElement>() as RefObject<HTMLDivElement | null>;
      const { result: result2 } = renderHook(() =>
        useScrollLock(ref2, { persistKey: "test-key" })
      );

      expect(result2.current.isScrollLocked).toBe(true);
      expect(result2.current.isAtBottom).toBe(true);
    });
  });

  describe("isActive", () => {
    test("does not auto-scroll when isActive is false", () => {
      // Set up scrollTop tracking BEFORE rendering the hook so the
      // setter is in place when the hook first discovers the viewport.
      const scrollTopSets: number[] = [];
      const { ref } = createMockScrollContainer({
        scrollTop: 500,
        trackScrollTopSets: scrollTopSets,
      });

      const { rerender } = renderHook(
        ({ isActive, scrollTrigger }) =>
          useScrollLock(ref, { isActive, scrollTrigger }),
        { initialProps: { isActive: true, scrollTrigger: 1 } }
      );

      const countBefore = scrollTopSets.length;

      // When inactive, changing scrollTrigger should not auto-scroll
      rerender({ isActive: false, scrollTrigger: 2 });

      expect(scrollTopSets.length).toBe(countBefore);
    });
  });

  describe("scrollTrigger", () => {
    test("auto-scrolls when scrollTrigger changes and scroll is locked", () => {
      // Set up scrollTop tracking BEFORE rendering the hook so the
      // setter is in place when the hook first discovers the viewport.
      const scrollTopSets: number[] = [];
      const { ref } = createMockScrollContainer({
        scrollTop: 500,
        trackScrollTopSets: scrollTopSets,
      });

      const { rerender } = renderHook(
        ({ scrollTrigger }) =>
          useScrollLock(ref, { scrollTrigger }),
        { initialProps: { scrollTrigger: 1 } }
      );

      const countBefore = scrollTopSets.length;

      rerender({ scrollTrigger: 2 });

      // Should have set scrollTop at least once more
      expect(scrollTopSets.length).toBeGreaterThan(countBefore);
    });
  });
});
