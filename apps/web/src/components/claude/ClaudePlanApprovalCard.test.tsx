import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ClaudeClient,
  ClaudeMessage,
  ClaudePlanApprovalRequest,
  ClaudePlanApprovalResponseResult,
} from "@/lib/claude-client";
import * as realClaudeClient from "@/lib/claude-client";
import { useClaudeStore } from "@/stores/claudeStore";
import { mockToastError } from "../../../../../tests/mocks/sonner";

const realClaudeClientSnapshot = { ...realClaudeClient };
const respondToPlanApprovalMock = mock(
  async (): Promise<ClaudePlanApprovalResponseResult> => "applied",
);

mock.module("@/lib/claude-client", () => ({
  ...realClaudeClientSnapshot,
  respondToPlanApproval: respondToPlanApprovalMock,
}));

const { ClaudePlanApprovalCard } = await import("./ClaudePlanApprovalCard");

const client = { baseUrl: "http://127.0.0.1:9999" } as ClaudeClient;
const approval: ClaudePlanApprovalRequest = {
  id: "approval-1",
  sessionId: "session-1",
};

function assistantMessage(
  id: string,
  filePath: string,
  content: string,
  overrides: {
    role?: ClaudeMessage["role"];
    toolName?: string;
    omitContent?: boolean;
  } = {},
): ClaudeMessage {
  return {
    id,
    role: overrides.role ?? "assistant",
    content: "",
    timestamp: "2026-07-20T10:00:00.000Z",
    parts: [
      {
        type: "tool-invocation",
        toolName: overrides.toolName ?? "Write",
        toolArgs: overrides.omitContent
          ? { file_path: filePath }
          : { file_path: filePath, content },
      },
    ],
  };
}

function renderCard(messages: ClaudeMessage[] = []) {
  useClaudeStore.getState().addPendingPlanApproval(approval);
  return render(
    <ClaudePlanApprovalCard
      approval={approval}
      client={client}
      sessionId="session-1"
      messages={messages}
    />,
  );
}

afterAll(() => {
  mock.module("@/lib/claude-client", () => realClaudeClientSnapshot);
});

beforeEach(() => {
  respondToPlanApprovalMock.mockClear();
  respondToPlanApprovalMock.mockImplementation(async () => "applied");
  mockToastError.mockClear();
  useClaudeStore.setState({ pendingPlanApprovals: new Map() });
});

afterEach(cleanup);

