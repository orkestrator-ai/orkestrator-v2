/**
 * Acceptance tests for rich transcript identity, streaming stability and
 * keyboard operation (specification F2, F3, F11), through the real transcript
 * path: VirtualizedMessageList → NativeMessage → TextPart → MessageMarkdown →
 * rich block components.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import * as realVirtuoso from "react-virtuoso";
import { setHighlightBackend } from "@/lib/chat/highlighter/client";
import {
  setMermaidRenderer,
  setMermaidSvgSanitizer,
} from "@/lib/chat/rich-markdown/mermaid-render";
import { richBlockViewKey } from "@/lib/chat/rich-identity";
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { mockWriteText } from "../../../../../tests/mocks/clipboard";

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

afterAll(() => {
  mock.module("react-virtuoso", () => realVirtuosoSnapshot);
});

beforeEach(() => {
  // Each line becomes one token, so highlighted and plain text are identical.
  setHighlightBackend({
    highlight: async (input) => ({
      lines: input.code.split("\n").map((line) => (line ? [{ c: line, s: "#ff0000" }] : [])),
      stateId: null,
    }),
  });
  setMermaidSvgSanitizer((markup) => ({ svg: markup }));
  setMermaidRenderer(async () => ({
    ok: true,
    svg: '<svg viewBox="0 0 100 50"><text>diagram</text></svg>',
    diagramType: "flowchart",
    rendererVersion: "t",
    svgBytes: 10,
    svgElements: 2,
    edges: 0,
    renderDigest: "d",
  }));
  richRenderScheduler.clear();
  useRichContentViewStore.getState().reset();
  mockWriteText.mockReset();
  mockWriteText.mockImplementation(async () => {});
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  setHighlightBackend(undefined);
  setMermaidRenderer(null);
  setMermaidSvgSanitizer(null);
  document.documentElement.classList.remove("dark");
});

const DETAILS = [
  "<details>",
  "<summary>Release notes</summary>",
  "",
  "Body text.",
  "",
  "</details>",
].join("\n");

function textMessage(
  id: string,
  parts: Array<{ content: string; sourcePartId?: string }>,
): NativeMessageType {
  return {
    id,
    role: "assistant",
    content: "",
    createdAt: "2026-10-20T10:00:00.000Z",
    parts: parts.map((part) => ({ type: "text" as const, ...part })),
  };
}

function list(messages: NativeMessageType[]) {
  return (
    <VirtualizedMessageList
      messages={messages}
      computeItemKey={(_index, item) => item.id}
      renderMessage={(_index, item) => <NativeMessage message={item} />}
      scrollProps={{
        followOutput: () => false,
        atBottomStateChange: () => {},
        atBottomThreshold: 0,
        restoreStateFrom: undefined,
      }}
      virtuosoRef={createRef()}
    />
  );
}

describe("block identity and view state", () => {
  test("prepended history and inserted source parts keep a disclosure's identity and state", () => {
    const target = textMessage("m-target", [{ content: DETAILS, sourcePartId: "part-b" }]);
    const { rerender } = render(list([target]));
    const toggle = screen.getByRole("button", { name: /Release notes/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const key = richBlockViewKey(null, "m-target", "part-b", "details:0");
    expect(useRichContentViewStore.getState().entries.get(key)?.open).toBe(true);

    // A history page is prepended: the row is not reset or remounted.
    const older = [1, 2, 3].map((index) => textMessage(`m-old-${index}`, [{ content: DETAILS }]));
    rerender(list([...older, target]));
    const targetRow = document.querySelector<HTMLElement>('[data-chat-message-key="m-target"]')!;
    const sameToggle = within(targetRow).getByRole("button", { name: /Release notes/ });
    expect(sameToggle).toBe(toggle);
    expect(sameToggle.getAttribute("aria-expanded")).toBe("true");
    // The older rows' identical disclosures are independent and closed.
    for (const row of older) {
      const element = document.querySelector<HTMLElement>(`[data-chat-message-key="${row.id}"]`)!;
      expect(
        within(element)
          .getByRole("button", { name: /Release notes/ })
          .getAttribute("aria-expanded"),
      ).toBe("false");
    }

    // A source part is inserted before the disclosure's part: its block
    // identity is (message, source part, block), so it stays open.
    const withInserted = textMessage("m-target", [
      { content: "Inserted context first.", sourcePartId: "part-a" },
      { content: DETAILS, sourcePartId: "part-b" },
    ]);
    rerender(list([...older, withInserted]));
    const row = document.querySelector<HTMLElement>('[data-chat-message-key="m-target"]')!;
    expect(within(row).getByText("Inserted context first.")).toBeTruthy();
    expect(
      within(row)
        .getByRole("button", { name: /Release notes/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(useRichContentViewStore.getState().entries.get(key)?.open).toBe(true);
  });

  test("a theme change and a remount keep a disclosure open", async () => {
    const message = textMessage("m-theme", [
      { content: `${DETAILS}\n\n\`\`\`ts\nconst x = 1;\n\`\`\``, sourcePartId: "p" },
    ]);
    const first = render(list([message]));
    fireEvent.click(screen.getByRole("button", { name: /Release notes/ }));
    act(() => document.documentElement.classList.add("dark"));
    // Theme invalidates rendering work, not view state.
    await waitFor(() => expect(richRenderScheduler.stats().settled).toBeGreaterThan(0));
    expect(
      screen.getByRole("button", { name: /Release notes/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    first.unmount();
    render(list([message]));
    expect(
      screen.getByRole("button", { name: /Release notes/ }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("streaming stability", () => {
  test("a selection in a completed code line and the focused toolbar button survive appends", async () => {
    const base = "Intro paragraph.\n\n```ts\nconst done = 1;\nconst partial";
    const message = (content: string) => textMessage("m-stream", [{ content, sourcePartId: "p" }]);
    const view = render(list([message(base)]));
    await waitFor(() => expect(screen.getAllByText("const done = 1;").length).toBeGreaterThan(0));
    const lineText = screen
      .getAllByText("const done = 1;")
      .find((element) => !element.closest("[data-rich-search-mirror]"))!.firstChild as Text;
    const range = document.createRange();
    range.setStart(lineText, 6);
    range.setEnd(lineText, 10);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    const copy = screen.getByRole("button", { name: "Copy code" });
    act(() => copy.focus());
    const paragraph = screen.getByText("Intro paragraph.").firstChild as Text;

    let content = base;
    for (const chunk of [" = 2;\n", "const next", " = 3;\nconst la", "st = 4;\n"]) {
      content += chunk;
      view.rerender(list([message(content)]));
      await waitFor(() =>
        expect(
          document
            .querySelector("[data-rich-code-body]")
            ?.textContent?.includes(content.split("```ts\n")[1]!.split("\n").at(-2) ?? ""),
        ).toBe(true),
      );
    }
    // The completed line's text node, the paragraph's and the focus are untouched.
    expect(lineText.isConnected).toBe(true);
    expect(paragraph.isConnected).toBe(true);
    expect(document.getSelection()!.toString()).toBe("done");
    expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(lineText);
    expect(document.activeElement).toBe(copy);
  });
});

/**
 * Keyboard-only operation. happy-dom does not implement a button's keyboard
 * activation behaviour, so `press` applies it exactly as a browser does: a
 * focused button activates (click) on Enter keydown and on Space keyup, unless
 * the key event was cancelled. `tab` moves focus to the next tabbable control
 * in document order. Nothing here clicks with a pointer.
 */
