import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ClaudeClient,
  ClaudeMessage,
  ClaudePlanApprovalRequest,
  ClaudeApprovalResponseResult,
} from "@/lib/claude-client";
import * as realClaudeClient from "@/lib/claude-client";
import { useClaudeStore } from "@/stores/claudeStore";
import {
  claudePlanApprovalDraftKey,
  usePromptDraftStore,
} from "@/stores/promptDraftStore";
import { mockToastError } from "../../../../../tests/mocks/sonner";

const realClaudeClientSnapshot = { ...realClaudeClient };
const respondToPlanApprovalMock = mock(
  async (): Promise<ClaudeApprovalResponseResult> => "applied",
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

function renderCard(
  messages: ClaudeMessage[] = [],
  approvalOverride: ClaudePlanApprovalRequest = approval,
) {
  useClaudeStore.getState().addPendingPlanApproval(approvalOverride);
  return render(
    <ClaudePlanApprovalCard
      approval={approvalOverride}
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
  // Every test reuses approval-1, and the feedback draft persists across
  // unmount by design; unresolved approvals would leak it into the next test.
  usePromptDraftStore.getState().reset();
});

afterEach(cleanup);

describe("ClaudePlanApprovalCard", () => {
  test("shows the bridge deadline without trusting browser clock drift to disable decisions", () => {
    renderCard([], { ...approval, expiresAt: Date.now() + 65_000 });
    expect(screen.getByText("Expires in 1:05")).toBeTruthy();
    cleanup();

    renderCard([], { ...approval, expiresAt: Date.now() - 1 });
    expect(screen.queryByText("This request expired and was declined.")).toBeNull();
    expect(screen.getByRole("button", { name: "Approve Plan" })).toBeTruthy();
    expect(respondToPlanApprovalMock).not.toHaveBeenCalled();
  });

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
    // 409 + {status:"stale"} from the bridge: the window closed while the user
    // was deciding. Nothing to retry, so the card goes away silently.
    ["stale response", async () => "stale" as const],
  ])("removes a no-longer-actionable approval after a %s", async (_label, response) => {
    respondToPlanApprovalMock.mockImplementation(response);
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Approve Plan" }));

    await waitFor(() =>
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(false),
    );
  });

  test.each([
    ["error response", async () => "error" as const, false, {
      description: "Claude is still waiting for a decision. Please try again.",
    }],
    ["unknown transport outcome", async () => "unknown" as const, true, {
      description: "The decision outcome is unknown. Reconnect or refresh Claude before trying again.",
    }],
  ])("keeps the approval visible and reports a %s", async (_label, response, retryBlocked, expectedToast) => {
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
        expect(screen.getByRole("button", { name: "Approve Plan" }).hasAttribute("disabled")).toBe(retryBlocked),
      );
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(true);
      expect(mockToastError).toHaveBeenCalledWith("Failed to approve plan", expectedToast);
    } finally {
      console.error = consoleError;
    }
  });

  test.each([
    ["error response", async () => "error" as const, false, {
      description: "Claude is still waiting for a decision. Please try again.",
    }],
    ["unknown transport outcome", async () => "unknown" as const, true, {
      description: "The feedback outcome is unknown. Reconnect or refresh Claude before trying again.",
    }],
  ])("keeps feedback rejection visible and reports a %s", async (
    _label,
    response,
    retryBlocked,
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
        expect(screen.getByRole("button", { name: "Submit Feedback" }).hasAttribute("disabled")).toBe(retryBlocked),
      );
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(true);
      expect(mockToastError).toHaveBeenCalledWith("Failed to send plan feedback", expectedToast);
    } finally {
      console.error = consoleError;
    }
  });

  test("keeps a failed dismiss available for retry and reports it", async () => {
    respondToPlanApprovalMock.mockImplementation(async () => "error");
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

  test("removes the card without a toast when a dismissal is stale", async () => {
    // Stale is resolved-not-failed: the approval is gone, so there is nothing to
    // retry and nothing to warn the user about.
    respondToPlanApprovalMock.mockImplementation(async () => "stale");
    const consoleWarn = console.warn;
    console.warn = (() => {}) as typeof console.warn;
    try {
      renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

      await waitFor(() =>
        expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(false),
      );
      expect(mockToastError).not.toHaveBeenCalled();
    } finally {
      console.warn = consoleWarn;
    }
  });

  test("reports a forbidden response as a failure the user can retry", async () => {
    respondToPlanApprovalMock.mockImplementation(async () => "forbidden");
    const consoleError = console.error;
    console.error = (() => {}) as typeof console.error;
    try {
      renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

      await waitFor(() => expect(mockToastError).toHaveBeenCalled());
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(true);
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

  test("rejection feedback survives the card unmounting and remounting", () => {
    /**
     * The approval rehydrates from the store when the user switches back to
     * this environment, so half-typed feedback must rehydrate with it instead
     * of silently vanishing.
     */
    const { unmount } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Request Changes" }));
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: "Add rollback steps" },
    });

    unmount();
    renderCard();

    // The feedback form is still open with the draft intact.
    expect(
      (screen.getByPlaceholderText(/describe what you'd like/i) as HTMLTextAreaElement).value,
    ).toBe("Add rollback steps");
    expect(screen.getByRole("button", { name: "Submit Feedback" })).toBeTruthy();
  });

  test("resolving the approval clears the feedback draft", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Request Changes" }));
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: "stale feedback" },
    });
    const draftKey = claudePlanApprovalDraftKey("session-1", "approval-1");
    expect(usePromptDraftStore.getState().drafts.has(draftKey)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Submit Feedback" }));
    await waitFor(() =>
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(false),
    );

    // A future approval that reuses the id must not inherit this draft.
    expect(usePromptDraftStore.getState().drafts.has(draftKey)).toBe(false);
  });

  test("locks every decision while a response is in flight", async () => {
    let resolveResponse!: (value: ClaudeApprovalResponseResult) => void;
    respondToPlanApprovalMock.mockImplementation(
      () => new Promise<ClaudeApprovalResponseResult>((resolve) => {
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
