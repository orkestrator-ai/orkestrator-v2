import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  isAgentInteractionResolution,
  type AgentInteractionApplyOutcome,
  type AgentInteractionQuestion,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import { NativeAgentQuestionCard } from "./NativeAgentQuestionCard";
import { usePromptDraftStore } from "@/stores/promptDraftStore";

afterEach(() => {
  cleanup();
  usePromptDraftStore.getState().reset();
});

function question(
  overrides: Partial<AgentInteractionQuestion> & { id: string },
): AgentInteractionQuestion {
  return {
    prompt: "Which approach?",
    required: true,
    multiple: false,
    secret: false,
    allowFreeText: true,
    options: [],
    ...overrides,
  };
}

function request(questions: AgentInteractionQuestion[]): AgentInteractionRequest {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id: "interaction-1",
    provider: "claude",
    kind: "question",
    origin: "interactive-native",
    sessionId: "session-1",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    presentation: { title: "Claude needs input", questions },
  };
}

function applied(): AgentInteractionApplyOutcome {
  return {
    result: "applied",
    interactionId: "interaction-1",
    sessionId: "session-1",
    revision: 2,
  };
}

const TWO_OPTIONS = [
  { id: "o0", label: "TypeScript", providerValue: "TypeScript" },
  { id: "o1", label: "Rust", providerValue: "Rust" },
];

