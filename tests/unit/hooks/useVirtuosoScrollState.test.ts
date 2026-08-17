import { describe, test, expect, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { StateSnapshot } from "react-virtuoso";
import {
  useVirtuosoScrollState,
  clearPersistedVirtuosoState,
} from "@/hooks/useVirtuosoScrollState";
import { useUIStore } from "@/stores/uiStore";

/**
 * happy-dom reports 0 for every layout metric, so a scroller that can actually
 * be pinned has to have its geometry stubbed. Appends to the document and
 * returns the element; callers remove it in a finally block.
 */
function makeScroller({
  scrollHeight,
  clientHeight,
}: {
  scrollHeight: number;
  clientHeight: number;
}): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", {
    get: () => scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    get: () => clientHeight,
    configurable: true,
  });
  document.body.appendChild(el);
  return el;
}

type ObserverHarness = {
  resizeObserved: Element[];
  resizeCallback?: ResizeObserverCallback;
  mutationObserveCalls: Array<{
    target: Node;
    options?: MutationObserverInit;
  }>;
  mutationCallback?: (
    records: MutationRecord[],
    observer: MutationObserver
  ) => void;
  restore: () => void;
};

/**
 * Replace the global observers with hand-driven stubs, so a test can decide
 * exactly when a resize or mutation is delivered. Callers must invoke
 * `restore()` in a finally block.
 */
function installObservers(): ObserverHarness {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalMutationObserver = globalThis.MutationObserver;
  const harness: ObserverHarness = {
    resizeObserved: [],
    mutationObserveCalls: [],
    restore: () => {
      (globalThis as any).ResizeObserver = originalResizeObserver;
      (globalThis as any).MutationObserver = originalMutationObserver;
    },
  };

  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      harness.resizeCallback = callback;
    }

    observe(element: Element) {
      harness.resizeObserved.push(element);
    }

    disconnect() {}
  }

  class MockMutationObserver {
    constructor(
      callback: (records: MutationRecord[], observer: MutationObserver) => void
    ) {
      harness.mutationCallback = callback;
    }

    observe(target: Node, options?: MutationObserverInit) {
      harness.mutationObserveCalls.push({ target, options });
    }

    disconnect() {}
  }

  (globalThis as any).ResizeObserver = MockResizeObserver;
  (globalThis as any).MutationObserver = MockMutationObserver;
  return harness;
}

