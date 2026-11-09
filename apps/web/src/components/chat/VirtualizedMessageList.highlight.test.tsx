import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRef, type ReactNode } from "react";
import * as realVirtuoso from "react-virtuoso";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { ConversationTargetHighlight } from "@/lib/transcript-scroll/conversation-target-highlight";
import {
  resetConversationScrollTargets,
  useConversationScrollTargetStore,
} from "@/stores/conversationScrollTargetStore";
import { useConversationScrollTarget } from "@/components/native-agent/useConversationScrollTarget";

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

const { VirtualizedMessageList } = await import("./VirtualizedMessageList");

beforeEach(() => resetConversationScrollTargets());
afterEach(() => cleanup());
afterAll(() => mock.module("react-virtuoso", () => realVirtuosoSnapshot));

interface Row {
  id: string;
  /** How the row's renderer marks its own box. */
  shape: "card" | "nested" | "unmarked";
}

const ROWS: Row[] = [
  { id: "card", shape: "card" },
  { id: "other", shape: "card" },
  { id: "nested", shape: "nested" },
  { id: "plain", shape: "unmarked" },
];

function renderRow(row: Row) {
  if (row.shape === "unmarked") return <p data-testid={`item-${row.id}`}>Plain {row.id}</p>;
  return (
    <div className="px-3 py-3" data-testid={`padding-${row.id}`}>
      <div data-transcript-item="message" data-testid={`item-${row.id}`} className="max-w-3xl">
        Message {row.id}
        {row.shape === "nested" ? (
          <div data-transcript-item="mail" data-testid="nested-tile">
            Nested tile
          </div>
        ) : null}
      </div>
    </div>
  );
}

const scrollProps = {
  followOutput: () => false as const,
  atBottomStateChange: () => {},
  atBottomThreshold: 0,
  restoreStateFrom: undefined,
};

function List({ highlight }: { highlight: ConversationTargetHighlight | null }) {
  return (
    <VirtualizedMessageList
      messages={ROWS}
      computeItemKey={(_index, row) => row.id}
      renderMessage={(_index, row) => renderRow(row)}
      scrollProps={scrollProps}
      virtuosoRef={createRef()}
      highlight={highlight}
    />
  );
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-chat-message-key="${id}"]`)!;
const item = (id: string) => document.querySelector<HTMLElement>(`[data-testid="item-${id}"]`)!;
/** Which elements glow, by test id (never deep-compare DOM nodes). */
const glowing = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>("[data-conversation-target-glow]"),
    (element) => element.dataset.testid ?? element.tagName,
  );
const jump = (messageId: string, generation: number, durationMs = 2_500) => ({
  messageId,
  generation,
  durationMs,
});

describe("VirtualizedMessageList jump highlight", () => {
  test("the glow goes on the item's own box, not the full-width row", () => {
    render(<List highlight={jump("card", 1)} />);

    expect(row("card").getAttribute("data-conversation-target")).toBe("true");
    // The row keeps no fill or outline of its own.
    expect(row("card").className).not.toMatch(/bg-sky|outline-sky|outline-2/);
    expect(row("card").hasAttribute("data-conversation-target-glow")).toBe(false);
    expect(
      document
        .querySelector('[data-testid="padding-card"]')!
        .hasAttribute("data-conversation-target-glow"),
    ).toBe(false);

    expect(item("card").getAttribute("data-conversation-target-glow")).toMatch(/^[ab]$/);
    expect(item("card").style.getPropertyValue("--conversation-target-glow-duration")).toBe(
      "2500ms",
    );
    expect(glowing()).toEqual(["item-card"]);
  });

  test("the outermost marked box wins over a tile nested inside the item", () => {
    render(<List highlight={jump("nested", 1)} />);
    expect(glowing()).toEqual(["item-nested"]);
  });

  test("an item with no marked box glows at the row's content wrapper", () => {
    render(<List highlight={jump("plain", 1)} />);
    const wrapper = item("plain").parentElement!;
    expect(wrapper.hasAttribute("data-conversation-target-glow")).toBe(true);
    expect(wrapper === row("plain")).toBe(false);
    expect(glowing()).toHaveLength(1);
  });

  test("clearing the highlight removes the glow and its duration", () => {
    const { rerender } = render(<List highlight={jump("card", 1)} />);
    rerender(<List highlight={null} />);
    expect(glowing()).toEqual([]);
    expect(item("card").style.getPropertyValue("--conversation-target-glow-duration")).toBe("");
    expect(row("card").hasAttribute("data-conversation-target")).toBe(false);
  });

  test("a repeat jump to the same item restarts the glow; another item takes it over", () => {
    const { rerender } = render(<List highlight={jump("card", 1)} />);
    const first = item("card").getAttribute("data-conversation-target-glow");

    // A new generation switches to the other, identical animation, which is
    // what restarts a CSS animation on an element that keeps the attribute.
    rerender(<List highlight={jump("card", 2)} />);
    const second = item("card").getAttribute("data-conversation-target-glow");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    rerender(<List highlight={jump("card", 3)} />);
    expect(item("card").getAttribute("data-conversation-target-glow")).toBe(first);

    rerender(<List highlight={jump("other", 4)} />);
    expect(glowing()).toEqual(["item-other"]);
    expect(row("card").hasAttribute("data-conversation-target")).toBe(false);
  });

  test("a jump through the scroll target glows the item and removes it at the end of the period", async () => {
    const nodeId = getWindowScope().commandScope().nodeId;
    function Harness() {
      const highlight = useConversationScrollTarget({
        environmentId: "env-1",
        tabId: "tab-1",
        isActive: true,
        messages: ROWS,
        transcriptSettled: true,
        scrollToIndex: () => true,
        highlightMs: 120,
      });
      return <List highlight={highlight} />;
    }
    render(<Harness />);
    act(() => {
      useConversationScrollTargetStore
        .getState()
        .request({ nodeId, environmentId: "env-1", tabId: "tab-1" }, { messageId: "card" });
    });
    await waitFor(() => expect(glowing()).toEqual(["item-card"]));
    // The fade runs for exactly the period the glow is kept.
    expect(item("card").style.getPropertyValue("--conversation-target-glow-duration")).toBe(
      "120ms",
    );
    await waitFor(() => expect(glowing()).toEqual([]));
  });
});

describe("jump highlight stylesheet", () => {
  const css = readFileSync(path.resolve(import.meta.dir, "../../index.css"), "utf8");

  test("the glow is a box-shadow only, fading over the highlight period", () => {
    const rule = css.match(/\n\[data-conversation-target-glow\] \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("box-shadow: var(--conversation-target-glow-shadow)");
    expect(rule).toContain("animation-duration: var(--conversation-target-glow-duration");
    expect(rule).toContain("animation-fill-mode: forwards");
    expect(rule).not.toMatch(/outline|background|padding|margin|border:/);
    expect(css).toMatch(
      /\[data-conversation-target-glow="a"\] \{\s*animation-name: conversation-target-glow-a;/,
    );
    expect(css).toMatch(
      /\[data-conversation-target-glow="b"\] \{\s*animation-name: conversation-target-glow-b;/,
    );
  });

  test("reduced motion keeps the glow but drops the fade", () => {
    const reduced = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\[data-conversation-target-glow\]\[data-conversation-target-glow\] \{([^}]*)\}/,
    )?.[1];
    expect(reduced).toContain("animation: none");
    expect(reduced).not.toContain("box-shadow");
  });
});
