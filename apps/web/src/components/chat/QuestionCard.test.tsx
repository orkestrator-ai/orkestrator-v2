import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { usePromptDraftStore } from "@/stores/promptDraftStore";
import { mockToastError } from "../../../../../tests/mocks/sonner";
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

afterEach(() => {
  cleanup();
  // Drafts are keyed by request id and survive unmount by design, so tests
  // reusing an id would otherwise inherit the previous test's answers.
  usePromptDraftStore.getState().reset();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

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

describe("QuestionCard deadlines", () => {
  test("shows a countdown without trusting browser clock drift to remove actions", () => {
    const question = [{
      question: "Proceed?",
      options: [{ label: "Yes" }, { label: "No" }],
    }];

    const live = renderCard(question, { expiresAt: Date.now() + 65_000 });
    expect(screen.getByText("1:05")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
    cleanup();

    renderCard(question, { expiresAt: Date.now() - 1 });
    expect(screen.queryByText("This request expired and was declined.") === null).toBe(true);
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Yes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByPlaceholderText(
        "Type your own answer (press Enter to add)",
      ) as HTMLInputElement).disabled,
    ).toBe(false);
    expect(live.onSubmit).not.toHaveBeenCalled();
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

  test("deselects a selected option when deselection is allowed", () => {
    renderCard(QUESTION);

    const option = screen.getByRole("button", { name: "Option A" });
    fireEvent.click(option);
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(option);
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
  });

  test("keeps a selected option when deselection is disabled", async () => {
    const { onSubmit } = renderCard(QUESTION, { allowOptionDeselect: false });

    const option = screen.getByRole("button", { name: "Option A" });
    fireEvent.click(option);
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([["Option A"]]));
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

  test("keeps custom text distinct from the internal option identity", async () => {
    const sentinel = "__orkestrator_option__:0:opt";
    const { onSubmit } = renderCard([
      {
        question: "Pick or type?",
        options: [{ id: "opt", label: "Option", value: "provider-option" }],
      },
    ]);

    const input = screen.getByPlaceholderText(/type your own/i);
    fireEvent.change(input, { target: { value: sentinel } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([[sentinel]]));
  });

  test("tokenizes duplicate initial option values once each and preserves custom values", async () => {
    const { onSubmit } = renderCard(
      [{
        question: "Restore answers?",
        multiSelect: true,
        options: [
          { id: "first", label: "First", value: "same" },
          { id: "second", label: "Second", value: "same" },
        ],
      }],
      { initialAnswers: [["same", "same", "custom"]] },
    );

    expect(screen.getByRole("button", { name: "First" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("button", { name: "Second" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByLabelText("Remove custom")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([["same", "same", "custom"]]));
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

    expect(screen.queryByPlaceholderText(/type your own/i) === null).toBe(true);
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

  test("ignores blank custom answers", () => {
    renderCard([{ question: "Answer?", options: [] }]);
    const input = screen.getByPlaceholderText("Type your answer");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
    expect((input as HTMLInputElement).value).toBe("   ");
  });

  test("does not add a duplicate custom-answer chip", async () => {
    const { onSubmit } = renderCard([
      { question: "Answer?", options: [], multiSelect: true },
    ]);
    const input = screen.getByPlaceholderText("Type your answer");

    fireEvent.change(input, { target: { value: "same answer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "same answer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([["same answer"]]));
    expect(screen.getAllByText("same answer")).toHaveLength(1);
  });
});

describe("QuestionCard exclusive draft supersedes the committed answer", () => {
  const QUESTION: QuestionCardQuestion[] = [
    { question: "Pick one?", options: [{ label: "Option A" }, { label: "Option B" }] },
  ];

  test("clears the committed chip once a new draft replaces it", async () => {
    /**
     * Exclusive mode submits the draft alone, so a chip left on screen with a
     * check mark and "will be included when you submit" was describing an
     * answer that was about to be silently dropped.
     */
    const { onSubmit } = renderCard(QUESTION, { exclusiveSingleSelect: true });
    const input = screen.getByPlaceholderText(/type your own/i);

    fireEvent.change(input, { target: { value: "answer A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByLabelText("Remove answer A")).toBeTruthy();

    fireEvent.change(input, { target: { value: "ans" } });
    expect(screen.queryByLabelText("Remove answer A") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([["ans"]]));
  });

  test("restores the superseded chip when the draft is erased", () => {
    // Superseding is a rendering rule, not a deletion: nothing the user
    // committed is destroyed by typing.
    renderCard(QUESTION, { exclusiveSingleSelect: true });
    const input = screen.getByPlaceholderText(/type your own/i);

    fireEvent.change(input, { target: { value: "answer A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "ans" } });
    expect(screen.queryByLabelText("Remove answer A") === null).toBe(true);

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByLabelText("Remove answer A")).toBeTruthy();
  });

  test("clears the selected option's check mark while a draft is pending", () => {
    renderCard(QUESTION, { exclusiveSingleSelect: true });

    const optionA = screen.getByRole("button", { name: "Option A" });
    fireEvent.click(optionA);
    expect(optionA.querySelector("div.rounded-full.bg-primary")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/type your own/i), {
      target: { value: "something else" },
    });
    expect(optionA.querySelector("div.rounded-full.bg-primary") === null).toBe(true);
  });

  test("picking an option while a draft is pending selects it and drops the draft", async () => {
    const { onSubmit } = renderCard(QUESTION, { exclusiveSingleSelect: true });
    const input = screen.getByPlaceholderText(/type your own/i);

    fireEvent.click(screen.getByRole("button", { name: "Option A" }));
    fireEvent.change(input, { target: { value: "typed instead" } });
    // Drawn as unselected, so this click must select rather than deselect.
    fireEvent.click(screen.getByRole("button", { name: "Option B" }));

    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([["Option B"]]));
  });

  test("leaves the non-exclusive card's chip alone while typing", () => {
    // Claude keeps a committed chip alongside whatever comes next, so nothing
    // is superseded and the chip must stay visible.
    renderCard(QUESTION);
    const input = screen.getByPlaceholderText(/type your own/i);

    fireEvent.change(input, { target: { value: "answer A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "answer B" } });

    expect(screen.getByLabelText("Remove answer A")).toBeTruthy();
  });
});

describe("QuestionCard submit contract", () => {
  const QUESTION: QuestionCardQuestion[] = [
    { question: "Continue?", options: [{ label: "Yes" }] },
  ];

  test("shows a failure toast and stays open for a retry when submit returns false", async () => {
    /**
     * The card never removes itself: each wrapper owns that (removePendingQuestion)
     * because the agent has to accept the reply first. `false` keeps it open
     * and now also reports that the response did not land.
     */
    const onSubmit = mock(async () => false);
    renderCard(QUESTION, { onSubmit });

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to send your answer",
      {
        description: "Test is still waiting for a response. Please try again.",
      },
    );

    const submit = await screen.findByRole("button", { name: "Submit" });
    expect(submit.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Continue?")).toBeTruthy();

    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith([["Yes"]]);
  });

  test("shows a failure toast and leaves dismiss retryable when dismiss returns false", async () => {
    const onDismiss = mock(async () => false);
    renderCard(QUESTION, { onDismiss });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to dismiss this question",
      {
        description: "Test is still waiting for a response. Please try again.",
      },
    );
    expect(screen.getByRole("button", { name: "Dismiss" }).hasAttribute("disabled"))
      .toBe(false);
  });

  test("blocks retry after an unreconciled submit exception", async () => {
    const onSubmit = mock(async () => {
      throw new Error("bridge down");
    });
    const consoleError = console.error;
    const errorSpy = mock(() => {});
    console.error = errorSpy;

    try {
      renderCard(QUESTION, { onSubmit });

      fireEvent.click(screen.getByRole("button", { name: "Yes" }));
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));

      await waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(
        "The response outcome is unknown. Reconnect or refresh Test to verify whether it was received.",
      );
      expect(alert.textContent).not.toMatch(/try again/i);
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to send your answer",
        {
          description:
            "The response outcome is unknown. Reconnect or refresh Test to verify whether it was received.",
        },
      );
      expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
      expect(onSubmit).toHaveBeenCalledTimes(1);
    } finally {
      console.error = consoleError;
    }
  });

  test("disables the options and the custom input while submitting", async () => {
    const pending = deferred<boolean>();
    const onSubmit = mock(() => pending.promise);
    renderCard(QUESTION, { onSubmit, onDismiss: async () => {} });

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Yes" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByPlaceholderText(/type your own/i).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Dismiss" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });

    expect(screen.getByRole("button", { name: "Yes" }).hasAttribute("disabled")).toBe(false);
  });

  test("uses structured submit errors and blocks an explicitly unsafe retry", async () => {
    const onSubmit = mock(() => ({
      applied: false,
      retryable: false,
      message: "The outcome could not be reconciled.",
    }));
    renderCard(QUESTION, { onSubmit });

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent)
      .toContain("The outcome could not be reconciled."));
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to send your answer",
      { description: "The outcome could not be reconciled." },
    );
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith([["Yes"]]);
  });

  test("leaves a structured retryable submit failure actionable", async () => {
    const onSubmit = mock(() => ({
      applied: false,
      retryable: true,
      message: "Try this response again.",
    }));
    renderCard(QUESTION, { onSubmit });

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent)
      .toContain("Try this response again."));
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);
  });

  test("supports synchronous successful submit and failed dismiss handlers", async () => {
    const onSubmit = mock(() => true);
    const onDismiss = mock(() => false);
    renderCard(QUESTION, { onSubmit, onDismiss });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([["Yes"]]));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("QuestionCard option-select submission", () => {
  test("submits a single option immediately with its provider value", async () => {
    const onSubmit = mock(() => true);
    renderCard(
      [{ question: "Continue?", options: [{ label: "Yes", value: "accept" }] }],
      { onSubmit, submitOnOptionSelect: true },
    );

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([["accept"]]));
  });

  test("does not auto-submit one question inside a multi-question wizard", () => {
    const onSubmit = mock(() => true);
    renderCard(TWO_QUESTIONS, { onSubmit, submitOnOptionSelect: true });

    fireEvent.click(screen.getByRole("button", { name: "1a" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("QuestionCard multi-select", () => {
  test("removes an option that is clicked a second time", async () => {
    const { onSubmit } = renderCard([
      {
        question: "Pick many?",
        multiSelect: true,
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    fireEvent.click(screen.getByRole("button", { name: "C" }));
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([["A", "C"]]));
  });

  test("labels the question as multi-select", () => {
    renderCard([
      { question: "Pick many?", multiSelect: true, options: [{ label: "A" }] },
    ]);
    expect(screen.getByText("(select all that apply)")).toBeTruthy();
  });
});

describe("QuestionCard custom input keyboard handling", () => {
  test("does not commit the draft on Shift+Enter", async () => {
    // Shift+Enter is a newline everywhere else in the composer; committing here
    // would make the same chord mean two different things.
    const { onSubmit } = renderCard([{ question: "Answer?", options: [] }]);
    const input = screen.getByPlaceholderText("Type your answer");

    fireEvent.change(input, { target: { value: "draft text" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(screen.queryByLabelText("Remove draft text") === null).toBe(true);
    expect((input as HTMLInputElement).value).toBe("draft text");

    // Still submitted, because an uncommitted draft is never lost.
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([["draft text"]]));
  });

  test("removes a committed chip through its remove button", () => {
    renderCard([{ question: "Answer?", options: [], multiSelect: true }]);
    const input = screen.getByPlaceholderText("Type your answer");

    fireEvent.change(input, { target: { value: "chip text" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByLabelText("Remove chip text"));

    expect(screen.queryByLabelText("Remove chip text") === null).toBe(true);
    expect(
      screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("QuestionCard multi-question navigation", () => {
  test("steps back to the previous question with its answer intact", async () => {
    const { onSubmit } = renderCard(TWO_QUESTIONS);

    fireEvent.click(screen.getByRole("button", { name: "1b" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Two?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("One?")).toBeTruthy();

    // Answer preserved: switching selection here proves the card round-tripped.
    fireEvent.click(screen.getByRole("button", { name: "1a" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "2b" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([["1a"], ["2b"]]));
  });

  test("offers no Back button on the first question", () => {
    renderCard(TWO_QUESTIONS);
    expect(screen.queryByRole("button", { name: "Back" }) === null).toBe(true);
  });

  test("tracks the answered count and flags a complete card", () => {
    const { container } = render(
      <QuestionCard
        agentLabel="Test"
        title="Agent needs your input"
        questions={TWO_QUESTIONS}
        onSubmit={async () => true}
      />,
    );

    expect(screen.getByText("0/2 answered")).toBeTruthy();
    expect(container.querySelector("svg.ml-auto.text-green-500") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "1b" }));
    expect(screen.getByText("1/2 answered")).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "2a" }));
    expect(screen.getByText("2/2 answered")).toBeTruthy();
    expect(container.querySelector("svg.ml-auto.text-green-500")).toBeTruthy();
    expect(screen.getByText("2 of 2")).toBeTruthy();
  });

  test("counts a single question without a progress fraction", () => {
    renderCard([{ question: "Only?", options: [{ label: "Yes" }] }]);
    expect(screen.getByText("1 question")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" }) === null).toBe(true);
  });

  test("falls back to the first question when a persisted index is out of range", () => {
    const draftKey = "test-question:out-of-range";
    usePromptDraftStore.getState().setDraftValue(draftKey, "currentQuestionIndex", 99);

    renderCard(TWO_QUESTIONS, { draftKey });

    expect(screen.getByText("One?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1a" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Two?")).toBeTruthy();
  });

  test("keeps answers attached to stable question ids when questions reorder", () => {
    const draftKey = "test-question:reorder";
    const firstOrder: QuestionCardQuestion[] = [
      { id: "one", question: "One?", header: "One", options: [{ label: "1a" }] },
      { id: "two", question: "Two?", header: "Two", options: [{ label: "2a" }] },
    ];
    const secondOrder = [firstOrder[1]!, firstOrder[0]!];
    const rendered = render(
      <QuestionCard
        agentLabel="Test"
        title="Agent needs your input"
        questions={firstOrder}
        onSubmit={() => true}
        draftKey={draftKey}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "1a" }));

    rendered.rerender(
      <QuestionCard
        agentLabel="Test"
        title="Agent needs your input"
        questions={secondOrder}
        onSubmit={() => true}
        draftKey={draftKey}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /One/ }));

    expect(screen.getByRole("button", { name: "1a" }).getAttribute("aria-pressed"))
      .toBe("true");
  });
});

describe("QuestionCard dismiss affordance", () => {
  test("hides the Dismiss button when asked to", () => {
    renderCard([{ question: "Continue?", options: [{ label: "Yes" }] }], {
      onDismiss: async () => {},
      hideDismiss: true,
    });
    expect(screen.queryByRole("button", { name: "Dismiss" }) === null).toBe(true);
  });

  test("hides the Dismiss button when there is nothing to dismiss to", () => {
    // The build pipeline reuses this card with no dismiss path at all.
    renderCard([{ question: "Continue?", options: [{ label: "Yes" }] }]);
    expect(screen.queryByRole("button", { name: "Dismiss" }) === null).toBe(true);
  });

  test("uses custom action labels and input placeholder copy", () => {
    renderCard([{ question: "Continue?", options: [] }], {
      onDismiss: () => true,
      dismissLabel: "Cancel request",
      customAnswerPlaceholder: "Enter a precise response",
    });

    expect(screen.getByRole("button", { name: "Cancel request" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Enter a precise response")).toBeTruthy();
  });

  test("renders a structured dismiss error and blocks unsafe retry", async () => {
    const onDismiss = mock(() => ({
      applied: false,
      retryable: false,
      message: "Dismissal outcome is unknown.",
    }));
    renderCard([{ question: "Continue?", options: [{ label: "Yes" }] }], { onDismiss });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent)
      .toContain("Dismissal outcome is unknown."));
    expect(screen.getByRole("button", { name: "Dismiss" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("QuestionCard draft persistence", () => {
  const DRAFT_KEY = "test-question:req-1";

  test("in-progress answers survive unmount and remount under the same draftKey", () => {
    /**
     * The card lives in a chat tab that unmounts when the user switches
     * environments; the pending request rehydrates, so half-entered answers
     * must too. This is the whole point of the prompt-draft store.
     */
    const { unmount } = render(
      <QuestionCard
        agentLabel="Test"
        title="Agent needs your input"
        questions={TWO_QUESTIONS}
        onSubmit={async () => true}
        draftKey={DRAFT_KEY}
      />,
    );

    // Answer question one, type an uncommitted draft on question two.
    fireEvent.click(screen.getByRole("button", { name: "1b" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByPlaceholderText(/type your own/i), {
      target: { value: "half-typed answer" },
    });

    unmount();

    render(
      <QuestionCard
        agentLabel="Test"
        title="Agent needs your input"
        questions={TWO_QUESTIONS}
        onSubmit={async () => true}
        draftKey={DRAFT_KEY}
      />,
    );

    // Remounted on the question the user was answering, with the typed draft
    // and the earlier selection intact.
    expect(screen.getByText("Two?")).toBeTruthy();
    expect(
      (screen.getByPlaceholderText(/type your own/i) as HTMLInputElement).value,
    ).toBe("half-typed answer");
    expect(screen.getByText("2/2 answered")).toBeTruthy();
  });

  test("clearing the draft key resets a remounted card", () => {
    // This is what the owning store does when the request resolves; a future
    // request reusing the id must start blank.
    const { unmount } = render(
      <QuestionCard
        agentLabel="Test"
        title="Agent needs your input"
        questions={TWO_QUESTIONS}
        onSubmit={async () => true}
        draftKey={DRAFT_KEY}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "1b" }));
    unmount();

    usePromptDraftStore.getState().clearDraft(DRAFT_KEY);

    render(
      <QuestionCard
        agentLabel="Test"
        title="Agent needs your input"
        questions={TWO_QUESTIONS}
        onSubmit={async () => true}
        draftKey={DRAFT_KEY}
      />,
    );
    expect(screen.getByText("0/2 answered")).toBeTruthy();
  });

  test("without a draftKey the card keeps plain component state", () => {
    // Callers without a durable pending request (e.g. the tmux TUI selection
    // prompt) must not write into the shared draft store.
    render(
      <QuestionCard
        agentLabel="Test"
        title="Agent needs your input"
        questions={TWO_QUESTIONS}
        onSubmit={async () => true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "1b" }));
    expect(usePromptDraftStore.getState().drafts.size).toBe(0);
  });
});

describe("QuestionCard secret handling", () => {
  test("submits a secret without retaining it and loses it on unmount", async () => {
    const questions: QuestionCardQuestion[] = [
      { id: "token", question: "Token?", secret: true, allowCustomAnswer: true },
    ];
    const onSubmit = mock(async () => false);
    const first = render(
      <QuestionCard
        agentLabel="Test"
        title="Secret required"
        questions={questions}
        onSubmit={onSubmit}
        draftKey="provider:session:request:token"
      />,
    );

    const input = screen.getByPlaceholderText("Type your answer") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "not-for-the-store" } });
    expect(usePromptDraftStore.getState().drafts.has("provider:session:request:token"))
      .toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([["not-for-the-store"]]));

    first.unmount();
    renderCard(questions, { draftKey: "provider:session:request:token" });
    expect((screen.getByPlaceholderText("Type your answer") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/lost if you leave it/i)).toBeTruthy();
  });

  test("never renders a committed secret value or puts it in an accessible label", async () => {
    const secret = "highly-distinct-secret-value";
    const onSubmit = mock(() => true);
    const rendered = render(
      <QuestionCard
        agentLabel="Test"
        title="Secret required"
        questions={[{ id: "token", question: "Token?", secret: true }]}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByPlaceholderText("Type your answer");

    fireEvent.change(input, { target: { value: secret } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(rendered.container.textContent).not.toContain(secret);
    expect(screen.getByText("Secret entered")).toBeTruthy();
    expect(screen.getByLabelText("Remove secret answer")).toBeTruthy();
    expect(screen.queryByLabelText(`Remove ${secret}`) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([[secret]]));
  });

  test("keeps secret option and initial answers local across wizard navigation", async () => {
    const draftKey = "test-question:secret-wizard";
    const questions: QuestionCardQuestion[] = [
      {
        id: "secret",
        question: "Choose secret?",
        header: "Secret",
        secret: true,
        multiSelect: true,
        options: [
          { id: "one", label: "Secret option one", value: "secret-one" },
          { id: "two", label: "Secret option two", value: "secret-two" },
        ],
      },
      { id: "plain", question: "Continue?", header: "Plain", options: [{ label: "Yes" }] },
    ];
    const onSubmit = mock(() => true);
    renderCard(questions, { draftKey, initialAnswers: [["secret-one"], []], onSubmit });

    expect(screen.getByRole("button", { name: "Secret option one" }).getAttribute("aria-pressed"))
      .toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Secret option two" }));
    expect(usePromptDraftStore.getState().drafts.get(draftKey)?.answersByQuestion)
      .toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Secret option two" }).getAttribute("aria-pressed"))
      .toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([
      ["secret-one", "secret-two"],
      ["Yes"],
    ]));
  });
});

describe("QuestionCard dismiss recovery", () => {
  test("blocks retry after an unreconciled dismiss exception", async () => {
    const onDismiss = mock(async () => {
      throw new Error("bridge unavailable");
    });
    renderCard([{ question: "Continue?", options: [{ label: "Yes" }] }], {
      onDismiss,
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Dismiss" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