const TABBABLE =
  'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function tab(): HTMLElement {
  const all = Array.from(document.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) => !element.closest("[hidden]"),
  );
  const index = all.indexOf(document.activeElement as HTMLElement);
  const next = all[(index + 1) % all.length]!;
  act(() => next.focus());
  return next;
}

function tabTo(name: string | RegExp, limit = 40): HTMLElement {
  for (let step = 0; step < limit; step++) {
    const element = tab();
    const label = element.getAttribute("aria-label") ?? element.textContent ?? "";
    if (typeof name === "string" ? label === name : name.test(label)) return element;
  }
  throw new Error(`No tabbable control named ${String(name)}`);
}

function press(key: "Enter" | " " | "Escape") {
  const target = document.activeElement as HTMLElement;
  const proceed = fireEvent.keyDown(target, { key });
  if (key === "Enter" && proceed && target.tagName === "BUTTON") fireEvent.click(target);
  const proceedUp = fireEvent.keyUp(target, { key });
  if (key === " " && proceed && proceedUp && target.tagName === "BUTTON") fireEvent.click(target);
}

describe("keyboard-only toolbars", () => {
  test("code block: wrap toggles, the viewer opens, Escape closes it and focus returns", async () => {
    render(
      list([textMessage("m-code", [{ content: "```ts\nconst x = 1;\n```", sourcePartId: "p" }])]),
    );
    act(() => (document.body as HTMLElement).focus());
    const wrap = tabTo("Wrap lines");
    expect(wrap.getAttribute("aria-pressed")).toBe("false");
    press(" ");
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
    const open = tabTo("Open in viewer");
    press("Enter");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    press("Escape");
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
    await waitFor(() => expect(document.activeElement).toBe(open));
    const copy = tabTo("Copy code");
    press("Enter");
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith("const x = 1;"));
    expect(document.activeElement).toBe(copy);
  });

  test("table: expand opens a dialog, Escape returns focus, copy works", async () => {
    const table = ["| Name | Value |", "| --- | --- |", "| alpha | 1 |"].join("\n");
    render(list([textMessage("m-table", [{ content: table, sourcePartId: "p" }])]));
    act(() => (document.body as HTMLElement).focus());
    // The scroll region itself is reachable, so wide tables scroll by keyboard.
    tabTo("Table contents, scroll horizontally");
    const expand = tabTo("Expand table");
    press("Enter");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    press("Escape");
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
    await waitFor(() => expect(document.activeElement).toBe(expand));
    tabTo("Copy as Markdown");
    press("Enter");
    await waitFor(() => expect(mockWriteText).toHaveBeenCalled());
  });

  test("diagram: show source toggles, the expanded dialog opens and closes by keyboard", async () => {
    render(
      list([
        textMessage("m-diagram", [
          { content: "```mermaid\nflowchart TD\n  A --> B\n```", sourcePartId: "p" },
        ]),
      ]),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-rich-search-exclude] svg")).toBeTruthy(),
    );
    act(() => (document.body as HTMLElement).focus());
    const source = tabTo("Show source");
    press("Enter");
    expect(source.getAttribute("aria-pressed")).toBe("true");
    press(" ");
    expect(source.getAttribute("aria-pressed")).toBe("false");
    const expand = tabTo("Expand diagram");
    press("Enter");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Fit diagram" })).toBeTruthy();
    press("Escape");
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
    expect(expand.isConnected).toBe(true);
  });

  // MermaidBlock's expanded dialog has no DialogTrigger, so Radix alone would
  // return focus to <body>; `useDialogFocusReturn()` restores the opener.
  test("diagram: focus returns to Expand diagram after the dialog closes", async () => {
    render(
      list([
        textMessage("m-diagram", [
          { content: "```mermaid\nflowchart TD\n  A --> B\n```", sourcePartId: "p" },
        ]),
      ]),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-rich-search-exclude] svg")).toBeTruthy(),
    );
    act(() => (document.body as HTMLElement).focus());
    const expand = tabTo("Expand diagram");
    press("Enter");
    await screen.findByRole("dialog");
    press("Escape");
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
    await waitFor(() => expect(document.activeElement).toBe(expand));
  });
});
