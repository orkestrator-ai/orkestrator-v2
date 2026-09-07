import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  type MultiReviewReviewerTranscript,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import {
  MANUAL_REFRESH_TIMEOUT_MS,
  MultiReviewReviewerTab,
  REFRESH_INTERVAL_MS,
  toMultiReviewReviewerMessages,
} from "./MultiReviewReviewerTab";

const report: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: ["src/review.ts"],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Multi-model review",
    before: "One reviewer",
    after: "Review panel",
    keyCodeChanges: [],
    userImpact: "Broader review coverage",
  },
  riskProfile: {
    changeTypes: ["feature"],
    riskAreas: [],
    overallRisk: "medium",
    reasoning: "New workflow",
  },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [
    {
      severity: "P1",
      confidence: 95,
      category: "correctness",
      title: "Shared finding",
      file: "src/review.ts",
      line: 12,
      symbol: "review",
      description: "A finding",
      evidence: "Observed by both reviewers",
      suggestion: "Address it",
      verification: "Run the regression test",
    },
  ],
  testCoverageGaps: [{ file: "src/review.test.ts", untestedBehavior: "The failure branch" }],
  verdict: { ready: "with-fixes", reasoning: "One issue remains" },
  summaryOfChange: "Adds Multi Review",
  reviewSummary: "Deduplicated reviewer findings",
};

/** A panel mid-run: both reviewers are live and therefore stoppable. */
function reviewingWorkflow(): MultiReviewWorkflow {
  const timestamp = "2026-08-14T00:00:00.000Z";
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
        providerSessionId: "provider-reviewer-1",
        startedAt: timestamp,
      },
      {
        id: "reviewer-2",
        agent: "codex",
        model: "gpt-5.6",
        status: "running",
        providerSessionId: "provider-reviewer-2",
        startedAt: timestamp,
      },
    ],
    fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 7,
  };
}

beforeEach(() => {
  useMultiReviewStore.setState({ workflows: new Map() });
  useMessagePartExpansionStore.getState().reset();
});
afterEach(cleanup);

async function openTranscriptRefreshMenu() {
  fireEvent.contextMenu(screen.getByTestId("multi-review-reviewer-transcript-body"));
  return screen.findByRole("menuitem", { name: "Refresh transcript" });
}

