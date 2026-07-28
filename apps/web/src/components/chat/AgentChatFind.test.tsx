import { afterEach, describe, expect, mock, test } from "bun:test";
import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  AgentChatFindBar,
  findAgentChatMatches,
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
    expect(screen.queryByRole("search", { name: "Find in agent chat" })).toBeNull();
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
    expect(screen.queryByRole("search", { name: "Find in agent chat" })).toBeNull();
  });
});
