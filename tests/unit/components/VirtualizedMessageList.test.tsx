import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";

// Capture the props passed to Virtuoso so we can assert on them
let lastVirtuosoProps: Record<string, any> = {};
let renderedItemIndexes: Set<number> | null = null;

mock.module("react-virtuoso", () => ({
  Virtuoso: (props: any) => {
    lastVirtuosoProps = props;
    const { data, itemContent, components, context } = props;

    // Render EmptyPlaceholder when data is empty
    if (data.length === 0 && components?.EmptyPlaceholder) {
      const Empty = components.EmptyPlaceholder;
      return (
        <div data-testid="virtuoso-mock">
          <Empty context={context} />
        </div>
      );
    }

    // Render items + footer
    return (
      <div data-testid="virtuoso-mock">
        {data.map((item: any, index: number) =>
          !renderedItemIndexes || renderedItemIndexes.has(index) ? (
            <div key={index} data-testid={`virtuoso-item-${index}`}>
              {itemContent(index, item)}
            </div>
          ) : null,
        )}
        {components?.Footer && (
          <div data-testid="virtuoso-footer">
            {(() => {
              const Footer = components.Footer;
              return <Footer context={context} />;
            })()}
          </div>
        )}
      </div>
    );
  },
}));

import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";

interface TestMessage {
  id: string;
  text: string;
}

class TestHighlight {
  readonly ranges: Range[];

  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

const originalHighlight = globalThis.Highlight;
const originalCSS = globalThis.CSS;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const cssHighlights = new Map<string, TestHighlight>();

function installHighlightApi() {
  cssHighlights.clear();
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { highlights: cssHighlights },
  });
  Object.defineProperty(globalThis, "Highlight", {
    configurable: true,
    value: TestHighlight,
    writable: true,
  });
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
}

function makeScrollProps() {
  return {
    followOutput: (_atBottom: boolean) => "auto" as const,
    atBottomStateChange: () => {},
    atBottomThreshold: 50,
    restoreStateFrom: undefined,
  };
}

