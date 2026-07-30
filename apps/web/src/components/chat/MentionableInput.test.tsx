import { createRef, useState } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MentionableInput, type MentionableInputRef } from "./MentionableInput";
import type { FileMention } from "@/types";

describe("MentionableInput", () => {
  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
  });

  test("restores draft text into the DOM on first render", () => {
    const draftText = "Hello, this is my draft";
    const { container } = render(
      <MentionableInput
        value={draftText}
        mentions={[]}
        onChange={() => {}}
      />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();
    expect(input!.textContent).toBe(draftText);
  });

  test("renders empty when value is empty string", () => {
    const { container } = render(
      <MentionableInput
        value=""
        mentions={[]}
        onChange={() => {}}
      />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();
    expect(input!.textContent).toBe("");
  });

  test("marks the editable viewport for the iOS focus-zoom workaround", () => {
    const { container } = render(
      <MentionableInput
        value=""
        mentions={[]}
        onChange={() => {}}
      />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input?.classList.contains("native-compose-input")).toBe(true);
    expect(
      input?.parentElement?.classList.contains("native-compose-input-viewport"),
    ).toBe(true);
  });

  test("restores draft text with mentions on first render", () => {
    const draftText = "Check @utils.ts for details";
    const mentions = [
      { id: "1", filename: "utils.ts", relativePath: "src/utils.ts" },
    ];
    const { container } = render(
      <MentionableInput
        value={draftText}
        mentions={mentions}
        onChange={() => {}}
      />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();
    expect(input!.textContent).toBe(draftText);

    const mentionSpan = input!.querySelector("[data-mention='true']");
    expect(mentionSpan).not.toBeNull();
    expect(mentionSpan!.textContent).toBe("@utils.ts");
  });

  test("reports the current editable text with cursor changes after input", () => {
    let cursorText = "";
    const { container } = render(
      <MentionableInput
        value=""
        mentions={[]}
        onChange={() => {}}
        onCursorChange={(_, text) => {
          cursorText = text;
        }}
      />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();

    input!.textContent = "@utils";
    fireEvent.input(input!);

    expect(cursorText).toBe("@utils");
  });

  test("exposes focus, blur, and cursor position through the ref", () => {
    const inputRef = createRef<MentionableInputRef>();
    const { container } = render(
      <MentionableInput
        ref={inputRef}
        value="Hello"
        mentions={[]}
        onChange={() => {}}
      />,
    );

    const input = container.querySelector("[contenteditable]") as HTMLElement;
    const focus = mock(() => {});
    const blur = mock(() => {});
    input.focus = focus as unknown as typeof input.focus;
    input.blur = blur as unknown as typeof input.blur;

    inputRef.current!.focus();
    inputRef.current!.blur();

    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "He".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(blur).toHaveBeenCalledTimes(1);
    expect(inputRef.current!.getCursorPosition()).toBe(2);
  });

  test("prevents regular Enter while forwarding keydown events", () => {
    const onKeyDown = mock(() => {});
    const { container } = render(
      <MentionableInput
        value=""
        mentions={[]}
        onChange={() => {}}
        onKeyDown={onKeyDown}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });

    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  test("allows Shift+Enter while forwarding keydown events", () => {
    const onKeyDown = mock(() => {});
    const { container } = render(
      <MentionableInput
        value=""
        mentions={[]}
        onChange={() => {}}
        onKeyDown={onKeyDown}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  test("renders as non-editable when disabled", () => {
    const { container } = render(
      <MentionableInput
        value="Locked"
        mentions={[]}
        onChange={() => {}}
        disabled
      />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();
    expect(input!.getAttribute("contenteditable")).toBe("false");
  });

  test("inserts a mention at the last known cursor position when focus moved outside", () => {
    const onChange = mock(() => {});
    const inputRef = createRef<MentionableInputRef>();

    render(
      <MentionableInput
        ref={inputRef}
        value="Review @ut"
        mentions={[]}
        onChange={onChange}
      />,
    );

    inputRef.current!.insertMention({
      id: "mention-1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    });

    expect(onChange).toHaveBeenCalledWith(
      "Review @utils.ts ",
      [{ id: "mention-1", filename: "utils.ts", relativePath: "src/utils.ts" }],
    );
  });

  test("refocuses and places the cursor after an inserted mention", () => {
    const inputRef = createRef<MentionableInputRef>();

    function Harness() {
      const [draftText, setDraftText] = useState("Review @ut");
      const [draftMentions, setDraftMentions] = useState<FileMention[]>([]);

      return (
        <>
          <button type="button" data-testid="outside-focus-target">
            Outside
          </button>
          <MentionableInput
            ref={inputRef}
            value={draftText}
            mentions={draftMentions}
            onChange={(newText, newMentions) => {
              setDraftText(newText);
              setDraftMentions(newMentions);
            }}
          />
        </>
      );
    }

    const { container, getByTestId } = render(<Harness />);
    const input = container.querySelector("[contenteditable]") as HTMLElement;
    const outsideFocusTarget = getByTestId("outside-focus-target");

    outsideFocusTarget.focus();
    expect(document.activeElement).toBe(outsideFocusTarget);

    act(() => {
      inputRef.current!.insertMention({
        id: "mention-1",
        filename: "utils.ts",
        relativePath: "src/utils.ts",
      });
    });

    expect(input.textContent).toBe("Review @utils.ts ");
    expect(document.activeElement).toBe(input);
    expect(inputRef.current!.getCursorPosition()).toBe("Review @utils.ts ".length);
  });

  test("places the cursor before reused whitespace after an inserted mention", () => {
    const inputRef = createRef<MentionableInputRef>();

    function Harness() {
      const [draftText, setDraftText] = useState("Review @ut please");
      const [draftMentions, setDraftMentions] = useState<FileMention[]>([]);

      return (
        <MentionableInput
          ref={inputRef}
          value={draftText}
          mentions={draftMentions}
          onChange={(newText, newMentions) => {
            setDraftText(newText);
            setDraftMentions(newMentions);
          }}
        />
      );
    }

    const { container } = render(<Harness />);
    const input = container.querySelector("[contenteditable]") as HTMLElement;

    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "Review @u".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    act(() => {
      inputRef.current!.insertMention({
        id: "mention-1",
        filename: "utils.ts",
        relativePath: "src/utils.ts",
      });
    });

    // The existing space after "@ut" is reused, so the caret must land directly
    // after "@utils.ts" and before that space, not one character into it.
    expect(input.textContent).toBe("Review @utils.ts please");
    expect(inputRef.current!.getCursorPosition()).toBe("Review @utils.ts".length);
  });

  test("does not insert a mention when no active token exists", () => {
    const onChange = mock(() => {});
    const inputRef = createRef<MentionableInputRef>();
    render(
      <MentionableInput
        ref={inputRef}
        value="Review utils"
        mentions={[]}
        onChange={onChange}
      />,
    );

    inputRef.current!.insertMention({
      id: "mention-1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  test("inserts a picker mention at the last known cursor without an active token", () => {
    const onChange = mock(() => {});
    const inputRef = createRef<MentionableInputRef>();
    render(
      <MentionableInput
        ref={inputRef}
        value="Review utils"
        mentions={[]}
        onChange={onChange}
      />,
    );

    inputRef.current!.insertMentionAtCursor({
      id: "mention-1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    });

    expect(onChange).toHaveBeenCalledWith(
      "Review utils @utils.ts ",
      [{ id: "mention-1", filename: "utils.ts", relativePath: "src/utils.ts" }],
    );
  });

  test.each([
    {
      name: "at the start before non-whitespace",
      value: "Review this",
      cursor: 0,
      expectedText: "@utils.ts Review this",
      expectedCursor: "@utils.ts ".length,
    },
    {
      name: "between non-whitespace and existing whitespace",
      value: "Review this",
      cursor: "Review".length,
      expectedText: "Review @utils.ts this",
      expectedCursor: "Review @utils.ts".length,
    },
    {
      name: "between existing whitespace and non-whitespace",
      value: "Review this",
      cursor: "Review ".length,
      expectedText: "Review @utils.ts this",
      expectedCursor: "Review @utils.ts ".length,
    },
    {
      name: "between whitespace on both sides",
      value: "Review  this",
      cursor: "Review ".length,
      expectedText: "Review @utils.ts this",
      expectedCursor: "Review @utils.ts".length,
    },
    {
      name: "between non-whitespace on both sides",
      value: "Reviewthis",
      cursor: "Review".length,
      expectedText: "Review @utils.ts this",
      expectedCursor: "Review @utils.ts ".length,
    },
    {
      name: "at the end after existing whitespace",
      value: "Review ",
      cursor: "Review ".length,
      expectedText: "Review @utils.ts ",
      expectedCursor: "Review @utils.ts ".length,
    },
    {
      name: "in an empty draft",
      value: "",
      cursor: 0,
      expectedText: "@utils.ts ",
      expectedCursor: "@utils.ts ".length,
    },
  ])(
    "inserts a picker mention $name",
    ({ value, cursor, expectedText, expectedCursor }) => {
      const inputRef = createRef<MentionableInputRef>();

      function Harness() {
        const [draftText, setDraftText] = useState<string>(value);
        const [draftMentions, setDraftMentions] = useState<FileMention[]>([]);

        return (
          <MentionableInput
            ref={inputRef}
            value={draftText}
            mentions={draftMentions}
            onChange={(newText, newMentions) => {
              setDraftText(newText);
              setDraftMentions(newMentions);
            }}
          />
        );
      }

      const { container } = render(<Harness />);
      const input = container.querySelector("[contenteditable]") as HTMLElement;
      const selection = window.getSelection()!;
      const range = document.createRange();
      if (input.firstChild) {
        range.setStart(input.firstChild, cursor);
      } else {
        range.setStart(input, 0);
      }
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);

      act(() => {
        inputRef.current!.insertMentionAtCursor({
          id: "mention-1",
          filename: "utils.ts",
          relativePath: "src/utils.ts",
        });
      });

      expect(input.textContent).toBe(expectedText);
      expect(inputRef.current!.getCursorPosition()).toBe(expectedCursor);
    },
  );

  test("restores focus and the remembered mid-text caret after picker insertion", () => {
    const inputRef = createRef<MentionableInputRef>();
    const onCursorChange = mock(() => {});

    function Harness() {
      const [draftText, setDraftText] = useState("Review this");
      const [draftMentions, setDraftMentions] = useState<FileMention[]>([]);

      return (
        <>
          <button type="button" data-testid="picker-focus-target">
            Picker
          </button>
          <MentionableInput
            ref={inputRef}
            value={draftText}
            mentions={draftMentions}
            onChange={(newText, newMentions) => {
              setDraftText(newText);
              setDraftMentions(newMentions);
            }}
            onCursorChange={onCursorChange}
          />
        </>
      );
    }

    const { container, getByTestId } = render(<Harness />);
    const input = container.querySelector("[contenteditable]") as HTMLElement;
    const focusTarget = getByTestId("picker-focus-target");
    const selection = window.getSelection()!;
    const inputRange = document.createRange();
    inputRange.setStart(input.firstChild!, "Review".length);
    inputRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(inputRange);
    document.dispatchEvent(new Event("selectionchange"));

    const outsideRange = document.createRange();
    outsideRange.selectNodeContents(focusTarget);
    outsideRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(outsideRange);
    focusTarget.focus();
    expect(document.activeElement).toBe(focusTarget);

    act(() => {
      inputRef.current!.insertMentionAtCursor({
        id: "mention-1",
        filename: "utils.ts",
        relativePath: "src/utils.ts",
      });
    });

    expect(input.textContent).toBe("Review @utils.ts this");
    expect(document.activeElement).toBe(input);
    expect(inputRef.current!.getCursorPosition()).toBe("Review @utils.ts".length);
  });

  test("does not treat the cursor before @ as an active mention token", () => {
    const onChange = mock(() => {});
    const inputRef = createRef<MentionableInputRef>();
    const { container } = render(
      <MentionableInput
        ref={inputRef}
        value="Review @ut"
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "Review ".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    inputRef.current!.insertMention({
      id: "mention-1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  test("replaces the full active mention token when the cursor is inside the query", () => {
    const onChange = mock(() => {});
    const inputRef = createRef<MentionableInputRef>();
    const { container } = render(
      <MentionableInput
        ref={inputRef}
        value="Review @ut"
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "Review @".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    inputRef.current!.insertMention({
      id: "mention-1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    });

    expect(onChange).toHaveBeenCalledWith(
      "Review @utils.ts ",
      [{ id: "mention-1", filename: "utils.ts", relativePath: "src/utils.ts" }],
    );
  });

  test("reuses existing whitespace after a replaced mention token", () => {
    const onChange = mock(() => {});
    const inputRef = createRef<MentionableInputRef>();
    const { container } = render(
      <MentionableInput
        ref={inputRef}
        value="Review @ut please"
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "Review @u".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    inputRef.current!.insertMention({
      id: "mention-1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    });

    expect(onChange).toHaveBeenCalledWith(
      "Review @utils.ts please",
      [{ id: "mention-1", filename: "utils.ts", relativePath: "src/utils.ts" }],
    );
  });

  test("replaces active mention tokens that contain filename punctuation", () => {
    const onChange = mock(() => {});
    const inputRef = createRef<MentionableInputRef>();
    const { container } = render(
      <MentionableInput
        ref={inputRef}
        value="Review @utils.t please"
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "Review @utils.".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    inputRef.current!.insertMention({
      id: "mention-1",
      filename: "utils.test.ts",
      relativePath: "src/utils.test.ts",
    });

    expect(onChange).toHaveBeenCalledWith(
      "Review @utils.test.ts please",
      [{ id: "mention-1", filename: "utils.test.ts", relativePath: "src/utils.test.ts" }],
    );
  });

  test("pastes plain text at the current selection", () => {
    const onChange = mock(() => {});
    const { container } = render(
      <MentionableInput
        value="Hello "
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "Hello ".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "world",
      },
    });

    expect(onChange).toHaveBeenCalledWith("Hello world", []);
  });

  test("replaces a non-collapsed selection when pasting plain text", () => {
    const onChange = mock(() => {});
    const inputRef = createRef<MentionableInputRef>();
    const { container } = render(
      <MentionableInput
        ref={inputRef}
        value="Hello brave world"
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "Hello ".length);
    range.setEnd(input.firstChild!, "Hello brave".length);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "kind",
      },
    });

    expect(onChange).toHaveBeenCalledWith("Hello kind world", []);
    expect(inputRef.current!.getCursorPosition()).toBe("Hello kind".length);
  });

  test("prevents paste without changing the draft when there is no selection", () => {
    const onChange = mock(() => {});
    const { container } = render(
      <MentionableInput
        value="Hello world"
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    window.getSelection()!.removeAllRanges();

    const pasteWasNotCancelled = fireEvent.paste(input, {
      clipboardData: {
        getData: () => "ignored",
      },
    });

    expect(pasteWasNotCancelled).toBe(false);
    expect(input.textContent).toBe("Hello world");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("extracts nested contenteditable blocks, line breaks, and inline text", () => {
    const onChange = mock(() => {});
    const { container } = render(
      <MentionableInput
        value=""
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    input.innerHTML =
      "Alpha<div>Beta<br>Gamma<span> delta</span></div><blockquote>Omega</blockquote>";
    fireEvent.input(input);

    expect(onChange).toHaveBeenCalledWith(
      "Alpha\nBeta\nGamma delta\nOmega",
      [],
    );
  });

  test("reports selection changes only for selections inside the editor", () => {
    const onCursorChange = mock(() => {});
    const { container, getByTestId } = render(
      <>
        <button type="button" data-testid="outside-selection">
          Outside
        </button>
        <MentionableInput
          value="Alpha beta"
          mentions={[]}
          onChange={() => {}}
          onCursorChange={onCursorChange}
        />
      </>,
    );

    const input = container.querySelector("[contenteditable]")!;
    const selection = window.getSelection()!;

    selection.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(onCursorChange).not.toHaveBeenCalled();

    const outsideRange = document.createRange();
    outsideRange.selectNodeContents(getByTestId("outside-selection"));
    outsideRange.collapse(false);
    selection.addRange(outsideRange);
    document.dispatchEvent(new Event("selectionchange"));
    expect(onCursorChange).not.toHaveBeenCalled();

    const inputRange = document.createRange();
    inputRange.setStart(input.firstChild!, "Alpha".length);
    inputRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(inputRange);
    onCursorChange.mockClear();
    document.dispatchEvent(new Event("selectionchange"));

    expect(onCursorChange).toHaveBeenCalledTimes(1);
    expect(onCursorChange).toHaveBeenCalledWith("Alpha".length, "Alpha beta");
  });

  test("ignores a selection spanning from the editor to an outside node", () => {
    const onCursorChange = mock(() => {});
    const { container, getByTestId } = render(
      <>
        <MentionableInput
          value="Alpha"
          mentions={[]}
          onChange={() => {}}
          onCursorChange={onCursorChange}
        />
        <span data-testid="outside-end">Omega</span>
      </>,
    );

    const input = container.querySelector("[contenteditable]")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, 0);
    range.setEnd(getByTestId("outside-end").firstChild!, "Omega".length);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    expect(onCursorChange).not.toHaveBeenCalled();
  });

  test("defers input updates until IME composition ends", () => {
    const onChange = mock(() => {});
    const { container } = render(
      <MentionableInput
        value=""
        mentions={[]}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    fireEvent.compositionStart(input);
    input.textContent = "あ";
    fireEvent.input(input);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    expect(onChange).toHaveBeenCalledWith("あ", []);
  });

  test("removes mention metadata when the rendered mention text is deleted", () => {
    const onChange = mock(() => {});
    const mentions = [
      { id: "1", filename: "utils.ts", relativePath: "src/utils.ts" },
    ];
    const { container } = render(
      <MentionableInput
        value="Check @utils.ts"
        mentions={mentions}
        onChange={onChange}
      />,
    );

    const input = container.querySelector("[contenteditable]")!;
    input.textContent = "Check utils.ts";
    fireEvent.input(input);

    expect(onChange).toHaveBeenCalledWith("Check utils.ts", []);
  });
});
