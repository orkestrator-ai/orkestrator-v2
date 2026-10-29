/**
 * A graph-engine Multi Review in its review tab (item 301): the tab renders
 * the projected record like any other, links to its graph run, and offers no
 * bespoke step control while the run is live.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { onGraphRunViewRequested, type GraphRunViewRequest } from "@/lib/graph-run-navigation";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { MultiReviewTab } from "./MultiReviewTab";

const timestamp = "2026-10-29T00:00:00.000Z";

function graphReviewing(settled = false): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-graph",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    engine: "graph",
    graphRun: {
      runId: "multi-review-multi-graph",
      projectedRevision: 9,
      ...(settled ? { settled } : {}),
    },
    phase: "reviewing",
    reviewers: [
      {
        id: "reviewer-1",
        agent: "claude",
        model: "opus",
        status: "running",
        providerSessionId: "ps-1",
        dispatchState: "sent",
        startedAt: timestamp,
      },
    ],
    fixModel: { agent: "claude", model: "opus" },
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 3,
  };
}

function commands(workflow: MultiReviewWorkflow) {
  return {
    address: mock(async () => workflow),
    retry: mock(async () => workflow),
    cancel: mock(async () => workflow),
    stopReviewer: mock(async () => workflow),
    restartReviewer: mock(async () => workflow),
    unstickReviewer: mock(async () => workflow),
    restartStep: mock(async () => workflow),
    pauseStep: mock(async () => workflow),
    resumeStep: mock(async () => workflow),
  };
}

function mount(workflow: MultiReviewWorkflow) {
  useMultiReviewStore.getState().replaceWorkflow(workflow);
  return render(
    <MultiReviewTab
      data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
      isActive
      hydrateWorkflow={mock(async () => workflow)}
      commands={commands(workflow)}
    />,
  );
}

beforeEach(() => {
  useMultiReviewStore.setState({ workflows: new Map() });
  useMessagePartExpansionStore.getState().reset();
});
afterEach(cleanup);

test("a live graph-engine review links to its run and offers no bespoke step control", async () => {
  const requests: GraphRunViewRequest[] = [];
  const unsubscribe = onGraphRunViewRequested((request) => {
    requests.push(request);
    return true;
  });
  try {
    mount(graphReviewing());
    expect(await screen.findByText(/runs on the graph runtime/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open graph run" }));
    await waitFor(() =>
      expect(requests).toEqual([
        {
          runId: "multi-review-multi-graph",
          projectId: "project-1",
          environmentId: "env-1",
          mock: false,
          title: "Multi Review",
        },
      ]),
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Reviewer 1 ·/ }));
    const inspector = within(screen.getByTestId("multi-review-inspector"));
    expectDomAbsent(inspector.queryByRole("button", { name: "Stop Reviewer 1" }));
    expectDomAbsent(inspector.queryByRole("button", { name: /Restart Reviewer 1/ }));
  } finally {
    unsubscribe();
  }
});

test("a settled graph-engine review keeps the link and reads as an ordinary review", async () => {
  const settled: MultiReviewWorkflow = { ...graphReviewing(true), phase: "cancelled" };
  settled.reviewers = settled.reviewers.map((reviewer) => ({ ...reviewer, status: "cancelled" }));
  mount(settled);
  expect(await screen.findByText("This review ran on the graph runtime.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open graph run" })).toBeTruthy();
});
