import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { useAutoLoadEarlier, type AutoLoadEarlierInput } from "./useAutoLoadEarlier";

/** Lets a test say when the transcript's head scrolls into range. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets: Element[] = [];
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  disconnect() {
    this.targets.length = 0;
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

/** Delivers one batch of crossings, oldest first, for every observed target. */
function deliver(...crossings: boolean[]) {
  act(() => {
    for (const observer of FakeIntersectionObserver.instances) {
      observer.callback(
        observer.targets.flatMap((target) =>
          crossings.map(
            (isIntersecting) => ({ isIntersecting, target }) as IntersectionObserverEntry,
          ),
        ),
        observer as unknown as IntersectionObserver,
      );
    }
  });
}

function setHeadInView(isIntersecting: boolean) {
  deliver(isIntersecting);
}

function Harness(props: AutoLoadEarlierInput & { withSentinel: boolean }) {
  const sentinel = useAutoLoadEarlier(props);
  return <div data-virtuoso-scroller="">{props.withSentinel ? <div ref={sentinel} /> : null}</div>;
}

const previousObserver = globalThis.IntersectionObserver;
beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  globalThis.IntersectionObserver =
    FakeIntersectionObserver as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  cleanup();
  globalThis.IntersectionObserver = previousObserver;
});

/**
 * A page the test settles by hand, so it can move the head first, as the
 * session does: the projection is applied before the page's promise settles.
 */
function pages() {
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const load = mock(
    (_scroller: HTMLElement | null) =>
      new Promise<void>((resolve, reject) => pending.push({ resolve, reject })),
  );
  const settle = async (outcome: "ok" | "fail" = "ok") => {
    const page = pending.shift();
    if (!page) throw new Error("No page in flight");
    await act(async () => {
      if (outcome === "ok") page.resolve();
      else page.reject(new Error("page failed"));
      await Promise.resolve();
    });
  };
  return { load, settle };
}

function baseInput(overrides: Partial<AutoLoadEarlierInput> = {}) {
  return {
    sessionKey: "session-1",
    isActive: true,
    settled: true,
    canLoadEarlier: true,
    headId: "row-100",
    loading: false,
    available: () => true,
    load: mock(async (_scroller: HTMLElement | null) => undefined),
    ...overrides,
  };
}

