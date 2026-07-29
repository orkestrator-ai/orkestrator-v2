import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import type { NativeStructuredAgent } from "@/lib/structured-review-agent";
import {
  StructuredOutputReadUnavailableError,
  type StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  dispatchMaterial,
  LoopedReviewTab,
  parseFixResult,
  parsePrResult,
  parseReviewPreparationResult,
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

function seedSentWorkflow(
  phase: "preparing" | "creating-pr",
): LoopedReviewWorkflow {
  const created = seedWorkflow({ phase });
  const session = {
    id: "workflow-session",
    phase: phase === "preparing" ? "preparation" as const : "pr" as const,
    round: 1,
    providerSessionId: "provider-session",
    requestIds: ["request-1"],
    status: "running" as const,
    startedAt: created.createdAt,
  };
  const workflow: LoopedReviewWorkflow = {
    ...created,
    phase,
    sessions: [session],
    activeSessionId: session.id,
    pr: phase === "creating-pr"
      ? { status: "running", sessionId: session.id }
      : created.pr,
    dispatch: {
      id: "dispatch-1",
      requestId: "request-1",
      sessionId: session.id,
      phase,
      kind: phase === "preparing" ? "prepare" : "pr",
      state: "sent",
      createdAt: created.createdAt,
    },
  };
  useLoopedReviewStore.setState({
    workflows: new Map([[workflow.id, workflow]]),
  });
  return workflow;
}

function seedSentFixWorkflow(): LoopedReviewWorkflow {
  const created = seedWorkflow({ startingAllowance: 1, currentAllowance: 1 });
  const session = {
    id: "workflow-session",
    phase: "fix" as const,
    round: 1,
    providerSessionId: "provider-session",
    requestIds: ["request-1"],
    status: "running" as const,
    startedAt: created.createdAt,
  };
  const workflow: LoopedReviewWorkflow = {
    ...created,
    phase: "fixing",
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
        alternativeFixes: [],
      }],
      coverageGaps: [],
    },
    sessions: [session],
    activeSessionId: session.id,
    dispatch: {
      id: "dispatch-1",
      requestId: "request-1",
      sessionId: session.id,
      phase: "fixing",
      kind: "fix",
      state: "sent",
      createdAt: created.createdAt,
    },
  };
  useLoopedReviewStore.setState({
    workflows: new Map([[workflow.id, workflow]]),
  });
  return workflow;
}

const preparedPackage = {
  id: "review-package-workflow-review-r1",
  round: 1,
  preparedAt: "2026-07-25T00:00:00.000Z",
  targetBranch: "main",
  baseRef: "a".repeat(40),
  headRef: "b".repeat(40),
  commit: null,
  completeDiff: "",
  changedFiles: [],
  validation: [],
  skippedFiles: [],
  uncommittedFiles: [],
  limitations: [],
  context: null,
};

