import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import {
  openCodeQuestionDraftKey,
  usePromptDraftStore,
} from "@/stores/promptDraftStore";
import type {
  OpenCodeInteractionResponseResult,
  OpencodeClient,
  QuestionRequest,
} from "@/lib/opencode-client";
import { mockToastError } from "../../../../../tests/mocks/sonner";

import * as realOpenCodeClient from "@/lib/opencode-client";
const realOpenCodeClientSnapshot = { ...realOpenCodeClient };

const replyMock = mock(async (): Promise<OpenCodeInteractionResponseResult> => "applied");
const rejectMock = mock(async (): Promise<OpenCodeInteractionResponseResult> => "applied");

mock.module("@/lib/opencode-client", () => ({
  ...realOpenCodeClientSnapshot,
  replyToQuestion: replyMock,
  rejectQuestion: rejectMock,
}));

afterAll(() => {
  mock.module("@/lib/opencode-client", () => realOpenCodeClientSnapshot);
});

const { OpenCodeQuestionCard } = await import("./OpenCodeQuestionCard");

const CLIENT = {
  baseUrl: "http://127.0.0.1:9999",
} as unknown as OpencodeClient;

function makeQuestion(
  overrides: Partial<QuestionRequest> = {},
): QuestionRequest {
  return {
    id: "question-1",
    sessionId: "session-1",
    questions: [
      {
        question: "Choose deployment targets",
        header: "Targets",
        options: [
          { label: "Web", description: "Deploy the web application" },
          { label: "Desktop", description: "Deploy the desktop application" },
        ],
        multiple: true,
        custom: false,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  replyMock.mockReset();
  replyMock.mockResolvedValue("applied");
  rejectMock.mockReset();
  rejectMock.mockResolvedValue("applied");
  mockToastError.mockClear();
  useOpenCodeStore.setState({
    pendingQuestions: new Map(),
  });
  // Drafts persist across unmount by design and every test reuses question-1;
  // the setState above bypasses removePendingQuestion, which would clear them.
  usePromptDraftStore.getState().reset();
});

afterEach(cleanup);

describe("OpenCodeQuestionCard", () => {
  test("maps OpenCode multi-select and custom-answer fields into the shared card", async () => {
    render(<OpenCodeQuestionCard question={makeQuestion()} client={CLIENT} />);

    expect(screen.getByText("Choose deployment targets")).toBeTruthy();
    expect(screen.getByText("Deploy the web application")).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Type your own answer/i) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: /Desktop/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(replyMock).toHaveBeenCalledWith(
        CLIENT,
        "question-1",
        [["Web", "Desktop"]],
      );
    });
  });

  test("keeps duplicate option labels independently selectable", async () => {
    const question = makeQuestion({
      questions: [{
        question: "Choose both matching targets",
        header: "Targets",
        options: [
          { label: "Same", description: "First target" },
          { label: "Same", description: "Second target" },
        ],
        multiple: true,
        custom: false,
      }],
    });
    render(<OpenCodeQuestionCard question={question} client={CLIENT} />);

    fireEvent.click(screen.getByRole("button", { name: /First target/ }));
    fireEvent.click(screen.getByRole("button", { name: /Second target/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(replyMock).toHaveBeenCalledWith(
        CLIENT,
        question.id,
        [["Same", "Same"]],
      );
    });
  });

  test("does not fabricate a countdown when OpenCode publishes no deadline", () => {
    render(<OpenCodeQuestionCard question={makeQuestion()} client={CLIENT} />);

    expect(screen.queryByLabelText(/Time remaining/i) === null).toBe(true);
  });

  test("treats custom as enabled by default and keeps single-select answers exclusive", async () => {
    const question = makeQuestion({
      questions: [
        {
          question: "Choose an approach",
          header: "Approach",
          options: [{ label: "Conservative" }],
          multiple: false,
        },
      ],
    });
    render(<OpenCodeQuestionCard question={question} client={CLIENT} />);

    fireEvent.click(screen.getByRole("button", { name: /Conservative/ }));
    fireEvent.change(screen.getByPlaceholderText(/Type your own answer/i), {
      target: { value: "Incremental" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(replyMock).toHaveBeenCalledWith(
        CLIENT,
        "question-1",
        [["Incremental"]],
      );
    });
  });

  test("removes a pending question only after a successful reply", async () => {
    const question = makeQuestion();
    useOpenCodeStore.getState().addPendingQuestion(question);
    render(<OpenCodeQuestionCard question={question} client={CLIENT} />);

    fireEvent.click(screen.getByRole("button", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getPendingQuestion(question.id)).toBeUndefined();
    });
  });

  test("keeps the question and unlocks controls after a failed reply", async () => {
    replyMock.mockResolvedValue("pending");
    const question = makeQuestion();
    useOpenCodeStore.getState().addPendingQuestion(question);
    render(<OpenCodeQuestionCard question={question} client={CLIENT} />);

    fireEvent.click(screen.getByRole("button", { name: /Web/ }));
    const submit = screen.getByRole("button", { name: "Submit" });
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(useOpenCodeStore.getState().getPendingQuestion(question.id)).toBeTruthy();
    expect(submit.hasAttribute("disabled")).toBe(false);
  });

  test("locks submission while the reply is in flight", async () => {
    let resolveReply!: (value: OpenCodeInteractionResponseResult) => void;
    replyMock.mockImplementation(
      () => new Promise<OpenCodeInteractionResponseResult>((resolve) => {
        resolveReply = resolve;
      }),
    );
    render(<OpenCodeQuestionCard question={makeQuestion()} client={CLIENT} />);

    fireEvent.click(screen.getByRole("button", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(
        true,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(replyMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReply("applied");
    });
  });

  test("in-progress answers survive a remount and clear once the question resolves", async () => {
    // Unmount/remount mirrors an environment switch; the question rehydrates
    // from the store, and so must the half-entered answer.
    const question = makeQuestion();
    useOpenCodeStore.getState().addPendingQuestion(question);
    const { unmount } = render(
      <OpenCodeQuestionCard question={question} client={CLIENT} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Web/ }));

    unmount();
    render(<OpenCodeQuestionCard question={question} client={CLIENT} />);

    // Selection still applied, so submission is immediately possible.
    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(replyMock).toHaveBeenCalledWith(CLIENT, "question-1", [["Web"]]);
      expect(useOpenCodeStore.getState().getPendingQuestion(question.id)).toBeUndefined();
    });
    // Resolution clears the draft so a reused id starts blank.
    expect(
      usePromptDraftStore
        .getState()
        .drafts.has(openCodeQuestionDraftKey(question.sessionId, question.id)),
    ).toBe(false);
  });

  test("dismisses through the reject API and only removes on success", async () => {
    const question = makeQuestion();
    useOpenCodeStore.getState().addPendingQuestion(question);
    render(<OpenCodeQuestionCard question={question} client={CLIENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => {
      expect(rejectMock).toHaveBeenCalledWith(CLIENT, question.id);
      expect(useOpenCodeStore.getState().getPendingQuestion(question.id)).toBeUndefined();
    });

    cleanup();
    rejectMock.mockClear();
    rejectMock.mockResolvedValue("pending");
    useOpenCodeStore.getState().addPendingQuestion(question);
    render(<OpenCodeQuestionCard question={question} client={CLIENT} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });
    expect(useOpenCodeStore.getState().getPendingQuestion(question.id)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "OpenCode is still waiting for a response. Please try again.",
    );
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to dismiss this question",
      {
        description: "OpenCode is still waiting for a response. Please try again.",
      },
    );

    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss.hasAttribute("disabled")).toBe(false);
    fireEvent.click(dismiss);
    await waitFor(() => expect(rejectMock).toHaveBeenCalledTimes(2));
  });

  test("removes a question that is no longer pending without claiming the reply landed", async () => {
    replyMock.mockResolvedValue("gone");
    const question = makeQuestion();
    useOpenCodeStore.getState().addPendingQuestion(question);
    render(<OpenCodeQuestionCard question={question} client={CLIENT} />);

    fireEvent.click(screen.getByRole("button", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(useOpenCodeStore.getState().getPendingQuestion(question.id)).toBeUndefined();
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("fails closed when the reply outcome is unknown", async () => {
    replyMock.mockResolvedValue("unknown");
    const question = makeQuestion();
    useOpenCodeStore.getState().addPendingQuestion(question);
    render(<OpenCodeQuestionCard question={question} client={CLIENT} />);

    fireEvent.click(screen.getByRole("button", { name: /Web/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    });

    expect(useOpenCodeStore.getState().getPendingQuestion(question.id)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "The response outcome is unknown. Reconnect or refresh OpenCode before trying again.",
    );
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
  });
});
