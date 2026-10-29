import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import {
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  nativeAgentSessionStorageKey,
  type AgentActivityState,
  type Environment,
  type NativeAgentRuntimeProvider,
  type PersistedNativeAgentSession,
  type PromptDispatchPreparation,
} from "./native-agent-service-shared.js";
import {
  NativeAgentTurnRecovery,
  TURN_RECOVERY_RETRY_BASE_MS,
  type IncompleteTurnRecovery,
  type IncompleteTurnRecoveryStrategy,
  type NativeAgentTurnRecoveryDependencies,
} from "./native-agent-turn-recovery.js";
import { deferred } from "./recurring-test-support.js";

/*
 * The collaborator is platform-neutral: these tests register a stand-in
 * strategy for Pi, a platform that has none in production, so nothing here
 * depends on OpenCode's transcript shape. OpenCode's end-to-end behaviour is
 * covered through the service in `native-agent-service-reconciliation.test.ts`.
 */

const AGENT: BuildPipelineAgent = "pi";

type FakeMessage = { stalled?: string; exhausted?: true };

function fakeStrategy(): IncompleteTurnRecoveryStrategy & {
  inspections: Array<{ historyComplete: boolean; now: number }>;
} {
  const inspections: Array<{ historyComplete: boolean; now: number }> = [];
  return {
    inspections,
    historyLimit: 8,
    inspect(messages, options): IncompleteTurnRecovery | null {
      inspections.push(options);
      const last = messages.at(-1) as FakeMessage | undefined;
      if (!last?.stalled) return null;
      return {
        action: last.exhausted ? "exhausted" : "continue",
        reason: "incomplete",
        assistantMessageId: last.stalled,
        modelId: "vendor/model-1",
        agent: "build",
        variant: "high",
      };
    },
    continuationPrompt: () => "Carry on from where the turn stopped.",
    requestId: (recovery) => `fake-incomplete-${recovery.assistantMessageId}`,
  };
}

