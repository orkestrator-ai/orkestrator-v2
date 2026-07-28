import { beforeEach, describe, expect, test } from "bun:test";
import { createSessionKey } from "@/lib/utils";
import type {
  CodexApproval,
  CodexClient,
  CodexInteraction,
  CodexMessage,
  CodexSessionStatusLookupResult,
} from "@/lib/codex-client";
import { useCodexStore } from "@/stores/codexStore";
import {
  createCodexBackgroundSynchronizer,
  type CodexBackgroundSyncDependencies,
} from "./useCodexBackgroundSync";

const ENVIRONMENT_ID = "background-env";
const SESSION_KEY = createSessionKey(ENVIRONMENT_ID, "codex-tab");
const SESSION_ID = "session-background";
const CLIENT = { baseUrl: "http://127.0.0.1:9999" } as CodexClient;

function toolMessage(toolState: "pending" | "success"): CodexMessage {
  return {
    id: "assistant-message",
    role: "assistant",
    content: toolState === "success" ? "Tests passed" : "",
    parts: [{
      type: "tool-invocation",
      content: "bun test",
      toolName: "bash",
      toolState,
      toolOutput: toolState === "success" ? "219 pass" : "",
    }],
    createdAt: "2026-07-28T17:53:23.000Z",
  };
}

function dependencies(
  lookup: CodexSessionStatusLookupResult,
  messages: CodexMessage[] = [],
  approvals: CodexApproval[] = [],
  interactions: CodexInteraction[] = [],
): CodexBackgroundSyncDependencies {
  return {
    lookupSessionStatus: async () => lookup,
    getSessionMessages: async () => messages,
    fetchPendingApprovals: async () => approvals,
    fetchPendingInteractions: async () => interactions,
  };
}

function seedLoadingSession(loadingStartedAt = Date.now() - 5_000): void {
  useCodexStore.setState({
    clients: new Map([[ENVIRONMENT_ID, CLIENT]]),
    sessions: new Map([[
      SESSION_KEY,
      {
        sessionId: SESSION_ID,
        messages: [toolMessage("pending")],
        isLoading: true,
        loadingStartedAt,
      },
    ]]),
  });
}

beforeEach(() => {
  useCodexStore.setState({
    clients: new Map(),
    sessions: new Map(),
    pendingApprovals: new Map(),
    pendingInteractions: new Map(),
    sessionPhase: new Map(),
    contextUsage: new Map(),
    unconfirmedDispatches: new Map(),
  });
});

describe("Codex background synchronization", () => {
  test("finishes an inactive session and hydrates its completed tool output", async () => {
    seedLoadingSession();
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: dependencies(
        {
          kind: "found",
          session: {
            status: "idle",
            phase: "idle",
            title: "Background turn",
          },
        },
        [toolMessage("success")],
      ),
    });

    await synchronizer.reconcileNow();

    const session = useCodexStore.getState().sessions.get(SESSION_KEY);
    expect(session?.isLoading).toBe(false);
    expect(session?.title).toBe("Background turn");
    expect(session?.error).toBeUndefined();
    expect(session?.lastCompletedElapsedSeconds).toBeGreaterThanOrEqual(5);
    expect(session?.messages[0]?.parts[0]?.toolState).toBe("success");
    expect(useCodexStore.getState().sessionPhase.has(SESSION_KEY)).toBe(false);
  });

  test("rehydrates pending input while a background turn is running", async () => {
    seedLoadingSession();
    const approval: CodexApproval = {
      approvalId: "approval-1",
      kind: "command",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      requestedAt: 1,
      expiresAt: 60_000,
      command: "bun test",
      actionable: true,
      supportsApproveForSession: false,
    };
    const interaction: CodexInteraction = {
      interactionId: "interaction-1",
      kind: "question",
      method: "item/tool/requestUserInput",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-2",
      requestedAt: 1,
      expiresAt: 60_000,
      questions: [{
        id: "answer",
        header: "Answer",
        question: "Continue?",
        isOther: false,
        isSecret: false,
      }],
    };
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: dependencies(
        {
          kind: "found",
          session: { status: "running", phase: "running" },
        },
        [],
        [approval],
        [interaction],
      ),
    });

    await synchronizer.reconcileNow();

    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    expect(useCodexStore.getState().pendingApprovals.get(SESSION_KEY))
      .toEqual([approval]);
    expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY))
      .toEqual([interaction]);
  });

  test("does not apply a delayed idle snapshot to a newer turn", async () => {
    seedLoadingSession(100);
    let resolveLookup:
      | ((value: CodexSessionStatusLookupResult) => void)
      | undefined;
    const lookup = new Promise<CodexSessionStatusLookupResult>((resolve) => {
      resolveLookup = resolve;
    });
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({ kind: "unavailable", error: new Error("unused") }),
        lookupSessionStatus: async () => lookup,
      },
    });

    const pending = synchronizer.reconcileNow();
    useCodexStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SESSION_KEY, {
        ...sessions.get(SESSION_KEY)!,
        isLoading: true,
        loadingStartedAt: 200,
      });
      return { sessions };
    });
    resolveLookup?.({
      kind: "found",
      session: { status: "idle", phase: "idle" },
    });
    await pending;

    const session = useCodexStore.getState().sessions.get(SESSION_KEY);
    expect(session?.isLoading).toBe(true);
    expect(session?.loadingStartedAt).toBe(200);
    expect(session?.messages[0]?.parts[0]?.toolState).toBe("pending");
  });

  test("does not overwrite a newer live approval with an older snapshot", async () => {
    seedLoadingSession();
    let resolveApprovals: ((value: CodexApproval[]) => void) | undefined;
    const approvals = new Promise<CodexApproval[]>((resolve) => {
      resolveApprovals = resolve;
    });
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: { status: "running", phase: "running" },
        }),
        fetchPendingApprovals: async () => approvals,
      },
    });
    const liveApproval: CodexApproval = {
      approvalId: "approval-live",
      kind: "command",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-live",
      requestedAt: 2,
      expiresAt: 60_000,
      command: "bun test",
      actionable: true,
      supportsApproveForSession: false,
    };

    const pending = synchronizer.reconcileNow();
    useCodexStore.getState().addPendingApproval(SESSION_KEY, liveApproval);
    resolveApprovals?.([]);
    await pending;

    expect(useCodexStore.getState().pendingApprovals.get(SESSION_KEY))
      .toEqual([liveApproval]);
  });
});
