import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TerminalProvider } from "@/contexts";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { NativeMessage } from "./NativeMessage";

afterEach(cleanup);

let messageCounter = 0;

function renderParts(parts: NativeMessagePart[]) {
  messageCounter += 1;
  return render(
    <TerminalProvider>
      <NativeMessage
        message={{
          // Unique per test so persisted expansion state cannot leak between them.
          id: `question-tool-${messageCounter}`,
          role: "assistant",
          content: "",
          createdAt: "2026-10-16T10:00:00.000Z",
          parts,
        }}
      />
    </TerminalProvider>,
  );
}

const QUESTION_ARGS = {
  questions: [
    {
      question: "How should I treat the commit?",
      header: "0795fb29",
      multiSelect: false,
      options: [
        { label: "Keep it on top and push", description: "Push it as part of #1012." },
        { label: "Leave it alone", description: "Someone else is still working on it." },
      ],
    },
    {
      question: "Where should the two public keys go?",
      header: "Keys go in",
      multiSelect: false,
      options: [{ label: "A sixth PR on top (Recommended)" }, { label: "Into #1003" }],
    },
  ],
};

const ANSWERED_OUTPUT =
  'Your questions have been answered: "How should I treat the commit?"="Keep it on top and push", ' +
  '"Where should the two public keys go?"="Into #1003". You can now continue with these answers in mind.';

function questionPart(overrides: Partial<NativeMessagePart> = {}): NativeMessagePart {
  return {
    type: "tool-invocation",
    content: "",
    toolUseId: `ask-${messageCounter}`,
    toolName: "AskUserQuestion",
    toolState: "success",
    toolArgs: QUESTION_ARGS,
    toolOutput: ANSWERED_OUTPUT,
    ...overrides,
  } as NativeMessagePart;
}

describe("question tool row", () => {
  test("renders questions and marks the chosen answers instead of JSON", () => {
    const { container } = renderParts([questionPart()]);

    expect(screen.getByText("2 questions · How should I treat the commit?")).toBeTruthy();
    fireEvent.click(screen.getByText("AskUserQuestion"));

    const details = screen.getByTestId("question-tool");
    expect(container.textContent).not.toContain('"questions"');
    expect(container.textContent).not.toContain("Your questions have been answered");

    const first = within(details).getByRole("region", { name: "0795fb29" });
    expect(within(first).getByText("How should I treat the commit?")).toBeTruthy();
    expect(within(first).getByText("Push it as part of #1012.")).toBeTruthy();
    const selected = [...details.querySelectorAll("[data-selected]")].map((row) =>
      row.textContent?.trim(),
    );
    expect(selected).toEqual(["Keep it on top and pushPush it as part of #1012.", "Into #1003"]);
  });

  test("shows a custom reply that matches no option", () => {
    renderParts([
      questionPart({
        toolOutput:
          'Your questions have been answered: "How should I treat the commit?"="Ask the author first", ' +
          '"Where should the two public keys go?"="Into #1003". You can now continue.',
      }),
    ]);
    fireEvent.click(screen.getByText("AskUserQuestion"));

    expect(screen.getByText("Ask the author first")).toBeTruthy();
  });

  test("keeps result text it cannot attribute to a question", () => {
    renderParts([questionPart({ toolOutput: "The user dismissed the questions." })]);
    fireEvent.click(screen.getByText("AskUserQuestion"));

    expect(screen.getByTestId("question-tool")).toBeTruthy();
    expect(screen.getByText("The user dismissed the questions.")).toBeTruthy();
    expect(screen.getByTestId("question-tool").querySelector("[data-selected]")).toBeNull();
  });
});
