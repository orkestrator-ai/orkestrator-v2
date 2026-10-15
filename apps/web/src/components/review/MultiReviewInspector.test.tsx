import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type {
  MultiReviewReviewerTranscript,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import {
  MultiReviewFindingsPane,
  ReviewerTranscriptTail,
  transcriptTailLines,
} from "./MultiReviewInspector";
import { reviewSeverityStyles } from "./StructuredReviewReportView";

const CREATED_AT = "2026-08-14T00:00:00.000Z";

function message(id: string, parts: NativeMessage["parts"]): NativeMessage {
  return { id, role: "assistant", content: "", parts, createdAt: CREATED_AT };
}

describe("transcriptTailLines", () => {
  test("flattens grouped tool rows into one keyword line per step", () => {
    const lines = transcriptTailLines([
      message("a", [
        {
          type: "tool-group",
          content: "",
          parts: [
            {
              type: "tool-invocation",
              content: "Read",
              toolName: "Read",
              toolArgs: { file_path: "src/review.ts" },
            },
            {
              type: "tool-invocation",
              content: "Grep",
              toolName: "Grep",
              toolArgs: { pattern: "pausedStep" },
            },
            { type: "thinking", content: "  The shared session\n clock moves  " },
          ],
        },
      ]),
      message("b", [
        {
          type: "tool-invocation",
          content: "search",
          toolName: "mcp__docs__search",
          toolTitle: "Search the docs for retries",
        },
        { type: "text", content: "Found one issue." },
        { type: "text", content: "   " },
      ]),
    ]);
    expect(lines.map(({ kind, text }) => [kind, text])).toEqual([
      ["read", "src/review.ts"],
      ["grep", "pausedStep"],
      ["think", "The shared session clock moves"],
      ["search", "Search the docs for retries"],
      ["say", "Found one issue."],
    ]);
    expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
  });

  test("keeps only the latest lines and shortens long ones", () => {
    const messages = Array.from({ length: 120 }, (_, index) =>
      message(`m${index}`, [{ type: "text", content: `line ${index} ${"x".repeat(400)}` }]),
    );
    const lines = transcriptTailLines(messages, 10);
    expect(lines).toHaveLength(10);
    expect(lines[0]!.text).toStartWith("line 110 ");
    expect(lines[0]!.text.length).toBe(240);
    expect(lines[0]!.text).toEndWith("…");
  });
});

function transcript(
  overrides: Partial<MultiReviewReviewerTranscript> = {},
): MultiReviewReviewerTranscript {
  return {
    workflowId: "multi-1",
    reviewerId: "reviewer-1",
    workflowPhase: "reviewing",
    agent: "codex",
    model: "gpt-5.6",
    status: "running",
    transcript: "snapshot",
    sourceToken: "token-1",
    startedAt: CREATED_AT,
    messages: [
      {
        id: "row-1",
        role: "assistant",
        content: "Read",
        createdAt: CREATED_AT,
        parts: [
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
            toolArgs: { file_path: "src/review.ts" },
            toolUseId: "tool-1",
            toolState: "success",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function workflowRevision(revision: number): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-1",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "reviewing",
    reviewers: [],
    fixModel: { agent: "codex", model: "gpt-5.6" },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    backendRevision: revision,
  };
}

beforeEach(() => {
  useMultiReviewStore.setState({ workflows: new Map() });
});
afterEach(cleanup);

describe("ReviewerTranscriptTail", () => {
  test("reads the reviewer's tail and echoes its token on the next read", async () => {
    useMultiReviewStore.getState().replaceWorkflow(workflowRevision(1));
    const loadTranscript = mock(
      async (_workflowId: string, _reviewerId: string, options?: { knownSourceToken?: string }) =>
        options?.knownSourceToken === "token-1"
          ? transcript({ transcript: "unchanged", messages: [] })
          : transcript(),
    );
    render(
      <ReviewerTranscriptTail
        workflowId="multi-1"
        reviewerId="reviewer-1"
        hasSession
        live
        isActive
        loadTranscript={loadTranscript}
      />,
    );

    const tail = screen.getByTestId("multi-review-transcript-tail");
    expect(await within(tail).findByText("src/review.ts")).toBeTruthy();
    expect(within(tail).getByText("read")).toBeTruthy();
    expect(loadTranscript.mock.calls[0]).toEqual([
      "multi-1",
      "reviewer-1",
      { knownSourceToken: undefined },
    ]);

    // A checkpoint reads again at once; an unchanged answer keeps the lines.
    act(() => useMultiReviewStore.getState().replaceWorkflow(workflowRevision(2)));
    await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
    expect(loadTranscript.mock.calls[1]?.[2]).toEqual({ knownSourceToken: "token-1" });
    expect(within(tail).getByText("src/review.ts")).toBeTruthy();
  });

  test("does not read a reviewer that has no session yet, or while the tab is hidden", () => {
    const loadTranscript = mock(async () => transcript());
    const view = render(
      <ReviewerTranscriptTail
        workflowId="multi-1"
        reviewerId="reviewer-1"
        hasSession={false}
        live
        isActive
        loadTranscript={loadTranscript}
      />,
    );
    expect(screen.getByText("The transcript appears here once this reviewer starts.")).toBeTruthy();
    view.rerender(
      <ReviewerTranscriptTail
        workflowId="multi-1"
        reviewerId="reviewer-1"
        hasSession
        live
        isActive={false}
        loadTranscript={loadTranscript}
      />,
    );
    expect(loadTranscript).not.toHaveBeenCalled();
  });

  test("shows a read failure in place of the tail", async () => {
    render(
      <ReviewerTranscriptTail
        workflowId="multi-1"
        reviewerId="reviewer-1"
        hasSession
        live={false}
        isActive
        loadTranscript={mock(async () => {
          throw new Error("Multi review reviewer not found");
        })}
      />,
    );
    expect(await screen.findByText("Multi review reviewer not found")).toBeTruthy();
  });
});

describe("MultiReviewFindingsPane", () => {
  test("lists each finding with its severity, location and the reviewers that raised it", () => {
    render(
      <MultiReviewFindingsPane
        reviewerCount={2}
        findings={[
          {
            key: "a",
            severity: "P0",
            title: "Restart resets the shared clock",
            file: "src/tab.tsx",
            line: 312,
            sources: [
              { reviewerId: "r1", index: 0, agent: "claude", model: "opus" },
              { reviewerId: "r2", index: 1, agent: "codex", model: "gpt-5.6" },
            ],
          },
          {
            key: "b",
            severity: "P2",
            title: "Copy mismatch",
            file: "src/footer.tsx",
            line: null,
            sources: [{ reviewerId: "r2", index: 1, agent: "codex", model: "gpt-5.6" }],
          },
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Findings so far" })).toBeTruthy();
    expect(screen.getByTestId("multi-review-findings-count").textContent).toBe(
      "2 · from 2 reviewers",
    );
    const [first, second] = screen.getAllByRole("listitem");
    expect(within(first!).getByText("P0").className).toContain(reviewSeverityStyles.P0);
    expect(within(first!).getByText("src/tab.tsx:312").className).toContain("font-mono");
    expect(within(first!).getByLabelText("Raised by Reviewer 1, Reviewer 2")).toBeTruthy();
    expect(within(first!).getByTitle("Reviewer 1 · claude · opus").className).toContain(
      "text-orange-400",
    );
    expect(within(second!).getByText("src/footer.tsx")).toBeTruthy();
  });

  test("explains an empty list", () => {
    const view = render(<MultiReviewFindingsPane findings={[]} reviewerCount={0} />);
    expect(screen.getByText("Findings appear here as each reviewer completes.")).toBeTruthy();
    view.rerender(<MultiReviewFindingsPane findings={[]} reviewerCount={1} />);
    expect(screen.getByTestId("multi-review-findings-count").textContent).toBe(
      "0 · from 1 reviewer",
    );
    expect(screen.getByText("The completed reviewers reported no issues.")).toBeTruthy();
  });
});
