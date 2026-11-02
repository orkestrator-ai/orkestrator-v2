import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  MULTI_REVIEW_FIX_TAB_TITLE,
  type MultiReviewModelSelection,
  type MultiReviewStepKind,
  type MultiReviewStepTranscript,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { readOnlyCommandSandboxOffNote } from "@orkestrator/protocol/native-agent";
import {
  TerminalProvider,
  useTerminalContext,
  type CreatableTabType,
  type CreateTabOptions,
} from "@/contexts";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { createSessionKey } from "@/lib/utils";
import {
  nativeAgentCapabilities,
  type NativeAgentSessionStateUpdate,
  type NativeAgentTurnPhase,
  type NativeAgentSessionProjection,
} from "@orkestrator/protocol/native-agent";
import type { Environment } from "@/types";
import { MultiReviewTab, allowsReviewTileActivation } from "./MultiReviewTab";
import * as pipelineReviewTab from "@/components/build-pipeline/PipelineReviewTab";
import {
  autoPrLaunchNotice,
  consolidationStep,
  fixSessionRuntimeStep,
  fixSessionRuntimeSummary,
  multiReviewStepRuntimeSummary,
  fixStep,
  multiReviewFixSessionTabOptions,
  multiReviewReviewSessionTabOptions,
  pullRequestDetail,
  pullRequestStep,
  reviewPackageGenerationStep,
  reviewerColumnLabel,
  reviewerProgressSummary,
  reviewerRuntimeSummary,
  reviewerStatusNote,
} from "./multi-review-steps";

/**
 * A node of the flow graph. Nodes are tabs controlling the inspector, named
 * `{title}, {status}…`: "Review package", "Reviewer 1 ·", "Consolidation" and
 * "Fix," pick the four kinds.
 */
function flowNode(prefix: string): HTMLElement {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return screen.getByRole("tab", { name: new RegExp(`^${escaped}`) });
}

/** Selects a node so the inspector shows it, and returns the node. */
function selectFlowNode(prefix: string): HTMLElement {
  const node = flowNode(prefix);
  fireEvent.click(node);
  return node;
}

function inspector() {
  return within(screen.getByTestId("multi-review-inspector"));
}

/** Radix activates a tab from mousedown/focus, not from a bare click. */
function showInspectorTab(name: "Transcript" | "Report"): void {
  const trigger = inspector().getByRole("tab", { name });
  fireEvent.mouseDown(trigger);
  fireEvent.focus(trigger);
}

const STEP_OPEN_LABEL = {
  "Review package": "Open review package generation session",
  Consolidation: "Open consolidation session",
  "Fix,": "Open fix model session",
} as const;

/** Selects a step node and returns the inspector's Open session button for it. */
function stepOpenButton(node: keyof typeof STEP_OPEN_LABEL): HTMLElement {
  selectFlowNode(node);
  return inspector().getByRole("button", { name: STEP_OPEN_LABEL[node] });
}

function activateReviewTile(button: HTMLElement): void {
  fireEvent.pointerDown(button, {
    pointerType: "mouse",
    pointerId: 1,
    isPrimary: true,
    button: 0,
  });
  fireEvent.pointerUp(button, { pointerType: "mouse", pointerId: 1, isPrimary: true, button: 0 });
  fireEvent.click(button, { detail: 1 });
}

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

