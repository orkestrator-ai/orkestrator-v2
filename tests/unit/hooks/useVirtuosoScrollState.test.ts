import { describe, test, expect, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import {
  useVirtuosoScrollState,
  clearPersistedVirtuosoState,
} from "@/hooks/useVirtuosoScrollState";
import { useUIStore } from "@/stores/uiStore";

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
    test("returns 'smooth' when isAtBottom is true", () => {
      const { result } = renderHook(() => useVirtuosoScrollState());
      expect(result.current.scrollProps.followOutput(true)).toBe("smooth");
    });

    test("returns 'smooth' while stick intent is still true even if not at bottom", () => {
      // Content growth can push the viewport off-bottom without disengaging
      // stick intent. followOutput should still auto-scroll.
      const { result } = renderHook(() => useVirtuosoScrollState());
      act(() => {
        result.current.scrollProps.atBottomStateChange(false);
      });
      expect(result.current.scrollProps.followOutput(false)).toBe("smooth");
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
    test("scrolls when total list height grows while sticky", async () => {
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

      expect(scrollToCalls).toEqual([
        {
          top: 10_000_000,
          behavior: "smooth",
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

      // Let all retries fire (10 attempts × 16ms + slack)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
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
      result.current.virtuosoRef.current = {
        scrollToIndex: () => {},
        scrollTo: (opts: any) => scrollToCalls.push(opts),
        getState: () => {},
      } as any;

      act(() => {
        result.current.scrollToBottom();
        // Second call while the first is still iterating — should be ignored
        result.current.scrollToBottom();
        result.current.scrollToBottom();
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });

      // Only one footer scrollTo fires despite three invocations
      expect(scrollToCalls).toHaveLength(1);
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
          callback: (
            records: MutationRecord[],
            observer: MutationObserver
          ) => void
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

    test("observes subtree mutations and scrolls while sticky", async () => {
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = document.createElement("div");
      const directChild = document.createElement("div");
      scroller.appendChild(directChild);
      document.body.appendChild(scroller);

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

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });

        expect(scrollToIndexCalls).toHaveLength(1);
        expect(scrollToCalls).toEqual([
          {
            top: 10_000_000,
            behavior: "smooth",
          },
        ]);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("scrolls when ResizeObserver fires while at bottom and sticky", async () => {
      // Locks in the contract that footer-only growth (which leaves Virtuoso
      // reporting atBottom=true) still triggers a follow-up scroll. The
      // earlier implementation short-circuited on isAtBottomRef.current, which
      // missed late-rendering footer content because followOutput only fires
      // on data-item changes.
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = document.createElement("div");
      scroller.appendChild(document.createElement("div"));
      document.body.appendChild(scroller);

      const scrollToIndexCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
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

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });

        expect(scrollToIndexCalls).toHaveLength(1);
      } finally {
        unmount();
        document.body.removeChild(scroller);
        harness.restore();
      }
    });

    test("skips re-observing direct children on deep subtree mutations", async () => {
      const harness = installObservers();
      const { result, unmount } = renderHook(() => useVirtuosoScrollState());
      const scroller = document.createElement("div");
      const directChild = document.createElement("div");
      const grandchild = document.createElement("span");
      directChild.appendChild(grandchild);
      scroller.appendChild(directChild);
      document.body.appendChild(scroller);

      const scrollToIndexCalls: any[] = [];
      result.current.virtuosoRef.current = {
        scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
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

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });

        // observeChildren() must not have re-walked: still just the original
        // direct child, no new observe() entries.
        expect(harness.resizeObserved.length).toBe(observedBeforeDeepMutation);
        // schedule() must still have run, so a sticky scroll fired.
        expect(scrollToIndexCalls).toHaveLength(1);
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
  });

  describe("scroll state persistence", () => {
    test("persists and restores snapshot when user had scrolled up (not sticky)", () => {
      const mockSnapshot = { ranges: [], scrollTop: 500 } as any;
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
        expect(result.current.scrollProps.followOutput(false)).toBe("smooth");
      } finally {
        document.body.removeChild(el);
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
        expect(result.current.scrollProps.followOutput(false)).toBe("smooth");
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
        expect(result2.current.scrollProps.followOutput(false)).toBe("smooth");
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
});
