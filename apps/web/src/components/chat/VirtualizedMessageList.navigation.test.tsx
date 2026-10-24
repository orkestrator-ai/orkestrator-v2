import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import * as realVirtuoso from "react-virtuoso";
import type { TranscriptScrollController } from "@/lib/transcript-scroll/transcript-scroll-controller";

let lastProps: Record<string, unknown> = {};

// Renders every row with Virtuoso's absolute-index contract.
const realVirtuosoSnapshot = { ...realVirtuoso };
mock.module("react-virtuoso", () => ({
  ...realVirtuosoSnapshot,
  Virtuoso: (props: {
    data: unknown[];
    firstItemIndex?: number;
    itemContent: (index: number, item: unknown) => ReactNode;
    computeItemKey: (index: number, item: unknown) => string;
  }) => {
    lastProps = props as unknown as Record<string, unknown>;
    const base = props.firstItemIndex ?? 0;
    return (
      <div data-virtuoso-scroller="true">
        {props.data.map((item, index) => (
          <div key={props.computeItemKey(base + index, item)}>
            {props.itemContent(base + index, item)}
          </div>
        ))}
      </div>
    );
  },
}));

const { FIRST_ITEM_INDEX_BASE, VirtualizedMessageList } = await import("./VirtualizedMessageList");

afterEach(() => cleanup());
afterAll(() => mock.module("react-virtuoso", () => realVirtuosoSnapshot));

interface Row {
  id: string;
  text: string;
}
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, text: `row ${id}` }));

function fakeController() {
  const navigateTo = mock((_target: unknown, _owner: string) => true);
  let resolver: ((key: string) => number) | null = null;
  const controller = {
    navigateTo,
    retarget: mock(() => true),
    generation: 7,
    currentOwner: null,
    onLatestRequested: () => () => {},
    subscribe: () => () => {},
    getSnapshot: () => ({ targetKey: null }),
    holdingStructure: false,
    setRowIndexResolver: (next: ((key: string) => number) | null) => {
      resolver = next;
    },
  };
  return {
    controller: controller as unknown as TranscriptScrollController,
    navigateTo,
    resolve: (key: string) => resolver?.(key) ?? -2,
  };
}

function List({
  messages,
  controller,
}: {
  messages: Row[];
  controller: TranscriptScrollController;
}) {
  return (
    <VirtualizedMessageList
      messages={messages}
      computeItemKey={(_index, row) => row.id}
      renderMessage={(_index, row) => <div data-agent-chat-search-content="true">{row.text}</div>}
      scrollProps={{
        followOutput: () => "auto",
        atBottomStateChange: () => {},
        atBottomThreshold: 50,
        restoreStateFrom: undefined,
        controller,
      }}
      virtuosoRef={createRef()}
      find={{ isActive: true, getSearchText: (row: Row) => row.text }}
    />
  );
}

describe("VirtualizedMessageList navigation and index spaces", () => {
  test("a pure prepend lowers firstItemIndex by the display rows added; rows keep local indices", () => {
    const { controller } = fakeController();
    const view = render(<List messages={rows("c", "d")} controller={controller} />);
    expect(lastProps.firstItemIndex).toBe(FIRST_ITEM_INDEX_BASE);
    view.rerender(<List messages={rows("a", "b", "c", "d")} controller={controller} />);
    expect(lastProps.firstItemIndex).toBe(FIRST_ITEM_INDEX_BASE - 2);
    view.rerender(
      <List messages={rows("y", "z", "a", "b", "c", "d", "e")} controller={controller} />,
    );
    expect(lastProps.firstItemIndex).toBe(FIRST_ITEM_INDEX_BASE - 4);
    // A streaming append does not move it.
    view.rerender(
      <List messages={rows("y", "z", "a", "b", "c", "d", "e", "f")} controller={controller} />,
    );
    expect(lastProps.firstItemIndex).toBe(FIRST_ITEM_INDEX_BASE - 4);
    const indices = Array.from(
      document.querySelectorAll<HTMLElement>("[data-chat-message-index]"),
    ).map((row) => row.dataset.chatMessageIndex);
    expect(indices).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  });

  test("find navigates through the controller to the intended row after prepends, never the raw handle", async () => {
    const { controller, navigateTo, resolve } = fakeController();
    const view = render(<List messages={rows("m", "n")} controller={controller} />);
    view.rerender(
      <List
        messages={[
          ...rows("a", "b", "c"),
          { id: "target", text: "needle here" },
          ...rows("m", "n"),
        ]}
        controller={controller}
      />,
    );
    expect(lastProps.firstItemIndex).toBe(FIRST_ITEM_INDEX_BASE - 4);

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in chat" });
    act(() => {
      fireEvent.change(input, { target: { value: "needle" } });
    });
    expect(await screen.findByText("1 of 1")).toBeTruthy();
    expect(navigateTo).toHaveBeenCalled();
    const [target, owner] = navigateTo.mock.calls.at(-1)!;
    expect(owner).toBe("find");
    // Local index and identity: not the absolute index, not clamped to the end.
    expect(target).toEqual({ kind: "row", index: 3, key: "target", align: "center" });
    // Navigation by identity resolves the row's current local index.
    expect(resolve("target")).toBe(3);
    expect(resolve("missing")).toBe(-1);
  });

  test("re-rendering with an inline key callback does not navigate find again", async () => {
    const { controller, navigateTo } = fakeController();
    const messages = [...rows("a", "b"), { id: "target", text: "needle here" }];
    const view = render(<List messages={messages} controller={controller} />);
    fireEvent.keyDown(document, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in chat" });
    act(() => {
      fireEvent.change(input, { target: { value: "needle" } });
    });
    expect(await screen.findByText("1 of 1")).toBeTruthy();
    const navigations = navigateTo.mock.calls.length;
    expect(navigations).toBeGreaterThan(0);
    // `List` passes a new `computeItemKey` arrow on every render.
    for (let index = 0; index < 5; index += 1) {
      view.rerender(<List messages={messages} controller={controller} />);
    }
    expect(navigateTo.mock.calls.length).toBe(navigations);
  });

  test("clearing and re-entering a query navigates to the same occurrence again", async () => {
    const { controller, navigateTo } = fakeController();
    render(<List messages={[{ id: "target", text: "needle here" }]} controller={controller} />);
    fireEvent.keyDown(document, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in chat" });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(navigateTo).toHaveBeenCalledTimes(1);
    // A reader departs while find remains open.
    Object.assign(controller, { generation: controller.generation + 1 });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(navigateTo).toHaveBeenCalledTimes(2);
  });

  test("refining a query at the same offset navigates again, while streaming does not", async () => {
    const { controller, navigateTo } = fakeController();
    const messages = [{ id: "target", text: "needle here" }];
    const view = render(<List messages={messages} controller={controller} />);
    fireEvent.keyDown(document, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in chat" });
    fireEvent.change(input, { target: { value: "need" } });
    expect(navigateTo).toHaveBeenCalledTimes(1);
    Object.assign(controller, { generation: controller.generation + 1 });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(navigateTo).toHaveBeenCalledTimes(2);
    view.rerender(
      <List
        messages={[{ ...messages[0]!, text: "needle here streamed" }]}
        controller={controller}
      />,
    );
    expect(navigateTo).toHaveBeenCalledTimes(2);
  });
});
