import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import type { NativeStructuredAgent } from "@/lib/structured-review-agent";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  dispatchMaterial,
  LoopedReviewTab,
  parseFixResult,
  parsePrResult,
} from "./LoopedReviewTab";
import { LoopedReviewSupervisor } from "./LoopedReviewSupervisor";
import {
  useLoopedReviewStore,
  type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";

const data = {
  environmentId: "env-review",
  workflowId: "workflow-review",
  isLocal: true,
};

function seedWorkflow(
  updates: Partial<LoopedReviewWorkflow>,
): LoopedReviewWorkflow {
  const id = useLoopedReviewStore.getState().createWorkflow({
    environmentId: data.environmentId,
    projectId: "project-1",
    agent: "codex",
    model: "codex-model",
    targetBranch: "main",
    allowance: 6,
  });
  const created = useLoopedReviewStore.getState().workflows.get(id)!;
  const workflow = { ...created, ...updates, id: data.workflowId };
  useLoopedReviewStore.setState({
    workflows: new Map([[data.workflowId, workflow]]),
  });
  return workflow;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function seedSentReconciliationWorkflow(): LoopedReviewWorkflow {
  const created = seedWorkflow({
    startingAllowance: 1,
    currentAllowance: 1,
  });
  const session = {
    id: "workflow-session",
    phase: "discovery" as const,
    round: 1,
    pass: 1,
    providerSessionId: "provider-session",
    requestIds: ["request-1"],
    status: "running" as const,
    startedAt: created.createdAt,
  };
  const workflow: LoopedReviewWorkflow = {
    ...created,
    phase: "reconciling",
    currentPass: 1,
    sessions: [session],
    activeSessionId: session.id,
    dispatch: {
      id: "dispatch-1",
      requestId: "request-1",
      sessionId: session.id,
      phase: "reconciling",
      kind: "reconcile",
      state: "sent",
      createdAt: created.createdAt,
    },
    rounds: [{
      ...created.rounds[0]!,
      allowance: 1,
      status: "reviewing",
      passes: [{
        pass: 1,
        sessionId: session.id,
        status: "reconciling",
        report: TEST_STRUCTURED_REVIEW_REPORT,
        startedAt: created.createdAt,
      }],
    }],
  };
  useLoopedReviewStore.setState({
    workflows: new Map([[workflow.id, workflow]]),
  });
  return workflow;
}

const successfulReconciliation = {
  ok: true as const,
  provider: "codex" as const,
  requestId: "request-1",
  value: {
    newIssues: TEST_STRUCTURED_REVIEW_REPORT.issues,
    issueUpdates: [],
    newCoverageGaps: TEST_STRUCTURED_REVIEW_REPORT.testCoverageGaps,
    coverageGapUpdates: [],
    issueOutcomes: TEST_STRUCTURED_REVIEW_REPORT.issues.map((_, reportIndex) => ({
      reportIndex,
      outcome: "new" as const,
      poolId: null,
    })),
    coverageGapOutcomes: TEST_STRUCTURED_REVIEW_REPORT.testCoverageGaps.map(
      (_, reportIndex) => ({
        reportIndex,
        outcome: "new" as const,
        poolId: null,
      }),
    ),
  },
};

beforeEach(() => {
  useLoopedReviewStore.setState({ workflows: new Map() });
  useEnvironmentStore.setState({
    environments: [{
      id: data.environmentId,
      projectId: "project-1",
      name: "Review environment",
      branch: "feature",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: "2026-07-25T00:00:00.000Z",
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: "/tmp/review-worktree",
      setupScriptsComplete: true,
    }],
  });
});

afterEach(() => {
  cleanup();
  useLoopedReviewStore.setState({ workflows: new Map() });
  useEnvironmentStore.setState({ environments: [] });
});

describe("LoopedReviewTab states", () => {
  test("shows a paused workflow with preserved pool and resume controls", () => {
    seedWorkflow({
      phase: "paused",
      pausedFromPhase: "discovering",
      activePool: {
        issues: [],
        coverageGaps: [{
          poolId: "gap-stable",
          file: "src/recovery.test.ts",
          untestedBehavior: "Inactive-tab recovery.",
        }],
      },
    });
    render(<LoopedReviewTab data={data} isActive={false} />);

    expect(screen.getByText("Workflow paused")).toBeTruthy();
    expect(screen.getByText("Inactive-tab recovery.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Resume/ })).toBeTruthy();
    expect(screen.getByText((content) => content.includes("Round 1 · pass —/6")))
      .toBeTruthy();
  });

  test("shows retry and cancellation controls for a failed phase", () => {
    seedWorkflow({
      phase: "failed",
      failure: {
        code: "structured-output",
        message: "Schema retries exhausted",
        retryPhase: "discovering",
        occurredAt: "2026-07-25T00:00:00.000Z",
      },
    });
    render(<LoopedReviewTab data={data} isActive />);

    expect(screen.getByRole("alert").textContent).toContain("Schema retries exhausted");
    expect(screen.getByRole("button", { name: /Retry phase/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeTruthy();
  });

  test("renders a completed PR and retains archived round pools", () => {
    seedWorkflow({
      phase: "completed",
      pr: {
        status: "created",
        sessionId: "pr-session",
        url: "https://github.com/org/repo/pull/42",
      },
      archivedPools: [{
        round: 1,
        fixedAt: "2026-07-25T00:00:00.000Z",
        fixSessionId: "fix-session",
        pool: {
          issues: [],
          coverageGaps: [{
            poolId: "gap-1",
            file: "src/review.test.ts",
            untestedBehavior: "The restart path.",
          }],
        },
      }],
    });
    render(<LoopedReviewTab data={data} isActive={false} />);

    expect(screen.getByText("Review complete and PR created")).toBeTruthy();
    expect(
      screen.getByRole("link", {
        name: (name) => name.includes("pull/42"),
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /Archived pool · round 1/ }),
    ).toBeTruthy();
    expect(screen.getByText("The restart path.")).toBeTruthy();
  });

  test("renders complete finding guidance in active pools", () => {
    seedWorkflow({
      phase: "paused",
      pausedFromPhase: "fixing",
      activePool: {
        issues: [{
          poolId: "issue-1",
          severity: "P1",
          confidence: 91,
          category: "correctness",
          title: "Lost result",
          file: "src/review.ts",
          line: 42,
          symbol: "applyResult",
          description: "The result can be lost.",
          evidence: "The lease is cleared first.",
          suggestion: "Consume the lease atomically.",
          verification: "Pause before result resolution.",
          alternativeFixes: ["Record the result while paused."],
        }],
        coverageGaps: [],
      },
    });
    render(<LoopedReviewTab data={data} isActive={false} />);

    expect(screen.getByText("The lease is cleared first.")).toBeTruthy();
    expect(screen.getByText("Consume the lease atomically.")).toBeTruthy();
    expect(screen.getByText("Pause before result resolution.")).toBeTruthy();
    expect(screen.getByText("Record the result while paused.")).toBeTruthy();
    expect(screen.getByText(/applyResult/)).toBeTruthy();
  });
});

describe("app-lifetime looped-review controller", () => {
  function agentWith(
    getResult: (
      sessionId: string,
      requestId: string,
    ) => Promise<StructuredOutputResult<unknown> | null>,
    getStatus: NativeStructuredAgent["getStatus"] = async () => "idle",
  ): NativeStructuredAgent {
    return {
      provider: "codex",
      // Keep the controller parked at the next phase boundary unless a test
      // explicitly supplies the next session behavior.
      createSession: () => new Promise<string>(() => {}),
      send: async () => {
        throw new Error("unexpected dispatch");
      },
      getResult: getResult as NativeStructuredAgent["getResult"],
      getStatus,
      abort: async () => true,
    };
  }

  test("advances a restored workflow without a visible tab", async () => {
    const workflow = seedSentReconciliationWorkflow();
    const agent = agentWith(async () => successfulReconciliation);
    render(
      <LoopedReviewSupervisor
        connectAgent={async () => agent}
        pollIntervalMs={1}
      />,
    );

    await waitFor(() => {
      const current =
        useLoopedReviewStore.getState().workflows.get(workflow.id);
      if (current?.phase === "failed") {
        throw new Error(current.failure?.message ?? "workflow failed");
      }
      expect(current?.phase).toBe("fixing");
    });
    expect(
      useLoopedReviewStore.getState().workflows.get(workflow.id)?.activePool,
    ).toMatchObject({
      issues: [{ title: TEST_STRUCTURED_REVIEW_REPORT.issues[0]!.title }],
      coverageGaps: [{
        file: TEST_STRUCTURED_REVIEW_REPORT.testCoverageGaps[0]!.file,
      }],
    });
  });

  test("preserves a result lease across pause and applies it once after resume", async () => {
    const workflow = seedSentReconciliationWorkflow();
    const pending = deferred<typeof successfulReconciliation>();
    let reads = 0;
    const agent = agentWith(async () => {
      reads += 1;
      return pending.promise;
    });
    render(
      <LoopedReviewTab
        data={data}
        isActive={false}
        driveWorkflow
        controllerOnly
        connectAgent={async () => agent}
        pollIntervalMs={1}
      />,
    );
    await waitFor(() => expect(reads).toBe(1));

    act(() => {
      useLoopedReviewStore.getState().pauseWorkflow(workflow.id);
    });
    await act(async () => {
      pending.resolve(successfulReconciliation);
      await pending.promise;
    });
    expect(
      useLoopedReviewStore.getState().workflows.get(workflow.id),
    ).toMatchObject({
      phase: "paused",
      dispatch: { id: "dispatch-1", requestId: "request-1" },
      activePool: { issues: [], coverageGaps: [] },
    });

    act(() => {
      useLoopedReviewStore.getState().resumeWorkflow(workflow.id);
    });
    await waitFor(() => {
      const current =
        useLoopedReviewStore.getState().workflows.get(workflow.id);
      if (current?.phase === "failed") {
        throw new Error(current.failure?.message ?? "workflow failed");
      }
      expect(current?.phase).toBe("fixing");
    });
    expect(reads).toBe(2);
    expect(
      useLoopedReviewStore.getState().workflows.get(workflow.id)?.rounds[0]
        ?.passes[0]?.reconciliation,
    ).toBeDefined();
  });

  test("cancellation wins over a late provider result", async () => {
    const workflow = seedSentReconciliationWorkflow();
    const pending = deferred<typeof successfulReconciliation>();
    const agent = agentWith(async () => pending.promise);
    render(
      <LoopedReviewTab
        data={data}
        isActive={false}
        driveWorkflow
        controllerOnly
        connectAgent={async () => agent}
        pollIntervalMs={1}
      />,
    );
    await waitFor(() => {
      expect(
        useLoopedReviewStore.getState().workflows.get(workflow.id)?.dispatch,
      ).toBeDefined();
    });
    act(() => {
      useLoopedReviewStore.getState().cancelWorkflow(workflow.id);
    });
    await act(async () => {
      pending.resolve(successfulReconciliation);
      await pending.promise;
    });

    expect(
      useLoopedReviewStore.getState().workflows.get(workflow.id),
    ).toMatchObject({
      phase: "cancelled",
      dispatch: undefined,
      activePool: { issues: [], coverageGaps: [] },
    });
  });

  test("turns a missing restored provider session into a bounded retryable failure", async () => {
    const workflow = seedSentReconciliationWorkflow();
    const agent = agentWith(async () => null, async () => null);
    render(
      <LoopedReviewTab
        data={data}
        isActive={false}
        driveWorkflow
        controllerOnly
        connectAgent={async () => agent}
        pollIntervalMs={1}
        missingSessionPollLimit={2}
      />,
    );

    await waitFor(() => {
      expect(
        useLoopedReviewStore.getState().workflows.get(workflow.id)?.phase,
      ).toBe("failed");
    });
    expect(
      useLoopedReviewStore.getState().workflows.get(workflow.id)?.failure,
    ).toMatchObject({
      retryPhase: "reconciling",
      preserveDispatch: true,
    });
  });
});

describe("LoopedReviewTab result validation", () => {
  test("rejects contradictory fix completion", () => {
    expect(() => parseFixResult({
      complete: true,
      summary: "Finished",
      filesChanged: ["src/a.ts"],
      commandsRun: [{
        command: "bun test",
        result: "failed",
        summary: "one failure",
      }],
      limitations: [],
    })).toThrow("cannot be complete");

    expect(parseFixResult({
      complete: true,
      summary: "Finished",
      filesChanged: ["src/a.ts"],
      commandsRun: [{
        command: "bun test",
        result: "passed",
        summary: "passed",
      }],
      limitations: [],
    }).complete).toBe(true);
  });

  test("accepts only HTTPS pull-request URLs", () => {
    expect(() => parsePrResult({
      status: "created",
      url: "https://example.com/not-a-pr",
      summary: "Created",
    })).toThrow("runtime validation");
    expect(parsePrResult({
      status: "created",
      url: "https://github.example/org/repo/pull/42",
      summary: "Created",
    }).url).toEndWith("/pull/42");
  });

  test("fails closed on a phase-incompatible recovered dispatch", () => {
    const workflow = seedWorkflow({ phase: "preparing" });
    const malformed = {
      id: "dispatch-1",
      requestId: "request-1",
      sessionId: "session-1",
      phase: "preparing",
      kind: "pr",
      state: "sent",
      createdAt: workflow.createdAt,
    } as unknown as NonNullable<LoopedReviewWorkflow["dispatch"]>;
    expect(() => dispatchMaterial(workflow, malformed)).toThrow("incompatible");
  });
});
