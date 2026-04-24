import { describe, test, expect, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import {
  useVirtuosoScrollState,
  clearPersistedVirtuosoState,
} from "@/hooks/useVirtuosoScrollState";

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

    test("skips snapshot restore when user was sticky (snaps to new bottom instead)", () => {
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
      expect(result2.current.scrollProps.restoreStateFrom).toBeUndefined();
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
