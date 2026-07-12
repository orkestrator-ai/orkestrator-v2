import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// Snapshot the real modules BEFORE installing per-file stubs. Bun's mock.module
// is global at the module-cache level, so top-level mocks here would otherwise
// leak into unrelated suites (e.g. BuildChatTab needs useClaudeStore.setState,
// ClaudeComposeBar needs the real claude-client). See CLAUDE.md "Snapshot-and-
// restore pattern" for the rationale.
import * as realClaudeClient from "@/lib/claude-client";
import * as realClaudeStore from "@/stores/claudeStore";
const realClaudeClientSnapshot = { ...realClaudeClient };
const realClaudeStoreSnapshot = { ...realClaudeStore };

const mockAnswerQuestion = mock(async () => true);
mock.module("@/lib/claude-client", () => ({
  ...realClaudeClientSnapshot,
  answerQuestion: mockAnswerQuestion,
}));

const mockRemovePendingQuestion = mock(() => {});
mock.module("@/stores/claudeStore", () => ({
  ...realClaudeStoreSnapshot,
  useClaudeStore: () => ({ removePendingQuestion: mockRemovePendingQuestion }),
}));

afterAll(() => {
  mock.module("@/lib/claude-client", () => realClaudeClientSnapshot);
  mock.module("@/stores/claudeStore", () => realClaudeStoreSnapshot);
});

import { ClaudeQuestionCard } from "./ClaudeQuestionCard";
import type { ClaudeClient, ClaudeQuestionRequest } from "@/lib/claude-client";

const client = { baseUrl: "http://127.0.0.1:9999" } as ClaudeClient;