const successfulPreparation = {
  validation: [],
  uncommittedFiles: [],
  limitations: [],
};

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

  test("renders the fix session's summary and notes on an archived pool", () => {
    seedWorkflow({
      phase: "creating-pr",
      archivedPools: [{
        round: 1,
        fixedAt: "2026-07-25T00:00:00.000Z",
        fixSessionId: "fix-session",
        pool: { issues: [], coverageGaps: [] },
        fixSummary: "Resolved the pool",
        fixNotes: ["Coverage gap 2 was disproved by the current tests."],
      }],
    });
    render(<LoopedReviewTab data={data} isActive={false} />);

    expect(screen.getByText("Resolved the pool")).toBeTruthy();
    expect(
      screen.getByText("Coverage gap 2 was disproved by the current tests."),
    ).toBeTruthy();
  });

  test("renders an archived pool restored without a fix outcome", () => {
    seedWorkflow({
      phase: "creating-pr",
      archivedPools: [{
        round: 1,
        fixedAt: "2026-07-25T00:00:00.000Z",
        fixSessionId: "fix-session",
        pool: { issues: [], coverageGaps: [] },
      }],
    });
    render(<LoopedReviewTab data={data} isActive={false} />);

    expect(screen.getByText("Archived pool · round 1")).toBeTruthy();
    expect(screen.queryByText("Fix session notes")).toBeNull();
  });

  test("renders failed hydration and retries the authoritative restore", async () => {
    const restored = seedWorkflow({ phase: "paused", pausedFromPhase: "preparing" });
    useLoopedReviewStore.setState({ workflows: new Map() });
    let attempts = 0;
    const hydrateWorkflow = mock(async () => {
      attempts += 1;
      if (attempts === 1) return null;
      useLoopedReviewStore.getState().replaceWorkflow(restored);
      return restored;
    });

    render(
      <LoopedReviewTab
        data={data}
        isActive={false}
        hydrateWorkflow={hydrateWorkflow}
      />,
    );

    expect(await screen.findByText("Looped review unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry restore/ }));
    expect(await screen.findByText("Workflow paused")).toBeTruthy();
    expect(hydrateWorkflow).toHaveBeenCalledTimes(2);
  });

  test("cancels locally even when aborting the provider fails", async () => {
    const workflow = seedWorkflow({ phase: "preparing" });
    const sessionId = useLoopedReviewStore.getState().addSession(workflow.id, {
      phase: "preparation",
      round: 1,
      providerSessionId: "provider-session",
    })!;
    const abort = mock(async () => {
      throw new Error("bridge offline");
    });
    const agent: NativeStructuredAgent = {
      provider: "codex",
      createSession: async () => "unused",
      send: async () => ({ accepted: true, requestId: "unused" }),
      getResult: async () => null,
      getStatus: async () => "running",
      abort,
    };

    render(
      <LoopedReviewTab
        data={data}
        isActive
        connectAgent={async () => agent}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id))
        .toMatchObject({
          phase: "cancelled",
          sessions: [{ id: sessionId, status: "cancelled" }],
        });
    });
    expect(abort).toHaveBeenCalledWith("provider-session");
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
        claimController={async () => ({
          granted: true,
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
        })}
        releaseController={async () => undefined}
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
    const send = mock(async (
      _sessionId: string,
      _prompt: string,
      _schema: unknown,
      requestId: string,
    ) => ({ accepted: true as const, requestId }));
    const agent: NativeStructuredAgent = {
      provider: "codex",
      createSession: async () => "replacement-provider-session",
      send,
      getResult: async () => null,
      getStatus: async (sessionId) =>
        sessionId === "provider-session" ? "missing" : "running",
      abort: async () => true,
    };
    render(
      <LoopedReviewTab
        data={data}
        isActive={false}
        driveWorkflow
        controllerOnly
        connectAgent={async () => agent}
        persistWorkflow={async (workflowId) =>
          useLoopedReviewStore.getState().workflows.get(workflowId)!}
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
      preserveDispatch: false,
    });

    act(() => {
      useLoopedReviewStore.getState().retryWorkflow(workflow.id);
    });
    await waitFor(() => {
      expect(
        useLoopedReviewStore.getState().workflows.get(workflow.id),
      ).toMatchObject({
        phase: "reconciling",
        sessions: [{
          id: "workflow-session",
          providerSessionId: "replacement-provider-session",
          status: "running",
        }],
        dispatch: {
          kind: "reconcile",
          state: "sent",
        },
      });
    });
    expect(send).toHaveBeenCalledWith(
      "replacement-provider-session",
      expect.any(String),
      expect.any(Object),
      expect.any(String),
    );
  });

  test("preserves the dispatch lease when the structured-result channel is unavailable", async () => {
    const workflow = seedSentReconciliationWorkflow();
    const agent = agentWith(async (_sessionId, requestId) => {
      throw new StructuredOutputReadUnavailableError(
        "codex",
        "result channel offline",
        { requestId },
      );
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

    await waitFor(() => {
      expect(
        useLoopedReviewStore.getState().workflows.get(workflow.id)?.phase,
      ).toBe("failed");
    });
    expect(
      useLoopedReviewStore.getState().workflows.get(workflow.id),
    ).toMatchObject({
      dispatch: {
        id: "dispatch-1",
        requestId: "request-1",
      },
      failure: {
        message: "result channel offline",
        retryPhase: "reconciling",
        preserveDispatch: true,
      },
    });
  });

  test("records an authoritative provider failure as a non-preservable lease", async () => {
    const workflow = seedSentReconciliationWorkflow();
    const agent = agentWith(async () => ({
      ok: false,
      provider: "codex",
      requestId: "request-1",
      error: {
        code: "malformed_output",
        provider: "codex",
        retryable: true,
        message: "Structured output did not match the reconciliation schema",
      },
    }));

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
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id))
        .toMatchObject({
          phase: "failed",
          sessions: [{
            id: "workflow-session",
            status: "error",
            error: "Structured output did not match the reconciliation schema",
          }],
          failure: {
            code: "structured-output",
            retryPhase: "reconciling",
          },
        });
    });
    expect(
      useLoopedReviewStore.getState().workflows.get(workflow.id)?.failure
        ?.preserveDispatch,
    ).not.toBe(true);
  });

  test("reconnects to a restarted provider before retrying a preserved lease", async () => {
    const workflow = seedSentReconciliationWorkflow();
    const firstAgent = agentWith(async (_sessionId, requestId) => {
      throw new StructuredOutputReadUnavailableError(
        "codex",
        "bridge restarted",
        { requestId },
      );
    });
    const secondAgent = agentWith(async () => successfulReconciliation);
    let connections = 0;

    render(
      <LoopedReviewTab
        data={data}
        isActive={false}
        driveWorkflow
        controllerOnly
        connectAgent={async () => {
          connections += 1;
          return connections === 1 ? firstAgent : secondAgent;
        }}
        pollIntervalMs={1}
      />,
    );
    await waitFor(() => {
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id)?.phase)
        .toBe("failed");
    });

    act(() => {
      useLoopedReviewStore.getState().retryWorkflow(workflow.id);
    });
    await waitFor(() => {
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id)?.phase)
        .toBe("fixing");
    });
    expect(connections).toBe(2);
  });

  test("creates, persists, and sends the first preparation lease", async () => {
    const workflow = seedWorkflow({ phase: "preparing" });
    const send = mock(async (
      _sessionId: string,
      _prompt: string,
      _schema: unknown,
      requestId: string,
    ) => ({ accepted: true as const, requestId }));
    const persistWorkflow = mock(async (workflowId: string) =>
      useLoopedReviewStore.getState().workflows.get(workflowId)!);
    const agent: NativeStructuredAgent = {
      provider: "codex",
      createSession: async () => "preparation-provider-session",
      send,
      getResult: async () => null,
      getStatus: async () => "running",
      abort: async () => true,
    };

    render(
      <LoopedReviewTab
        data={data}
        isActive={false}
        driveWorkflow
        controllerOnly
        connectAgent={async () => agent}
        persistWorkflow={persistWorkflow}
        pollIntervalMs={1}
      />,
    );

    await waitFor(() => {
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id))
        .toMatchObject({
          sessions: [{
            phase: "preparation",
            providerSessionId: "preparation-provider-session",
          }],
          dispatch: {
            kind: "prepare",
            state: "sent",
          },
        });
    });
    expect(persistWorkflow).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("advances only after the backend generates a deterministic package", async () => {
    const workflow = seedSentWorkflow("preparing");
    const generatePackage = mock(async () => preparedPackage);
    const agent = agentWith(async () => ({
      ok: true,
      provider: "codex",
      requestId: "request-1",
      value: successfulPreparation,
    }));

    render(
      <LoopedReviewTab
        data={data}
        isActive={false}
        driveWorkflow
        controllerOnly
        connectAgent={async () => agent}
        generatePackage={generatePackage}
        pollIntervalMs={1}
      />,
    );

    await waitFor(() => {
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id)?.phase)
        .toBe("discovering");
    });
    expect(generatePackage).toHaveBeenCalledWith(
      data.environmentId,
      "review-package-workflow-review-r1",
      1,
      "main",
      successfulPreparation,
    );
  });

  test("fails closed when deterministic package generation rejects preparation", async () => {
    const workflow = seedSentWorkflow("preparing");
    const agent = agentWith(async () => ({
      ok: true,
      provider: "codex",
      requestId: "request-1",
      value: successfulPreparation,
    }));

    render(
      <LoopedReviewTab
        data={data}
        isActive={false}
        driveWorkflow
        controllerOnly
        connectAgent={async () => agent}
        generatePackage={async () => {
          throw new Error("Preparation result does not account for every uncommitted file");
        }}
        pollIntervalMs={1}
      />,
    );

    await waitFor(() => {
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id))
        .toMatchObject({
          phase: "failed",
          failure: {
            code: "package",
            preserveDispatch: false,
          },
        });
    });
    expect(
      useLoopedReviewStore.getState().workflows.get(workflow.id)?.rounds[0]?.package,
    ).toBeUndefined();
  });

  test("completes only with a backend-verified open PR", async () => {
    const workflow = seedSentWorkflow("creating-pr");
    const prUrl = "https://github.com/acme/repo/pull/42";
    const verifyPr = mock(async () => ({
      url: prUrl,
      headRefName: "feature",
      baseRefName: "main",
      state: "OPEN" as const,
    }));
    const agent = agentWith(async () => ({
      ok: true,
      provider: "codex",
      requestId: "request-1",
      value: { status: "created", url: prUrl, summary: "Created PR" },
    }));

    render(
      <LoopedReviewTab
        data={data}
        isActive={false}
        driveWorkflow
        controllerOnly
        connectAgent={async () => agent}
        verifyPr={verifyPr}
        pollIntervalMs={1}
      />,
    );

    await waitFor(() => {
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id))
        .toMatchObject({
          phase: "completed",
          pr: { status: "created", url: prUrl },
        });
    });
    expect(verifyPr).toHaveBeenCalledWith(data.environmentId, prUrl, "main");
  });

  test("does not complete when backend PR verification rejects model evidence", async () => {
    const workflow = seedSentWorkflow("creating-pr");
    const prUrl = "https://github.com/acme/repo/pull/42";
    const agent = agentWith(async () => ({
      ok: true,
      provider: "codex",
      requestId: "request-1",
      value: { status: "created", url: prUrl, summary: "Created PR" },
    }));

    render(
      <LoopedReviewTab
        data={data}
        isActive={false}
        driveWorkflow
        controllerOnly
        connectAgent={async () => agent}
        verifyPr={async () => {
          throw new Error("Pull request head branch does not match the environment branch");
        }}
        pollIntervalMs={1}
      />,
    );

    await waitFor(() => {
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id))
        .toMatchObject({
          phase: "failed",
          pr: {
            status: "failed",
            error: "Pull request head branch does not match the environment branch",
          },
          failure: {
            code: "pr",
          },
        });
    });
    expect(
      useLoopedReviewStore.getState().workflows.get(workflow.id)?.failure
        ?.preserveDispatch,
    ).not.toBe(true);
  });

  test("archives the fixed pool with the session's summary and notes", async () => {
    const workflow = seedSentFixWorkflow();
    const agent = agentWith(async () => ({
      ok: true,
      provider: "codex",
      requestId: "request-1",
      value: {
        complete: true,
        summary: "Resolved the pool",
        filesChanged: ["src/review.ts"],
        commandsRun: [
          { command: "bun test", result: "failed", summary: "1 fail" },
          { command: "bun test", result: "passed", summary: "0 fail" },
        ],
        notes: ["Coverage gap 2 was disproved by the current tests."],
        limitations: [],
      },
    }));

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
      const current =
        useLoopedReviewStore.getState().workflows.get(workflow.id);
      if (current?.phase === "failed") {
        throw new Error(current.failure?.message ?? "workflow failed");
      }
      expect(current?.phase).toBe("creating-pr");
    });
    expect(
      useLoopedReviewStore.getState().workflows.get(workflow.id)
        ?.archivedPools[0],
    ).toMatchObject({
      round: 1,
      fixSessionId: "workflow-session",
      fixSummary: "Resolved the pool",
      fixNotes: ["Coverage gap 2 was disproved by the current tests."],
    });
  });

  test("reports every blocker when the fix session did not finish", async () => {
    const workflow = seedSentFixWorkflow();
    const agent = agentWith(async () => ({
      ok: true,
      provider: "codex",
      requestId: "request-1",
      value: {
        complete: false,
        summary: "Partially fixed",
        filesChanged: ["src/review.ts"],
        commandsRun: [
          { command: "bun test", result: "failed", summary: "2 failures" },
        ],
        notes: ["Left the unrelated worktree changes alone."],
        limitations: ["Issue 1 needs a decision on the retry contract."],
      },
    }));

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
      expect(useLoopedReviewStore.getState().workflows.get(workflow.id))
        .toMatchObject({
          phase: "failed",
          failure: { code: "fix", retryPhase: "fixing" },
        });
    });
    const failure =
      useLoopedReviewStore.getState().workflows.get(workflow.id)?.failure;
    // Every blocker must be listed, not just the first limitation.
    expect(failure?.message).toBe(
      "The fix session did not resolve the complete active pool:\n"
      + "- Failed validation: bun test — 2 failures\n"
      + "- Blocking limitation: Issue 1 needs a decision on the retry contract.",
    );
    expect(failure?.preserveDispatch).not.toBe(true);
    expect(
      useLoopedReviewStore.getState().workflows.get(workflow.id)?.archivedPools,
    ).toHaveLength(0);
  });
});