function persistedSession(
  overrides: Partial<PersistedNativeAgentSession> = {},
): PersistedNativeAgentSession {
  const agent = overrides.agent ?? AGENT;
  return {
    version: 1,
    key: nativeAgentSessionStorageKey("env-1", agent, "tab-1"),
    environmentId: "env-1",
    agent,
    logicalSessionKey: "tab-1",
    providerSessionId: "provider-1",
    origin: "interactive-native",
    interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function harness(
  options: {
    transcript?: FakeMessage[];
    dispatch?: NativeAgentTurnRecoveryDependencies["dispatchPrompt"];
  } = {},
) {
  let clock = 1_000_000;
  const strategy = fakeStrategy();
  const session = persistedSession();
  const transcript: FakeMessage[] = options.transcript ?? [{ stalled: "assistant-1" }];
  const provider = {
    messages: mock(async () => transcript),
  } as unknown as NativeAgentRuntimeProvider;
  const observed = new Map<string, { providerSessionId: string; state: AgentActivityState }>();
  const dispatches: Array<{
    input: Parameters<NativeAgentTurnRecoveryDependencies["dispatchPrompt"]>[0];
    preparation: PromptDispatchPreparation;
  }> = [];
  const storage = {
    getEnvironment: mock(
      async () => ({ status: "running", setupPhase: "ready" }) as unknown as Environment,
    ),
    getNativeAgentSession: mock(async () => session),
    getPromptQueue: mock(async () => null),
    setIncompleteTurnNotice: mock(async () => true),
  };
  const recovery = new NativeAgentTurnRecovery({
    storage: storage as unknown as NativeAgentTurnRecoveryDependencies["storage"],
    now: () => clock,
    isStopped: () => false,
    assertAcceptingWork: () => undefined,
    observeProvider: async () => provider,
    dispatchPrompt:
      options.dispatch ??
      (async (input, prepare) => {
        dispatches.push({ input, preparation: await prepare(session, provider) });
      }),
    observedActivity: (key) => observed.get(key),
    strategyFor: (agent) => (agent === AGENT ? strategy : undefined),
  });
  return {
    recovery,
    strategy,
    session,
    provider,
    storage,
    dispatches,
    observed,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    settle: () => Promise.allSettled(recovery.pendingTasks()),
  };
}

function claimInput(requestId: string) {
  return {
    environmentId: "env-1",
    agent: AGENT,
    logicalSessionKey: "tab-1",
    providerSessionId: "provider-1",
    requestId,
  };
}

describe("NativeAgentTurnRecovery", () => {
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  test("applies only to interactive sessions of a platform with a strategy", () => {
    const { recovery } = harness();
    expect(recovery.appliesTo({ agent: AGENT })).toBe(true);
    expect(recovery.appliesTo({ agent: AGENT, origin: "interactive-native" })).toBe(true);
    expect(recovery.appliesTo({ agent: AGENT, origin: "build-pipeline" })).toBe(false);
    expect(recovery.appliesTo({ agent: AGENT, origin: "automated-review" })).toBe(false);
    expect(recovery.appliesTo({ agent: "codex" })).toBe(false);
  });

  test("continues an incomplete turn through the durable dispatch with the strategy's prompt", async () => {
    const { recovery, strategy, session, dispatches, settle, now } = harness();

    recovery.noteActivity(session, "idle", "working");
    expect(recovery.hasCandidate(session.key)).toBe(true);
    await settle();

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.input).toEqual({
      environmentId: "env-1",
      agent: AGENT,
      logicalSessionKey: "tab-1",
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      prompt: "Carry on from where the turn stopped.",
      requestId: "fake-incomplete-assistant-1",
    });
    // The stalled turn's own execution settings carry into the continuation.
    expect(dispatches[0]!.preparation).toEqual({
      dispatch: true,
      model: "vendor/model-1",
      effort: "high",
      executionAgent: "build",
    });
    // One page shorter than the limit proves the history is complete.
    expect(strategy.inspections).toEqual([
      { historyComplete: true, now: now() },
      { historyComplete: true, now: now() },
    ]);
    expect(recovery.hasCandidate(session.key)).toBe(false);
  });

  test("ignores platforms without a strategy, unattended origins and non-idle states", async () => {
    const { recovery, session, dispatches, settle } = harness();
    const codex = persistedSession({ agent: "codex" });
    const pipeline = persistedSession({ origin: "build-pipeline" });

    recovery.noteActivity(codex, "idle", "working");
    recovery.noteActivity(pipeline, "idle", "working");
    recovery.noteActivity(session, "working", "idle");
    await settle();

    expect(recovery.hasCandidate(codex.key)).toBe(false);
    expect(recovery.hasCandidate(session.key)).toBe(false);
    expect(dispatches).toHaveLength(0);
  });

  test("a later non-idle observation drops a retained candidate", async () => {
    const { recovery, session, settle } = harness();
    await recovery.claimManualPrompt(claimInput("manual-1"));

    recovery.noteActivity(session, "idle", "working");
    await settle();
    expect(recovery.hasCandidate(session.key)).toBe(true);

    recovery.noteActivity(session, "working", "idle");
    expect(recovery.hasCandidate(session.key)).toBe(false);
  });

  test("a manual prompt claim defers recovery until it is released", async () => {
    const { recovery, session, dispatches, storage, settle, advance } = harness();
    await recovery.claimManualPrompt(claimInput("manual-1"));
    // The user is replacing the stalled turn, so its notice is cleared.
    expect(storage.setIncompleteTurnNotice).toHaveBeenCalledWith(session.key, "provider-1", null);

    recovery.noteActivity(session, "idle", "working");
    await settle();
    expect(dispatches).toHaveLength(0);
    expect(recovery.hasCandidate(session.key)).toBe(true);

    recovery.releaseManualPrompt(claimInput("manual-1"));
    // A deferred candidate waits out its retry delay before the next pass.
    recovery.noteActivity(session, "idle", "idle");
    await settle();
    expect(dispatches).toHaveLength(0);

    advance(TURN_RECOVERY_RETRY_BASE_MS);
    recovery.noteActivity(session, "idle", "idle");
    await settle();
    expect(dispatches).toHaveLength(1);
  });

  test("defers while the session has newer activity than the stalled turn", async () => {
    const { recovery, session, dispatches, observed, settle } = harness();
    observed.set(session.key, { providerSessionId: "provider-1", state: "working" });

    recovery.noteActivity(session, "idle", "working");
    await settle();

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.preparation).toEqual({ dispatch: false });
    expect(recovery.hasCandidate(session.key)).toBe(true);
  });

  test("rejects a manual claim during the automatic dispatch handoff, naming the platform", async () => {
    const sent = deferred();
    const release = deferred();
    const { recovery, session, settle } = harness({
      dispatch: async (_input, prepare) => {
        const preparation = await prepare(persistedSession(), {
          messages: async () => [{ stalled: "assistant-1" }],
        } as unknown as NativeAgentRuntimeProvider);
        expect(preparation.dispatch).toBe(true);
        sent.resolve();
        await release.promise;
      },
    });

    recovery.noteActivity(session, "idle", "working");
    await sent.promise;
    await expect(recovery.claimManualPrompt(claimInput("manual-overlap"))).rejects.toThrow(
      "Pi automatic recovery is already being sent",
    );
    release.resolve();
    await settle();

    await recovery.claimManualPrompt(claimInput("manual-after"));
    await expect(recovery.claimManualPrompt(claimInput("manual-other"))).rejects.toThrow(
      "Another Pi prompt is already being sent",
    );
    recovery.releaseManualPrompt(claimInput("manual-after"));
    await recovery.claimManualPrompt(claimInput("manual-other"));
  });

  test("records an exhausted notice instead of continuing again", async () => {
    const { recovery, session, dispatches, settle, now } = harness({
      transcript: [{ stalled: "assistant-2", exhausted: true }],
    });

    recovery.noteActivity(session, "idle", undefined);
    await settle();

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.preparation).toEqual({
      dispatch: false,
      notice: {
        kind: "exhausted",
        assistantMessageId: "assistant-2",
        updatedAt: new Date(now()).toISOString(),
      },
    });
    expect(recovery.hasCandidate(session.key)).toBe(false);
  });

  test("persists a failed notice and backs off when the continuation cannot be sent", async () => {
    const { recovery, session, storage, settle, now } = harness({
      transcript: [{ stalled: "assistant-3" }],
      dispatch: async (_input, prepare) => {
        await prepare(persistedSession(), {
          messages: async () => [{ stalled: "assistant-3" }],
        } as unknown as NativeAgentRuntimeProvider);
        throw new Error("provider unavailable");
      },
    });

    recovery.noteActivity(session, "idle", "working");
    await settle();

    expect(storage.setIncompleteTurnNotice).toHaveBeenCalledWith(session.key, "provider-1", {
      kind: "failed",
      assistantMessageId: "assistant-3",
      updatedAt: new Date(now()).toISOString(),
    });
    expect(recovery.hasCandidate(session.key)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "[native-agent] Pi incomplete-turn recovery for env-1 failed:",
      "Error",
    );
  });

  test("clear forgets candidates and claims", async () => {
    const { recovery, session, settle } = harness();
    await recovery.claimManualPrompt(claimInput("manual-1"));
    recovery.noteActivity(session, "idle", "working");
    await settle();
    expect(recovery.hasCandidate(session.key)).toBe(true);

    recovery.clear();
    expect(recovery.hasCandidate(session.key)).toBe(false);
    await recovery.claimManualPrompt(claimInput("manual-2"));
  });
});
