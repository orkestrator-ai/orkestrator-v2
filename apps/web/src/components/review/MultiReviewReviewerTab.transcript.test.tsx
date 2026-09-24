import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  MultiReviewReviewerTranscript,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import {
  MultiReviewReviewerTab,
  mergeMultiReviewReviewerTranscript,
} from "./MultiReviewReviewerTab";

const STARTED_AT = "2026-09-14T22:00:00.000Z";

function transcript(
  overrides: Partial<MultiReviewReviewerTranscript> = {},
): MultiReviewReviewerTranscript {
  return {
    workflowId: "multi-1",
    reviewerId: "reviewer-1",
    workflowPhase: "reviewing",
    agent: "claude",
    model: "opus",
    status: "running",
    startedAt: STARTED_AT,
    messages: [
      {
        id: "progress",
        role: "assistant",
        content: "Inspecting the changed files",
        createdAt: STARTED_AT,
        parts: [{ type: "text", content: "Inspecting the changed files" }],
      },
    ],
    transcript: "snapshot",
    sourceToken: "token-1",
    ...overrides,
  };
}

function workflow(backendRevision: number): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-1",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "reviewing",
    reviewers: [
      {
        id: "reviewer-1",
        agent: "claude",
        model: "opus",
        status: "running",
        startedAt: STARTED_AT,
      },
    ],
    fixModel: { agent: "claude", model: "opus" },
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    backendRevision,
  };
}

const data = {
  environmentId: "env-1",
  workflowId: "multi-1",
  reviewerId: "reviewer-1",
  isLocal: true,
};

beforeEach(() => {
  useMultiReviewStore.setState({ workflows: new Map() });
});
afterEach(cleanup);

describe("conditional reviewer transcript reads", () => {
  test("an unchanged answer keeps the shown messages and refreshes the status", () => {
    const previous = transcript();
    const merged = mergeMultiReviewReviewerTranscript(
      previous,
      transcript({ transcript: "unchanged", messages: [], stalledSince: STARTED_AT }),
    );
    expect(merged.messages).toBe(previous.messages);
    expect(merged.stalledSince).toBe(STARTED_AT);
  });

  test("a snapshot replaces the list, and an old backend's response is a snapshot", () => {
    const next = transcript({ messages: [] });
    expect(mergeMultiReviewReviewerTranscript(transcript(), next)).toBe(next);
    const legacy = transcript({ transcript: undefined, sourceToken: undefined, messages: [] });
    expect(mergeMultiReviewReviewerTranscript(transcript(), legacy).messages).toEqual([]);
  });

  test("polls echo the last token and keep rendering on unchanged answers", async () => {
    const loadTranscript = mock(
      async (_workflowId: string, _reviewerId: string, options?: { knownSourceToken?: string }) =>
        options?.knownSourceToken === "token-1"
          ? transcript({ transcript: "unchanged", messages: [] })
          : transcript(),
    );
    render(
      <MultiReviewReviewerTab
        data={data}
        isActive
        loadTranscript={loadTranscript}
        refreshIntervalMs={20}
      />,
    );
    await waitFor(() => expect(loadTranscript.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(loadTranscript.mock.calls[0]?.[2]).toEqual({ knownSourceToken: undefined });
    expect(loadTranscript.mock.calls.at(-1)?.[2]).toEqual({ knownSourceToken: "token-1" });
    // Status projection still renders from every unchanged answer.
    expect(await screen.findByText("opus · Read only")).toBeTruthy();
  });

  test("a workflow checkpoint refreshes the active tab without waiting for the poll", async () => {
    useMultiReviewStore.getState().replaceWorkflow(workflow(7));
    const loadTranscript = mock(async () => transcript());
    render(
      <MultiReviewReviewerTab
        data={data}
        isActive
        loadTranscript={loadTranscript}
        refreshIntervalMs={60_000}
      />,
    );
    await waitFor(() => expect(loadTranscript).toHaveBeenCalled());
    await screen.findByText("opus · Read only");
    const callsBefore = loadTranscript.mock.calls.length;

    act(() => useMultiReviewStore.getState().replaceWorkflow(workflow(8)));
    await waitFor(() => expect(loadTranscript.mock.calls.length).toBe(callsBefore + 1));
  });

  test("an inactive tab does not poll or react to checkpoints", async () => {
    useMultiReviewStore.getState().replaceWorkflow(workflow(7));
    const loadTranscript = mock(async () => transcript());
    render(
      <MultiReviewReviewerTab
        data={data}
        isActive={false}
        loadTranscript={loadTranscript}
        refreshIntervalMs={20}
      />,
    );
    act(() => useMultiReviewStore.getState().replaceWorkflow(workflow(8)));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(loadTranscript).not.toHaveBeenCalled();
  });
});
