import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  MultiReviewReviewerTranscript,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  TerminalProvider,
  useTerminalContext,
  type CreatableTabType,
  type CreateTabOptions,
} from "@/contexts";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import {
  MultiReviewTab,
  multiReviewFixSessionTabOptions,
  reviewerProgressSummary,
  reviewerStatusNote,
} from "./MultiReviewTab";
import {
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

describe("MultiReviewTab backend snapshot viewer", () => {
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

  test("records the handoff without opening a tab before backend acknowledgement", async () => {
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
        name: "Please address all the issues and coverage gaps",
      }),
    );

    await waitFor(() => expect(address).toHaveBeenCalledWith(ready.id));
    expect(await screen.findByText("The fix model is working interactively")).toBeTruthy();
    expect(await screen.findByText(/fix request was recorded and will be delivered/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open fix session" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: ADDRESS_ALL_REVIEW_PROMPT }) === null).toBe(true);
    expect(createTab).not.toHaveBeenCalled();
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

    fireEvent.click(screen.getByRole("button", { name: ADDRESS_ALL_REVIEW_PROMPT }));
    expect(await screen.findByText(/consolidation session is no longer available/)).toBeTruthy();
    // Nothing may reach the provider session when the handoff was refused.
    expect(createTab).not.toHaveBeenCalled();
    expect(useMultiReviewStore.getState().workflows.get(ready.id)?.phase).toBe("ready");
  });

  test("opens an acknowledged handoff after the pending view remounts", async () => {
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
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

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

    fireEvent.click(screen.getByRole("button", { name: ADDRESS_ALL_REVIEW_PROMPT }));
    expect(await screen.findByText(/fix request was recorded and will be delivered/)).toBeTruthy();
    await waitFor(() => expect(address).toHaveBeenCalledWith(ready.id));
    expect(useMultiReviewStore.getState().workflows.get(ready.id)?.phase).toBe("interactive");
    expect(createTab).not.toHaveBeenCalled();

    // The acknowledged authoritative snapshot exposes presentation only after
    // backend delivery, and remounting never redispatches the prompt.
    firstView.unmount();
    useMultiReviewStore.getState().replaceWorkflow(interactive);
    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => interactive)}
          commands={{
            address,
            retry: mock(async () => ready),
            cancel: mock(async () => ready),
            stopReviewer: mock(async () => ready),
          }}
        />
      </TerminalProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open fix session" }));
    await waitFor(() =>
      expect(createTab).toHaveBeenLastCalledWith(
        "codex",
        expect.objectContaining({
          resumeSessionId: "provider-fix",
        }),
      ),
    );
    expect(createTab.mock.calls.at(-1)?.[1]).not.toHaveProperty("initialPrompt");
    expect(address).toHaveBeenCalledTimes(1);
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

    expect(await screen.findByText(/fix request was recorded and will be delivered/)).toBeTruthy();
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
    const pending = { ...ready, phase: "interactive" as const, addressPromptPending: true };
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

    const button = screen.getByRole("button", { name: ADDRESS_ALL_REVIEW_PROMPT });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(address).toHaveBeenCalledWith(ready.id));
    expect(await screen.findByText(/fix request was recorded and will be delivered/)).toBeTruthy();
  });

  test("builds native tab options that resume the consolidation session", () => {
    const ready = readyWorkflow();
    expect(multiReviewFixSessionTabOptions(ready)).toEqual({
      agentLaunchMode: "native",
      resumeSessionId: "provider-fix",
      displayTitle: "Multi Review · Fix",
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
    fireEvent.click(screen.getByRole("button", { name: "Refresh reviewer transcript" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Refresh reviewer transcript" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Refresh reviewer transcript" }));
    await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Stop this reviewer" }));

    await waitFor(() => expect(loadTranscript.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(await screen.findByText(/Stopped · excluded from the consolidated report/)).toBeTruthy();
    await act(async () => {
      resolveStale(runningSnapshot);
      await stalePoll;
    });
    expect(screen.queryByRole("button", { name: "Stop this reviewer" }) === null).toBe(true);
  });
});
