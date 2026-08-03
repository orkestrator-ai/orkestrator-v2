import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { TerminalProvider, useTerminalContext } from "@/contexts";
import { useLoopedReviewStore, type LoopedReviewWorkflow } from "@/stores/loopedReviewStore";
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
    providerSession: mock(async () => ({ providerSessionId: "provider-1" })),
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