describe("MultiReviewReviewerTab", () => {
  test("shows progress and tool calls read-only, replacing final JSON with the report", async () => {
    const finalJson = JSON.stringify(report);
    const loadTranscript = mock(async () => ({
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      workflowPhase: "ready" as const,
      agent: "codex" as const,
      model: "gpt-5.6",
      reasoningEffort: "high",
      status: "completed" as const,
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:01:00.000Z",
      report,
      messages: [
        {
          id: "generated-review-prompt",
          role: "user",
          content: "Generated reviewer workflow instructions",
          createdAt: "2026-08-14T00:00:00.000Z",
          parts: [{ type: "text", content: "Generated reviewer workflow instructions" }],
        },
        {
          id: "progress",
          role: "assistant",
          content: "Inspecting the changed files",
          createdAt: "2026-08-14T00:00:10.000Z",
          parts: [
            { type: "text", content: "Inspecting the changed files" },
            {
              type: "tool-invocation",
              content: "shell",
              toolName: "shell",
              toolArgs: { command: "git diff" },
              toolState: "success",
              toolOutput: "diff output",
            },
          ],
        },
        {
          id: "generated-schema-repair",
          role: "user",
          content: "Expected schema and $.ready validation failure",
          createdAt: "2026-08-14T00:00:30.000Z",
          parts: [{ type: "text", content: "Expected schema and $.ready validation failure" }],
        },
        {
          id: "final-json",
          role: "assistant",
          content: finalJson,
          createdAt: "2026-08-14T00:01:00.000Z",
          parts: [{ type: "text", content: finalJson }],
        },
      ],
    }));

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
      />,
    );

    await waitFor(() => expect(loadTranscript).toHaveBeenCalledWith("multi-1", "reviewer-1"));
    expect(await screen.findByRole("article", { name: "Reviewer report" })).toBeTruthy();
    expect(screen.getByText(/Ready: with-fixes · 1 issue · 1 coverage gap/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(finalJson);
    expect(screen.queryByRole("textbox") === null).toBe(true);

    const normalized = toMultiReviewReviewerMessages(await loadTranscript());
    // The reviewer transcript shares the chat adapter, so the progress turn is
    // split into its narration and its tool activity, and the schema-shaped
    // final answer is dropped in favour of the validated report above.
    expect(normalized.map((message) => message.id)).toEqual(["progress", "progress:text-block:1"]);
    expect(normalized[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", content: "Inspecting the changed files" }),
    ]);
    const toolGroup = normalized[1]?.parts[0];
    expect(toolGroup?.type).toBe("tool-group");
    expect(toolGroup?.type === "tool-group" ? toolGroup.parts : []).toContainEqual(
      expect.objectContaining({
        type: "tool-invocation",
        toolName: "shell",
        toolArgs: { command: "git diff" },
        toolOutput: "diff output",
      }),
    );
  });

  test("keeps the transcript full-height and does not overlap slow refreshes", async () => {
    let resolveFirst!: (value: MultiReviewReviewerTranscript) => void;
    const first = new Promise<MultiReviewReviewerTranscript>((resolve) => {
      resolveFirst = resolve;
    });
    const completed: MultiReviewReviewerTranscript = {
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      workflowPhase: "ready",
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
      ({ unmount } = render(
        <MultiReviewReviewerTab
          data={{
            environmentId: "env-1",
            workflowId: "multi-1",
            reviewerId: "reviewer-1",
            isLocal: true,
          }}
          isActive
          loadTranscript={loadTranscript}
        />,
      ));

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

  test("queues a manual refresh behind an in-flight transcript poll", async () => {
    let resolvePoll!: (value: MultiReviewReviewerTranscript) => void;
    const poll = new Promise<MultiReviewReviewerTranscript>((resolve) => {
      resolvePoll = resolve;
    });
    let resolveManual!: (value: MultiReviewReviewerTranscript) => void;
    const manual = new Promise<MultiReviewReviewerTranscript>((resolve) => {
      resolveManual = resolve;
    });
    const running: MultiReviewReviewerTranscript = {
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      workflowPhase: "reviewing",
      agent: "codex",
      model: "gpt-5.6",
      status: "running",
      messages: [],
    };
    const refreshed: MultiReviewReviewerTranscript = {
      ...running,
      model: "gpt-5.6-refreshed",
      messages: [
        {
          id: "new-progress",
          role: "assistant",
          content: "Progress loaded after the click",
          parts: [{ type: "text", content: "Progress loaded after the click" }],
        },
      ],
    };
    let calls = 0;
    const loadTranscript = mock(async () => {
      calls += 1;
      if (calls <= 2) return running;
      if (calls === 3) return await poll;
      return await manual;
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
      ({ unmount } = render(
        <MultiReviewReviewerTab
          data={{
            environmentId: "env-1",
            workflowId: "multi-1",
            reviewerId: "reviewer-1",
            isLocal: true,
          }}
          isActive
          loadTranscript={loadTranscript}
        />,
      ));

      // The status-dependent effect performs one settling read before arming
      // the stable running-state interval used below.
      await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
      act(() => intervalCallback?.());
      await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(3));

      fireEvent.click(await openTranscriptRefreshMenu());
      // The click waits behind the controlled poll instead of overlapping it.
      expect(loadTranscript).toHaveBeenCalledTimes(3);

      await act(async () => {
        resolvePoll(running);
        await poll;
      });
      // With status already stable, only manualRefresh can start this read.
      await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(4));
      await act(async () => {
        resolveManual(refreshed);
        await manual;
      });
      expect(await screen.findByText(/gpt-5.6-refreshed · Read only/)).toBeTruthy();
      expect(loadTranscript).toHaveBeenCalledTimes(4);
    } finally {
      unmount?.();
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test("manually refreshes a settled reviewer when no poll is in flight", async () => {
    let resolveManual!: (value: MultiReviewReviewerTranscript) => void;
    const manual = new Promise<MultiReviewReviewerTranscript>((resolve) => {
      resolveManual = resolve;
    });
    const completed: MultiReviewReviewerTranscript = {
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      workflowPhase: "ready",
      agent: "codex",
      model: "gpt-5.6",
      status: "completed",
      messages: [],
    };
    const refreshed: MultiReviewReviewerTranscript = {
      ...completed,
      model: "gpt-5.6-settled-refresh",
      messages: [
        {
          id: "settled-progress",
          role: "assistant",
          content: "Settled transcript refreshed manually",
          parts: [{ type: "text", content: "Settled transcript refreshed manually" }],
        },
      ],
    };
    let calls = 0;
    const loadTranscript = mock(async () => {
      calls += 1;
      return calls <= 2 ? completed : await manual;
    });

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
      />,
    );

    await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
    fireEvent.click(await openTranscriptRefreshMenu());
    await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveManual(refreshed);
      await manual;
    });
    expect(await screen.findByText(/gpt-5.6-settled-refresh · Read only/)).toBeTruthy();
    expect(loadTranscript).toHaveBeenCalledTimes(3);
  });

  test("re-arms Refresh after a transcript request times out", async () => {
    let resolveStale!: (value: MultiReviewReviewerTranscript) => void;
    const stale = new Promise<MultiReviewReviewerTranscript>((resolve) => {
      resolveStale = resolve;
    });
    let resolveRetry!: (value: MultiReviewReviewerTranscript) => void;
    const retry = new Promise<MultiReviewReviewerTranscript>((resolve) => {
      resolveRetry = resolve;
    });
    const running: MultiReviewReviewerTranscript = {
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      workflowPhase: "reviewing",
      agent: "codex",
      model: "gpt-5.6",
      status: "running",
      messages: [],
    };
    const refreshed: MultiReviewReviewerTranscript = {
      ...running,
      model: "gpt-5.6-timeout-recovery",
      messages: [
        {
          id: "retry-progress",
          role: "assistant",
          content: "Refresh recovered after timeout",
          parts: [{ type: "text", content: "Refresh recovered after timeout" }],
        },
      ],
    };
    let calls = 0;
    const loadTranscript = mock(async () => {
      calls += 1;
      return calls === 1 ? await stale : await retry;
    });
    let timeoutCallback: (() => void) | undefined;
    const manualTimeoutId = 2_147_000_001;
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    window.setTimeout = ((callback: TimerHandler, delay?: number) => {
      if (delay === MANUAL_REFRESH_TIMEOUT_MS && typeof callback === "function") {
        timeoutCallback = () => callback();
        return manualTimeoutId;
      }
      return originalSetTimeout(callback, delay);
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== manualTimeoutId) originalClearTimeout(id);
    }) as typeof window.clearTimeout;
    let unmount: (() => void) | undefined;

    try {
      ({ unmount } = render(
        <MultiReviewReviewerTab
          data={{
            environmentId: "env-1",
            workflowId: "multi-1",
            reviewerId: "reviewer-1",
            isLocal: true,
          }}
          isActive
          loadTranscript={loadTranscript}
        />,
      ));

      await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(1));
      fireEvent.click(await openTranscriptRefreshMenu());

      await act(async () => {
        timeoutCallback?.();
        await Promise.resolve();
      });
      fireEvent.click(await openTranscriptRefreshMenu());
      await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));

      await act(async () => {
        resolveStale(running);
        await stale;
      });
      // The abandoned attempt settling late cannot clear the newer spinner.
      await act(async () => {
        resolveRetry(refreshed);
        await retry;
      });
      expect(await screen.findByText(/gpt-5.6-timeout-recovery · Read only/)).toBeTruthy();
    } finally {
      unmount?.();
      window.setTimeout = originalSetTimeout;
      window.clearTimeout = originalClearTimeout;
    }
  });

  test("releases a pending manual refresh when the reviewer tab becomes inactive", async () => {
    let resolveStale!: (value: MultiReviewReviewerTranscript) => void;
    const stale = new Promise<MultiReviewReviewerTranscript>((resolve) => {
      resolveStale = resolve;
    });
    const staleSnapshot: MultiReviewReviewerTranscript = {
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      workflowPhase: "reviewing",
      agent: "codex",
      model: "stale-inactive-model",
      status: "running",
      messages: [
        {
          id: "inactive-progress",
          role: "assistant",
          content: "Stale inactive transcript",
          parts: [{ type: "text", content: "Stale inactive transcript" }],
        },
      ],
    };
    const loadTranscript = mock(async () => await stale);
    const data = {
      environmentId: "env-1",
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
      isLocal: true,
    };
    const view = render(
      <MultiReviewReviewerTab data={data} isActive loadTranscript={loadTranscript} />,
    );

    await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(1));
    fireEvent.click(await openTranscriptRefreshMenu());

    view.rerender(
      <MultiReviewReviewerTab data={data} isActive={false} loadTranscript={loadTranscript} />,
    );
    await act(async () => {
      resolveStale(staleSnapshot);
      await stale;
    });
    expect(screen.queryByText(/stale-inactive-model/) === null).toBe(true);
  });

  test("shows a transcript read failure in the read-only view", async () => {
    const loadTranscript = mock(async () => {
      throw new Error("Multi review workflow not found: multi-1");
    });

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
      />,
    );

    expect(await screen.findByText(/Multi review workflow not found: multi-1/)).toBeTruthy();
  });

  test("stops polling a transcript whose workflow no longer exists", async () => {
    let calls = 0;
    const loadTranscript = mock(async () => {
      calls += 1;
      throw new Error("Multi review workflow not found: multi-1");
    });

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
      />,
    );

    expect(await screen.findByText(/Multi review workflow not found: multi-1/)).toBeTruthy();
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    const callsAtSettlement = calls;

    // A gone workflow must tear the poll down: no transcript request may fire
    // during a full interval period after the error is shown.
    await new Promise((resolve) => setTimeout(resolve, REFRESH_INTERVAL_MS + 500));
    expect(calls).toBe(callsAtSettlement);
  });
});