describe("LoopedReviewTab result validation", () => {
  test("accepts preparation metadata and rejects model-authored package evidence", () => {
    expect(parseReviewPreparationResult(successfulPreparation))
      .toEqual(successfulPreparation);
    expect(() => parseReviewPreparationResult(preparedPackage)).toThrow(
      "Review preparation result failed runtime validation",
    );
    expect(() => parseReviewPreparationResult({
      ...successfulPreparation,
      validation: [{
        command: "bun test",
        status: "passed",
        exitCode: 1,
        stdoutPath: "stdout.txt",
        stderrPath: "stderr.txt",
        durationMs: 10,
        limitation: null,
      }],
    })).toThrow("Review preparation result failed runtime validation");
  });

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
      notes: [],
      limitations: ["A second validation could not run"],
    })).toThrow(
      "Failed validation: bun test — one failure\n- Blocking limitation: A second validation could not run",
    );

    expect(parseFixResult({
      complete: true,
      summary: "Finished",
      filesChanged: ["src/a.ts"],
      commandsRun: [{
        command: "bun test",
        result: "passed",
        summary: "passed",
      }],
      notes: ["Preserved the existing feature branch and its commits."],
      limitations: [],
    })).toEqual({
      complete: true,
      summary: "Finished",
      filesChanged: ["src/a.ts"],
      commandsRun: [{
        command: "bun test",
        result: "passed",
        summary: "passed",
      }],
      notes: ["Preserved the existing feature branch and its commits."],
      limitations: [],
    });

    expect(() => parseFixResult({
      complete: false,
      summary: "Not finished",
      filesChanged: [],
      commandsRun: [],
      notes: ["No blocking issue was found."],
      limitations: [],
    })).toThrow(
      "cannot be incomplete without a failed validation or blocking limitation."
      + " Session summary: Not finished",
    );
  });

  test("treats the last report for a command as its final result", () => {
    // A fix session that repairs what its own validation caught and re-runs the
    // command is green. Counting the superseded attempt would stall the loop.
    const revalidated = {
      complete: true,
      summary: "Fixed the failing assertion and re-ran the suite",
      filesChanged: ["src/a.ts"],
      commandsRun: [
        { command: "bun test", result: "failed" as const, summary: "1 fail" },
        { command: "bun test", result: "passed" as const, summary: "0 fail" },
      ],
      notes: [],
      limitations: [],
    };
    expect(parseFixResult(revalidated)).toEqual(revalidated);

    // The reverse order is a genuine blocker: the command ended up failing.
    expect(() => parseFixResult({
      ...revalidated,
      commandsRun: [
        { command: "bun test", result: "passed", summary: "0 fail" },
        { command: "bun test", result: "failed", summary: "1 fail" },
      ],
    })).toThrow("- Failed validation: bun test — 1 fail");

    // A different command that never passed is still counted.
    expect(() => parseFixResult({
      ...revalidated,
      commandsRun: [
        ...revalidated.commandsRun,
        { command: "bun run typecheck", result: "failed", summary: "" },
      ],
    })).toThrow("- Failed validation: bun run typecheck");
  });

  test("normalizes notes and limitations the strict schema cannot constrain", () => {
    // The provider schema is the OpenAI strict subset, which has no minLength,
    // so blank entries must be dropped rather than fail the whole round.
    expect(parseFixResult({
      complete: true,
      summary: "Finished",
      filesChanged: [],
      commandsRun: [],
      notes: ["  Kept the branch  ", "", "   "],
      limitations: [],
    })).toMatchObject({ notes: ["Kept the branch"], limitations: [] });

    // A whitespace-only limitation describes no blocker, so it cannot justify
    // an incomplete result either.
    expect(() => parseFixResult({
      complete: false,
      summary: "Not finished",
      filesChanged: [],
      commandsRun: [],
      notes: [],
      limitations: ["   "],
    })).toThrow("cannot be incomplete without a failed validation");

    expect(() => parseFixResult({
      complete: true,
      summary: "Finished",
      filesChanged: [],
      commandsRun: [],
      notes: [42],
      limitations: [],
    })).toThrow("Fix result failed runtime validation");
  });

  test("defaults notes for a fix result dispatched before the field existed", () => {
    // A dispatch sent by an earlier build is replayed by request ID after an
    // upgrade; rejecting it would fail a workflow that actually succeeded.
    expect(parseFixResult({
      complete: true,
      summary: "Finished",
      filesChanged: ["src/a.ts"],
      commandsRun: [],
      limitations: [],
    })).toEqual({
      complete: true,
      summary: "Finished",
      filesChanged: ["src/a.ts"],
      commandsRun: [],
      notes: [],
      limitations: [],
    });
  });

  test("rejects structurally invalid fix results", () => {
    const valid = {
      complete: true,
      summary: "Finished",
      filesChanged: ["src/a.ts"],
      commandsRun: [
        { command: "bun test", result: "passed" as const, summary: "ok" },
      ],
      notes: [],
      limitations: [],
    };
    expect(parseFixResult(valid)).toEqual(valid);

    for (
      const invalid of [
        null,
        "not an object",
        [],
        { ...valid, unexpected: "extra" },
        { ...valid, complete: "true" },
        { ...valid, summary: "   " },
        { ...valid, filesChanged: ["src/a.ts", "src/a.ts"] },
        { ...valid, filesChanged: [" "] },
        { ...valid, filesChanged: [42] },
        { ...valid, commandsRun: [{ ...valid.commandsRun[0], extra: 1 }] },
        { ...valid, commandsRun: [{ ...valid.commandsRun[0], result: "errored" }] },
        { ...valid, commandsRun: [{ ...valid.commandsRun[0], command: "  " }] },
        { ...valid, commandsRun: [{ command: "bun test", result: "passed" }] },
        { ...valid, notes: "not a list" },
        { ...valid, limitations: [null] },
      ]
    ) {
      expect(() => parseFixResult(invalid)).toThrow(
        "Fix result failed runtime validation",
      );
    }
  });

  test("accepts only canonical-host HTTPS pull-request URLs", () => {
    expect(() => parsePrResult({
      status: "created",
      url: "https://example.com/not-a-pr",
      summary: "Created",
    })).toThrow("runtime validation");
    expect(() => parsePrResult({
      status: "created",
      url: "https://github.example/org/repo/pull/42",
      summary: "Created",
    })).toThrow("runtime validation");
    expect(parsePrResult({
      status: "created",
      url: "https://github.com/org/repo/pull/42",
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