describe("useAutoLoadEarlier", () => {
  test("loads one page when a tab opens on a transcript with earlier history", async () => {
    const { load, settle } = pages();
    const input = baseInput({ load });
    const view = render(<Harness {...input} withSentinel={false} />);
    expect(load).toHaveBeenCalledTimes(1);

    // The page prepended rows; with the head off screen nothing more loads.
    view.rerender(<Harness {...input} headId="row-0" withSentinel={false} />);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("retries an opening page that brought nothing, once", async () => {
    // A poll landing while the page is in flight supersedes it.
    const { load, settle } = pages();
    render(<Harness {...baseInput({ load })} withSentinel={false} />);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("waits until the read settles and the tab is active", async () => {
    const { load, settle } = pages();
    const input = baseInput({ settled: false, isActive: false, load });
    const view = render(<Harness {...input} withSentinel={false} />);
    view.rerender(<Harness {...input} settled withSentinel={false} />);
    expect(load).not.toHaveBeenCalled();
    view.rerender(<Harness {...input} settled isActive withSentinel={false} />);
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<Harness {...input} settled isActive headId="row-0" withSentinel={false} />);
    await settle();
  });

  test("a replaced session opens immediately and ignores the old pending completion", async () => {
    const old = pages();
    const next = pages();
    const input = baseInput({ load: old.load });
    const view = render(<Harness {...input} withSentinel={false} />);
    const replacement = baseInput({ sessionKey: "session-2", load: next.load });
    view.rerender(<Harness {...replacement} withSentinel={false} />);
    expect(next.load).toHaveBeenCalledTimes(1);

    await old.settle();
    view.rerender(<Harness {...replacement} available={() => true} withSentinel={false} />);
    expect(next.load).toHaveBeenCalledTimes(1);
    // Old misses must not count against this session's own retry allowance.
    await next.settle("fail");
    expect(next.load).toHaveBeenCalledTimes(2);
    await next.settle("fail");
    expect(next.load).toHaveBeenCalledTimes(2);
  });

  test("deactivation and reactivation isolate a pending page from its successor", async () => {
    const { load, settle } = pages();
    const input = baseInput({ load });
    const view = render(<Harness {...input} withSentinel={false} />);
    view.rerender(<Harness {...input} isActive={false} withSentinel={false} />);
    view.rerender(<Harness {...input} withSentinel={false} />);
    expect(load).toHaveBeenCalledTimes(2);
    // Settle the request from before deactivation while the new one is pending.
    await settle();
    view.rerender(<Harness {...input} available={() => true} withSentinel={false} />);
    expect(load).toHaveBeenCalledTimes(2);
    view.rerender(<Harness {...input} headId="row-0" withSentinel={false} />);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("a page completed while inactive is adopted on return without another opening page", async () => {
    const { load, settle } = pages();
    const input = baseInput({ load });
    const view = render(<Harness {...input} withSentinel={false} />);
    view.rerender(<Harness {...input} isActive={false} loading withSentinel={false} />);
    view.rerender(<Harness {...input} isActive={false} headId="row-0" withSentinel={false} />);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<Harness {...input} headId="row-0" withSentinel={false} />);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("remounting while a page is pending gives the new mount its own opening request", async () => {
    const old = pages();
    const next = pages();
    const view = render(<Harness {...baseInput({ load: old.load })} withSentinel={false} />);
    view.unmount();
    const input = baseInput({ load: next.load });
    const remounted = render(<Harness {...input} withSentinel={false} />);
    expect(next.load).toHaveBeenCalledTimes(1);
    await old.settle("fail");
    expect(next.load).toHaveBeenCalledTimes(1);
    remounted.rerender(<Harness {...input} headId="row-0" withSentinel={false} />);
    await next.settle();
    expect(next.load).toHaveBeenCalledTimes(1);
  });

  test("never pages without a cheap cursor or without earlier history", () => {
    const input = baseInput({ available: () => false });
    const view = render(<Harness {...input} withSentinel />);
    setHeadInView(true);
    expect(input.load).not.toHaveBeenCalled();

    const short = baseInput({ canLoadEarlier: false, sessionKey: "session-2" });
    view.rerender(<Harness {...short} withSentinel />);
    setHeadInView(true);
    expect(short.load).not.toHaveBeenCalled();
  });

  test("pages on while the head stays in range, and stops at pages that add nothing", async () => {
    const { load, settle } = pages();
    const input = baseInput({ load });
    const view = render(<Harness {...input} withSentinel />);
    expect(load).toHaveBeenCalledTimes(1);
    // The opening page brought rows, but the reader is not near the top.
    view.rerender(<Harness {...input} headId="row-50" withSentinel />);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);

    // Scrolling to the top loads the next page from the sentinel's scroller.
    setHeadInView(true);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]![0]).toBeInstanceOf(HTMLElement);
    view.rerender(<Harness {...input} headId="row-0" withSentinel />);
    await settle();
    // Still in range after the prepend: one more page.
    expect(load).toHaveBeenCalledTimes(3);

    // That page left the head where it was: one retry, then no more.
    await settle();
    expect(load).toHaveBeenCalledTimes(4);
    await settle();
    expect(load).toHaveBeenCalledTimes(4);

    // A clicked page that moves the head lets automatic paging resume.
    view.rerender(<Harness {...input} headId="row-zero-older" withSentinel />);
    expect(load).toHaveBeenCalledTimes(5);
    view.rerender(<Harness {...input} headId="row-oldest" canLoadEarlier={false} withSentinel />);
    await settle();
  });

  test("stops after failed pages until the head moves", async () => {
    const { load, settle } = pages();
    const input = baseInput({ load });
    const view = render(<Harness {...input} withSentinel />);
    await settle("fail");
    expect(load).toHaveBeenCalledTimes(2);
    setHeadInView(true);
    await settle("fail");
    expect(load).toHaveBeenCalledTimes(2);

    view.rerender(<Harness {...input} headId="row-90" withSentinel />);
    expect(load).toHaveBeenCalledTimes(3);
    view.rerender(<Harness {...input} headId="row-80" withSentinel />);
    setHeadInView(false);
    await settle();
  });

  test("reads only the latest crossing in a batch", async () => {
    // The list mounts at its top and jumps to the latest row before the
    // observer reports: both crossings arrive together.
    const { load, settle } = pages();
    const input = baseInput({ load });
    const view = render(<Harness {...input} withSentinel />);
    view.rerender(<Harness {...input} headId="row-50" withSentinel />);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);

    deliver(true, false);
    expect(load).toHaveBeenCalledTimes(1);
    deliver(false, true);
    expect(load).toHaveBeenCalledTimes(2);
    view.rerender(<Harness {...input} headId="row-0" withSentinel />);
    setHeadInView(false);
    await settle();
  });

  test("a transcript that keeps collapsing to its tail stops being paged", async () => {
    const { load, settle } = pages();
    const input = baseInput({ load });
    const view = render(<Harness {...input} withSentinel />);
    // The tail is short, so its head stays in range once it is back on screen.
    setHeadInView(true);
    expect(load).toHaveBeenCalledTimes(1);

    // Each round: the page lands, the next page chains from the head it
    // brought, then a poll collapses the list back to the same live tail.
    const round = async (older: string) => {
      view.rerender(<Harness {...input} headId={older} withSentinel />);
      await settle();
      view.rerender(<Harness {...input} withSentinel />);
      await settle();
    };
    await round("row-50");
    expect(load).toHaveBeenCalledTimes(3);
    await round("row-50");
    // Two pages from the tail and two from the older head: nothing is left to
    // try, however many more times the list comes back.
    expect(load).toHaveBeenCalledTimes(4);
    view.rerender(<Harness {...input} headId="row-50" withSentinel />);
    view.rerender(<Harness {...input} withSentinel />);
    expect(load).toHaveBeenCalledTimes(4);
  });

  test("does not start a page while another is loading", async () => {
    const { load, settle } = pages();
    const input = baseInput({ loading: true, load });
    const view = render(<Harness {...input} withSentinel />);
    setHeadInView(true);
    expect(load).not.toHaveBeenCalled();
    view.rerender(<Harness {...input} loading={false} withSentinel />);
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<Harness {...input} loading={false} headId="row-0" withSentinel />);
    setHeadInView(false);
    await settle();
  });
});
