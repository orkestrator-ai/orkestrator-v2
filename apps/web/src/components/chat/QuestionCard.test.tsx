import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuestionCard, type QuestionCardQuestion } from "./QuestionCard";

/**
 * Covers the shared card directly. `ClaudeQuestionCard.test.tsx` exercises it
 * through Claude's wrapper, which cannot reach the OpenCode-only paths
 * (`exclusiveSingleSelect`, the per-question `allowCustomAnswer` override) or
 * the `option.value` fallback, since Claude's fixtures never set them.
 */
function renderCard(
  questions: QuestionCardQuestion[],
  props: Partial<React.ComponentProps<typeof QuestionCard>> = {},
) {
  const onSubmit = mock(async () => true);
  render(
    <QuestionCard
      agentLabel="Test"
      title="Agent needs your input"
      questions={questions}
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { onSubmit };
}

const TWO_QUESTIONS: QuestionCardQuestion[] = [
  { question: "One?", header: "One", options: [{ label: "1a" }, { label: "1b" }] },
  { question: "Two?", header: "Two", options: [{ label: "2a" }, { label: "2b" }] },
];

afterEach(() => cleanup());

describe("QuestionCard multi-question submit", () => {
  test("navigates to the first unanswered question instead of doing nothing", async () => {
    /**
     * The Submit button is enabled from the *current* question's answer, but
     * submitting needs every question answered, and the tab strip lets the user
     * jump straight to the last one. Previously the click was a silent no-op:
     * an enabled button, no error, and a turn left blocked forever.
     */
    const { onSubmit } = renderCard(TWO_QUESTIONS);

    fireEvent.click(screen.getByRole("button", { name: /Two/ }));
    fireEvent.click(screen.getByRole("button", { name: "2a" }));

    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText("One?")).toBeTruthy();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("submits every answer once nothing is missing", async () => {
    const { onSubmit } = renderCard(TWO_QUESTIONS);

    fireEvent.click(screen.getByRole("button", { name: "1b" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "2a" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith([["1b"], ["2a"]]);
    });
  });
});

describe("QuestionCard single-select exclusivity", () => {
  const QUESTION: QuestionCardQuestion[] = [
    { question: "Pick one?", options: [{ label: "Option A" }, { label: "Option B" }] },
  ];

  test("replaces the selected option with a custom answer when exclusive", async () => {
    /**
     * OpenCode's `multiple: false` means exactly one answer, so replying with
     * both an option and custom text contradicts the question it asked.
     */
    const { onSubmit } = renderCard(QUESTION, { exclusiveSingleSelect: true });

    fireEvent.click(screen.getByRole("button", { name: "Option A" }));
    const input = screen.getByPlaceholderText(/type your own/i);
    fireEvent.change(input, { target: { value: "my own answer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith([["my own answer"]]);
    });
  });

  test("keeps the option alongside a custom answer by default", async () => {
    // Claude's long-standing behaviour, unchanged.
    const { onSubmit } = renderCard(QUESTION);

    fireEvent.click(screen.getByRole("button", { name: "Option A" }));
    const input = screen.getByPlaceholderText(/type your own/i);
    fireEvent.change(input, { target: { value: "my own answer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith([["Option A", "my own answer"]]);
    });
  });

  test("does not smuggle a second answer through uncommitted draft text", async () => {
    // The user never pressed Enter, so the text is still a draft — but it is
    // included at submit so nothing typed is lost, and exclusivity must hold.
    const { onSubmit } = renderCard(QUESTION, { exclusiveSingleSelect: true });

    fireEvent.click(screen.getByRole("button", { name: "Option A" }));
    fireEvent.change(screen.getByPlaceholderText(/type your own/i), {
      target: { value: "typed but not entered" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith([["typed but not entered"]]);
    });
  });

  test("switching option replaces rather than accumulates when exclusive", async () => {
    const { onSubmit } = renderCard(QUESTION, { exclusiveSingleSelect: true });

    fireEvent.click(screen.getByRole("button", { name: "Option A" }));
    fireEvent.click(screen.getByRole("button", { name: "Option B" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith([["Option B"]]);
    });
  });
});

describe("QuestionCard option values", () => {
  test("submits option.value when it differs from the label", async () => {
    // The label is display text; the agent expects the value it supplied. A
    // regression to `label` here would be invisible in Claude's fixtures.
    const { onSubmit } = renderCard([
      {
        question: "Pick one?",
        options: [{ label: "Human readable", value: "machine-value" }],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Human readable" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith([["machine-value"]]);
    });
  });
});

describe("QuestionCard custom-answer overrides", () => {
  test("honours a per-question allowCustomAnswer override", () => {
    // OpenCode sets this from `info.custom !== false`, per question.
    renderCard(
      [
        { question: "No custom?", options: [{ label: "A" }], allowCustomAnswer: false },
      ],
      { allowCustomAnswer: true },
    );

    expect(screen.queryByPlaceholderText(/type your own/i)).toBeNull();
  });

  test("renders nothing when handed an empty question list", () => {
    const { container } = render(
      <QuestionCard
        agentLabel="Test"
        title="Agent needs your input"
        questions={[]}
        onSubmit={async () => true}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
