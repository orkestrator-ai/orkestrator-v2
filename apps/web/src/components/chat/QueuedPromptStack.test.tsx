import { createRef, useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NativeComposeBar } from "./NativeComposeBar";
import type { MentionableInputRef } from "./MentionableInput";
import type { NativeComposeQueuedPrompt } from "./QueuedPromptStack";

interface HarnessOptions {
  text?: string;
  prompts?: readonly string[];
  steerable?: (id: string) => boolean;
  keyboardMenuOpen?: boolean;
  comboboxExpanded?: boolean;
  /** Steering resolves without the prompt leaving the queue (a refused steer). */
  refuseSteer?: boolean;
}

function renderHarness({
  text = "Draft in progress",
  prompts = ["First queued", "Second queued", "Third queued"],
  steerable = () => true,
  keyboardMenuOpen = false,
  comboboxExpanded = false,
  refuseSteer = false,
}: HarnessOptions = {}) {
  const inputRef = createRef<MentionableInputRef>();
  const steered: string[] = [];
  const onKeyDown = mock(() => {});
  const onTextAndMentionsChange = mock(() => {});
  let replaceQueue!: (items: { id: string; text: string }[]) => void;
  let withdrawSteering!: () => void;

  function Harness() {
    const [draft, setDraft] = useState(text);
    const [canSteer, setCanSteer] = useState(true);
    const [queued, setQueued] = useState(() =>
      prompts.map((prompt, index) => ({ id: `q${index + 1}`, text: prompt })),
    );
    useLayoutEffect(() => {
      replaceQueue = setQueued;
      withdrawSteering = () => setCanSteer(false);
    }, []);
    const items: NativeComposeQueuedPrompt[] = queued.map((item) => ({
      ...item,
      onSteer:
        canSteer && steerable(item.id)
          ? async () => {
              steered.push(item.id);
              await Promise.resolve();
              if (!refuseSteer) setQueued((current) => current.filter((q) => q.id !== item.id));
            }
          : undefined,
      onRemove: () => setQueued((current) => current.filter((q) => q.id !== item.id)),
      onEdit: async () => {
        await Promise.resolve();
        setDraft(item.text);
        setQueued((current) => current.filter((q) => q.id !== item.id));
      },
    }));
    return (
      <NativeComposeBar
        attachments={[]}
        onRemoveAttachment={() => {}}
        inputRef={inputRef}
        inputContainerRef={createRef<HTMLDivElement>()}
        text={draft}
        mentions={[]}
        onTextAndMentionsChange={onTextAndMentionsChange}
        onCursorPositionChange={() => {}}
        onKeyDown={onKeyDown}
        inputComboboxAria={comboboxExpanded ? { expanded: true } : undefined}
        keyboardMenuOpen={keyboardMenuOpen}
        placeholder="Ask anything"
        primaryControls={null}
        isLoading
        onSend={() => {}}
        queue={{ length: queued.length, items, onOpen: () => {} }}
      />
    );
  }

  render(<Harness />);
  const input = screen.getByRole("textbox", { name: "Ask anything" });
  const steerButton = (position: number, total: number) =>
    screen.getByRole("button", {
      name: new RegExp(`^Steer queued prompt ${position} of ${total}:`),
    });
  const placeCaret = (offset: number) => act(() => inputRef.current!.focusAtOffset(offset));
  const press = (key: string, target: Element = document.activeElement ?? document.body) =>
    fireEvent.keyDown(target, { key });
  return {
    input,
    inputRef,
    steered,
    onKeyDown,
    onTextAndMentionsChange,
    steerButton,
    placeCaret,
    press,
    replaceQueue: (items: { id: string; text: string }[]) => act(() => replaceQueue(items)),
    withdrawSteering: () => act(() => withdrawSteering()),
  };
}