function validatingWorkflow(): MultiReviewWorkflow {
  const workflow = reviewingWorkflow();
  workflow.phase = "preparing";
  workflow.validationRun = {
    id: "validation-1",
    status: "running",
    startedAt: "2026-09-08T20:00:04.000Z",
    plan: {
      headRef: "a".repeat(40),
      commands: [
        {
          id: "test",
          command: "mise run test",
          cwd: ".",
          dependsOn: [],
          resources: ["workspace:test"],
          weight: 2,
          timeoutMs: 1_200_000,
        },
      ],
      limitations: [],
    },
    results: [
      {
        id: "test",
        command: "mise run test",
        status: "running",
        exitCode: null,
        stdoutPath: ".orkestrator/test.stdout",
        stderrPath: ".orkestrator/test.stderr",
        stdoutBytes: 0,
        stderrBytes: 0,
        startedAt: "2026-09-08T20:00:05.000Z",
        durationMs: 0,
        limitation: null,
      },
    ],
  };
  return workflow;
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

function ReviewMountDuringPointerGesture({
  workflow,
  createTab,
}: {
  workflow: MultiReviewWorkflow;
  createTab: (type: CreatableTabType, options?: CreateTabOptions) => boolean;
}) {
  const [reviewMounted, setReviewMounted] = useState(false);

  return (
    <TerminalProvider>
      <TabRegistrar createTab={createTab} />
      {reviewMounted ? (
        <MultiReviewTab
          data={{ environmentId: workflow.environmentId, workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      ) : (
        <button type="button" onPointerDown={() => setReviewMounted(true)}>
          Launch review
        </button>
      )}
    </TerminalProvider>
  );
}

beforeEach(() => {
  useMultiReviewStore.setState({ workflows: new Map() });
  useMessagePartExpansionStore.getState().reset();
});
afterEach(cleanup);

describe("MultiReviewTab pipeline pass routing", () => {
  test.each([
    { isActive: true, ownsGlobalShortcuts: undefined, expectedShortcuts: true },
    { isActive: false, ownsGlobalShortcuts: undefined, expectedShortcuts: false },
    { isActive: true, ownsGlobalShortcuts: false, expectedShortcuts: false },
    { isActive: false, ownsGlobalShortcuts: true, expectedShortcuts: true },
  ])(
    "forwards pipeline identity and activity: %j",
    ({ isActive, ownsGlobalShortcuts, expectedShortcuts }) => {
      const viewer = spyOn(pipelineReviewTab, "PipelineReviewTab").mockImplementation(() => <></>);
      const hydrateWorkflow = mock(async () => null);
      try {
        render(
          <MultiReviewTab
            data={{
              workflowId: "build-pipeline-routing",
              environmentId: "pipeline-environment",
              pipelinePass: "review-pass-2",
              reviewerId: "ignored-standalone-reviewer",
              isLocal: true,
            }}
            isActive={isActive}
            ownsGlobalShortcuts={ownsGlobalShortcuts}
            hydrateWorkflow={hydrateWorkflow}
          />,
        );
        expect(viewer).toHaveBeenCalled();
        expect(viewer.mock.calls.at(-1)?.[0]).toEqual({
          pipelineId: "build-pipeline-routing",
          environmentId: "pipeline-environment",
          passKey: "review-pass-2",
          isActive,
          ownsGlobalShortcuts: expectedShortcuts,
        });
        expect(hydrateWorkflow).not.toHaveBeenCalled();
      } finally {
        viewer.mockRestore();
      }
    },
  );
});

describe("MultiReviewTab backend snapshot viewer", () => {
  test("reads the PR stage from the launch, its agent and the environment's pull request", () => {
    const requestId = "multi-review-pr:multi-1";
    const launched = { state: "launched" as const, requestId, tabId: "agent-job-pr" };
    const base = {
      autoPr: true,
      launch: undefined,
      prUrl: null,
      prState: null,
      agentPhase: undefined,
      upstreamComplete: false,
    };
    expect(pullRequestStep(base)).toMatchObject({ state: "not-started", pendingLabel: "waiting" });
    expect(pullRequestStep({ ...base, autoPr: false })).toMatchObject({
      state: "not-started",
      pendingLabel: "manual",
    });
    expect(pullRequestStep({ ...base, launch: { state: "pending", requestId } })).toMatchObject({
      state: "running",
      statusWord: { text: "launching" },
    });
    expect(pullRequestStep({ ...base, launch: launched, agentPhase: "running" })).toMatchObject({
      state: "running",
      statusWord: { text: "working" },
    });
    expect(pullRequestStep({ ...base, launch: launched, agentPhase: "blocked" })).toMatchObject({
      state: "running",
      statusWord: { text: "needs input", tone: "warning" },
    });
    expect(pullRequestStep({ ...base, launch: launched })).toMatchObject({
      state: "paused",
      statusWord: { text: "status unknown" },
    });
    expect(
      pullRequestStep({
        ...base,
        launch: launched,
        agentPhase: "running",
        prUrl: "https://github.com/o/r/pull/42",
      }),
    ).toMatchObject({
      state: "complete",
      label: "Pull request open",
    });
    // A settled agent without a detected pull request does not claim one.
    expect(pullRequestStep({ ...base, launch: launched, agentPhase: "idle" })).toMatchObject({
      state: "complete",
      statusWord: { text: "no PR yet", tone: "warning" },
    });
    expect(pullRequestStep({ ...base, launch: launched, agentPhase: "error" }).state).toBe(
      "failed",
    );
    expect(
      pullRequestStep({
        ...base,
        launch: launched,
        agentPhase: "idle",
        prUrl: "https://github.com/o/r/pull/42",
        prState: "merged",
      }),
    ).toMatchObject({ state: "complete", label: "Pull request merged" });
    // A pull request opened by hand counts once the Fix is done, not before.
    const manual = { ...base, autoPr: false, prUrl: "https://github.com/o/r/pull/42" };
    expect(pullRequestStep(manual).state).toBe("not-started");
    expect(pullRequestStep({ ...manual, upstreamComplete: true }).state).toBe("complete");
    expect(
      pullRequestStep({
        ...base,
        launch: { state: "skipped", requestId, message: "PR exists" },
      }),
    ).toMatchObject({ state: "not-started", pendingLabel: "skipped", label: "PR exists" });
    expect(
      pullRequestStep({ ...base, launch: { state: "failed", requestId, message: "tab limit" } }),
    ).toMatchObject({ state: "failed", error: expect.stringContaining("tab limit") });

    expect(pullRequestDetail("https://github.com/o/r/pull/42", "main")).toBe("#42 · into main");
    expect(pullRequestDetail(null, "main")).toBe("into main");
  });

  test("shows the opened pull request as the PR node", () => {
    const workflow: MultiReviewWorkflow = {
      ...readyWorkflow(),
      phase: "interactive",
      autoPr: true,
      autoPrLaunch: {
        state: "launched",
        requestId: "multi-review-pr:multi-1",
        tabId: "agent-job-pr",
      },
    };
    const environments = useEnvironmentStore.getState().environments;
    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          prUrl: "https://github.com/o/r/pull/42",
          prState: "open",
        } as Environment,
      ],
    });
    try {
      useMultiReviewStore.getState().replaceWorkflow(workflow);
      render(
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />,
      );
      const pr = flowNode("Pull request,");
      expect(pr.getAttribute("data-flow-state")).toBe("complete");
      expect(within(pr).getByText(`#42 · into ${workflow.targetBranch}`)).toBeTruthy();
      fireEvent.click(pr);
      expect(screen.getByRole("button", { name: "View pull request" })).toBeTruthy();
      // The PR tab is not in this layout, so there is no session to show.
      expect(
        (screen.getByRole("button", { name: "Open PR session" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    } finally {
      useEnvironmentStore.setState({ environments });
    }
  });

  test("reports each auto-PR launch state after the Fix completes", () => {
    const requestId = "multi-review-pr:multi-1";
    expect(autoPrLaunchNotice({ state: "pending", requestId })).toMatchObject({ tone: "muted" });
    expect(
      autoPrLaunchNotice({ state: "launched", requestId, tabId: "agent-job-pr" }).text,
    ).toContain("PR tab was launched");
    expect(
      autoPrLaunchNotice({
        state: "skipped",
        requestId,
        message: "A pull request already exists.",
      }),
    ).toEqual({ text: "A pull request already exists.", tone: "muted" });
    expect(
      autoPrLaunchNotice({
        state: "skipped",
        requestId,
        message: "Review the interactive Fix, then use the PR button to create a pull request.",
      }).text,
    ).toContain("use the PR button");
    expect(
      autoPrLaunchNotice({ basis: "clean-review", state: "launched", requestId, tabId: "pr" }),
    ).toEqual({
      text: "The review found nothing to fix, so a PR tab was launched to commit, push, and open the pull request.",
      tone: "success",
    });
    expect(autoPrLaunchNotice({ basis: "clean-review", state: "pending", requestId }).text).toMatch(
      /^The review found nothing to fix\. /,
    );
    const failed = autoPrLaunchNotice({ state: "failed", requestId, message: "tab limit" });
    expect(failed.tone).toBe("warning");
    expect(failed.text).toContain(": tab limit");
    expect(failed.text).toContain("Use the PR button");

    const workflow: MultiReviewWorkflow = {
      ...readyWorkflow(),
      phase: "interactive",
      autoPr: true,
      autoPrLaunch: { state: "launched", requestId, tabId: "agent-job-pr" },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
      />,
    );
    expect(screen.queryByTestId("multi-review-auto-pr-notice") === null).toBe(true);
    expect(
      screen.queryByText("The fix request was delivered. The fix session is ready to open.") ===
        null,
    ).toBe(true);
    selectFlowNode("Pull request,");
    expect(inspector().getByText(/The fix completed, so a PR tab was launched/)).toBeTruthy();
  });

  test.each(["pending", "failed", "skipped"] as const)(
    "keeps the %s post-fix PR launch notice visible",
    (state) => {
      const launch = {
        state,
        requestId: "multi-review-pr:multi-1",
        message: "A pull request already exists.",
      };
      const workflow: MultiReviewWorkflow = {
        ...readyWorkflow(),
        phase: "interactive",
        autoPr: true,
        autoPrLaunch: launch,
      };
      useMultiReviewStore.getState().replaceWorkflow(workflow);
      render(
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />,
      );
      expect(screen.getByTestId("multi-review-auto-pr-notice").textContent).toContain(
        autoPrLaunchNotice(launch).text,
      );
    },
  );

  test.each(["ready", "interactive", "reviewing", "consolidating"] as const)(
    "hides a retained clean-review notice after moving to %s with findings",
    (phase) => {
      const workflow: MultiReviewWorkflow = {
        ...readyWorkflow(),
        autoPr: true,
        consolidatedReport: { ...report, issues: [], testCoverageGaps: [] },
        autoPrLaunch: {
          basis: "clean-review",
          state: "launched",
          requestId: "multi-review-pr:multi-1",
          tabId: "agent-job-pr",
        },
      };
      useMultiReviewStore.getState().replaceWorkflow(workflow);
      const view = render(
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />,
      );
      expect(screen.getByTestId("multi-review-auto-pr-notice").textContent).toContain(
        "The review found nothing to fix",
      );
      const moved = { ...workflow, phase, consolidatedReport: report };
      act(() => useMultiReviewStore.getState().replaceWorkflow(moved));
      expect(screen.queryByTestId("multi-review-auto-pr-notice") === null).toBe(true);
      const assertCurrentReview = () => {
        expect(flowNode("Pull request,").dataset.flowState).toBe("not-started");
        expect(flowNode("Pull request,").getAttribute("aria-selected")).toBe("false");
        const edge = document.querySelector('[data-flow-edge="into-pr"]')!;
        expect(edge.getAttribute("data-edge-state")).toBe("pending");
        const fixRect = document.querySelector<HTMLElement>('[data-flow-node="fix"]')!;
        expect(edge.getAttribute("d")).toStartWith(
          `M${parseFloat(fixRect.style.left) + parseFloat(fixRect.style.width)} `,
        );
        selectFlowNode("Pull request,");
        expect(inspector().queryByText(/The review found nothing to fix/) === null).toBe(true);
        expect(inspector().getByText(/earlier review/)).toBeTruthy();
      };
      assertCurrentReview();
      // A fresh mount reads the same persisted snapshot, without the transition event.
      view.unmount();
      render(
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => moved)}
        />,
      );
      expect(screen.queryByTestId("multi-review-auto-pr-notice") === null).toBe(true);
      assertCurrentReview();
    },
  );

  test.each(["interactive", "reviewing", "consolidating"] as const)(
    "hides the clean-review notice in %s even while the old clean report remains",
    (phase) => {
      const workflow: MultiReviewWorkflow = {
        ...readyWorkflow(),
        phase,
        consolidatedReport: { ...report, issues: [], testCoverageGaps: [] },
        autoPrLaunch: { basis: "clean-review", state: "launched", requestId: "pr" },
      };
      useMultiReviewStore.getState().replaceWorkflow(workflow);
      render(
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />,
      );
      expect(screen.queryByTestId("multi-review-auto-pr-notice") === null).toBe(true);
    },
  );

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
      // Usage the provider has not reported yet shows as a neutral dash.
      expect(screen.getByLabelText("Reviewer 2 runtime and token usage").textContent).toBe(
        "1m 35s · —",
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

  test("shows severity counts on completed reviewer nodes and totals in their names", () => {
    const ready = readyWorkflow();
    ready.reviewers[1]!.report = {
      ...report,
      issues: [...report.issues, { ...report.issues[0]!, title: "Second finding" }],
      testCoverageGaps: [],
    };
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );

    const firstReviewer = screen.getByRole("tab", {
      name: "Reviewer 1 · claude, Complete, 1 issue found, 1 coverage gap found",
    });
    const firstP1 = within(firstReviewer).getByTitle("1 P1 issue");
    expect(firstP1.textContent).toBe("1");
    // The chips use the report's own severity colours.
    expect(firstP1.className).toContain("text-amber-300");
    expect(firstReviewer.querySelectorAll("[data-severity]")).toHaveLength(1);

    const secondReviewer = screen.getByRole("tab", {
      name: "Reviewer 2 · codex, Complete, 2 issues found, 0 coverage gaps found",
    });
    expect(within(secondReviewer).getByTitle("2 P1 issues").textContent).toBe("2");

    // The inspector's Open session keeps the counts in its accessible name.
    fireEvent.click(secondReviewer);
    expect(
      inspector().getByRole("button", {
        name: "Open Reviewer 2 transcript, 2 issues found, 0 coverage gaps found",
      }),
    ).toBeTruthy();
    expect(inspector().getByText("2 issues found, 0 coverage gaps found")).toBeTruthy();
  });

  test("does not show finding counts before a reviewer has produced a report", () => {
    const reviewing = reviewingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(reviewing);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: reviewing.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => reviewing)}
      />,
    );

    expect(screen.queryByRole("tab", { name: /issues? found/ }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: /issues? found/ }) === null).toBe(true);
    expect(document.querySelectorAll("[data-severity]")).toHaveLength(0);
  });

  test("does not stack a preparing-report spinner on a running reviewer tile", () => {
    const reviewing = reviewingWorkflow();
    reviewing.reviewers[0]!.resultTransport = "tool-v1";
    reviewing.reviewers[0]!.resultSubmission = "preparing";
    reviewing.reviewers[1]!.resultTransport = "tool-v1";
    reviewing.reviewers[1]!.resultSubmission = "correcting";
    useMultiReviewStore.getState().replaceWorkflow(reviewing);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: reviewing.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => reviewing)}
      />,
    );

    const preparingNode = flowNode("Reviewer 1 ·");
    const correctingNode = flowNode("Reviewer 2 ·");

    // Each node keeps exactly one status spinner; the slot state never adds one.
    expect(screen.queryByText("Preparing report") === null).toBe(true);
    expect(preparingNode.querySelectorAll("svg.animate-spin")).toHaveLength(1);
    expect(within(preparingNode).getByText("reviewing")).toBeTruthy();
    expect(correctingNode.querySelectorAll("svg.animate-spin")).toHaveLength(1);
    expect(within(correctingNode).getByText("correcting report")).toBeTruthy();

    // The first running reviewer is inspected by default; its preparing slot
    // is not reported as a separate status.
    expect(inspector().queryByTestId("workflow-result-status") === null).toBe(true);
    fireEvent.click(correctingNode);
    expect(inspector().getByText("Correcting report format")).toBeTruthy();
    expect(screen.getAllByTestId("workflow-result-status")).toHaveLength(1);
  });

  test("keeps received and needs-attention report status on reviewer tiles", () => {
    const reviewing = reviewingWorkflow();
    reviewing.reviewers[0]!.resultTransport = "tool-v1";
    reviewing.reviewers[0]!.resultSubmission = "received";
    reviewing.reviewers[1]!.resultTransport = "tool-v1";
    reviewing.reviewers[1]!.resultSubmission = "needs-attention";
    useMultiReviewStore.getState().replaceWorkflow(reviewing);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: reviewing.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => reviewing)}
      />,
    );

    expect(within(flowNode("Reviewer 1 ·")).getByText("report received")).toBeTruthy();
    const attentionWord = within(flowNode("Reviewer 2 ·")).getByText("report needs attention");
    expect(attentionWord.className).toContain("text-amber-500");

    const received = inspector().getByTestId("workflow-result-status");
    expect(received.dataset.state).toBe("received");
    expect(received.textContent).toBe("Report received; finishing checks");

    selectFlowNode("Reviewer 2 ·");
    const needsAttention = inspector().getByTestId("workflow-result-status");
    expect(needsAttention.dataset.state).toBe("needs-attention");
    expect(needsAttention.textContent).toBe("Report needs attention");
    expect(screen.getAllByTestId("workflow-result-status")).toHaveLength(1);
  });

  test("hides a stale preparing-report status on failed and cancelled reviewer tiles", () => {
    const settled = readyWorkflow();
    settled.phase = "failed";
    settled.reviewers = [
      {
        ...settled.reviewers[0]!,
        status: "failed",
        resultTransport: "tool-v1",
        resultSubmission: "preparing",
        error: "Reviewer failed after the slot was prepared",
      },
      {
        ...settled.reviewers[1]!,
        status: "cancelled",
        resultTransport: "tool-v1",
        resultSubmission: "preparing",
      },
    ];
    useMultiReviewStore.getState().replaceWorkflow(settled);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: settled.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => settled)}
      />,
    );

    for (const reviewer of ["Reviewer 1 ·", "Reviewer 2 ·"]) {
      selectFlowNode(reviewer);
      expect(screen.queryByText("Preparing report") === null).toBe(true);
      expect(screen.queryByTestId("workflow-result-status") === null).toBe(true);
    }
  });

  test("keeps partial-report counts visible for failed and cancelled reviewers", () => {
    const settled = readyWorkflow();
    settled.phase = "failed";
    settled.reviewers = [
      { ...settled.reviewers[0]!, status: "failed", error: "Reviewer failed after reporting" },
      { ...settled.reviewers[1]!, status: "cancelled" },
    ];
    useMultiReviewStore.getState().replaceWorkflow(settled);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: settled.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => settled)}
      />,
    );

    const failed = screen.getByRole("tab", {
      name: "Reviewer 1 · claude, Failed, 1 issue found, 1 coverage gap found",
    });
    const stopped = screen.getByRole("tab", {
      name: "Reviewer 2 · codex, Stopped, 1 issue found, 1 coverage gap found",
    });
    expect(within(failed).getByTitle("1 P1 issue")).toBeTruthy();
    expect(within(stopped).getByTitle("1 P1 issue")).toBeTruthy();
    // Partial reports are not findings so far: only completed reviewers count.
    fireEvent.click(screen.getByTestId("multi-review-findings-badge"));
    expect(screen.getByTestId("multi-review-findings-count").textContent).toBe(
      "0 · from 0 reviewers",
    );
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

  test("keeps the preparation and command clocks live after the model hands off to validation", () => {
    const originalNow = Date.now;
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    let now = Date.parse("2026-09-08T20:00:10.000Z");
    let tick: (() => void) | undefined;
    Date.now = () => now;
    window.setInterval = ((callback: TimerHandler) => {
      tick = callback as () => void;
      return 42;
    }) as typeof window.setInterval;
    window.clearInterval = mock(() => undefined) as typeof window.clearInterval;

    const workflow = readyWorkflow();
    workflow.phase = "preparing";
    workflow.reviewers = workflow.reviewers.map((reviewer) => ({
      ...reviewer,
      status: "pending",
      providerSessionId: undefined,
      report: undefined,
    }));
    delete workflow.consolidatedReport;
    workflow.fixSession = { ...workflow.fixSession!, status: "idle", completedAt: undefined };
    workflow.stepRuntimes = { prepare: { startedAt: "2026-09-08T20:00:00.000Z" } };
    workflow.validationRun = {
      id: "validation-1",
      status: "running",
      startedAt: "2026-09-08T20:00:04.000Z",
      plan: {
        headRef: "a".repeat(40),
        commands: [
          {
            id: "check",
            command: "bun run check",
            cwd: ".",
            dependsOn: [],
            resources: ["next"],
            weight: 2,
            timeoutMs: 1_200_000,
          },
        ],
        limitations: [],
      },
      results: [
        {
          id: "check",
          command: "bun run check",
          status: "running",
          exitCode: null,
          stdoutPath: ".orkestrator/check.stdout",
          stderrPath: ".orkestrator/check.stderr",
          stdoutBytes: 0,
          stderrBytes: 0,
          startedAt: "2026-09-08T20:00:05.000Z",
          durationMs: 0,
          limitation: null,
        },
      ],
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);

    const view = render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
      />,
    );
    try {
      expect(screen.getByLabelText("Review package generation runtime").textContent).toContain(
        "10s",
      );
      const validationRow = () =>
        screen
          .getByRole("button", { name: "View terminal output for bun run check" })
          .closest("tr")!;
      expect(validationRow().textContent).toContain("running");
      expect(validationRow().querySelector("[data-slot='validation-elapsed']")?.textContent).toBe(
        "5.0s",
      );

      now = Date.parse("2026-09-08T20:00:13.000Z");
      act(() => tick?.());

      expect(screen.getByLabelText("Review package generation runtime").textContent).toContain(
        "13s",
      );
      expect(validationRow().textContent).toContain("running");
      expect(validationRow().querySelector("[data-slot='validation-elapsed']")?.textContent).toBe(
        "8.0s",
      );
    } finally {
      view.unmount();
      Date.now = originalNow;
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test("places validation and the package transcript in separate split columns", () => {
    const workflow = validatingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(workflow);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
      />,
    );

    const split = screen.getByTestId("multi-review-step-split");
    expect(split.className).toContain("@min-[88rem]:grid-cols-2");
    expect(split.children).toHaveLength(2);
    expect(
      split.querySelector(":scope > div:first-child [aria-label='Review validation']"),
    ).not.toBeNull();
    expect(
      split.querySelector(":scope > div:last-child [data-testid='multi-review-transcript-tail']"),
    ).not.toBeNull();
  });

  test("preserves the package transcript and its source token when validation arrives", async () => {
    const validated = validatingWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...validated,
      validationRun: undefined,
      reviewSession: {
        agent: "codex",
        model: "gpt-5.6",
        sessionKey: "multi-review:multi-1:prepare",
        providerSessionId: "prepare-session",
        requestIds: ["prepare-1"],
        status: "running",
        startedAt: validated.createdAt,
      },
    };
    const snapshot: MultiReviewStepTranscript = {
      workflowId: workflow.id,
      step: "prepare",
      workflowPhase: "preparing",
      session: "own",
      agent: "codex",
      transcript: "snapshot",
      sourceToken: "package-output-1",
      messages: [{ id: "output-1", role: "assistant", content: "Preparing validation commands" }],
    };
    const loadStepTranscript = mock(
      async (_id: string, _step: MultiReviewStepKind, options?: { knownSourceToken?: string }) =>
        options?.knownSourceToken === snapshot.sourceToken
          ? { ...snapshot, transcript: "unchanged" as const, messages: [] }
          : snapshot,
    );
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
        loadStepTranscript={loadStepTranscript}
      />,
    );
    const tail = screen.getByRole("log", { name: "Latest review package generation activity" });
    await waitFor(() => expect(tail.textContent).toContain("Preparing validation commands"));
    const message = within(tail).getByText("Preparing validation commands");
    expect(screen.queryByLabelText("Review validation") === null).toBe(true);

    act(() => {
      useMultiReviewStore.getState().replaceWorkflow({
        ...workflow,
        validationRun: validated.validationRun,
        backendRevision: workflow.backendRevision + 1,
      });
    });

    await waitFor(() =>
      expect(loadStepTranscript).toHaveBeenLastCalledWith(workflow.id, "prepare", {
        knownSourceToken: snapshot.sourceToken,
      }),
    );
    expect(screen.getByLabelText("Review validation")).toBeTruthy();
    expect(screen.getByRole("log", { name: "Latest review package generation activity" })).toBe(
      tail,
    );
    expect(tail.textContent).toContain("Preparing validation commands");
    expect(within(tail).getByText("Preparing validation commands")).toBe(message);
  });

  test("stops validation while keeping Multi Review on course for the reviewer step", async () => {
    const workflow = validatingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const stopping = {
      ...workflow,
      validationStopRequested: true,
      backendRevision: workflow.backendRevision + 1,
    };
    const stopValidation = mock(async () => stopping);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
        commands={{
          address: mock(async () => workflow),
          retry: mock(async () => workflow),
          cancel: mock(async () => workflow),
          stopValidation,
          stopReviewer: mock(async () => workflow),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop tests and continue" }));
    await waitFor(() => expect(stopValidation).toHaveBeenCalledWith(workflow.id));
    expect(useMultiReviewStore.getState().workflows.get(workflow.id)).toMatchObject({
      validationStopRequested: true,
    });
    expect(screen.getByText("Stopping")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Stopping tests…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("surfaces a stop-validation failure and makes the control usable again", async () => {
    const workflow = validatingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const stopValidation = mock(async () => {
      throw new Error("Validation cancellation failed");
    });

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
        commands={{
          address: mock(async () => workflow),
          retry: mock(async () => workflow),
          cancel: mock(async () => workflow),
          stopValidation,
          stopReviewer: mock(async () => workflow),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop tests and continue" }));
    await waitFor(() => expect(screen.getByText("Validation cancellation failed")).toBeTruthy());
    const retry = screen.getByRole("button", { name: "Stop tests and continue" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(stopValidation).toHaveBeenCalledTimes(2));
  });

  test("suppresses stop validation while another workflow command is pending", async () => {
    const workflow = validatingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    let finishCancel!: (value: MultiReviewWorkflow) => void;
    const cancel = mock(
      () =>
        new Promise<MultiReviewWorkflow>((resolve) => {
          finishCancel = resolve;
        }),
    );
    const stopValidation = mock(async () => workflow);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
        commands={{
          address: mock(async () => workflow),
          retry: mock(async () => workflow),
          cancel,
          stopValidation,
          stopReviewer: mock(async () => workflow),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Stop tests and continue" }));
    expect(stopValidation).not.toHaveBeenCalled();
    await act(async () => finishCancel(workflow));
  });

  test("does not show a stale stopping state after validation has failed", () => {
    const workflow = validatingWorkflow();
    workflow.phase = "failed";
    workflow.error = "Packaging failed";
    workflow.validationStopRequested = true;
    workflow.validationRun!.status = "cancelled";
    workflow.validationRun!.completedAt = "2026-09-08T20:00:10.000Z";
    useMultiReviewStore.getState().replaceWorkflow(workflow);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
      />,
    );

    // Validation belongs to the package node; the running reviewers are
    // inspected by default.
    selectFlowNode("Review package");
    expect(screen.queryByText("Stopping") === null).toBe(true);
    expect(inspector().getByText("cancelled")).toBeTruthy();
  });

  test("keeps a running validation clock live while the workflow is cancelling", () => {
    const originalNow = Date.now;
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    let now = Date.parse("2026-09-08T20:00:10.000Z");
    let tick: (() => void) | undefined;
    Date.now = () => now;
    window.setInterval = ((callback: TimerHandler) => {
      tick = callback as () => void;
      return 43;
    }) as typeof window.setInterval;
    window.clearInterval = mock(() => undefined) as typeof window.clearInterval;

    const workflow = readyWorkflow();
    workflow.phase = "cancelling";
    workflow.validationRun = {
      id: "validation-cancelling",
      status: "running",
      startedAt: "2026-09-08T20:00:04.000Z",
      plan: {
        headRef: "a".repeat(40),
        commands: [
          {
            id: "check",
            command: "bun run check",
            cwd: ".",
            dependsOn: [],
            resources: ["*"],
            weight: 2,
            timeoutMs: 1_200_000,
          },
        ],
        limitations: [],
      },
      results: [
        {
          id: "check",
          command: "bun run check",
          status: "running",
          exitCode: null,
          stdoutPath: ".orkestrator/check.stdout",
          stderrPath: ".orkestrator/check.stderr",
          stdoutBytes: 0,
          stderrBytes: 0,
          startedAt: "2026-09-08T20:00:05.000Z",
          durationMs: 0,
          limitation: null,
        },
      ],
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);

    const view = render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
      />,
    );
    try {
      selectFlowNode("Review package");
      expect(screen.getByText(/Validation: 6\.0s\./)).toBeTruthy();
      now = Date.parse("2026-09-08T20:00:13.000Z");
      act(() => tick?.());
      expect(screen.getByText(/Validation: 9\.0s\./)).toBeTruthy();
    } finally {
      view.unmount();
      Date.now = originalNow;
      window.setInterval = originalSetInterval;
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

    selectFlowNode("Reviewer 1 ·");
    fireEvent.click(inspector().getByRole("button", { name: /^Open Reviewer 1 transcript/ }));
    expect(openReviewer).toHaveBeenCalledWith("reviewer-1", 0);

    // Double-clicking a node opens its session as well.
    fireEvent.doubleClick(flowNode("Reviewer 2 ·"));
    expect(openReviewer).toHaveBeenLastCalledWith("reviewer-2", 1);
    // Enter on a focused node does the same.
    fireEvent.keyDown(flowNode("Reviewer 1 ·"), { key: "Enter" });
    expect(openReviewer).toHaveBeenCalledTimes(3);
  });

  test("shows a node's report in a tab beside its transcript", () => {
    const ready = readyWorkflow();
    ready.reviewers[1] = { ...ready.reviewers[1]!, report: undefined };
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );

    // The transcript is shown first; the report waits behind its own tab.
    selectFlowNode("Reviewer 1 ·");
    expect(inspector().getByRole("tab", { name: "Transcript" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(inspector().getByTestId("multi-review-transcript-tail")).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Reviewer report" }) === null).toBe(true);

    showInspectorTab("Report");
    expect(screen.getByRole("article", { name: "Reviewer report" })).toBeTruthy();
    // The transcript stays mounted, hidden, so it keeps its place.
    expect(
      inspector().getByTestId("multi-review-transcript-tail").closest("[data-state=inactive]"),
    ).toBeTruthy();

    // A reviewer without a report has only its transcript.
    selectFlowNode("Reviewer 2 ·");
    expect(inspector().getByTestId("multi-review-transcript-tail")).toBeTruthy();
    expect(inspector().queryByRole("tablist") === null).toBe(true);
    expect(inspector().queryByRole("tab", { name: "Transcript" }) === null).toBe(true);
    expect(inspector().queryByRole("tab", { name: "Report" }) === null).toBe(true);

    // Each node remembers which tab was last shown.
    selectFlowNode("Reviewer 1 ·");
    expect(screen.getByRole("article", { name: "Reviewer report" })).toBeTruthy();
  });

  test("navigates inspector views from the keyboard without changing the pipeline selection", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );

    const node = selectFlowNode("Reviewer 1 ·");
    const views = within(inspector().getByRole("tablist", { name: "Inspector views" }));
    act(() => views.getByRole("tab", { name: "Transcript" }).focus());
    for (const [key, name] of [
      ["ArrowRight", "Report"],
      ["ArrowLeft", "Transcript"],
      ["End", "Report"],
      ["Home", "Transcript"],
      ["ArrowLeft", "Report"],
      ["ArrowRight", "Transcript"],
    ]) {
      fireEvent.keyDown(document.activeElement!, { key });
      await waitFor(() => {
        const selected = views.getByRole("tab", { name });
        expect(document.activeElement === selected).toBe(true);
        expect(selected.getAttribute("aria-selected")).toBe("true");
      });
      const pipeline = within(screen.getByRole("tablist", { name: "Multi Review pipeline" }));
      expect(pipeline.getAllByRole("tab", { selected: true }).length).toBe(1);
      expect(pipeline.getByRole("tab", { selected: true }) === node).toBe(true);
      expect(inspector().getByRole("heading", { name: /^Reviewer 1 ·/ }).textContent).toBe(
        "Reviewer 1 · claude",
      );
    }
  });

  test("shows the focus each reviewer was launched with", () => {
    const ready = readyWorkflow();
    ready.reviewers[0]!.lens = { label: "Security", instruction: "Trace untrusted input." };
    useMultiReviewStore.getState().replaceWorkflow(ready);
    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );
    expect(flowNode("Reviewer 1 ·").textContent).toContain("Focus: Security");
    expect(flowNode("Reviewer 2 ·").textContent).not.toContain("Focus:");
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

    selectFlowNode("Reviewer 1 ·");
    const withoutSession = inspector().getByRole("button", {
      name: /^Open Reviewer 1 transcript/,
    });
    expect(withoutSession.hasAttribute("disabled")).toBe(true);
    fireEvent.click(withoutSession);
    fireEvent.doubleClick(flowNode("Reviewer 1 ·"));
    expect(openReviewer).not.toHaveBeenCalled();

    // The sibling reviewer still has a session and stays reachable.
    selectFlowNode("Reviewer 2 ·");
    expect(
      inspector()
        .getByRole("button", { name: /^Open Reviewer 2 transcript/ })
        .hasAttribute("disabled"),
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

    selectFlowNode("Reviewer 1 ·");
    expect(
      inspector()
        .getByRole("button", { name: /^Open Reviewer 1 transcript/ })
        .hasAttribute("disabled"),
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

    // Each node carries a one-line excerpt; the inspector shows the whole note.
    expect(flowNode("Reviewer 2 ·").querySelector("[data-flow-node-error]")?.textContent).toBe(
      "The reviewer session no longer exists",
    );
    selectFlowNode("Reviewer 2 ·");
    const reviewerError = await inspector().findByText("The reviewer session no longer exists");
    selectFlowNode("Reviewer 1 ·");
    expect(await inspector().findByText("The reviewer session failed")).toBeTruthy();
    expect(reviewerError.className).toContain("whitespace-normal");
    expect(reviewerError.className).toContain("break-words");
    expect(reviewerError.className).toContain("[overflow-wrap:anywhere]");
    expect(reviewerError.className).not.toContain("truncate");
  });

  test("names a reviewer whose agent could not start, with why, above the graph (todo 1090)", async () => {
    const reason = "codex bridge directory not found: /data/resources/codex-bridge";
    const ready = readyWorkflow();
    ready.phase = "reviewing";
    ready.reviewers[1] = {
      ...ready.reviewers[1]!,
      status: "failed",
      error: reason,
      startFailed: true,
    };
    delete ready.reviewers[1]!.providerSessionId;
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );

    const notice = await screen.findByTestId("reviewer-start-failures");
    expect(notice.textContent).toContain(
      "Reviewer 2 (Codex) could not start, so this review is missing its findings.",
    );
    expect(notice.textContent).toContain(`Reviewer 2 · Codex: ${reason}`);
    // The node's status names it too; its face shows the reason.
    expect(flowNode("Reviewer 2 ·").getAttribute("aria-label")).toContain("Could not start");
    expect(flowNode("Reviewer 2 ·").querySelector("[data-flow-node-error]")?.textContent).toBe(
      reason,
    );
  });

  test("a reviewer that failed after it started raises no start notice", async () => {
    const ready = readyWorkflow();
    ready.reviewers[0] = { ...ready.reviewers[0]!, status: "failed", error: "Session failed" };
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );

    await screen.findAllByText("Session failed");
    expect(screen.queryByTestId("reviewer-start-failures") === null).toBe(true);
  });

  test("bounds a long reviewer failure while keeping its complete text available", async () => {
    const ready = readyWorkflow();
    const longReviewerError = `Provider failure: ${"unbroken-session-token/".repeat(256)}`;
    ready.phase = "failed";
    ready.error = "No reviewer produced a valid report";
    ready.reviewers[0] = {
      ...ready.reviewers[0]!,
      status: "failed",
      error: longReviewerError,
    };
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );

    selectFlowNode("Reviewer 1 ·");
    const reviewerError = await screen.findByTestId("multi-reviewer-note-reviewer-1");
    expect(reviewerError.textContent).toBe(longReviewerError);
    expect(reviewerError.getAttribute("title")).toBe(longReviewerError);
    expect(reviewerError.className).toContain("max-h-16");
    expect(reviewerError.className).toContain("overflow-x-hidden");
    expect(reviewerError.className).toContain("overflow-y-auto");
    expect(reviewerError.className).toContain("overscroll-contain");
    expect(reviewerError.className).toContain("whitespace-normal");
    expect(reviewerError.className).toContain("break-words");
    expect(reviewerError.className).toContain("[overflow-wrap:anywhere]");
    expect(reviewerError.className).not.toContain("truncate");
    expect(reviewerError.className).not.toContain("line-clamp");
  });

  test("says where a read-only step's commands ran without the sandbox (todo 0190)", async () => {
    const reason = "Claude's command sandbox cannot run commands on this host: bwrap is missing.";
    const ready = readyWorkflow();
    ready.reviewers[0] = { ...ready.reviewers[0]!, commandSandboxOff: reason };
    ready.stepRuntimes = {
      consolidate: {
        startedAt: "2026-10-28T10:00:00.000Z",
        completedAt: "2026-10-28T10:05:00.000Z",
        commandSandboxOff: reason,
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );

    selectFlowNode("Reviewer 1 ·");
    const note = await screen.findByTestId("multi-reviewer-sandbox-off-reviewer-1");
    expect(note.textContent).toBe(readOnlyCommandSandboxOffNote(reason));
    expect(note.textContent).toContain("read-only command filter");
    expect(note.getAttribute("title")).toBe(readOnlyCommandSandboxOffNote(reason));
    // A reviewer whose host had a sandbox says nothing.
    selectFlowNode("Reviewer 2 ·");
    await inspector().findByText(/Read only/);
    expect(screen.queryByTestId("multi-reviewer-sandbox-off-reviewer-2") === null).toBe(true);

    selectFlowNode("Consolidation");
    expect((await screen.findByTestId("multi-review-consolidation-sandbox-off")).textContent).toBe(
      readOnlyCommandSandboxOffNote(reason),
    );
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

    selectFlowNode("Consolidation");
    expect(screen.queryByRole("article", { name: "Consolidated Multi Review" }) === null).toBe(
      true,
    );
    showInspectorTab("Report");
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

    expect(await screen.findByRole("button", { name: "Open fix session" })).toBeTruthy();
    expect(screen.queryByText(/fix session is ready to open/i) === null).toBe(true);
    expect(createTab).not.toHaveBeenCalled();

    view.rerender(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab {...props} isActive />
      </TerminalProvider>,
    );
    expect(screen.getByRole("button", { name: "Open fix session" })).toBeTruthy();
    expect(screen.queryByText(/fix session is ready to open/i) === null).toBe(true);
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
    expect(screen.queryByText(/fix session is ready to open/i) === null).toBe(true);
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

  test("resumes the consolidation session but allows a missing session to be recovered", () => {
    const ready = readyWorkflow();
    expect(multiReviewFixSessionTabOptions(ready)).toEqual({
      tabId: "multi-review-fix:multi-1",
      activateExistingTab: true,
      agentLaunchMode: "native",
      resumeSessionId: "provider-fix",
      displayTitle: MULTI_REVIEW_FIX_TAB_TITLE,
      isReviewTab: true,
      hideStructuredOutput: true,
      initialAgentModel: "gpt-5.6",
      initialReasoningEffort: "high",
      initialConversationMode: "build",
    });
    expect(multiReviewFixSessionTabOptions(ready)).not.toHaveProperty("initialPrompt");
    expect(multiReviewFixSessionTabOptions(ready)).not.toHaveProperty(
      "requireExistingResumeSession",
    );
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
    fireEvent.contextMenu(flowNode("Reviewer 2 ·"));
    expect(
      (await screen.findByRole("menuitem", { name: "Stop" })).hasAttribute("data-disabled"),
    ).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });

    selectFlowNode("Reviewer 1 ·");
    fireEvent.click(inspector().getByRole("button", { name: "Stop Reviewer 1" }));
    await waitFor(() => expect(stopReviewer).toHaveBeenCalledWith(reviewing.id, "reviewer-1"));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop Reviewer 1" }) === null).toBe(true),
    );
    expect(screen.getByText(/Stopped · excluded from the consolidated report/)).toBeTruthy();
    expect(screen.getByText("Review · 0/1 · 1 stopped").getAttribute("title")).toBe(
      "0/1 complete · 1 stopped",
    );
    // The other reviewer keeps working: stopping one is not cancelling the run.
    selectFlowNode("Reviewer 2 ·");
    expect(inspector().getByRole("button", { name: "Stop Reviewer 2" })).toBeTruthy();
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

    const firstCard = flowNode("Reviewer 1 ·");
    fireEvent.contextMenu(firstCard);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart" }));
    await waitFor(() => expect(restartReviewer).toHaveBeenCalledWith(reviewing.id, "reviewer-1"));

    fireEvent.contextMenu(firstCard);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unstick" }));
    await waitFor(() => expect(unstickReviewer).toHaveBeenCalledWith(reviewing.id, "reviewer-1"));
  });

  test("offers restart from every started workflow step tile", async () => {
    const ready = readyWorkflow();
    const completed: MultiReviewWorkflow = {
      ...ready,
      phase: "completed",
      stepRuntimes: {
        prepare: { startedAt: ready.createdAt, completedAt: ready.updatedAt },
        consolidate: { startedAt: ready.createdAt, completedAt: ready.updatedAt },
        fix: { startedAt: ready.createdAt, completedAt: ready.updatedAt },
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(completed);
    const restartStep = mock(async () => completed);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: completed.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => completed)}
        commands={{
          address: mock(async () => completed),
          retry: mock(async () => completed),
          cancel: mock(async () => completed),
          stopReviewer: mock(async () => completed),
          restartStep,
        }}
      />,
    );

    for (const [nodeName, kind] of [
      ["Review package", "prepare"],
      ["Consolidation", "consolidate"],
      ["Fix,", "fix"],
    ] as const) {
      fireEvent.contextMenu(flowNode(nodeName));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Restart" }));
      await waitFor(() => expect(restartStep).toHaveBeenLastCalledWith(completed.id, kind));
    }
  });

  test("opens Restart in for a step and submits its current model selection", async () => {
    const ready = readyWorkflow();
    ready.consolidationModel = {
      agent: "codex",
      model: "gpt-5.4",
      reasoningEffort: "medium",
    };
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const restartStep = mock(
      async (_workflowId: string, _kind: MultiReviewStepKind, _model?: MultiReviewModelSelection) =>
        ready,
    );

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
          restartStep,
        }}
      />,
    );

    fireEvent.contextMenu(flowNode("Consolidation"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart in…" }));
    expect(await screen.findByRole("heading", { name: "Restart Consolidation" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restart Consolidation" }));
    await waitFor(() => expect(restartStep).toHaveBeenCalledTimes(1));
    expect(restartStep.mock.calls[0]?.[0]).toBe(ready.id);
    expect(restartStep.mock.calls[0]?.[1]).toBe("consolidate");
    expect(restartStep.mock.calls[0]?.[2]).toMatchObject({
      agent: "codex",
      model: "gpt-5.4",
      reasoningEffort: "medium",
    });
  });

  test.each([
    {
      kind: "prepare" as const,
      node: "Review package",
      heading: "Restart Preparation",
      selection: { agent: "claude" as const, model: "sonnet", reasoningEffort: "high" },
    },
    {
      kind: "fix" as const,
      node: "Fix,",
      heading: "Restart Fix",
      selection: { agent: "codex" as const, model: "gpt-5.4", reasoningEffort: "high" },
    },
  ])("submits the $kind step's own Restart in selection", async (fixture) => {
    const ready = readyWorkflow();
    ready.reviewModel = { agent: "claude", model: "sonnet", reasoningEffort: "high" };
    ready.reviewSession = {
      ...ready.reviewModel,
      sessionKey: "review-session",
      providerSessionId: "provider-review",
      requestIds: ["prepare-1", "consolidate-1"],
      status: "idle",
      startedAt: ready.createdAt,
      completedAt: ready.updatedAt,
    };
    if (fixture.kind === "fix") {
      ready.phase = "completed";
      ready.stepRuntimes = {
        fix: { startedAt: ready.createdAt, completedAt: ready.updatedAt },
      };
    }
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const restartStep = mock(
      async (_workflowId: string, _kind: MultiReviewStepKind, _model?: MultiReviewModelSelection) =>
        ready,
    );

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
          restartStep,
        }}
      />,
    );

    fireEvent.contextMenu(flowNode(fixture.node));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart in…" }));
    fireEvent.click(await screen.findByRole("button", { name: fixture.heading }));
    await waitFor(() => expect(restartStep).toHaveBeenCalledTimes(1));
    expect(restartStep.mock.calls[0]).toEqual([ready.id, fixture.kind, fixture.selection]);
  });

  test("shows each review-side step's recorded model", () => {
    const ready = readyWorkflow();
    ready.reviewModel = { agent: "claude", model: "sonnet", reasoningEffort: "high" };
    ready.consolidationModel = {
      agent: "codex",
      model: "gpt-5.4",
      reasoningEffort: "medium",
    };
    ready.reviewSession = {
      ...ready.consolidationModel,
      sessionKey: "review-session",
      providerSessionId: "provider-review",
      requestIds: ["consolidate-1"],
      status: "idle",
      startedAt: ready.createdAt,
      completedAt: ready.updatedAt,
    };
    useMultiReviewStore.getState().replaceWorkflow(ready);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: ready.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => ready)}
      />,
    );

    expect(within(flowNode("Review package")).getByText("claude · sonnet · high")).toBeTruthy();
    expect(within(flowNode("Consolidation")).getByText("codex · gpt-5.4 · medium")).toBeTruthy();
  });

  test("pauses and resumes the active workflow step from its context menu", async () => {
    const ready = readyWorkflow();
    const timestamp = ready.createdAt;
    const preparing: MultiReviewWorkflow = {
      ...ready,
      phase: "preparing",
      consolidatedReport: undefined,
      activeRequest: {
        kind: "prepare",
        requestId: "prepare-2",
        state: "sent",
        createdAt: timestamp,
      },
      fixSession: {
        ...ready.fixSession!,
        requestIds: [...ready.fixSession!.requestIds, "prepare-2"],
        status: "running",
        completedAt: undefined,
      },
    };
    const paused: MultiReviewWorkflow = {
      ...preparing,
      phase: "paused",
      pausedFromPhase: "preparing",
      pausedStep: "prepare",
      activeRequest: undefined,
      fixSession: { ...preparing.fixSession!, status: "idle" },
    };
    const resumed: MultiReviewWorkflow = {
      ...paused,
      phase: "preparing",
      pausedFromPhase: undefined,
      pausedStep: undefined,
    };
    useMultiReviewStore.getState().replaceWorkflow(preparing);
    const pauseStep = mock(async (_workflowId: string, _kind: MultiReviewStepKind) => paused);
    const resumeStep = mock(async (_workflowId: string, _kind: MultiReviewStepKind) => resumed);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: preparing.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => preparing)}
        commands={{
          address: mock(async () => preparing),
          retry: mock(async () => preparing),
          cancel: mock(async () => preparing),
          stopReviewer: mock(async () => preparing),
          pauseStep,
          resumeStep,
        }}
      />,
    );

    const preparationTile = () => flowNode("Review package");
    fireEvent.contextMenu(preparationTile());
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
    await waitFor(() => expect(pauseStep).toHaveBeenCalledWith(preparing.id, "prepare"));
    expect(await screen.findByText("Multi Review paused")).toBeTruthy();

    fireEvent.contextMenu(preparationTile());
    fireEvent.click(await screen.findByRole("menuitem", { name: "Resume" }));
    await waitFor(() => expect(resumeStep).toHaveBeenCalledWith(preparing.id, "prepare"));
    expect(
      await screen.findByText(
        "Discovering validation, running checks, and preparing shared evidence",
      ),
    ).toBeTruthy();
  });

  test("does not offer Pause for an interactive Fix session", async () => {
    const workflow = readyWorkflow();
    workflow.phase = "interactive";
    workflow.fixSession = { ...workflow.fixSession!, status: "running" };
    workflow.fixLaunch = { kind: "default" };
    workflow.stepRuntimes = { fix: { startedAt: workflow.createdAt } };
    useMultiReviewStore.getState().replaceWorkflow(workflow);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
        commands={{
          address: mock(async () => workflow),
          retry: mock(async () => workflow),
          cancel: mock(async () => workflow),
          stopReviewer: mock(async () => workflow),
          pauseStep: mock(async () => workflow),
        }}
      />,
    );

    fireEvent.contextMenu(flowNode("Fix,"));
    expect(await screen.findByRole("menuitem", { name: "Restart" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Pause" }) === null).toBe(true);
    expect(screen.queryByRole("menuitem", { name: "Resume" }) === null).toBe(true);
  });

  test("offers step restart from a touch long press", async () => {
    const ready = readyWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(ready);
    const restartStep = mock(async () => ready);
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
          restartStep,
        }}
      />,
    );

    const tile = flowNode("Consolidation");
    fireEvent.pointerDown(tile, {
      pointerType: "touch",
      pointerId: 72,
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    await act(async () => {
      await Bun.sleep(710);
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart" }));

    await waitFor(() => expect(restartStep).toHaveBeenCalledWith(ready.id, "consolidate"));
  });

  test("shows a repository-change note and allows reviewer restart", async () => {
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

    expect(
      screen.getByText(
        "The repository worktree changed after this Multi Review started. The review continued, so reviewer reports may reflect different worktree states.",
      ),
    ).toBeTruthy();

    fireEvent.contextMenu(flowNode("Reviewer 1 ·"));
    const restart = await screen.findByRole("menuitem", { name: "Restart" });
    expect(restart.hasAttribute("data-disabled")).toBe(false);
    fireEvent.click(restart);
    await waitFor(() => expect(restartReviewer).toHaveBeenCalledWith(stale.id, "reviewer-1"));
  });

  test("keeps reviewer restart disabled when immutable package evidence is stale", async () => {
    const stale: MultiReviewWorkflow = {
      ...reviewingWorkflow(),
      reviewSnapshotStale: true,
      reviewPackage: {
        kind: "file",
        id: "package-1",
        round: 1,
        preparedAt: "2026-08-14T00:00:00.000Z",
        targetBranch: "main",
        baseRef: "origin/main",
        headRef: "HEAD",
        filePath: ".orkestrator/review-packages/package-1.json",
        sha256: "a".repeat(64),
        bytes: 2048,
        changedFileCount: 2,
        limitations: [],
      },
    };
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

    fireEvent.contextMenu(flowNode("Reviewer 1 ·"));
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

    fireEvent.contextMenu(flowNode("Reviewer 1 ·"));
    expect(
      (await screen.findByRole("menuitem", { name: "Unstick" })).hasAttribute("data-disabled"),
    ).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.contextMenu(flowNode("Reviewer 2 ·"));
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

    fireEvent.contextMenu(flowNode("Reviewer 1 ·"));
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
    const node = flowNode("Reviewer 1 ·");
    expect(node.dataset.flowState).toBe("running");
    expect(within(node).getByText("stalled")).toBeTruthy();
    expect(inspector().getByTestId("multi-review-inspector-status").textContent).toBe("Stalled");
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

    // The graph's column heading says the same in fewer words.
    expect(reviewerColumnLabel(ready.reviewers)).toBe("Review · 2/2");
    expect(
      reviewerColumnLabel([
        ready.reviewers[0]!,
        { ...ready.reviewers[1]!, status: "cancelled", report: undefined },
      ]),
    ).toBe("Review · 1/1 · 1 stopped");
    expect(
      reviewerColumnLabel(
        ready.reviewers.map((reviewer) => ({ ...reviewer, status: "pending" as const })),
      ),
    ).toBe("Review · 0/2");
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

      expect(screen.getByRole("status").textContent).toContain(
        phase === "consolidating"
          ? "Review preparation model appears stalled"
          : "Fix model appears stalled",
      );
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

test("renders backend-owned package preparation after remount with cancel available", () => {
  const workflow = reviewingWorkflow();
  workflow.phase = "preparing";
  workflow.reviewers = workflow.reviewers.map((reviewer) => ({
    ...reviewer,
    status: "pending",
    providerSessionId: undefined,
  }));
  useMultiReviewStore.getState().replaceWorkflow(workflow);
  const view = render(
    <MultiReviewTab
      data={{ environmentId: workflow.environmentId, workflowId: workflow.id, isLocal: true }}
      isActive={true}
      hydrateWorkflow={async () => workflow}
    />,
  );
  expect(
    screen.getByText("Discovering validation, running checks, and preparing shared evidence"),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop Reviewer 1" }) === null).toBe(true);
  view.unmount();
  render(
    <MultiReviewTab
      data={{ environmentId: workflow.environmentId, workflowId: workflow.id, isLocal: true }}
      isActive={true}
      hydrateWorkflow={async () => workflow}
    />,
  );
  expect(
    screen.getByText("Discovering validation, running checks, and preparing shared evidence"),
  ).toBeTruthy();
});

describe("MultiReviewTab pipeline step cards", () => {
  function preparingWorkflow(): MultiReviewWorkflow {
    const workflow = reviewingWorkflow();
    workflow.phase = "preparing";
    workflow.reviewers = workflow.reviewers.map((reviewer) => ({
      ...reviewer,
      status: "pending",
      providerSessionId: undefined,
    }));
    workflow.activeRequest = {
      kind: "prepare",
      requestId: "prepare-1",
      state: "sent",
      createdAt: "2026-08-14T00:00:00.000Z",
    };
    workflow.fixSession = {
      agent: "codex",
      model: "gpt-5.6",
      reasoningEffort: "high",
      sessionKey: "multi-review:multi-1:fix",
      providerSessionId: "provider-fix",
      requestIds: ["prepare-1"],
      status: "running",
      startedAt: "2026-08-14T00:00:00.000Z",
    };
    return workflow;
  }

  test("opens the live preparation session only after direct tile activation", () => {
    const workflow = preparingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      </TerminalProvider>,
    );

    expect(screen.getByText("Generating package")).toBeTruthy();
    expect(screen.getByLabelText("Review package generation runtime")).toBeTruthy();
    const card = stepOpenButton("Review package");
    expect(card.hasAttribute("disabled")).toBe(false);
    // A presentation click without a matching tile interaction must not
    // materialize the backend-owned coordinator session as another pane tab.
    fireEvent.click(card);
    expect(createTab).not.toHaveBeenCalled();
    activateReviewTile(card);
    expect(createTab).toHaveBeenCalledTimes(1);
    const [agent, options] = createTab.mock.calls[0]!;
    expect(agent).toBe("codex");
    expect(options).toMatchObject({
      agentLaunchMode: "native",
      resumeSessionId: "provider-fix",
      requireExistingResumeSession: true,
      isReviewTab: true,
      hideStructuredOutput: true,
    });

    createTab.mockClear();
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.click(card);
    expect(createTab).toHaveBeenCalledTimes(1);
  });

  test.each(["touch", "pen"] as const)(
    "keeps a %s activation armed through the post-pointerup leave events",
    (pointerType) => {
      const workflow = preparingWorkflow();
      useMultiReviewStore.getState().replaceWorkflow(workflow);
      const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

      render(
        <TerminalProvider>
          <TabRegistrar createTab={createTab} />
          <MultiReviewTab
            data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
            isActive
            hydrateWorkflow={mock(async () => workflow)}
          />
        </TerminalProvider>,
      );

      const card = stepOpenButton("Review package");
      const pointer = { pointerType, pointerId: 11, isPrimary: true, button: 0 };
      fireEvent.pointerDown(card, pointer);
      fireEvent.pointerUp(card, pointer);
      fireEvent.pointerOut(card, pointer);
      fireEvent.pointerLeave(card, pointer);
      fireEvent.click(card, { detail: 1 });

      expect(createTab).toHaveBeenCalledTimes(1);
    },
  );

  test("keeps a pointer activation armed when it leaves, re-enters, and releases on the tile", () => {
    const workflow = preparingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      </TerminalProvider>,
    );

    const card = stepOpenButton("Review package");
    const pointer = { pointerType: "mouse", pointerId: 12, isPrimary: true, button: 0 };
    fireEvent.pointerDown(card, pointer);
    fireEvent.pointerLeave(card, pointer);
    fireEvent.pointerEnter(card, pointer);
    fireEvent.pointerUp(card, pointer);
    fireEvent.click(card, { detail: 1 });

    expect(createTab).toHaveBeenCalledTimes(1);
  });

  test("disarms pointer activation when the gesture is cancelled or released outside", () => {
    const workflow = preparingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      </TerminalProvider>,
    );

    const card = stepOpenButton("Review package");
    fireEvent.pointerDown(card, {
      pointerType: "touch",
      pointerId: 13,
      isPrimary: true,
      button: 0,
    });
    fireEvent.pointerCancel(card, { pointerType: "touch", pointerId: 13, isPrimary: true });
    fireEvent.click(card, { detail: 1 });
    expect(createTab).not.toHaveBeenCalled();

    fireEvent.pointerDown(card, {
      pointerType: "mouse",
      pointerId: 14,
      isPrimary: true,
      button: 0,
    });
    fireEvent.pointerLeave(card, { pointerType: "mouse", pointerId: 14, isPrimary: true });
    fireEvent.pointerUp(document.body, {
      pointerType: "mouse",
      pointerId: 14,
      isPrimary: true,
      button: 0,
    });
    fireEvent.click(card, { detail: 1 });
    expect(createTab).not.toHaveBeenCalled();
  });

  test("focus loss disarms keyboard activation without cancelling a pointer activation", () => {
    const workflow = preparingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      </TerminalProvider>,
    );

    const card = stepOpenButton("Review package");
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.blur(card);
    fireEvent.click(card, { detail: 1 });
    expect(createTab).not.toHaveBeenCalled();

    const pointer = { pointerType: "touch", pointerId: 15, isPrimary: true, button: 0 };
    fireEvent.pointerDown(card, pointer);
    fireEvent.blur(card);
    fireEvent.pointerUp(card, pointer);
    fireEvent.click(card, { detail: 1 });
    expect(createTab).toHaveBeenCalledTimes(1);
  });

  test("accepts only a trusted detail-zero click without an armed input", () => {
    expect(allowsReviewTileActivation(true, false, 0, true)).toBe(true);
    expect(allowsReviewTileActivation(true, false, 0, false)).toBe(false);
    expect(allowsReviewTileActivation(true, false, 1, true)).toBe(false);
    expect(allowsReviewTileActivation(true, true, 1, false)).toBe(true);
    expect(allowsReviewTileActivation(false, false, 1, false)).toBe(true);
  });

  test("rejects click-through when the coordinator tile mounts during another gesture", () => {
    const workflow = preparingWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(<ReviewMountDuringPointerGesture workflow={workflow} createTab={createTab} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Launch review" }), {
      pointerType: "touch",
      pointerId: 16,
      isPrimary: true,
      button: 0,
    });
    const card = stepOpenButton("Review package");
    fireEvent.pointerUp(card, {
      pointerType: "touch",
      pointerId: 16,
      isPrimary: true,
      button: 0,
    });
    fireEvent.click(card, { detail: 1 });

    expect(createTab).not.toHaveBeenCalled();
  });

  test("opens preparation and consolidation separately from the fix tab", () => {
    const legacy = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...legacy,
      phase: "fixing",
      reviewModel: { agent: "claude", model: "opus", reasoningEffort: "high" },
      reviewSessionKey: "multi-review:multi-1:review",
      reviewSession: {
        agent: "claude",
        model: "opus",
        reasoningEffort: "high",
        sessionKey: "multi-review:multi-1:review",
        providerSessionId: "provider-review-coordinator",
        requestIds: ["prepare-1", "consolidate-1"],
        status: "idle",
        startedAt: "2026-08-14T00:00:00.000Z",
        completedAt: "2026-08-14T00:04:00.000Z",
      },
      fixSession: { ...legacy.fixSession!, status: "running", completedAt: undefined },
      activeRequest: {
        kind: "fix",
        requestId: "fix-1",
        state: "sent",
        createdAt: "2026-08-14T00:05:00.000Z",
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      </TerminalProvider>,
    );

    activateReviewTile(stepOpenButton("Review package"));
    activateReviewTile(stepOpenButton("Consolidation"));
    fireEvent.click(stepOpenButton("Fix,"));

    // Both coordinator cards resolve to the same dedicated tab identity, while
    // Fix uses another tab backed by its own provider session.
    expect(createTab).toHaveBeenCalledTimes(3);
    expect(createTab.mock.calls[0]?.[0]).toBe("claude");
    expect(createTab.mock.calls[0]?.[1]).toMatchObject({
      tabId: "multi-review-review:multi-1:provider-review-coordinator",
      displayTitle: "Review preparation & consolidation",
      resumeSessionId: "provider-review-coordinator",
      hideStructuredOutput: true,
    });
    expect(createTab.mock.calls[1]?.[1]).toMatchObject({
      tabId: "multi-review-review:multi-1:provider-review-coordinator",
      resumeSessionId: "provider-review-coordinator",
      hideStructuredOutput: true,
    });
    expect(createTab.mock.calls[2]?.[0]).toBe("codex");
    expect(createTab.mock.calls[2]?.[1]).toMatchObject({
      tabId: "multi-review-fix:multi-1",
      displayTitle: "Fix",
      resumeSessionId: "provider-fix",
    });
  });

  test("opens a consolidation restarted on another provider with that provider", () => {
    const legacy = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...legacy,
      phase: "consolidating",
      reviewModel: { agent: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      consolidationModel: { agent: "cursor", model: "grok-4.6" },
      reviewSessionKey: "multi-review:multi-1:review:restart:1",
      reviewSession: {
        agent: "cursor",
        model: "grok-4.6",
        sessionKey: "multi-review:multi-1:review:restart:1",
        providerSessionId: "provider-cursor-consolidation",
        requestIds: ["consolidate-2"],
        status: "running",
        startedAt: "2026-08-14T00:04:00.000Z",
      },
      activeRequest: {
        kind: "consolidate",
        requestId: "consolidate-2",
        state: "sent",
        createdAt: "2026-08-14T00:04:00.000Z",
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      </TerminalProvider>,
    );

    activateReviewTile(stepOpenButton("Consolidation"));

    // The preparation provider's tab for the abandoned session must not be
    // refocused or reused for the restarted consolidation.
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab.mock.calls[0]?.[0]).toBe("cursor");
    expect(createTab.mock.calls[0]?.[1]).toMatchObject({
      tabId: "multi-review-review:multi-1:provider-cursor-consolidation",
      resumeSessionId: "provider-cursor-consolidation",
      initialAgentModel: "grok-4.6",
      requireExistingResumeSession: true,
    });
  });

  test("keeps legacy preparation and fix tabs on the shared provider session", () => {
    const legacy = readyWorkflow();

    expect(multiReviewReviewSessionTabOptions(legacy)).toMatchObject({
      tabId: "multi-review-review:multi-1:provider-fix",
      resumeSessionId: "provider-fix",
      initialAgentModel: "gpt-5.6",
      initialReasoningEffort: "high",
      initialConversationMode: "plan",
      hideStructuredOutput: true,
    });
    expect(multiReviewFixSessionTabOptions(legacy)).toMatchObject({
      tabId: "multi-review-fix:multi-1",
      resumeSessionId: "provider-fix",
      initialAgentModel: "gpt-5.6",
      initialReasoningEffort: "high",
      initialConversationMode: "build",
      hideStructuredOutput: true,
    });
  });

  test("opens preparation on the session it kept once consolidation has its own", () => {
    const legacy = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...legacy,
      preparationSession: {
        ...legacy.fixSession!,
        providerSessionId: "provider-prepare",
        openedFor: "prepare",
      },
      fixSession: { ...legacy.fixSession!, openedFor: "consolidate" },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      </TerminalProvider>,
    );

    activateReviewTile(stepOpenButton("Review package"));
    activateReviewTile(stepOpenButton("Consolidation"));

    expect(createTab.mock.calls.map((call) => call[1]?.resumeSessionId)).toEqual([
      "provider-prepare",
      "provider-fix",
    ]);
    // A record written before consolidation moved still opens the shared session.
    expect(multiReviewReviewSessionTabOptions(legacy, "prepare")).toMatchObject({
      resumeSessionId: "provider-fix",
    });
  });

  test("stays disabled until the review model has opened a provider session", () => {
    const workflow = preparingWorkflow();
    delete workflow.fixSession;
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      </TerminalProvider>,
    );

    const card = stepOpenButton("Review package");
    expect(card.hasAttribute("disabled")).toBe(true);
    activateReviewTile(card);
    expect(createTab).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Review package generation runtime") === null).toBe(true);
  });

  function packagedWorkflow(): MultiReviewWorkflow {
    const workflow = reviewingWorkflow();
    workflow.reviewPackage = {
      kind: "file",
      id: "package-1",
      round: 1,
      preparedAt: "2026-08-14T00:00:00.000Z",
      targetBranch: "main",
      baseRef: "origin/main",
      headRef: "HEAD",
      filePath: ".orkestrator/review-packages/package-1.json",
      sha256: "a".repeat(64),
      bytes: 2048,
      changedFileCount: 2,
      limitations: [],
    };
    return workflow;
  }

  test("reports preparation from the package pointer, not only from the phase", () => {
    const packaged = packagedWorkflow();
    expect(reviewPackageGenerationStep(packaged)).toEqual({
      label: "Package ready",
      state: "complete",
    });
    // A settled workflow still carries the pointer, so the finished step keeps
    // reading as finished rather than as the failure that stopped the workflow.
    expect(reviewPackageGenerationStep({ ...packaged, phase: "failed" })).toEqual({
      label: "Package ready",
      state: "complete",
    });
    expect(reviewPackageGenerationStep({ ...packaged, phase: "cancelled" })).toEqual({
      label: "Package ready",
      state: "complete",
    });
  });

  test("falls back to phase and reviewer evidence for pre-package workflows", () => {
    const ready = readyWorkflow();
    const preparing = preparingWorkflow();
    expect(reviewPackageGenerationStep(preparing)).toEqual({
      label: "Generating package",
      state: "running",
    });
    expect(reviewPackageGenerationStep({ ...ready, phase: "consolidating" })).toEqual({
      label: "Package ready",
      state: "complete",
    });
    // A reviewer only receives a provider session once the package it reads
    // exists, so preparation finished even though the phase no longer says so.
    expect(reviewPackageGenerationStep({ ...ready, phase: "failed" })).toEqual({
      label: "Package ready",
      state: "complete",
    });
  });

  test("blames preparation only when nothing downstream ever started", () => {
    const preparing = preparingWorkflow();
    expect(
      reviewPackageGenerationStep({
        ...preparing,
        phase: "failed",
        fixSession: { ...preparing.fixSession!, status: "failed" },
      }),
    ).toEqual({ label: "Failed", state: "failed" });
    expect(reviewPackageGenerationStep({ ...preparing, phase: "cancelling" })).toEqual({
      label: "Cancelling",
      state: "cancelling",
    });
    // Cancelling retires every pending reviewer, which must not be mistaken for
    // reviewers that were dispatched against a finished package.
    expect(
      reviewPackageGenerationStep({
        ...preparing,
        phase: "cancelled",
        reviewers: preparing.reviewers.map((reviewer) => ({
          ...reviewer,
          status: "cancelled" as const,
        })),
      }),
    ).toEqual({ label: "Cancelled", state: "cancelled" });
  });

  test("tracks consolidation from waiting through to its own outcome", () => {
    const ready = readyWorkflow();
    const preparing = preparingWorkflow();
    const unconsolidated = { ...ready, consolidatedReport: undefined };
    expect(consolidationStep(preparing)).toEqual({
      label: "Waiting for review package",
      state: "not-started",
    });
    expect(consolidationStep({ ...unconsolidated, phase: "reviewing" })).toEqual({
      label: "Waiting for reviews",
      state: "not-started",
    });
    expect(consolidationStep({ ...unconsolidated, phase: "consolidating" })).toEqual({
      label: "Consolidating findings",
      state: "running",
    });
    expect(consolidationStep(ready)).toEqual({ label: "Complete", state: "complete" });
    expect(
      consolidationStep({
        ...unconsolidated,
        phase: "failed",
        activeRequest: {
          kind: "consolidate",
          requestId: "consolidate-1",
          state: "sent",
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      }),
    ).toEqual({ label: "Failed", state: "failed" });
    expect(consolidationStep({ ...unconsolidated, phase: "cancelling" })).toEqual({
      label: "Cancelling",
      state: "cancelling",
    });
    expect(consolidationStep({ ...unconsolidated, phase: "cancelled" })).toEqual({
      label: "Cancelled",
      state: "cancelled",
    });
  });

  test("keeps downstream labels phase-aware while preparation is paused", () => {
    const preparing = preparingWorkflow();
    const paused: MultiReviewWorkflow = {
      ...preparing,
      phase: "paused",
      pausedFromPhase: "preparing",
      pausedStep: "prepare",
    };

    expect(reviewPackageGenerationStep(paused)).toEqual({ label: "Paused", state: "paused" });
    expect(consolidationStep(paused)).toEqual({
      label: "Waiting for review package",
      state: "not-started",
    });
    expect(fixStep(paused)).toEqual({
      label: "Waiting for review package",
      state: "not-started",
    });
  });

  test("never blames consolidation for a failure that happened before it ran", () => {
    const ready = readyWorkflow();
    const unconsolidated = { ...ready, consolidatedReport: undefined };
    // Preparation failed: its own card reports that, and consolidation never ran.
    expect(
      consolidationStep({
        ...preparingWorkflow(),
        phase: "failed",
        activeRequest: {
          kind: "prepare",
          requestId: "prepare-1",
          state: "sent",
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      }),
    ).toEqual({ label: "Not started", state: "not-started" });
    // A reviewer failure clears no request at all, because the reviewers do not
    // use one; consolidation is still unrun.
    expect(
      consolidationStep({
        ...unconsolidated,
        phase: "failed",
        activeRequest: undefined,
        reviewers: unconsolidated.reviewers.map((reviewer) => ({
          ...reviewer,
          status: "failed" as const,
          report: undefined,
        })),
      }),
    ).toEqual({ label: "Not started", state: "not-started" });
  });

  test("tracks the fix turn separately from the steps that feed it", () => {
    const ready = readyWorkflow();
    expect(fixStep(ready)).toEqual({ label: "Ready to start", state: "not-started" });
    expect(fixStep({ ...ready, phase: "reviewing" })).toEqual({
      label: "Not started",
      state: "not-started",
    });
    expect(fixStep({ ...ready, phase: "fixing" })).toEqual({
      label: "Addressing findings",
      state: "running",
    });
    expect(
      fixStep({
        ...ready,
        phase: "interactive",
        fixSession: { ...ready.fixSession!, status: "running" },
      }),
    ).toEqual({
      label: "Interactive fix session",
      state: "running",
    });
    expect(
      fixStep({
        ...ready,
        phase: "interactive",
        fixSession: { ...ready.fixSession!, status: "idle" },
      }),
    ).toEqual({ label: "Interactive fix session", state: "running" });
    expect(
      fixStep({
        ...ready,
        phase: "interactive",
        fixSession: { ...ready.fixSession!, status: "idle" },
        stepRuntimes: {
          fix: {
            startedAt: "2026-08-14T00:10:00.000Z",
            completedAt: "2026-08-14T00:14:00.000Z",
          },
        },
      }),
    ).toEqual({ label: "Complete", state: "complete" });
    expect(
      fixStep({
        ...ready,
        phase: "interactive",
        fixSession: { ...ready.fixSession!, status: "failed" },
      }),
    ).toEqual({ label: "Failed", state: "failed" });
    expect(
      fixStep({
        ...ready,
        phase: "interactive",
        addressPromptPending: true,
        fixSession: { ...ready.fixSession!, status: "idle" },
      }),
    ).toEqual({ label: "Starting fix session", state: "running" });
    expect(fixStep({ ...ready, phase: "completed" })).toEqual({
      label: "Complete",
      state: "complete",
    });
    expect(
      fixStep({
        ...ready,
        phase: "failed",
        fixResult: {
          complete: false,
          summary: "Two findings remain",
          filesChanged: [],
          commandsRun: [],
          notes: [],
          limitations: [],
        },
      }),
    ).toEqual({ label: "Failed", state: "failed" });
    // The workflow failed before the fix request was ever dispatched.
    expect(fixStep({ ...ready, phase: "failed" })).toEqual({
      label: "Not started",
      state: "not-started",
    });
    expect(fixStep({ ...ready, phase: "cancelled" })).toEqual({
      label: "Cancelled",
      state: "cancelled",
    });
  });

  test("attributes the shared session clock to the step that is holding it", () => {
    const ready = readyWorkflow();
    expect(fixSessionRuntimeStep({ ...ready, phase: "preparing" })).toBe("package");
    // The reviewers run without this session, so it still holds preparation's
    // finished timings for the whole review stage.
    expect(fixSessionRuntimeStep({ ...ready, phase: "reviewing" })).toBe("package");
    expect(fixSessionRuntimeStep({ ...ready, phase: "consolidating" })).toBe("consolidation");
    expect(fixSessionRuntimeStep(ready)).toBe("consolidation");
    expect(fixSessionRuntimeStep({ ...ready, phase: "fixing" })).toBe("fix");
    expect(fixSessionRuntimeStep({ ...ready, phase: "completed" })).toBe("fix");
    // Until the address turn is dispatched the session still carries
    // consolidation's timings, so no step may show them as its own.
    expect(
      fixSessionRuntimeStep({ ...ready, phase: "interactive", addressPromptPending: true }),
    ).toBeNull();
    expect(fixSessionRuntimeStep({ ...ready, phase: "interactive" })).toBe("fix");
    // Cancelling clears the active request, so nothing can claim the clock.
    expect(fixSessionRuntimeStep({ ...ready, phase: "cancelled" })).toBeNull();
    expect(
      fixSessionRuntimeStep({
        ...ready,
        phase: "failed",
        activeRequest: {
          kind: "prepare",
          requestId: "prepare-1",
          state: "sent",
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      }),
    ).toBe("package");
  });

  test("renders the three steps around the reviewer panel in pipeline order", () => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      phase: "consolidating",
      consolidatedReport: undefined,
      fixSession: { ...ready.fixSession!, status: "running" },
      activeRequest: {
        kind: "consolidate",
        requestId: "consolidate-1",
        state: "sent",
        createdAt: "2026-08-14T00:00:00.000Z",
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
      />,
    );

    const pipeline = screen.getByRole("tablist", { name: "Multi Review pipeline" });
    expect(
      within(pipeline)
        .getAllByRole("tab")
        .map((node) => node.getAttribute("aria-label")),
    ).toEqual([
      "Review package, Package ready",
      "Reviewer 1 · claude, Complete, 1 issue found, 1 coverage gap found",
      "Reviewer 2 · codex, Complete, 1 issue found, 1 coverage gap found",
      expect.stringMatching(/^Consolidation, Consolidating findings, \d+/),
      "Fix, Not started",
      "Pull request, Automatic PR is off. Use the PR button to create one",
    ]);
    for (const label of ["Prepare", "Review · 2/2", "Consolidate", "PR"]) {
      expect(within(pipeline).getByText(label)).toBeTruthy();
    }
    // The running step is the one inspected until the user picks another.
    expect(flowNode("Consolidation").getAttribute("aria-selected")).toBe("true");
    expect(inspector().getByTestId("multi-review-inspector-status").textContent).toBe(
      "Consolidating findings",
    );
    expect(within(flowNode("Fix,")).getByText("not started")).toBeTruthy();
  });

  test("keeps a failed preparation session openable so its transcript can be read", () => {
    const preparing = preparingWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...preparing,
      phase: "failed",
      error: "The preparation session produced no activity for 20 minutes",
      fixSession: { ...preparing.fixSession!, status: "failed" },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      </TerminalProvider>,
    );

    expect(inspector().getByTestId("multi-review-inspector-status").textContent).toBe("Failed");
    expect(flowNode("Review package").dataset.flowState).toBe("failed");
    const card = stepOpenButton("Review package");
    expect(card.hasAttribute("disabled")).toBe(false);
    expect(card.getAttribute("title")).toBe(
      "Open the failed review package generation session in a new tab",
    );
    activateReviewTile(card);
    expect(createTab).toHaveBeenCalledTimes(1);
    // Consolidation never ran, so it stays unopenable and does not claim to have
    // failed alongside preparation.
    const consolidation = stepOpenButton("Consolidation");
    expect(consolidation.hasAttribute("disabled")).toBe(true);
  });

  test("keeps a failed consolidation session openable", () => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      phase: "failed",
      consolidatedReport: undefined,
      fixSession: { ...ready.fixSession!, status: "failed" },
      activeRequest: {
        kind: "consolidate",
        requestId: "consolidate-1",
        state: "sent",
        createdAt: "2026-08-14T00:00:00.000Z",
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      </TerminalProvider>,
    );

    const card = stepOpenButton("Consolidation");
    expect(card.hasAttribute("disabled")).toBe(false);
    expect(card.getAttribute("title")).toBe("Open the failed consolidation session in a new tab");
    activateReviewTile(card);
    expect(createTab).toHaveBeenCalledTimes(1);
    // Preparation finished, so it stays openable and keeps reading as finished.
    const preparation = stepOpenButton("Review package");
    expect(preparation.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Package ready")).toBeTruthy();
  });

  test("shows the fix turn as live while it addresses findings", () => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      phase: "fixing",
      fixSession: { ...ready.fixSession!, status: "running", completedAt: undefined },
      activeRequest: {
        kind: "fix",
        requestId: "fix-1",
        state: "sent",
        createdAt: "2026-08-14T00:00:00.000Z",
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock((_type: CreatableTabType, _options?: CreateTabOptions) => true);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />
      </TerminalProvider>,
    );

    expect(screen.getByText("Addressing findings")).toBeTruthy();
    expect(screen.getByLabelText("Fix runtime")).toBeTruthy();
    // The finished steps must not show the fix turn's clock as their own.
    expect(screen.queryByLabelText("Consolidation runtime") === null).toBe(true);
    expect(screen.queryByLabelText("Review package generation runtime") === null).toBe(true);
    const card = stepOpenButton("Fix,");
    expect(card.hasAttribute("disabled")).toBe(false);
    fireEvent.click(card);
    expect(createTab).toHaveBeenCalledTimes(1);
  });

  test("shows a settled interactive Fix turn as complete with final usage", () => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      fixSession: {
        ...ready.fixSession!,
        status: "idle",
        tokenCount: 23_456,
        completedAt: "2026-08-14T00:14:00.000Z",
      },
      stepRuntimes: {
        fix: {
          startedAt: "2026-08-14T00:10:00.000Z",
          completedAt: "2026-08-14T00:14:00.000Z",
          tokenBaseline: 0,
          tokenCount: 23_456,
        },
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
      />,
    );

    expect(screen.getByText("The fix session finished and is ready for follow-up")).toBeTruthy();
    const node = flowNode("Fix,");
    expect(node.getAttribute("aria-label")).toStartWith("Fix, Complete");
    expect(screen.getByLabelText("Fix runtime").textContent).toBe("4m 0s · 23k tokens");
    expect(node.querySelector(".animate-spin") === null).toBe(true);
  });

  test("keeps a legacy idle interactive Fix running until its runtime is settled", () => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      fixSession: {
        ...ready.fixSession!,
        status: "idle",
        completedAt: undefined,
      },
      stepRuntimes: {
        fix: { startedAt: "2026-08-14T00:10:00.000Z" },
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
      />,
    );

    expect(screen.getByText("The fix model is working interactively")).toBeTruthy();
    const node = flowNode("Fix,");
    expect(node.getAttribute("aria-label")).toStartWith("Fix, Interactive fix session");
    expect(node.querySelector(".animate-spin")).toBeTruthy();
  });

  test.each([
    ["failed" as const, "Provider turn failed", "Failed"],
    ["cancelled" as const, undefined, "Cancelled"],
  ])("renders a %s interactive Fix outcome on the card", (status, error, label) => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      fixSession: {
        ...ready.fixSession!,
        status,
        ...(error ? { error } : {}),
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
      />,
    );

    if (error) {
      expect(document.querySelector("header")?.textContent).toContain(error);
      expect(flowNode("Fix,").querySelector("[data-flow-node-error]")?.textContent).toBe(error);
    }
    expect(flowNode("Fix,").getAttribute("aria-label")).toStartWith(`Fix, ${label}`);
    selectFlowNode("Fix,");
    expect(inspector().getByTestId("multi-review-inspector-status").textContent).toBe(label);
  });

  test("warns on the card owning the stalled turn", () => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      phase: "fixing",
      fixSession: {
        ...ready.fixSession!,
        status: "running",
        completedAt: undefined,
        stalledSince: "2026-08-14T00:10:00.000Z",
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Fix model appears stalled");
    const fixNode = flowNode("Fix,");
    expect(fixNode.querySelector(".text-amber-500")).toBeTruthy();
    expect(within(fixNode).getByText("stalled")).toBeTruthy();
    expect(flowNode("Review package").querySelector(".text-amber-500") === null).toBe(true);
  });

  test("reports each step's own runtime and token count", () => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      stepRuntimes: {
        prepare: {
          startedAt: "2026-08-14T00:00:00.000Z",
          completedAt: "2026-08-14T00:01:20.000Z",
          tokenCount: 40_000,
        },
        consolidate: {
          startedAt: "2026-08-14T00:05:00.000Z",
          completedAt: "2026-08-14T00:07:45.000Z",
          tokenCount: 25_000,
        },
      },
    };
    const now = Date.parse("2026-08-14T00:20:00.000Z");

    // Every settled step keeps its own numbers, whichever one holds the session.
    expect(multiReviewStepRuntimeSummary(workflow, "package", false, now)).toBe(
      "1m 20s · 40k tokens",
    );
    expect(multiReviewStepRuntimeSummary(workflow, "consolidation", false, now)).toBe(
      "2m 45s · 25k tokens",
    );
    expect(multiReviewStepRuntimeSummary(workflow, "fix", false, now)).toBeNull();
  });

  test("counts a running step's runtime up from its own dispatch", () => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      phase: "consolidating",
      consolidatedReport: undefined,
      stepRuntimes: {
        prepare: {
          startedAt: "2026-08-14T00:00:00.000Z",
          completedAt: "2026-08-14T00:01:20.000Z",
          tokenCount: 40_000,
        },
        consolidate: { startedAt: "2026-08-14T00:05:00.000Z" },
      },
    };
    const now = Date.parse("2026-08-14T00:06:10.000Z");

    expect(multiReviewStepRuntimeSummary(workflow, "consolidation", true, now)).toBe(
      "1m 10s · Tokens pending",
    );
    expect(multiReviewStepRuntimeSummary(workflow, "package", false, now)).toBe(
      "1m 20s · 40k tokens",
    );
  });

  test("shows the interactive fix turn from its durable runtime record", () => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      phase: "interactive",
      stepRuntimes: {
        prepare: {
          startedAt: "2026-08-14T00:00:00.000Z",
          completedAt: "2026-08-14T00:01:20.000Z",
          tokenCount: 40_000,
        },
        consolidate: {
          startedAt: "2026-08-14T00:05:00.000Z",
          completedAt: "2026-08-14T00:07:45.000Z",
          tokenCount: 25_000,
        },
        fix: { startedAt: "2026-08-14T00:10:00.000Z", tokenBaseline: 65_000 },
      },
    };
    const now = Date.parse("2026-08-14T00:11:10.000Z");

    expect(multiReviewStepRuntimeSummary(workflow, "fix", true, now)).toBe(
      "1m 10s · Tokens pending",
    );
  });

  test("a settled runtime wins over a stale running card state", () => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      stepRuntimes: {
        consolidate: {
          startedAt: "2026-08-14T00:05:00.000Z",
          completedAt: "2026-08-14T00:07:45.000Z",
          tokenCount: 25_000,
        },
      },
    };

    expect(
      multiReviewStepRuntimeSummary(
        workflow,
        "consolidation",
        true,
        Date.parse("2026-08-14T00:20:00.000Z"),
      ),
    ).toBe("2m 45s · 25k tokens");
  });

  test("falls back to the shared session clock for workflows without step records", () => {
    const ready = readyWorkflow();
    const now = Date.parse("2026-08-14T00:02:05.000Z");

    expect(multiReviewStepRuntimeSummary(ready, "consolidation", false, now)).toBe(
      fixSessionRuntimeSummary(ready.fixSession!, now),
    );
    expect(multiReviewStepRuntimeSummary(ready, "package", false, now)).toBeNull();
    // Once a workflow records steps, one that has not run yet stays blank
    // rather than borrowing the clock of the step holding the session.
    expect(
      multiReviewStepRuntimeSummary(
        { ...ready, stepRuntimes: { prepare: { startedAt: "2026-08-14T00:00:00.000Z" } } },
        "consolidation",
        false,
        now,
      ),
    ).toBeNull();
  });

  test("shows preparation and consolidation timings on their own cards", () => {
    const ready = readyWorkflow();
    const workflow: MultiReviewWorkflow = {
      ...ready,
      stepRuntimes: {
        prepare: {
          startedAt: "2026-08-14T00:00:00.000Z",
          completedAt: "2026-08-14T00:01:20.000Z",
          tokenCount: 40_000,
        },
        consolidate: {
          startedAt: "2026-08-14T00:05:00.000Z",
          completedAt: "2026-08-14T00:07:45.000Z",
          tokenCount: 25_000,
        },
      },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);

    render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
      />,
    );

    expect(screen.getByLabelText("Review package generation runtime").textContent).toBe(
      "1m 20s · 40k tokens",
    );
    expect(screen.getByLabelText("Consolidation runtime").textContent).toBe("2m 45s · 25k tokens");
  });

  test("formats fix session runtime for live and settled sessions", () => {
    const ready = readyWorkflow();
    const session = ready.fixSession!;
    const now = Date.parse("2026-08-14T00:02:05.000Z");
    expect(fixSessionRuntimeSummary({ ...session, status: "running" }, now)).toBe("2m 5s");
    expect(
      fixSessionRuntimeSummary({ ...session, completedAt: "2026-08-14T00:00:30.000Z" }, now),
    ).toBe("30s");
    const { completedAt: _completedAt, ...unfinished } = session;
    expect(fixSessionRuntimeSummary(unfinished, now)).toBeNull();
  });
});

