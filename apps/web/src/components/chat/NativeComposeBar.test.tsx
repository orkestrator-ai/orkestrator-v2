import { createRef } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NativeComposeBar, type NativeComposeAttachment } from "./NativeComposeBar";
import type { MentionableInputRef } from "./MentionableInput";

function renderComposeBar(
  onSend: () => void,
  attachments: NativeComposeAttachment[] = [],
  onRemoveAttachment: (id: string) => void = () => {},
) {
  const inputRef = createRef<MentionableInputRef>();
  const inputContainerRef = createRef<HTMLDivElement>();
  render(
    <NativeComposeBar
      attachments={attachments}
      onRemoveAttachment={onRemoveAttachment}
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

  test("image attachments show a thumbnail without a filename and open a preview", async () => {
    const onRemove = mock(() => {});
    renderComposeBar(
      () => {},
      [
        {
          id: "img-1",
          type: "image",
          name: "clipboard-2026-10-22.png",
          path: "/workspace/.orkestrator/clipboard/clipboard-2026-10-22.png",
          previewUrl: "data:image/png;base64,AAAA",
        },
      ],
      onRemove,
    );

    const tile = screen.getByTestId("compose-image-attachment");
    expect(tile.textContent).not.toContain("clipboard-2026-10-22.png");

    fireEvent.click(screen.getByRole("button", { name: "Preview clipboard-2026-10-22.png" }));
    expect(
      await screen.findByRole("dialog", { name: "Image preview: clipboard-2026-10-22.png" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove clipboard-2026-10-22.png" }));
    expect(onRemove).toHaveBeenCalledWith("img-1");
  });
});
