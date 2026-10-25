import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { CodeBlock } from "@/components/chat/rich/CodeBlock";
import { MermaidBlock } from "@/components/chat/rich/MermaidBlock";
import { setHighlightBackend } from "@/lib/chat/highlighter/client";
import {
  setMermaidRenderer,
  setMermaidSvgSanitizer,
} from "@/lib/chat/rich-markdown/mermaid-render";
import { RichTranscriptScopeContext, type RichTranscriptScope } from "@/lib/chat/rich-identity";
import { richRenderScheduler, type RichRenderLane } from "@/lib/chat/rich-render-cache";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import {
  MAX_OBSERVED_BLOCKS,
  RichRowVisibilityContext,
  TranscriptRowVisibilityTracker,
  useRichBlockVisibility,
  useRichRenderPriority,
} from "./rich-render-priority";

/*
 * Per-block visibility: every rich block of a transcript is observed by the
 * transcript's single IntersectionObserver, so an offscreen block of a long
 * row requests idle prefetch and is promoted when it scrolls in.
 */

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** The browser reports a scroll: `target` now does / does not intersect. */
  report(target: Element, isIntersecting: boolean): void {
    if (!this.targets.has(target)) throw new Error("not observed");
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const realObserver = globalThis.IntersectionObserver;
const realRect = Element.prototype.getBoundingClientRect;

/** Layout for the tests: a 600px scroller; blocks keyed `below-*` start far down. */
function installLayout(): void {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rect = (top: number, height: number) =>
      ({ top, bottom: top + height, left: 0, right: 800, width: 800, height }) as DOMRect;
    if (this.hasAttribute("data-virtuoso-scroller")) return rect(0, 600);
    const key = this.getAttribute("data-rich-block-key");
    if (key?.startsWith("below")) return rect(2_000, 200);
    if (key) return rect(20, 200);
    return realRect.call(this);
  };
}

const SCOPE: RichTranscriptScope = {
  backendId: "backend-A",
  environmentId: "env-1",
  logicalSessionKey: "session-1",
  generation: "g",
};

let tracker: TranscriptRowVisibilityTracker;

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  globalThis.IntersectionObserver =
    FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  tracker = new TranscriptRowVisibilityTracker();
  richRenderScheduler.clear();
  useRichContentViewStore.getState().reset();
});

afterEach(() => {
  cleanup();
  tracker.dispose();
  globalThis.IntersectionObserver = realObserver;
  Element.prototype.getBoundingClientRect = realRect;
  setHighlightBackend(undefined);
  setMermaidRenderer(null);
  setMermaidSvgSanitizer(null);
});

function observer(): FakeIntersectionObserver {
  expect(FakeIntersectionObserver.instances).toHaveLength(1);
  return FakeIntersectionObserver.instances[0]!;
}

/** A rich block that reports the priority its own visibility gives it. */
function BlockProbe({ id }: { id: string }) {
  const { observe, visibility } = useRichBlockVisibility();
  const { priority } = useRichRenderPriority(visibility);
  return (
    <figure data-rich-block="probe" data-probe={id}>
      <span ref={observe} hidden />
      <output data-priority-for={id}>{priority}</output>
    </figure>
  );
}

function inRow(rowKey: string, children: ReactNode) {
  return (
    <RichTranscriptScopeContext value={SCOPE}>
      <RichRowVisibilityContext value={tracker.source(rowKey)}>{children}</RichRowVisibilityContext>
    </RichTranscriptScopeContext>
  );
}

function priorityOf(container: HTMLElement, id: string): string | null | undefined {
  return container.querySelector(`[data-priority-for="${id}"]`)?.textContent;
}

function figure(container: HTMLElement, id: string): Element {
  return container.querySelector(`[data-probe="${id}"]`)!;
}

