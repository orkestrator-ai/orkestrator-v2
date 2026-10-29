/**
 * A graph-engine Multi Review in its review tab (item 301): the tab renders
 * the projected record like any other, links to its graph run, and offers no
 * bespoke step control, live or settled; the reviewer tab, the step statuses
 * and the pull request step read it as the graph engine runs it.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  MultiReviewReviewerTranscript,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { onGraphRunViewRequested, type GraphRunViewRequest } from "@/lib/graph-run-navigation";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { MultiReviewReviewerTab } from "./MultiReviewReviewerTab";
import { MultiReviewTab } from "./MultiReviewTab";
import {
  autoPrLaunchNotice,
  consolidationStep,
  fixStep,
  pullRequestStep,
} from "./multi-review-steps";

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

test("a settled graph-engine review still offers no bespoke step control", async () => {
  const settled: MultiReviewWorkflow = {
    ...graphReviewing(true),
    phase: "failed",
    error: "Node consolidate failed",
    reviewSession: {
      agent: "claude",
      model: "opus",
      sessionKey: "graph:run:consolidate",
      providerSessionId: "ps-consolidate",
      openedFor: "consolidate",
      requestIds: ["request-c"],
      status: "failed",
      startedAt: timestamp,
    },
  };
  settled.reviewers = settled.reviewers.map((reviewer) => ({ ...reviewer, status: "completed" }));
  mount(settled);
  expect(await screen.findByText("This review ran on the graph runtime.")).toBeTruthy();
  expectDomAbsent(screen.queryByRole("button", { name: "Retry failed stage" }));
  fireEvent.click(screen.getByRole("tab", { name: /^Reviewer 1 ·/ }));
  const inspector = within(screen.getByTestId("multi-review-inspector"));
  expectDomAbsent(inspector.queryByRole("button", { name: /Restart Reviewer 1/ }));
  // The failed step is attributed from its session, not a journaled request.
  expect(consolidationStep(settled)).toMatchObject({ state: "failed" });
});

test("graph-engine steps: a failed Fix, and a pull request opened by a system step", () => {
  const report = { issues: [], testCoverageGaps: [] } as unknown as NonNullable<
    MultiReviewWorkflow["consolidatedReport"]
  >;
  const failedFix: MultiReviewWorkflow = {
    ...graphReviewing(true),
    phase: "failed",
    consolidatedReport: report,
    stepRuntimes: { fix: { startedAt: timestamp } },
  };
  expect(fixStep(failedFix)).toMatchObject({ state: "failed" });
  expect(
    pullRequestStep({
      autoPr: true,
      launch: { state: "launched", requestId: "run:pr" },
      prUrl: null,
      prState: null,
      agentPhase: undefined,
      upstreamComplete: true,
      graphEngine: true,
    }),
  ).toMatchObject({ state: "complete", label: "Pull request opened by the graph run" });
  expect(
    pullRequestStep({
      autoPr: true,
      launch: { state: "pending", requestId: "run:pr" },
      prUrl: null,
      prState: null,
      agentPhase: undefined,
      upstreamComplete: true,
      graphEngine: true,
    }),
  ).toMatchObject({ state: "running", statusWord: { text: "opening" } });
  expect(autoPrLaunchNotice({ state: "launched", requestId: "run:pr" }, true).text).toMatch(
    /graph run's pull request step pushed the branch/,
  );
  expect(autoPrLaunchNotice({ state: "launched", requestId: "run:pr" }).text).toMatch(/PR tab/);
});

test("a graph-engine reviewer's tab offers no Stop, Restart or Unstick", async () => {
  useMultiReviewStore.getState().replaceWorkflow(graphReviewing());
  render(
    <MultiReviewReviewerTab
      data={{
        environmentId: "env-1",
        workflowId: "multi-graph",
        reviewerId: "reviewer-1",
        isLocal: true,
      }}
      isActive
      loadTranscript={mock(
        async () =>
          ({
            workflowId: "multi-graph",
            reviewerId: "reviewer-1",
            workflowPhase: "reviewing",
            agent: "claude",
            model: "opus",
            status: "running",
            dispatchState: "sent",
            startedAt: timestamp,
            messages: [],
          }) as unknown as MultiReviewReviewerTranscript,
      )}
      stopReviewer={mock(async () => ({}) as never)}
    />,
  );
  expect(await screen.findByText(/Read only/)).toBeTruthy();
  expectDomAbsent(screen.queryByRole("button", { name: "Stop this reviewer" }));
  expectDomAbsent(screen.queryByRole("button", { name: "Restart reviewer" }));
  expectDomAbsent(screen.queryByRole("button", { name: "Unstick reviewer" }));
});
