import { describe, expect, test } from "bun:test";
import {
  NativeAgentPromptDispatch,
  hasPendingTabTeardown,
  type NativeAgentPromptDispatchHost,
} from "./native-agent-prompt-dispatch.js";
import {
  nativeAgentSessionStorageKey,
  type Environment,
  type NativeAgentRuntimeProvider,
  type PersistedNativeAgentPendingSteer,
  type PersistedNativeAgentSession,
  type StorageService,
} from "./native-agent-service-shared.js";

const identity = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "workflow-session",
};
const sessionKey = nativeAgentSessionStorageKey(
  identity.environmentId,
  identity.agent,
  identity.logicalSessionKey,
);

/**
 * A fake host whose every fence, lease and provider call appends to `events`,
 * so a test can read the order prompt dispatch takes them in.
 */
function harness(
  input: {
    session?: Partial<PersistedNativeAgentSession>;
    provider?: Record<string, unknown>;
    storage?: Record<string, unknown>;
    environment?: Partial<Environment> | null;
    host?: Partial<NativeAgentPromptDispatchHost>;
  } = {},
) {
  const events: string[] = [];
  let session = {
    ...identity,
    key: sessionKey,
    providerSessionId: "provider-session",
    origin: "workflow",
    // A prompt after the first, so first-prompt naming reads nothing.
    dispatchedRequestIds: ["earlier"],
    ...input.session,
  } as PersistedNativeAgentSession;
  const provider = {
    agent: identity.agent,
    status: async () => "idle",
    send: async (_id: string, _prompt: string, options: { requestId: string }) => {
      events.push(`send:${options.requestId}`);
    },
    ...input.provider,
  } as unknown as NativeAgentRuntimeProvider;
  const fence =
    (name: string) =>
    async <T>(_input: unknown, operation: () => Promise<T>) => {
      events.push(`${name}:enter`);
      try {
        return await operation();
      } finally {
        events.push(`${name}:exit`);
      }
    };
  const storage = {
    getEnvironment: async () =>
      input.environment === null
        ? null
        : ({ id: identity.environmentId, ...input.environment } as Environment),
    getNativeAgentSession: async (key: string) => (key === sessionKey ? session : null),
    getPromptQueue: async () => null,
    dispatchNativeAgentPromptOnce: async (
      _key: string,
      requestId: string,
      dispatch: (durable: PersistedNativeAgentSession) => Promise<{ dispatched: boolean }>,
      _pending: unknown,
      admit?: (durable: PersistedNativeAgentSession) => Promise<unknown>,
    ) => {
      events.push("lease:enter");
      try {
        await admit?.(session);
        const outcome = await dispatch(session);
        if (outcome.dispatched)
          session = {
            ...session,
            dispatchedRequestIds: [...(session.dispatchedRequestIds ?? []), requestId],
          };
        return { session, dispatched: outcome.dispatched };
      } finally {
        events.push("lease:exit");
      }
    },
    dispatchNativeAgentSteerOnce: async (
      _key: string,
      _pending: PersistedNativeAgentPendingSteer,
      dispatch: (durable: PersistedNativeAgentSession) => Promise<unknown>,
    ) => {
      events.push("steer-lease:enter");
      try {
        return await dispatch(session);
      } finally {
        events.push("steer-lease:exit");
      }
    },
    clearPendingNativeAgentDispatch: async (_key: string, requestId: string) => {
      events.push(`clear-dispatch:${requestId}`);
      return true;
    },
    clearPendingNativeAgentSteer: async (_key: string, requestId: string) => {
      events.push(`clear-steer:${requestId}`);
      return true;
    },
    confirmNativeAgentDispatch: async () => true,
    retireNativeAgentDispatch: async () => true,
    ...input.storage,
  } as unknown as StorageService;
  const host: NativeAgentPromptDispatchHost = {
    storage,
    invoke: async () => undefined as never,
    options: {},
    environmentFence: {
      beginAgentWork: () => {
        events.push("environment:enter");
        return () => events.push("environment:exit");
      },
      assertAcceptsAgentWork: () => undefined,
    } as unknown as NativeAgentPromptDispatchHost["environmentFence"],
    catalogs: { readCommandsForDispatch: async () => ({ commands: [] }) } as never,
    projections: {
      invalidateProjection: (key: string) => events.push(`invalidate:${key}`),
      refreshProjectionState: async () => null,
    } as unknown as NativeAgentPromptDispatchHost["projections"],
    promptQueues: {
      withSessionMutationIntent: fence("intent"),
      withSessionMutationFence: fence("mutation"),
      withSessionWorkFence: fence("work"),
      scheduleAmbiguousSteerSettle: () => undefined,
    } as unknown as NativeAgentPromptDispatchHost["promptQueues"],
    observations: {
      beginDispatch: () => {
        events.push("observation:enter");
        return () => events.push("observation:exit");
      },
      recordDispatchAccepted: () => events.push("accepted"),
    } as unknown as NativeAgentPromptDispatchHost["observations"],
    launches: {
      recordObservedActivity: () => undefined,
    } as unknown as NativeAgentPromptDispatchHost["launches"],
    providerRegistry: {
      beginDispatch: () => events.push("registry:enter"),
      endDispatch: () => events.push("registry:exit"),
    } as unknown as NativeAgentPromptDispatchHost["providerRegistry"],
    turnRecovery: {
      appliesTo: () => false,
      claimManualPrompt: async () => undefined,
      releaseManualPrompt: () => undefined,
    } as unknown as NativeAgentPromptDispatchHost["turnRecovery"],
    goals: { command: async () => undefined } as unknown as NativeAgentPromptDispatchHost["goals"],
    handoffs: {
      pending: async () => undefined,
      markConsumed: async () => undefined,
    } as unknown as NativeAgentPromptDispatchHost["handoffs"],
    signInResends: {
      remember: () => undefined,
    } as unknown as NativeAgentPromptDispatchHost["signInResends"],
    now: () => 1_000,
    assertAcceptingWork: () => undefined,
    assertEnvironmentLive: async () => ({ id: identity.environmentId }) as Environment,
    assertProjectionInput: () => undefined,
    beginBridgeWork: () => {
      events.push("bridge:enter");
      return () => events.push("bridge:exit");
    },
    trustedSessionInput: async (value) => value,
    ensureSession: async () => session,
    provider: async () => provider,
    resolveProjectionSession: async () => ({
      key: sessionKey,
      session,
      provider,
      transient: false,
    }),
    applySessionHeldDispatchModel: async () => {
      events.push("admit");
      return undefined;
    },
    sessionTurnIsBusy: () => false,
    recordObservedTurnOutcome: async () => undefined,
    settleArtifactTurn: () => undefined,
    tabMailFor: async () => undefined,
    notifyPromptQueueChanged: () => undefined,
    ...input.host,
  };
  return { dispatch: new NativeAgentPromptDispatch(host), events, provider };
}