describe("MultiReviewReviewerTab stop control", () => {
  const runningSnapshot: MultiReviewReviewerTranscript = {
    workflowId: "multi-1",
    reviewerId: "reviewer-1",
    workflowPhase: "reviewing",
    agent: "cursor",
    model: "composer-1",
    status: "running",
    startedAt: "2026-08-14T00:00:00.000Z",
    messages: [],
  };

  test("does not offer Stop for a pending reviewer while the package is preparing", async () => {
    const stopReviewer = mock(async () => ({}) as never);
    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={mock(
          async () =>
            ({
              ...runningSnapshot,
              workflowPhase: "preparing",
              status: "pending",
              startedAt: undefined,
            }) satisfies MultiReviewReviewerTranscript,
        )}
        stopReviewer={stopReviewer}
      />,
    );

    expect(await screen.findByText(/Read only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop this reviewer" }) === null).toBe(true);
    expect(stopReviewer).not.toHaveBeenCalled();
  });

  test("stops the reviewer and re-reads the authoritative snapshot", async () => {
    let current: MultiReviewReviewerTranscript = runningSnapshot;
    const loadTranscript = mock(async () => current);
    const stopReviewer = mock(async () => {
      current = { ...runningSnapshot, status: "cancelled" };
      return {} as never;
    });

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
        stopReviewer={stopReviewer}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Stop this reviewer" }));
    await waitFor(() => expect(stopReviewer).toHaveBeenCalledWith("multi-1", "reviewer-1"));
    // The workflow owns the lifecycle, so the tab proves the new status by
    // re-reading rather than assuming it locally.
    expect(await screen.findByText(/Stopped · excluded from the consolidated report/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop this reviewer" }) === null).toBe(true),
    );
  });

  test("restarts only the opened reviewer from the beginning", async () => {
    const failedWorkflow: MultiReviewWorkflow = {
      ...reviewingWorkflow(),
      phase: "failed",
      backendRevision: 8,
      error: "No reviewer produced a valid report: 1 reviewer was stopped",
      reviewers: [
        {
          ...reviewingWorkflow().reviewers[0]!,
          status: "cancelled",
          completedAt: "2026-08-14T00:10:00.000Z",
        },
      ],
    };
    const restartedWorkflow: MultiReviewWorkflow = {
      ...failedWorkflow,
      phase: "reviewing",
      backendRevision: 9,
      error: undefined,
      reviewers: [{ ...failedWorkflow.reviewers[0]!, status: "pending" }],
    };
    let current: MultiReviewReviewerTranscript = {
      ...runningSnapshot,
      workflowPhase: "failed",
      status: "cancelled",
    };
    const loadTranscript = mock(async () => current);
    const restartReviewer = mock(async () => {
      current = { ...current, workflowPhase: "reviewing", status: "pending", messages: [] };
      return restartedWorkflow;
    });
    useMultiReviewStore.getState().replaceWorkflow(failedWorkflow);

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
        restartReviewer={restartReviewer}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Restart reviewer" }));
    await waitFor(() => expect(restartReviewer).toHaveBeenCalledWith("multi-1", "reviewer-1"));
    await waitFor(() =>
      expect(useMultiReviewStore.getState().workflows.get("multi-1")?.phase).toBe("reviewing"),
    );
    expect(screen.getByRole("button", { name: "Restart reviewer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Refresh.*transcript/ }) === null).toBe(true);
    expect(await openTranscriptRefreshMenu()).toBeTruthy();
  });

  test("unsticks the opened reviewer and re-reads its session", async () => {
    let current: MultiReviewReviewerTranscript = {
      ...runningSnapshot,
      dispatchState: "sent",
    };
    const loadTranscript = mock(async () => current);
    const unstickReviewer = mock(async () => {
      current = { ...current, model: "composer-continued" };
      return reviewingWorkflow();
    });

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
        unstickReviewer={unstickReviewer}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Unstick reviewer" }));
    await waitFor(() => expect(unstickReviewer).toHaveBeenCalledWith("multi-1", "reviewer-1"));
    expect(await screen.findByText(/composer-continued · Read only/)).toBeTruthy();
  });

  test("hides Unstick when the parent workflow is no longer reviewing", async () => {
    const loadTranscript = mock(async () => ({
      ...runningSnapshot,
      workflowPhase: "ready" as const,
      dispatchState: "sent" as const,
    }));

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
      />,
    );

    await waitFor(() => expect(loadTranscript).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Unstick reviewer" }) === null).toBe(true);
  });

  test("surfaces a stale-snapshot Unstick rejection and settles the control", async () => {
    const loadTranscript = mock(async () => ({
      ...runningSnapshot,
      dispatchState: "sent" as const,
    }));
    const unstickReviewer = mock(async () => {
      throw new Error("A reviewer can only be unstuck while review is running");
    });

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
        unstickReviewer={unstickReviewer}
      />,
    );

    const button = await screen.findByRole("button", { name: "Unstick reviewer" });
    fireEvent.click(button);
    expect(await screen.findByText(/only be unstuck while review is running/)).toBeTruthy();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });

  test("surfaces a stall on a reviewer that is still running", async () => {
    const loadTranscript = mock(async () => ({
      ...runningSnapshot,
      stalledSince: "2026-08-14T00:20:00.000Z",
    }));

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
        stopReviewer={mock(async () => ({}) as never)}
      />,
    );

    expect(await screen.findByText(/No activity for a while/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop this reviewer" })).toBeTruthy();
  });

  test("reports a refused stop without pretending the reviewer settled", async () => {
    const loadTranscript = mock(async () => runningSnapshot);
    const stopReviewer = mock(async () => {
      throw new Error("Multi review reviewer not found: reviewer-1");
    });

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
        stopReviewer={stopReviewer}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Stop this reviewer" }));
    expect(await screen.findByText(/Multi review reviewer not found/)).toBeTruthy();
    fireEvent.click(await openTranscriptRefreshMenu());
    await waitFor(() => expect(loadTranscript.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText(/Multi review reviewer not found/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop this reviewer" })).toBeTruthy();
  });

  test("lets a gone workflow displace a stale stop failure", async () => {
    let gone = false;
    const loadTranscript = mock(async () => {
      if (gone) throw new Error("Multi review workflow not found: multi-1");
      return runningSnapshot;
    });
    const stopReviewer = mock(async () => {
      throw new Error("The Multi Review controller is busy");
    });

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
        stopReviewer={stopReviewer}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Stop this reviewer" }));
    expect(await screen.findByText(/controller is busy/)).toBeTruthy();

    // The action failure outranks an ordinary transcript failure, but a gone
    // workflow is terminal for this view: reporting the stale stop error there
    // would hide why the transcript stopped refreshing.
    gone = true;
    fireEvent.click(await openTranscriptRefreshMenu());
    expect(await screen.findByText(/Multi review workflow not found/)).toBeTruthy();
    expect(screen.queryByText(/controller is busy/) === null).toBe(true);
  });

  test("fences out an older running poll after a reviewer is stopped", async () => {
    let resolveStale!: (value: MultiReviewReviewerTranscript) => void;
    const stalePoll = new Promise<MultiReviewReviewerTranscript>((resolve) => {
      resolveStale = resolve;
    });
    const cancelled = { ...runningSnapshot, status: "cancelled" as const };
    let calls = 0;
    const loadTranscript = mock(async () => {
      calls += 1;
      if (calls === 1) return runningSnapshot;
      if (calls === 2) return stalePoll;
      return cancelled;
    });
    const stopReviewer = mock(async () => ({}) as never);

    render(
      <MultiReviewReviewerTab
        data={{
          environmentId: "env-1",
          workflowId: "multi-1",
          reviewerId: "reviewer-1",
          isLocal: true,
        }}
        isActive
        loadTranscript={loadTranscript}
        stopReviewer={stopReviewer}
      />,
    );

    await screen.findByRole("button", { name: "Stop this reviewer" });
    fireEvent.click(await openTranscriptRefreshMenu());
    await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Stop this reviewer" }));

    await waitFor(() => expect(loadTranscript.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(await screen.findByText(/Stopped · excluded from the consolidated report/)).toBeTruthy();
    // Stop fences the stalled manual request before that abandoned request settles.
    await act(async () => {
      resolveStale(runningSnapshot);
      await stalePoll;
    });
    expect(screen.queryByRole("button", { name: "Stop this reviewer" }) === null).toBe(true);
  });
});
