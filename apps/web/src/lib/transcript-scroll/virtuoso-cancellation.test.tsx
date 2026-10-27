import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { createRef, useCallback, useLayoutEffect, useState } from "react";
import { Virtuoso, VirtuosoMockContext, type VirtuosoHandle } from "react-virtuoso";
import { useVirtuosoScrollState } from "@/hooks/useVirtuosoScrollState";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";

/**
 * Exercises the pinned, patched react-virtuoso (patches/react-virtuoso@4.18.19.patch)
 * rather than a fake handle: only the real library can prove that its own
 * retry window, cleanup timer and queued follow work are retired.
 */

afterEach(() => cleanup());

const VIEWPORT = 300;
const ITEM = 30;

interface Writes {
  tops: number[];
}

/** Scroller geometry for happy-dom, which lays nothing out; counts library writes. */
function instrument(element: HTMLElement, count: () => number, writes: Writes) {
  let top = 0;
  const height = () => count() * ITEM;
  Object.defineProperty(element, "offsetHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: height });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  element.getBoundingClientRect = () =>
    ({ top: 0, bottom: VIEWPORT, height: VIEWPORT, width: 400, left: 0, right: 400 }) as DOMRect;
  element.scrollTo = ((options: ScrollToOptions) => {
    if (typeof options.top !== "number") return;
    writes.tops.push(options.top);
    top = Math.max(0, Math.min(options.top, height() - VIEWPORT));
    element.dispatchEvent(new Event("scroll"));
  }) as typeof element.scrollTo;
}

function Harness({
  handle,
  writes,
  initialCount,
  setCountRef,
  followOutput,
}: {
  handle: React.RefObject<VirtuosoHandle | null>;
  writes: Writes;
  initialCount: number;
  setCountRef: { current: (count: number) => void };
  followOutput?: ((atBottom: boolean) => "auto" | false) | false;
}) {
  const [count, setCount] = useState(initialCount);
  const countRef = { current: count };
  useLayoutEffect(() => {
    setCountRef.current = setCount;
  }, [setCountRef]);
  return (
    <VirtuosoMockContext.Provider value={{ viewportHeight: VIEWPORT, itemHeight: ITEM }}>
      <Virtuoso
        ref={handle}
        totalCount={count}
        followOutput={followOutput}
        itemContent={(index) => <div style={{ height: ITEM }}>row {index}</div>}
        scrollerRef={(element) => {
          if (element instanceof HTMLElement) instrument(element, () => countRef.current, writes);
        }}
        style={{ height: VIEWPORT }}
      />
    </VirtuosoMockContext.Provider>
  );
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe("patched Virtuoso navigation cancellation", () => {
  test("the handle exposes cancelPendingNavigation", () => {
    const handle = createRef<VirtuosoHandle>();
    render(
      <Harness
        handle={handle}
        writes={{ tops: [] }}
        initialCount={10}
        setCountRef={{ current: () => {} }}
      />,
    );
    expect(typeof handle.current?.cancelPendingNavigation).toBe("function");
  });

  async function indexJumpThenRefresh(cancel: boolean) {
    const handle = createRef<VirtuosoHandle>();
    const writes: Writes = { tops: [] };
    const setCount = { current: (_count: number) => {} };
    render(<Harness handle={handle} writes={writes} initialCount={200} setCountRef={setCount} />);
    await wait(20);
    act(() => handle.current!.scrollToIndex({ index: 120, align: "start" }));
    const afterJump = writes.tops.length;
    if (cancel) act(() => handle.current!.cancelPendingNavigation());
    // Inside the 150 ms refresh window the list changes, which makes the
    // library retry the old index target unless the navigation was retired.
    act(() => setCount.current(260));
    await wait(1300);
    return { writes, afterJump };
  }

  test("control: without cancellation the library retries the index target after a refresh", async () => {
    const { writes, afterJump } = await indexJumpThenRefresh(false);
    expect(afterJump).toBeGreaterThanOrEqual(1);
    expect(writes.tops.length).toBeGreaterThan(afterJump);
  });

  test("cancelling after the first index write leaves no later write, past the cleanup deadline", async () => {
    const { writes, afterJump } = await indexJumpThenRefresh(true);
    expect(afterJump).toBeGreaterThanOrEqual(1);
    expect(writes.tops.length).toBe(afterJump);
  });

  async function followThenRefresh(cancel: boolean) {
    const handle = createRef<VirtuosoHandle>();
    const writes: Writes = { tops: [] };
    const setCount = { current: (_count: number) => {} };
    render(
      <Harness
        handle={handle}
        writes={writes}
        initialCount={40}
        setCountRef={setCount}
        followOutput={() => "auto"}
      />,
    );
    await wait(20);
    const before = writes.tops.length;
    // Appending while following queues a LAST navigation until the next
    // list refresh; ownership moves to the reader before it is delivered.
    act(() => setCount.current(41));
    const committed = writes.tops.length;
    if (cancel) act(() => handle.current!.cancelPendingNavigation());
    await wait(400);
    // The follow was still queued (waiting for the refresh) when cancelled.
    expect(committed).toBe(before);
    return { writes, before };
  }

  test("control: an append while following publishes the queued follow", async () => {
    const { writes, before } = await followThenRefresh(false);
    expect(writes.tops.length).toBeGreaterThan(before);
  });

  test("cancelling before the refresh retires the queued follow: no LAST write", async () => {
    const { writes, before } = await followThenRefresh(true);
    expect(writes.tops.length).toBe(before);
  });

  test("a literal false follow prop never scrolls on growth", async () => {
    const handle = createRef<VirtuosoHandle>();
    const writes: Writes = { tops: [] };
    const setCount = { current: (_count: number) => {} };
    render(
      <Harness
        handle={handle}
        writes={writes}
        initialCount={40}
        setCountRef={setCount}
        followOutput={false}
      />,
    );
    await wait(20);
    const before = writes.tops.length;
    act(() => setCount.current(50));
    await wait(300);
    expect(writes.tops.length).toBe(before);
  });

  async function shrinkViewport(followOutput: ((atBottom: boolean) => "auto" | false) | false) {
    const handle = createRef<VirtuosoHandle>();
    const writes: Writes = { tops: [] };
    let viewport = VIEWPORT;
    function Shrinking({ height }: { height: number }) {
      return (
        <VirtuosoMockContext.Provider value={{ viewportHeight: height, itemHeight: ITEM }}>
          <Virtuoso
            ref={handle}
            totalCount={60}
            followOutput={followOutput}
            itemContent={(index) => <div style={{ height: ITEM }}>row {index}</div>}
            scrollerRef={(element) => {
              if (element instanceof HTMLElement) instrument(element, () => 60, writes);
            }}
          />
        </VirtuosoMockContext.Provider>
      );
    }
    const view = render(<Shrinking height={viewport} />);
    await wait(20);
    // A detached reader: well above the end.
    act(() => handle.current!.scrollTo({ top: 300 }));
    await wait(20);
    const before = writes.tops.length;
    // The composer grows: the transcript viewport shrinks.
    viewport = VIEWPORT - 90;
    view.rerender(<Shrinking height={viewport} />);
    await wait(300);
    return { writes, before };
  }

  test("a function follow prop that answers false is still truthy to the viewport-shrink path", async () => {
    const { writes, before } = await shrinkViewport(() => false);
    // Recorded, not asserted: whether the library scrolls here depends on its
    // at-bottom state; the literal-false case below is the guarantee.
    expect(writes.tops.length).toBeGreaterThanOrEqual(before);
  });

  test("literal false: a detached reader is not moved when the viewport shrinks", async () => {
    const { writes, before } = await shrinkViewport(false);
    expect(writes.tops.length).toBe(before);
  });

  /** A missing list must fail, rather than count as a visible restored list. */
  function restoredList(container: HTMLElement) {
    const list = container.querySelector<HTMLElement>("[data-testid=virtuoso-item-list]");
    expect(list).not.toBeNull();
    return list!;
  }

  function restoreFixture() {
    const handle = createRef<VirtuosoHandle>();
    const writes: Writes = { tops: [] };
    let onFirstWrite = () => {};
    const firstWrite = new Promise<void>((resolve) => {
      onFirstWrite = resolve;
    });
    const snapshot = {
      ranges: [{ startIndex: 0, endIndex: 199, size: ITEM }],
      scrollTop: 3000,
    };
    function RestoredVirtuoso({
      virtuosoRef = handle,
      scrollerRef,
    }: {
      virtuosoRef?: React.RefObject<VirtuosoHandle | null>;
      scrollerRef?: (element: HTMLElement | Window | null) => void;
    }) {
      const attachScroller = useCallback(
        (element: HTMLElement | Window | null) => {
          if (element instanceof HTMLElement) {
            instrument(element, () => 200, writes);
            const write = element.scrollTo.bind(element);
            element.scrollTo = ((options: ScrollToOptions) => {
              write(options);
              onFirstWrite();
            }) as typeof element.scrollTo;
          }
          scrollerRef?.(element);
        },
        [scrollerRef],
      );
      return (
        <VirtuosoMockContext.Provider value={{ viewportHeight: VIEWPORT, itemHeight: ITEM }}>
          <Virtuoso
            ref={virtuosoRef}
            totalCount={200}
            restoreStateFrom={snapshot}
            followOutput={false}
            itemContent={(index) => <div style={{ height: ITEM }}>row {index}</div>}
            scrollerRef={attachScroller}
            style={{ height: VIEWPORT }}
          />
        </VirtuosoMockContext.Provider>
      );
    }
    return { handle, writes, firstWrite, RestoredVirtuoso };
  }

  // Hold the refresh window open explicitly, so a slow worker cannot complete
  // the initial navigation before the hidden-state or cancellation assertions.
  test.each([false, true])(
    "restored snapshot transitions from hidden to visible (cancel=%s)",
    async (cancel) => {
      const refresh = installControlledTimeout(150, { label: "Virtuoso index refresh window" });
      const fixture = restoreFixture();
      const view = render(<fixture.RestoredVirtuoso />);
      try {
        expect(restoredList(view.container).style.visibility).toBe("hidden");
        await act(() => fixture.firstWrite);
        expect(fixture.writes.tops).toContain(3000);
        expect(refresh.pendingCount()).toBe(1);
        expect(restoredList(view.container).style.visibility).toBe("hidden");
        if (cancel) act(() => fixture.handle.current!.cancelPendingNavigation());
        else
          act(() => {
            expect(refresh.advance()).toBe(1);
          });
        expect(restoredList(view.container).style.visibility).toBe("");
        const afterCompletion = fixture.writes.tops.length;
        // Unsubscribing leaves the fallback timer queued; delivering it must
        // neither retry the cancelled target nor hide the list again.
        if (cancel)
          act(() => {
            expect(refresh.advance()).toBe(1);
          });
        await wait(1300);
        expect(restoredList(view.container).style.visibility).toBe("");
        expect(fixture.writes.tops.length).toBe(afterCompletion);
        refresh.assertDrained();
      } finally {
        view.unmount();
        refresh.restore();
      }
    },
  );

  test("cancelling before any index navigation is pending does not reveal the restored list", async () => {
    const refresh = installControlledTimeout(150, { label: "Virtuoso index refresh window" });
    const fixture = restoreFixture();
    const view = render(<fixture.RestoredVirtuoso />);
    try {
      expect(fixture.writes.tops).toHaveLength(0);
      expect(refresh.pendingCount()).toBe(0);
      expect(restoredList(view.container).style.visibility).toBe("hidden");
      act(() => fixture.handle.current!.cancelPendingNavigation());
      expect(fixture.writes.tops).toHaveLength(0);
      expect(restoredList(view.container).style.visibility).toBe("hidden");
      // Cancellation did not complete an initial location that has yet to run.
      await act(() => fixture.firstWrite);
      expect(fixture.writes.tops).toContain(3000);
      expect(restoredList(view.container).style.visibility).toBe("hidden");
      act(() => {
        expect(refresh.advance()).toBe(1);
      });
      expect(restoredList(view.container).style.visibility).toBe("");
      refresh.assertDrained();
    } finally {
      view.unmount();
      refresh.restore();
    }
  });

  test.each(["activation", "deactivation"] as const)(
    "controller %s reveals a snapshot whose initial navigation is still pending",
    async (transition) => {
      const refresh = installControlledTimeout(150, {
        label: "Virtuoso index refresh window",
        // Activation starts a new index navigation while the cancelled
        // restore's unsubscribed fallback timer is still queued.
        maxPending: 2,
      });
      const fixture = restoreFixture();
      let scrollState: ReturnType<typeof useVirtuosoScrollState>;
      function ControllerRestore({
        active,
        activationHeld,
      }: {
        active: boolean;
        activationHeld: boolean;
      }) {
        const state = useVirtuosoScrollState({
          isActive: active,
          activation: "latest",
          explicitTargetPending: activationHeld,
        });
        useLayoutEffect(() => {
          scrollState = state;
        });
        return (
          <fixture.RestoredVirtuoso
            virtuosoRef={state.virtuosoRef}
            scrollerRef={state.scrollProps.scrollerRef}
          />
        );
      }
      const view = render(<ControllerRestore active activationHeld />);
      try {
        expect(restoredList(view.container).style.visibility).toBe("hidden");
        await act(() => fixture.firstWrite);
        expect(fixture.writes.tops).toContain(3000);
        expect(refresh.pendingCount()).toBe(1);
        expect(restoredList(view.container).style.visibility).toBe("hidden");
        const before = scrollState!.getScrollDiagnostics().libraryCancellations;
        view.rerender(
          <ControllerRestore active={transition === "activation"} activationHeld={false} />,
        );
        // Activation is scheduled on a frame; retirement runs in the effect.
        if (transition === "activation") {
          await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
          expect(scrollState!.getScrollDiagnostics().operationsStarted).toBeGreaterThan(0);
        } else {
          expect(scrollState!.scrollProps.controller.active).toBe(false);
        }
        expect(scrollState!.getScrollDiagnostics().libraryCancellations).toBeGreaterThan(before);
        expect(restoredList(view.container).style.visibility).toBe("");
        const afterTransition = fixture.writes.tops.length;
        act(() => {
          expect(refresh.advance()).toBe(transition === "activation" ? 2 : 1);
        });
        await wait(1300);
        expect(restoredList(view.container).style.visibility).toBe("");
        expect(fixture.writes.tops.length).toBe(afterTransition);
        refresh.assertDrained();
      } finally {
        view.unmount();
        refresh.restore();
      }
    },
  );
});

describe("firstItemIndex with the real virtualizer", () => {
  test("rows keep local indices and identity across two prepends", async () => {
    const { VirtualizedMessageList } = await import("@/components/chat/VirtualizedMessageList");
    type Row = { id: string };
    const rows = (from: number, to: number): Row[] =>
      Array.from({ length: to - from }, (_, offset) => ({ id: `r${from + offset}` }));
    const handle = createRef<VirtuosoHandle>();
    const writes: Writes = { tops: [] };
    // Read by the instrumented scroller; set from the rendered rows.
    const count = { current: 0 };
    function List({ messages }: { messages: Row[] }) {
      useLayoutEffect(() => {
        count.current = messages.length;
      });
      return (
        <VirtuosoMockContext.Provider value={{ viewportHeight: VIEWPORT, itemHeight: ITEM }}>
          <div style={{ height: VIEWPORT }}>
            <VirtualizedMessageList
              messages={messages}
              computeItemKey={(_index, row) => row.id}
              renderMessage={(_index, row) => <div style={{ height: ITEM }}>{row.id}</div>}
              scrollProps={{
                followOutput: () => false,
                atBottomStateChange: () => {},
                atBottomThreshold: 50,
                restoreStateFrom: undefined,
                scrollerRef: (element) => {
                  if (element instanceof HTMLElement)
                    instrument(element, () => count.current, writes);
                },
              }}
              virtuosoRef={handle}
            />
          </div>
        </VirtuosoMockContext.Provider>
      );
    }
    const view = render(<List messages={rows(100, 140)} />);
    await wait(20);
    view.rerender(<List messages={rows(60, 140)} />);
    await wait(20);
    view.rerender(<List messages={rows(20, 140)} />);
    await wait(20);
    const rendered = Array.from(
      document.querySelectorAll<HTMLElement>("[data-chat-message-index]"),
    ).map((row) => [Number(row.dataset.chatMessageIndex), row.dataset.chatMessageKey]);
    expect(rendered.length).toBeGreaterThan(0);
    // Every rendered row's local index names its own message.
    for (const [index, key] of rendered) expect(key).toBe(`r${20 + (index as number)}`);
    // Navigation by index with this nonzero base is proven in a real browser
    // (e2e/TranscriptPaging.spec.ts: find after an 80-row prepend).
  });
});