describe("NativeAgentQuestionCard", () => {
  test("shows an option's preview verbatim as monospace text", () => {
    const preview = "<b>not html</b>\n  ├─ src/\n  └─ **not markdown**";
    render(
      <NativeAgentQuestionCard
        interaction={request([
          question({
            id: "q0",
            options: [{ ...TWO_OPTIONS[0]!, preview }, TWO_OPTIONS[1]!],
          }),
        ])}
        onResolve={async () => applied()}
      />,
    );

    const previews = screen.getAllByTestId("question-option-preview");
    expect(previews).toHaveLength(1);
    expect(previews[0]!.textContent).toBe(preview);
    expect(previews[0]!.querySelector("b") === null).toBe(true);
  });

  test("hides the free-text field until the user picks Something else", () => {
    render(
      <NativeAgentQuestionCard
        interaction={request([question({ id: "q0", options: TWO_OPTIONS })])}
        onResolve={async () => applied()}
      />,
    );

    expect(screen.queryByLabelText("Which approach? response") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Something else" }));

    expect(screen.getByLabelText("Which approach? response")).toBeTruthy();
  });

  test("shows the free-text field immediately when there are no options", () => {
    render(
      <NativeAgentQuestionCard
        interaction={request([question({ id: "q0" })])}
        onResolve={async () => applied()}
      />,
    );

    expect(screen.getByLabelText("Which approach? response")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Something else" }) === null).toBe(true);
  });

  test("keeps a single-choice option and a custom answer mutually exclusive", async () => {
    const onResolve = mock(async (_resolution: AgentInteractionResolution) => applied());
    render(
      <NativeAgentQuestionCard
        interaction={request([question({ id: "q0", options: TWO_OPTIONS })])}
        onResolve={onResolve}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "TypeScript" }));
    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    fireEvent.change(screen.getByLabelText("Which approach? response"), {
      target: { value: "Zig" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0].answer?.answers).toEqual([
      { questionId: "q0", freeText: "Zig" },
    ]);
  });

  test("closing Something else discards the text it was holding", () => {
    render(
      <NativeAgentQuestionCard
        interaction={request([question({ id: "q0", options: TWO_OPTIONS })])}
        onResolve={async () => applied()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    fireEvent.change(screen.getByLabelText("Which approach? response"), {
      target: { value: "Zig" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    fireEvent.click(screen.getByRole("button", { name: "Something else" }));

    expect((screen.getByLabelText("Which approach? response") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  test("keeps a custom answer alongside options in a multi-select question", async () => {
    const onResolve = mock(async (_resolution: AgentInteractionResolution) => applied());
    render(
      <NativeAgentQuestionCard
        interaction={request([question({ id: "q0", multiple: true, options: TWO_OPTIONS })])}
        onResolve={onResolve}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "TypeScript" }));
    fireEvent.click(screen.getByRole("button", { name: "Rust" }));
    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    fireEvent.change(screen.getByLabelText("Which approach? response"), {
      target: { value: "Zig" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0].answer?.answers).toEqual([
      { questionId: "q0", optionIds: ["o0", "o1"], freeText: "Zig" },
    ]);
  });

  test("shows one question at a time and navigates with the tab strip", async () => {
    const onResolve = mock(async (_resolution: AgentInteractionResolution) => applied());
    render(
      <NativeAgentQuestionCard
        interaction={request([
          question({
            id: "q0",
            prompt: "Which language?",
            description: "Language",
            options: TWO_OPTIONS,
          }),
          question({
            id: "q1",
            prompt: "Which runtime?",
            description: "Runtime",
            options: [{ id: "o0", label: "Bun", providerValue: "Bun" }],
          }),
        ])}
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Which language?")).toBeTruthy();
    expect(screen.queryByText("Which runtime?") === null).toBe(true);
    // The last question owns Submit, so an unseen question cannot be skipped.
    expect(screen.queryByRole("button", { name: "Submit" }) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "TypeScript" }));
    fireEvent.click(screen.getByRole("tab", { name: /Runtime/ }));

    expect(screen.getByText("Which runtime?")).toBeTruthy();
    expect(screen.queryByText("Which language?") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Bun" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0].answer?.answers).toEqual([
      { questionId: "q0", optionIds: ["o0"] },
      { questionId: "q1", optionIds: ["o0"] },
    ]);
  });

  test("refuses to submit while a required question is unanswered", () => {
    render(
      <NativeAgentQuestionCard
        interaction={request([
          question({ id: "q0", options: TWO_OPTIONS }),
          question({ id: "q1", prompt: "Which runtime?", options: TWO_OPTIONS }),
        ])}
        onResolve={async () => applied()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "TypeScript" }));
    // Answering the visible question is not enough; the first one is still open.
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    fireEvent.click(screen.getByRole("button", { name: "Rust" }));
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("keeps a secret answer live-only and discards it across unmount", async () => {
    const onResolve = mock(async (_resolution: AgentInteractionResolution) => applied());
    const interaction = request([question({ id: "q0", prompt: "Access token", secret: true })]);
    const view = render(
      <NativeAgentQuestionCard interaction={interaction} onResolve={onResolve} />,
    );

    const input = screen.getByLabelText("Access token response") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    expect(screen.getByText(/discarded when you leave this tab/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "discard-me" } });
    expect(usePromptDraftStore.getState().drafts.size).toBe(0);

    view.unmount();
    render(<NativeAgentQuestionCard interaction={interaction} onResolve={onResolve} />);
    expect((screen.getByLabelText("Access token response") as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByLabelText("Access token response"), {
      target: { value: "send-live" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0].answer?.answers).toEqual([
      { questionId: "q0", freeText: "send-live" },
    ]);
    expect(usePromptDraftStore.getState().drafts.size).toBe(0);
  });

  test("omits an unanswered optional question from the resolution", async () => {
    const interaction = request([
      question({ id: "q0", prompt: "Which language?", options: TWO_OPTIONS }),
      question({ id: "q1", prompt: "Any notes?", required: false }),
    ]);
    const onResolve = mock(async (_resolution: AgentInteractionResolution) => applied());
    render(<NativeAgentQuestionCard interaction={interaction} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole("button", { name: "TypeScript" }));
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    const resolution = onResolve.mock.calls[0]?.[0];
    expect(resolution?.answer?.answers).toEqual([{ questionId: "q0", optionIds: ["o0"] }]);
    expect(isAgentInteractionResolution(resolution, interaction)).toBe(true);
  });

  test("keeps the card retryable when the provider is unavailable", async () => {
    const onResolve = mock(async (_resolution: AgentInteractionResolution) => ({
      result: "provider-unavailable" as const,
      interactionId: "interaction-1",
      sessionId: "session-1",
      revision: 1,
    }));
    render(
      <NativeAgentQuestionCard
        interaction={request([question({ id: "q0", options: TWO_OPTIONS })])}
        onResolve={onResolve}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "TypeScript" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("safe to retry");
    // The selection survives, so the same answer can simply be sent again.
    expect(screen.getByRole("button", { name: "TypeScript" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  test("restores the answer and the open question from the draft store", () => {
    const questions = [
      question({ id: "q0", description: "Language", options: TWO_OPTIONS }),
      question({
        id: "q1",
        prompt: "Which runtime?",
        description: "Runtime",
        options: TWO_OPTIONS,
      }),
    ];
    const { unmount } = render(
      <NativeAgentQuestionCard
        interaction={request(questions)}
        onResolve={async () => applied()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /Runtime/ }));
    fireEvent.click(screen.getByRole("button", { name: "Rust" }));
    unmount();

    render(
      <NativeAgentQuestionCard
        interaction={request(questions)}
        onResolve={async () => applied()}
      />,
    );

    expect(screen.getByText("Which runtime?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rust" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("declines the question through the dismiss action", async () => {
    const onResolve = mock(async (_resolution: AgentInteractionResolution) => applied());
    render(
      <NativeAgentQuestionCard
        interaction={request([question({ id: "q0", options: TWO_OPTIONS })])}
        onResolve={onResolve}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0]?.[0].action).toBe("deny");
    expect(onResolve.mock.calls[0]?.[0].answer).toBeUndefined();
  });
});

describe("NativeAgentQuestionCard countdown pause", () => {
  const CEILING = 24 * 60 * 60_000;

  function timed(hold: AgentInteractionRequest["hold"], expiresAt = Date.now() + 4 * 60_000) {
    return {
      ...request([question({ id: "q0", options: TWO_OPTIONS })]),
      expiresAt,
      hold,
    };
  }

  function outcome(result: AgentInteractionApplyOutcome["result"]): AgentInteractionApplyOutcome {
    return { ...applied(), result };
  }

  test("a paused question shows Paused when it mounts, as it does after a reload", () => {
    const heldAt = Date.now();
    render(
      <NativeAgentQuestionCard
        interaction={timed({ available: true, heldAt }, heldAt + CEILING)}
        onResolve={async () => applied()}
        onHold={async () => applied()}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Resume countdown" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toBe("Paused");
  });

  test("clicking the countdown asks the agent to pause, then shows the paused state", async () => {
    let finish!: (value: AgentInteractionApplyOutcome) => void;
    const onHold = mock(
      (_held: boolean) =>
        new Promise<AgentInteractionApplyOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(
      <NativeAgentQuestionCard
        interaction={timed({ available: true })}
        onResolve={async () => applied()}
        onHold={onHold}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Pause countdown, \d:\d\d left$/ }));
    expect(onHold).toHaveBeenCalledWith(true);
    // Shown as paused while the request is on its way, but not clickable twice.
    const pending = screen.getByRole("button", { name: "Resume countdown" }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);

    const heldAt = Date.now();
    rerender(
      <NativeAgentQuestionCard
        interaction={timed({ available: true, heldAt }, heldAt + CEILING)}
        onResolve={async () => applied()}
        onHold={onHold}
      />,
    );
    finish(applied());
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Resume countdown" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: "Resume countdown" }));
    expect(onHold).toHaveBeenLastCalledWith(false);
  });

  test("a refused pause says so and leaves the countdown running", async () => {
    render(
      <NativeAgentQuestionCard
        interaction={timed({ available: true })}
        onResolve={async () => applied()}
        onHold={async () => outcome("rejected")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Pause countdown/ }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "This countdown can't be paused right now.",
    );
    expect(screen.getByRole("button", { name: /^Pause countdown/ })).toBeTruthy();
  });

  test("a request that went away meanwhile is not reported as an error", async () => {
    const onHold = mock(async () => outcome("stale"));
    render(
      <NativeAgentQuestionCard
        interaction={timed({ available: true })}
        onResolve={async () => applied()}
        onHold={onHold}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Pause countdown/ }));
    await waitFor(() => expect(onHold).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alert") === null).toBe(true));
  });

  test("a countdown from an older bridge cannot be clicked, and says why", () => {
    render(
      <NativeAgentQuestionCard
        interaction={timed({ available: false, reason: "bridge-outdated" })}
        onResolve={async () => applied()}
        onHold={async () => applied()}
      />,
    );
    expect(screen.queryByRole("button", { name: /countdown/ }) === null).toBe(true);
    expect(screen.getByText(/Restart this environment to update it\./)).toBeTruthy();
  });
});
