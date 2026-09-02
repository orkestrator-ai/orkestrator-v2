import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MULTI_REVIEW_FIX_TAB_TITLE,
  type MultiReviewReviewerTranscript,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  TerminalProvider,
  useTerminalContext,
  type CreatableTabType,
  type CreateTabOptions,
} from "@/contexts";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import {
  MultiReviewTab,
  multiReviewFixSessionTabOptions,
  reviewerProgressSummary,
  reviewerRuntimeSummary,
  reviewerStatusNote,
} from "./MultiReviewTab";
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

function readyWorkflow(): MultiReviewWorkflow {
  const timestamp = "2026-08-14T00:00:00.000Z";
  return {
    version: 1,
    controller: "backend",
    id: "multi-1",
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    phase: "ready",
    reviewers: [
      {
        id: "reviewer-1",
        agent: "claude",
        model: "opus",
        status: "completed",
        providerSessionId: "provider-reviewer-1",
        report,
      },
      {
        id: "reviewer-2",
        agent: "codex",
        model: "gpt-5.6",
        status: "completed",
        providerSessionId: "provider-reviewer-2",
        report,
      },
    ],
    fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
    fixSession: {
      agent: "codex",
      model: "gpt-5.6",
      reasoningEffort: "high",
      sessionKey: "multi-review:multi-1:fix",
      providerSessionId: "provider-fix",
      requestIds: ["consolidate-1"],
      status: "idle",
      startedAt: timestamp,
      completedAt: timestamp,
    },
    consolidatedReport: report,
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 7,
  };
}

/** A panel mid-run: both reviewers are live and therefore stoppable. */
function reviewingWorkflow(): MultiReviewWorkflow {
  const ready = readyWorkflow();
  const timestamp = "2026-08-14T00:00:00.000Z";
  const { fixSession: _fixSession, consolidatedReport: _consolidatedReport, ...rest } = ready;
  return {
    ...rest,
    phase: "reviewing",
    reviewers: ready.reviewers.map((reviewer) => ({
      ...reviewer,
      status: "running" as const,
      report: undefined,
      startedAt: timestamp,
    })),
  };
}

