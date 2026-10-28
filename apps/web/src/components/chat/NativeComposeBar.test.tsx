import { createRef } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  NativeComposeBar,
  type NativeComposeAttachment,
  type NativeComposeQueueState,
} from "./NativeComposeBar";
import type { MentionableInputRef } from "./MentionableInput";

function renderComposeBar(
  onSend: () => void,
  attachments: NativeComposeAttachment[] = [],
  onRemoveAttachment: (id: string) => void = () => {},
  queue?: NativeComposeQueueState,
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
      queue={queue}
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

  test.each([
    { length: 0, items: [], header: null },
    { length: 1, items: ["Next task"], header: "1 queued" },
    { length: 3, items: ["Next task", "Second", "Third"], header: "3 queued" },
  ])("queue stack for $length items", ({ length, items, header }) => {
    const onOpen = mock(() => {});
    renderComposeBar(
      () => {},
      [],
      () => {},
      { length, items: items.map((text, index) => ({ id: `q${index}`, text })), onOpen },
    );
    if (!length) {
      expect(screen.queryByTestId("compose-queue-strip")).toBeNull();
      return;
    }
    const stack = within(screen.getByTestId("compose-queue-strip"));
    expect(stack.getByText(header!)).toBeTruthy();
    // Run order in the DOM; the list is laid out reversed so the next sits lowest.
    expect(stack.getAllByTestId("compose-queue-item").map((row) => row.textContent)).toEqual([
      ...items,
    ]);
    const open = stack.getByRole("button", { name: `View queued prompts (${length})` });
    expect(open.title).toBe("View queued prompts");
    expect(stack.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("blocked queue exposes the error in its accessible name and tooltip", () => {
    renderComposeBar(
      () => {},
      [],
      () => {},
      {
        length: 1,
        items: [{ id: "q", text: "Next task" }],
        onOpen: () => {},
        error: { message: "Model unavailable" },
      },
    );
    const open = screen.getByRole("button", {
      name: "1 queued prompts blocked: Model unavailable",
    });
    expect(open.title).toBe("Queued prompt was not sent: Model unavailable");
    expect(screen.getByTestId("compose-queue-strip").textContent).toContain(
      "Blocked: Model unavailable",
    );
  });

  test.each([
    ["onSteer", "Steer queued prompt 2 of 2: Second task"],
    ["onEdit", "Edit queued prompt 2 of 2"],
    ["onRemove", "Remove queued prompt 2 of 2"],
  ] as const)(
    "%s acts on its own prompt, preserves focus and blocks every action until completion",
    async (action, name) => {
      let complete!: () => void;
      const pending = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const calls: string[] = [];
      const item = (id: string, text: string) => ({
        id,
        text,
        onSteer: mock(() => (calls.push(`onSteer:${id}`), pending)),
        onEdit: mock(() => (calls.push(`onEdit:${id}`), pending)),
        onRemove: mock(() => (calls.push(`onRemove:${id}`), pending)),
      });
      const inputRef = renderComposeBar(
        () => {},
        [],
        () => {},
        {
          length: 2,
          items: [item("first", "Next task"), item("second", "Second task")],
          onOpen: () => {},
        },
      );
      act(() => inputRef.current!.focus());
      const input = screen.getByRole("textbox");
      const button = screen.getByRole("button", { name });
      expect(fireEvent.mouseDown(button)).toBe(false);
      fireEvent.click(button);
      expect(document.activeElement).toBe(input);
      const buttons = within(screen.getByTestId("compose-queue-strip"))
        .getAllByRole("button")
        .slice(1);
      for (const button of buttons) {
        expect(button.getAttribute("aria-disabled")).toBe("true");
        expect(button.getAttribute("aria-busy")).toBe("true");
        fireEvent.click(button);
      }
      expect(calls).toEqual([`${action}:second`]);
      await act(async () => {
        complete();
        await pending;
      });
      for (const button of buttons) {
        expect(button.getAttribute("aria-disabled")).toBeNull();
        expect(button.getAttribute("aria-busy")).toBe("false");
      }
    },
  );

  test("stop stays available while a prompt is being submitted", () => {
    // A prompt the provider has not accepted yet (Pi's startup) is in flight
    // with input locked; stopping it is the only way out until it is accepted.
    const onStop = mock(() => {});
    render(
      <NativeComposeBar
        attachments={[]}
        onRemoveAttachment={() => {}}
        inputRef={createRef<MentionableInputRef>()}
        inputContainerRef={createRef<HTMLDivElement>()}
        text=""
        mentions={[]}
        onTextAndMentionsChange={() => {}}
        onCursorPositionChange={() => {}}
        onKeyDown={() => {}}
        placeholder="Ask anything"
        primaryControls={null}
        onSend={() => {}}
        disabled
        isSending
        isLoading
        onStop={onStop}
      />,
    );

    const stop = screen.getByTitle("Stop current query") as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("image attachments show a thumbnail without a filename and open a preview", () => {
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
    const dialog = screen.getByRole("dialog", { name: "Image preview: clipboard-2026-10-22.png" });
    expect(within(dialog).queryByRole("status") === null).toBe(true);
    expect(
      within(dialog).getByRole("img", { name: "clipboard-2026-10-22.png" }).getAttribute("src"),
    ).toBe("data:image/png;base64,AAAA");

    fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    expect(screen.queryByRole("dialog") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Remove clipboard-2026-10-22.png" }));
    expect(onRemove).toHaveBeenCalledWith("img-1");
  });

  test.each(["Escape", "close button"])(
    "closing with %s returns focus to the thumbnail",
    async (close) => {
      renderComposeBar(() => {}, [
        {
          id: "image",
          type: "image",
          name: "image.png",
          path: "/image.png",
          previewUrl: "data:image/png;base64,AAAA",
        },
      ]);
      const opener = screen.getByRole("button", { name: "Preview image.png" });
      act(() => opener.focus());
      fireEvent.click(opener);
      const dialog = screen.getByRole("dialog");
      expect(dialog.contains(document.activeElement)).toBe(true);
      if (close === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
      else fireEvent.click(within(dialog).getByRole("button", { name: "Close image preview" }));
      await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
      await waitFor(() => expect(document.activeElement).toBe(opener));
    },
  );

  test("mixed attachments keep filename chips and only previewable images enter the gallery", async () => {
    const onRemove = mock((_id: string) => {});
    renderComposeBar(
      () => {},
      [
        {
          id: "first",
          type: "image",
          name: "first.png",
          path: "/first.png",
          previewUrl: "data:image/png;base64,AAAA",
        },
        {
          id: "file",
          type: "file",
          name: "notes.txt",
          path: "/notes.txt",
          previewUrl: "data:text/plain,notes",
        },
        { id: "missing", type: "image", name: "missing.png", path: "/missing.png" },
        {
          id: "second",
          type: "image",
          name: "second.png",
          path: "/second.png",
          previewUrl: "data:image/png;base64,BBBB",
        },
      ],
      onRemove,
    );
    expect(screen.getAllByTestId("compose-image-attachment")).toHaveLength(2);
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.getByText("missing.png")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview notes.txt" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Preview missing.png" }) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Preview second.png" }));
    const dialog = screen.getByRole("dialog", { name: "Image preview: second.png" });
    expect(within(dialog).getByText(/2 of 2/)).toBeTruthy();
    expect(within(dialog).queryByRole("status") === null).toBe(true);
    expect(within(dialog).getByRole("img", { name: "second.png" }).getAttribute("src")).toBe(
      "data:image/png;base64,BBBB",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous image" }));
    expect(
      (await within(dialog).findByRole("img", { name: "first.png" })).getAttribute("src"),
    ).toBe("data:image/png;base64,AAAA");
    expect(within(dialog).getByText(/1 of 2/)).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(within(dialog).getByRole("img", { name: "second.png" }).getAttribute("src")).toBe(
      "data:image/png;base64,BBBB",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
    expect(within(dialog).getByRole("img", { name: "first.png" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close image preview" }));

    fireEvent.click(screen.getByRole("button", { name: "Remove missing.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(onRemove.mock.calls).toEqual([["missing"], ["file"]]);
  });
});
