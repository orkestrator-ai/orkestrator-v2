import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { NativeMessage } from "./NativeMessage";
import { MessageForkAction, useMessageForkAction } from "./MessageForkAction";
import type { MessageForkKind } from "./message-fork";

afterEach(cleanup);

/**
 * Renders the hook and hands the produced elements back to the test, plus a
 * button that forces a parent re-render exactly like a streaming tick does.
 */
function Harness({
  messageIds,
  disabled,
  onFork,
  collect,
  kind = "prompt",
}: {
  messageIds: string[];
  disabled: boolean;
  onFork: (messageId: string, kind: MessageForkKind) => void;
  collect: (elements: ReactNode[]) => void;
  kind?: MessageForkKind;
}) {
  const [tick, setTick] = useState(0);
  const forkAction = useMessageForkAction({
    agentLabel: "Codex",
    disabled,
    onFork,
  });
  collect(messageIds.map((id) => forkAction(id, kind)));
  return (
    <div>
      <button type="button" onClick={() => setTick((value) => value + 1)}>
        Re-render
      </button>
      <span data-testid="tick">{tick}</span>
      {messageIds.map((id) => (
        <span key={id}>{forkAction(id, kind)}</span>
      ))}
    </div>
  );
}

describe("useMessageForkAction", () => {
  test("returns the identical element for a message id across parent re-renders", () => {
    /*
     * `renderMessage` runs on every parent render — once per streaming tick.
     * Building the action inline produced a fresh element object each time, so
     * the shallow compare behind `memo(NativeMessage)` failed for every visible
     * user message and the whole transcript re-rendered mid-answer.
     */
    const renders: ReactNode[][] = [];
    render(
      <Harness
        messageIds={["user-1", "user-2"]}
        disabled={false}
        onFork={() => {}}
        collect={(elements) => renders.push(elements)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-render" }));
    fireEvent.click(screen.getByRole("button", { name: "Re-render" }));

    expect(screen.getByTestId("tick").textContent).toBe("2");
    expect(renders.length).toBeGreaterThanOrEqual(3);
    const first = renders[0]!;
    for (const pass of renders.slice(1)) {
      expect(pass[0]).toBe(first[0]);
      expect(pass[1]).toBe(first[1]);
    }
    // Different messages still get their own action.
    expect(first[0]).not.toBe(first[1]);
  });

  test("never serves a cached element carrying a stale disabled state", () => {
    // The latch that blocks a double fork is exactly this prop; a stale cache
    // entry would keep the button clickable while a fork was in flight.
    const renders: ReactNode[][] = [];
    const view = render(
      <Harness
        messageIds={["user-1"]}
        disabled={false}
        onFork={() => {}}
        collect={(elements) => renders.push(elements)}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Fork Codex session from this prompt" })
        .hasAttribute("disabled"),
    ).toBe(false);

    view.rerender(
      <Harness
        messageIds={["user-1"]}
        disabled
        onFork={() => {}}
        collect={(elements) => renders.push(elements)}
      />,
    );

    expect(renders.at(-1)![0]).not.toBe(renders[0]![0]);
    expect(
      screen.getByRole("button", { name: "Fork Codex session from this prompt" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  test("forks the message the button belongs to", () => {
    const onFork = mock((_messageId: string, _kind: MessageForkKind) => {});
    render(
      <Harness
        messageIds={["user-1", "user-2"]}
        disabled={false}
        onFork={onFork}
        collect={() => {}}
      />,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Fork Codex session from this prompt" })[1]!,
    );

    expect(onFork.mock.calls).toEqual([["user-2", "prompt"]]);
  });

  test("names and describes a response action by its kind", () => {
    const onFork = mock((_messageId: string, _kind: MessageForkKind) => {});
    render(
      <Harness
        messageIds={["assistant-1"]}
        disabled={false}
        onFork={onFork}
        collect={() => {}}
        kind="response"
      />,
    );

    const button = screen.getByRole("button", {
      name: "Fork Codex session from this response",
    });
    expect(button.getAttribute("title")).toBe("Fork after response");

    fireEvent.click(button);
    expect(onFork.mock.calls).toEqual([["assistant-1", "response"]]);
  });

  test("describes a prompt action as an edit", () => {
    render(
      <Harness
        messageIds={["user-1"]}
        disabled={false}
        onFork={() => {}}
        collect={() => {}}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Fork Codex session from this prompt" })
        .getAttribute("title"),
    ).toBe("Fork and edit prompt");
  });

  test("keys the cache by kind as well as message id", () => {
    // A Claude prompt and the response to it can share a source message id once
    // split rows are resolved; a message-id-only cache would serve the wrong
    // button for one of them.
    const seen: ReactNode[] = [];
    function BothKinds() {
      const forkAction = useMessageForkAction({
        agentLabel: "Codex",
        disabled: false,
        onFork: () => {},
      });
      seen.push(
        forkAction("shared-1", "prompt"),
        forkAction("shared-1", "response"),
        forkAction("shared-1", "prompt"),
      );
      return null;
    }
    render(<BothKinds />);

    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).toBe(seen[2]);
  });

  test("drops the cache when the fork handler identity changes", () => {
    /*
     * The cached element closes over `onFork`. A tab whose handler depends on
     * the transcript hands over a new function on every streaming tick — the
     * cache must follow it, or a click would run a handler built against a
     * transcript that has since moved on.
     */
    const renders: ReactNode[][] = [];
    const view = render(
      <Harness
        messageIds={["user-1"]}
        disabled={false}
        onFork={() => {}}
        collect={(elements) => renders.push(elements)}
      />,
    );
    const beforeSwap = renders.at(-1)![0];

    view.rerender(
      <Harness
        messageIds={["user-1"]}
        disabled={false}
        onFork={() => {}}
        collect={(elements) => renders.push(elements)}
      />,
    );

    expect(renders.at(-1)![0]).not.toBe(beforeSwap);
  });
});

describe("MessageForkAction inside NativeMessage", () => {
  test("renders in the message action slot and forks on click", () => {
    const onFork = mock((_messageId: string, _kind: MessageForkKind) => {});
    render(
      <NativeMessage
        message={{
          id: "user-1",
          role: "user",
          content: "Add pagination",
          createdAt: "2026-07-26T10:00:00.000Z",
          parts: [{ type: "text", content: "Add pagination" }],
        }}
        assistantLabel="Codex"
        actions={
          <MessageForkAction
            messageId="user-1"
            kind="prompt"
            label="Fork Codex session from this prompt"
            disabled={false}
            onFork={onFork}
          />
        }
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Fork Codex session from this prompt" }),
    );
    expect(onFork.mock.calls).toEqual([["user-1", "prompt"]]);
  });
});
