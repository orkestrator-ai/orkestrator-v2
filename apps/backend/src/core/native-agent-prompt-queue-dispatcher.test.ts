import { describe, expect, mock, test } from "bun:test";
import {
  NativeAgentPromptQueueDispatcher,
  type NativeAgentPromptQueueDispatcherHost,
} from "./native-agent-prompt-queue-dispatcher.js";
import {
  nativeAgentSessionStorageKey,
  type NativeAgentRuntimeProvider,
  type StorageService,
} from "./native-agent-service-shared.js";

const identity = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:tab-1",
};
const sessionKey = nativeAgentSessionStorageKey(
  identity.environmentId,
  identity.agent,
  identity.logicalSessionKey,
);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function harness(overrides: Partial<NativeAgentPromptQueueDispatcherHost> = {}) {
  let stopped = false;
  const tracked: Promise<void>[] = [];
  const host: NativeAgentPromptQueueDispatcherHost = {
    storage: {
      listAllPromptQueues: async () => [],
      getPromptQueue: async () => null,
    } as unknown as StorageService,
    isStopped: () => stopped,
    trackScan: (task) => {
      tracked.push(task);
      return task;
    },
    refreshProjection: mock(async () => null),
    queueSessionObservedBusy: () => false,
    assertEnvironmentLive: async () => {
      throw new Error("unexpected environment check");
    },
    ensureSession: async () => {
      throw new Error("unexpected ensure");
    },
    provider: async () => {
      throw new Error("unexpected provider");
    },
    dispatchPrompt: async () => {
      throw new Error("unexpected dispatch");
    },
    dispatchQueuedAsyncQuestionAnswer: async () => {
      throw new Error("unexpected steer");
    },
    recordObservedTurnOutcome: async () => undefined,
    settleAmbiguousDispatch: mock(async () => "confirmed" as const),
    settleAmbiguousSteer: mock(async () => "dispatched" as const),
    ...overrides,
  };
  return {
    dispatcher: new NativeAgentPromptQueueDispatcher(host),
    host,
    tracked,
    stop: () => {
      stopped = true;
    },
  };
}

describe("NativeAgentPromptQueueDispatcher session work fences", () => {
  test("work for one session runs in admission order; other sessions are not held", async () => {
    const { dispatcher } = harness();
    const order: string[] = [];
    const first = deferred();
    const a = dispatcher.withSessionWorkFence(identity, async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = dispatcher.withSessionWorkFence(identity, async () => {
      order.push("b");
    });
    await dispatcher.withSessionWorkFence({ ...identity, logicalSessionKey: "other" }, async () => {
      order.push("other");
    });
    expect(order).toEqual(["a:start", "other"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "other", "a:end", "b"]);
  });

  test("a mutation intent is visible while it waits behind the fence", async () => {
    const { dispatcher } = harness();
    const holder = deferred();
    const held = dispatcher.withSessionWorkFence(identity, () => holder.promise);
    const waiting = dispatcher.withSessionMutationFence(identity, async () => "done");
    expect(dispatcher.hasPendingSessionMutation(sessionKey)).toBe(true);
    holder.resolve();
    await held;
    await expect(waiting).resolves.toBe("done");
    expect(dispatcher.hasPendingSessionMutation(sessionKey)).toBe(false);
  });

  test("mutation admission refuses a new session past 1,024 waiting keys", async () => {
    const { dispatcher } = harness();
    const release = deferred();
    const pending = Array.from({ length: 1_024 }, (_, index) =>
      dispatcher.withSessionMutationIntent(
        { ...identity, logicalSessionKey: `tab-${index}` },
        () => release.promise,
      ),
    );
    await expect(
      dispatcher.withSessionMutationIntent(
        { ...identity, logicalSessionKey: "one-too-many" },
        async () => undefined,
      ),
    ).rejects.toThrow("Native session mutation admission is at capacity");
    release.resolve();
    await Promise.all(pending);
  });
});

describe("NativeAgentPromptQueueDispatcher interrupt fences", () => {
  test("a Stop fences its request until storage acknowledges it", () => {
    const { dispatcher } = harness();
    dispatcher.fenceTurnInterrupt(sessionKey, "provider-session", "request-1");
    expect(dispatcher.pendingTurnInterrupt(sessionKey, "request-1")).toEqual({
      providerSessionId: "provider-session",
      requestId: "request-1",
    });
    dispatcher.releaseTurnInterrupt(sessionKey, "request-1");
    expect(dispatcher.pendingTurnInterrupt(sessionKey, "request-1")).toBeUndefined();
    expect(dispatcher.interruptFencesOverflowed()).toBe(false);
  });

  test("past 256 unpersisted Stops no fence is evicted; every outcome becomes untrustworthy", () => {
    const { dispatcher } = harness();
    for (let index = 0; index < 256; index += 1) {
      dispatcher.fenceTurnInterrupt(sessionKey, "provider-session", `request-${index}`);
    }
    dispatcher.fenceTurnInterrupt(sessionKey, "provider-session", "request-256");
    expect(dispatcher.interruptFencesOverflowed()).toBe(true);
    expect(dispatcher.pendingTurnInterrupt(sessionKey, "request-0")).toBeDefined();
    expect(dispatcher.pendingTurnInterrupt(sessionKey, "request-256")).toBeUndefined();
  });
});

describe("NativeAgentPromptQueueDispatcher parked-dispatch settles", () => {
  test.each(["confirmed", "retired"] as const)(
    "concurrent settles coalesce and refresh after %s",
    async (outcome) => {
      const settled = deferred<"confirmed" | "retired" | undefined>();
      const settleAmbiguousDispatch = mock(() => settled.promise);
      const { dispatcher, host, tracked } = harness({ settleAmbiguousDispatch });
      const provider = {} as NativeAgentRuntimeProvider;

      dispatcher.scheduleAmbiguousDispatchSettle(identity, sessionKey, "request-1", provider);
      dispatcher.scheduleAmbiguousDispatchSettle(identity, sessionKey, "request-1", provider);
      expect(settleAmbiguousDispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.forTesting().settlingDispatches.size).toBe(1);

      settled.resolve(outcome);
      await Promise.all(tracked);
      expect(host.refreshProjection).toHaveBeenCalledWith(identity);
      expect(dispatcher.forTesting().settlingDispatches.size).toBe(0);
    },
  );
});

describe("NativeAgentPromptQueueDispatcher scheduling", () => {
  test("keyed scheduling reports status until stopped", async () => {
    const { dispatcher } = harness();
    expect(dispatcher.schedulingStatus()).toBeNull();
    await expect(dispatcher.reconcileScheduling()).resolves.toBeNull();

    dispatcher.startKeyedScheduling(async () => 0, {
      progressIntervalMs: 60_000,
      discoveryIntervalMs: 60_000,
    });
    expect(dispatcher.schedulingStatus()).not.toBeNull();
    dispatcher.stopScheduling();
    expect(dispatcher.schedulingStatus()).toBeNull();
  });

  test("a stopped dispatcher ignores queue notifications and drains nothing", async () => {
    const getPromptQueue = mock(async () => null);
    const { dispatcher, stop } = harness({
      storage: { getPromptQueue } as unknown as StorageService,
    });
    stop();
    dispatcher.notifyPromptQueueChanged("codex\0tab-1");
    await dispatcher.drainPromptQueueForSession(identity);
    expect(getPromptQueue).not.toHaveBeenCalled();
    expect(dispatcher.pendingDrains()).toEqual([]);
  });
});
