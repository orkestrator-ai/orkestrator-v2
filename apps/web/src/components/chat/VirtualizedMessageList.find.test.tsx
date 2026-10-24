import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import * as realVirtuoso from "react-virtuoso";
import { setHighlightBackend } from "@/lib/chat/highlighter/client";
import { setMermaidRenderer } from "@/lib/chat/rich-markdown/mermaid-render";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { useRichContentViewStore } from "@/stores/richContentViewStore";

// Virtuoso measures real layout; happy-dom has none. Render every item so
// the find integration (search roots, ranges, reveal) runs against real rows.
const realVirtuosoSnapshot = { ...realVirtuoso };
mock.module("react-virtuoso", () => ({
  ...realVirtuosoSnapshot,
  Virtuoso: ({
    data,
    itemContent,
    firstItemIndex = 0,
    computeItemKey,
  }: {
    data: unknown[];
    firstItemIndex?: number;
    itemContent: (index: number, item: unknown) => ReactNode;
    computeItemKey: (index: number, item: unknown) => string;
  }) => (
    <div data-virtuoso-scroller="true">
      {data.map((item, index) => (
        <div key={computeItemKey(firstItemIndex + index, item)}>
          {itemContent(firstItemIndex + index, item)}
        </div>
      ))}
    </div>
  ),
}));

const { VirtualizedMessageList } = await import("./VirtualizedMessageList");
const { NativeMessage } = await import("./NativeMessage");
const { getNativeMessageSearchText } = await import("./native-message-search");

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const highlights = new Map<string, FakeHighlight>();
let originalCss: PropertyDescriptor | undefined;

beforeAll(() => {
  (globalThis as unknown as { Highlight: unknown }).Highlight = FakeHighlight;
  // happy-dom's `CSS` getter returns a fresh object each read; pin one with highlights.
  originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", {
    value: { highlights, supports: () => false, escape: (value: string) => value },
    configurable: true,
    writable: true,
  });
  setHighlightBackend(null);
  setMermaidRenderer(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  highlights.clear();
  useRichContentViewStore.getState().reset();
});

afterAll(() => {
  setHighlightBackend(undefined);
  setMermaidRenderer(null);
  mock.module("react-virtuoso", () => realVirtuosoSnapshot);
  if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
});

const CONTENT = [
  "Prose mentions items.length once.",
  "",
  "<details>",
  "<summary>Implementation notes</summary>",
  "",
  "```ts",
  "const label = `Count: ${items.length}`;",
  "```",
  "",
  "</details>",
].join("\n");

const message: NativeMessageType = {
  id: "assistant-find",
  role: "assistant",
  content: "",
  createdAt: "2026-10-20T10:00:00.000Z",
  parts: [{ type: "text", content: CONTENT }],
};

describe("VirtualizedMessageList find in rich content", () => {
  test("reveals a collapsed disclosure for its match and restores it when find closes", async () => {
    render(
      <VirtualizedMessageList
        messages={[message]}
        computeItemKey={(_index, item) => item.id}
        renderMessage={(_index, item) => <NativeMessage message={item} />}
        scrollProps={{
          followOutput: () => false,
          atBottomStateChange: () => {},
          atBottomThreshold: 0,
          restoreStateFrom: undefined,
        }}
        virtuosoRef={createRef()}
        find={{ isActive: true, getSearchText: getNativeMessageSearchText }}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Implementation notes/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in chat" });
    fireEvent.change(input, { target: { value: "items.length" } });
    expect(await screen.findByText("1 of 2")).toBeTruthy();

    // The first match is in prose: nothing is revealed.
    await waitFor(() =>
      expect(
        highlights.get(Array.from(highlights.keys()).find((key) => key.includes("current"))!)
          ?.ranges,
      ).toHaveLength(1),
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // The second match is inside the collapsed disclosure: find opens it.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("2 of 2")).toBeTruthy();
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    await waitFor(() => {
      const current = Array.from(highlights.entries()).find(([key]) =>
        key.includes("current"),
      )?.[1];
      const range = current?.ranges[0];
      expect(range?.toString()).toBe("items.length");
      expect(
        range?.startContainer.parentElement?.closest("[data-rich-search-mirror]") === null,
      ).toBe(true);
    });

    // Closing find restores the user's (closed) choice.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
  });
});
