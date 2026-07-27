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
): ClaudeMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp: "2026-07-20T10:00:00.000Z",
    parts: [
      {
        type: "tool-invocation",
        toolName: "Write",
        toolArgs: { file_path: filePath, content },
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
    ["failed response", async () => "failed" as const],
    ["transport error", async () => {
      throw new Error("bridge unavailable");
    }],
  ])("keeps the approval retryable after a %s", async (_label, response) => {
    respondToPlanApprovalMock.mockImplementation(response);
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Approve Plan" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve Plan" }).hasAttribute("disabled")).toBe(false),
    );
    expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(true);
  });

  test("keeps a failed feedback rejection available for retry", async () => {
    respondToPlanApprovalMock.mockImplementation(async () => "failed");
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Request Changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit Feedback" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Submit Feedback" }).hasAttribute("disabled")).toBe(false),
    );
    expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(true);
  });

  test("keeps a failed dismiss available for retry", async () => {
    respondToPlanApprovalMock.mockImplementation(async () => "failed");
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dismiss" }).hasAttribute("disabled")).toBe(false),
    );
    expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(true);
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
