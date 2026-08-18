import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";
import { pinNativeAgentParts } from "@/lib/chat/native-agent-pinning";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";
import * as realVirtualizedMessageList from "./VirtualizedMessageList";

const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
let lastVirtualizedMessageListProps: Record<string, any> | null = null;

mock.module("./VirtualizedMessageList", () => ({
  VirtualizedMessageList: (props: any) => {
    lastVirtualizedMessageListProps = props;
    return (
      <div>
        {props.emptyState}
        {props.messages.map((message: any, index: number) => (
          <div key={props.computeItemKey(index, message)}>
            {props.renderMessage(
              index,
              message,
              // Mirror the real list: honour the caller's resolver when it
              // supplies one, so these tests exercise the predecessor the shell
              // actually renders with rather than the raw neighbour.
              props.resolvePreviousMessage
                ? props.resolvePreviousMessage(props.messages, index)
                : index > 0
                  ? props.messages[index - 1]
                  : null,
            )}
          </div>
        ))}
        {props.footer}
      </div>
    );
  },
}));

import { NativeChatShell } from "./NativeChatShell";

let resizeCallback: ResizeObserverCallback | null = null;
let resizeObserver: ResizeObserver | null = null;
const originalResizeObserver = globalThis.ResizeObserver;

function shellProps() {
  return {
    agentLabel: "Test",
    platform: "codex" as const,
    agentExpansionScope: "environment-test",
    isActive: true,
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
    lastVirtualizedMessageListProps = null;
    resizeCallback = null;
    resizeObserver = null;
    globalThis.ResizeObserver = class ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        // Publishes the instance to the test; not an alias to dodge binding.
        // oxlint-disable-next-line typescript/no-this-alias
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
    dock.getBoundingClientRect = () => ({ height: 640 }) as DOMRect;

    act(() => {
      resizeCallback?.([], resizeObserver!);
    });
    expect(spacer.style.height).toBe("640px");
    expect(spacer.className).not.toContain("h-80");

    dock.getBoundingClientRect = () => ({ height: 735 }) as DOMRect;
    act(() => {
      resizeCallback?.([], resizeObserver!);
    });
    expect(spacer.style.height).toBe("735px");
  });

  test("tracks composer growth even when the dock has no pinned content", () => {
    render(<NativeChatShell {...shellProps()} />);

    const dock = screen.getByTestId("compose-dock");
    const spacer = screen.getByTestId("transcript-bottom-spacer");
    dock.getBoundingClientRect = () => ({ height: 148 }) as DOMRect;

    act(() => {
      resizeCallback?.([], resizeObserver!);
    });
    expect(spacer.style.height).toBe("148px");
    expect(spacer.className).not.toContain("h-32");

    // A multiline draft makes the dock taller. The transcript must gain the
    // same clearance so its last line can still scroll above the composer.
    dock.getBoundingClientRect = () => ({ height: 336 }) as DOMRect;
    act(() => {
      resizeCallback?.([], resizeObserver!);
    });
    expect(spacer.style.height).toBe("336px");
  });

  test("shows a desync warning while already at the bottom without another accessory", () => {
    render(<NativeChatShell {...shellProps()} desynced />);

    expect(screen.getByText(/Live updates disconnected/)).toBeTruthy();
  });

  test("exposes agent lifecycle announcements outside interactive transcript cards", () => {
    render(
      <NativeChatShell
        {...shellProps()}
        agentActivityAnnouncement={{ text: "1 sub-agent working: Reviewer.", seq: 1 }}
      />,
    );

    const status = screen.getByRole("status", {
      name: "1 sub-agent working: Reviewer.",
    });
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.closest("button") === null).toBe(true);
  });

  test("replaces the announced text node when the same message repeats", () => {
    /**
     * Two children can share a label, so "Sub-agent finished." can legitimately
     * be announced twice in a row. An unchanged text node is not a mutation, so
     * the region must be re-created from `seq` or the second one is never spoken.
     */
    const announcement = { text: "Sub-agent finished.", seq: 4 };
    const view = render(
      <NativeChatShell {...shellProps()} agentActivityAnnouncement={announcement} />,
    );

    const region = screen.getByRole("status", { name: "Sub-agent finished." });
    const firstNode = region.firstElementChild;
    expect(firstNode?.textContent).toBe("Sub-agent finished.");

    view.rerender(
      <NativeChatShell {...shellProps()} agentActivityAnnouncement={{ ...announcement, seq: 5 }} />,
    );

    const repeated = screen.getByRole("status", { name: "Sub-agent finished." });
    // The live region itself must survive; only its content is replaced.
    expect(repeated).toBe(region);
    expect(repeated.firstElementChild === firstNode).toBe(false);
    expect(repeated.firstElementChild?.textContent).toBe("Sub-agent finished.");
  });

  test("stays a silent live region until an announcement arrives", () => {
    // The region must already be in the accessibility tree before the first
    // message: a live region created at the same moment its text appears is
    // unreliable across screen readers.
    const { container } = render(<NativeChatShell {...shellProps()} />);

    const region = container.firstElementChild?.firstElementChild;
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.getAttribute("aria-atomic")).toBe("true");
    expect(region?.textContent).toBe("");
    expect(region?.getAttribute("role") === null).toBe(true);
  });

  test("shows the desync warning while the composer is centered", () => {
    /**
     * `centerCompose` is true exactly when the transcript is empty, which is
     * the state a tab sits in when it never received a message — the state the
     * banner exists for. Routing it through `topAccessory` hid it here, because
     * the dock suppresses that strip while centered.
     */
    render(<NativeChatShell {...shellProps()} centerCompose desynced />);

    expect(screen.getByText(/Live updates disconnected/)).toBeTruthy();
  });

  test("keeps the scroll affordance out of the centered layout while desynced", () => {
    // The banner is unconditional; the scroll-down button still belongs only to
    // a scrolled transcript, so the two must not have been merged into one row.
    render(<NativeChatShell {...shellProps()} centerCompose desynced isAtBottom={false} />);

    expect(screen.getByText(/Live updates disconnected/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Scroll to bottom of conversation" }) === null,
    ).toBe(true);
  });

  test("forwards the model-label resolver to each rendered message", () => {
    const resolveModelLabel = mock(() => "Friendly Model");
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
      content: "Done",
      parts: [{ type: "text" as const, content: "Done" }],
      createdAt: "2026-07-28T12:00:00.000Z",
      modelId: "provider/model-id",
    };

    render(
      <NativeChatShell
        {...shellProps()}
        messages={[message]}
        resolveModelLabel={resolveModelLabel}
      />,
    );

    expect(screen.getByText("Friendly Model")).toBeTruthy();
    expect(resolveModelLabel).toHaveBeenCalledWith("provider/model-id");
  });

  test("preserves expanded agent state as a pinned row changes membership", () => {
    const firstAgent: NativeMessagePart = {
      type: "subagent",
      content: "Reviewer",
      subagentId: "agent-1",
      subagentName: "Reviewer",
      subagentPrompt: "Inspect the original task details",
      toolState: "pending",
      subagentActions: [],
    };
    const secondAgent: NativeMessagePart = {
      type: "subagent",
      content: "Tester",
      subagentId: "agent-2",
      subagentName: "Tester",
      toolState: "pending",
      subagentActions: [],
    };
    const source: NativeMessage = {
      id: "assistant-agent-group",
      role: "assistant",
      content: "",
      parts: [firstAgent],
      createdAt: "2026-07-28T12:00:00.000Z",
    };
    const pinnedMessages = (parts: NativeMessagePart[]) =>
      pinNativeAgentParts([{ ...source, parts }]);

    const view = render(
      <NativeChatShell {...shellProps()} messages={pinnedMessages([firstAgent])} />,
    );

    const initialCard = screen.getByRole("button", { name: /reviewer/i });
    expect(within(initialCard).getByText("Active")).toBeTruthy();
    expect(within(initialCard).getByText("Inspect the original task details")).toBeTruthy();
    expect(initialCard.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(initialCard);
    expect(screen.getAllByText("Inspect the original task details")).toHaveLength(2);

    view.rerender(
      <NativeChatShell {...shellProps()} messages={pinnedMessages([firstAgent, secondAgent])} />,
    );

    expect(screen.getByRole("region", { name: "2 agents" })).toBeTruthy();
    expect(screen.getAllByText("Inspect the original task details")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /reviewer/i }).getAttribute("aria-expanded")).toBe(
      "true",
    );

    view.rerender(
      <NativeChatShell
        {...shellProps()}
        messages={pinnedMessages([firstAgent, { ...secondAgent, toolState: "success" }])}
      />,
    );

    expect(screen.queryByRole("region", { name: "2 agents" }) === null).toBe(true);
    expect(screen.getAllByText("Inspect the original task details")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /reviewer/i }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  test("remeasures pinned clearance when the viewport changes", () => {
    render(<NativeChatShell {...shellProps()} pinnedAccessory={<div>Plan details</div>} />);

    const dock = screen.getByTestId("compose-dock");
    const spacer = screen.getByTestId("transcript-bottom-spacer");
    dock.getBoundingClientRect = () => ({ height: 420 }) as DOMRect;

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(spacer.style.height).toBe("420px");
  });

  test("uses the configured spacer before an unpinned dock can be measured", () => {
    render(<NativeChatShell {...shellProps()} bottomSpacerClassName="h-48" />);

    const spacer = screen.getByTestId("transcript-bottom-spacer");
    expect(spacer.className).toContain("h-48");
    expect(spacer.style.height).toBe("");
  });

  test("treats an empty blockingCards array as no pinned content", () => {
    /**
     * `blockingCards` is a ReactNode and the natural thing to pass is a
     * `.map()` — Codex passes `pendingApprovals.map(...)`. An empty array is
     * truthy, so a `Boolean()` check would render the empty pinned wrapper and
     * permanently switch the spacer to dock-height mode on a tab with no
     * blocking prompt at all.
     */
    render(<NativeChatShell {...shellProps()} blockingCards={[]} />);

    const dock = screen.getByTestId("compose-dock");
    const spacer = screen.getByTestId("transcript-bottom-spacer");
    dock.getBoundingClientRect = () => ({ height: 500 }) as DOMRect;
    act(() => {
      resizeCallback?.([], resizeObserver!);
    });

    expect(spacer.className).not.toContain("h-32");
    expect(spacer.style.height).toBe("500px");
    expect(dock.querySelector(".max-h-\\[60vh\\]") === null).toBe(true);
  });

  test("reserves a conservative spacer for pinned content before the dock is measured", () => {
    // The dock has no laid-out height yet, so reserving its measurement would
    // clear nothing and the prompt would sit on top of the transcript.
    render(<NativeChatShell {...shellProps()} blockingCards={<div>Approve this command</div>} />);

    const spacer = screen.getByTestId("transcript-bottom-spacer");
    expect(spacer.className).toContain("h-80");
    expect(spacer.style.height).toBe("");
  });

  test("measures the dock without a ResizeObserver", () => {
    // Older webviews have no ResizeObserver; the window resize listener alone
    // still has to keep the pinned clearance correct.
    const stub = globalThis.ResizeObserver;
    // @ts-expect-error - deliberately removing the global for this test.
    delete globalThis.ResizeObserver;

    try {
      render(<NativeChatShell {...shellProps()} blockingCards={<div>Approve this command</div>} />);

      const dock = screen.getByTestId("compose-dock");
      const spacer = screen.getByTestId("transcript-bottom-spacer");
      dock.getBoundingClientRect = () => ({ height: 360 }) as DOMRect;

      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(spacer.style.height).toBe("360px");
    } finally {
      globalThis.ResizeObserver = stub;
    }
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
    expect(blockingCard.compareDocumentPosition(accessory) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test("renders transcript cards inside the transcript, not the pinned dock", () => {
    render(
      <NativeChatShell
        {...shellProps()}
        transcriptCards={<div>Which approach?</div>}
      />,
    );

    const card = screen.getByText("Which approach?");
    expect(screen.getByTestId("compose-dock").contains(card)).toBe(false);
    // Above the spacer, so the dock's reserved height still clears it.
    expect(
      card.compareDocumentPosition(screen.getByTestId("transcript-bottom-spacer"))
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  test("leaves the spacer alone for transcript cards, which take their own space", () => {
    // Unlike a pinned card, a transcript card is part of the scrolled content.
    // Widening the spacer for it would open a gap below the conversation.
    render(
      <NativeChatShell
        {...shellProps()}
        transcriptCards={<div>Which approach?</div>}
      />,
    );

    expect(screen.getByTestId("transcript-bottom-spacer").className)
      .toContain("h-32");
  });

  test("treats an empty transcriptCards array as no transcript card", () => {
    render(<NativeChatShell {...shellProps()} transcriptCards={[]} centerCompose />);

    expect(screen.queryByTestId("transcript-cards") === null).toBe(true);
    expect(screen.getByTestId("compose-dock").className).toContain("top-1/2");
  });

  test("un-centers the composer so a question before the first message is visible", () => {
    /**
     * The centered layout hides the transcript entirely. A question that
     * arrives with no messages yet would otherwise block the turn behind an
     * invisible card the user cannot answer.
     */
    render(
      <NativeChatShell
        {...shellProps()}
        centerCompose
        transcriptCards={<div>Which approach?</div>}
      />,
    );

    expect(screen.getByText("Which approach?")).toBeTruthy();
    expect(screen.getByTestId("compose-dock").className).not.toContain("top-1/2");
  });

  test("forwards shortcut ownership and canonical searchable message text", () => {
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
      content: "provider aggregate",
      createdAt: "2025-01-01T00:00:00.000Z",
      parts: [
        { type: "text" as const, content: "A **visible** answer" },
        { type: "thinking" as const, content: "hidden thought" },
      ],
    };
    const previousMessage = {
      id: "user-1",
      role: "user" as const,
      content: "Earlier prompt",
      createdAt: "2025-01-01T00:00:00.000Z",
      parts: [{ type: "text" as const, content: "Earlier prompt" }],
    };
    const messageActions = mock(() => <button type="button">Fork</button>);

    const view = render(
      <NativeChatShell
        {...shellProps()}
        isActive={false}
        agentLabel="Claude"
        containerId="container-1"
        messages={[previousMessage, message]}
        messageActions={messageActions}
      />,
    );

    expect(lastVirtualizedMessageListProps?.find.isActive).toBe(false);
    expect(lastVirtualizedMessageListProps?.find.getSearchText(message)).toBe("A visible answer");
    expect(messageActions).toHaveBeenCalledWith(previousMessage);
    expect(messageActions).toHaveBeenCalledWith(message);
    expect(screen.getByText("Earlier prompt")).toBeTruthy();
    expect(
      Array.from(view.container.querySelectorAll("[data-agent-chat-search-content]")).map(
        (element) => element.textContent,
      ),
    ).toEqual(["Earlier prompt", "A visible answer"]);
    expect(screen.getAllByRole("button", { name: "Fork" })).toHaveLength(2);
  });

  describe("connection states", () => {
    test("shows a connecting screen instead of the transcript", () => {
      const { container } = render(
        <NativeChatShell
          {...shellProps()}
          agentLabel="Codex"
          platform="codex"
          connectionState="connecting"
        />,
      );

      const status = screen.getByRole("status");
      expect(status.textContent).toBe("Connecting to Codex...");
      expect(screen.queryByTestId("compose-dock") === null).toBe(true);
      expect(screen.queryByTestId("transcript-bottom-spacer") === null).toBe(true);
      const logo = container.querySelector("svg.agent-connecting-logo");
      expect(logo).toBeTruthy();
      expect(logo?.getAttribute("class")).toContain("h-16");
      expect(logo?.closest("[aria-hidden='true']")).toBeTruthy();
      expect(container.querySelector(".animate-spin") === null).toBe(true);
    });

    test("uses the selected platform logo while connecting", () => {
      const { container, rerender } = render(
        <NativeChatShell
          {...shellProps()}
          agentLabel="Grok Build"
          platform="grok"
          connectionState="connecting"
        />,
      );

      expect(container.querySelector("svg.agent-connecting-logo")?.getAttribute("viewBox")).toBe(
        "0 0 33 32",
      );

      rerender(
        <NativeChatShell
          {...shellProps()}
          agentLabel="Cursor Agent"
          platform="cursor"
          connectionState="connecting"
        />,
      );
      expect(container.querySelector("svg.agent-connecting-logo")?.getAttribute("viewBox")).toBe(
        "0 0 49 56",
      );
    });

    test("reports the failure reason and retries on demand", () => {
      const onRetry = mock(() => {});
      render(
        <NativeChatShell
          {...shellProps()}
          connectionState="error"
          errorMessage="spawn ENOENT"
          onRetry={onRetry}
        />,
      );

      expect(screen.getByText("Connection Failed")).toBeTruthy();
      expect(screen.getByText("spawn ENOENT")).toBeTruthy();
      expect(screen.queryByTestId("compose-dock") === null).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    test("falls back to a generic message when the error has no detail", () => {
      render(
        <NativeChatShell
          {...shellProps()}
          agentLabel="OpenCode"
          connectionState="error"
          errorMessage={null}
        />,
      );

      expect(screen.getByText("Unable to connect to OpenCode")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Log/ }) === null).toBe(true);
    });

    test("toggles the server log on and off", () => {
      render(
        <NativeChatShell
          {...shellProps()}
          connectionState="error"
          serverLog={"listening on 4242\nEADDRINUSE"}
        />,
      );

      expect(screen.queryByText(/EADDRINUSE/) === null).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Show Log" }));
      expect(screen.getByText(/EADDRINUSE/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Hide Log" }));
      expect(screen.queryByText(/EADDRINUSE/) === null).toBe(true);
    });

    test("says so rather than opening an empty log box", () => {
      // A whitespace-only log is truthy, so the toggle is offered; showing a
      // blank pane would read as a broken UI rather than an empty log.
      render(<NativeChatShell {...shellProps()} connectionState="error" serverLog={"   \n  "} />);

      fireEvent.click(screen.getByRole("button", { name: "Show Log" }));
      expect(screen.getByText("(empty log)")).toBeTruthy();
    });
  });

  describe("empty state", () => {
    test("uses the agent-specific default copy", () => {
      render(<NativeChatShell {...shellProps()} agentLabel="Claude" />);
      expect(screen.getByText("No messages yet. Start a conversation with Claude!")).toBeTruthy();
    });

    test("prefers an explicit empty-state message", () => {
      render(
        <NativeChatShell {...shellProps()} emptyStateMessage="Pick a session to get going." />,
      );

      expect(screen.getByText("Pick a session to get going.")).toBeTruthy();
      expect(screen.queryByText(/No messages yet/) === null).toBe(true);
    });

    test("suppresses the empty state while the composer is centered", () => {
      // The centered composer already is the empty state; a second one below it
      // would be duplicate copy.
      render(<NativeChatShell {...shellProps()} centerCompose />);
      expect(screen.queryByText(/No messages yet/) === null).toBe(true);
    });

    test("offers Resume Session from the empty transcript", () => {
      const onResumeClick = mock(() => {});
      render(<NativeChatShell {...shellProps()} onResumeClick={onResumeClick} />);

      // The dock's copy is aria-hidden while docked, so this is the empty
      // state's button.
      fireEvent.click(screen.getByRole("button", { name: /Resume Session/ }));
      expect(onResumeClick).toHaveBeenCalledTimes(1);
    });

    test("omits Resume Session when there is nothing to resume", () => {
      render(<NativeChatShell {...shellProps()} />);
      expect(screen.queryByText("Resume Session") === null).toBe(true);
    });
  });

  describe("dock actions", () => {
    test("exposes Resume Session only while the composer is centered", () => {
      const onResumeClick = mock(() => {});
      const { rerender } = render(
        <NativeChatShell {...shellProps()} centerCompose onResumeClick={onResumeClick} />,
      );

      const dockButton = screen
        .getByTestId("compose-dock")
        .querySelector("button") as HTMLButtonElement;
      expect(dockButton.getAttribute("aria-hidden")).toBe("false");
      expect(dockButton.getAttribute("tabindex")).toBe("0");

      fireEvent.click(dockButton);
      expect(onResumeClick).toHaveBeenCalledTimes(1);

      rerender(
        <NativeChatShell {...shellProps()} centerCompose={false} onResumeClick={onResumeClick} />,
      );

      // Collapsed out of the docked layout, so it must leave the tab order too.
      expect(dockButton.getAttribute("aria-hidden")).toBe("true");
      expect(dockButton.getAttribute("tabindex")).toBe("-1");
    });

    test("renders the resume dialog outside the dock so its portal is not clipped", () => {
      render(
        <NativeChatShell {...shellProps()} resumeDialog={<div data-testid="resume-dialog" />} />,
      );

      const dialog = screen.getByTestId("resume-dialog");
      expect(screen.getByTestId("compose-dock").contains(dialog)).toBe(false);
    });
  });

  describe("transcript footer", () => {
    test("shows the thinking indicator and the running elapsed time", () => {
      render(
        <NativeChatShell {...shellProps()} agentLabel="Codex" isLoading elapsedSeconds={95} />,
      );

      expect(screen.getByRole("status").textContent).toBe("Codex is thinking...");
      expect(screen.getByText("1m 35s")).toBeTruthy();
    });

    test("prefers an explicit status label over the thinking indicator", () => {
      render(
        <NativeChatShell
          {...shellProps()}
          isLoading
          statusLabel={<span>Stopping…</span>}
          elapsedSeconds={0}
        />,
      );

      expect(screen.getByText("Stopping…")).toBeTruthy();
      expect(screen.queryByRole("status") === null).toBe(true);
      // A zero elapsed reads as noise next to a status that just started.
      expect(screen.queryByText("0s") === null).toBe(true);
    });

    test("reports the completed duration once the turn ends", () => {
      const { rerender } = render(
        <NativeChatShell
          {...shellProps()}
          isLoading
          elapsedSeconds={12}
          finalElapsedSeconds={12}
        />,
      );

      expect(screen.queryByText(/Completed in/) === null).toBe(true);

      rerender(
        <NativeChatShell
          {...shellProps()}
          isLoading={false}
          elapsedSeconds={null}
          finalElapsedSeconds={12}
        />,
      );

      expect(screen.getByText("Completed in 12s")).toBeTruthy();
      expect(screen.queryByRole("status") === null).toBe(true);
    });
  });

  describe("scroll affordance", () => {
    test("offers a scroll-down shortcut only when scrolled away from the bottom", () => {
      const scrollToBottom = mock(() => {});
      const { rerender } = render(
        <NativeChatShell {...shellProps()} isAtBottom scrollToBottom={scrollToBottom} />,
      );

      expect(screen.queryByText("Scroll down") === null).toBe(true);

      rerender(
        <NativeChatShell {...shellProps()} isAtBottom={false} scrollToBottom={scrollToBottom} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom of conversation" }));
      expect(scrollToBottom).toHaveBeenCalledTimes(1);
    });
  });

  describe("previous-message resolution", () => {
    const makeMessage = (
      id: string,
      role: "user" | "assistant",
      content: string,
    ): NativeMessage => ({
      id,
      role,
      content,
      createdAt: "2026-03-21T10:00:00.000Z",
      parts: role === "assistant" && content ? [{ type: "text", content }] : [],
    });

    test("renders attribution once and keeps the duration across an empty placeholder", () => {
      const messages: NativeMessage[] = [
        {
          ...makeMessage("user-1", "user", "Question"),
          createdAt: "2026-03-21T10:00:00.000Z",
        },
        {
          ...makeMessage("assistant-empty", "assistant", ""),
          createdAt: "2026-03-21T10:00:20.000Z",
          modelId: "gpt-5.6-sol",
        },
        {
          ...makeMessage("assistant-content", "assistant", "Answer"),
          createdAt: "2026-03-21T10:00:45.000Z",
          modelId: "gpt-5.6-sol",
        },
      ];
      render(
        <NativeChatShell
          {...shellProps()}
          messages={messages}
          resolveModelLabel={() => "GPT 5.6 Sol"}
        />,
      );

      // Attribution lands once, on the content row, and the empty placeholder
      // has not swallowed the response duration.
      expect(screen.getAllByText("GPT 5.6 Sol")).toHaveLength(1);
      expect(screen.getByText(/responded in 45s/)).toBeTruthy();
    });

    test("forwards platform so Cursor agent rows hide reported tool counts", () => {
      const message: NativeMessage = {
        id: "assistant-cursor-task",
        role: "assistant",
        content: "",
        createdAt: "2026-03-21T10:00:00.000Z",
        parts: [
          {
            type: "task-group",
            content: "Task: Subagent task",
            task: {
              type: "tool-invocation",
              content: "Task: Subagent task",
              toolName: "task",
              toolTitle: "Task: Subagent task",
              toolState: "success",
              agentState: "finished",
              toolUseCount: 8,
              toolArgs: {
                description: "Summarize two docs",
                prompt: "Read the two docs.",
                subagent_type: "explore",
                durationMs: 1_240,
              },
            },
            childTools: [],
          },
        ],
      };

      const { rerender } = render(
        <NativeChatShell {...shellProps()} platform="cursor" messages={[message]} />,
      );
      expect(screen.getByText("Summarize two docs (explore)")).toBeTruthy();
      expect(screen.getByText("1.2s")).toBeTruthy();
      expect(screen.queryByText("8 tool uses") === null).toBe(true);

      rerender(<NativeChatShell {...shellProps()} platform="claude" messages={[message]} />);
      expect(screen.getByText("8 tool uses")).toBeTruthy();
    });

    test("passes the resolver through to the list", () => {
      render(<NativeChatShell {...shellProps()} messages={[]} />);

      expect(lastVirtualizedMessageListProps?.resolvePreviousMessage).toBe(
        findPreviousNativeMessage,
      );
    });
  });
});
