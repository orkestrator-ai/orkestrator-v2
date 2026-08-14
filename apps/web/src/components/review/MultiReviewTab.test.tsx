import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { MultiReviewTab } from "./MultiReviewTab";

const report: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main", baseRef: "origin/main...HEAD", commit: null,
    filesReviewed: ["src/review.ts"], filesSkipped: [], filesLeftUncommitted: [],
    commandsRun: [], commandsNotRun: [], limitations: [],
  },
  whatChanged: {
    overview: "Multi-model review", before: "One reviewer", after: "Review panel",
    keyCodeChanges: [], userImpact: "Broader review coverage",
  },
  riskProfile: { changeTypes: ["feature"], riskAreas: [], overallRisk: "medium", reasoning: "New workflow" },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [{
    severity: "P1", confidence: 95, category: "correctness", title: "Shared finding",
    file: "src/review.ts", line: 12, symbol: "review", description: "A finding",
    evidence: "Observed by both reviewers", suggestion: "Address it", verification: "Run the regression test",
  }],
  testCoverageGaps: [{ file: "src/review.test.ts", untestedBehavior: "The failure branch" }],
  verdict: { ready: "with-fixes", reasoning: "One issue remains" },
  summaryOfChange: "Adds Multi Review", reviewSummary: "Deduplicated reviewer findings",
};

function readyWorkflow(): MultiReviewWorkflow {
  const timestamp = "2026-08-14T00:00:00.000Z";
  return {
    version: 1, controller: "backend", id: "multi-1", environmentId: "env-1",
    projectId: "project-1", targetBranch: "main", phase: "ready",
    reviewers: [
      { id: "reviewer-1", agent: "claude", model: "opus", status: "completed", report },
      { id: "reviewer-2", agent: "codex", model: "gpt-5.6", status: "completed", report },
    ],
    fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
    fixSession: {
      agent: "codex", model: "gpt-5.6", reasoningEffort: "high",
      sessionKey: "multi-review:multi-1:fix", providerSessionId: "provider-fix",
      requestIds: ["consolidate-1"], status: "idle", startedAt: timestamp, completedAt: timestamp,
    },
    consolidatedReport: report, createdAt: timestamp, updatedAt: timestamp, backendRevision: 7,
  };
}

beforeEach(() => useMultiReviewStore.setState({ workflows: new Map() }));
afterEach(cleanup);

describe("MultiReviewTab backend snapshot viewer", () => {
  test("renders the consolidated report and delegates the fix intent to the backend", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const fixing: MultiReviewWorkflow = {
      ...ready, phase: "fixing", backendRevision: 8,
      fixSession: { ...ready.fixSession!, status: "running", requestIds: ["consolidate-1", "fix-1"] },
      activeRequest: { kind: "fix", requestId: "fix-1", state: "prepared", createdAt: ready.updatedAt },
    };
    const address = mock(async () => fixing);
    const hydrate = mock(async () => ready);

    render(<MultiReviewTab
      data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
      isActive
      hydrateWorkflow={hydrate}
      commands={{
        address,
        retry: mock(async () => ready),
        cancel: mock(async () => ready),
      }}
    />);

    const consolidated = screen.getByRole("article", { name: "Consolidated Multi Review" });
    expect(consolidated.textContent).toContain("Shared finding");
    expect(consolidated.textContent).toContain("The failure branch");
    fireEvent.click(screen.getByRole("button", {
      name: "Please address all the issues and coverage gaps",
    }));

    await waitFor(() => expect(address).toHaveBeenCalledWith(ready.id));
    expect(await screen.findByText("The fix model is addressing every finding")).toBeTruthy();
  });

  test("rehydrates from the authoritative backend when activated", async () => {
    const ready = readyWorkflow();
    const hydrate = mock(async () => {
      useMultiReviewStore.getState().replaceWorkflow(ready);
      return ready;
    });
    const view = render(<MultiReviewTab
      data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
      isActive={false}
      hydrateWorkflow={hydrate}
    />);
    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
    view.rerender(<MultiReviewTab
      data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
      isActive
      hydrateWorkflow={hydrate}
    />);
    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(2));
  });
});
