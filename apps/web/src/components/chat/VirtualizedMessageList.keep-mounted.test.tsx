import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import * as realVirtuoso from "react-virtuoso";
import type { ListRange } from "react-virtuoso";
import { useRichRenderPriority } from "@/lib/chat/rich-render-priority";
import { useArtifactLiveHostStore } from "@/stores/artifactLiveHostStore";
import { pinRichViewKey } from "@/stores/richContentViewStore";

/**
 * A Virtuoso stand-in with a real render window: it renders the visible range
 * plus `minOverscanItemCount` rows on each side and reports the expanded range
 * through `rangeChanged`, so tests can establish exactly which rows are
 * mounted while the reader scrolls.
 */
let visible: ListRange = { startIndex: 0, endIndex: 2 };
let scrollVirtuoso: ((range: ListRange) => void) | null = null;
let lastFollowOutput: ((atBottom: boolean) => "auto" | false) | false | null = null;
const realVirtuosoSnapshot = { ...realVirtuoso };

function FakeVirtuoso({
  data,
  itemContent,
  firstItemIndex = 0,
  computeItemKey,
  minOverscanItemCount,
  rangeChanged,
  followOutput,
}: {
  data: unknown[];
  firstItemIndex?: number;
  itemContent: (index: number, item: unknown) => ReactNode;
  computeItemKey: (index: number, item: unknown) => string;
  minOverscanItemCount?: number | { top: number; bottom: number };
  rangeChanged?: (range: ListRange) => void;
  followOutput?: ((atBottom: boolean) => "auto" | false) | false;
}) {
  const [range, setRange] = useState(visible);
  useLayoutEffect(() => {
    scrollVirtuoso = (next) => {
      visible = next;
      setRange(next);
    };
    lastFollowOutput = followOutput ?? null;
  });
  const overscan =
    typeof minOverscanItemCount === "number"
      ? { top: minOverscanItemCount, bottom: minOverscanItemCount }
      : (minOverscanItemCount ?? { top: 0, bottom: 0 });
  const start = Math.max(0, range.startIndex - overscan.top);
  const end = Math.min(data.length - 1, range.endIndex + overscan.bottom);
  useEffect(() => {
    rangeChanged?.({ startIndex: firstItemIndex + start, endIndex: firstItemIndex + end });
  }, [firstItemIndex, start, end, rangeChanged]);
  const rows: ReactNode[] = [];
  for (let index = start; index <= end; index++) {
    rows.push(
      <div key={computeItemKey(firstItemIndex + index, data[index])}>
        {itemContent(firstItemIndex + index, data[index])}
      </div>,
    );
  }
  return (
    <div
      data-virtuoso-scroller="true"
      ref={(node) => {
        if (!node) return;
        node.getBoundingClientRect = () => ({
          top: range.startIndex * 20,
          bottom: (range.endIndex + 1) * 20,
          height: (range.endIndex - range.startIndex + 1) * 20,
          width: 100,
          left: 0,
          right: 100,
          x: 0,
          y: range.startIndex * 20,
          toJSON() {},
        });
        for (const row of node.querySelectorAll<HTMLElement>("[data-chat-message-index]")) {
          const index = Number(row.dataset.chatMessageIndex);
          row.getBoundingClientRect = () => ({
            top: index * 20,
            bottom: (index + 1) * 20,
            height: 20,
            width: 100,
            left: 0,
            right: 100,
            x: 0,
            y: index * 20,
            toJSON() {},
          });
        }
      }}
    >
      {rows}
    </div>
  );
}

mock.module("react-virtuoso", () => ({ ...realVirtuosoSnapshot, Virtuoso: FakeVirtuoso }));

const { VirtualizedMessageList, KEEP_MOUNTED_MAX_ROWS } = await import("./VirtualizedMessageList");

afterAll(() => {
  mock.module("react-virtuoso", () => realVirtuosoSnapshot);
});

interface Row {
  id: string;
  text: string;
}

const ROWS: Row[] = Array.from({ length: 40 }, (_, index) => ({
  id: `m-${index}`,
  text: `Message number ${index}`,
}));

/** Reports the render priority its row provides. */
function PriorityProbe({ id }: { id: string }) {
  const { priority } = useRichRenderPriority();
  return <span data-priority-for={id}>{priority}</span>;
}

