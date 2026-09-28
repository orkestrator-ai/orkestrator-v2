import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";

const originalList = { ...realVirtualizedMessageList };
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  ...originalList,
  VirtualizedMessageList: ({
    messages,
    renderMessage,
  }: {
    messages: unknown[];
    renderMessage: (index: number, message: unknown, previous: unknown) => ReactNode;
  }) => (
    <div>
      {messages.map((message, index) => (
        <div key={index}>{renderMessage(index, message, index ? messages[index - 1] : null)}</div>
      ))}
    </div>
  ),
}));

const { MultiReviewReviewerTab } = await import("./MultiReviewReviewerTab");

afterEach(cleanup);
afterAll(() => mock.module("@/components/chat/VirtualizedMessageList", () => originalList));

test("the real message renderer loads a reviewer's deferred tool body", async () => {
  const loadToolDetails = mock(
    async (_workflowId: string, _reviewerId: string, detailRef: string) => ({
      detailRef,
      toolOutput: "the deferred reviewer body",
    }),
  );
  const loadTranscript = mock(async () => ({
    workflowId: "multi-real",
    reviewerId: "reviewer-real",
    workflowPhase: "reviewing" as const,
    agent: "codex" as const,
    model: "default",
    status: "running" as const,
    startedAt: "2026-08-17T00:00:00.000Z",
    messages: [
      {
        id: "tool-row",
        role: "assistant",
        content: "",
        createdAt: "2026-08-17T00:00:01.000Z",
        parts: [
          {
            type: "tool-invocation",
            content: "bun test",
            toolName: "bash",
            toolArgs: { command: "bun test" },
            toolState: "success",
            detailRef: "bd1.real-reviewer",
          },
        ],
      },
    ],
  }));
  render(
    <MultiReviewReviewerTab
      data={{
        environmentId: "env-1",
        workflowId: "multi-real",
        reviewerId: "reviewer-real",
        isLocal: true,
      }}
      isActive
      loadTranscript={loadTranscript}
      loadToolDetails={loadToolDetails}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Run Command/i }));
  await waitFor(() =>
    expect(loadToolDetails).toHaveBeenCalledWith(
      "multi-real",
      "reviewer-real",
      "bd1.real-reviewer",
    ),
  );
  expect(await screen.findByText("the deferred reviewer body")).toBeTruthy();
});
