import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { useComposerMountFocus } from "./useComposerMountFocus";

function Composer() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<MentionableInputRef | null>({
    focus: () => textareaRef.current?.focus(),
  } as MentionableInputRef);
  useComposerMountFocus(inputRef);
  return <textarea ref={textareaRef} aria-label="Composer" />;
}

function Harness({ composer, panel }: { composer: boolean; panel: "open" | "closed" }) {
  return (
    <>
      <button type="button">Open tab</button>
      <section role="dialog" aria-label="Agent information" aria-hidden={panel === "closed"}>
        <button type="button">Close agent information</button>
      </section>
      {composer ? <Composer /> : null}
    </>
  );
}

describe("useComposerMountFocus", () => {
  afterEach(cleanup);

  test("focuses the composer when its tab mounts from an ordinary control", () => {
    const { rerender } = render(<Harness composer={false} panel="closed" />);
    screen.getByRole("button", { name: "Open tab" }).focus();
    rerender(<Harness composer panel="closed" />);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Composer" }));
  });

  test("leaves focus in an open panel when the composer mounts late", () => {
    const { rerender } = render(<Harness composer={false} panel="open" />);
    const close = screen.getByRole("button", { name: "Close agent information" });
    close.focus();
    rerender(<Harness composer panel="open" />);
    expect(document.activeElement).toBe(close);
  });
});
