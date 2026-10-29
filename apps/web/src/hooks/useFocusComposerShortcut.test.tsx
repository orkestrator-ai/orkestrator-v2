import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { useFocusComposerShortcut } from "./useFocusComposerShortcut";

function Harness({
  isActive = true,
  modalOpen = false,
}: {
  isActive?: boolean;
  modalOpen?: boolean;
}) {
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<MentionableInputRef | null>({
    focus: () => textareaRef.current?.focus(),
  } as MentionableInputRef);
  useFocusComposerShortcut({ isActive, inputRef, scopeRef: composerRef });
  return (
    <>
      <div data-pane-leaf="">
        <button type="button">Transcript action</button>
        <div ref={composerRef}>
          <textarea ref={textareaRef} aria-label="Composer" />
        </div>
      </div>
      <div data-pane-leaf="">
        <button type="button">Sibling pane</button>
      </div>
      {modalOpen ? (
        <div role="dialog" aria-modal="true">
          <input aria-label="Settings field" />
        </div>
      ) : null}
    </>
  );
}

function pressCmdI(target: Element, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, { key: "i", code: "KeyI", metaKey: true, ...init });
}

afterEach(() => cleanup());

describe("useFocusComposerShortcut", () => {
  test("focuses the composer from inside the pane", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: "Transcript action" });
    button.focus();

    expect(pressCmdI(button)).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText("Composer"));
  });

  test("accepts Ctrl+I", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: "Transcript action" });

    pressCmdI(button, { metaKey: false, ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText("Composer"));
  });

  test("focuses the composer when nothing has focus", () => {
    render(<Harness />);

    pressCmdI(document.body);
    expect(document.activeElement).toBe(screen.getByLabelText("Composer"));
  });

  test("claims the key inside the composer so it does not italicise", () => {
    render(<Harness />);
    const composer = screen.getByLabelText("Composer");
    composer.focus();

    expect(pressCmdI(composer)).toBe(false);
  });

  test("leaves a neighbouring pane's ⌘I alone", () => {
    // A terminal there toggles its compose bar with the same chord.
    render(<Harness />);
    const sibling = screen.getByRole("button", { name: "Sibling pane" });
    sibling.focus();

    expect(pressCmdI(sibling)).toBe(true);
    expect(document.activeElement).toBe(sibling);
  });

  test("ignores the key while an outside dialog is open", () => {
    render(<Harness modalOpen />);

    expect(pressCmdI(document.body)).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByLabelText("Composer"));
  });

  test("only the active tab claims the key", () => {
    render(<Harness isActive={false} />);

    expect(pressCmdI(document.body)).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByLabelText("Composer"));
  });

  test("ignores other modifiers", () => {
    render(<Harness />);

    expect(pressCmdI(document.body, { shiftKey: true })).toBe(true);
    expect(pressCmdI(document.body, { altKey: true })).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByLabelText("Composer"));
  });
});
