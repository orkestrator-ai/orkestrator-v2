import { describe, test, expect, mock, beforeEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { createRef } from "react";
import type { VirtuosoHandle } from "react-virtuoso";

// Capture the props passed to Virtuoso so we can assert on them
let lastVirtuosoProps: Record<string, any> = {};

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
        {data.map((item: any, index: number) => (
          <div key={index} data-testid={`virtuoso-item-${index}`}>
            {itemContent(index, item)}
          </div>
        ))}
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
});
