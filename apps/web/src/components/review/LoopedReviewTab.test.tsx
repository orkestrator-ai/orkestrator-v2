import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { TerminalProvider, useTerminalContext } from "@/contexts";
import {
  useLoopedReviewStore,
  type LoopedReviewSession,
  type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";
import { loopedReviewFixture } from "@/test/looped-review-fixture";
import {
  LoopedReviewTab,
} from "./LoopedReviewTab";

const data = {
  environmentId: "env-1",
  workflowId: "workflow-view",
  isLocal: true,
};

function commands(result: LoopedReviewWorkflow) {
  return {
    pause: mock(async () => result),
    resume: mock(async () => result),
    retry: mock(async () => result),
    cancel: mock(async () => result),
    providerSession: mock(async (): Promise<{ providerSessionId: string } | null> => ({ providerSessionId: "provider-1" })),
  };
}

function TabRegistrar({ createTab }: { createTab: ReturnType<typeof mock> }) {
  const terminal = useTerminalContext();
  useEffect(() => {
    terminal.setCreateTab(createTab);
    return () => terminal.setCreateTab(null);
  }, [createTab, terminal]);
  return null;
}

beforeEach(() => {
  useLoopedReviewStore.setState({ workflows: new Map() });
});

afterEach(cleanup);

describe("LoopedReviewTab backend snapshot viewer", () => {
  test("hydrates a missing projection and renders the progressed backend phase", async () => {
    const restored = loopedReviewFixture({
      id: data.workflowId,
      phase: "paused",
      pausedFromPhase: "fixing",
      backendRevision: 8,
    });
    const hydrate = mock(async () => {
      useLoopedReviewStore.getState().replaceWorkflow(restored);
      return restored;
    });

    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={hydrate} />);

    expect(await screen.findByText("Workflow paused")).toBeTruthy();
    expect(screen.getByText(/Backend progress is paused at fixing/)).toBeTruthy();
  });

  test("retries a null restore through the guarded hydration path", async () => {
    const restored = loopedReviewFixture({
      id: data.workflowId,
      phase: "paused",
      pausedFromPhase: "discovering",
      backendRevision: 3,
    });
    let attempts = 0;
    const hydrate = mock(async () => {
      attempts += 1;
      if (attempts === 1) return null;
      useLoopedReviewStore.getState().replaceWorkflow(restored);
      return restored;
    });

    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={hydrate} />);
    expect(await screen.findByText("Looped review unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry restore" }));

    expect(await screen.findByText("Workflow paused")).toBeTruthy();
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  test("reports restore rejection and ignores its completion after unmount", async () => {
    const rejected = mock(async () => {
      throw new Error("workflow store unavailable");
    });
    const view = render(<LoopedReviewTab data={data} isActive hydrateWorkflow={rejected} />);
    expect(await screen.findByText("workflow store unavailable")).toBeTruthy();
    view.unmount();

    let resolveRestore!: (workflow: LoopedReviewWorkflow | null) => void;
    const deferred = new Promise<LoopedReviewWorkflow | null>((resolve) => {
      resolveRestore = resolve;
    });
    const second = render(<LoopedReviewTab data={data} isActive hydrateWorkflow={() => deferred} />);
    second.unmount();
    resolveRestore(null);
    await deferred;
  });

  test("rehydrates failure context, unattended history, counts, and controls", () => {
    const workflow = loopedReviewFixture({
      id: data.workflowId,
      phase: "failed",
      backendRevision: 10,
      failure: {
        code: "interactive-request",
        message: "The review pass requested unexpected authorization",
        retryPhase: "discovering",
        occurredAt: "2026-08-02T00:00:00.000Z",
      },
      autoDeclineCount: 1,
      sessions: [{
        id: "session-1",
        phase: "discovery",
        round: 1,
        pass: 1,
        sessionKey: "looped-review:workflow-view:discovery:1:1",
        providerSessionId: "provider-1",
        requestIds: ["request-1"],
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        autoDeclineCount: 1,
        interactionTranscript: [{
          id: "question-1",
          provider: "opencode",
          kind: "question",
          phase: "discovery",
          requestedAt: 1,
          resolvedAt: 2,
          outcome: "auto-declined-headless",
          title: "Choose a safe default",
          questions: [],
        }],
        status: "error",
        startedAt: "2026-08-02T00:00:00.000Z",
      }],
      activeSessionId: "session-1",
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);

    render(<LoopedReviewTab data={data} isActive commands={commands(workflow)} />);

    expect(screen.getByRole("alert").textContent).toContain("unexpected authorization");
    expect(screen.getByText(/1 auto-declined/)).toBeTruthy();
    expect(screen.getByText("Choose a safe default")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry phase" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Provider session" })).toBeTruthy();
  });

  test("pause is a backend command and installs only its returned snapshot", async () => {
    const running = loopedReviewFixture({ id: data.workflowId, phase: "discovering", backendRevision: 2 });
    const paused = { ...running, phase: "paused" as const, pausedFromPhase: "discovering" as const, backendRevision: 3 };
    const api = commands(paused);
    useLoopedReviewStore.getState().replaceWorkflow(running);

    render(<LoopedReviewTab data={data} isActive commands={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(api.pause).toHaveBeenCalledWith(data.workflowId));
    expect(useLoopedReviewStore.getState().workflows.get(data.workflowId)).toEqual(paused);
    expect(await screen.findByText("Workflow paused")).toBeTruthy();
  });

  test("resume, retry, and cancel install only authoritative command results", async () => {
    for (const scenario of [
      { phase: "paused" as const, pausedFromPhase: "fixing" as const, label: "Resume", command: "resume" as const },
      { phase: "failed" as const, pausedFromPhase: undefined, label: "Retry phase", command: "retry" as const },
      { phase: "discovering" as const, pausedFromPhase: undefined, label: "Cancel", command: "cancel" as const },
    ]) {
      cleanup();
      useLoopedReviewStore.setState({ workflows: new Map() });
      const current = loopedReviewFixture({
        id: data.workflowId,
        phase: scenario.phase,
        pausedFromPhase: scenario.pausedFromPhase,
      });
      const next = loopedReviewFixture({ id: data.workflowId, phase: "cancelled", backendRevision: 20 });
      const api = commands(next);
      useLoopedReviewStore.getState().replaceWorkflow(current);
      render(<LoopedReviewTab data={data} isActive commands={api} />);

      fireEvent.click(screen.getByRole("button", { name: scenario.label }));
      await waitFor(() => expect(api[scenario.command]).toHaveBeenCalledWith(data.workflowId));
      expect(useLoopedReviewStore.getState().workflows.get(data.workflowId)).toEqual(next);
    }
  });

  test("surfaces lifecycle command failures without replacing the snapshot", async () => {
    const running = loopedReviewFixture({ id: data.workflowId, phase: "discovering" });
    const api = commands(running);
    api.pause.mockImplementationOnce(async () => { throw new Error("pause refused"); });
    useLoopedReviewStore.getState().replaceWorkflow(running);

    render(<LoopedReviewTab data={data} isActive commands={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect((await screen.findByRole("alert")).textContent).toContain("pause refused");
    expect(useLoopedReviewStore.getState().workflows.get(data.workflowId)).toBe(running);
  });

  test("opens the authoritative provider session in a native agent tab", async () => {
    const workflow = loopedReviewFixture({
      id: data.workflowId,
      agent: "opencode",
      activeSessionId: "session-1",
      sessions: [{
        id: "session-1",
        phase: "preparation",
        round: 1,
        sessionKey: "fence",
        providerSessionId: "provider-1",
        requestIds: [],
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        status: "running",
        startedAt: "2026-08-02T00:00:00.000Z",
      }],
    });
    const api = commands(workflow);
    const createTab = mock(() => true);
    useLoopedReviewStore.getState().replaceWorkflow(workflow);

    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <LoopedReviewTab data={data} isActive commands={api} />
      </TerminalProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Provider session" }));

    await waitFor(() => expect(createTab).toHaveBeenCalledWith("opencode", expect.objectContaining({
      agentLaunchMode: "native",
      resumeSessionId: "provider-1",
      isReviewTab: true,
    })));
    expect(api.providerSession).toHaveBeenCalledWith(data.workflowId, "session-1");
  });

  test("surfaces missing and refused provider-session tabs", async () => {
    const workflow = loopedReviewFixture({
      id: data.workflowId,
      activeSessionId: "session-1",
      sessions: [{
        id: "session-1",
        phase: "discovery",
        round: 1,
        pass: 1,
        sessionKey: "session-key",
        providerSessionId: "provider-1",
        requestIds: [],
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        status: "running",
        startedAt: "2026-08-02T00:00:00.000Z",
      }],
    });
    const api = commands(workflow);
    api.providerSession.mockImplementationOnce(async () => null);
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock(() => false);

    render(<TerminalProvider><TabRegistrar createTab={createTab} /><LoopedReviewTab data={data} isActive commands={api} /></TerminalProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Provider session" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no longer available");

    fireEvent.click(screen.getByRole("button", { name: "Provider session" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be opened");
  });

  test("renders cancellation progress without offering duplicate lifecycle actions", () => {
    const workflow = loopedReviewFixture({
      id: data.workflowId,
      phase: "cancelling",
      cancellingFromPhase: "fixing",
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    render(<LoopedReviewTab data={data} isActive commands={commands(workflow)} />);

    expect(screen.getByText("Cancellation in progress")).toBeTruthy();
    expect(screen.getByText(/provider work from fixing/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  test("renders the completed PR from an authoritative terminal snapshot", () => {
    const workflow = loopedReviewFixture({
      id: data.workflowId,
      phase: "completed",
      pr: { status: "created", url: "https://github.com/acme/repo/pull/42" },
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    render(<LoopedReviewTab data={data} isActive commands={commands(workflow)} />);
    expect(screen.getByText("Review complete")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://github.com/acme/repo/pull/42");
  });
});

const poolIssue = {
  poolId: "issue-1", severity: "P1" as const, confidence: 92,
  category: "correctness" as const, title: "Lost transition",
  file: "src/controller.ts", line: 42, symbol: "advance",
  description: "The phase advances twice.", evidence: "Two callers pass the guard.",
  suggestion: "Persist a dispatch lease.", verification: "Reconnect mid-dispatch.",
  alternativeFixes: ["Serialize on a queue", "Serialize on a queue"],
};

const poolGap = {
  poolId: "gap-1", file: "src/controller.ts", untestedBehavior: "restart mid-dispatch",
};

const stageReport: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main", baseRef: "origin/main...HEAD", commit: null,
    filesReviewed: ["src/controller.ts"], filesSkipped: [], filesLeftUncommitted: [],
    commandsRun: [], commandsNotRun: [], limitations: [],
  },
  whatChanged: {
    overview: "Reviewed the transition.", before: "The transition was unchecked.",
    after: "The transition is checked.", keyCodeChanges: [], userImpact: "Safer retries.",
  },
  riskProfile: {
    changeTypes: ["bugfix"], riskAreas: ["workflow"], overallRisk: "medium",
    reasoning: "The workflow state changes asynchronously.",
  },
  testResults: { total: 1, passed: 1, failed: 0, notRun: 0, failures: [] },
  strengths: [], issues: [], testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "No issues remain." },
  summaryOfChange: "Checks the transition.",
  reviewSummary: "No high-confidence issues were found in the reviewed scope.",
};

function discoverySession(
  id: string,
  pass: number,
  status: LoopedReviewSession["status"] = "running",
): LoopedReviewSession {
  return {
    id, phase: "discovery", round: 1, pass,
    sessionKey: `session-key-${pass}`, providerSessionId: `provider-${pass}`,
    requestIds: [], origin: "looped-review",
    interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
    status, startedAt: "2026-08-03T00:00:00.000Z",
  };
}

describe("LoopedReviewTab content rendering", () => {
  test("builds every stage, follows active work, and pins keyboard navigation", async () => {
    const firstSession = discoverySession("session-1", 1, "idle");
    const activeSession = discoverySession("session-2", 2);
    const passes = [{
      pass: 1, sessionId: firstSession.id, status: "completed" as const,
      report: stageReport, startedAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:01:00.000Z",
    }, {
      pass: 2, sessionId: activeSession.id, status: "reconciling" as const,
      report: stageReport, startedAt: "2026-08-03T00:02:00.000Z",
    }];
    const workflow = loopedReviewFixture({
      id: data.workflowId, phase: "reconciling", currentPass: 2,
      activeSessionId: activeSession.id, sessions: [firstSession, activeSession],
      rounds: [{
        round: 1, allowance: 6, status: "reviewing",
        passes, startedAt: "2026-08-03T00:00:00.000Z",
      }],
      archivedPools: [{
        round: 1, fixedAt: "2026-08-03T00:03:00.000Z", fixSessionId: "fix-session-1",
        pool: { issues: [], coverageGaps: [] },
      }],
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => workflow)} />);

    const overviewTab = screen.getByRole("tab", { name: /Overview/ });
    const firstPassTab = screen.getByRole("tab", { name: /Round 1 · Pass 1/ });
    const activePassTab = screen.getByRole("tab", { name: /Round 1 · Pass 2/ });
    const archiveTab = screen.getByRole("tab", { name: /Round 1 · Fix/ });
    await waitFor(() => expect(activePassTab.getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByLabelText("Round 1, pass 2 report")).toBeTruthy();

    fireEvent.keyDown(activePassTab, { key: "Home" });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(overviewTab, { key: "End" });
    expect(archiveTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(archiveTab, { key: "ArrowUp" });
    expect(activePassTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(activePassTab, { key: "ArrowUp" });
    expect(firstPassTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(firstPassTab);

    // A backend update still points at pass 2, but the user's valid selection
    // remains pinned until that stage disappears from the snapshot.
    act(() => {
      useLoopedReviewStore.getState().replaceWorkflow({ ...workflow, backendRevision: 2 });
    });
    await waitFor(() => expect(firstPassTab.getAttribute("aria-selected")).toBe("true"));
    act(() => {
      useLoopedReviewStore.getState().replaceWorkflow({
        ...workflow,
        backendRevision: 3,
        rounds: [{ ...workflow.rounds[0]!, passes: [passes[1]!] }],
      });
    });
    await waitFor(() => expect(activePassTab.getAttribute("aria-selected")).toBe("true"));
  });

  test("renders paused, failed, and cancelled active passes without a running spinner", async () => {
    const activeSession = discoverySession("session-1", 1);
    const pass = {
      pass: 1, sessionId: activeSession.id, status: "discovering" as const,
      startedAt: "2026-08-03T00:00:00.000Z",
    };
    const paused = loopedReviewFixture({
      id: data.workflowId, phase: "paused", pausedFromPhase: "discovering",
      currentPass: 1, activeSessionId: activeSession.id, sessions: [activeSession],
      rounds: [{
        round: 1, allowance: 6, status: "reviewing", passes: [pass],
        startedAt: "2026-08-03T00:00:00.000Z",
      }],
    });
    useLoopedReviewStore.getState().replaceWorkflow(paused);
    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => paused)} />);

    const passTab = screen.getByRole("tab", { name: /Round 1 · Pass 1/ });
    await waitFor(() => expect(passTab.textContent).toContain("paused"));
    expect(passTab.querySelector(".animate-spin")).toBeNull();

    // Legacy snapshots can carry an errored active session while the nested pass
    // still says `discovering`; the workflow failure remains authoritative.
    act(() => {
      useLoopedReviewStore.getState().replaceWorkflow({
        ...paused,
        phase: "failed",
        pausedFromPhase: undefined,
        failure: {
          code: "provider", message: "provider disconnected", retryPhase: "discovering",
          occurredAt: "2026-08-03T00:01:00.000Z",
        },
        sessions: [{ ...activeSession, status: "error" }],
        rounds: [{ ...paused.rounds[0]!, status: "failed" }],
        backendRevision: 2,
      });
    });
    await waitFor(() => expect(passTab.textContent).toContain("failed"));
    expect(passTab.querySelector(".animate-spin")).toBeNull();

    act(() => {
      useLoopedReviewStore.getState().replaceWorkflow({
        ...paused,
        phase: "cancelled",
        pausedFromPhase: undefined,
        sessions: [{ ...activeSession, status: "cancelled" }],
        backendRevision: 3,
      });
    });
    await waitFor(() => expect(passTab.textContent).toContain("cancelled"));
    expect(passTab.querySelector(".animate-spin")).toBeNull();
  });

  test("renders pooled issues with their category, symbol and alternatives", () => {
    const workflow = loopedReviewFixture({
      id: data.workflowId, phase: "fixing",
      activePool: { issues: [poolIssue], coverageGaps: [poolGap] },
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => workflow)} />);

    expect(screen.getByText("Lost transition")).toBeTruthy();
    expect(screen.getByText(/issue-1 · P1 · 92% · correctness/)).toBeTruthy();
    expect(screen.getByText(/src\/controller\.ts:42 · advance/)).toBeTruthy();
    expect(screen.getByText(/The phase advances twice\./)).toBeTruthy();
    // Duplicate alternatives are legitimate model output and must not collide
    // on their React key.
    expect(screen.getAllByText("Serialize on a queue")).toHaveLength(2);
    expect(screen.getByText("restart mid-dispatch")).toBeTruthy();
  });

  test("renders the empty pool state", () => {
    const workflow = loopedReviewFixture({ id: data.workflowId, phase: "discovering" });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => workflow)} />);
    // The overview is what a workflow with no report yet follows.
    expect(screen.getAllByText("No pooled findings.").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: /Round 1/ }));
    expect(screen.getByText("No completed passes yet.")).toBeTruthy();
  });

  test("surfaces the review package's limitations and provenance", () => {
    // Without these the user cannot tell that the review ran against a
    // truncated package — files omitted, validation skipped.
    const workflow = loopedReviewFixture({
      id: data.workflowId, phase: "discovering",
      rounds: [{
        round: 1, allowance: 6, status: "reviewing", startedAt: "2026-08-03T00:00:00.000Z",
        passes: [],
        package: {
          id: "package-1", round: 1, preparedAt: "2026-08-03T00:00:00.000Z",
          targetBranch: "main", baseRef: "a".repeat(40), headRef: "b".repeat(40),
          commit: null, completeDiff: "diff --git a/a.ts b/a.ts",
          changedFiles: [{
            path: "src/a.ts", status: "M", content: "x",
            contentSha256: "sha", omittedReason: null,
          }],
          validation: [], skippedFiles: [], uncommittedFiles: [],
          limitations: ["Skipped the integration suite: no database available"],
        },
      }],
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => workflow)} />);
    fireEvent.click(screen.getByRole("tab", { name: /Round 1/ }));

    expect(screen.getByText("Review package limitations")).toBeTruthy();
    expect(screen.getByText(/no database available/)).toBeTruthy();
    expect(screen.getByText(/1 changed file/)).toBeTruthy();
    expect(screen.getByLabelText("Review round 1")).toBeTruthy();
  });

  test("renders archived pools with duplicate fix notes and their fix session", () => {
    const workflow = loopedReviewFixture({
      id: data.workflowId, phase: "preparing", currentRound: 2,
      rounds: [{
        round: 2, allowance: 3, status: "preparing", passes: [],
        startedAt: "2026-08-03T00:04:00.000Z",
      }],
      archivedPools: [{
        round: 1, fixedAt: "2026-08-03T00:00:00.000Z", fixSessionId: "fix-session-1",
        pool: { issues: [poolIssue], coverageGaps: [] },
        fixSummary: "Serialized the transition.",
        // A model can legitimately repeat itself; the position is the only
        // stable key.
        fixNotes: ["Rewrote the guard", "Rewrote the guard"],
      }],
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => workflow)} />);
    fireEvent.click(screen.getByRole("tab", { name: /Round 1 · Fix/ }));

    expect(screen.getByLabelText("Archived findings from round 1")).toBeTruthy();
    expect(screen.getByText("Fix session fix-session-1")).toBeTruthy();
    expect(screen.getByText("Serialized the transition.")).toBeTruthy();
    expect(screen.getAllByText("Rewrote the guard")).toHaveLength(2);
  });

  test("labels the failure with its code and the phase a retry would restart", () => {
    const workflow = loopedReviewFixture({
      id: data.workflowId, phase: "failed",
      failure: {
        code: "structured-output", message: "The provider returned no report",
        retryPhase: "discovering", occurredAt: "2026-08-03T00:00:00.000Z",
      },
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => workflow)} />);

    expect(screen.getByText("Phase failed · structured-output")).toBeTruthy();
    expect(screen.getByText(/Retry starts only the discovering phase again/)).toBeTruthy();
  });

  test("reports a pull request that never completed", () => {
    const workflow = loopedReviewFixture({
      id: data.workflowId, phase: "cancelled",
      pr: { status: "failed", error: "Cancelled before the pull request was created" },
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => workflow)} />);
    expect(screen.getByText("Pull request not created")).toBeTruthy();
    expect(screen.getByText(/Cancelled before the pull request/)).toBeTruthy();
  });

  test("renders only https pull-request links", () => {
    const hostile = loopedReviewFixture({
      id: data.workflowId, phase: "completed",
      // eslint-disable-next-line no-script-url
      pr: { status: "created", url: "javascript:alert(1)" },
    });
    useLoopedReviewStore.getState().replaceWorkflow(hostile);
    const view = render(
      <LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => hostile)} />,
    );
    // The URL comes from agent output and is read back from disk, so an
    // unvalidated href would be one click from script execution.
    expect(view.container.querySelector("a")).toBeNull();
    view.unmount();

    const safe = loopedReviewFixture({
      id: data.workflowId, phase: "completed",
      pr: { status: "created", url: "https://github.com/acme/repo/pull/7" },
    });
    useLoopedReviewStore.getState().replaceWorkflow(safe);
    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => safe)} />);
    expect(screen.getByRole("link", { name: "https://github.com/acme/repo/pull/7" })).toBeTruthy();
  });

  test("names the agent, model and target branch in the header", () => {
    const workflow = loopedReviewFixture({
      id: data.workflowId, agent: "claude", model: "opus-5",
      reasoningEffort: "high", targetBranch: "release/v2",
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    render(<LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => workflow)} />);
    expect(screen.getByText(/claude · opus-5 · high · target release\/v2/)).toBeTruthy();
  });

  test("labels every phase it can be handed", () => {
    for (const [phase, label] of [
      ["preparing", "Preparing immutable review package"],
      ["discovering", "Discovering findings"],
      ["reconciling", "Reconciling this pass"],
      ["fixing", "Fixing active pool"],
      ["creating-pr", "Creating pull request"],
    ] as const) {
      const workflow = loopedReviewFixture({ id: data.workflowId, phase });
      useLoopedReviewStore.getState().replaceWorkflow(workflow);
      const view = render(
        <LoopedReviewTab data={data} isActive hydrateWorkflow={mock(async () => workflow)} />,
      );
      expect(screen.getByText(new RegExp(label))).toBeTruthy();
      view.unmount();
    }
  });
});