function renderList(options: { setFollowPaused?: (reason: string, paused: boolean) => void } = {}) {
  const followOutput = (atBottom: boolean) => (atBottom ? ("auto" as const) : false);
  const utils = render(
    <div>
      <input aria-label="Outside" />
      <VirtualizedMessageList
        messages={ROWS}
        computeItemKey={(_index, row) => row.id}
        renderMessage={(_index, row) => (
          <div data-agent-chat-search-content="true">
            <p>{row.text}</p>
            <button type="button">Action {row.id}</button>
            <PriorityProbe id={row.id} />
          </div>
        )}
        scrollProps={{
          followOutput,
          atBottomStateChange: () => {},
          atBottomThreshold: 0,
          restoreStateFrom: undefined,
          ...(options.setFollowPaused ? { setFollowPaused: options.setFollowPaused } : {}),
        }}
        virtuosoRef={createRef()}
        find={{ isActive: true, getSearchText: (row) => row.text }}
      />
    </div>,
  );
  return { ...utils, followOutput };
}

function rowElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-chat-message-key="${id}"]`);
}

function selectText(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function clearSelection() {
  document.getSelection()?.removeAllRanges();
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

/** Scroll one row at a time, as a reader does. */
function scrollTo(startIndex: number) {
  const current = visible.startIndex;
  const step = startIndex > current ? 1 : -1;
  for (let index = current; index !== startIndex; index += step) {
    act(() => scrollVirtuoso?.({ startIndex: index + step, endIndex: index + step + 2 }));
  }
}

beforeEach(() => {
  visible = { startIndex: 0, endIndex: 2 };
});

afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
  useArtifactLiveHostStore.setState({ active: null });
});

describe("VirtualizedMessageList keep-mounted protection", () => {
  test("the row holding a text selection stays mounted while within the bound, then is released", () => {
    renderList();
    scrollTo(4);
    const selected = rowElement("m-5")!;
    selectText(selected.querySelector("p")!.firstChild!);

    // Scroll the selected row out of view, one row at a time, up to the bound.
    scrollTo(5 + KEEP_MOUNTED_MAX_ROWS);
    expect(rowElement("m-5")).toBe(selected);
    expect(selected.isConnected).toBe(true);
    expect(document.getSelection()?.toString()).toBe("Message number 5");
    // Virtualization stays on: rows far above the protected one are not mounted.
    expect(rowElement("m-0") === null).toBe(true);
    expect(rowElement("m-2") === null).toBe(true);

    // One more row past the bound releases protection and the row unmounts.
    scrollTo(5 + KEEP_MOUNTED_MAX_ROWS + 1);
    expect(rowElement("m-5") === null).toBe(true);
  });

  test("a collapsed selection releases the row immediately", () => {
    renderList();
    scrollTo(4);
    selectText(rowElement("m-5")!.querySelector("p")!.firstChild!);
    scrollTo(9);
    expect(rowElement("m-5")?.isConnected).toBe(true);
    clearSelection();
    // Re-render at the same range: protection has gone.
    act(() => scrollVirtuoso?.({ startIndex: 9, endIndex: 11 }));
    expect(rowElement("m-5") === null).toBe(true);
  });

  test("the row holding focus stays mounted and keeps focus; focus leaving releases it", () => {
    renderList();
    scrollTo(2);
    const button = screen.getByRole("button", { name: "Action m-3" });
    act(() => button.focus());
    scrollTo(9);
    expect(document.activeElement).toBe(button);
    expect(rowElement("m-3")?.contains(button)).toBe(true);
    // Only one row is protected: the next row up from the visible range is
    // within the margin, but nothing far above the protected row is mounted.
    expect(rowElement("m-0") === null).toBe(true);

    act(() => screen.getByRole("textbox", { name: "Outside" }).focus());
    act(() => scrollVirtuoso?.({ startIndex: 9, endIndex: 11 }));
    expect(rowElement("m-3") === null).toBe(true);
  });

  test("a selection takes precedence over focus in another row; only one row is protected", () => {
    renderList();
    act(() => scrollVirtuoso?.({ startIndex: 8, endIndex: 14 }));
    act(() => screen.getByRole("button", { name: "Action m-14" }).focus());
    selectText(rowElement("m-10")!.querySelector("p")!.firstChild!);
    for (let start = 7; start >= 4; start--) {
      act(() => scrollVirtuoso?.({ startIndex: start, endIndex: start + 6 }));
    }
    // The selected row is visible; the focused row below it is not kept.
    expect(rowElement("m-10")?.isConnected).toBe(true);
    expect(rowElement("m-14") === null).toBe(true);
  });
});

describe("VirtualizedMessageList follow pausing", () => {
  test("selection, find and an expanded artifact or viewer each hold a pause reason until released", () => {
    const calls: Array<[string, boolean]> = [];
    renderList({ setFollowPaused: (reason, paused) => calls.push([reason, paused]) });
    const last = (reason: string) =>
      calls.filter(([candidate]) => candidate === reason).at(-1)?.[1] ?? false;

    selectText(rowElement("m-1")!.querySelector("p")!.firstChild!);
    expect(last("selection")).toBe(true);
    clearSelection();
    expect(last("selection")).toBe(false);

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    expect(last("find")).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(last("find")).toBe(false);

    act(() =>
      useArtifactLiveHostStore.setState({
        active: { placement: "fullscreen" } as never,
      }),
    );
    expect(last("expanded-artifact")).toBe(true);
    act(() => useArtifactLiveHostStore.setState({ active: { placement: "inline" } as never }));
    expect(last("expanded-artifact")).toBe(false);

    let pin: ReturnType<typeof pinRichViewKey> | null = null;
    act(() => {
      pin = pinRichViewKey("viewer-key");
    });
    expect(last("expanded-artifact")).toBe(true);
    act(() => pin!.release());
    expect(last("expanded-artifact")).toBe(false);
  });

  test("without the scroll hook's pause support, Virtuoso's follow is paused locally", () => {
    const { followOutput } = renderList();
    expect(lastFollowOutput).toBe(followOutput);
    selectText(rowElement("m-1")!.querySelector("p")!.firstChild!);
    // The literal false: Virtuoso's size paths treat any function as enabled.
    expect(lastFollowOutput).toBe(false);
    clearSelection();
    expect(lastFollowOutput).toBe(followOutput);
  });
});

describe("VirtualizedMessageList render priority", () => {
  test("rows outside the viewport (overscan) report prefetch; intersecting rows visible", () => {
    const observed = new Map<Element, (visible: boolean) => void>();
    const OriginalObserver = globalThis.IntersectionObserver;
    class FakeObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        observed.set(target, (isIntersecting) =>
          this.callback(
            [{ target, isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        );
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    }
    globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
    try {
      const { unmount } = renderList();
      const probe = (id: string) =>
        document.querySelector(`[data-priority-for="${id}"]`)?.textContent;
      expect(observed.size).toBe(3);
      act(() => observed.get(rowElement("m-2")!)!(false));
      expect(probe("m-2")).toBe("prefetch");
      expect(probe("m-1")).toBe("visible");
      act(() => observed.get(rowElement("m-2")!)!(true));
      expect(probe("m-2")).toBe("visible");
      // Only mounted rows are observed; unmounting releases every observation.
      unmount();
      expect(observed.size).toBe(0);
    } finally {
      globalThis.IntersectionObserver = OriginalObserver;
    }
  });
});

test.each(["first", "last"])(
  "overscan converges while the %s row is protected at a clipped edge",
  (edge) => {
    renderList();
    const index = edge === "first" ? 0 : ROWS.length - 1;
    if (edge === "last") scrollTo(index - 2);
    const selected = rowElement(`m-${index}`)!;
    selectText(selected.querySelector("p")!.firstChild!);
    scrollTo(edge === "first" ? KEEP_MOUNTED_MAX_ROWS : index - KEEP_MOUNTED_MAX_ROWS - 2);
    expect(rowElement(`m-${index}`)).toBe(selected);
    expect(selected.isConnected).toBe(true);
    expect(document.getSelection()?.toString()).toBe(`Message number ${index}`);
    scrollTo(edge === "first" ? KEEP_MOUNTED_MAX_ROWS + 1 : index - KEEP_MOUNTED_MAX_ROWS - 3);
    expect(rowElement(`m-${index}`)).toBeNull();
  },
);
