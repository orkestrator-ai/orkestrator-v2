import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  test("shows a countdown for a live request and removes actions after expiry", () => {
    const question = [{
      question: "Proceed?",
      options: [{ label: "Yes" }, { label: "No" }],
    }];

    const live = renderCard(question, { expiresAt: Date.now() + 65_000 });
    expect(screen.getByText("1:05")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
    cleanup();

    renderCard(question, { expiresAt: Date.now() - 1 });
    expect(screen.getByText("This request expired and was declined.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Yes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByPlaceholderText(
        "Type your own answer (press Enter to add)",
      ) as HTMLInputElement).disabled,
    ).toBe(true);
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
    expect(screen.queryByLabelText("Remove answer A")).toBeNull();

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
    expect(screen.queryByLabelText("Remove answer A")).toBeNull();

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
    expect(optionA.querySelector("div.rounded-full.bg-primary")).toBeNull();
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

  test("ignores the handler's return value and stays open for a retry", async () => {
    /**
     * The card never removes itself: each wrapper owns that (removePendingQuestion)
     * because the agent has to accept the reply first. `false` therefore means
     * nothing here beyond the caller's own bookkeeping.
     */
    const onSubmit = mock(async () => false);
    renderCard(QUESTION, { onSubmit });

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    const submit = await screen.findByRole("button", { name: "Submit" });
    expect(submit.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Continue?")).toBeTruthy();

    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith([["Yes"]]);
  });

  test("releases the card after a rejected submit", async () => {
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
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled"),
        ).toBe(false),
      );

      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
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
        screen.getByRole("button", { name: "Submitting..." }).hasAttribute("disabled"),
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

    expect(screen.queryByLabelText("Remove draft text")).toBeNull();
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

    expect(screen.queryByLabelText("Remove chip text")).toBeNull();
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
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
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
    expect(container.querySelector("svg.ml-auto.text-green-500")).toBeNull();

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
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });
});

describe("QuestionCard dismiss affordance", () => {
  test("hides the Dismiss button when asked to", () => {
    renderCard([{ question: "Continue?", options: [{ label: "Yes" }] }], {
      onDismiss: async () => {},
      hideDismiss: true,
    });
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  test("hides the Dismiss button when there is nothing to dismiss to", () => {
    // The build pipeline reuses this card with no dismiss path at all.
    renderCard([{ question: "Continue?", options: [{ label: "Yes" }] }]);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});

describe("QuestionCard dismiss recovery", () => {
  test("unlocks the card after a rejected dismiss so the user can retry", async () => {
    const onDismiss = mock(async () => {
      throw new Error("bridge unavailable");
    });
    renderCard([{ question: "Continue?", options: [{ label: "Yes" }] }], {
      onDismiss,
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dismiss" }).hasAttribute("disabled")).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(2));
  });
});