function TabRegistrar({
  createTab,
}: {
  createTab: (type: CreatableTabType, options?: CreateTabOptions) => boolean;
}) {
  const terminal = useTerminalContext();
  useEffect(() => {
    terminal.setCreateTab(createTab);
    return () => terminal.setCreateTab(null);
  }, [createTab, terminal]);
  return null;
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

describe("MultiReviewTab backend snapshot viewer", () => {
  test("formats live reviewer elapsed time and token usage", () => {
    const reviewer = reviewingWorkflow().reviewers[0]!;
    reviewer.startedAt = "2026-08-14T00:00:00.000Z";
    reviewer.tokenCount = 12_345;

    expect(reviewerRuntimeSummary(reviewer, Date.parse("2026-08-14T00:01:35.000Z"))).toBe(
      "1m 35s · 12k tokens",
    );
    delete reviewer.tokenCount;
    expect(reviewerRuntimeSummary(reviewer, Date.parse("2026-08-14T00:01:35.000Z"))).toBe(
      "1m 35s · Tokens pending",
    );
    reviewer.status = "completed";
    reviewer.completedAt = "2026-08-14T00:01:40.000Z";
    reviewer.tokenCount = 12_345;
    expect(reviewerRuntimeSummary(reviewer, Date.parse("2026-08-14T01:00:00.000Z"))).toBe(
      "1m 40s · 12k tokens",
    );
    delete reviewer.tokenCount;
    expect(reviewerRuntimeSummary(reviewer, Date.parse("2026-08-14T01:00:00.000Z"))).toBe("1m 40s");
    delete reviewer.completedAt;
    expect(reviewerRuntimeSummary(reviewer, Date.parse("2026-08-14T01:00:00.000Z"))).toBeNull();
    expect(reviewerRuntimeSummary(reviewer, Date.parse("2026-08-14T02:00:00.000Z"))).toBeNull();
    reviewer.tokenCount = 12_345;
    expect(reviewerRuntimeSummary(reviewer, Date.parse("2026-08-14T02:00:00.000Z"))).toBe(
      "12k tokens",
    );
    reviewer.startedAt = "not-a-date";
    expect(reviewerRuntimeSummary(reviewer)).toBeNull();
  });

  test("shows runtime metadata on each running reviewer card", () => {
    const originalNow = Date.now;
    Date.now = () => Date.parse("2026-08-14T00:01:35.000Z");
    const reviewing = reviewingWorkflow();
    reviewing.reviewers[0]!.startedAt = "2026-08-14T00:00:00.000Z";
    reviewing.reviewers[0]!.tokenCount = 12_345;
    useMultiReviewStore.getState().replaceWorkflow(reviewing);
    try {
      render(
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: reviewing.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => reviewing)}
        />,
      );

      expect(screen.getByLabelText("Reviewer 1 runtime and token usage").textContent).toBe(
        "1m 35s · 12k tokens",
      );
      expect(screen.getByLabelText("Reviewer 2 runtime and token usage").textContent).toContain(
        "Tokens pending",
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("keeps final usage visible on a settled reviewer card", () => {
    const ready = readyWorkflow();
    ready.reviewers[0]!.startedAt = "2026-08-14T00:00:00.000Z";
    ready.reviewers[0]!.completedAt = "2026-08-14T00:02:00.000Z";
    ready.reviewers[0]!.tokenCount = 23_456;
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );

    const runtime = screen.getByLabelText("Reviewer 1 runtime and token usage");
    expect(runtime.textContent).toBe("2m 0s · 23k tokens");
    expect(runtime.className).toContain("text-muted-foreground");
    expect(runtime.className).not.toContain("text-cyan");
  });

  test("freezes the clock while inactive, reanchors on activation, and clears its timer", async () => {
    const originalNow = Date.now;
    const originalClearInterval = window.clearInterval;
    const clearInterval = mock((handle?: number) => originalClearInterval(handle));
    window.clearInterval = clearInterval as typeof window.clearInterval;
    let now = Date.parse("2026-08-14T00:01:35.000Z");
    Date.now = () => now;
    const reviewing = reviewingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(reviewing);

    const view = render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: reviewing.id, isLocal: true }}
        isActive={false}
        hydrateWorkflow={mock(async () => reviewing)}
      />,
    );
    try {
      expect(screen.getByLabelText("Reviewer 1 runtime and token usage").textContent).toContain(
        "1m 35s",
      );
      now = Date.parse("2026-08-14T00:02:05.000Z");
      view.rerender(
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: reviewing.id, isLocal: true }}
          isActive={false}
          hydrateWorkflow={mock(async () => reviewing)}
        />,
      );
      expect(screen.getByLabelText("Reviewer 1 runtime and token usage").textContent).toContain(
        "1m 35s",
      );

      view.rerender(
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: reviewing.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => reviewing)}
        />,
      );
      await waitFor(() =>
        expect(screen.getByLabelText("Reviewer 1 runtime and token usage").textContent).toContain(
          "2m 5s",
        ),
      );
      view.unmount();
      expect(clearInterval.mock.calls.length).toBeGreaterThan(0);
    } finally {
      view.unmount();
      Date.now = originalNow;
      window.clearInterval = originalClearInterval;
    }
  });

  test("opens a reviewer transcript in a separate tab intent", () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const openReviewer = mock((_reviewerId: string, _index: number) => undefined);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
        openReviewer={openReviewer}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Reviewer 1 transcript" }));
    expect(openReviewer).toHaveBeenCalledWith("reviewer-1", 0);
  });

  test("cannot open a reviewer that never opened a provider session", () => {
    const ready = readyWorkflow();
    delete ready.reviewers[0]!.providerSessionId;
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const openReviewer = mock((_reviewerId: string, _index: number) => undefined);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
        openReviewer={openReviewer}
      />,
    );

    const withoutSession = screen.getByRole("button", { name: "Open Reviewer 1 transcript" });
    expect(withoutSession.hasAttribute("disabled")).toBe(true);
    fireEvent.click(withoutSession);
    expect(openReviewer).not.toHaveBeenCalled();

    // The sibling reviewer still has a session and stays reachable.
    expect(
      screen.getByRole("button", { name: "Open Reviewer 2 transcript" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  test("cannot open any reviewer without an intent or a terminal context", () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Open Reviewer 1 transcript" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("shows each reviewer's own failure beside the generalized workflow error", async () => {
    const ready = readyWorkflow();
    ready.phase = "failed";
    ready.error = "No reviewer produced a valid report: The reviewer session failed";
    ready.reviewers[0] = {
      ...ready.reviewers[0]!,
      status: "failed",
      error: "The reviewer session failed",
    };
    ready.reviewers[1] = {
      ...ready.reviewers[1]!,
      status: "failed",
      error: "The reviewer session no longer exists",
    };
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );

    expect(await screen.findByText("The reviewer session failed")).toBeTruthy();
    expect(screen.getByText("The reviewer session no longer exists")).toBeTruthy();
  });

  test("records the handoff and opens its backend-owned session after delivery", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const pending: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      addressPromptPending: true,
      addressPromptAttempts: 0,
      backendRevision: 8,
    };
    const address = mock(async () => pending);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);
    const hydrate = mock(async () => ready);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={hydrate}
          commands={{
            address,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );

    const consolidated = screen.getByRole("article", { name: "Consolidated Multi Review" });
    expect(screen.getByRole("button", { name: "Review Scope" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Issues · 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test Coverage Gaps · 1" })).toBeTruthy();
    expect(consolidated.textContent).not.toContain("Shared finding");
    expect(consolidated.textContent).not.toContain("The failure branch");

    fireEvent.click(screen.getByRole("button", { name: "Issues · 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Test Coverage Gaps · 1" }));
    expect(consolidated.textContent).toContain("Shared finding");
    expect(consolidated.textContent).toContain("The failure branch");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Fix",
      }),
    );

    await waitFor(() => expect(address).toHaveBeenCalledWith(ready.id));
    expect(await screen.findByText("The fix model is working interactively")).toBeTruthy();
    expect(await screen.findByText(/fix request was recorded and is being delivered/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open fix session" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Fix" }) === null).toBe(true);
    expect(createTab).not.toHaveBeenCalled();

    const retrying: MultiReviewWorkflow = {
      ...pending,
      addressPromptAttempts: 1,
      error: "The provider is temporarily unavailable; delivery will retry",
      backendRevision: 9,
    };
    act(() => useMultiReviewStore.getState().replaceWorkflow(retrying));
    expect(createTab).not.toHaveBeenCalled();

    const delivered: MultiReviewWorkflow = {
      ...pending,
      addressPromptPending: undefined,
      addressPromptAttempts: undefined,
      error: undefined,
      backendRevision: 10,
    };
    act(() => useMultiReviewStore.getState().replaceWorkflow(delivered));

    await waitFor(() =>
      expect(createTab).toHaveBeenCalledWith(
        "codex",
        expect.objectContaining({
          tabId: "multi-review-fix:multi-1",
          activateExistingTab: true,
          resumeSessionId: "provider-fix",
          requireExistingResumeSession: true,
          agentLaunchMode: "native",
          initialConversationMode: "build",
        }),
      ),
    );
    expect(createTab).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        resumeSessionId: "provider-fix",
        agentLaunchMode: "native",
        initialConversationMode: "build",
      }),
    );
    expect(createTab.mock.calls[0]?.[1]).not.toHaveProperty("initialPrompt");
  });

  test("does not steal focus when delivery completes after the review tab becomes inactive", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const pending: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      addressPromptPending: true,
      backendRevision: 8,
    };
    const delivered: MultiReviewWorkflow = {
      ...pending,
      addressPromptPending: undefined,
      backendRevision: 9,
    };
    const address = mock(async () => pending);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);
    const props = {
      data: { environmentId: "env-1", workflowId: ready.id, isLocal: true },
      hydrateWorkflow: mock(async () => ready),
      commands: {
        address,
        retry: mock(async () => ready),
        cancel: mock(async () => ready),
        stopReviewer: mock(async () => ready),
      },
    };

    const view = render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab {...props} isActive />
      </TerminalProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    await waitFor(() => expect(address).toHaveBeenCalledWith(ready.id));

    view.rerender(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab {...props} isActive={false} />
      </TerminalProvider>,
    );
    act(() => useMultiReviewStore.getState().replaceWorkflow(delivered));

    expect(await screen.findByText(/fix session is ready to open/i)).toBeTruthy();
    expect(createTab).not.toHaveBeenCalled();

    view.rerender(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab {...props} isActive />
      </TerminalProvider>,
    );
    await waitFor(() => expect(screen.getByText(/fix session is ready to open/i)).toBeTruthy());
    expect(createTab).not.toHaveBeenCalled();
  });

  test("opens a custom fix dialog with the selected fix model and default prompt", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);
    const customFix = mock(
      async (
        _workflowId: string,
        fixModel: MultiReviewWorkflow["fixModel"],
        instruction: string,
      ): Promise<MultiReviewWorkflow> => ({
        ...ready,
        phase: "interactive",
        customFixInstruction: instruction,
        customFixModel: fixModel,
        addressPromptPending: true,
        addressPromptAttempts: 0,
        backendRevision: 8,
      }),
    );

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => ready)}
          commands={{
            address: mock(async () => ready),
            customFix,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Custom fix prompt" }));
    expect(await screen.findByRole("heading", { name: "Custom fix prompt" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Custom fix model" }).textContent).toContain(
      "gpt-5.4",
    );
    const prompt = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    expect(prompt.value).toBe("Please address all the issues and coverage gaps");

    fireEvent.change(prompt, { target: { value: "Fix the reported regression" } });
    fireEvent.click(screen.getByRole("button", { name: "Start fix" }));

    await waitFor(() =>
      expect(customFix).toHaveBeenCalledWith(
        ready.id,
        { agent: "codex", model: "gpt-5.4", reasoningEffort: "high" },
        "Fix the reported regression",
      ),
    );
    // The renderer records intent only. Session creation, tab publication and
    // prompt delivery continue in the backend after this component unmounts.
    expect(createTab).not.toHaveBeenCalled();
    expect(useMultiReviewStore.getState().workflows.get(ready.id)).toMatchObject({
      phase: "interactive",
      addressPromptPending: true,
    });
    expect(screen.queryByRole("heading", { name: "Custom fix prompt" }) === null).toBe(true);
  });

  test("keeps custom fix launch failures visible inside the dialog", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => false);
    const customFix = mock(async () => {
      throw new Error("The environment is not ready or the maximum tab count was reached.");
    });

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => ready)}
          commands={{
            address: mock(async () => ready),
            customFix,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Custom fix prompt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start fix" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The environment is not ready or the maximum tab count was reached.",
    );
    expect(screen.getByRole("heading", { name: "Custom fix prompt" })).toBeTruthy();
    expect(customFix).toHaveBeenCalledTimes(1);
    expect(createTab).not.toHaveBeenCalled();
  });

  test("disables custom fix submission while the backend command is pending", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    let resolveCustomFix!: (workflow: MultiReviewWorkflow) => void;
    const customFix = mock(
      () =>
        new Promise<MultiReviewWorkflow>((resolve) => {
          resolveCustomFix = resolve;
        }),
    );

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
        commands={{
          address: mock(async () => ready),
          customFix,
          retry: mock(async () => ready),
          cancel: mock(async () => ready),
          stopReviewer: mock(async () => ready),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Custom fix prompt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start fix" }));
    const starting = await screen.findByRole("button", { name: "Starting…" });
    expect(starting.hasAttribute("disabled")).toBe(true);
    fireEvent.click(starting);
    expect(customFix).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCustomFix({
        ...ready,
        phase: "interactive",
        addressPromptPending: true,
        customFixInstruction: "Please address all the issues and coverage gaps",
        customFixModel: ready.fixModel,
        backendRevision: 8,
      });
    });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Custom fix prompt" }) === null).toBe(true),
    );
  });

  test("rehydrates a durable tab-publication warning", async () => {
    const ready = readyWorkflow();
    const interactive: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      presentationError:
        "The fix request was delivered, but its tab could not be opened. Close another tab if needed, then use Open fix session.",
      backendRevision: 8,
    };
    useMultiReviewStore.getState().replaceWorkflow(interactive);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive={false}
        hydrateWorkflow={mock(async () => interactive)}
      />,
    );

    expect(await screen.findByText(/tab could not be opened/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open fix session" })).toBeTruthy();
  });

  test("leaves a custom fix command running when the review tab unmounts", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const pending: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      customFixInstruction: "Please address all the issues and coverage gaps",
      customFixModel: ready.fixModel,
      addressPromptPending: true,
      addressPromptAttempts: 0,
      backendRevision: 8,
    };
    let finish!: () => void;
    const customFix = mock(
      () =>
        new Promise<MultiReviewWorkflow>((resolve) => {
          finish = () => resolve(pending);
        }),
    );
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);
    const view = render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => ready)}
          commands={{
            address: mock(async () => ready),
            customFix,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Custom fix prompt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start fix" }));
    await waitFor(() => expect(customFix).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      finish();
      await Promise.resolve();
    });

    expect(createTab).not.toHaveBeenCalled();
    expect(useMultiReviewStore.getState().workflows.get(ready.id)?.phase).toBe("interactive");
  });

  test("does not open a fix tab when the backend refuses the handoff", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const address = mock(async () => {
      throw new Error("The consolidation session is no longer available");
    });
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => ready)}
          commands={{
            address,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(await screen.findByText(/consolidation session is no longer available/)).toBeTruthy();
    // Nothing may reach the provider session when the handoff was refused.
    expect(createTab).not.toHaveBeenCalled();
    expect(useMultiReviewStore.getState().workflows.get(ready.id)?.phase).toBe("ready");
  });

  test("does not open when pending delivery reports that the provider session is missing", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const pending: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      addressPromptPending: true,
      backendRevision: 8,
    };
    const address = mock(async () => pending);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => ready)}
          commands={{
            address,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(await screen.findByText(/fix request was recorded and is being delivered/)).toBeTruthy();
    const { fixSession: _missing, ...withoutSession } = pending;
    act(() =>
      useMultiReviewStore.getState().replaceWorkflow({
        ...withoutSession,
        phase: "failed",
        addressPromptPending: undefined,
        error: "The consolidation session is no longer available",
        backendRevision: 9,
      }),
    );

    expect(
      await screen.findByText("The consolidation session is no longer available"),
    ).toBeTruthy();
    expect(createTab).not.toHaveBeenCalled();
  });

  test("surfaces an acknowledged interactive handoff with no fix session", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const { fixSession: _missing, ...withoutSession } = ready;
    const unavailable: MultiReviewWorkflow = {
      ...withoutSession,
      phase: "interactive",
      backendRevision: 8,
    };
    const address = mock(async () => unavailable);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => ready)}
          commands={{
            address,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(
      await screen.findByText("The consolidation session is no longer available"),
    ).toBeTruthy();
    expect(createTab).not.toHaveBeenCalled();
  });

  test("keeps a retry affordance when automatic tab presentation is unavailable", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const pending: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      addressPromptPending: true,
      addressPromptAttempts: 0,
      backendRevision: 8,
    };
    const interactive: MultiReviewWorkflow = {
      ...pending,
      addressPromptPending: undefined,
      addressPromptAttempts: undefined,
      backendRevision: 9,
    };
    const address = mock(async () => pending);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => false);

    const firstView = render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => ready)}
          commands={{
            address,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(await screen.findByText(/fix request was recorded and is being delivered/)).toBeTruthy();
    await waitFor(() => expect(address).toHaveBeenCalledWith(ready.id));
    expect(useMultiReviewStore.getState().workflows.get(ready.id)?.phase).toBe("interactive");
    expect(createTab).not.toHaveBeenCalled();

    act(() => useMultiReviewStore.getState().replaceWorkflow(interactive));
    expect(
      await screen.findByText(/fix request was delivered, but its tab could not be opened/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open fix session" })).toBeTruthy();
    expect(screen.queryByText(/fix request was recorded and is being delivered/) === null).toBe(
      true,
    );
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(address).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Open fix session" }));
    expect(await screen.findByText(/fix session tab could not be opened/i)).toBeTruthy();
    expect(screen.queryByText(/then use Open fix session/i) === null).toBe(true);
    expect(createTab).toHaveBeenCalledTimes(2);
    firstView.unmount();
  });

  test("does not attempt presentation after the review view unmounts", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const pending: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      addressPromptPending: true,
      backendRevision: 8,
    };
    let acknowledge!: (workflow: MultiReviewWorkflow) => void;
    const address = mock(
      async () =>
        await new Promise<MultiReviewWorkflow>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    const view = render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => ready)}
          commands={{
            address,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    await waitFor(() => expect(address).toHaveBeenCalledWith(ready.id));
    view.unmount();
    await act(async () => acknowledge(pending));

    expect(createTab).not.toHaveBeenCalled();
    const delivered: MultiReviewWorkflow = {
      ...pending,
      addressPromptPending: undefined,
      backendRevision: 9,
    };
    act(() => useMultiReviewStore.getState().replaceWorkflow(delivered));
    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => delivered)}
        />
      </TerminalProvider>,
    );
    expect(await screen.findByRole("button", { name: "Open fix session" })).toBeTruthy();
    expect(await screen.findByText(/fix session is ready to open/i)).toBeTruthy();
    expect(createTab).not.toHaveBeenCalled();
  });

  test("does not expose or create a tab for a pending backend-owned address session", async () => {
    const ready = readyWorkflow();
    const pending: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      addressPromptPending: true,
      addressPromptAttempts: 1,
      backendRevision: 8,
    };
    useMultiReviewStore.getState().replaceWorkflow(pending);
    const address = mock(async (_id: string) => pending);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    const firstView = render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => pending)}
          commands={{
            address,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );
    firstView.unmount();

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => pending)}
          commands={{
            address,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );

    expect(await screen.findByText(/fix request was recorded and is being delivered/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open fix session" }) === null).toBe(true);
    expect(address).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
    expect(useMultiReviewStore.getState().workflows.get(ready.id)?.addressPromptPending).toBe(true);
  });

  test("reopens an interactive fix session without sending the address prompt again", async () => {
    const ready = readyWorkflow();
    const interactive = { ...ready, phase: "interactive" as const, backendRevision: 8 };
    useMultiReviewStore.getState().replaceWorkflow(interactive);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => interactive)}
        />
      </TerminalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open fix session" }));
    await waitFor(() =>
      expect(createTab).toHaveBeenCalledWith(
        "codex",
        expect.objectContaining({
          resumeSessionId: "provider-fix",
          agentLaunchMode: "native",
          initialConversationMode: "build",
        }),
      ),
    );
    expect(createTab.mock.calls[0]?.[1]).not.toHaveProperty("initialPrompt");
  });

  test("records Address all even when no native tab can be created", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const pending = {
      ...ready,
      phase: "interactive" as const,
      addressPromptPending: true,
      backendRevision: 8,
    };
    const address = mock(async (_id: string) => pending);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
        commands={{
          address,
          retry: mock(async () => ready),
          cancel: mock(async () => ready),
          stopReviewer: mock(async () => ready),
        }}
      />,
    );

    const button = screen.getByRole("button", { name: "Fix" });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(address).toHaveBeenCalledWith(ready.id));
    expect(await screen.findByText(/fix request was recorded and is being delivered/)).toBeTruthy();

    act(() =>
      useMultiReviewStore.getState().replaceWorkflow({
        ...pending,
        addressPromptPending: undefined,
        backendRevision: 9,
      }),
    );
    expect(await screen.findByText(/cannot open agent tabs right now/i)).toBeTruthy();
  });

  test("builds native tab options that resume the consolidation session", () => {
    const ready = readyWorkflow();
    expect(multiReviewFixSessionTabOptions(ready)).toEqual({
      tabId: "multi-review-fix:multi-1",
      activateExistingTab: true,
      agentLaunchMode: "native",
      resumeSessionId: "provider-fix",
      requireExistingResumeSession: true,
      displayTitle: MULTI_REVIEW_FIX_TAB_TITLE,
      isReviewTab: true,
      initialAgentModel: "gpt-5.6",
      initialReasoningEffort: "high",
      initialConversationMode: "build",
    });
    expect(multiReviewFixSessionTabOptions(ready)).not.toHaveProperty("initialPrompt");
    const defaultModel = multiReviewFixSessionTabOptions({
      ...ready,
      fixModel: { agent: "codex", model: "default" },
    });
    expect(defaultModel?.initialAgentModel).toBeUndefined();
    expect(defaultModel?.initialReasoningEffort).toBeUndefined();
    expect(
      multiReviewFixSessionTabOptions({ ...ready, fixTabId: "multi-review-fix:multi-1:launch-1" })
        ?.tabId,
    ).toBe("multi-review-fix:multi-1:launch-1");
  });

  test("rehydrates from the authoritative backend when activated", async () => {
    const ready = readyWorkflow();
    const hydrate = mock(async () => {
      useMultiReviewStore.getState().replaceWorkflow(ready);
      return ready;
    });
    const view = render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive={false}
        hydrateWorkflow={hydrate}
      />,
    );
    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
    view.rerender(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={hydrate}
      />,
    );
    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(2));
  });

  test("lets users abandon ready and failed workflows", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const cancelled = { ...ready, phase: "cancelled" as const, backendRevision: 8 };
    const cancel = mock(async () => cancelled);
    const view = render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
        commands={{
          address: mock(async () => ready),
          retry: mock(async () => ready),
          cancel,
          stopReviewer: mock(async () => ready),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Abandon" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(ready.id));

    const failed = { ...ready, phase: "failed" as const, backendRevision: 9, error: "offline" };
    const retry = mock(async () => ({
      ...ready,
      phase: "reviewing" as const,
      backendRevision: 10,
    }));
    act(() => {
      useMultiReviewStore.setState({ workflows: new Map([[ready.id, failed]]) });
    });
    view.rerender(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => failed)}
        commands={{
          address: mock(async () => failed),
          retry,
          cancel,
          stopReviewer: mock(async () => failed),
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Abandon" })).toBeTruthy();
    expect(screen.getByText("offline")).toBeTruthy();

    // Retry is a backend intent; the tab installs whatever snapshot it returns
    // rather than deciding the next phase itself.
    fireEvent.click(screen.getByRole("button", { name: "Retry failed stage" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith(ready.id));
    await waitFor(() =>
      expect(useMultiReviewStore.getState().workflows.get(ready.id)?.phase).toBe("reviewing"),
    );
    expect(screen.queryByRole("button", { name: "Retry failed stage" }) === null).toBe(true);
  });

  test("stops one reviewer and leaves the rest of the panel running", async () => {
    const reviewing = reviewingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(reviewing);
    const withoutFirst: MultiReviewWorkflow = {
      ...reviewing,
      backendRevision: 8,
      reviewers: [{ ...reviewing.reviewers[0]!, status: "cancelled" }, reviewing.reviewers[1]!],
    };
    const stopReviewer = mock(async () => withoutFirst);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: reviewing.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => reviewing)}
        commands={{
          address: mock(async () => reviewing),
          retry: mock(async () => reviewing),
          cancel: mock(async () => reviewing),
          stopReviewer,
        }}
      />,
    );

    // Every running reviewer is independently stoppable; the workflow-wide
    // Cancel remains the control that stops all of them.
    expect(screen.getByRole("button", { name: "Stop Reviewer 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop Reviewer 1" }));
    await waitFor(() => expect(stopReviewer).toHaveBeenCalledWith(reviewing.id, "reviewer-1"));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop Reviewer 1" }) === null).toBe(true),
    );
    expect(screen.getByText(/Stopped · excluded from the consolidated report/)).toBeTruthy();
    expect(screen.getByText("0/1 complete · 1 stopped")).toBeTruthy();
    // The other reviewer keeps working: stopping one is not cancelling the run.
    expect(screen.getByRole("button", { name: "Stop Reviewer 2" })).toBeTruthy();
    expect(useMultiReviewStore.getState().workflows.get(reviewing.id)?.reviewers[0]?.status).toBe(
      "cancelled",
    );
  });

  test("offers reviewer-scoped restart and unstick actions from the card context menu", async () => {
    const reviewing = reviewingWorkflow();
    reviewing.reviewers[0] = {
      ...reviewing.reviewers[0]!,
      requestId: "request-1",
      dispatchState: "sent",
    };
    useMultiReviewStore.getState().replaceWorkflow(reviewing);
    const restartReviewer = mock(async () => reviewing);
    const unstickReviewer = mock(async () => reviewing);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: reviewing.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => reviewing)}
        commands={{
          address: mock(async () => reviewing),
          retry: mock(async () => reviewing),
          cancel: mock(async () => reviewing),
          stopReviewer: mock(async () => reviewing),
          restartReviewer,
          unstickReviewer,
        }}
      />,
    );

    const firstCard = screen.getByRole("button", {
      name: "Open Reviewer 1 transcript",
    }).parentElement!;
    fireEvent.contextMenu(firstCard);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart" }));
    await waitFor(() => expect(restartReviewer).toHaveBeenCalledWith(reviewing.id, "reviewer-1"));

    fireEvent.contextMenu(firstCard);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unstick" }));
    await waitFor(() => expect(unstickReviewer).toHaveBeenCalledWith(reviewing.id, "reviewer-1"));
  });

  test("disables reviewer restart when the worktree snapshot is stale", async () => {
    const stale = { ...readyWorkflow(), reviewSnapshotStale: true };
    useMultiReviewStore.getState().replaceWorkflow(stale);
    const restartReviewer = mock(async () => stale);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: stale.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => stale)}
        commands={{
          address: mock(async () => stale),
          retry: mock(async () => stale),
          cancel: mock(async () => stale),
          stopReviewer: mock(async () => stale),
          restartReviewer,
          unstickReviewer: mock(async () => stale),
        }}
      />,
    );

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Open Reviewer 1 transcript" }).parentElement!,
    );
    const restart = await screen.findByRole("menuitem", { name: "Restart" });
    expect(restart.hasAttribute("data-disabled")).toBe(true);
    fireEvent.click(restart);
    expect(restartReviewer).not.toHaveBeenCalled();
  });

  test("disables Unstick without a sent turn or a running reviewer", async () => {
    const reviewing = reviewingWorkflow();
    reviewing.reviewers[0] = { ...reviewing.reviewers[0]!, dispatchState: undefined };
    reviewing.reviewers[1] = {
      ...reviewing.reviewers[1]!,
      status: "completed",
      dispatchState: "sent",
      report,
    };
    useMultiReviewStore.getState().replaceWorkflow(reviewing);
    const unstickReviewer = mock(async () => reviewing);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: reviewing.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => reviewing)}
        commands={{
          address: mock(async () => reviewing),
          retry: mock(async () => reviewing),
          cancel: mock(async () => reviewing),
          stopReviewer: mock(async () => reviewing),
          restartReviewer: mock(async () => reviewing),
          unstickReviewer,
        }}
      />,
    );

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Open Reviewer 1 transcript" }).parentElement!,
    );
    expect(
      (await screen.findByRole("menuitem", { name: "Unstick" })).hasAttribute("data-disabled"),
    ).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Open Reviewer 2 transcript" }).parentElement!,
    );
    expect(
      (await screen.findByRole("menuitem", { name: "Unstick" })).hasAttribute("data-disabled"),
    ).toBe(true);
    expect(unstickReviewer).not.toHaveBeenCalled();
  });

  test("can restart a completed reviewer before fix work begins", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const restarted = { ...reviewingWorkflow(), backendRevision: 8 };
    const restartReviewer = mock(async () => restarted);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
        commands={{
          address: mock(async () => ready),
          retry: mock(async () => ready),
          cancel: mock(async () => ready),
          stopReviewer: mock(async () => ready),
          restartReviewer,
          unstickReviewer: mock(async () => ready),
        }}
      />,
    );

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Open Reviewer 1 transcript" }).parentElement!,
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart" }));
    await waitFor(() => expect(restartReviewer).toHaveBeenCalledWith(ready.id, "reviewer-1"));
    expect(useMultiReviewStore.getState().workflows.get(ready.id)?.phase).toBe("reviewing");
  });

  test("surfaces a stalled reviewer without claiming it failed", () => {
    const reviewing = reviewingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow({
      ...reviewing,
      reviewers: [
        { ...reviewing.reviewers[0]!, stalledSince: "2026-08-14T00:20:00.000Z" },
        reviewing.reviewers[1]!,
      ],
    });

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: reviewing.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => reviewing)}
      />,
    );

    expect(screen.getByText(/No activity for a while/)).toBeTruthy();
    // A stall is a prompt to intervene, not a verdict: the reviewer is still
    // running and may still produce a report.
    expect(screen.getByRole("button", { name: "Stop Reviewer 1" })).toBeTruthy();
  });

  test("reports a stopped reviewer as stopped rather than failed", () => {
    expect(
      reviewerStatusNote({
        id: "reviewer-1",
        agent: "claude",
        model: "opus",
        status: "cancelled",
      }),
    ).toEqual({ text: "Stopped · excluded from the consolidated report", tone: "muted" });
    expect(
      reviewerStatusNote({
        id: "reviewer-1",
        agent: "claude",
        model: "opus",
        status: "failed",
        error: "offline",
      }),
    ).toEqual({ text: "offline", tone: "destructive" });
    // A stall flag left on a settled reviewer must not relabel its result.
    expect(
      reviewerStatusNote({
        id: "reviewer-1",
        agent: "claude",
        model: "opus",
        status: "completed",
        report,
        stalledSince: "2026-08-14T00:20:00.000Z",
      }),
    ).toBeNull();
  });

  test("summarises completed and stopped reviewers without an unfinished denominator", () => {
    const ready = readyWorkflow();
    expect(
      reviewerProgressSummary([
        ready.reviewers[0]!,
        { ...ready.reviewers[1]!, status: "cancelled", report: undefined },
      ]),
    ).toBe("1/1 complete · 1 stopped");
    expect(reviewerProgressSummary(ready.reviewers)).toBe("2/2 complete");
    expect(
      reviewerProgressSummary(
        ready.reviewers.map((reviewer) => ({
          ...reviewer,
          status: "cancelled" as const,
          report: undefined,
        })),
      ),
    ).toBe("0 complete · 2 stopped");
  });

  test("surfaces a stalled consolidation or fix session with recovery guidance", () => {
    const ready = readyWorkflow();
    for (const phase of ["consolidating", "fixing"] as const) {
      const stalled: MultiReviewWorkflow = {
        ...ready,
        phase,
        fixSession: {
          ...ready.fixSession!,
          status: "running",
          stalledSince: "2026-08-14T00:20:00.000Z",
        },
        ...(phase === "fixing"
          ? {
              activeRequest: {
                kind: "fix" as const,
                requestId: "fix-1",
                state: "sent" as const,
                createdAt: "2026-08-14T00:15:00.000Z",
              },
            }
          : {}),
      };
      useMultiReviewStore.setState({ workflows: new Map([[stalled.id, stalled]]) });
      const view = render(
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: stalled.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => stalled)}
        />,
      );

      expect(screen.getByRole("status").textContent).toContain("Fix model appears stalled");
      expect(screen.getByRole("status").textContent).toContain("Cancel now");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      view.unmount();
    }
  });

  test("ignores a stale fix-session stall flag after the workflow settles", () => {
    const ready = readyWorkflow();
    const settled = {
      ...ready,
      fixSession: { ...ready.fixSession!, stalledSince: "2026-08-14T00:20:00.000Z" },
    };
    useMultiReviewStore.getState().replaceWorkflow(settled);
    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => settled)}
      />,
    );

    expect(screen.queryByRole("status") === null).toBe(true);
    expect(screen.getByText("Consolidated report ready")).toBeTruthy();
  });
});

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
