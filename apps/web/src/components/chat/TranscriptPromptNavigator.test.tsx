import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { TranscriptScrollController } from "@/lib/transcript-scroll/transcript-scroll-controller";
import { TranscriptPromptNavigator } from "./TranscriptPromptNavigator";

afterEach(cleanup);

function row(id: string, role: NativeMessage["role"], content: string): NativeMessage {
  return {
    id,
    role,
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-11-05T00:00:00.000Z",
  };
}

const MESSAGES = [
  row("first", "user", "Explain the pull request"),
  row("first-reply", "assistant", "I read the diff. Here is the walkthrough."),
  row("mail", "assistant", "Between prompts"),
  row("second", "user", "Now fix the test"),
  row("third", "user", "And ship it"),
];

function setup(messages: NativeMessage[] = MESSAGES) {
  const glideTo = mock(() => true);
  const controller = { glideTo } as unknown as TranscriptScrollController;
  const view = render(
    <TranscriptPromptNavigator messages={messages} controller={controller} bottomInsetPx={120} />,
  );
  return { glideTo, controller, ...view };
}

const lines = () =>
  within(screen.getByRole("navigation", { name: /your prompts/i })).getAllByRole("button");
const lineStyle = (button: HTMLElement) =>
  (button.firstElementChild as HTMLElement).style as CSSStyleDeclaration;

describe("TranscriptPromptNavigator", () => {
  test("renders one line per prompt and nothing without prompts", () => {
    setup();
    expect(lines().map((line) => line.getAttribute("aria-label"))).toEqual([
      "Go to prompt 1 of 3: Explain the pull request",
      "Go to prompt 2 of 3: Now fix the test",
      "Go to prompt 3 of 3: And ship it",
    ]);
    cleanup();
    setup([row("only", "assistant", "No prompt here")]);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  test("the hovered line is the longest and brightest, and previews its prompt", () => {
    setup();
    expect(screen.queryByTestId("transcript-prompt-preview")).toBeNull();

    fireEvent.pointerEnter(lines()[0]!);

    const [hovered, near, far] = lines().map(lineStyle);
    expect(Number.parseFloat(hovered!.width)).toBeGreaterThan(Number.parseFloat(near!.width));
    expect(Number.parseFloat(near!.width)).toBeGreaterThan(Number.parseFloat(far!.width));
    expect(Number(hovered!.opacity)).toBe(1);
    expect(Number(near!.opacity)).toBeGreaterThan(Number(far!.opacity));

    const preview = screen.getByTestId("transcript-prompt-preview");
    expect(preview.textContent).toContain("Explain the pull request");
    expect(preview.textContent).toContain("I read the diff.");

    fireEvent.pointerLeave(screen.getByRole("navigation"));
    expect(screen.queryByTestId("transcript-prompt-preview")).toBeNull();
  });

  test("a prompt with no reply yet previews only itself", () => {
    setup();
    fireEvent.pointerEnter(lines()[2]!);
    expect(screen.getByTestId("transcript-prompt-preview").textContent).toBe("And ship it");
  });

  test("a click glides to the prompt's current row", () => {
    const { glideTo } = setup();
    fireEvent.click(lines()[1]!);
    expect(glideTo).toHaveBeenCalledWith(
      { kind: "row", index: 3, key: "second", offsetPx: 16 },
      "row",
    );
  });

  test("a click leaves focus where it was, in the composer", () => {
    setup();
    // Not cancelled, the browser would move focus to the button on mouse down.
    expect(fireEvent.mouseDown(lines()[0]!)).toBe(false);
  });

  test("the rail is one tab stop, and the arrow keys move along it", () => {
    setup();
    expect(lines().map((line) => line.tabIndex)).toEqual([-1, -1, 0]);

    lines()[2]!.focus();
    fireEvent.keyDown(lines()[2]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(lines()[1]!);
    fireEvent.keyDown(lines()[1]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(lines()[2]!);
    // At the end of the rail there is nowhere further to go.
    fireEvent.keyDown(lines()[2]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(lines()[2]!);
  });

  test("a new prompt joins the rail, and a removed one ends its preview", () => {
    const { controller, rerender } = setup();
    fireEvent.pointerEnter(lines()[2]!);

    const next = [...MESSAGES, row("fourth", "user", "One more")];
    rerender(
      <TranscriptPromptNavigator messages={next} controller={controller} bottomInsetPx={120} />,
    );
    expect(lines()).toHaveLength(4);
    expect(screen.getByTestId("transcript-prompt-preview").textContent).toBe("And ship it");

    rerender(
      <TranscriptPromptNavigator
        messages={MESSAGES.slice(0, 2)}
        controller={controller}
        bottomInsetPx={120}
      />,
    );
    expect(lines()).toHaveLength(1);
    expect(screen.queryByTestId("transcript-prompt-preview")).toBeNull();
  });
});