describe("queued prompt stack", () => {
  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
  });

  test("renders every queued prompt with its own labelled Steer, edit and remove", () => {
    renderHarness();
    const rows = screen.getAllByTestId("compose-queue-item");
    expect(rows.map((row) => row.dataset.queuedPromptId)).toEqual(["q1", "q2", "q3"]);
    expect(
      screen
        .getAllByRole("button", { name: /^Steer queued prompt/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Steer queued prompt 1 of 3: First queued",
      "Steer queued prompt 2 of 3: Second queued",
      "Steer queued prompt 3 of 3: Third queued",
    ]);
    expect(screen.getAllByRole("button", { name: /^Remove queued prompt/ })).toHaveLength(3);
    // One roving tab stop: the strip nearest the input.
    expect(
      screen
        .getAllByRole("button", { name: /^Steer queued prompt/ })
        .map((button) => button.tabIndex),
    ).toEqual([0, -1, -1]);
  });

  test("ArrowUp from the first line focuses the Steer nearest the input", () => {
    const { input, steerButton, placeCaret, press, onKeyDown } = renderHarness();
    placeCaret(5);
    const event = press("ArrowUp", input);
    expect(event).toBe(false);
    expect(document.activeElement).toBe(steerButton(1, 3));
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(steerButton(1, 3).getAttribute("aria-describedby")).toBeTruthy();
  });

  test("ArrowUp below the first line moves the caret instead", () => {
    const { input, placeCaret, press, onKeyDown } = renderHarness({
      text: "First line\nSecond line\nThird line",
    });
    placeCaret(15);
    expect(press("ArrowUp", input)).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    placeCaret(4);
    press("ArrowUp", input);
    expect(document.activeElement).not.toBe(input);
  });

  test.each([
    ["a menu owns the keyboard", { keyboardMenuOpen: true }],
    ["the completion popup is open", { comboboxExpanded: true }],
    ["no queued prompt has actions", { prompts: [] }],
  ] as const)("ArrowUp stays in the input when %s", (_, options) => {
    const { input, placeCaret, press, onKeyDown } = renderHarness(options);
    placeCaret(0);
    expect(press("ArrowUp", input)).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  test("modified ArrowUp is left to the input", () => {
    const { input, placeCaret } = renderHarness();
    placeCaret(0);
    fireEvent.keyDown(input, { key: "ArrowUp", shiftKey: true });
    expect(document.activeElement).toBe(input);
  });

  test("Up, Up, Down, Down walks the strips and returns to the input with the caret restored", () => {
    const { input, inputRef, steerButton, placeCaret, press, onTextAndMentionsChange } =
      renderHarness();
    placeCaret(5);
    press("ArrowUp", input);
    expect(document.activeElement).toBe(steerButton(1, 3));
    press("ArrowUp");
    expect(document.activeElement).toBe(steerButton(2, 3));
    expect(steerButton(2, 3).tabIndex).toBe(0);
    expect(steerButton(1, 3).tabIndex).toBe(-1);
    press("ArrowUp");
    press("ArrowUp"); // Stops at the top.
    expect(document.activeElement).toBe(steerButton(3, 3));
    press("ArrowDown");
    press("ArrowDown");
    expect(document.activeElement).toBe(steerButton(1, 3));
    press("ArrowDown");
    expect(document.activeElement).toBe(input);
    expect(inputRef.current!.getCursorPosition()).toBe(5);
    expect(input.textContent).toBe("Draft in progress");
    expect(onTextAndMentionsChange).not.toHaveBeenCalled();
  });

  test("navigation reaches Edit and Remove on non-steerable rows", async () => {
    const { input, steerButton, placeCaret, press } = renderHarness({
      steerable: (id) => id !== "q2",
    });
    placeCaret(0);
    press("ArrowUp", input);
    press("ArrowUp");
    const remove = screen.getByRole("button", { name: "Remove queued prompt 2 of 3" });
    const edit = screen.getByRole("button", { name: "Edit queued prompt 2 of 3" });
    expect(document.activeElement).toBe(edit);
    expect(remove.tabIndex).toBe(0);
    press("ArrowUp");
    expect(document.activeElement).toBe(steerButton(3, 3));
    expect(screen.queryByRole("button", { name: /^Steer queued prompt 2 of 3/ }) === null).toBe(
      true,
    );
    press("ArrowDown");
    expect(document.activeElement).toBe(edit);
    act(() => remove.focus()); // Tab's native focus movement is covered in the browser.
    expect(press("Enter")).toBe(true);
    await act(async () => fireEvent.click(remove));
    expect(document.activeElement).toBe(steerButton(2, 2));
  });

  test("a non-steerable head is reachable before a steerable later row", () => {
    const { input, steerButton, placeCaret, press } = renderHarness({
      steerable: (id) => id !== "q1",
    });
    placeCaret(4);
    press("ArrowUp", input);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit queued prompt 1 of 3" }),
    );
    press("ArrowUp");
    expect(document.activeElement).toBe(steerButton(2, 3));
  });

  test("keyboard Edit on a non-steerable head returns to the loaded draft's end", async () => {
    const { input, inputRef, placeCaret, press } = renderHarness({
      text: "",
      steerable: (id) => id !== "q1",
    });
    placeCaret(0);
    press("ArrowUp", input);
    const edit = screen.getByRole("button", { name: "Edit queued prompt 1 of 3" });
    expect(document.activeElement).toBe(edit);
    expect(press("Enter")).toBe(true);
    await act(async () => fireEvent.click(edit));
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.textContent).toBe("First queued");
    expect(inputRef.current!.getCursorPosition()).toBe("First queued".length);
  });

  test("external removal of the focused row focuses the next row", () => {
    const { input, steerButton, placeCaret, press, replaceQueue } = renderHarness();
    placeCaret(4);
    press("ArrowUp", input);
    replaceQueue([{ id: "q2", text: "Second queued" }]);
    expect(document.activeElement).toBe(steerButton(1, 1));
  });

  test("withdrawing steering focuses a surviving action on the same row", () => {
    const { input, placeCaret, press, withdrawSteering } = renderHarness();
    placeCaret(4);
    press("ArrowUp", input);
    withdrawSteering();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit queued prompt 1 of 3" }),
    );
    press("ArrowDown");
    expect(document.activeElement).toBe(input);
  });

  test("externally emptying the queue restores the saved composer offset", () => {
    const { input, inputRef, placeCaret, press, replaceQueue } = renderHarness();
    placeCaret(4);
    press("ArrowUp", input);
    replaceQueue([]);
    expect(document.activeElement).toBe(input);
    expect(inputRef.current!.getCursorPosition()).toBe(4);
  });

  test.each([false, true])(
    "external updates preserve focus after leaving the stack (blur: %s)",
    (blur) => {
      const { input, placeCaret, press, replaceQueue } = renderHarness();
      placeCaret(4);
      press("ArrowUp", input);
      const outside = document.createElement("button");
      document.body.append(outside);
      try {
        outside.focus();
        if (blur) outside.blur();
        const active = document.activeElement;
        replaceQueue([]);
        expect(document.activeElement).toBe(active);
      } finally {
        outside.remove();
      }
    },
  );

  test("Escape returns to the input and is not taken as a stop", () => {
    const { input, inputRef, steerButton, placeCaret, press } = renderHarness();
    const stop = mock((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener("keydown", stop);
    try {
      placeCaret(3);
      press("ArrowUp", input);
      press("ArrowUp");
      expect(document.activeElement).toBe(steerButton(2, 3));
      press("Escape");
      expect(document.activeElement).toBe(input);
      expect(inputRef.current!.getCursorPosition()).toBe(3);
      expect(stop.mock.results.at(-1)?.value).toBe(true);
    } finally {
      window.removeEventListener("keydown", stop);
    }
  });

  test("Enter on a focused Steer steers that prompt and focus moves to the next strip", async () => {
    const { input, steerButton, placeCaret, press, steered, onTextAndMentionsChange } =
      renderHarness();
    placeCaret(0);
    press("ArrowUp", input);
    press("ArrowUp");
    const second = steerButton(2, 3);
    // Enter's activation is the browser's; the stack must not swallow it.
    expect(press("Enter")).toBe(true);
    await act(async () => {
      fireEvent.click(second);
    });
    expect(steered).toEqual(["q2"]);
    // The prompt that ran after it takes its slot and the focus.
    await waitFor(() => expect(document.activeElement).toBe(steerButton(2, 2)));
    expect(steerButton(2, 2).getAttribute("aria-label")).toBe(
      "Steer queued prompt 2 of 2: Third queued",
    );
    expect(input.textContent).toBe("Draft in progress");
    expect(onTextAndMentionsChange).not.toHaveBeenCalled();
  });

  test("steering the last strip moves focus to the one below it", async () => {
    const { input, steerButton, placeCaret, press, steered } = renderHarness({
      prompts: ["First queued", "Second queued"],
    });
    placeCaret(0);
    press("ArrowUp", input);
    press("ArrowUp");
    await act(async () => {
      fireEvent.click(steerButton(2, 2));
    });
    expect(steered).toEqual(["q2"]);
    await waitFor(() => expect(document.activeElement).toBe(steerButton(1, 1)));
  });

  test("steering the only strip returns focus to the input with the caret restored", async () => {
    const { input, inputRef, steerButton, placeCaret, press } = renderHarness({
      prompts: ["Only queued"],
    });
    placeCaret(6);
    press("ArrowUp", input);
    await act(async () => {
      fireEvent.click(steerButton(1, 1));
    });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(inputRef.current!.getCursorPosition()).toBe(6);
    expect(screen.queryByTestId("compose-queue-strip") === null).toBe(true);
    expect(input.textContent).toBe("Draft in progress");
  });

  test("a refused steer keeps focus on its strip", async () => {
    const { input, steerButton, placeCaret, press, steered } = renderHarness({ refuseSteer: true });
    placeCaret(0);
    press("ArrowUp", input);
    await act(async () => {
      fireEvent.click(steerButton(1, 3));
    });
    expect(steered).toEqual(["q1"]);
    expect(document.activeElement).toBe(steerButton(1, 3));
  });

  test("a mouse steer leaves focus in the input", async () => {
    const { input, steerButton, placeCaret, steered } = renderHarness();
    placeCaret(2);
    const button = steerButton(3, 3);
    expect(fireEvent.mouseDown(button)).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(steered).toEqual(["q3"]);
    expect(document.activeElement).toBe(input);
  });
});
