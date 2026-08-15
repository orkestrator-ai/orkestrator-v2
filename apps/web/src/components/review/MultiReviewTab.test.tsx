import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  MultiReviewReviewerTranscript,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { MultiReviewTab } from "./MultiReviewTab";
import {
  MultiReviewReviewerTab,
  REFRESH_INTERVAL_MS,
  toMultiReviewReviewerMessages,
} from "./MultiReviewReviewerTab";

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
      { id: "reviewer-1", agent: "claude", model: "opus", status: "completed",
        providerSessionId: "provider-reviewer-1", report },
      { id: "reviewer-2", agent: "codex", model: "gpt-5.6", status: "completed",
        providerSessionId: "provider-reviewer-2", report },
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
  test("opens a reviewer transcript in a separate tab intent", () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const openReviewer = mock((_reviewerId: string, _index: number) => undefined);

    render(<MultiReviewTab
      data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
      isActive
      hydrateWorkflow={mock(async () => ready)}
      openReviewer={openReviewer}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Open Reviewer 1 transcript" }));
    expect(openReviewer).toHaveBeenCalledWith("reviewer-1", 0);
  });

  test("cannot open a reviewer that never opened a provider session", () => {
    const ready = readyWorkflow();
    delete ready.reviewers[0]!.providerSessionId;
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const openReviewer = mock((_reviewerId: string, _index: number) => undefined);

    render(<MultiReviewTab
      data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
      isActive
      hydrateWorkflow={mock(async () => ready)}
      openReviewer={openReviewer}
    />);

    const withoutSession = screen.getByRole("button", { name: "Open Reviewer 1 transcript" });
    expect(withoutSession.hasAttribute("disabled")).toBe(true);
    fireEvent.click(withoutSession);
    expect(openReviewer).not.toHaveBeenCalled();

    // The sibling reviewer still has a session and stays reachable.
    expect(screen.getByRole("button", { name: "Open Reviewer 2 transcript" })
      .hasAttribute("disabled")).toBe(false);
  });

  test("cannot open any reviewer without an intent or a terminal context", () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(<MultiReviewTab
      data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
      isActive
      hydrateWorkflow={mock(async () => ready)}
    />);

    expect(screen.getByRole("button", { name: "Open Reviewer 1 transcript" })
      .hasAttribute("disabled")).toBe(true);
  });

  test("shows each reviewer's own failure beside the generalized workflow error", async () => {
    const ready = readyWorkflow();
    ready.phase = "failed";
    ready.error = "No reviewer produced a valid report: The reviewer session failed";
    ready.reviewers[0] = {
      ...ready.reviewers[0]!, status: "failed", error: "The reviewer session failed",
    };
    ready.reviewers[1] = {
      ...ready.reviewers[1]!, status: "failed", error: "The reviewer session no longer exists",
    };
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(<MultiReviewTab
      data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
      isActive
      hydrateWorkflow={mock(async () => ready)}
    />);

    expect(await screen.findByText("The reviewer session failed")).toBeTruthy();
    expect(screen.getByText("The reviewer session no longer exists")).toBeTruthy();
  });

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

  test("lets users abandon ready and failed workflows", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const cancelled = { ...ready, phase: "cancelled" as const, backendRevision: 8 };
    const cancel = mock(async () => cancelled);
    const view = render(<MultiReviewTab
      data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
      isActive
      hydrateWorkflow={mock(async () => ready)}
      commands={{
        address: mock(async () => ready),
        retry: mock(async () => ready),
        cancel,
      }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Abandon" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(ready.id));

    const failed = { ...ready, phase: "failed" as const, backendRevision: 9, error: "offline" };
    const retry = mock(async () => ({ ...ready, phase: "reviewing" as const, backendRevision: 10 }));
    act(() => {
      useMultiReviewStore.setState({ workflows: new Map([[ready.id, failed]]) });
    });
    view.rerender(<MultiReviewTab
      data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
      isActive
      hydrateWorkflow={mock(async () => failed)}
      commands={{ address: mock(async () => failed), retry, cancel }}
    />);
    expect(screen.getByRole("button", { name: "Abandon" })).toBeTruthy();
    expect(screen.getByText("offline")).toBeTruthy();

    // Retry is a backend intent; the tab installs whatever snapshot it returns
    // rather than deciding the next phase itself.
    fireEvent.click(screen.getByRole("button", { name: "Retry failed stage" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith(ready.id));
    await waitFor(() =>
      expect(useMultiReviewStore.getState().workflows.get(ready.id)?.phase).toBe("reviewing"));
    expect(screen.queryByRole("button", { name: "Retry failed stage" }) === null).toBe(true);
  });
});

describe("MultiReviewReviewerTab", () => {
  test("shows progress and tool calls read-only, replacing final JSON with the report", async () => {
    const finalJson = JSON.stringify(report);
    const loadTranscript = mock(async () => ({
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      agent: "codex" as const,
      model: "gpt-5.6",
      reasoningEffort: "high",
      status: "completed" as const,
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:01:00.000Z",
      report,
      messages: [{
        id: "generated-review-prompt",
        role: "user",
        content: "Generated reviewer workflow instructions",
        createdAt: "2026-08-14T00:00:00.000Z",
        parts: [{ type: "text", content: "Generated reviewer workflow instructions" }],
      }, {
        id: "progress",
        role: "assistant",
        content: "Inspecting the changed files",
        createdAt: "2026-08-14T00:00:10.000Z",
        parts: [
          { type: "text", content: "Inspecting the changed files" },
          {
            type: "tool-invocation", content: "shell", toolName: "shell",
            toolArgs: { command: "git diff" }, toolState: "success", toolOutput: "diff output",
          },
        ],
      }, {
        id: "generated-schema-repair",
        role: "user",
        content: "Expected schema and $.ready validation failure",
        createdAt: "2026-08-14T00:00:30.000Z",
        parts: [{ type: "text", content: "Expected schema and $.ready validation failure" }],
      }, {
        id: "final-json",
        role: "assistant",
        content: finalJson,
        createdAt: "2026-08-14T00:01:00.000Z",
        parts: [{ type: "text", content: finalJson }],
      }],
    }));

    render(<MultiReviewReviewerTab
      data={{
        environmentId: "env-1", workflowId: "multi-1", reviewerId: "reviewer-1", isLocal: true,
      }}
      isActive
      loadTranscript={loadTranscript}
    />);

    await waitFor(() => expect(loadTranscript).toHaveBeenCalledWith("multi-1", "reviewer-1"));
    expect(await screen.findByRole("article", { name: "Reviewer report" })).toBeTruthy();
    expect(screen.getByText(/Ready: with-fixes · 1 issue · 1 coverage gap/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(finalJson);
    expect(screen.queryByRole("textbox") === null).toBe(true);

    const normalized = toMultiReviewReviewerMessages(await loadTranscript());
    expect(normalized.map((message) => message.id)).toEqual(["progress"]);
    expect(normalized[0]?.parts).toContainEqual(expect.objectContaining({
      type: "tool-invocation",
      toolName: "shell",
      toolArgs: { command: "git diff" },
      toolOutput: "diff output",
    }));
  });

  test("keeps the transcript full-height and does not overlap slow refreshes", async () => {
    let resolveFirst!: (value: MultiReviewReviewerTranscript) => void;
    const first = new Promise<MultiReviewReviewerTranscript>((resolve) => {
      resolveFirst = resolve;
    });
    const completed: MultiReviewReviewerTranscript = {
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      agent: "codex",
      model: "gpt-5.6",
      status: "completed",
      report,
      messages: [],
    };
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    let calls = 0;
    const loadTranscript = mock(async () => {
      calls += 1;
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      try {
        return calls === 1 ? await first : completed;
      } finally {
        activeRequests -= 1;
      }
    });
    let intervalCallback: (() => void) | undefined;
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    window.setInterval = ((callback: TimerHandler) => {
      if (typeof callback === "function") intervalCallback = () => callback();
      return 1;
    }) as typeof window.setInterval;
    window.clearInterval = mock(() => undefined) as typeof window.clearInterval;
    let unmount: (() => void) | undefined;

    try {
      ({ unmount } = render(<MultiReviewReviewerTab
        data={{
          environmentId: "env-1", workflowId: "multi-1", reviewerId: "reviewer-1", isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
      />));

      const body = screen.getByTestId("multi-review-reviewer-transcript-body");
      expect(body.classList.contains("flex")).toBe(true);
      expect(body.classList.contains("flex-col")).toBe(true);
      await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(1));

      act(() => {
        intervalCallback?.();
        intervalCallback?.();
      });
      expect(loadTranscript).toHaveBeenCalledTimes(1);
      expect(maximumActiveRequests).toBe(1);

      await act(async () => {
        resolveFirst(completed);
        await first;
      });
      await waitFor(() => expect(activeRequests).toBe(0));
      expect(maximumActiveRequests).toBe(1);
    } finally {
      unmount?.();
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test("shows a transcript read failure in the read-only view", async () => {
    const loadTranscript = mock(async () => {
      throw new Error("Multi review workflow not found: multi-1");
    });

    render(<MultiReviewReviewerTab
      data={{
        environmentId: "env-1", workflowId: "multi-1", reviewerId: "reviewer-1", isLocal: true,
      }}
      isActive
      loadTranscript={loadTranscript}
    />);

    expect(await screen.findByText(/Multi review workflow not found: multi-1/)).toBeTruthy();
  });

  test("stops polling a transcript whose workflow no longer exists", async () => {
    let calls = 0;
    const loadTranscript = mock(async () => {
      calls += 1;
      throw new Error("Multi review workflow not found: multi-1");
    });

    render(<MultiReviewReviewerTab
      data={{
        environmentId: "env-1", workflowId: "multi-1", reviewerId: "reviewer-1", isLocal: true,
      }}
      isActive
      loadTranscript={loadTranscript}
    />);

    expect(await screen.findByText(/Multi review workflow not found: multi-1/)).toBeTruthy();
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    const callsAtSettlement = calls;

    // A gone workflow must tear the poll down: no transcript request may fire
    // during a full interval period after the error is shown.
    await new Promise((resolve) => setTimeout(resolve, REFRESH_INTERVAL_MS + 500));
    expect(calls).toBe(callsAtSettlement);
  });
});
