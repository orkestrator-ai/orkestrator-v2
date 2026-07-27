import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { VirtuosoHandle } from "react-virtuoso";
import * as realVirtualizedMessageList from "./VirtualizedMessageList";

const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

mock.module("./VirtualizedMessageList", () => ({
  VirtualizedMessageList: ({ footer, emptyState }: any) => (
    <div>
      {emptyState}
      {footer}
    </div>
  ),
}));

import { NativeChatShell } from "./NativeChatShell";

let resizeCallback: ResizeObserverCallback | null = null;
let resizeObserver: ResizeObserver | null = null;
const originalResizeObserver = globalThis.ResizeObserver;

function shellProps() {
  return {
    agentLabel: "Test",
    connectionState: "connected" as const,
    onRetry: () => {},
    messages: [],
    isLoading: false,
    elapsedSeconds: null,
    finalElapsedSeconds: null,
    centerCompose: false,
    composer: <textarea aria-label="Prompt" />,
    isAtBottom: true,
    scrollToBottom: () => {},
    scrollProps: {
      followOutput: () => false as const,
      atBottomStateChange: () => {},
      atBottomThreshold: 100,
      restoreStateFrom: undefined,
    },
    virtuosoRef: createRef<VirtuosoHandle>(),
  };
}

describe("NativeChatShell", () => {
  beforeEach(() => {
    resizeCallback = null;
    resizeObserver = null;
    globalThis.ResizeObserver = class ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  afterEach(() => cleanup());

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    mock.module("./VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
  });

  test("reserves the measured dock height for pinned content and tracks growth", () => {
    render(
      <NativeChatShell
        {...shellProps()}
        blockingCards={<div>Approval with a long explanation</div>}
      />,
    );

    const dock = screen.getByTestId("compose-dock");
    const spacer = screen.getByTestId("transcript-bottom-spacer");
    dock.getBoundingClientRect = () =>
      ({ height: 640 } as DOMRect);

    act(() => {
      resizeCallback?.([], resizeObserver!);
    });
    expect(spacer.style.height).toBe("640px");
    expect(spacer.className).not.toContain("h-80");

    dock.getBoundingClientRect = () =>
      ({ height: 735 } as DOMRect);
    act(() => {
      resizeCallback?.([], resizeObserver!);
    });
    expect(spacer.style.height).toBe("735px");
  });

  test("remeasures pinned clearance when the viewport changes", () => {
    render(
      <NativeChatShell
        {...shellProps()}
        pinnedAccessory={<div>Plan details</div>}
      />,
    );

    const dock = screen.getByTestId("compose-dock");
    const spacer = screen.getByTestId("transcript-bottom-spacer");
    dock.getBoundingClientRect = () =>
      ({ height: 420 } as DOMRect);

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(spacer.style.height).toBe("420px");
  });

  test("retains the configured spacer when there is no pinned content", () => {
    render(
      <NativeChatShell
        {...shellProps()}
        bottomSpacerClassName="h-48"
      />,
    );

    const spacer = screen.getByTestId("transcript-bottom-spacer");
    expect(spacer.className).toContain("h-48");
    expect(spacer.style.height).toBe("");
  });

  test("renders blocking cards before the pinned accessory in one pinned region", () => {
    render(
      <NativeChatShell
        {...shellProps()}
        blockingCards={<div>Answer the blocking question</div>}
        pinnedAccessory={<div>Review the current plan</div>}
      />,
    );

    const blockingCard = screen.getByText("Answer the blocking question");
    const accessory = screen.getByText("Review the current plan");
    expect(blockingCard.parentElement).toBe(accessory.parentElement);
    expect(
      blockingCard.compareDocumentPosition(accessory)
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