describe("useVirtuosoScrollState", () => {
  beforeEach(() => {
    // Clear any persisted state between tests
    clearPersistedVirtuosoState("test-key");
    clearPersistedVirtuosoState("key-a");
    clearPersistedVirtuosoState("key-b");
  });

  describe("initial state", () => {
    test("starts with isAtBottom true", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());
      expect(result.current.isAtBottom).toBe(true);
    });

    test("returns a virtuosoRef", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());
      expect(result.current.virtuosoRef).toBeDefined();
      expect(result.current.virtuosoRef.current).toBeNull();
    });

    test("returns scrollProps with expected shape", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());
      const { scrollProps } = result.current;

      expect(typeof scrollProps.followOutput).toBe("function");
      expect(typeof scrollProps.atBottomStateChange).toBe("function");
      expect(typeof scrollProps.totalListHeightChanged).toBe("function");
      expect(typeof scrollProps.atBottomThreshold).toBe("number");
      expect(scrollProps.atBottomThreshold).toBe(50);
    });

    test("restoreStateFrom is undefined when no persistKey", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());
      expect(result.current.scrollProps.restoreStateFrom).toBeUndefined();
    });

    test("restoreStateFrom is undefined when persistKey has no saved state", () => {
      const { result } = renderHook(() =>
        useVirtuosoScrollState({ persistKey: "test-key" })
      );
      expect(result.current.scrollProps.restoreStateFrom).toBeUndefined();
    });
  });

  describe("atBottomStateChange", () => {
    test("updates isAtBottom to false when called with false", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      act(() => {
        result.current.scrollProps.atBottomStateChange(false);
      });

      expect(result.current.isAtBottom).toBe(false);
    });

    test("updates isAtBottom back to true when called with true", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      act(() => {
        result.current.scrollProps.atBottomStateChange(false);
      });
      expect(result.current.isAtBottom).toBe(false);

      act(() => {
        result.current.scrollProps.atBottomStateChange(true);
      });
      expect(result.current.isAtBottom).toBe(true);
    });

    test("updates isAtBottomRef in sync with isAtBottom", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      // Initially true
      expect(result.current.isAtBottomRef.current).toBe(true);

      act(() => {
        result.current.scrollProps.atBottomStateChange(false);
      });
      expect(result.current.isAtBottomRef.current).toBe(false);

      act(() => {
        result.current.scrollProps.atBottomStateChange(true);
      });
      expect(result.current.isAtBottomRef.current).toBe(true);
    });
  });

  describe("followOutput", () => {
    test("returns 'auto' when isAtBottom is true", () => {
      // Never "smooth": a native smooth scroll restarts its easing every time
      // Virtuoso re-issues it, so it never converges while tokens stream and
      // the tail visibly bobs. Instant follow is what reads as smooth.
      const { result } = renderHook(() => useVirtuosoScrollState());
      expect(result.current.scrollProps.followOutput(true)).toBe("auto");
    });

    test("returns 'auto' while stick intent is still true even if not at bottom", () => {
      // Content growth can push the viewport off-bottom without disengaging
      // stick intent. followOutput should still auto-scroll.
      const { result } = renderHook(() => useVirtuosoScrollState());
      act(() => {
        result.current.scrollProps.atBottomStateChange(false);
      });
      expect(result.current.scrollProps.followOutput(false)).toBe("auto");
    });

    test("returns false after a user-initiated scroll up releases stick intent", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());
      const el = document.createElement("div");
      document.body.appendChild(el);
      try {
        act(() => result.current.scrollProps.scrollerRef(el));
        act(() => {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });
        act(() => {
          result.current.scrollProps.atBottomStateChange(false);
        });
        expect(result.current.scrollProps.followOutput(false)).toBe(false);
      } finally {
        document.body.removeChild(el);
      }
    });
  });

  describe("scrollToBottom", () => {
    test("pins directly to the bottom when list height grows while sticky", () => {
      // Content growth must not go through the animated retry loop: that loop
      // holds scrollInFlightRef for its retries plus a 400ms watch window, so
      // every growth event in between was swallowed and the tail drifted.
      const { result } = renderHook(() => useVirtuosoScrollState());
      const el = makeScroller({ scrollHeight: 1200, clientHeight: 400 });

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      try {
        act(() => result.current.scrollProps.scrollerRef(el));

        act(() => {
          result.current.scrollProps.totalListHeightChanged(1200);
        });

        expect(el.scrollTop).toBe(800);
        expect(scrollToIndexCalls).toHaveLength(0);
        expect(scrollToCalls).toHaveLength(0);
      } finally {
        document.body.removeChild(el);
      }
    });

    test("falls back to the instant handle scroll when no scroller has mounted", async () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      act(() => {
        result.current.scrollProps.totalListHeightChanged(1200);
      });

      expect(scrollToIndexCalls).toHaveLength(1);

      act(() => {
        result.current.scrollProps.atBottomStateChange(true);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      // "auto", not "smooth" — this is content catching up, not a user journey.
      expect(scrollToCalls).toEqual([
        {
          top: 10_000_000,
          behavior: "auto",
        },
      ]);
    });

    test("does not scroll on total list height changes after user scrolls up", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());
      const el = document.createElement("div");
      document.body.appendChild(el);

      const scrollToIndexCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: () => {},
        getState: () => {},
      } as any;

      try {
        act(() => result.current.scrollProps.scrollerRef(el));
        act(() => {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });
        act(() => {
          result.current.scrollProps.totalListHeightChanged(1200);
        });

        expect(scrollToIndexCalls).toHaveLength(0);
      } finally {
        document.body.removeChild(el);
      }
    });

    test("does not scroll on total list height changes while inactive", () => {
      const { result } = renderHook(() =>
        useVirtuosoScrollState({ isActive: false })
      );

      const scrollToIndexCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: () => {},
        getState: () => {},
      } as any;

      act(() => {
        result.current.scrollProps.totalListHeightChanged(1200);
      });

      expect(scrollToIndexCalls).toHaveLength(0);
    });

    test("does not stack scrollToBottom calls while one is in-flight", async () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      // Stay non-bottom so the retry loop keeps scrollInFlightRef true.
      act(() => {
        result.current.scrollProps.atBottomStateChange(false);
      });

      const scrollToIndexCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: () => {},
        getState: () => {},
      } as any;

      act(() => {
        result.current.scrollToBottom();
      });
      const callsAfterStart = scrollToIndexCalls.length;
      expect(callsAfterStart).toBeGreaterThan(0);

      // Capture how many retry calls have accumulated, then fire
      // totalListHeightChanged a few times — the in-flight guard should
      // prevent any of them from kicking off a fresh scrollToBottom.
      act(() => {
        result.current.scrollProps.totalListHeightChanged(1200);
        result.current.scrollProps.totalListHeightChanged(1300);
        result.current.scrollProps.totalListHeightChanged(1400);
      });

      // The only scrollToIndex calls should come from the original retry
      // loop, not from the totalListHeightChanged invocations. Allow the
      // retry loop a single tick of slack so we capture its natural cadence,
      // not three extra immediate-from-totalListHeightChanged calls.
      const callsAfterTotalListHeight = scrollToIndexCalls.length;
      expect(callsAfterTotalListHeight - callsAfterStart).toBeLessThanOrEqual(1);
    });

    test("calls scrollToIndex then scrollTo on the virtuoso ref", async () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      act(() => {
        result.current.scrollToBottom();
      });

      // First attempt: instant scrollToIndex to force rendering at the end
      expect(scrollToIndexCalls).toHaveLength(1);
      expect(scrollToIndexCalls[0]).toEqual({
        index: "LAST",
        align: "end",
      });

      // Simulate Virtuoso firing atBottomStateChange(true) after rendering
      // the tail items, so the retry loop stops and moves to the scrollTo.
      act(() => {
        result.current.scrollProps.atBottomStateChange(true);
      });

      // Flush the setTimeout that schedules the footer scroll
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(scrollToCalls).toHaveLength(1);
      expect(scrollToCalls[0]).toEqual({
        top: 10_000_000,
        behavior: "smooth",
      });
    });

    test("retries scrollToIndex until reaching bottom (corrects estimated heights)", async () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      // Simulate the bug scenario: Virtuoso never reports isAtBottom=true
      // because estimated heights keep the scroll short of the true bottom.
      // The retry loop should fire scrollToIndex multiple times.
      act(() => {
        result.current.scrollProps.atBottomStateChange(false);
      });

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      act(() => {
        result.current.scrollToBottom();
      });

      // Each retry schedules the next one, so fixed wall-clock slack becomes
      // flaky when the full repository suite is competing for the event loop.
      await waitFor(() => {
        expect(scrollToIndexCalls).toHaveLength(10);
        expect(scrollToCalls).toHaveLength(1);
      }, {
        timeout: 2_000,
      });

      // Exhaustion: exactly MAX_ATTEMPTS (10) retries when isAtBottom never flips
      expect(scrollToIndexCalls).toHaveLength(10);
      // Even after exhausting retries, the footer scrollTo is still issued
      expect(scrollToCalls).toHaveLength(1);
    });

    test("ignores overlapping scrollToBottom invocations while one is in-flight", async () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      // Stay at non-bottom so the retry loop runs long enough to observe
      act(() => {
        result.current.scrollProps.atBottomStateChange(false);
      });

      const scrollToCalls: any[] = [];
      const scrollToIndexCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      act(() => {
        result.current.scrollToBottom();
        // Second call while the first is still iterating — should be ignored
        result.current.scrollToBottom();
        result.current.scrollToBottom();
      });

      // Gate on the retry counter, not on the footer scroll alone. `scrollTo`
      // fires once per chain at the very end, so waiting only for it to reach 1
      // would resolve the instant the *first* chain finished and never observe
      // the extra chains a broken guard would have started. Exactly MAX_ATTEMPTS
      // retries is only reachable when a single chain ran; three chains would
      // reach 30 and this condition would never hold.
      //
      // `scrollTo` is asserted inside the same wait because it lands a tick
      // after the tenth `scrollToIndex`. Reading it immediately after the wait
      // resolved made this test lose that race under load.
      await waitFor(() => {
        expect(scrollToIndexCalls).toHaveLength(10);
        expect(scrollToCalls).toHaveLength(1);
      }, {
        timeout: 2_000,
      });
    });

    test("can be invoked again after a previous scroll completes", async () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      // First invocation — let it complete via atBottomStateChange(true)
      act(() => {
        result.current.scrollToBottom();
      });
      act(() => {
        result.current.scrollProps.atBottomStateChange(true);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(scrollToCalls).toHaveLength(1);

      // Second invocation — should NOT be blocked by the in-flight guard
      act(() => {
        result.current.scrollToBottom();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(scrollToCalls).toHaveLength(2);
    });

    test("does not optimistically set isAtBottom", async () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      // First move away from bottom
      act(() => {
        result.current.scrollProps.atBottomStateChange(false);
      });
      expect(result.current.isAtBottom).toBe(false);

      // Provide a mock ref
      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: () => {},
        getState: () => {},
      } as any;

      // scrollToBottom should NOT set isAtBottom to true
      act(() => {
        result.current.scrollToBottom();
      });
      expect(result.current.isAtBottom).toBe(false);
    });

    test("is a no-op when virtuosoRef is null", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      // Should not throw when ref is null
      act(() => {
        result.current.scrollToBottom();
      });
      expect(result.current.isAtBottom).toBe(true);
    });

    test("is a no-op when the virtuoso handle is incomplete", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      const scrollToIndexCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        getState: () => {},
      } as any;

      act(() => {
        result.current.scrollToBottom();
      });

      expect(scrollToIndexCalls).toHaveLength(0);
      expect(result.current.isAtBottom).toBe(true);
    });

    test("scheduled scrollTo does not fire after unmount", async () => {
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());

      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      // Start the scroll — first scrollToIndex fires synchronously, the
      // follow-up retry/scrollTo is scheduled on setTimeout.
      act(() => {
        result.current.scrollToBottom();
      });

      // Unmount before the scheduled callback fires
      unmount();

      // Flush any pending setTimeout — scrollTo should NOT be called
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });

      expect(scrollToCalls).toHaveLength(0);
    });
  });

  describe("ResizeObserver fallback", () => {
    test("observes subtree mutations and pins while sticky", () => {
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });
      const directChild = document.createElement("div");
      scroller.appendChild(directChild);

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));

        expect(harness.resizeObserved).toContain(directChild);
        expect(harness.mutationObserveCalls).toEqual([
          {
            target: scroller,
            options: { childList: true, subtree: true },
          },
        ]);
        expect(harness.mutationCallback).toBeDefined();

        act(() => {
          harness.mutationCallback?.([], {} as MutationObserver);
        });

        // The mutation callback runs at a microtask checkpoint, while layout
        // is still dirty from the commit that mutated the DOM. Measuring there
        // would force a reflow, so the pin is deferred to the ResizeObserver
        // delivery for the same frame.
        expect(scroller.scrollTop).toBe(0);

        act(() => {
          harness.resizeCallback?.([], {} as ResizeObserver);
        });

        // Pinned synchronously inside the resize callback — no animation and
        // no trip through the handle-driven retry loop.
        expect(scroller.scrollTop).toBe(700);
        expect(scrollToIndexCalls).toHaveLength(0);
        expect(scrollToCalls).toHaveLength(0);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("pins when ResizeObserver fires while at bottom and sticky", () => {
      // Locks in the contract that footer-only growth (which leaves Virtuoso
      // reporting atBottom=true) still triggers a follow-up scroll. The
      // earlier implementation short-circuited on isAtBottomRef.current, which
      // missed late-rendering footer content because followOutput only fires
      // on data-item changes.
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });
      scroller.appendChild(document.createElement("div"));

      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: () => {},
        getState: () => {},
      } as any;

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        // Default state: isAtBottom=true, wantsStick=true.
        expect(result.current.isAtBottom).toBe(true);

        act(() => {
          harness.resizeCallback?.([], {} as ResizeObserver);
        });

        expect(scroller.scrollTop).toBe(700);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("does not pin on content growth after a user scrolls up", () => {
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });
      scroller.appendChild(document.createElement("div"));

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        act(() => {
          scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });

        act(() => {
          harness.resizeCallback?.([], {} as ResizeObserver);
        });

        expect(scroller.scrollTop).toBe(0);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("skips re-observing direct children on deep subtree mutations", () => {
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });
      const directChild = document.createElement("div");
      const grandchild = document.createElement("span");
      directChild.appendChild(grandchild);
      scroller.appendChild(directChild);

      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: () => {},
        getState: () => {},
      } as any;

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));

        // After mounting, the only observed element is the existing direct
        // child. Capture that baseline before firing the deep mutation.
        const observedBeforeDeepMutation = harness.resizeObserved.length;
        expect(observedBeforeDeepMutation).toBe(1);

        // Add a new grandchild and dispatch a record whose target is the
        // direct child (not the scroller) — observeChildren() should NOT run.
        const newGrandchild = document.createElement("em");
        directChild.appendChild(newGrandchild);
        const deepRecord = {
          type: "childList",
          target: directChild,
          addedNodes: [newGrandchild] as unknown as NodeList,
          removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord;

        act(() => {
          harness.mutationCallback?.([deepRecord], {} as MutationObserver);
        });

        // observeChildren() must not have re-walked: still just the original
        // direct child, no new observe() entries.
        expect(harness.resizeObserved.length).toBe(observedBeforeDeepMutation);
        // The growth follow must still have been scheduled, so the resize
        // delivery for this frame pins.
        act(() => {
          harness.resizeCallback?.([], {} as ResizeObserver);
        });
        expect(scroller.scrollTop).toBe(700);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("re-observes direct children when a direct child is added", () => {
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = document.createElement("div");
      const initialChild = document.createElement("div");
      scroller.appendChild(initialChild);
      document.body.appendChild(scroller);

      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: () => {},
        getState: () => {},
      } as any;

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        expect(harness.resizeObserved).toEqual([initialChild]);

        const newChild = document.createElement("div");
        scroller.appendChild(newChild);
        const directRecord = {
          type: "childList",
          target: scroller,
          addedNodes: [newChild] as unknown as NodeList,
          removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord;

        act(() => {
          harness.mutationCallback?.([directRecord], {} as MutationObserver);
        });

        expect(harness.resizeObserved).toEqual([initialChild, newChild]);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("pins on the next frame when a mutation produces no resize notification", async () => {
      // Backstop for growth ResizeObserver cannot see (margin-only growth).
      // One frame late is the cost; never pinning at all would be worse.
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });
      scroller.appendChild(document.createElement("div"));

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));

        act(() => {
          harness.mutationCallback?.([], {} as MutationObserver);
        });
        expect(scroller.scrollTop).toBe(0);

        await act(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        });

        expect(scroller.scrollTop).toBe(700);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("a resize delivery consumes the mutation's queued backstop frame", async () => {
      // The backstop exists only for growth ResizeObserver cannot see. Leaving
      // it queued after a real resize landed would measure a second time every
      // frame, which is the forced-reflow cost the deferral exists to avoid.
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });
      scroller.appendChild(document.createElement("div"));

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));

        act(() => {
          harness.mutationCallback?.([], {} as MutationObserver);
        });
        act(() => {
          harness.resizeCallback?.([], {} as ResizeObserver);
        });
        expect(scroller.scrollTop).toBe(700);

        // Move the viewport without touching stick intent, so a surviving
        // backstop would be visible as a second pin back to 700.
        scroller.scrollTop = 400;

        await act(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        });

        expect(scroller.scrollTop).toBe(400);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("never pins upward when the viewport already sits past the target", () => {
      // pinToBottom's downward-only guard. Content shrinking is clamped by the
      // browser; pulling the viewport *up* here would fight a user mid-scroll.
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });
      scroller.appendChild(document.createElement("div"));

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        // Past the 700 target, with stick intent still engaged.
        scroller.scrollTop = 900;

        act(() => {
          harness.resizeCallback?.([], {} as ResizeObserver);
        });

        expect(scroller.scrollTop).toBe(900);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("does not pin content growth while the view is inactive", () => {
      // The scroller stays mounted when a tab goes inactive, so the isActive
      // guard is the only thing stopping a background view from scrolling.
      const harness = installObservers();
      const { result, unmount } = renderHook(() =>
        useVirtuosoScrollState({ isActive: false })
      );
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });
      scroller.appendChild(document.createElement("div"));

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));

        act(() => {
          harness.resizeCallback?.([], {} as ResizeObserver);
        });

        expect(scroller.scrollTop).toBe(0);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("does not pin content growth while a user-initiated scroll is in flight", () => {
      // The smooth scroll-down-button journey owns the viewport until its
      // retry loop and watch window finish; pinning underneath it would
      // teleport past the animation the user asked for.
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });
      scroller.appendChild(document.createElement("div"));

      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: () => {},
        getState: () => {},
      } as any;

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        // Stay off-bottom so the retry loop holds scrollInFlightRef.
        act(() => {
          result.current.scrollProps.atBottomStateChange(false);
        });
        act(() => {
          result.current.scrollToBottom();
        });

        act(() => {
          harness.resizeCallback?.([], {} as ResizeObserver);
        });

        expect(scroller.scrollTop).toBe(0);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });
  });

  describe("user scroll-up detection", () => {
    test("releases stick intent when the scrollbar is dragged up", () => {
      // Dragging the scrollbar fires no wheel, touch or key event. Without the
      // drag listener the user stays flagged sticky and is pinned straight
      // back to the bottom on the next token.
      const { result } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        scroller.scrollTop = 700;
        act(() => {
          scroller.dispatchEvent(new Event("scroll"));
        });

        act(() => {
          scroller.dispatchEvent(new Event("pointerdown"));
        });
        // Drag well clear of the bottom.
        scroller.scrollTop = 200;
        act(() => {
          scroller.dispatchEvent(new Event("scroll"));
        });

        expect(result.current.scrollProps.followOutput(false)).toBe(false);
      } finally {
        document.body.removeChild(scroller);
      }
    });

    test("keeps stick intent for an upward scroll with no pointer held", () => {
      // Virtuoso corrects over-estimated heights after restoring a snapshot,
      // which moves scrollTop up with no user involved. Treating that as
      // intent would silently stop auto-follow on mount.
      const { result } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        scroller.scrollTop = 700;
        act(() => {
          scroller.dispatchEvent(new Event("scroll"));
        });

        scroller.scrollTop = 200;
        act(() => {
          scroller.dispatchEvent(new Event("scroll"));
        });

        expect(result.current.scrollProps.followOutput(false)).toBe("auto");
      } finally {
        document.body.removeChild(scroller);
      }
    });

    test("stops treating scrolls as a drag once the pointer is released", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        scroller.scrollTop = 700;
        act(() => {
          scroller.dispatchEvent(new Event("scroll"));
          scroller.dispatchEvent(new Event("pointerdown"));
          // Released over the page, not the scroller — hence the window
          // listener rather than an element one.
          window.dispatchEvent(new Event("pointerup"));
        });

        scroller.scrollTop = 200;
        act(() => {
          scroller.dispatchEvent(new Event("scroll"));
        });

        expect(result.current.scrollProps.followOutput(false)).toBe("auto");
      } finally {
        document.body.removeChild(scroller);
      }
    });

    test("keeps stick intent when our own pin scrolls down", () => {
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });
      scroller.appendChild(document.createElement("div"));

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        act(() => {
          harness.resizeCallback?.([], {} as ResizeObserver);
        });
        expect(scroller.scrollTop).toBe(700);

        // Even with the pointer held (the user resting on the scrollbar), the
        // pin's own downward scroll event must not read as them leaving.
        act(() => {
          scroller.dispatchEvent(new Event("pointerdown"));
          scroller.dispatchEvent(new Event("scroll"));
        });

        expect(result.current.scrollProps.followOutput(false)).toBe("auto");
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("keeps stick intent when the drag moves down, even short of the bottom", () => {
      // Only *upward* movement is a signal to stop following. Dragging toward
      // the bottom is the opposite intent, and lands away from it on the way.
      const { result } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        scroller.scrollTop = 100;
        act(() => {
          scroller.dispatchEvent(new Event("scroll"));
          scroller.dispatchEvent(new Event("pointerdown"));
        });

        // Downward, but still 300px clear of the 700 bottom.
        scroller.scrollTop = 400;
        act(() => {
          scroller.dispatchEvent(new Event("scroll"));
        });

        expect(result.current.scrollProps.followOutput(false)).toBe("auto");
      } finally {
        document.body.removeChild(scroller);
      }
    });

    test("keeps stick intent when a drag drops scrollTop but stays at the bottom", () => {
      // A growing viewport (window resize) clamps scrollTop downward while
      // leaving the user at the bottom. That is not intent to stop following.
      const { result } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        scroller.scrollTop = 700;
        act(() => {
          scroller.dispatchEvent(new Event("scroll"));
          scroller.dispatchEvent(new Event("pointerdown"));
        });

        // Still within AT_BOTTOM_THRESHOLD (50px) of the 700 target.
        scroller.scrollTop = 670;
        act(() => {
          scroller.dispatchEvent(new Event("scroll"));
        });

        expect(result.current.scrollProps.followOutput(false)).toBe("auto");
      } finally {
        document.body.removeChild(scroller);
      }
    });

    test("releases stick intent on an upward touch drag", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        scroller.scrollTop = 700;

        act(() => {
          scroller.dispatchEvent(new Event("touchstart"));
        });
        scroller.scrollTop = 690;
        act(() => {
          scroller.dispatchEvent(new Event("touchmove"));
        });

        expect(result.current.scrollProps.followOutput(false)).toBe(false);
      } finally {
        document.body.removeChild(scroller);
      }
    });

    test("keeps stick intent on a downward touch drag", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        scroller.scrollTop = 500;

        act(() => {
          scroller.dispatchEvent(new Event("touchstart"));
        });
        scroller.scrollTop = 560;
        act(() => {
          scroller.dispatchEvent(new Event("touchmove"));
        });

        expect(result.current.scrollProps.followOutput(false)).toBe("auto");
      } finally {
        document.body.removeChild(scroller);
      }
    });

    test.each(["ArrowUp", "PageUp", "Home"])(
      "releases stick intent on %s",
      (key) => {
        const { result } = renderHook(() => useVirtuosoScrollState());
        const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });

        try {
          act(() => result.current.scrollProps.scrollerRef(scroller));
          act(() => {
            scroller.dispatchEvent(new KeyboardEvent("keydown", { key }));
          });

          expect(result.current.scrollProps.followOutput(false)).toBe(false);
        } finally {
          document.body.removeChild(scroller);
        }
      }
    );

    test.each(["ArrowDown", "PageDown", "End"])(
      "keeps stick intent on %s",
      (key) => {
        const { result } = renderHook(() => useVirtuosoScrollState());
        const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });

        try {
          act(() => result.current.scrollProps.scrollerRef(scroller));
          act(() => {
            scroller.dispatchEvent(new KeyboardEvent("keydown", { key }));
          });

          expect(result.current.scrollProps.followOutput(false)).toBe("auto");
        } finally {
          document.body.removeChild(scroller);
        }
      }
    );

    test("stops releasing stick intent after the scroller is detached", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());
      const scroller = makeScroller({ scrollHeight: 1000, clientHeight: 300 });

      try {
        act(() => result.current.scrollProps.scrollerRef(scroller));
        act(() => result.current.scrollProps.scrollerRef(null));

        act(() => {
          scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });

        expect(result.current.scrollProps.followOutput(false)).toBe("auto");
      } finally {
        document.body.removeChild(scroller);
      }
    });
  });

  describe("scroll state persistence", () => {
    test("persists and restores a real getState snapshot when user had scrolled up", () => {
      const mockSnapshot: StateSnapshot = {
        // react-virtuoso represents the size tree's terminal entry as an
        // open-ended range. Losing this snapshot regresses every persisted
        // transcript to a mount-from-top instead of restoring the user's view.
        ranges: [{ startIndex: 0, endIndex: Number.POSITIVE_INFINITY, size: 34 }],
        scrollTop: 500,
      };
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({ isActive, persistKey: "test-key" }),
        { initialProps: { isActive: true } }
      );

      // Simulate a user scroll up so stick intent is released; the snapshot
      // should then be restored on remount.
      const el = document.createElement("div");
      document.body.appendChild(el);
      try {
        act(() => result.current.scrollProps.scrollerRef(el));
        act(() => {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });

        result.current.virtuosoRef.current = {
          scrollToIndex: () => {},
          getState: (cb: (state: any) => void) => cb(mockSnapshot),
        } as any;

        rerender({ isActive: false });

        const { result: result2 } = renderHook(() =>
          useVirtuosoScrollState({ persistKey: "test-key" })
        );
        expect(result2.current.scrollProps.restoreStateFrom).toEqual(
          mockSnapshot,
        );
      } finally {
        document.body.removeChild(el);
      }
    });

    test("restores snapshot even when user was sticky (avoids mount-from-top flash)", () => {
      // Locks in the contract that the persisted snapshot is always restored
      // when one exists. For sticky users, this lands them at the previous
      // bottom (no flash from the top of the list); the activation effect on
      // a subsequent re-activation handles jumping to any newer bottom.
      const mockSnapshot = { ranges: [], scrollTop: 500 } as any;
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({ isActive, persistKey: "sticky-key" }),
        { initialProps: { isActive: true } }
      );

      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        getState: (cb: (state: any) => void) => cb(mockSnapshot),
      } as any;

      // Default intent is sticky; deactivating persists {snapshot, wantsStick:true}.
      rerender({ isActive: false });

      const { result: result2 } = renderHook(() =>
        useVirtuosoScrollState({ persistKey: "sticky-key" })
      );
      expect(result2.current.scrollProps.restoreStateFrom).toEqual(mockSnapshot);
      clearPersistedVirtuosoState("sticky-key");
    });

    test("does not persist when no persistKey is provided", () => {
      const { result, rerender } = renderHook(
        ({ isActive }) => useVirtuosoScrollState({ isActive }),
        { initialProps: { isActive: true } }
      );

      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        getState: (cb: (state: any) => void) =>
          cb({ ranges: [], scrollTop: 100 }),
      } as any;

      rerender({ isActive: false });

      // A new hook with a fresh key should have no restore state
      const { result: result2 } = renderHook(() =>
        useVirtuosoScrollState({ persistKey: "no-state-here" })
      );
      expect(result2.current.scrollProps.restoreStateFrom).toBeUndefined();
    });

    test("jumps to bottom instantly on re-activation when sticky", async () => {
      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({ isActive, persistKey: "reactivate-key" }),
        { initialProps: { isActive: true } }
      );

      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: (cb: (state: any) => void) =>
          cb({ ranges: [], scrollTop: 100 } as any),
      } as any;

      // Deactivate (persists wantsStick=true) then re-activate.
      rerender({ isActive: false });
      const before = scrollToIndexCalls.length;
      rerender({ isActive: true });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      // Re-activation issues an instant scrollToIndex + scrollTo (auto, not
      // smooth). The smooth retry loop is intentionally NOT used here.
      expect(scrollToIndexCalls.length - before).toBe(1);
      expect(scrollToCalls).toEqual([
        { top: 10_000_000, behavior: "auto" },
      ]);

      clearPersistedVirtuosoState("reactivate-key");
    });

    test("clears stale scrollInFlightRef on re-activation (deadlock recovery)", async () => {
      // Regression: if a smooth scrollToBottom was in flight when the user
      // switched tabs, scrollInFlightRef could remain true on return,
      // causing the scroll-down button click and totalListHeightChanged to
      // silently no-op. Re-activation must reset that flag.
      const { result, rerender } = renderHook(
        ({ isActive }) => useVirtuosoScrollState({ isActive }),
        { initialProps: { isActive: true } }
      );

      const scrollToIndexCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: () => {},
        getState: () => {},
      } as any;

      const el = document.createElement("div");
      document.body.appendChild(el);
      try {
        act(() => result.current.scrollProps.scrollerRef(el));

        // Start a scroll. This sets both wantsStickRef=true AND
        // scrollInFlightRef=true and fires one scrollToIndex.
        act(() => {
          result.current.scrollToBottom();
        });

        // Now flip wantsStick back to false via a wheel-up. This isolates
        // the flag-reset behavior: with wantsStick=false at re-activation,
        // the activation effect must NOT itself fire a scroll, so any new
        // scrollToIndex calls after re-activation come solely from our own
        // scrollToBottom() — which proves scrollInFlightRef was cleared.
        act(() => {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });

        // Deactivate before the in-flight retry loop resolves — leaves
        // scrollInFlightRef stuck true.
        rerender({ isActive: false });

        const callsBeforeReactivation = scrollToIndexCalls.length;

        // Re-activate, then flush any pending rAF/timers. Because
        // wantsStick=false the activation effect's rAF body is a no-op
        // beyond the flag reset, so the call count must not change.
        rerender({ isActive: true });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        expect(scrollToIndexCalls.length).toBe(callsBeforeReactivation);

        // Subsequent scrollToBottom must succeed (one new scrollToIndex)
        // because the in-flight flag was cleared on re-activation.
        act(() => {
          result.current.scrollToBottom();
        });
        expect(scrollToIndexCalls.length).toBe(callsBeforeReactivation + 1);
      } finally {
        document.body.removeChild(el);
      }
    });

    test("does not scroll on first activation when sticky (Virtuoso handles initial position)", async () => {
      // The activation effect must skip the very first time isActive becomes
      // true: Virtuoso handles initial position via restoreStateFrom, and
      // firing an extra scrollToIndex on top of that would either fight the
      // restore or scroll past intended initial position.
      const mockSnapshot = { ranges: [], scrollTop: 500 } as any;

      // Seed persisted sticky state so a fresh mount sees wantsStick=true.
      const { result: seedResult, rerender: seedRerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({ isActive, persistKey: "first-mount-key" }),
        { initialProps: { isActive: true } }
      );
      seedResult.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: () => {},
        getState: (cb: (state: any) => void) => cb(mockSnapshot),
      } as any;
      seedRerender({ isActive: false });

      // Fresh mount with isActive=true. wantsStick=true is restored from
      // the persisted entry, but this is the *first* activation.
      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      const { result } = renderHook(() =>
        useVirtuosoScrollState({ isActive: true, persistKey: "first-mount-key" })
      );
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      // restoreStateFrom must be present (sticky restore).
      expect(result.current.scrollProps.restoreStateFrom).toEqual(mockSnapshot);

      // Flush any rAF the activation effect might schedule. It must not
      // fire a scroll on first activation.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(scrollToIndexCalls.length).toBe(0);
      expect(scrollToCalls.length).toBe(0);

      clearPersistedVirtuosoState("first-mount-key");
    });

    test("does not scroll on re-activation when wantsStick is false", async () => {
      // Symmetric to the sticky-jump test: when the user had scrolled up
      // before leaving, the activation effect must NOT fire a scroll on
      // return — it should only reset scrollInFlightRef and exit.
      const { result, rerender } = renderHook(
        ({ isActive }) => useVirtuosoScrollState({ isActive }),
        { initialProps: { isActive: true } }
      );

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      const el = document.createElement("div");
      document.body.appendChild(el);
      try {
        // Release stick intent via a wheel-up.
        act(() => result.current.scrollProps.scrollerRef(el));
        act(() => {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });

        rerender({ isActive: false });
        rerender({ isActive: true });

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });

        expect(scrollToIndexCalls.length).toBe(0);
        expect(scrollToCalls.length).toBe(0);
      } finally {
        document.body.removeChild(el);
      }
    });

    test("stickToBottomOnActivation jumps and re-engages stick even after user scrolled up", async () => {
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({
            isActive,
            stickToBottomOnActivation: true,
          }),
        { initialProps: { isActive: false } }
      );

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      const el = document.createElement("div");
      document.body.appendChild(el);
      try {
        act(() => result.current.scrollProps.scrollerRef(el));
        act(() => {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });
        expect(result.current.scrollProps.followOutput(false)).toBe(false);

        rerender({ isActive: true });

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });

        expect(scrollToIndexCalls).toEqual([{ index: "LAST", align: "end" }]);
        expect(scrollToCalls).toEqual([
          { top: 10_000_000, behavior: "auto" },
        ]);
        expect(result.current.scrollProps.followOutput(false)).toBe("auto");
      } finally {
        document.body.removeChild(el);
      }
    });

    test("stickToBottomOnActivation waits for Virtuoso to mount after activation", async () => {
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({
            isActive,
            stickToBottomOnActivation: true,
          }),
        { initialProps: { isActive: false } }
      );

      rerender({ isActive: true });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      const scroller = document.createElement("div");
      document.body.appendChild(scroller);

      try {
        result.current.virtuosoRef.current = {
          scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
          scrollTo: (opts: any) => scrollToCalls.push(opts),
          getState: () => {},
        } as any;

        act(() => {
          result.current.scrollProps.scrollerRef(scroller);
        });

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });

        expect(scrollToIndexCalls).toEqual([{ index: "LAST", align: "end" }]);
        expect(scrollToCalls).toEqual([
          { top: 10_000_000, behavior: "auto" },
        ]);
      } finally {
        document.body.removeChild(scroller);
      }
    });

    test("keeps retrying until the Virtuoso handle is ready while the scroller stays mounted", async () => {
      // Covers the retry branch where the scroller is present at activation but
      // the Virtuoso handle only becomes ready a few frames later. A controlled
      // getter simulates the handle arriving on the 4th readiness check, which
      // is deterministic regardless of the (near-instant) happy-dom rAF timing.
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({
            isActive,
            stickToBottomOnActivation: true,
          }),
        { initialProps: { isActive: false } }
      );

      const scroller = document.createElement("div");
      document.body.appendChild(scroller);
      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      const realHandle = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      };

      let reads = 0;
      const READY_AFTER = 3;
      Object.defineProperty(result.current.virtuosoRef, "current", {
        configurable: true,
        get() {
          reads += 1;
          return reads > READY_AFTER ? realHandle : null;
        },
        set() {},
      });

      try {
        // Scroller mounts first, then the tab activates.
        act(() => {
          result.current.scrollProps.scrollerRef(scroller);
        });
        rerender({ isActive: true });

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });

        // The handle became ready on a later retry, so exactly one activation
        // scroll fired once it was available.
        expect(reads).toBeGreaterThan(READY_AFTER);
        expect(scrollToIndexCalls).toEqual([{ index: "LAST", align: "end" }]);
        expect(scrollToCalls).toEqual([{ top: 10_000_000, behavior: "auto" }]);
      } finally {
        Object.defineProperty(result.current.virtuosoRef, "current", {
          configurable: true,
          writable: true,
          value: null,
        });
        document.body.removeChild(scroller);
      }
    });

    test("clears pending activation scroll after readiness retries are exhausted (no stale re-fire on scroller remount)", async () => {
      // Covers the exhaustion branch: the scroller is present but the handle
      // never becomes ready within the retry budget. The pending flag must be
      // cleared so a later scroller remount can't re-fire the stale activation
      // scroll and yank a user who has since scrolled up back to the bottom.
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({
            isActive,
            stickToBottomOnActivation: true,
          }),
        { initialProps: { isActive: false } }
      );

      const scroller = document.createElement("div");
      const remount = document.createElement("div");
      document.body.appendChild(scroller);
      document.body.appendChild(remount);

      try {
        // Activate, then mount the scroller — but never provide a handle, so
        // every readiness check fails until the retry budget is exhausted.
        rerender({ isActive: true });
        act(() => {
          result.current.scrollProps.scrollerRef(scroller);
        });

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });

        // The handle is now ready and the scroller remounts. Because the
        // pending flag was cleared on exhaustion, this must NOT fire a scroll.
        const scrollToIndexCalls: any[] = [];
        const scrollToCalls: any[] = [];
        result.current.virtuosoRef.current = {
          scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
          scrollTo: (opts: any) => scrollToCalls.push(opts),
          getState: () => {},
        } as any;

        act(() => {
          result.current.scrollProps.scrollerRef(remount);
        });

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });

        expect(scrollToIndexCalls).toEqual([]);
        expect(scrollToCalls).toEqual([]);
      } finally {
        document.body.removeChild(scroller);
        document.body.removeChild(remount);
      }
    });

    test("fires only one activation scroll when both activation effects run on the same transition", async () => {
      // Both the activation effect and the scroller-keyed effect run on the
      // false→true transition. The rAF double-schedule guard must collapse them
      // into a single scroll rather than stacking two.
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({
            isActive,
            stickToBottomOnActivation: true,
          }),
        { initialProps: { isActive: false } }
      );

      const scroller = document.createElement("div");
      document.body.appendChild(scroller);
      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];

      try {
        // Both the scroller and the handle are ready before activation.
        result.current.virtuosoRef.current = {
          scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
          scrollTo: (opts: any) => scrollToCalls.push(opts),
          getState: () => {},
        } as any;
        act(() => {
          result.current.scrollProps.scrollerRef(scroller);
        });

        rerender({ isActive: true });

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });

        expect(scrollToIndexCalls).toEqual([{ index: "LAST", align: "end" }]);
        expect(scrollToCalls).toEqual([{ top: 10_000_000, behavior: "auto" }]);
      } finally {
        document.body.removeChild(scroller);
      }
    });

    test("cancels pending activation scroll if isActive flips false before rAF fires", async () => {
      // The activation effect schedules its instant jump via rAF and
      // returns a cleanup that cancels it. If the user toggles tabs again
      // before the rAF body runs, the scroll must not fire.
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({ isActive, persistKey: "cancel-raf-key" }),
        { initialProps: { isActive: true } }
      );

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: (cb: (state: any) => void) =>
          cb({ ranges: [], scrollTop: 100 } as any),
      } as any;

      // Deactivate (persists wantsStick=true), re-activate, then immediately
      // deactivate again — all synchronously, before the activation rAF
      // can fire. The cleanup must cancel the scheduled scroll.
      rerender({ isActive: false });
      rerender({ isActive: true });
      rerender({ isActive: false });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      expect(scrollToIndexCalls.length).toBe(0);
      expect(scrollToCalls.length).toBe(0);

      clearPersistedVirtuosoState("cancel-raf-key");
    });

    test("does not persist when isActive stays true", () => {
      const getStateCalls: number[] = [];
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({ isActive, persistKey: "test-key" }),
        { initialProps: { isActive: true } }
      );

      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        getState: () => {
          getStateCalls.push(1);
        },
      } as any;

      // Rerender while still active
      rerender({ isActive: true });

      expect(getStateCalls).toHaveLength(0);
    });
  });

  describe("environment switch handling", () => {
    function makeHandle(
      scrollToIndexCalls: any[],
      scrollToCalls: any[]
    ) {
      return {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: (cb: (state: any) => void) =>
          cb({ ranges: [], scrollTop: 100 } as any),
      } as any;
    }

    test("jumps to bottom on re-activation after env switch even when user had scrolled up", async () => {
      useUIStore.setState({ selectedEnvironmentId: "env-1" });
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({ isActive, environmentId: "env-1" }),
        { initialProps: { isActive: true } }
      );

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = makeHandle(
        scrollToIndexCalls,
        scrollToCalls
      );

      const el = document.createElement("div");
      document.body.appendChild(el);
      try {
        // Release stick intent via a wheel-up: without an env switch this
        // would suppress the re-activation jump.
        act(() => result.current.scrollProps.scrollerRef(el));
        act(() => {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });

        // Switch environments away and back while the view is inactive.
        act(() => {
          useUIStore.setState({ selectedEnvironmentId: "env-2" });
        });
        rerender({ isActive: false });
        act(() => {
          useUIStore.setState({ selectedEnvironmentId: "env-1" });
        });
        rerender({ isActive: true });

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });

        // The env switch forces the jump despite wantsStick=false.
        expect(scrollToIndexCalls.length).toBeGreaterThanOrEqual(1);
        expect(scrollToIndexCalls[0]).toEqual({ index: "LAST", align: "end" });
        expect(scrollToCalls[scrollToCalls.length - 1]).toEqual({
          top: 10_000_000,
          behavior: "auto",
        });
        // The forced jump also re-engages stick intent.
        expect(result.current.scrollProps.followOutput(false)).toBe("auto");
      } finally {
        document.body.removeChild(el);
        useUIStore.setState({ selectedEnvironmentId: null });
      }
    });

    test("does not jump on within-environment tab switch when user had scrolled up", async () => {
      useUIStore.setState({ selectedEnvironmentId: "env-1" });
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({ isActive, environmentId: "env-1" }),
        { initialProps: { isActive: true } }
      );

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = makeHandle(
        scrollToIndexCalls,
        scrollToCalls
      );

      const el = document.createElement("div");
      document.body.appendChild(el);
      try {
        act(() => result.current.scrollProps.scrollerRef(el));
        act(() => {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });

        // Deactivate/re-activate without any environment change (simulates
        // switching to another tab in the same environment and back).
        rerender({ isActive: false });
        rerender({ isActive: true });

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });

        expect(scrollToIndexCalls.length).toBe(0);
        expect(scrollToCalls.length).toBe(0);
      } finally {
        document.body.removeChild(el);
        useUIStore.setState({ selectedEnvironmentId: null });
      }
    });

    test("retries the activation jump until Virtuoso reports at-bottom", async () => {
      // After an environment switch, items outside the rendered window have
      // estimated heights, so a one-shot jump can land short. The activation
      // jump must keep retrying scrollToIndex until isAtBottom flips.
      useUIStore.setState({ selectedEnvironmentId: "env-1" });
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({ isActive, environmentId: "env-1" }),
        { initialProps: { isActive: true } }
      );

      const scrollToIndexCalls: any[] = [];
      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = makeHandle(
        scrollToIndexCalls,
        scrollToCalls
      );

      try {
        // Simulate not-at-bottom (estimated heights keep landing short).
        act(() => {
          result.current.scrollProps.atBottomStateChange(false);
        });

        act(() => {
          useUIStore.setState({ selectedEnvironmentId: "env-2" });
        });
        rerender({ isActive: false });
        act(() => {
          useUIStore.setState({ selectedEnvironmentId: "env-1" });
        });
        rerender({ isActive: true });

        // Let several retry iterations elapse (16ms apart).
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        expect(scrollToIndexCalls.length).toBeGreaterThan(1);

        // Once Virtuoso reports at-bottom, the loop finishes with an instant
        // footer scroll.
        act(() => {
          result.current.scrollProps.atBottomStateChange(true);
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        expect(scrollToCalls[scrollToCalls.length - 1]).toEqual({
          top: 10_000_000,
          behavior: "auto",
        });
      } finally {
        useUIStore.setState({ selectedEnvironmentId: null });
      }
    });
  });

  describe("persisted stick intent regression", () => {
    test("persisted wantsStick=false does not get re-cleared when user later reaches bottom", () => {
      // Regression: an earlier implementation seeded stick intent via a
      // render-time conditional write. After atBottomStateChange(true)
      // re-engaged stick, the next render would see persisted.wantsStick=false
      // and clobber the ref back to false, silently breaking the
      // "reaching bottom re-engages stick" invariant.
      const mockSnapshot = { ranges: [], scrollTop: 500 } as any;
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({ isActive, persistKey: "regress-key" }),
        { initialProps: { isActive: true } }
      );

      const el = document.createElement("div");
      document.body.appendChild(el);
      try {
        // Release stick so the persisted entry records wantsStick=false.
        act(() => result.current.scrollProps.scrollerRef(el));
        act(() => {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });

        result.current.virtuosoRef.current = {
          scrollToIndex: () => {},
          getState: (cb: (state: any) => void) => cb(mockSnapshot),
        } as any;

        rerender({ isActive: false });

        // Remount: persisted has wantsStick=false, so restoreStateFrom is set
        // and initial followOutput(false) returns false.
        const { result: result2 } = renderHook(() =>
          useVirtuosoScrollState({ persistKey: "regress-key" })
        );
        expect(result2.current.scrollProps.followOutput(false)).toBe(false);

        // User scrolls to the bottom — stick should re-engage.
        act(() => {
          result2.current.scrollProps.atBottomStateChange(true);
        });

        // Rerender multiple times to catch any render-time clobber.
        act(() => {
          result2.current.scrollProps.atBottomStateChange(false);
        });
        act(() => {
          result2.current.scrollProps.atBottomStateChange(true);
        });
        act(() => {
          result2.current.scrollProps.atBottomStateChange(false);
        });

        // followOutput should still report stick intent true even though we're
        // not at bottom — this would fail if the render-time clobber returned.
        expect(result2.current.scrollProps.followOutput(false)).toBe("auto");
      } finally {
        document.body.removeChild(el);
        clearPersistedVirtuosoState("regress-key");
      }
    });
  });

  describe("scrollToBottom post-scroll watch window", () => {
    test("re-issues scrollTo when scrollHeight grows after landing at bottom", async () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      const el = document.createElement("div");
      let mockScrollHeight = 1000;
      Object.defineProperty(el, "scrollHeight", {
        get: () => mockScrollHeight,
        configurable: true,
      });
      document.body.appendChild(el);

      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      try {
        act(() => result.current.scrollProps.scrollerRef(el));

        act(() => {
          result.current.scrollToBottom();
        });

        // Let the initial retry → finish() fire the first scrollTo.
        act(() => {
          result.current.scrollProps.atBottomStateChange(true);
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        expect(scrollToCalls).toHaveLength(1);

        // Simulate late-rendering footer content growing the scroll height.
        // The watch loop runs on rAF; advance by waiting a couple of frames.
        mockScrollHeight = 1200;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
        });

        // The watch window should detect the scrollHeight change and re-issue
        // a smooth scrollTo so the new footer content stays in view.
        expect(scrollToCalls.length).toBeGreaterThanOrEqual(2);
        expect(scrollToCalls[scrollToCalls.length - 1]).toEqual({
          top: 10_000_000,
          behavior: "smooth",
        });
      } finally {
        document.body.removeChild(el);
      }
    });

    test("stops watching scrollHeight after the watch window expires", async () => {
      const { result } = renderHook(() => useVirtuosoScrollState());

      const el = document.createElement("div");
      let mockScrollHeight = 1000;
      Object.defineProperty(el, "scrollHeight", {
        get: () => mockScrollHeight,
        configurable: true,
      });
      document.body.appendChild(el);

      const scrollToCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      try {
        act(() => result.current.scrollProps.scrollerRef(el));

        act(() => {
          result.current.scrollToBottom();
        });
        act(() => {
          result.current.scrollProps.atBottomStateChange(true);
        });

        // Wait well past POST_SCROLL_WATCH_MS (400ms) so the window closes.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
        });
        const callsAfterWindow = scrollToCalls.length;

        // A growth after the window should NOT trigger another scrollTo.
        mockScrollHeight = 1500;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
        });
        expect(scrollToCalls.length).toBe(callsAfterWindow);
      } finally {
        document.body.removeChild(el);
      }
    });
  });

  describe("clearPersistedVirtuosoState", () => {
    test("clears persisted state for a given key", () => {
      const mockSnapshot = { ranges: [], scrollTop: 200 } as any;
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useVirtuosoScrollState({ isActive, persistKey: "test-key" }),
        { initialProps: { isActive: true } }
      );

      // Release stick intent so the snapshot will be restored on remount.
      const el = document.createElement("div");
      document.body.appendChild(el);
      try {
        act(() => result.current.scrollProps.scrollerRef(el));
        act(() => {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        });

        result.current.virtuosoRef.current = {
          scrollToIndex: () => {},
          getState: (cb: (state: any) => void) => cb(mockSnapshot),
        } as any;

        rerender({ isActive: false });

        const { result: before } = renderHook(() =>
          useVirtuosoScrollState({ persistKey: "test-key" })
        );
        expect(before.current.scrollProps.restoreStateFrom).toEqual(
          mockSnapshot,
        );

        clearPersistedVirtuosoState("test-key");

        const { result: after } = renderHook(() =>
          useVirtuosoScrollState({ persistKey: "test-key" })
        );
        expect(after.current.scrollProps.restoreStateFrom).toBeUndefined();
      } finally {
        document.body.removeChild(el);
      }
    });
  });

  describe("persisted state eviction", () => {
    /**
     * Persist one snapshot under `persistKey` by mounting active, then
     * deactivating — the deactivation effect is what writes the entry.
     */
    function persistSnapshot(persistKey: string, scrollTop: number) {
      const { result, rerender, unmount } = renderHook(
        ({ isActive }) => useVirtuosoScrollState({ isActive, persistKey }),
        { initialProps: { isActive: true } }
      );
      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: () => {},
        getState: (cb: (state: any) => void) =>
          cb({ ranges: [], scrollTop } as any),
      } as any;
      rerender({ isActive: false });
      unmount();
    }

    function isPersisted(persistKey: string) {
      const { result, unmount } = renderHook(() =>
        useVirtuosoScrollState({ persistKey })
      );
      const persisted = result.current.scrollProps.restoreStateFrom;
      unmount();
      return persisted !== undefined;
    }

    test("evicts the oldest entry once the 200-key cap is exceeded", () => {
      // Every chat tab in every environment gets its own key, so an unbounded
      // map would retain a snapshot per tab for the life of the process.
      persistSnapshot("evict-oldest", 10);
      expect(isPersisted("evict-oldest")).toBe(true);

      // MAX_PERSISTED_STATES is 200; fill past it.
      for (let i = 0; i < 200; i += 1) {
        persistSnapshot(`evict-filler-${i}`, i);
      }

      expect(isPersisted("evict-oldest")).toBe(false);
      expect(isPersisted("evict-filler-199")).toBe(true);

      for (let i = 0; i < 200; i += 1) {
        clearPersistedVirtuosoState(`evict-filler-${i}`);
      }
    });

    test("re-persisting a key refreshes its position in the eviction order", () => {
      // setPersistedState deletes before re-inserting so a key still in use
      // does not age out just because it was written early.
      persistSnapshot("evict-refreshed", 10);

      for (let i = 0; i < 150; i += 1) {
        persistSnapshot(`refresh-filler-${i}`, i);
      }

      // Touch it again, then push the total past the cap.
      persistSnapshot("evict-refreshed", 20);
      for (let i = 150; i < 260; i += 1) {
        persistSnapshot(`refresh-filler-${i}`, i);
      }

      expect(isPersisted("evict-refreshed")).toBe(true);
      expect(isPersisted("refresh-filler-0")).toBe(false);

      clearPersistedVirtuosoState("evict-refreshed");
      for (let i = 0; i < 260; i += 1) {
        clearPersistedVirtuosoState(`refresh-filler-${i}`);
      }
    });
  });

  describe("environment subscription lifecycle", () => {
    test("unsubscribes from the environment store when the view reactivates", () => {
      const subscribe = useUIStore.subscribe;
      let unsubscribeCalls = 0;
      const wrapped = ((listener: any) => {
        const unsubscribe = subscribe(listener);
        return () => {
          unsubscribeCalls += 1;
          unsubscribe();
        };
      }) as typeof useUIStore.subscribe;
      (useUIStore as any).subscribe = wrapped;

      try {
        const { rerender } = renderHook(
          ({ isActive }) =>
            useVirtuosoScrollState({ isActive, environmentId: "env-1" }),
          { initialProps: { isActive: false } }
        );
        expect(unsubscribeCalls).toBe(0);

        rerender({ isActive: true });

        // Reactivating tears down the inactive-period watcher; leaving it
        // attached would leak a listener per activation cycle.
        expect(unsubscribeCalls).toBe(1);
      } finally {
        (useUIStore as any).subscribe = subscribe;
      }
    });

    test("unsubscribes from the environment store on unmount", () => {
      const subscribe = useUIStore.subscribe;
      let unsubscribeCalls = 0;
      const wrapped = ((listener: any) => {
        const unsubscribe = subscribe(listener);
        return () => {
          unsubscribeCalls += 1;
          unsubscribe();
        };
      }) as typeof useUIStore.subscribe;
      (useUIStore as any).subscribe = wrapped;

      try {
        const { unmount } = renderHook(() =>
          useVirtuosoScrollState({ isActive: false, environmentId: "env-1" })
        );
        expect(unsubscribeCalls).toBe(0);

        unmount();

        expect(unsubscribeCalls).toBe(1);
      } finally {
        (useUIStore as any).subscribe = subscribe;
      }
    });

    test("does not subscribe when no environmentId is provided", () => {
      const subscribe = useUIStore.subscribe;
      let subscribeCalls = 0;
      const wrapped = ((listener: any) => {
        subscribeCalls += 1;
        return subscribe(listener);
      }) as typeof useUIStore.subscribe;
      (useUIStore as any).subscribe = wrapped;

      try {
        renderHook(() => useVirtuosoScrollState({ isActive: false }));
        expect(subscribeCalls).toBe(0);
      } finally {
        (useUIStore as any).subscribe = subscribe;
      }
    });
  });
});