describe("VirtualizedMessageList", () => {
  beforeEach(() => {
    cleanup();
    lastVirtuosoProps = {};
    renderedItemIndexes = null;
    installHighlightApi();
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: originalCSS,
      writable: true,
    });
    Object.defineProperty(globalThis, "Highlight", {
      configurable: true,
      value: originalHighlight,
      writable: true,
    });
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  test("renders messages via itemContent", () => {
    const messages: TestMessage[] = [
      { id: "1", text: "Hello" },
      { id: "2", text: "World" },
    ];

    render(
      <VirtualizedMessageList
        messages={messages}
        computeItemKey={(_i, msg) => msg.id}
        renderMessage={(_i, msg, _prev) => <span>{msg.text}</span>}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
      />
    );

    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.getByText("World")).toBeTruthy();
  });

  test("passes previous message to renderMessage", () => {
    const messages: TestMessage[] = [
      { id: "1", text: "First" },
      { id: "2", text: "Second" },
    ];
    const prevMessages: (TestMessage | null)[] = [];

    render(
      <VirtualizedMessageList
        messages={messages}
        computeItemKey={(_i, msg) => msg.id}
        renderMessage={(_i, msg, prev) => {
          prevMessages.push(prev);
          return <span>{msg.text}</span>;
        }}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
      />
    );

    expect(prevMessages[0]).toBeNull();
    expect(prevMessages[1]).toEqual({ id: "1", text: "First" });
  });

  test("renders EmptyPlaceholder when messages array is empty", () => {
    render(
      <VirtualizedMessageList
        messages={[]}
        computeItemKey={(_i, msg) => (msg as any).id}
        renderMessage={() => <span>should not render</span>}
        emptyState={<p>No messages yet</p>}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
      />
    );

    expect(screen.getByText("No messages yet")).toBeTruthy();
    expect(screen.queryByText("should not render")).toBeNull();
  });

  test("does not render EmptyPlaceholder when messages exist", () => {
    const messages: TestMessage[] = [{ id: "1", text: "Hi" }];

    render(
      <VirtualizedMessageList
        messages={messages}
        computeItemKey={(_i, msg) => msg.id}
        renderMessage={(_i, msg) => <span>{msg.text}</span>}
        emptyState={<p>No messages yet</p>}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
      />
    );

    expect(screen.queryByText("No messages yet")).toBeNull();
    expect(screen.getByText("Hi")).toBeTruthy();
  });

  test("renders footer content", () => {
    const messages: TestMessage[] = [{ id: "1", text: "Hi" }];

    render(
      <VirtualizedMessageList
        messages={messages}
        computeItemKey={(_i, msg) => msg.id}
        renderMessage={(_i, msg) => <span>{msg.text}</span>}
        footer={<div>Loading...</div>}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
      />
    );

    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  test("does not render footer when not provided", () => {
    const messages: TestMessage[] = [{ id: "1", text: "Hi" }];

    render(
      <VirtualizedMessageList
        messages={messages}
        computeItemKey={(_i, msg) => msg.id}
        renderMessage={(_i, msg) => <span>{msg.text}</span>}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
      />
    );

    expect(screen.queryByTestId("virtuoso-footer")).toBeNull();
  });

  test("passes scroll props through to Virtuoso", () => {
    const followOutput = (atBottom: boolean) =>
      atBottom ? ("auto" as const) : false;
    const atBottomStateChange = () => {};
    const totalListHeightChanged = () => {};
    const restoreState = { ranges: [], scrollTop: 100 } as any;

    render(
      <VirtualizedMessageList
        messages={[]}
        computeItemKey={(_i, msg) => (msg as any).id}
        renderMessage={() => null}
        scrollProps={{
          followOutput,
          atBottomStateChange,
          atBottomThreshold: 75,
          totalListHeightChanged,
          restoreStateFrom: restoreState,
        }}
        virtuosoRef={createRef<VirtuosoHandle>()}
      />
    );

    expect(lastVirtuosoProps.followOutput).toBe(followOutput);
    expect(lastVirtuosoProps.atBottomStateChange).toBe(atBottomStateChange);
    expect(lastVirtuosoProps.atBottomThreshold).toBe(75);
    expect(lastVirtuosoProps.totalListHeightChanged).toBe(totalListHeightChanged);
    expect(lastVirtuosoProps.restoreStateFrom).toBe(restoreState);
  });

  test("passes computeItemKey through to Virtuoso", () => {
    const computeItemKey = (_i: number, msg: TestMessage) => msg.id;

    render(
      <VirtualizedMessageList
        messages={[{ id: "1", text: "Hi" }]}
        computeItemKey={computeItemKey}
        renderMessage={(_i, msg) => <span>{msg.text}</span>}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
      />
    );

    expect(lastVirtuosoProps.computeItemKey).toBe(computeItemKey);
  });

  test("sets increaseViewportBy for overscan", () => {
    render(
      <VirtualizedMessageList
        messages={[]}
        computeItemKey={(_i, msg) => (msg as any).id}
        renderMessage={() => null}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
      />
    );

    expect(lastVirtuosoProps.increaseViewportBy).toEqual({
      top: 400,
      bottom: 200,
    });
  });

  test("components identity stays stable when footer content changes", () => {
    const ref = createRef<VirtuosoHandle>();
    const { rerender } = render(
      <VirtualizedMessageList
        messages={[{ id: "1", text: "Hi" }]}
        computeItemKey={(_i, msg) => (msg as any).id}
        renderMessage={(_i, msg) => <span>{(msg as any).text}</span>}
        footer={<div>Footer v1</div>}
        scrollProps={makeScrollProps()}
        virtuosoRef={ref}
      />
    );

    const firstComponents = lastVirtuosoProps.components;

    rerender(
      <VirtualizedMessageList
        messages={[{ id: "1", text: "Hi" }]}
        computeItemKey={(_i, msg) => (msg as any).id}
        renderMessage={(_i, msg) => <span>{(msg as any).text}</span>}
        footer={<div>Footer v2</div>}
        scrollProps={makeScrollProps()}
        virtuosoRef={ref}
      />
    );

    // Components object identity must not change when only footer content changes,
    // because a new identity causes Virtuoso to unmount/remount children.
    expect(lastVirtuosoProps.components).toBe(firstComponents);
    // But context should update so the new content renders
    expect(lastVirtuosoProps.context.footer).toBeTruthy();
  });

  test("components identity changes when footer presence toggles", () => {
    const ref = createRef<VirtuosoHandle>();
    const { rerender } = render(
      <VirtualizedMessageList
        messages={[{ id: "1", text: "Hi" }]}
        computeItemKey={(_i, msg) => (msg as any).id}
        renderMessage={(_i, msg) => <span>{(msg as any).text}</span>}
        footer={<div>Footer</div>}
        scrollProps={makeScrollProps()}
        virtuosoRef={ref}
      />
    );

    const firstComponents = lastVirtuosoProps.components;
    expect(firstComponents.Footer).toBeDefined();

    rerender(
      <VirtualizedMessageList
        messages={[{ id: "1", text: "Hi" }]}
        computeItemKey={(_i, msg) => (msg as any).id}
        renderMessage={(_i, msg) => <span>{(msg as any).text}</span>}
        scrollProps={makeScrollProps()}
        virtuosoRef={ref}
      />
    );

    // Components object should change because footer presence toggled
    expect(lastVirtuosoProps.components).not.toBe(firstComponents);
    expect(lastVirtuosoProps.components.Footer).toBeUndefined();
  });

  test("context updates when footer or emptyState content changes", () => {
    const ref = createRef<VirtuosoHandle>();
    const { rerender } = render(
      <VirtualizedMessageList
        messages={[{ id: "1", text: "Hi" }]}
        computeItemKey={(_i, msg) => (msg as any).id}
        renderMessage={(_i, msg) => <span>{(msg as any).text}</span>}
        footer={<div>Footer v1</div>}
        emptyState={<p>Empty v1</p>}
        scrollProps={makeScrollProps()}
        virtuosoRef={ref}
      />
    );

    const firstContext = lastVirtuosoProps.context;

    rerender(
      <VirtualizedMessageList
        messages={[{ id: "1", text: "Hi" }]}
        computeItemKey={(_i, msg) => (msg as any).id}
        renderMessage={(_i, msg) => <span>{(msg as any).text}</span>}
        footer={<div>Footer v2</div>}
        emptyState={<p>Empty v1</p>}
        scrollProps={makeScrollProps()}
        virtuosoRef={ref}
      />
    );

    // Context should update so Virtuoso renders new footer content
    expect(lastVirtuosoProps.context).not.toBe(firstContext);
  });

  test("footer renders nothing when context has no footer", () => {
    // Render with no footer and no emptyState — the components object
    // should not include Footer or EmptyPlaceholder at all.
    render(
      <VirtualizedMessageList
        messages={[{ id: "1", text: "Hi" }]}
        computeItemKey={(_i, msg) => (msg as any).id}
        renderMessage={(_i, msg) => <span>{(msg as any).text}</span>}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
      />
    );

    expect(lastVirtuosoProps.components.Footer).toBeUndefined();
    expect(lastVirtuosoProps.components.EmptyPlaceholder).toBeUndefined();
    expect(screen.queryByTestId("virtuoso-footer")).toBeNull();
  });

  test("opens find, counts the full list, and centers the current row", () => {
    const scrollToIndex = mock(() => {});
    const virtuosoRef = {
      current: { scrollToIndex },
    } as unknown as RefObject<VirtuosoHandle>;
    const messages = [
      { id: "1", text: "first needle" },
      { id: "2", text: "second needle" },
    ];

    render(
      <VirtualizedMessageList
        messages={messages}
        computeItemKey={(_index, message) => message.id}
        renderMessage={(_index, message) => (
          <span data-agent-chat-search-content="true">{message.text}</span>
        )}
        scrollProps={makeScrollProps()}
        virtuosoRef={virtuosoRef}
        find={{ isActive: true, getSearchText: (message) => message.text }}
      />,
    );

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in chat" }), {
      target: { value: "needle" },
    });

    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(scrollToIndex).toHaveBeenLastCalledWith({
      index: 0,
      align: "center",
      behavior: "auto",
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Find in chat" }), {
      key: "Enter",
    });
    expect(scrollToIndex).toHaveBeenLastCalledWith({
      index: 1,
      align: "center",
      behavior: "auto",
    });
    expect(
      screen.getByText("second needle").closest("[data-chat-message-index]")?.className,
    ).toContain("outline");
  });

  test("highlights only searchable content and spans fragmented text nodes", () => {
    render(
      <VirtualizedMessageList
        messages={[{ id: "1", text: "Can you help?" }]}
        computeItemKey={(_index, message) => message.id}
        renderMessage={() => (
          <div>
            <span className="sr-only">You</span>
            <div data-agent-chat-search-content="true">
              <strong>Can</strong>
              {" you help?"}
            </div>
          </div>
        )}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
        find={{ isActive: true, getSearchText: (message) => message.text }}
      />,
    );

    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    const input = screen.getByRole("textbox", { name: "Find in chat" });
    fireEvent.change(input, { target: { value: "you" } });

    const current = Array.from(cssHighlights.entries())
      .find(([name]) => name.includes("agent-chat-find-current"))?.[1];
    expect(current?.ranges).toHaveLength(1);
    expect(current?.ranges[0]?.toString()).toBe("you");

    fireEvent.change(input, { target: { value: "Can you" } });
    const fragmented = Array.from(cssHighlights.entries())
      .find(([name]) => name.includes("agent-chat-find-current"))?.[1];
    expect(fragmented?.ranges[0]?.toString()).toBe("Can you");
  });

  test("uses Unicode-safe DOM offsets", () => {
    render(
      <VirtualizedMessageList
        messages={[{ id: "1", text: "İx" }]}
        computeItemKey={(_index, message) => message.id}
        renderMessage={(index, message) => (
          <span data-agent-chat-search-content={index}>{message.text}</span>
        )}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
        find={{ isActive: true, getSearchText: (message) => message.text }}
      />,
    );

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in chat" }), {
      target: { value: "x" },
    });

    const current = Array.from(cssHighlights.entries())
      .find(([name]) => name.includes("agent-chat-find-current"))?.[1];
    expect(current?.ranges[0]?.toString()).toBe("x");
  });

  test("keeps each mounted list's highlight registry entries isolated", () => {
    const activeMessages = [{ id: "active", text: "needle" }];
    const firstInactiveMessages = [{ id: "inactive", text: "background" }];
    const secondInactiveMessages = [{ id: "inactive", text: "background update" }];
    const renderLists = (inactiveMessages: TestMessage[]) => (
      <>
        <VirtualizedMessageList
          messages={activeMessages}
          computeItemKey={(_index, message) => message.id}
          renderMessage={(_index, message) => (
            <span data-agent-chat-search-content="true">{message.text}</span>
          )}
          scrollProps={makeScrollProps()}
          virtuosoRef={createRef<VirtuosoHandle>()}
          find={{ isActive: true, getSearchText: (message) => message.text }}
        />
        <VirtualizedMessageList
          messages={inactiveMessages}
          computeItemKey={(_index, message) => message.id}
          renderMessage={(_index, message) => (
            <span data-agent-chat-search-content="true">{message.text}</span>
          )}
          scrollProps={makeScrollProps()}
          virtuosoRef={createRef<VirtuosoHandle>()}
          find={{ isActive: false, getSearchText: (message) => message.text }}
        />
      </>
    );
    const view = render(renderLists(firstInactiveMessages));

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in chat" }), {
      target: { value: "needle" },
    });
    const activeKeys = Array.from(cssHighlights.keys());
    expect(activeKeys).toHaveLength(2);

    view.rerender(renderLists(secondInactiveMessages));
    expect(Array.from(cssHighlights.keys())).toEqual(activeKeys);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(cssHighlights.size).toBe(0);
  });

  test("cleans up only its own highlights on deactivation and unmount", () => {
    const messages = [{ id: "1", text: "needle" }];
    const renderList = (isActive: boolean) => (
      <VirtualizedMessageList
        messages={messages}
        computeItemKey={(_index, message) => message.id}
        renderMessage={(_index, message) => (
          <span data-agent-chat-search-content="true">{message.text}</span>
        )}
        scrollProps={makeScrollProps()}
        virtuosoRef={createRef<VirtuosoHandle>()}
        find={{ isActive, getSearchText: (message) => message.text }}
      />
    );
    const view = render(renderList(true));

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in chat" }), {
      target: { value: "needle" },
    });
    expect(cssHighlights.size).toBe(2);

    view.rerender(renderList(false));
    expect(cssHighlights.size).toBe(0);
    view.rerender(renderList(true));
    expect(cssHighlights.size).toBe(2);

    view.unmount();
    expect(cssHighlights.size).toBe(0);
  });

  test("retains count and navigation when CSS Highlights are unsupported", () => {
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: {},
    });
    globalThis.Highlight = undefined as unknown as typeof Highlight;
    const scrollToIndex = mock(() => {});

    render(
      <VirtualizedMessageList
        messages={[{ id: "1", text: "needle" }]}
        computeItemKey={(_index, message) => message.id}
        renderMessage={(_index, message) => <span>{message.text}</span>}
        scrollProps={makeScrollProps()}
        virtuosoRef={{
          current: { scrollToIndex },
        } as unknown as RefObject<VirtuosoHandle>}
        find={{ isActive: true, getSearchText: (message) => message.text }}
      />,
    );

    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in chat" }), {
      target: { value: "needle" },
    });
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(scrollToIndex).toHaveBeenCalled();
  });

  test("bounds materialization retries when the current row is still unmounted", () => {
    renderedItemIndexes = new Set([0]);
    let frameCount = 0;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frameCount += 1;
      callback(frameCount);
      return frameCount;
    }) as typeof requestAnimationFrame;

    render(
      <VirtualizedMessageList
        messages={[
          { id: "1", text: "first" },
          { id: "2", text: "needle" },
        ]}
        computeItemKey={(_index, message) => message.id}
        renderMessage={(_index, message) => (
          <span data-agent-chat-search-content="true">{message.text}</span>
        )}
        scrollProps={makeScrollProps()}
        virtuosoRef={{
          current: { scrollToIndex: mock(() => {}) },
        } as unknown as RefObject<VirtuosoHandle>}
        find={{ isActive: true, getSearchText: (message) => message.text }}
      />,
    );

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in chat" }), {
      target: { value: "needle" },
    });
    expect(frameCount).toBeLessThanOrEqual(6);
  });
});
