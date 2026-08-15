import { afterEach, describe, expect, mock, test } from "bun:test";
import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  AgentChatFindBar,
  findAgentChatMatches,
  findAgentChatTextMatches,
  useAgentChatFind,
  type AgentChatFindMatch,
} from "./AgentChatFind";

afterEach(() => cleanup());

function FindHarness({
  active = true,
  onNavigate = () => {},
}: {
  active?: boolean;
  onNavigate?: (match: AgentChatFindMatch) => void;
}) {
  const ownerRef = useRef<HTMLDivElement>(null);
  const find = useAgentChatFind({
    items: [
      { text: "First needle, second NEEDLE." },
      { text: "A message without it." },
      { text: "The final needle." },
    ],
    getSearchText: (item) => item.text,
    isActive: active,
    ownerRef,
    onNavigate,
  });

  return (
    <div ref={ownerRef}>
      <button type="button">Before search</button>
      <AgentChatFindBar
        inputRef={find.inputRef}
        query={find.query}
        isOpen={find.isOpen}
        currentMatchIndex={find.currentMatchIndex}
        matchCount={find.matches.length}
        onQueryChange={find.onQueryChange}
        onInputKeyDown={find.onInputKeyDown}
        onPrevious={find.onPrevious}
        onNext={find.onNext}
        onClose={find.onClose}
        matchHighlightName="test-match"
        currentHighlightName="test-current"
      />
    </div>
  );
}

describe("findAgentChatMatches", () => {
  test("finds case-insensitive non-overlapping matches in transcript order", () => {
    expect(findAgentChatMatches(["Needle needle", "needless", "none"], "NEEDLE")).toEqual([
      { itemIndex: 0, characterIndex: 0, occurrenceIndex: 0 },
      { itemIndex: 0, characterIndex: 7, occurrenceIndex: 1 },
      { itemIndex: 1, characterIndex: 0, occurrenceIndex: 0 },
    ]);
  });

  test("does not search an empty or whitespace-only query", () => {
    expect(findAgentChatMatches(["anything"], "")).toEqual([]);
    expect(findAgentChatMatches(["anything"], "   ")).toEqual([]);
  });

  test("returns original UTF-16 offsets for Unicode and literal punctuation", () => {
    expect(findAgentChatTextMatches("İx [x]", "x")).toEqual([
      { characterIndex: 1, length: 1 },
      { characterIndex: 4, length: 1 },
    ]);
    expect(findAgentChatTextMatches("a+b A+B", "a+b")).toEqual([
      { characterIndex: 0, length: 3 },
      { characterIndex: 4, length: 3 },
    ]);
    expect(findAgentChatMatches(["İx"], "x")).toEqual([
      { itemIndex: 0, characterIndex: 1, occurrenceIndex: 0 },
    ]);
  });
});

describe("agent chat find controls", () => {
  test("opens with Cmd+F, counts the full transcript, and navigates matches", () => {
    const onNavigate = mock(() => {});
    render(<FindHarness onNavigate={onNavigate} />);

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    const input = screen.getByRole("textbox", { name: "Find in chat" });
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "needle" } });
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(onNavigate).toHaveBeenLastCalledWith({
      itemIndex: 0,
      characterIndex: 6,
      occurrenceIndex: 0,
    });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(onNavigate).toHaveBeenLastCalledWith({
      itemIndex: 0,
      characterIndex: 21,
      occurrenceIndex: 1,
    });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("1 of 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(onNavigate).toHaveBeenLastCalledWith({
      itemIndex: 2,
      characterIndex: 10,
      occurrenceIndex: 0,
    });
  });

  test("reports no results and closes with Escape", () => {
    render(<FindHarness />);
    const previousFocus = screen.getByRole("button", { name: "Before search" });
    previousFocus.focus();

    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    const input = screen.getByRole("textbox", { name: "Find in chat" });
    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByText("No results")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("search", { name: "Find in agent chat" }) === null).toBe(true);
    expect(document.activeElement).toBe(previousFocus);
  });

  test("does not capture the browser shortcut for an inactive tab", () => {
    render(<FindHarness active={false} />);
    const event = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("search", { name: "Find in agent chat" }) === null).toBe(true);
  });

  test("reuses an open search by focusing and selecting its query", () => {
    render(<FindHarness />);
    fireEvent.keyDown(document, { key: "f", metaKey: true });
    const input = screen.getByRole("textbox", { name: "Find in chat" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "needle" } });
    screen.getByRole("button", { name: "Before search" }).focus();

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("needle".length);
  });

  test("stops owning shortcuts after becoming inactive and ignores modified find", () => {
    const view = render(<FindHarness />);
    fireEvent.keyDown(document, { key: "f", metaKey: true });
    expect(screen.getByRole("search", { name: "Find in agent chat" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Find in chat" }), {
      target: { value: "needle" },
    });

    view.rerender(<FindHarness active={false} />);
    expect(screen.getByText("No results")).toBeTruthy();
    const inactiveEvent = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(inactiveEvent);
    expect(inactiveEvent.defaultPrevented).toBe(false);

    view.rerender(<FindHarness />);
    fireEvent.keyDown(document, { key: "f", metaKey: true, altKey: true });
    fireEvent.keyDown(document, { key: "f", ctrlKey: true, shiftKey: true });
    expect(screen.getAllByRole("search", { name: "Find in agent chat" })).toHaveLength(1);
  });

  test("listens on the owner document instead of the ambient document", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const ownerDocument = iframe.contentDocument!;
    const container = ownerDocument.createElement("div");
    ownerDocument.body.append(container);
    render(<FindHarness />, { container });

    const ambientEvent = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ambientEvent);
    expect(ambientEvent.defaultPrevented).toBe(false);
    expect(container.getElementsByTagName("input")).toHaveLength(0);

    fireEvent.keyDown(container, {
      key: "f",
      metaKey: true,
    });
    expect(container.getElementsByTagName("input")).toHaveLength(1);
  });
});