function singleQuestionWithOptions(): ClaudeQuestionRequest {
  return {
    id: "q-1",
    sessionId: "s-1",
    questions: [
      {
        question: "Pick a color",
        header: "Color",
        options: [
          { label: "Red" },
          { label: "Blue" },
        ],
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
  mockAnswerQuestion.mockClear();
  mockRemovePendingQuestion.mockClear();
});

describe("ClaudeQuestionCard", () => {
  test("Submit button enables when only a custom answer is typed (no option selected)", () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        client={client}
        sessionId="s-1"
      />
    );

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Green" } });

    expect(submit.disabled).toBe(false);
  });

  test("Submit button enables for a no-options question when text is typed", () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionNoOptions()}
        client={client}
        sessionId="s-1"
      />
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
        client={client}
        sessionId="s-1"
      />
    );

    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Green" } });

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(mockAnswerQuestion).toHaveBeenCalledTimes(1);
    const args = mockAnswerQuestion.mock.calls[0] as unknown as [unknown, unknown, unknown, string[][]];
    // args: (client, sessionId, questionId, answers)
    expect(args[3]).toEqual([["Green"]]);
  });

  test("submits through the callback mode without using the native client store path", async () => {
    const onSubmitAnswers = mock(async () => true);

    render(
      <ClaudeQuestionCard
        question={twoQuestions()}
        onSubmitAnswers={onSubmitAnswers}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Red/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: /Two/ }));

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(onSubmitAnswers).toHaveBeenCalledWith([["Red"], ["Two"]]);
    expect(mockAnswerQuestion).not.toHaveBeenCalled();
    expect(mockRemovePendingQuestion).not.toHaveBeenCalled();
  });

  test("callback mode treats false as a failed submit and re-enables the button", async () => {
    const onSubmitAnswers = mock(async () => false);

    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={onSubmitAnswers}
      />
    );

    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Green" } });

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(onSubmitAnswers).toHaveBeenCalledTimes(1);
    expect(mockRemovePendingQuestion).not.toHaveBeenCalled();
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
      />
    );

    expect(screen.queryByPlaceholderText(/Type your own answer/i)).toBeNull();
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(false);

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
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Blue/ }));
    });

    expect(onSubmitAnswers).toHaveBeenCalledWith([["Blue"]]);
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("submit-on-option-select does not auto-submit multi-question cards", () => {
    const onSubmitAnswers = mock(async () => true);

    render(
      <ClaudeQuestionCard
        question={twoQuestions()}
        submitOnOptionSelect
        onSubmitAnswers={onSubmitAnswers}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Red/ }));

    expect(onSubmitAnswers).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
  });

  test("custom typed answer persists when navigating between questions", () => {
    render(
      <ClaudeQuestionCard
        question={twoQuestions()}
        client={client}
        sessionId="s-1"
      />
    );

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
        client={client}
        sessionId="s-1"
      />
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
        client={client}
        sessionId="s-1"
      />
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
    expect(screen.queryByLabelText("Remove Green")).toBeNull();
    expect(submit.disabled).toBe(true);
  });

  test("multi-select allows a chip and a selected option to coexist", async () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionMultiSelect()}
        client={client}
        sessionId="s-1"
      />
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

    const args = mockAnswerQuestion.mock.calls[0] as unknown as [unknown, unknown, unknown, string[][]];
    expect(args[3]).toEqual([["Cheese", "Pineapple"]]);
  });

  test("single-select Enter replaces the previous custom chip (only one chip allowed)", async () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        client={client}
        sessionId="s-1"
      />
    );

    const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Green" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByLabelText("Remove Green")).toBeTruthy();

    fireEvent.change(input, { target: { value: "Purple" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Old chip replaced by new one
    expect(screen.queryByLabelText("Remove Green")).toBeNull();
    expect(screen.getByLabelText("Remove Purple")).toBeTruthy();

    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    const args = mockAnswerQuestion.mock.calls[0] as unknown as [unknown, unknown, unknown, string[][]];
    expect(args[3]).toEqual([["Purple"]]);
  });

  test("single-select Enter keeps a selected option alongside the chip", async () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        client={client}
        sessionId="s-1"
      />
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

    const args = mockAnswerQuestion.mock.calls[0] as unknown as [unknown, unknown, unknown, string[][]];
    // Option preserved + chip appended
    expect(args[3]).toEqual([["Red", "Magenta"]]);
  });

  test("when answerQuestion throws, the question stays pending and submit re-enables", async () => {
    const failure = mock(async () => {
      throw new Error("network down");
    });
    mockAnswerQuestion.mockImplementation(failure as never);
    // Silence the expected console.error
    const origError = console.error;
    console.error = () => {};

    try {
      render(
        <ClaudeQuestionCard
          question={singleQuestionWithOptions()}
          client={client}
          sessionId="s-1"
        />
      );

      const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Green" } });

      const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(submit);
      });

      // Question NOT removed on failure
      expect(mockRemovePendingQuestion).not.toHaveBeenCalled();
      // Submit button re-enabled
      expect(submit.disabled).toBe(false);
    } finally {
      console.error = origError;
      mockAnswerQuestion.mockImplementation(async () => true);
    }
  });

  test("when answerQuestion returns false, the question stays pending", async () => {
    mockAnswerQuestion.mockImplementation((async () => false) as never);

    try {
      render(
        <ClaudeQuestionCard
          question={singleQuestionWithOptions()}
          client={client}
          sessionId="s-1"
        />
      );

      const input = screen.getByPlaceholderText(/Type your own answer/i) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Green" } });

      const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(submit);
      });

      expect(mockAnswerQuestion).toHaveBeenCalledTimes(1);
      expect(mockRemovePendingQuestion).not.toHaveBeenCalled();
    } finally {
      mockAnswerQuestion.mockImplementation(async () => true);
    }
  });

  test("dismiss removes the native pending question by default", () => {
    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        client={client}
        sessionId="s-1"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(mockRemovePendingQuestion).toHaveBeenCalledWith("q-1");
  });

  test("dismiss delegates to the callback path when provided", () => {
    const onDismiss = mock(() => {});

    render(
      <ClaudeQuestionCard
        question={singleQuestionWithOptions()}
        onSubmitAnswers={mock(async () => true)}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mockRemovePendingQuestion).not.toHaveBeenCalled();
  });
});
