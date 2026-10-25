import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClaudeQuestionCard } from "./ClaudeQuestionCard";
import type { ClaudeQuestionRequest } from "@/lib/claude-types";
import type { SubmitAnswersHandler } from "@/components/chat/QuestionCard";
import { usePromptDraftStore } from "@/stores/promptDraftStore";

const onSubmitAnswers = mock<SubmitAnswersHandler>(async () => true);

function submittedAnswers(): string[][] {
  return onSubmitAnswers.mock.calls[0]?.[0] as string[][];
}

function singleQuestionWithOptions(): ClaudeQuestionRequest {
  return {
    id: "q-1",
    sessionId: "s-1",
    questions: [
      {
        question: "Pick a color",
        header: "Color",
        options: [{ label: "Red" }, { label: "Blue" }],
        multiSelect: false,
      },
    ],
  };
}

function singleQuestionNoOptions(): ClaudeQuestionRequest {
  return {
    id: "q-2",
    sessionId: "s-1",
    questions: [
      {
        question: "Describe your preferred approach",
        header: "Approach",
        options: [],
        multiSelect: false,
      },
    ],
  };
}

function singleQuestionMultiSelect(): ClaudeQuestionRequest {
  return {
    id: "q-multi",
    sessionId: "s-1",
    questions: [
      {
        question: "Pick toppings",
        header: "Toppings",
        options: [{ label: "Cheese" }, { label: "Ham" }],
        multiSelect: true,
      },
    ],
  };
}