describe("ClaudePlanApprovalCard", () => {
  test("shows the most recent Write to a recognized plan path", async () => {
    renderCard([
      assistantMessage("old", "/workspace/implementation-plan.md", "# Old plan"),
      assistantMessage("unrelated", "/workspace/README.md", "# Not a plan"),
      assistantMessage("new", "/workspace/docs/plans/feature.md", "# New plan"),
    ]);

    expect(screen.getByRole("heading", { name: "New plan" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Old plan" })).toBeNull();

    fireEvent.click(screen.getByText("Implementation Plan"));
    await waitFor(() =>
      expect(screen.getByText("Click to expand")).toBeTruthy(),
    );
  });

  test("falls back to conversation guidance when no plan Write exists", () => {
    renderCard([assistantMessage("readme", "/workspace/README.md", "# Readme")]);

    expect(screen.getByText(/review the plan in the conversation above/i)).toBeTruthy();
    expect(screen.queryByText("Implementation Plan")).toBeNull();
  });

  test.each([
    ["a bare plan file", "/workspace/plan.md"],
    ["the plan-prefixed form", "/workspace/plan-phase-two.md"],
    ["the underscore-prefixed form", "/workspace/plan_phase_two.md"],
    ["a suffixed plan file", "/workspace/rollout-plan.md"],
    ["any markdown under .claude/", "/workspace/.claude/notes.md"],
    ["any markdown under plans/", "/workspace/plans/notes.md"],
    ["a path recognized case-insensitively", "/workspace/Docs/Plans/Feature.MD"],
  ])("recognizes %s as a plan", (_label, filePath) => {
    renderCard([assistantMessage("plan", filePath, "# Recognized plan")]);

    expect(screen.getByRole("heading", { name: "Recognized plan" })).toBeTruthy();
  });

  test.each([
    ["a non-markdown file in a plan directory", "/workspace/docs/plans/feature.txt"],
    ["markdown outside any plan directory", "/workspace/docs/architecture.md"],
    ["a file that merely mentions plan", "/workspace/planning.md"],
  ])("does not treat %s as a plan", (_label, filePath) => {
    renderCard([assistantMessage("not-a-plan", filePath, "# Not a plan")]);

    expect(screen.queryByRole("heading", { name: "Not a plan" })).toBeNull();
    expect(screen.getByText(/review the plan in the conversation above/i)).toBeTruthy();
  });

  test("keeps searching past a plan Write that carried no content", () => {
    // A Write whose args never made it through is not a plan the user can
    // review; stopping there would hide the plan that does exist.
    renderCard([
      assistantMessage("with-content", "/workspace/plan.md", "# Earlier plan"),
      assistantMessage("empty", "/workspace/plan.md", "", { omitContent: true }),
      assistantMessage("blank", "/workspace/plan.md", ""),
    ]);

    expect(screen.getByRole("heading", { name: "Earlier plan" })).toBeTruthy();
  });

  test("matches the Write tool name case-insensitively", () => {
    renderCard([
      assistantMessage("lower", "/workspace/plan.md", "# Lowercase tool", {
        toolName: "write",
      }),
    ]);

    expect(screen.getByRole("heading", { name: "Lowercase tool" })).toBeTruthy();
  });

  test("ignores plan Writes that are not on an assistant message", () => {
    // Only the assistant's own tool calls describe what Claude proposes; a
    // replayed user or system part must not be rendered as the plan.
    renderCard([
      assistantMessage("user-part", "/workspace/plan.md", "# User plan", {
        role: "user",
      }),
      assistantMessage("system-part", "/workspace/plan.md", "# System plan", {
        role: "system",
      }),
    ]);

    expect(screen.queryByRole("heading", { name: "User plan" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "System plan" })).toBeNull();
    expect(screen.getByText(/review the plan in the conversation above/i)).toBeTruthy();
  });

  test("ignores non-Write tool invocations that touch a plan file", () => {
    renderCard([
      assistantMessage("read", "/workspace/plan.md", "# Read plan", {
        toolName: "Read",
      }),
    ]);

    expect(screen.queryByRole("heading", { name: "Read plan" })).toBeNull();
  });

  test("approves the request and removes the pending card", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Approve Plan" }));

    await waitFor(() =>
      expect(respondToPlanApprovalMock).toHaveBeenCalledWith(
        client,
        "session-1",
        "approval-1",
        true,
      ),
    );
    expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(false);
  });

  test("collects trimmed feedback before rejecting the plan", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Request Changes" }));
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: "  Add rollback steps  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit Feedback" }));

    await waitFor(() =>
      expect(respondToPlanApprovalMock).toHaveBeenCalledWith(
        client,
        "session-1",
        "approval-1",
        false,
        "Add rollback steps",
      ),
    );
    expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(false);
  });

  test("dismisses as a rejection without feedback", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(respondToPlanApprovalMock).toHaveBeenCalledWith(
        client,
        "session-1",
        "approval-1",
        false,
      ),
    );
    expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(false);
  });

  test.each([
    ["expired response", async () => "expired" as const],
  ])("removes a no-longer-actionable approval after an %s", async (_label, response) => {
    respondToPlanApprovalMock.mockImplementation(response);
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Approve Plan" }));

    await waitFor(() =>
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(false),
    );
  });

  test.each([
    ["failed response", async () => "failed" as const, {
      description: "Claude is still waiting for a decision. Please try again.",
    }],
    ["transport error", async () => {
      throw new Error("bridge unavailable");
    }, { description: "bridge unavailable" }],
  ])("keeps the approval retryable and reports a %s", async (_label, response, expectedToast) => {
    /**
     * The card staying enabled is not a signal on its own — the turn is fully
     * blocked on this answer, so a response that never landed has to say so.
     */
    respondToPlanApprovalMock.mockImplementation(response);
    const consoleError = console.error;
    console.error = (() => {}) as typeof console.error;
    try {
      renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Approve Plan" }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Approve Plan" }).hasAttribute("disabled")).toBe(false),
      );
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(true);
      expect(mockToastError).toHaveBeenCalledWith("Failed to approve plan", expectedToast);
    } finally {
      console.error = consoleError;
    }
  });

  test.each([
    ["failed response", async () => "failed" as const, {
      description: "Claude is still waiting for a decision. Please try again.",
    }],
    ["transport error", async () => {
      throw new Error("bridge unavailable");
    }, { description: "bridge unavailable" }],
  ])("keeps feedback rejection available for retry and reports a %s", async (
    _label,
    response,
    expectedToast,
  ) => {
    respondToPlanApprovalMock.mockImplementation(response);
    const consoleError = console.error;
    console.error = (() => {}) as typeof console.error;
    try {
      renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Request Changes" }));
      fireEvent.click(screen.getByRole("button", { name: "Submit Feedback" }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Submit Feedback" }).hasAttribute("disabled")).toBe(false),
      );
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(true);
      expect(mockToastError).toHaveBeenCalledWith("Failed to send plan feedback", expectedToast);
    } finally {
      console.error = consoleError;
    }
  });

  test("keeps a failed dismiss available for retry and reports it", async () => {
    respondToPlanApprovalMock.mockImplementation(async () => "failed");
    const consoleError = console.error;
    console.error = (() => {}) as typeof console.error;
    try {
      renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Dismiss" }).hasAttribute("disabled")).toBe(false),
      );
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(true);
      expect(mockToastError).toHaveBeenCalledWith("Failed to dismiss plan", {
        description: "Claude is still waiting for a decision. Please try again.",
      });
    } finally {
      console.error = consoleError;
    }
  });

  test("stays silent when the response lands", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Approve Plan" }));

    await waitFor(() =>
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(false),
    );
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("locks every decision while a response is in flight", async () => {
    let resolveResponse!: (value: ClaudePlanApprovalResponseResult) => void;
    respondToPlanApprovalMock.mockImplementation(
      () => new Promise<ClaudePlanApprovalResponseResult>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Approve Plan" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approving..." }).hasAttribute("disabled")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Dismiss" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Request Changes" }).hasAttribute("disabled")).toBe(true);

    resolveResponse("applied");
    await waitFor(() =>
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(false),
    );
  });
});