describe("LoopedReviewTab command guards", () => {
  test("a command failure survives an unrelated backend snapshot update", async () => {
    const running = loopedReviewFixture({ id: data.workflowId, phase: "fixing" });
    useLoopedReviewStore.getState().replaceWorkflow(running);
    const failing = {
      ...commands(running),
      pause: mock(async () => { throw new Error("lease lost"); }),
    };
    render(
      <LoopedReviewTab
        data={data} isActive hydrateWorkflow={mock(async () => running)} commands={failing}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("lease lost")).toBeTruthy();

    // A running review publishes a new revision roughly once a second. That
    // must not erase the error the user is still reading.
    act(() => {
      useLoopedReviewStore.getState().replaceWorkflow({ ...running, backendRevision: 99 });
    });
    await waitFor(() => {
      expect(screen.getByText("lease lost")).toBeTruthy();
    });
  });

  test("a double click runs one command and opens one provider tab", async () => {
    const workflow = loopedReviewFixture({
      id: data.workflowId, phase: "discovering", activeSessionId: "session-1",
      sessions: [{
        id: "session-1", phase: "discovery", round: 1, pass: 1,
        sessionKey: "key-1", providerSessionId: "provider-1", requestIds: [],
        origin: "looped-review", interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        status: "running", startedAt: "2026-08-03T00:00:00.000Z",
      }],
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    const createTab = mock(() => true);
    const workflowCommands = commands(workflow);
    render(
      <TerminalProvider>
        <TabRegistrar createTab={createTab} />
        <LoopedReviewTab
          data={data} isActive hydrateWorkflow={mock(async () => workflow)}
          commands={workflowCommands}
        />
      </TerminalProvider>,
    );

    const button = screen.getByRole("button", { name: /Provider session/ });
    // `disabled` only takes effect after a re-render, so two clicks in one tick
    // would both run without a synchronous guard.
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => {
      expect(createTab).toHaveBeenCalledTimes(1);
    });
    expect(workflowCommands.providerSession).toHaveBeenCalledTimes(1);
  });

  test("re-reads the authoritative record when the tab becomes active again", async () => {
    const workflow = loopedReviewFixture({ id: data.workflowId, phase: "discovering" });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    const hydrate = mock(async () => workflow);
    const view = render(
      <LoopedReviewTab data={data} isActive={false} hydrateWorkflow={hydrate} />,
    );
    // Present in the store, so the mount path does not fetch.
    expect(hydrate).toHaveBeenCalledTimes(0);

    // A hidden tab can miss resource events entirely, so becoming visible again
    // must re-read rather than trust whatever is left in the store.
    view.rerender(<LoopedReviewTab data={data} isActive hydrateWorkflow={hydrate} />);
    await waitFor(() => {
      expect(hydrate).toHaveBeenCalledTimes(1);
    });

    // Staying active must not re-fetch on every render.
    view.rerender(<LoopedReviewTab data={data} isActive hydrateWorkflow={hydrate} />);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });
});