function twoQuestions(): ClaudeQuestionRequest {
  return {
    id: "q-3",
    sessionId: "s-1",
    questions: [
      {
        question: "Pick a color",
        header: "Color",
        options: [{ label: "Red" }, { label: "Blue" }],
        multiSelect: false,
      },
      {
        question: "Pick a number",
        header: "Number",
        options: [{ label: "One" }, { label: "Two" }],
        multiSelect: false,
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  onSubmitAnswers.mockReset();
  onSubmitAnswers.mockImplementation(async () => true);
  // Cards with a draft key persist drafts, and this suite reuses ids.
  usePromptDraftStore.getState().reset();
});

describe("ClaudeQuestionCard", () => {
  test("Submit button enables when only a custom answer is typed (no option selected)", () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Green" } });

    expect(submit.disabled).toBe(false);
  });

  test("Submit button enables for a no-options question when text is typed", () => {
    render(
      <ClaudeQuestionCard question={singleQuestionNoOptions()} onSubmitAnswers={onSubmitAnswers} />,
    );

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const input = screen.getByPlaceholderText(/Type your answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "my approach" } });

    expect(submit.disabled).toBe(false);
  });

  test("submits the typed custom answer even without pressing Enter", async () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Green" } });

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(onSubmitAnswers).toHaveBeenCalledTimes(1);
    expect(submittedAnswers()).toEqual([["Green"]]);
  });

  test("submits every answer of a multi-question card through the callback", async () => {
    render(<ClaudeQuestionCard question={twoQuestions()} onSubmitAnswers={onSubmitAnswers} />);

    fireEvent.click(screen.getByRole("button", { name: /Red/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: /Two/ }));

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(onSubmitAnswers).toHaveBeenCalledWith([["Red"], ["Two"]]);
  });

  test("treats false as a failed submit and re-enables the button", async () => {
    const onSubmitAnswers = mock(async () => false);

    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Green" } });

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(onSubmitAnswers).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(false);
  });

  test("initial answers can preselect an option without custom input and submit on re-click", async () => {
    const onSubmitAnswers = mock(async () => true);

    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        initialAnswers={[["Red"]]}
        allowCustomAnswer={false}
        allowOptionDeselect={false}
        submitOnOptionSelect
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    expect(screen.queryByPlaceholderText(/Type your own answer/i) === null).toBe(true);
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Red/ }));
    });

    expect(onSubmitAnswers).toHaveBeenCalledWith([["Red"]]);
  });

  test("submit-on-option-select treats false as a failed submit and re-enables controls", async () => {
    const onSubmitAnswers = mock(async () => false);

    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        allowCustomAnswer={false}
        submitOnOptionSelect
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Blue/ }));
    });

    expect(onSubmitAnswers).toHaveBeenCalledWith([["Blue"]]);
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("submit-on-option-select does not auto-submit multi-question cards", () => {
    const onSubmitAnswers = mock(async () => true);

    render(
      <ClaudeQuestionCard
        question={twoQuestions()}
        submitOnOptionSelect
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Red/ }));

    expect(onSubmitAnswers).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
  });

  test("custom typed answer persists when navigating between questions", () => {
    render(<ClaudeQuestionCard question={twoQuestions()} onSubmitAnswers={onSubmitAnswers} />);

    // On Q1: type a custom answer
    const inputQ1 = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(inputQ1, { target: { value: "Purple" } });
    expect(inputQ1.value).toBe("Purple");

    // Next button (multi-question) is labelled "Next"
    const nextBtn = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);
    fireEvent.click(nextBtn);

    // Now on Q2 — go Back
    const backBtn = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    fireEvent.click(backBtn);

    // The custom text from Q1 should still be in the input
    const inputQ1Again = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    expect(inputQ1Again.value).toBe("Purple");
  });

  test("Enter commits custom answer into a removable chip", () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Green" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Input should clear after commit
    expect(input.value).toBe("");

    // Committed chip should be visible
    expect(screen.getByLabelText("Remove Green")).toBeTruthy();

    // Submit button still enabled
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  test("clicking the chip's X removes the committed custom answer", async () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Green" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Sanity: chip is there, submit enabled
    const removeBtn = screen.getByLabelText("Remove Green");
    expect(removeBtn).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    // Remove the chip
    fireEvent.click(removeBtn);

    // Chip is gone, submit disabled again
    expect(screen.queryByLabelText("Remove Green") === null).toBe(true);
    expect(submit.disabled).toBe(true);
  });

  test("multi-select allows a chip and a selected option to coexist", async () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionMultiSelect()}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    // Pick an option
    fireEvent.click(screen.getByRole("button", { name: /Cheese/ }));
    // Add a custom chip via Enter
    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Pineapple" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Both the option and the chip should be present
    expect(screen.getByLabelText("Remove Pineapple")).toBeTruthy();

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(submittedAnswers()).toEqual([["Cheese", "Pineapple"]]);
  });

  test("single-select Enter replaces the previous custom chip (only one chip allowed)", async () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Green" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByLabelText("Remove Green")).toBeTruthy();

    fireEvent.change(input, { target: { value: "Purple" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Old chip replaced by new one
    expect(screen.queryByLabelText("Remove Green") === null).toBe(true);
    expect(screen.getByLabelText("Remove Purple")).toBeTruthy();

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(submittedAnswers()).toEqual([["Purple"]]);
  });

  test("single-select Enter keeps a selected option alongside the chip", async () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    // Select option first
    fireEvent.click(screen.getByRole("button", { name: /Red/ }));
    // Then add a custom chip
    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Magenta" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByLabelText("Remove Magenta")).toBeTruthy();

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    // Option preserved + chip appended
    expect(submittedAnswers()).toEqual([["Red", "Magenta"]]);
  });

  test("when the submit handler throws, the question stays pending and retry stays blocked", async () => {
    onSubmitAnswers.mockImplementation(async () => {
      throw new Error("network down");
    });
    // Silence the expected console.error
    const origError = console.error;
    console.error = () => {};

    try {
      render(
        <ClaudeQuestionCard
          question={singleQuestionWithOptions()}
          onSubmitAnswers={onSubmitAnswers}
        />,
      );

      const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Green" } });

      const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(submit);
      });

      // A thrown response has not been reconciled, so retry cannot be safe yet.
      expect(submit.disabled).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  test("an unknown answer outcome stays visible but blocks an unsafe retry", async () => {
    onSubmitAnswers.mockImplementationOnce(async () => ({
      applied: false,
      retryable: false,
      message: "The response outcome is unknown. Reconnect or refresh Claude before trying again.",
    }));
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(
      await screen.findByText(
        "The response outcome is unknown. Reconnect or refresh Claude before trying again.",
      ),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("dismiss disables the card and cannot be submitted twice while in flight", async () => {
    let resolveDismiss!: (value: boolean) => void;
    const onDismiss = mock(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDismiss = resolve;
        }),
    );
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
        onDismiss={onDismiss}
      />,
    );

    const dismissButton = screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement;
    fireEvent.click(dismissButton);
    expect(dismissButton.disabled).toBe(true);
    fireEvent.click(dismissButton);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDismiss(true);
    });
  });

  test("cards with a draft key persist in-progress answers across remounts", () => {
    // The tmux tab keys drafts by its pending request, so answers survive the
    // tab unmounting and its store knows which draft to clear on resolution.
    const { unmount } = render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
        draftKey="tmux-question-draft"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Type your own answer/i), {
      target: { value: "half-typed" },
    });
    expect(usePromptDraftStore.getState().drafts.has("tmux-question-draft")).toBe(true);

    unmount();
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
        draftKey="tmux-question-draft"
      />,
    );
    expect((screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement).value).toBe(
      "half-typed",
    );
  });

  test("a card without a draftKey does not write to the draft store", () => {
    // The tmux selection prompt reuses this wrapper with a content-derived
    // question id; persisting that would resurrect stale selections.
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Type your own answer/i), {
      target: { value: "ephemeral" },
    });
    expect(usePromptDraftStore.getState().drafts.size).toBe(0);
  });

  test("dismiss delegates to the callback when provided", async () => {
    const onDismiss = mock(() => {});

    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
        onDismiss={onDismiss}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("ClaudeQuestionCard countdown in terminal mode", () => {
  test("a prompt from a hook that predates pausing explains why it cannot pause", () => {
    render(
      <ClaudeQuestionCard
        question={{
          ...singleQuestionWithOptions(),
          expiresAt: Date.now() + 2 * 60_000,
          hold: { available: false, reason: "hook-outdated" },
        }}
        onSubmitAnswers={onSubmitAnswers}
      />,
    );
    expect(screen.queryByRole("button", { name: /countdown/ }) === null).toBe(true);
    const countdown = screen.getByLabelText(/^Time remaining \d:\d\d$/);
    expect(countdown.tabIndex).toBe(0);
    expect(document.getElementById(countdown.getAttribute("aria-describedby")!)?.textContent).toBe(
      "This prompt came from a terminal hook that predates pausing. Prompts after Claude restarts can be paused.",
    );
  });

  test("a pausable prompt pauses through the hook and reports a refusal", async () => {
    const onHold = mock(async (held: boolean) => ({
      result: held ? ("rejected" as const) : ("applied" as const),
      interactionId: "q-1",
      sessionId: "s-1",
      revision: 0,
    }));
    render(
      <ClaudeQuestionCard
        question={{
          ...singleQuestionWithOptions(),
          expiresAt: Date.now() + 2 * 60_000,
          hold: { available: true },
        }}
        onSubmitAnswers={onSubmitAnswers}
        onHold={onHold}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Pause countdown/ }));
    });
    expect(onHold).toHaveBeenCalledWith(true);
    expect(screen.getByRole("alert").textContent).toBe("This countdown can't be paused right now.");
  });

  test("a paused prompt offers to restart the countdown", async () => {
    const onHold = mock(async () => ({
      result: "applied" as const,
      interactionId: "q-1",
      sessionId: "s-1",
      revision: 0,
    }));
    const heldAt = Date.now();
    render(
      <ClaudeQuestionCard
        question={{
          ...singleQuestionWithOptions(),
          expiresAt: heldAt + 24 * 60 * 60_000,
          hold: { available: true, heldAt },
        }}
        onSubmitAnswers={onSubmitAnswers}
        onHold={onHold}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume countdown" }));
    });
    expect(onHold).toHaveBeenCalledWith(false);
  });
});
