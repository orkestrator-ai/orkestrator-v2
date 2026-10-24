import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import * as realVirtuoso from "react-virtuoso";
import { setHighlightBackend } from "@/lib/chat/highlighter/client";
import {
  setMermaidRenderer,
  setMermaidSvgSanitizer,
} from "@/lib/chat/rich-markdown/mermaid-render";
import { richBlockViewKey } from "@/lib/chat/rich-identity";
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import { withSearchProjection } from "@/lib/chat/rich-markdown/search-segments";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { useRichContentViewStore } from "@/stores/richContentViewStore";

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
  originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", {
    value: { highlights, supports: () => false, escape: (value: string) => value },
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  setHighlightBackend(null);
  setMermaidSvgSanitizer((markup) => ({ svg: markup }));
  setMermaidRenderer(async () => ({
    ok: true,
    svg: '<svg viewBox="0 0 10 10"><text>diagram</text></svg>',
    diagramType: "flowchart",
    rendererVersion: "t",
    svgBytes: 10,
    svgElements: 2,
    edges: 0,
    renderDigest: "d",
  }));
  richRenderScheduler.clear();
});

afterEach(() => {
  cleanup();
  highlights.clear();
  useRichContentViewStore.getState().reset();
});

afterAll(() => {
  setHighlightBackend(undefined);
  setMermaidRenderer(null);
  setMermaidSvgSanitizer(null);
  mock.module("react-virtuoso", () => realVirtuosoSnapshot);
  if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
});

function currentRange(): Range | undefined {
  return Array.from(highlights.entries()).find(([key]) => key.includes("current"))?.[1].ranges[0];
}

function scrollProps() {
  return {
    followOutput: () => false as const,
    atBottomStateChange: () => {},
    atBottomThreshold: 0,
    restoreStateFrom: undefined,
  };
}

describe("find pairs rich matches by block identity", () => {
  test("duplicate phrases in prose, a hidden disclosure and diagram source each reveal their own block", async () => {
    const content = [
      "The needle in prose.",
      "",
      "<details>",
      "<summary>Hidden</summary>",
      "",
      "Inside: needle.",
      "",
      "</details>",
      "",
      "```mermaid",
      "flowchart TD",
      "  A[needle] --> B",
      "```",
    ].join("\n");
    const message: NativeMessageType = {
      id: "assistant-segments",
      role: "assistant",
      content: "",
      createdAt: "2026-10-20T10:00:00.000Z",
      parts: [{ type: "text", content, sourcePartId: "part-1" }],
    };
    const { container } = render(
      <VirtualizedMessageList
        messages={[message]}
        computeItemKey={(_index, item) => item.id}
        renderMessage={(_index, item) => <NativeMessage message={item} />}
        scrollProps={scrollProps()}
        virtuosoRef={createRef()}
        find={{ isActive: true, getSearchText: getNativeMessageSearchText }}
      />,
    );
    // The diagram preview is shown, so its source is only a hidden mirror.
    await waitFor(() =>
      expect(container.querySelector("[data-rich-search-exclude] svg")).toBeTruthy(),
    );
    const toggle = screen.getByRole("button", { name: /Hidden/ });
    const diagramKey = richBlockViewKey(
      null,
      message.id,
      "part-1",
      `code:${content.indexOf("```mermaid")}`,
    );
    const diagramRevealed = () =>
      useRichContentViewStore.getState().entries.get(diagramKey)?.findRevealed === true;

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    fireEvent.change(await screen.findByRole("textbox", { name: "Find in chat" }), {
      target: { value: "needle" },
    });
    expect(await screen.findByText("1 of 3")).toBeTruthy();
    await waitFor(() => {
      const range = currentRange();
      expect(range?.startContainer.parentElement?.closest("[data-rich-block-key]") === null).toBe(
        true,
      );
      expect(range?.toString()).toBe("needle");
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(diagramRevealed()).toBe(false);

    const input = screen.getByRole("textbox", { name: "Find in chat" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("2 of 3")).toBeTruthy();
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    await waitFor(() => {
      const element = currentRange()?.startContainer.parentElement;
      expect(element?.closest('[data-rich-block="details"]')).toBeTruthy();
      expect(element?.closest("[data-rich-search-mirror]") === null).toBe(true);
    });
    expect(diagramRevealed()).toBe(false);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("3 of 3")).toBeTruthy();
    await waitFor(() => expect(diagramRevealed()).toBe(true));
    await waitFor(() => {
      const element = currentRange()?.startContainer.parentElement;
      expect(element?.closest('[data-rich-block="mermaid"]')).toBeTruthy();
      expect(element?.closest("[data-rich-search-mirror]") === null).toBe(true);
    });
    // The disclosure's temporary reveal was undone when the match moved on.
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
  });

  test("text inside one block that the model does not count cannot shift prose or other blocks", async () => {
    // A row whose code block shows an extra occurrence the model projection
    // does not have (e.g. a renderer label). With row ordinals, the prose
    // match would be drawn on the block's extra text instead.
    const blockKey = richBlockViewKey(null, "m-1", "part-1", "code:0");
    const tableKey = richBlockViewKey(null, "m-1", "part-1", "table:40");
    const row = { id: "m-1" };
    const getSearchText = withSearchProjection(
      () => "needle in code\nprose needle\nneedle in table",
      () => ({
        text: "needle in code\nprose needle\nneedle in table",
        segments: [
          {
            part: 0,
            blockId: "code:0",
            kind: "code" as const,
            start: 0,
            end: 14,
            sourceStart: 0,
            sourceEnd: 30,
            reveal: null,
          },
          {
            part: 0,
            blockId: "table:40",
            kind: "table" as const,
            start: 28,
            end: 43,
            sourceStart: 40,
            sourceEnd: 60,
            reveal: null,
          },
        ],
      }),
    );
    render(
      <VirtualizedMessageList
        messages={[row]}
        computeItemKey={(_index, item) => item.id}
        renderMessage={() => (
          <div data-agent-chat-search-content="true">
            <div data-rich-block-key={blockKey}>
              <span>needle in code</span>
              <span data-testid="extra">needle extra</span>
            </div>
            <p data-testid="prose">prose needle</p>
            <div data-rich-block-key={tableKey}>
              <span data-testid="table">needle in table</span>
            </div>
          </div>
        )}
        scrollProps={scrollProps()}
        virtuosoRef={createRef()}
        find={{ isActive: true, getSearchText }}
      />,
    );
    fireEvent.keyDown(document, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in chat" });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(await screen.findByText("1 of 3")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("2 of 3")).toBeTruthy();
    await waitFor(() =>
      expect(currentRange()?.startContainer.parentElement).toBe(screen.getByTestId("prose")),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("3 of 3")).toBeTruthy();
    await waitFor(() =>
      expect(currentRange()?.startContainer.parentElement).toBe(screen.getByTestId("table")),
    );
    // The unmatched extra text is never highlighted.
    const all = Array.from(highlights.entries()).find(([key]) => key.includes("match"))?.[1].ranges;
    expect(all).toHaveLength(3);
    expect(
      all?.some((range) => range.startContainer.parentElement === screen.getByTestId("extra")),
    ).toBe(false);
  });
});
