import { createRef } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NativeComposeBar } from "./NativeComposeBar";
import type { MentionableInputRef } from "./MentionableInput";

function renderComposeBar(onSend: () => void) {
  const inputRef = createRef<MentionableInputRef>();
  const inputContainerRef = createRef<HTMLDivElement>();
  render(
    <NativeComposeBar
      attachments={[]}
      onRemoveAttachment={() => {}}
      inputRef={inputRef}
      inputContainerRef={inputContainerRef}
      text="Ship it"
      mentions={[]}
      onTextAndMentionsChange={() => {}}
      onCursorPositionChange={() => {}}
      onKeyDown={() => {}}
      placeholder="Ask anything"
      primaryControls={null}
      onSend={onSend}
    />,
  );
  return inputRef;
}

describe("NativeComposeBar", () => {
  afterEach(() => cleanup());

  test("sending with the mouse leaves focus in the prompt input", () => {
    const onSend = mock(() => {});
    const inputRef = renderComposeBar(onSend);
    const input = screen.getByRole("textbox", { name: "Ask anything" });
    act(() => inputRef.current!.focus());

    const sendButton = screen.getByRole("button", { name: "Send message" });
    const mouseDownWasNotCancelled = fireEvent.mouseDown(sendButton);
    fireEvent.click(sendButton);

    expect(mouseDownWasNotCancelled).toBe(false);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
  });
});
