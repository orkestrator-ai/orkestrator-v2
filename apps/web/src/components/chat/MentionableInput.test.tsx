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

  test("locked focused input ignores submit and completion shortcuts until unlocked", () => {
    const onKeyDown = mock(() => {});
    const onChange = mock(() => {});
    const props = { value: "/com", mentions: [], onChange, onKeyDown };
    const { getByRole, rerender } = render(<MentionableInput {...props} />);
    const input = getByRole("textbox");
    input.focus();
    rerender(<MentionableInput {...props} disabled />);
    for (const key of ["Enter", "Tab", "ArrowDown", "Escape"]) {
      fireEvent.keyDown(input, { key });
    }
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(input.textContent).toBe("/com");
    expect(document.activeElement).toBe(input);
    rerender(<MentionableInput {...props} />);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  test("restores draft text into the DOM on first render", () => {
    const draftText = "Hello, this is my draft";
    const { container } = render(
      <MentionableInput value={draftText} mentions={[]} onChange={() => {}} />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();
    expect(input!.textContent).toBe(draftText);
  });

  test("renders empty when value is empty string", () => {
    const { container, getByRole } = render(
      <MentionableInput value="" mentions={[]} onChange={() => {}} />,
    );

    const input = container.querySelector("[contenteditable]") as HTMLElement;
    expect(input).not.toBeNull();
    expect(input.textContent).toBe("");
    expect(input.style.minHeight).toBe("28px");
    expect(input.style.maxHeight).toBe("216px");
    expect(input.getAttribute("data-placeholder")).toBe("Type a message...");
    expect(getByRole("textbox", { name: "Type a message..." })).toBe(input);
    expect(input.getAttribute("aria-multiline")).toBe("true");
    expect(input.getAttribute("aria-placeholder")).toBe("Type a message...");
    expect(
      input.parentElement?.querySelector("[data-native-compose-placeholder]")?.textContent,
    ).toBe("Type a message...");
  });

  test("marks the editable element for the iOS focus-zoom workaround", () => {
    const { container } = render(<MentionableInput value="" mentions={[]} onChange={() => {}} />);

    const input = container.querySelector("[contenteditable]");
    expect(input?.classList.contains("native-compose-input")).toBe(true);
    expect(input?.parentElement?.classList.contains("native-compose-input-viewport")).toBe(false);
  });

  test("renders one placeholder and applies custom class and height props", () => {
    const { container, rerender } = render(
      <MentionableInput
        value=""
        mentions={[]}
        onChange={() => {}}
        placeholder="Describe the change"
        className="custom-compose-class"
        minHeight={40}
        maxHeight={80}
      />,
    );

    const input = container.querySelector("[contenteditable]") as HTMLElement;
    expect(input.classList.contains("custom-compose-class")).toBe(true);
    expect(input.style.minHeight).toBe("40px");
    expect(input.style.maxHeight).toBe("80px");
    expect(input.getAttribute("data-placeholder")).toBe("Describe the change");
    expect(input.className).not.toContain("before:content");
    const placeholders = input.parentElement?.querySelectorAll("[data-native-compose-placeholder]");
    expect(placeholders?.length).toBe(1);
    expect(placeholders?.[0]?.textContent).toBe("Describe the change");
    expect(placeholders?.[0]?.classList.contains("native-compose-placeholder")).toBe(true);

    rerender(
      <MentionableInput
        value="Ready"
        mentions={[]}
        onChange={() => {}}
        placeholder="Describe the change"
      />,
    );
    expect(input.parentElement?.querySelector("[data-native-compose-placeholder]") === null).toBe(
      true,
    );
  });

  test("syncs external value and mention metadata changes into the editor", () => {
    const initialMention = {
      id: "mention-1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    };
    const { container, rerender } = render(
      <MentionableInput value="Check @utils.ts" mentions={[initialMention]} onChange={() => {}} />,
    );

    const input = container.querySelector("[contenteditable]") as HTMLElement;
    expect(input.querySelector("[data-mention='true']")?.getAttribute("data-path")).toBe(
      "src/utils.ts",
    );

    rerender(
      <MentionableInput
        value="Check @utils.ts"
        mentions={[{ ...initialMention, relativePath: "packages/utils.ts" }]}
        onChange={() => {}}
      />,
    );
    expect(input.querySelector("[data-mention='true']")?.getAttribute("data-path")).toBe(
      "packages/utils.ts",
    );

    rerender(
      <MentionableInput
        value="Check @utils.ts"
        mentions={[
          {
            ...initialMention,
            id: "mention-2",
            relativePath: "packages/utils.ts",
          },
        ]}
        onChange={() => {}}
      />,
    );
    expect(input.querySelector("[data-mention='true']")?.getAttribute("data-id")).toBe("mention-2");

    rerender(
      <MentionableInput
        value="Check @utils.ts"
        mentions={[
          {
            ...initialMention,
            id: "mention-2",
            filename: "helpers.ts",
            relativePath: "packages/utils.ts",
          },
        ]}
        onChange={() => {}}
      />,
    );
    expect(input.querySelector("[data-mention='true']") === null).toBe(true);

    rerender(<MentionableInput value="A replacement draft" mentions={[]} onChange={() => {}} />);
    expect(input.textContent).toBe("A replacement draft");
  });

  test("preserves live content and selection across an unchanged-value rerender", () => {
    const inputRef = createRef<MentionableInputRef>();
    const initialMentions: FileMention[] = [];
    const { container, rerender } = render(
      <MentionableInput
        ref={inputRef}
        value="Alpha"
        mentions={initialMentions}
        onChange={() => {}}
      />,
    );

    const input = container.querySelector("[contenteditable]") as HTMLElement;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, 2);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    rerender(
      <MentionableInput
        ref={inputRef}
        value="Alpha"
        mentions={[]}
        onChange={() => {}}
        className="rerendered"
      />,
    );

    expect(input.textContent).toBe("Alpha");
    expect(input.classList.contains("rerendered")).toBe(true);
    expect(inputRef.current!.getCursorPosition()).toBe(2);
  });

  test("escapes special characters in text and mention metadata", () => {
    const filename = `a&b".ts`;
    const draftText = `Review <script>alert("x")</script> @${filename}`;
    const { container } = render(
      <MentionableInput
        value={draftText}
        mentions={[
          {
            id: `id"&<`,
            filename,
            relativePath: `src/"<&.ts`,
          },
        ]}
        onChange={() => {}}
      />,
    );

    const input = container.querySelector("[contenteditable]") as HTMLElement;
    const mention = input.querySelector("[data-mention='true']");
    expect(input.textContent).toBe(draftText);
    expect(input.querySelector("script") === null).toBe(true);
    expect(mention?.getAttribute("data-id")).toBe(`id"&<`);
    expect(mention?.getAttribute("data-filename")).toBe(filename);
    expect(mention?.getAttribute("data-path")).toBe(`src/"<&.ts`);
  });

  test("restores draft text with mentions on first render", () => {
    const draftText = "Check @utils.ts for details";
    const mentions = [{ id: "1", filename: "utils.ts", relativePath: "src/utils.ts" }];
    const { container } = render(
      <MentionableInput value={draftText} mentions={mentions} onChange={() => {}} />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();
    expect(input!.textContent).toBe(draftText);

    const mentionSpan = input!.querySelector("[data-mention='true']");
    expect(mentionSpan).not.toBeNull();
    expect(mentionSpan!.textContent).toBe("@utils.ts");
  });

  test("renders overlapping and duplicate mention filenames without rewriting generated markup", () => {
    const { container } = render(
      <MentionableInput
        value="@utils.tsx and @utils.ts then @utils.ts"
        mentions={[
          { id: "old-short", filename: "utils.ts", relativePath: "old/utils.ts" },
          { id: "long", filename: "utils.tsx", relativePath: "src/utils.tsx" },
          { id: "new-short", filename: "utils.ts", relativePath: "src/utils.ts" },
        ]}
        onChange={() => {}}
      />,
    );

    const input = container.querySelector("[contenteditable]") as HTMLElement;
    const renderedMentions = Array.from(
      input.querySelectorAll<HTMLElement>("[data-mention='true']"),
    );
    expect(input.textContent).toBe("@utils.tsx and @utils.ts then @utils.ts");
    expect(renderedMentions.map((mention) => mention.dataset.id)).toEqual([
      "long",
      "new-short",
      "new-short",
    ]);
    expect(
      renderedMentions.every((mention) => mention.querySelector("[data-mention='true']") === null),
    ).toBe(true);
  });

  test("renders multiline drafts and restores a caret after a line break", () => {
    const inputRef = createRef<MentionableInputRef>();
    const { container, rerender } = render(
      <MentionableInput ref={inputRef} value={"Alpha\nBeta"} mentions={[]} onChange={() => {}} />,
    );

    const input = container.querySelector("[contenteditable]") as HTMLElement;
    expect(input.querySelector("br")).not.toBeNull();
    expect(input.innerHTML).toBe("Alpha<br>Beta");

    let betaText = input.lastChild!;
    const selection = window.getSelection()!;
    let range = document.createRange();
    range.setStart(betaText, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(inputRef.current!.getCursorPosition()).toBe("Alpha\n".length);

    rerender(
      <MentionableInput ref={inputRef} value={"Alpha\nBeta!"} mentions={[]} onChange={() => {}} />,
    );

    expect(input.innerHTML).toBe("Alpha<br>Beta!");
    expect(inputRef.current!.getCursorPosition()).toBe("Alpha\n".length);

    betaText = input.lastChild!;
    range = document.createRange();
    range.setStart(betaText, 1);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(inputRef.current!.getCursorPosition()).toBe("Alpha\nB".length);

    rerender(
      <MentionableInput ref={inputRef} value={"Alpha\nBeta!!"} mentions={[]} onChange={() => {}} />,
    );

    expect(input.innerHTML).toBe("Alpha<br>Beta!!");
    expect(inputRef.current!.getCursorPosition()).toBe("Alpha\nB".length);
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
      <MentionableInput ref={inputRef} value="Hello" mentions={[]} onChange={() => {}} />,
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

  test("falls back safely when the cursor selection is absent or outside the editor", () => {
    const inputRef = createRef<MentionableInputRef>();
    const { container, getByTestId } = render(
      <>
        <span data-testid="outside-selection">Outside</span>
        <MentionableInput ref={inputRef} value="Hello" mentions={[]} onChange={() => {}} />
      </>,
    );

    window.getSelection()!.removeAllRanges();
    expect(inputRef.current!.getCursorPosition()).toBe(0);

    const outside = getByTestId("outside-selection");
    const outsideRange = document.createRange();
    outsideRange.setStart(outside.firstChild!, 2);
    outsideRange.collapse(true);
    window.getSelection()!.addRange(outsideRange);
    expect(inputRef.current!.getCursorPosition()).toBe("Hello".length);

    expect(container.querySelector("[contenteditable]")?.textContent).toBe("Hello");
  });

  test("prevents regular Enter while forwarding keydown events", () => {
    const onKeyDown = mock(() => {});
    const { container } = render(
      <MentionableInput value="" mentions={[]} onChange={() => {}} onKeyDown={onKeyDown} />,
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
      <MentionableInput value="" mentions={[]} onChange={() => {}} onKeyDown={onKeyDown} />,
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

  test("leaves IME composition Enter to the browser without forwarding it", () => {
    const onKeyDown = mock(() => {});
    const { container } = render(
      <MentionableInput value="" mentions={[]} onChange={() => {}} onKeyDown={onKeyDown} />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });

    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  // WebKit (Safari, and the WKWebView the iOS app loads this UI in) fires
  // compositionend before the confirming keydown, so `isComposing` is already
  // false and only keyCode 229 still identifies the keystroke as an IME
  // confirmation rather than a submit.
  test("leaves a WebKit composition-confirming Enter to the browser", () => {
    const onKeyDown = mock(() => {});
    const { container } = render(
      <MentionableInput value="" mentions={[]} onChange={() => {}} onKeyDown={onKeyDown} />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: false,
      keyCode: 229,
    });
    expect(event.isComposing).toBe(false);
    expect(event.keyCode).toBe(229);

    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  test("renders as non-editable when disabled", () => {
    const { container } = render(
      <MentionableInput value="Locked" mentions={[]} onChange={() => {}} disabled />,
    );

    const input = container.querySelector("[contenteditable]");
    expect(input).not.toBeNull();
    expect(input!.getAttribute("contenteditable")).toBe("false");
    expect(input!.getAttribute("aria-disabled")).toBe("true");
  });

  test("stays focusable but out of the tab order while disabled", () => {
    const { container, rerender } = render(
      <MentionableInput value="" mentions={[]} onChange={() => {}} />,
    );

    const input = container.querySelector("[contenteditable]") as HTMLElement;
    expect(input.hasAttribute("tabindex")).toBe(false);

    rerender(<MentionableInput value="" mentions={[]} onChange={() => {}} disabled />);
    expect(input.getAttribute("tabindex")).toBe("-1");

    rerender(<MentionableInput value="" mentions={[]} onChange={() => {}} />);
    expect(input.hasAttribute("tabindex")).toBe(false);
  });

  test("keeps focus and restores the caret when a send re-enables the input", () => {
    const inputRef = createRef<MentionableInputRef>();

    function Harness({ text, sending }: { text: string; sending: boolean }) {
      return (
        <MentionableInput
          ref={inputRef}
          value={text}
          mentions={[]}
          onChange={() => {}}
          disabled={sending}
        />
      );
    }

    const { container, rerender } = render(<Harness text="Ship it" sending={false} />);
    const input = container.querySelector("[contenteditable]") as HTMLElement;
    act(() => inputRef.current!.focus());
    expect(document.activeElement).toBe(input);

    rerender(<Harness text="Ship it" sending />);
    expect(document.activeElement).toBe(input);

    // The send completes: the draft clears and editing is allowed again.
    window.getSelection()!.removeAllRanges();
    rerender(<Harness text="" sending={false} />);

    expect(document.activeElement).toBe(input);
    const selection = window.getSelection()!;
    expect(selection.rangeCount).toBe(1);
    expect(input.contains(selection.getRangeAt(0).startContainer)).toBe(true);
    expect(inputRef.current!.getCursorPosition()).toBe(0);
  });

  test("places the caret at the end of a draft restored after a failed send", () => {
    const inputRef = createRef<MentionableInputRef>();
    const { container, rerender } = render(
      <MentionableInput ref={inputRef} value="Retry me" mentions={[]} onChange={() => {}} />,
    );
    const input = container.querySelector("[contenteditable]") as HTMLElement;
    act(() => inputRef.current!.focus());

    rerender(
      <MentionableInput
        ref={inputRef}
        value="Retry me"
        mentions={[]}
        onChange={() => {}}
        disabled
      />,
    );
    window.getSelection()!.removeAllRanges();
    rerender(
      <MentionableInput ref={inputRef} value="Retry me" mentions={[]} onChange={() => {}} />,
    );

    expect(document.activeElement).toBe(input);
    expect(inputRef.current!.getCursorPosition()).toBe("Retry me".length);
  });

  test("does not take focus when re-enabled after focus moved elsewhere", () => {
    function Harness({ sending }: { sending: boolean }) {
      return (
        <>
          <button type="button" data-testid="elsewhere">
            Elsewhere
          </button>
          <MentionableInput value="" mentions={[]} onChange={() => {}} disabled={sending} />
        </>
      );
    }

    const { getByTestId, rerender } = render(<Harness sending />);
    const elsewhere = getByTestId("elsewhere");
    elsewhere.focus();

    rerender(<Harness sending={false} />);

    expect(document.activeElement).toBe(elsewhere);
  });

  test("a composer that mounts while an open panel holds focus leaves focus and the caret there", () => {
    const inputRef = createRef<MentionableInputRef>();
    function Harness({ value }: { value: string | null }) {
      return (
        <>
          <section role="dialog" aria-label="Agent information" aria-hidden="false">
            <button type="button" data-testid="panel-close">
              Close
            </button>
          </section>
          {value === null ? null : (
            <MentionableInput ref={inputRef} value={value} mentions={[]} onChange={() => {}} />
          )}
        </>
      );
    }

    const { getByTestId, getByRole, rerender } = render(<Harness value={null} />);
    const close = getByTestId("panel-close");
    close.focus();
    window.getSelection()!.removeAllRanges();

    // A late composer restores its draft. Chromium focuses a contenteditable
    // that receives the caret, so neither may move while the panel is open.
    rerender(<Harness value="Late draft" />);
    expect(document.activeElement).toBe(close);
    expect(window.getSelection()!.rangeCount).toBe(0);

    // The caret the sync could not place lands when the editor is focused.
    const input = getByRole("textbox", { name: "Type a message..." });
    act(() => input.focus());
    expect(input.textContent).toBe("Late draft");
    expect(inputRef.current!.getCursorPosition()).toBe("Late draft".length);

    // A later sync, back in the panel, leaves it alone too.
    close.focus();
    rerender(<Harness value="Late draft, revised" />);
    expect(input.textContent).toBe("Late draft, revised");
    expect(document.activeElement).toBe(close);
  });

  test.each([
    ["direct", "Late draft, revised"],
    ["imperative", "Late draft, revised"],
    ["direct", "Short"],
    ["imperative", "Short"],
  ])(
    "preserves the deferred caret before %s focus with final draft %s",
    (focusMethod, finalValue) => {
      const ref = createRef<MentionableInputRef>();
      const mention = {
        id: "file-1",
        relativePath: "src/a.ts",
        filename: "a.ts",
      } satisfies FileMention;
      function Harness({ value, mentions }: { value: string | null; mentions: FileMention[] }) {
        return (
          <>
            <section role="dialog" aria-label="Agent information">
              <button type="button">Close panel</button>
            </section>
            {value !== null && (
              <MentionableInput ref={ref} value={value} mentions={mentions} onChange={() => {}} />
            )}
          </>
        );
      }
      const { getByRole, rerender } = render(<Harness value={null} mentions={[]} />);
      const close = getByRole("button", { name: "Close panel" });
      close.focus();
      window.getSelection()!.removeAllRanges();
      for (const [value, mentions] of [
        ["Late draft", []],
        ["Late draft, revised", []],
        ["Late draft, revised", [mention]],
        [finalValue, [mention]],
      ] as [string, FileMention[]][]) {
        rerender(<Harness value={value} mentions={mentions} />);
        expect(document.activeElement).toBe(close);
        expect(window.getSelection()!.rangeCount).toBe(0);
      }
      const input = getByRole("textbox");
      act(() => {
        if (focusMethod === "direct") input.focus();
        else ref.current!.focus();
      });
      expect(document.activeElement).toBe(input);
      expect(ref.current!.getCursorPosition()).toBe(
        Math.min("Late draft".length, finalValue.length),
      );
    },
  );

  test("a draft that syncs in while a closed panel's control keeps focus places the caret", () => {
    const { getByTestId, getByRole } = render(
      <>
        <section role="dialog" aria-hidden="true">
          <button type="button" data-testid="hidden-close">
            Close
          </button>
        </section>
        <MentionableInput value="Draft" mentions={[]} onChange={() => {}} />
      </>,
    );
    getByTestId("hidden-close").focus();
    const input = getByRole("textbox");
    expect(input.contains(window.getSelection()!.getRangeAt(0).startContainer)).toBe(true);
  });

  test("ignores pastes while disabled", () => {
    const onChange = mock(() => {});
    const { container } = render(
      <MentionableInput value="Hello " mentions={[]} onChange={onChange} disabled />,
    );

    const input = container.querySelector("[contenteditable]")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "Hello ".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    const pasteWasNotCancelled = fireEvent.paste(input, {
      clipboardData: {
        getData: () => "world",
      },
    });

    expect(pasteWasNotCancelled).toBe(false);
    expect(input.textContent).toBe("Hello ");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("focusAtEnd parks the cursor after a wholesale value replacement", () => {
    const inputRef = createRef<MentionableInputRef>();

    function Harness() {
      const [draftText, setDraftText] = useState("/st");

      return (
        <>
          <button type="button" data-testid="replace-draft" onClick={() => setDraftText("/steer ")}>
            Replace
          </button>
          <MentionableInput
            ref={inputRef}
            value={draftText}
            mentions={[]}
            onChange={(newText) => setDraftText(newText)}
          />
        </>
      );
    }

    const { container, getByTestId } = render(<Harness />);
    const input = container.querySelector("[contenteditable]") as HTMLElement;

    // The caret sits where the user stopped typing the prefix — restoring that
    // offset into "/steer " would land it mid-word.
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "/st".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    act(() => {
      getByTestId("replace-draft").click();
      inputRef.current!.focusAtEnd("/steer ");
    });

    expect(input.textContent).toBe("/steer ");
    expect(document.activeElement).toBe(input);
    expect(inputRef.current!.getCursorPosition()).toBe("/steer ".length);
  });

  test("focusAtEnd parks the cursor when the value replacement already rendered", () => {
    const inputRef = createRef<MentionableInputRef>();
    const onChange = mock(() => {});
    const { container, rerender } = render(
      <MentionableInput ref={inputRef} value="/st" mentions={[]} onChange={onChange} />,
    );
    const input = container.querySelector("[contenteditable]") as HTMLElement;

    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, "/st".length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    // Zustand-backed composer updates can render before selectCommand calls
    // focusAtEnd, so there may be no later render to apply a queued cursor.
    rerender(<MentionableInput ref={inputRef} value="/steer " mentions={[]} onChange={onChange} />);
    expect(inputRef.current!.getCursorPosition()).toBe("/st".length);

    act(() => inputRef.current!.focusAtEnd("/steer "));

    expect(document.activeElement).toBe(input);
    expect(inputRef.current!.getCursorPosition()).toBe("/steer ".length);

    const laterRange = document.createRange();
    laterRange.setStart(input.firstChild!, 3);
    laterRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(laterRange);

    rerender(
      <MentionableInput ref={inputRef} value="/st!eer " mentions={[]} onChange={onChange} />,
    );

    expect(inputRef.current!.getCursorPosition()).toBe(3);
  });

  test("inserts a mention at the last known cursor position when focus moved outside", () => {
    const onChange = mock(() => {});
    const inputRef = createRef<MentionableInputRef>();

    render(
      <MentionableInput ref={inputRef} value="Review @ut" mentions={[]} onChange={onChange} />,
    );

    inputRef.current!.insertMention({
      id: "mention-1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    });

    expect(onChange).toHaveBeenCalledWith("Review @utils.ts ", [
      { id: "mention-1", filename: "utils.ts", relativePath: "src/utils.ts" },
    ]);
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
      <MentionableInput ref={inputRef} value="Review utils" mentions={[]} onChange={onChange} />,
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
      <MentionableInput ref={inputRef} value="Review utils" mentions={[]} onChange={onChange} />,
    );

    inputRef.current!.insertMentionAtCursor({
      id: "mention-1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    });

    expect(onChange).toHaveBeenCalledWith("Review utils @utils.ts ", [
      { id: "mention-1", filename: "utils.ts", relativePath: "src/utils.ts" },
    ]);
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
  ])("inserts a picker mention $name", ({ value, cursor, expectedText, expectedCursor }) => {
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
  });

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
      <MentionableInput ref={inputRef} value="Review @ut" mentions={[]} onChange={onChange} />,
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
      <MentionableInput ref={inputRef} value="Review @ut" mentions={[]} onChange={onChange} />,
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

    expect(onChange).toHaveBeenCalledWith("Review @utils.ts ", [
      { id: "mention-1", filename: "utils.ts", relativePath: "src/utils.ts" },
    ]);
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

    expect(onChange).toHaveBeenCalledWith("Review @utils.ts please", [
      { id: "mention-1", filename: "utils.ts", relativePath: "src/utils.ts" },
    ]);
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

    expect(onChange).toHaveBeenCalledWith("Review @utils.test.ts please", [
      { id: "mention-1", filename: "utils.test.ts", relativePath: "src/utils.test.ts" },
    ]);
  });

  test("pastes plain text at the current selection", () => {
    const onChange = mock(() => {});
    const { container } = render(
      <MentionableInput value="Hello " mentions={[]} onChange={onChange} />,
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
      <MentionableInput value="Hello world" mentions={[]} onChange={onChange} />,
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
    const { container } = render(<MentionableInput value="" mentions={[]} onChange={onChange} />);

    const input = container.querySelector("[contenteditable]")!;
    input.innerHTML =
      "Alpha<div>Beta<br>Gamma<span> delta</span></div><blockquote>Omega</blockquote>";
    fireEvent.input(input);

    expect(onChange).toHaveBeenCalledWith("Alpha\nBeta\nGamma delta\nOmega", []);
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
    const { container } = render(<MentionableInput value="" mentions={[]} onChange={onChange} />);

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
    const mentions = [{ id: "1", filename: "utils.ts", relativePath: "src/utils.ts" }];
    const { container } = render(
      <MentionableInput value="Check @utils.ts" mentions={mentions} onChange={onChange} />,
    );

    const input = container.querySelector("[contenteditable]")!;
    input.textContent = "Check utils.ts";
    fireEvent.input(input);

    expect(onChange).toHaveBeenCalledWith("Check utils.ts", []);
  });

  test("retains mention metadata when surrounding text changes", () => {
    const onChange = mock(() => {});
    const mention = {
      id: "1",
      filename: "utils.ts",
      relativePath: "src/utils.ts",
    };
    const { container } = render(
      <MentionableInput value="Check @utils.ts" mentions={[mention]} onChange={onChange} />,
    );

    const input = container.querySelector("[contenteditable]")!;
    input.insertBefore(document.createTextNode("Please "), input.firstChild);
    fireEvent.input(input);

    expect(onChange).toHaveBeenCalledWith("Please Check @utils.ts", [mention]);
  });
});
