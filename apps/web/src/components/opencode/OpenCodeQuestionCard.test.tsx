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
  OpencodeClient,
  QuestionRequest,
} from "@/lib/opencode-client";

import * as realOpenCodeClient from "@/lib/opencode-client";
const realOpenCodeClientSnapshot = { ...realOpenCodeClient };

const replyMock = mock(async () => true);
const rejectMock = mock(async () => true);

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
  replyMock.mockResolvedValue(true);
  rejectMock.mockReset();
  rejectMock.mockResolvedValue(true);
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
    expect(screen.queryByPlaceholderText(/Type your own answer/i)).toBeNull();

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
    replyMock.mockResolvedValue(false);
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
    let resolveReply!: (value: boolean) => void;
    replyMock.mockImplementation(
      () => new Promise<boolean>((resolve) => {
        resolveReply = resolve;
      }),
    );
    render(<OpenCodeQuestionCard question={makeQuestion()} client={CLIENT} />);

    fireEvent.click(screen.getByRole("button", { name: /Web/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Submitting..." }).hasAttribute("disabled")).toBe(
        true,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Submitting..." }));
    expect(replyMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReply(true);
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
        .drafts.has(openCodeQuestionDraftKey(question.id)),
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
    rejectMock.mockResolvedValue(false);
    useOpenCodeStore.getState().addPendingQuestion(question);
    render(<OpenCodeQuestionCard question={question} client={CLIENT} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });
    expect(useOpenCodeStore.getState().getPendingQuestion(question.id)).toBeTruthy();
  });
});
