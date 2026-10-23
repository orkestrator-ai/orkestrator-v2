import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { createRef, useLayoutEffect, useState } from "react";
import { Virtuoso, VirtuosoMockContext, type VirtuosoHandle } from "react-virtuoso";

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
});