describe("per-block visibility", () => {
  test("blocks share the transcript's one observer and each follow their own intersection", () => {
    const rowElement = document.createElement("div");
    document.body.append(rowElement);
    tracker.observe("row-1", rowElement);
    const { container, unmount } = render(
      inRow(
        "row-1",
        <>
          <BlockProbe id="a" />
          <BlockProbe id="b" />
          <BlockProbe id="c" />
        </>,
      ),
    );
    const io = observer();
    // The row and its three block frames, one observer.
    expect(io.targets.size).toBe(4);
    expect(io.targets.has(figure(container, "b"))).toBe(true);
    expect(tracker.stats().blocks).toBe(3);
    // Unanswered blocks follow their (visible) row.
    expect(priorityOf(container, "c")).toBe("visible");

    act(() => {
      io.report(figure(container, "b"), false);
      io.report(figure(container, "c"), false);
    });
    expect(priorityOf(container, "a")).toBe("visible");
    expect(priorityOf(container, "b")).toBe("prefetch");
    expect(priorityOf(container, "c")).toBe("prefetch");

    act(() => io.report(figure(container, "c"), true));
    expect(priorityOf(container, "c")).toBe("visible");
    expect(priorityOf(container, "b")).toBe("prefetch");

    unmount();
    expect(io.targets.size).toBe(1);
    expect(tracker.stats().blocks).toBe(0);
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    rowElement.remove();
  });

  test("a block the observer has not answered for follows its row", () => {
    tracker.setVisible("row-overscan", false);
    const { container } = render(inRow("row-overscan", <BlockProbe id="a" />));
    expect(priorityOf(container, "a")).toBe("prefetch");
    act(() => tracker.setVisible("row-overscan", true));
    expect(priorityOf(container, "a")).toBe("visible");
    act(() => observer().report(figure(container, "a"), false));
    expect(priorityOf(container, "a")).toBe("prefetch");
  });

  test("block registrations are bounded; blocks over the bound follow their row", () => {
    const ids = Array.from({ length: MAX_OBSERVED_BLOCKS + 3 }, (_, index) => `b${index}`);
    const { container } = render(
      inRow(
        "row-long",
        ids.map((id) => <BlockProbe key={id} id={id} />),
      ),
    );
    expect(tracker.stats().blocks).toBe(MAX_OBSERVED_BLOCKS);
    expect(observer().targets.size).toBe(MAX_OBSERVED_BLOCKS);
    const last = ids[ids.length - 1]!;
    expect(observer().targets.has(figure(container, last))).toBe(false);
    act(() => tracker.setVisible("row-long", false));
    expect(priorityOf(container, last)).toBe("prefetch");
    // An observed block keeps following its own (unanswered → row) state too.
    expect(priorityOf(container, "b0")).toBe("prefetch");
  });

  test("outside a transcript a block is always visible and nothing is observed", () => {
    const { container } = render(<BlockProbe id="solo" />);
    expect(priorityOf(container, "solo")).toBe("visible");
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });
});

/** Fill a lane with running jobs so later requests queue; returns their releases. */
async function fillLane(lane: RichRenderLane, count: number): Promise<Array<() => void>> {
  const releases: Array<() => void> = [];
  const before = richRenderScheduler.stats().running;
  for (let index = 0; index < count; index++) {
    richRenderScheduler
      .request<string>({
        key: `blocker-${lane}-${index}`,
        lane,
        sourceBytes: 1,
        run: (signal) =>
          new Promise<{ value: string; bytes: number }>((resolve, reject) => {
            releases.push(() => resolve({ value: "x", bytes: 1 }));
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      })
      .promise.catch(() => {});
  }
  await Promise.resolve();
  await Promise.resolve();
  expect(richRenderScheduler.stats().running - before).toBe(count);
  return releases;
}

function scroller(children: ReactNode) {
  return (
    <div data-virtuoso-scroller="true">
      <div data-chat-message-key="row-1">{children}</div>
    </div>
  );
}

describe("rich blocks request work by their own visibility", () => {
  test("code blocks below the fold of a visible row prefetch; scrolling one in promotes it", async () => {
    installLayout();
    const order: string[] = [];
    setHighlightBackend({
      highlight(input, signal) {
        order.push(input.code);
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      },
    });
    const releases = await fillLane("highlight", FRONTEND_RENDER_POLICY.highlightConcurrency);
    const { container } = render(
      inRow(
        "row-1",
        scroller(
          <>
            <CodeBlock source="const onScreen = 1;" language="ts" closed blockKey="top" />
            <CodeBlock source="const below1 = 2;" language="ts" closed blockKey="below-1" />
            <CodeBlock source="const below2 = 3;" language="ts" closed blockKey="below-2" />
          </>,
        ),
      ),
    );
    await waitFor(() => expect(richRenderScheduler.stats().queued).toBe(3));
    const io = observer();
    expect(tracker.stats().blocks).toBe(3);
    // The second offscreen block scrolls in while all three are queued.
    const below2 = container.querySelector('[data-rich-block-key="below-2"]')!;
    expect(io.targets.has(below2)).toBe(true);
    act(() => io.report(below2, true));
    for (const release of releases) release();
    await waitFor(() => expect(order).toHaveLength(2));
    // Row-level priority alone would have run "below1" second (request order).
    expect(order).toEqual(["const onScreen = 1;", "const below2 = 3;"]);
  });

  test("a diagram below the fold prefetches; scrolling it in promotes it ahead of others", async () => {
    installLayout();
    const order: string[] = [];
    setMermaidRenderer((input) => {
      order.push(input.source);
      return new Promise(() => {});
    });
    setMermaidSvgSanitizer((markup) => ({ svg: markup }));
    const releases = await fillLane("diagram", FRONTEND_RENDER_POLICY.diagramConcurrency);
    const { container } = render(
      inRow(
        "row-1",
        scroller(
          <>
            <MermaidBlock source={"flowchart TD\n  A --> B"} closed blockKey="below-1" />
            <MermaidBlock source={"flowchart TD\n  C --> D"} closed blockKey="below-2" />
          </>,
        ),
      ),
    );
    await waitFor(() => expect(richRenderScheduler.stats().queued).toBe(2));
    const io = observer();
    expect(tracker.stats().blocks).toBe(2);
    const second = container.querySelector('[data-rich-block-key="below-2"]')!;
    expect(io.targets.has(second)).toBe(true);
    act(() => io.report(second, true));
    for (const release of releases) release();
    await waitFor(() => expect(order).toHaveLength(1));
    expect(order).toEqual(["flowchart TD\n  C --> D"]);
  });
});