describe("NativeAgentPromptDispatch", () => {
  test("a prompt takes its fences and lease in one fixed order and releases them in reverse", async () => {
    const { dispatch, events } = harness();
    await dispatch.dispatchPrompt({ ...identity, prompt: "hello", requestId: "request-1" });
    expect(events).toEqual([
      "bridge:enter",
      "environment:enter",
      "mutation:enter",
      "registry:enter",
      "lease:enter",
      "admit",
      "observation:enter",
      "send:request-1",
      "accepted",
      "observation:exit",
      "lease:exit",
      "registry:exit",
      "mutation:exit",
      "environment:exit",
      "bridge:exit",
    ]);
  });

  test("the intent path takes the mutation intent before the same inner order", async () => {
    const { dispatch, events } = harness();
    const outcome = await dispatch.dispatchIntent({
      ...identity,
      prompt: "hello",
      requestId: "request-2",
    });
    expect(outcome).toEqual({ outcome: "accepted", requestId: "request-2" });
    expect(events.slice(0, 4)).toEqual([
      "bridge:enter",
      "environment:enter",
      "intent:enter",
      "bridge:enter",
    ]);
    expect(events.indexOf("mutation:enter")).toBeGreaterThan(events.indexOf("intent:enter"));
    expect(events.at(-1)).toBe("bridge:exit");
    expect(events.at(-3)).toBe("intent:exit");
  });

  test("a refused environment fence rejects the intent and releases the bridge", async () => {
    const { dispatch, events } = harness({
      host: {
        environmentFence: {
          beginAgentWork: () => {
            throw new Error("Environment is being replaced");
          },
          assertAcceptsAgentWork: () => undefined,
        } as unknown as NativeAgentPromptDispatchHost["environmentFence"],
      },
    });
    expect(
      await dispatch.dispatchIntent({ ...identity, prompt: "hello", requestId: "request-3" }),
    ).toEqual({ outcome: "rejected", error: "Environment is being replaced" });
    expect(events).toEqual(["bridge:enter", "bridge:exit"]);
  });

  test("a tab with pending teardown refuses the intent before taking it", async () => {
    const tabIdentity = { ...identity, logicalSessionKey: "env-env-1:tab-1" };
    const { dispatch, events } = harness({
      environment: { tabTeardownIntents: { "tab-1": {} } } as unknown as Partial<Environment>,
    });
    const outcome = await dispatch.dispatchIntent({
      ...tabIdentity,
      prompt: "hello",
      requestId: "request-4",
    });
    expect(outcome.outcome).toBe("rejected");
    expect(events).not.toContain("intent:enter");
  });

  test("a steer takes the mutation fence around its storage lease", async () => {
    const { dispatch, events, provider } = harness();
    provider.performSessionAction = async () => {
      events.push("steer");
      return { outcome: "applied" };
    };
    const pending = {
      requestId: "steer-1",
      text: "now",
      inputDigest: "0".repeat(64),
      expectedRunId: "run-1",
      state: "prepared",
      createdAt: new Date(0).toISOString(),
    } as PersistedNativeAgentPendingSteer;
    const outcome = await dispatch.dispatchPersistedSteer(
      provider,
      "provider-session",
      sessionKey,
      pending,
    );
    expect(outcome).toEqual({ outcome: "applied" });
    expect(events).toEqual([
      "mutation:enter",
      "steer-lease:enter",
      "steer",
      "steer-lease:exit",
      "mutation:exit",
    ]);
  });

  test("a steer for a replaced provider session is cleared without a provider call", async () => {
    const { dispatch, events, provider } = harness({
      provider: { performSessionAction: async () => ({ outcome: "applied" }) },
    });
    const outcome = await dispatch.dispatchPersistedSteer(
      provider,
      "an-older-session",
      sessionKey,
      { requestId: "steer-2" } as PersistedNativeAgentPendingSteer,
    );
    expect(outcome).toEqual({ outcome: "mismatch" });
    expect(events).toEqual(["clear-steer:steer-2"]);
  });

  test("settling a parked dispatch follows the provider's journal and nothing else", async () => {
    const parked = { pendingDispatch: { requestId: "parked" } } as never;
    for (const [status, expected] of [
      ["dispatched", "confirmed"],
      ["pending", "confirmed"],
      ["lost", "retired"],
      ["absent", undefined],
    ] as const) {
      const { dispatch } = harness({
        session: parked,
        provider: { dispatchStatus: async () => status },
      });
      expect(await dispatch.settleAmbiguousDispatch(identity, sessionKey, "parked")).toBe(expected);
    }
    // A provider with no journal cannot answer, and a different parked id is left alone.
    expect(
      await harness({ session: parked }).dispatch.settleAmbiguousDispatch(
        identity,
        sessionKey,
        "parked",
      ),
    ).toBeUndefined();
    expect(
      await harness({
        session: parked,
        provider: { dispatchStatus: async () => "dispatched" },
      }).dispatch.settleAmbiguousDispatch(identity, sessionKey, "another"),
    ).toBeUndefined();
  });

  test("discard clears the parked steer or dispatch the caller was shown", async () => {
    const steer = harness({ session: { pendingSteer: { requestId: "steer-3" } } as never });
    expect(
      await steer.dispatch.discardRecoverableDispatch({ ...identity, requestId: "steer-3" }),
    ).toEqual({ discarded: true });
    expect(steer.events).toEqual(["clear-steer:steer-3"]);
    const prompt = harness({ session: { pendingDispatch: { requestId: "prompt-3" } } as never });
    await prompt.dispatch.discardRecoverableDispatch({ ...identity, requestId: "prompt-3" });
    expect(prompt.events).toEqual(["clear-dispatch:prompt-3"]);
  });

  test("hasPendingTabTeardown matches only the environment's own tab keys", () => {
    const environment = {
      id: "env-1",
      tabTeardownIntents: { "tab-1": {} },
    } as unknown as Environment;
    expect(hasPendingTabTeardown(environment, "env-env-1:tab-1")).toBe(true);
    expect(hasPendingTabTeardown(environment, "env-env-1:tab-2")).toBe(false);
    expect(hasPendingTabTeardown(environment, "workflow-session")).toBe(false);
    expect(hasPendingTabTeardown(null, "env-env-1:tab-1")).toBe(false);
  });
});