describe("PR background state and review clock", () => {
  function installPrTab() {
    const saved = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.setState({
      environments: new Map([
        [
          "env-1",
          {
            root: {
              kind: "leaf",
              id: "pr-pane",
              activeTabId: "overview",
              tabs: [
                { id: "overview", type: "multi-review" },
                {
                  id: "agent-job-pr",
                  type: "agent-native",
                  nativeAgentData: { platform: "codex", environmentId: "env-1" },
                },
              ],
            },
            activePaneId: "pr-pane",
            containerId: null,
          },
        ],
      ]),
    });
    return () => usePaneLayoutStore.setState({ environments: saved });
  }
  function snapshot(phase: NativeAgentTurnPhase): NativeAgentSessionStateUpdate {
    return {
      viewVersion: 1,
      status: "snapshot",
      token: phase,
      value: {
        identity: {
          backendInstanceId: "test",
          environmentId: "env-1",
          platform: "codex",
          logicalSessionKey: createSessionKey("env-1", "agent-job-pr"),
          providerSessionId: "pr-session",
          sourceGeneration: 1,
        },
        connection: "connected",
        turn: { phase },
        interactions: [],
        composerControls: [],
        capabilities: nativeAgentCapabilities("codex"),
        notices: [],
      },
    };
  }
  const launchedWorkflow = (): MultiReviewWorkflow => ({
    ...readyWorkflow(),
    phase: "completed",
    autoPr: true,
    stepRuntimes: {
      fix: { startedAt: "2026-08-14T00:00:00.000Z", completedAt: "2026-08-14T00:01:00.000Z" },
    },
    autoPrLaunch: { state: "launched", requestId: "pr", tabId: "agent-job-pr" },
  });

  test("refreshes an inactive PR tab through blocked, error and idle and focuses its live session", async () => {
    const restorePane = installPrTab();
    const originalTimeout = window.setTimeout;
    let poll: (() => void) | undefined;
    window.setTimeout = ((callback: () => void, delay?: number) => {
      if (delay === 2_000) {
        poll = callback;
        return 123456;
      }
      return originalTimeout(callback, delay);
    }) as typeof window.setTimeout;
    let sessionState: NativeAgentSessionStateUpdate = snapshot("running");
    const loadPrSessionState = mock(async () => sessionState);
    const workflow = launchedWorkflow();
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const view = render(
      <MultiReviewTab
        data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
        isActive
        hydrateWorkflow={mock(async () => workflow)}
        loadPrSessionState={loadPrSessionState}
      />,
    );
    try {
      await waitFor(() => expect(flowNode("Pull request,").textContent).toContain("working"));
      expect(loadPrSessionState).toHaveBeenCalledWith({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: createSessionKey("env-1", "agent-job-pr"),
        viewVersion: 1,
      });
      expect(
        usePaneLayoutStore.getState().findPaneWithTab("agent-job-pr", "env-1")?.activeTabId,
      ).toBe("overview");
      for (const [next, state, label] of [
        ["blocked", "running", "needs input"],
        ["error", "failed", "stopped with an error"],
        ["idle", "complete", "no PR yet"],
      ] as const) {
        sessionState = snapshot(next);
        await act(async () => {
          poll?.();
        });
        expect(flowNode("Pull request,").dataset.flowState).toBe(state);
        expect(
          flowNode("Pull request,").getAttribute("aria-label") +
            flowNode("Pull request,").textContent,
        ).toContain(label);
      }
      sessionState = { viewVersion: 1, status: "missing" };
      await act(async () => {
        poll?.();
      });
      expect(flowNode("Pull request,").dataset.flowState).toBe("paused");
      expect(flowNode("Pull request,").textContent).toContain("status unknown");
      sessionState = { viewVersion: 1, status: "unavailable", retryable: true };
      await act(async () => {
        poll?.();
      });
      expect(flowNode("Pull request,").dataset.flowState).toBe("paused");
      selectFlowNode("Pull request,");
      fireEvent.click(inspector().getByRole("button", { name: "Open PR session" }));
      expect(
        usePaneLayoutStore.getState().findPaneWithTab("agent-job-pr", "env-1")?.activeTabId,
      ).toBe("agent-job-pr");
    } finally {
      view.unmount();
      window.setTimeout = originalTimeout;
      restorePane();
    }
  });

  test("accepts a manual PR for a clean review with automatic PR off and no Fix or launch", () => {
    const saved = useEnvironmentStore.getState().environments;
    useEnvironmentStore.setState({
      environments: [
        { id: "env-1", prUrl: "https://github.com/o/r/pull/42", prState: "open" } as Environment,
      ],
    });
    const workflow = {
      ...readyWorkflow(),
      autoPr: false,
      fixSession: undefined,
      consolidatedReport: { ...report, issues: [], testCoverageGaps: [] },
    };
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    try {
      render(
        <MultiReviewTab
          data={{ environmentId: "env-1", workflowId: workflow.id, isLocal: true }}
          isActive
          hydrateWorkflow={mock(async () => workflow)}
        />,
      );
      expect(flowNode("Pull request,").dataset.flowState).toBe("complete");
      expect(flowNode("Pull request,").getAttribute("aria-selected")).toBe("true");
      const edge = document.querySelector('[data-flow-edge="into-pr"]')!;
      expect(edge.getAttribute("data-edge-state")).toBe("complete");
      const source = document.querySelector<HTMLElement>('[data-flow-node="consolidation"]')!;
      expect(edge.getAttribute("d")).toStartWith(
        `M${parseFloat(source.style.left) + parseFloat(source.style.width)} `,
      );
      expect(inspector().queryByText(/Use the PR button/) === null).toBe(true);
    } finally {
      cleanup();
      useEnvironmentStore.setState({ environments: saved });
    }
  });

  test("keeps review duration stable during PR-only work, completion and remount despite a stale projection", async () => {
    const restorePane = installPrTab();
    const savedEnvironments = useEnvironmentStore.getState().environments;
    const savedProjections = useNativeAgentProjectionStore.getState().projections;
    const originalNow = Date.now;
    let now = Date.parse("2026-08-14T00:02:00.000Z");
    Date.now = () => now;
    const workflow = launchedWorkflow();
    const loadPrSessionState = mock(async () => snapshot("running"));
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    const props = {
      data: { environmentId: "env-1", workflowId: workflow.id, isLocal: true },
      isActive: true,
      hydrateWorkflow: mock(async () => workflow),
      loadPrSessionState,
    };
    let view = render(<MultiReviewTab {...props} />);
    try {
      await waitFor(() => expect(flowNode("Pull request,").dataset.flowState).toBe("running"));
      expect(screen.getByTestId("multi-review-elapsed").textContent).toContain("1m 0s");
      now += 10_000;
      view.rerender(<MultiReviewTab {...props} />);
      expect(screen.getByTestId("multi-review-elapsed").textContent).toContain("1m 0s");
      act(() => {
        useNativeAgentProjectionStore.setState({
          projections: new Map([
            [
              createSessionKey("env-1", "agent-job-pr"),
              { turn: { phase: "running" } } as NativeAgentSessionProjection,
            ],
          ]),
        });
        useEnvironmentStore.setState({
          environments: [
            {
              id: "env-1",
              prUrl: "https://github.com/o/r/pull/42",
              prState: "open",
            } as Environment,
          ],
        });
      });
      expect(flowNode("Pull request,").dataset.flowState).toBe("complete");
      expect(screen.getByTestId("multi-review-elapsed").textContent).toContain("1m 0s");
      view.unmount();
      now += 60_000;
      view = render(<MultiReviewTab {...props} />);
      expect(flowNode("Pull request,").dataset.flowState).toBe("complete");
      expect(screen.getByTestId("multi-review-elapsed").textContent).toContain("1m 0s");
    } finally {
      view.unmount();
      Date.now = originalNow;
      restorePane();
      useEnvironmentStore.setState({ environments: savedEnvironments });
      useNativeAgentProjectionStore.setState({ projections: savedProjections });
    }
  });
});
