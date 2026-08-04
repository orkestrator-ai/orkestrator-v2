import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
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
  useCodexBackgroundSync,
} from "./useCodexBackgroundSync";

const ENVIRONMENT_ID = "background-env";
const SESSION_KEY = createSessionKey(ENVIRONMENT_ID, "codex-tab");
const SESSION_ID = "session-background";
const CLIENT = { baseUrl: "http://127.0.0.1:9999" } as CodexClient;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

function optimisticMessage(id = "optimistic-prompt"): CodexMessage {
  return {
    id,
    role: "user",
    content: "Run the checks",
    parts: [{ type: "text", content: "Run the checks" }],
    createdAt: "2026-07-28T17:53:22.000Z",
  };
}

function approval(id = "approval-1"): CodexApproval {
  return {
    approvalId: id,
    kind: "command",
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: `item-${id}`,
    requestedAt: 1,
    expiresAt: 60_000,
    command: "bun test",
    actionable: true,
    supportsApproveForSession: false,
  };
}

function interaction(id = "interaction-1"): CodexInteraction {
  return {
    interactionId: id,
    kind: "question",
    method: "item/tool/requestUserInput",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: `item-${id}`,
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

function seedLoadingSession(
  loadingStartedAt = Date.now() - 5_000,
  messages: CodexMessage[] = [toolMessage("pending")],
): void {
  useCodexStore.setState({
    clients: new Map([[ENVIRONMENT_ID, CLIENT]]),
    sessions: new Map([[
      SESSION_KEY,
      {
        sessionId: SESSION_ID,
        messages,
        isLoading: true,
        loadingStartedAt,
        turnId: `turn-${loadingStartedAt}`,
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
    useCodexStore.getState().setSessionPhase(SESSION_KEY, "running");
    useCodexStore.getState().setSessionError(SESSION_KEY, "stale error");
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
    seedLoadingSession(9_000);
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
          session: {
            status: "running",
            phase: "running",
            turnStartedAt: 2_000,
          },
        },
        [],
        [approval],
        [interaction],
      ),
    });

    await synchronizer.reconcileNow();

    expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
      isLoading: true,
      loadingStartedAt: 2_000,
    });
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
        turnId: "turn-200",
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

  test("does not apply a delayed terminal transcript to a newer turn", async () => {
    seedLoadingSession(100);
    const transcript = deferred<CodexMessage[]>();
    let transcriptCalls = 0;
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: {
            status: "idle",
            phase: "idle",
            title: "Previous turn",
          },
        }),
        getSessionMessages: async () => {
          transcriptCalls += 1;
          return transcript.promise;
        },
      },
    });

    const pending = synchronizer.reconcileNow();
    await waitFor(() => expect(transcriptCalls).toBe(1));
    useCodexStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SESSION_KEY, {
        ...sessions.get(SESSION_KEY)!,
        messages: [toolMessage("pending")],
        isLoading: true,
        loadingStartedAt: 200,
        turnId: "turn-200",
        title: "Newer turn",
        error: "newer error",
      });
      return { sessions };
    });
    transcript.resolve([toolMessage("success")]);
    await pending;

    expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
      isLoading: true,
      loadingStartedAt: 200,
      title: "Newer turn",
      error: "newer error",
      messages: [toolMessage("pending")],
    });
  });

  test("re-polls instead of clearing live input raised after terminal status", async () => {
    seedLoadingSession(100);
    const transcript = deferred<CodexMessage[]>();
    const liveApproval = approval("new-turn");
    const liveInteraction = interaction("new-turn");
    let lookupCalls = 0;
    let transcriptCalls = 0;
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: { status: "running", phase: "running" },
        }),
        lookupSessionStatus: async () => {
          lookupCalls += 1;
          return {
            kind: "found",
            session: lookupCalls === 1
              ? { status: "idle", phase: "idle", title: "Old turn" }
              : { status: "running", phase: "running" },
          };
        },
        getSessionMessages: async () => {
          transcriptCalls += 1;
          return transcript.promise;
        },
        fetchPendingApprovals: async () =>
          lookupCalls > 1 ? [liveApproval] : [],
        fetchPendingInteractions: async () =>
          lookupCalls > 1 ? [liveInteraction] : [],
      },
    });

    const first = synchronizer.reconcileNow();
    await waitFor(() => expect(transcriptCalls).toBe(1));
    useCodexStore.getState().addPendingApproval(SESSION_KEY, liveApproval);
    useCodexStore.getState().addPendingInteraction(
      SESSION_KEY,
      liveInteraction,
    );
    transcript.resolve([toolMessage("success")]);
    await first;

    let state = useCodexStore.getState();
    expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    expect(state.sessions.get(SESSION_KEY)?.title).toBeUndefined();
    expect(state.pendingApprovals.get(SESSION_KEY)).toEqual([liveApproval]);
    expect(state.pendingInteractions.get(SESSION_KEY)).toEqual([liveInteraction]);

    await synchronizer.reconcileNow();

    state = useCodexStore.getState();
    expect(lookupCalls).toBe(2);
    expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    expect(state.pendingApprovals.get(SESSION_KEY)).toEqual([liveApproval]);
    expect(state.pendingInteractions.get(SESSION_KEY)).toEqual([liveInteraction]);
  });

  test("handles unavailable, missing, and running terminal confirmations", async () => {
    const scenarios: Array<{
      name: string;
      confirmation: CodexSessionStatusLookupResult;
      finishesMissing: boolean;
    }> = [
      {
        name: "unavailable",
        confirmation: {
          kind: "unavailable",
          error: new Error("bridge restarted"),
        },
        finishesMissing: false,
      },
      {
        name: "missing",
        confirmation: { kind: "missing" },
        finishesMissing: true,
      },
      {
        name: "running",
        confirmation: {
          kind: "found",
          session: {
            status: "running",
            phase: "running",
            messageRevision: 7,
            engineGeneration: 2,
          },
        },
        finishesMissing: false,
      },
    ];

    for (const scenario of scenarios) {
      seedLoadingSession(100);
      useCodexStore.getState().setSessionPhase(SESSION_KEY, "running");
      useCodexStore.getState().setPendingApprovals(
        SESSION_KEY,
        [approval(scenario.name)],
      );
      let lookupCalls = 0;
      const synchronizer = createCodexBackgroundSynchronizer({
        dependencies: {
          ...dependencies({ kind: "missing" }, [toolMessage("success")]),
          lookupSessionStatus: async () => {
            lookupCalls += 1;
            return lookupCalls === 1
              ? {
                  kind: "found",
                  session: {
                    status: "idle",
                    phase: "idle",
                    messageRevision: 7,
                    engineGeneration: 2,
                  },
                }
              : scenario.confirmation;
          },
        },
      });

      await synchronizer.reconcileNow();

      const state = useCodexStore.getState();
      expect(lookupCalls).toBe(2);
      expect(state.sessions.get(SESSION_KEY)?.messages[0]?.parts[0]?.toolState)
        .toBe("pending");
      if (scenario.finishesMissing) {
        expect(state.sessions.get(SESSION_KEY)).toMatchObject({
          isLoading: false,
          error: "The Codex session is no longer available on the server",
        });
        expect(state.sessionPhase.has(SESSION_KEY)).toBe(false);
        expect(state.pendingApprovals.has(SESSION_KEY)).toBe(false);
      } else {
        expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(true);
        expect(state.sessionPhase.get(SESSION_KEY)).toBe("running");
        expect(state.pendingApprovals.get(SESSION_KEY))
          .toEqual([approval(scenario.name)]);
      }
      synchronizer.dispose();
    }
  });

  test("re-polls when the backend transcript generation changes during hydration", async () => {
    for (const changedField of ["messageRevision", "engineGeneration"] as const) {
      seedLoadingSession(100);
      const newerMessage: CodexMessage = {
        ...toolMessage("success"),
        id: `newer-${changedField}`,
        content: `Newer ${changedField}`,
      };
      let lookupCalls = 0;
      let transcriptCalls = 0;
      const synchronizer = createCodexBackgroundSynchronizer({
        dependencies: {
          ...dependencies({ kind: "missing" }),
          lookupSessionStatus: async () => {
            lookupCalls += 1;
            const newerSnapshot = lookupCalls > 1;
            return {
              kind: "found",
              session: {
                status: "idle",
                phase: "idle",
                title: newerSnapshot ? "Newer turn" : "Older turn",
                messageRevision:
                  changedField === "messageRevision" && newerSnapshot ? 8 : 7,
                engineGeneration:
                  changedField === "engineGeneration" && newerSnapshot ? 3 : 2,
              },
            };
          },
          getSessionMessages: async () => {
            transcriptCalls += 1;
            return transcriptCalls === 1
              ? [toolMessage("success")]
              : [newerMessage];
          },
        },
      });

      await synchronizer.reconcileNow();

      let session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.isLoading).toBe(true);
      expect(session?.title).toBeUndefined();
      expect(session?.messages[0]?.parts[0]?.toolState).toBe("pending");

      await synchronizer.reconcileNow();

      session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(lookupCalls).toBe(4);
      expect(transcriptCalls).toBe(2);
      expect(session).toMatchObject({
        isLoading: false,
        title: "Newer turn",
        messages: [newerMessage],
      });
      synchronizer.dispose();
    }
  });

  test("rejects a terminal confirmation when renderer state changes in flight", async () => {
    seedLoadingSession(100);
    const confirmation = deferred<CodexSessionStatusLookupResult>();
    let lookupCalls = 0;
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({ kind: "missing" }, [toolMessage("success")]),
        lookupSessionStatus: async () => {
          lookupCalls += 1;
          if (lookupCalls === 1) {
            return {
              kind: "found",
              session: {
                status: "idle",
                phase: "idle",
                messageRevision: 7,
                engineGeneration: 2,
              },
            };
          }
          return confirmation.promise;
        },
      },
    });

    const pending = synchronizer.reconcileNow();
    await waitFor(() => expect(lookupCalls).toBe(2));
    useCodexStore.getState().setSessionTitle(SESSION_KEY, "Live title");
    confirmation.resolve({
      kind: "found",
      session: {
        status: "idle",
        phase: "idle",
        messageRevision: 7,
        engineGeneration: 2,
      },
    });
    await pending;

    const session = useCodexStore.getState().sessions.get(SESSION_KEY);
    expect(session?.isLoading).toBe(true);
    expect(session?.title).toBe("Live title");
    expect(session?.messages[0]?.parts[0]?.toolState).toBe("pending");
  });

  test("disposal rejects a terminal confirmation already in flight", async () => {
    seedLoadingSession(100);
    const confirmation = deferred<CodexSessionStatusLookupResult>();
    let lookupCalls = 0;
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({ kind: "missing" }, [toolMessage("success")]),
        lookupSessionStatus: async () => {
          lookupCalls += 1;
          if (lookupCalls === 1) {
            return {
              kind: "found",
              session: {
                status: "idle",
                phase: "idle",
                messageRevision: 7,
                engineGeneration: 2,
              },
            };
          }
          return confirmation.promise;
        },
      },
    });

    const pending = synchronizer.reconcileNow();
    await waitFor(() => expect(lookupCalls).toBe(2));
    synchronizer.dispose();
    confirmation.resolve({
      kind: "found",
      session: {
        status: "idle",
        phase: "idle",
        messageRevision: 7,
        engineGeneration: 2,
      },
    });
    await pending;

    const session = useCodexStore.getState().sessions.get(SESSION_KEY);
    expect(session?.isLoading).toBe(true);
    expect(session?.title).toBeUndefined();
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

  test("clears stale pending input before idle unlock despite delayed snapshots", async () => {
    seedLoadingSession();
    useCodexStore.getState().setPendingApprovals(SESSION_KEY, [approval("stale")]);
    useCodexStore.getState().setPendingInteractions(SESSION_KEY, [interaction("stale")]);
    const approvals = deferred<CodexApproval[]>();
    const interactions = deferred<CodexInteraction[]>();
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: { status: "idle", phase: "idle" },
        }, [toolMessage("success")]),
        fetchPendingApprovals: async () => approvals.promise,
        fetchPendingInteractions: async () => interactions.promise,
      },
    });

    const pending = synchronizer.reconcileNow();
    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading)
        .toBe(false);
    });
    expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false);
    expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false);

    approvals.resolve([approval("delayed")]);
    interactions.resolve([interaction("delayed")]);
    await pending;

    expect(useCodexStore.getState().pendingApprovals.has(SESSION_KEY)).toBe(false);
    expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false);
  });

  test("clears stale pending input before a missing session unlocks", async () => {
    const optimistic = optimisticMessage();
    seedLoadingSession(undefined, [toolMessage("pending"), optimistic]);
    useCodexStore.getState().setPendingApprovals(SESSION_KEY, [approval("stale")]);
    useCodexStore.getState().setPendingInteractions(SESSION_KEY, [interaction("stale")]);
    useCodexStore.getState().setUnconfirmedDispatch(SESSION_KEY, {
      userMessageId: optimistic.id,
      fingerprint: "missing-prompt",
      requestId: "missing-request",
    });
    const approvals = deferred<CodexApproval[]>();
    const interactions = deferred<CodexInteraction[]>();
    let messageReads = 0;
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({ kind: "missing" }),
        getSessionMessages: async () => {
          messageReads += 1;
          return [];
        },
        fetchPendingApprovals: async () => approvals.promise,
        fetchPendingInteractions: async () => interactions.promise,
      },
    });

    const pending = synchronizer.reconcileNow();
    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading)
        .toBe(false);
    });
    approvals.resolve([approval("delayed")]);
    interactions.resolve([interaction("delayed")]);
    await pending;

    const state = useCodexStore.getState();
    expect(state.sessions.get(SESSION_KEY)?.error)
      .toBe("The Codex session is no longer available on the server");
    expect(state.pendingApprovals.has(SESSION_KEY)).toBe(false);
    expect(state.pendingInteractions.has(SESSION_KEY)).toBe(false);
    expect(state.unconfirmedDispatches.has(SESSION_KEY)).toBe(false);
    expect(state.sessions.get(SESSION_KEY)?.messages.map((message) => message.id))
      .toEqual(["assistant-message"]);
    expect(messageReads).toBe(0);
  });

  test("leaves a loading turn unchanged when status is unavailable", async () => {
    seedLoadingSession(123);
    useCodexStore.getState().setSessionPhase(SESSION_KEY, "running");
    useCodexStore.getState().setSessionError(SESSION_KEY, "existing");
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "unavailable",
          error: new Error("bridge unavailable"),
        }),
        fetchPendingApprovals: async () => {
          throw new Error("also unavailable");
        },
        fetchPendingInteractions: async () => {
          throw new Error("also unavailable");
        },
      },
    });

    await synchronizer.reconcileNow();

    const state = useCodexStore.getState();
    expect(state.sessions.get(SESSION_KEY)).toMatchObject({
      isLoading: true,
      loadingStartedAt: 123,
      error: "existing",
    });
    expect(state.sessionPhase.get(SESSION_KEY)).toBe("running");
  });

  test("applies explicit and default terminal errors", async () => {
    for (const [reported, expected] of [
      ["  turn exploded  ", "turn exploded"],
      ["   ", "Codex session failed"],
    ] as const) {
      seedLoadingSession();
      const synchronizer = createCodexBackgroundSynchronizer({
        dependencies: dependencies(
          {
            kind: "found",
            session: { status: "error", phase: "idle", error: reported },
          },
          [toolMessage("success")],
        ),
      });

      await synchronizer.reconcileNow();

      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.error)
        .toBe(expected);
    }
  });

  test("retries a rejected status lookup without changing the turn", async () => {
    seedLoadingSession();
    let attempts = 0;
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: { status: "running", phase: "running" },
        }),
        lookupSessionStatus: async () => {
          attempts += 1;
          throw new Error("temporary lookup failure");
        },
      },
    });

    await synchronizer.reconcileNow();
    await synchronizer.reconcileNow();

    expect(attempts).toBe(2);
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
  });

  test("unlocks ordinary terminal turns when transcript hydration fails", async () => {
    seedLoadingSession();
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: { status: "idle", phase: "idle", title: "Recovered title" },
        }),
        getSessionMessages: async () => {
          throw new Error("transcript unavailable");
        },
      },
    });

    await synchronizer.reconcileNow();

    const session = useCodexStore.getState().sessions.get(SESSION_KEY);
    expect(session?.isLoading).toBe(false);
    expect(session?.title).toBe("Recovered title");
    expect(session?.messages[0]?.parts[0]?.toolState).toBe("pending");
  });

  test("clears an ambiguous dispatch when the transcript contains its server echo", async () => {
    const optimistic = optimisticMessage();
    seedLoadingSession(undefined, [optimistic]);
    useCodexStore.getState().setUnconfirmedDispatch(SESSION_KEY, {
      userMessageId: optimistic.id,
      fingerprint: "prompt-fingerprint",
      requestId: "request-confirmed",
    });
    const serverEcho = optimisticMessage("server-user-message");
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: dependencies(
        {
          kind: "found",
          session: { status: "idle", phase: "idle" },
        },
        [serverEcho],
      ),
    });

    await synchronizer.reconcileNow();

    const state = useCodexStore.getState();
    expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(false);
    expect(state.sessions.get(SESSION_KEY)?.messages.map((message) => message.id))
      .toEqual([serverEcho.id]);
    expect(state.unconfirmedDispatches.has(SESSION_KEY)).toBe(false);
  });

  test("withdraws an unmatched optimistic prompt and retains a durable safe retry", async () => {
    const optimistic = optimisticMessage();
    seedLoadingSession(undefined, [toolMessage("pending"), optimistic]);
    useCodexStore.getState().setUnconfirmedDispatch(SESSION_KEY, {
      userMessageId: optimistic.id,
      fingerprint: "prompt-fingerprint",
      requestId: "request-retry",
    });
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: dependencies(
        {
          kind: "found",
          session: { status: "idle", phase: "idle" },
        },
        [toolMessage("success")],
      ),
    });

    await synchronizer.reconcileNow();

    const state = useCodexStore.getState();
    expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(false);
    expect(state.sessions.get(SESSION_KEY)?.messages.map((message) => message.id))
      .toEqual(["assistant-message"]);
    expect(state.sessions.get(SESSION_KEY)?.error)
      .toBe("Could not confirm whether Codex received the prompt. You can send it again safely.");
    expect(state.unconfirmedDispatches.get(SESSION_KEY)).toEqual({
      userMessageId: optimistic.id,
      fingerprint: "prompt-fingerprint",
      requestId: "request-retry",
      retryable: true,
    });
  });

  test("keeps an ambiguous turn loading until transcript settlement can retry", async () => {
    const optimistic = optimisticMessage();
    seedLoadingSession(undefined, [toolMessage("pending"), optimistic]);
    useCodexStore.getState().setUnconfirmedDispatch(SESSION_KEY, {
      userMessageId: optimistic.id,
      fingerprint: "prompt-fingerprint",
      requestId: "request-retry",
    });
    useCodexStore.getState().setPendingApprovals(SESSION_KEY, [approval("stale")]);
    useCodexStore.getState().setPendingInteractions(SESSION_KEY, [interaction("stale")]);
    let transcriptAttempts = 0;
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: { status: "idle", phase: "idle" },
        }),
        getSessionMessages: async () => {
          transcriptAttempts += 1;
          if (transcriptAttempts === 1) {
            throw new Error("transcript unavailable");
          }
          return [toolMessage("success")];
        },
      },
    });

    await synchronizer.reconcileNow();

    let state = useCodexStore.getState();
    expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    expect(state.sessions.get(SESSION_KEY)?.messages.map((message) => message.id))
      .toContain(optimistic.id);
    expect(state.unconfirmedDispatches.get(SESSION_KEY)?.retryable).toBeUndefined();
    expect(state.pendingApprovals.has(SESSION_KEY)).toBe(false);
    expect(state.pendingInteractions.has(SESSION_KEY)).toBe(false);

    await synchronizer.reconcileNow();

    state = useCodexStore.getState();
    expect(transcriptAttempts).toBe(2);
    expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(false);
    expect(state.sessions.get(SESSION_KEY)?.messages.map((message) => message.id))
      .not.toContain(optimistic.id);
    expect(state.unconfirmedDispatches.get(SESSION_KEY)?.retryable).toBe(true);
  });

  test("preserves an unconfirmed dispatch and reports terminal error when its transcript fails", async () => {
    const optimistic = optimisticMessage();
    seedLoadingSession(undefined, [optimistic]);
    useCodexStore.getState().setUnconfirmedDispatch(SESSION_KEY, {
      userMessageId: optimistic.id,
      fingerprint: "prompt-fingerprint",
      requestId: "request-error",
    });
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: {
            status: "error",
            phase: "idle",
            error: "Engine failed",
          },
        }),
        getSessionMessages: async () => {
          throw new Error("transcript unavailable");
        },
      },
    });

    await synchronizer.reconcileNow();

    const state = useCodexStore.getState();
    expect(state.sessions.get(SESSION_KEY)).toMatchObject({
      isLoading: true,
      error: "Engine failed",
    });
    expect(state.unconfirmedDispatches.get(SESSION_KEY)).toMatchObject({
      requestId: "request-error",
    });
    expect(state.sessions.get(SESSION_KEY)?.messages.map((message) => message.id))
      .toContain(optimistic.id);
  });

  test("ignores a blank title and accepts zero-valued context usage", async () => {
    seedLoadingSession();
    useCodexStore.getState().setSessionTitle(SESSION_KEY, "Existing title");
    const contextUsage = {
      usedTokens: 0,
      totalTokens: 0,
      percentUsed: 0,
    };
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: dependencies(
        {
          kind: "found",
          session: {
            status: "idle",
            phase: "idle",
            title: "   ",
            contextUsage,
          },
        },
        [toolMessage("success")],
      ),
    });

    await synchronizer.reconcileNow();

    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.title)
      .toBe("Existing title");
    expect(useCodexStore.getState().contextUsage.get(SESSION_KEY))
      .toEqual(contextUsage);
  });

  test("applies each pending endpoint independently when the other rejects", async () => {
    seedLoadingSession();
    const currentApproval = approval("independent");
    const currentInteraction = interaction("independent");
    const approvalSynchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: { status: "running", phase: "running" },
        }),
        fetchPendingApprovals: async () => [currentApproval],
        fetchPendingInteractions: async () => {
          throw new Error("interactions unavailable");
        },
      },
    });

    await approvalSynchronizer.reconcileNow();
    expect(useCodexStore.getState().pendingApprovals.get(SESSION_KEY))
      .toEqual([currentApproval]);
    expect(useCodexStore.getState().pendingInteractions.has(SESSION_KEY)).toBe(false);

    const interactionSynchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: { status: "running", phase: "running" },
        }),
        fetchPendingApprovals: async () => {
          throw new Error("approvals unavailable");
        },
        fetchPendingInteractions: async () => [currentInteraction],
      },
    });
    await interactionSynchronizer.reconcileNow();

    expect(useCodexStore.getState().pendingApprovals.get(SESSION_KEY))
      .toEqual([currentApproval]);
    expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY))
      .toEqual([currentInteraction]);
  });

  test("does not overwrite a newer live interaction with an older snapshot", async () => {
    seedLoadingSession();
    const interactions = deferred<CodexInteraction[]>();
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: { status: "running", phase: "running" },
        }),
        fetchPendingInteractions: async () => interactions.promise,
      },
    });
    const liveInteraction = interaction("live");

    const pending = synchronizer.reconcileNow();
    useCodexStore.getState().addPendingInteraction(SESSION_KEY, liveInteraction);
    interactions.resolve([]);
    await pending;

    expect(useCodexStore.getState().pendingInteractions.get(SESSION_KEY))
      .toEqual([liveInteraction]);
  });

  test("coalesces overlapping status and pending requests", async () => {
    seedLoadingSession();
    const lookup = deferred<CodexSessionStatusLookupResult>();
    const approvals = deferred<CodexApproval[]>();
    const interactions = deferred<CodexInteraction[]>();
    let statusCalls = 0;
    let approvalCalls = 0;
    let interactionCalls = 0;
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({ kind: "unavailable", error: new Error("unused") }),
        lookupSessionStatus: async () => {
          statusCalls += 1;
          return lookup.promise;
        },
        fetchPendingApprovals: async () => {
          approvalCalls += 1;
          return approvals.promise;
        },
        fetchPendingInteractions: async () => {
          interactionCalls += 1;
          return interactions.promise;
        },
      },
    });

    const first = synchronizer.reconcileNow();
    const second = synchronizer.reconcileNow();
    expect([statusCalls, approvalCalls, interactionCalls]).toEqual([1, 1, 1]);

    lookup.resolve({
      kind: "found",
      session: { status: "running", phase: "running" },
    });
    approvals.resolve([]);
    interactions.resolve([]);
    await Promise.all([first, second]);
    expect([statusCalls, approvalCalls, interactionCalls]).toEqual([1, 1, 1]);
  });

  test("disposal prevents in-flight and subsequent requests from mutating state", async () => {
    seedLoadingSession();
    const lookup = deferred<CodexSessionStatusLookupResult>();
    const approvals = deferred<CodexApproval[]>();
    const interactions = deferred<CodexInteraction[]>();
    let statusCalls = 0;
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({ kind: "unavailable", error: new Error("unused") }),
        lookupSessionStatus: async () => {
          statusCalls += 1;
          return lookup.promise;
        },
        fetchPendingApprovals: async () => approvals.promise,
        fetchPendingInteractions: async () => interactions.promise,
      },
    });

    const pending = synchronizer.reconcileNow();
    synchronizer.dispose();
    lookup.resolve({
      kind: "found",
      session: { status: "idle", phase: "idle", title: "Too late" },
    });
    approvals.resolve([approval("too-late")]);
    interactions.resolve([interaction("too-late")]);
    await pending;
    await synchronizer.reconcileNow();

    const state = useCodexStore.getState();
    expect(statusCalls).toBe(1);
    expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    expect(state.sessions.get(SESSION_KEY)?.title).toBeUndefined();
    expect(state.pendingApprovals.has(SESSION_KEY)).toBe(false);
    expect(state.pendingInteractions.has(SESSION_KEY)).toBe(false);
  });

  test("disposal rejects a terminal transcript that was already in flight", async () => {
    seedLoadingSession();
    const transcript = deferred<CodexMessage[]>();
    let transcriptCalls = 0;
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: { status: "idle", phase: "idle", title: "Too late" },
        }),
        getSessionMessages: async () => {
          transcriptCalls += 1;
          return transcript.promise;
        },
      },
    });

    const pending = synchronizer.reconcileNow();
    await waitFor(() => expect(transcriptCalls).toBe(1));
    synchronizer.dispose();
    transcript.resolve([toolMessage("success")]);
    await pending;

    const session = useCodexStore.getState().sessions.get(SESSION_KEY);
    expect(session?.isLoading).toBe(true);
    expect(session?.title).toBeUndefined();
    expect(session?.messages[0]?.parts[0]?.toolState).toBe("pending");
  });

  test("isolates multiple sessions and filters targets without clients", async () => {
    const secondKey = createSessionKey(ENVIRONMENT_ID, "second-tab");
    const secondId = "session-second";
    const clientlessKey = createSessionKey("clientless-env", "codex-tab");
    const malformedKey = "not-a-session-key";
    useCodexStore.setState({
      clients: new Map([[ENVIRONMENT_ID, CLIENT]]),
      sessions: new Map([
        [SESSION_KEY, {
          sessionId: SESSION_ID,
          messages: [toolMessage("pending")],
          isLoading: true,
          loadingStartedAt: 1,
        }],
        [secondKey, {
          sessionId: secondId,
          messages: [toolMessage("pending")],
          isLoading: true,
          loadingStartedAt: 2,
        }],
        [clientlessKey, {
          sessionId: "session-clientless",
          messages: [toolMessage("pending")],
          isLoading: true,
          loadingStartedAt: 3,
        }],
        [malformedKey, {
          sessionId: "session-malformed",
          messages: [toolMessage("pending")],
          isLoading: true,
          loadingStartedAt: 4,
        }],
      ]),
    });
    const lookedUp: string[] = [];
    const synchronizer = createCodexBackgroundSynchronizer({
      dependencies: {
        ...dependencies({
          kind: "found",
          session: { status: "running", phase: "running" },
        }),
        lookupSessionStatus: async (_client, sessionId) => {
          lookedUp.push(sessionId);
          if (sessionId === SESSION_ID) {
            throw new Error("one session failed");
          }
          return {
            kind: "found",
            session: { status: "idle", phase: "idle", title: "Second complete" },
          };
        },
        getSessionMessages: async (_client, sessionId) =>
          sessionId === secondId ? [toolMessage("success")] : [],
      },
    });

    await synchronizer.reconcileNow();

    expect(lookedUp.sort()).toEqual([SESSION_ID, secondId, secondId].sort());
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    expect(useCodexStore.getState().sessions.get(secondKey)).toMatchObject({
      isLoading: false,
      title: "Second complete",
    });
    expect(useCodexStore.getState().sessions.get(clientlessKey)?.isLoading).toBe(true);
    expect(useCodexStore.getState().sessions.get(malformedKey)?.isLoading).toBe(true);
  });

  test("the hook reconciles immediately without installing a timer", async () => {
    seedLoadingSession();
    const originalSetInterval = window.setInterval;
    let intervalCalls = 0;
    let statusCalls = 0;
    let approvalCalls = 0;
    let interactionCalls = 0;
    const hookDependencies: CodexBackgroundSyncDependencies = {
      ...dependencies({
        kind: "found",
        session: { status: "running", phase: "running" },
      }),
      lookupSessionStatus: async () => {
        statusCalls += 1;
        return {
          kind: "found",
          session: { status: "running", phase: "running" },
        };
      },
      fetchPendingApprovals: async () => {
        approvalCalls += 1;
        return [];
      },
      fetchPendingInteractions: async () => {
        interactionCalls += 1;
        return [];
      },
    };
    window.setInterval = (() => {
      intervalCalls += 1;
      return 73;
    }) as unknown as typeof window.setInterval;

    try {
      const hook = renderHook(() => useCodexBackgroundSync({
        dependencies: hookDependencies,
      }));
      expect([statusCalls, approvalCalls, interactionCalls]).toEqual([1, 1, 1]);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      expect(intervalCalls).toBe(0);
      hook.unmount();
      expect([statusCalls, approvalCalls, interactionCalls]).toEqual([1, 1, 1]);
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    } finally {
      cleanup();
      window.setInterval = originalSetInterval;
    }
  });
});
