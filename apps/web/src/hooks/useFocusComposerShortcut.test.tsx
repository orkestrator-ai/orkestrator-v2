import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { isFocusComposerShortcut, useFocusComposerShortcut } from "./useFocusComposerShortcut";

function Harness({
  isActive = true,
  modalOpen = false,
  pane = true,
  agentScope = false,
  attachRef = true,
}: {
  isActive?: boolean;
  modalOpen?: boolean;
  pane?: boolean;
  agentScope?: boolean;
  attachRef?: boolean;
}) {
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<MentionableInputRef | null>({
    focus: () => textareaRef.current?.focus(),
  } as MentionableInputRef);
  useFocusComposerShortcut({ isActive, inputRef, scopeRef: composerRef });
  return (
    <>
      <div data-pane-leaf={pane ? "" : undefined} data-agent-scope={agentScope ? "" : undefined}>
        <button type="button">Transcript action</button>
        <div ref={attachRef ? composerRef : undefined}>
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

for (const [key, code, matches] of [
  ["c", "KeyI", false],
  ["u", "KeyI", false],
  ["ш", "KeyI", true],
  ["i", "KeyC", true],
  ["I", "KeyC", true],
] as const) {
  test(`layout key ${key} at ${code} matches: ${matches}`, () => {
    const event = new KeyboardEvent("keydown", { key, code, ctrlKey: true });
    expect(isFocusComposerShortcut(event)).toBe(matches);
    render(<Harness />);
    const button = screen.getByRole("button", { name: "Transcript action" });
    button.focus();
    expect(pressCmdI(button, { key, code })).toBe(!matches);
    expect(document.activeElement).toBe(matches ? screen.getByLabelText("Composer") : button);
  });
}

test("prevents auto-repeat without moving focus again", () => {
  render(<Harness />);
  const button = screen.getByRole("button", { name: "Transcript action" });
  button.focus();
  expect(pressCmdI(button, { repeat: true })).toBe(false);
  expect(document.activeElement).toBe(button);
});

test("leaves a previously consumed chord alone", () => {
  render(<Harness />);
  const button = screen.getByRole("button", { name: "Transcript action" });
  button.focus();
  const event = new KeyboardEvent("keydown", {
    key: "i",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  event.preventDefault();
  button.dispatchEvent(event);
  expect(document.activeElement).toBe(button);
});

test("ignores IME composition", () => {
  render(<Harness />);
  const button = screen.getByRole("button", { name: "Transcript action" });
  button.focus();
  expect(pressCmdI(button, { isComposing: true })).toBe(true);
  expect(document.activeElement).toBe(button);
});

test("focuses from a sibling control in a pane-less agent scope", () => {
  render(<Harness pane={false} agentScope />);
  const button = screen.getByRole("button", { name: "Transcript action" });
  expect(pressCmdI(button)).toBe(false);
  expect(document.activeElement).toBe(screen.getByLabelText("Composer"));
});

test("falls back to the composer when no scope marker exists", () => {
  render(<Harness pane={false} />);
  const button = screen.getByRole("button", { name: "Transcript action" });
  button.focus();
  expect(pressCmdI(button)).toBe(true);
  expect(document.activeElement).toBe(button);
  expect(pressCmdI(screen.getByLabelText("Composer"))).toBe(false);
  expect(document.activeElement).toBe(screen.getByLabelText("Composer"));
});

test("does not claim a focused target with a null scope ref", () => {
  render(<Harness attachRef={false} />);
  const button = screen.getByRole("button", { name: "Transcript action" });
  button.focus();
  expect(pressCmdI(button)).toBe(true);
  expect(document.activeElement).toBe(button);
});

test("unregisters when inactive and on unmount", () => {
  const view = render(<Harness />);
  view.rerender(<Harness isActive={false} />);
  expect(pressCmdI(document.body)).toBe(true);
  view.rerender(<Harness />);
  expect(pressCmdI(document.body)).toBe(false);
  view.unmount();
  expect(pressCmdI(document.body)).toBe(true);
});
