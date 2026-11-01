import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  NativeAgentPromptQueueDispatcher,
  type NativeAgentPromptQueueDispatcherHost,
} from "./native-agent-prompt-queue-dispatcher.js";
import {
  nativeAgentSessionStorageKey,
  type NativeAgentRuntimeProvider,
} from "./native-agent-service-shared.js";

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";
import {
  seedLegacyPromptQueueClaim,
  storageDatabase,
  readStoredValue,
} from "./storage-test-support.js";

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

async function withPersistedQueue(
  run: (storage: StorageService, context: ReturnType<typeof harness>) => Promise<void>,
) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ork-legacy-queue-scan-"));
  const storage = new StorageService(directory);
  await storage.init();
  try {
    const environment = await storage.addEnvironment({
      id: identity.environmentId,
      projectId: "project-1",
      name: "test",
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      setupPhase: "ready",
    });
    const session = await storage.getOrCreateNativeAgentSession(
      { ...identity, key: sessionKey },
      async () => "provider-1",
    );
    const context = harness({
      storage,
      assertEnvironmentLive: async () => environment,
      ensureSession: async () => session,
      provider: async () =>
        ({ status: async () => "idle" }) as unknown as NativeAgentRuntimeProvider,
      dispatchPrompt: mock(async () => session),
    });
    await run(storage, context);
  } finally {
    storage.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const queueKey = `${identity.agent}\0${identity.logicalSessionKey}`;

describe("NativeAgentPromptQueueDispatcher legacy claim scans", () => {
  test("a mixed-backend holder remains the sole submitter across normalization and acknowledgement", async () => {
    await withPersistedQueue(async (storage, { dispatcher, host }) => {
      await storage.enqueuePromptQueueMessage(queueKey, identity.environmentId, {
        id: "head",
        text: "claimed",
      });
      const expiresAt = Date.now() + 300_000;
      const token = seedLegacyPromptQueueClaim(storage.getDataDir(), queueKey, "head", {
        expiresAt,
      });
      const peer = new StorageService(storage.getDataDir());
      await peer.init();
      try {
        // Model the old command's holder crossing submission, then waiting to ack.
        const submit = mock(async (_requestId: string) => undefined);
        const dispatch = spyOn(host, "dispatchPrompt");
        await submit("head");
        const releaseAck = deferred();
        const acknowledgement = (async () => {
          await releaseAck.promise;
          // The old acknowledge command consumes only the matching token,
          // under the same cross-backend prompt queue storage lease.
          const database = storageDatabase(peer);
          const release = await database.acquireLease(
            "prompt-queues.json",
            "legacy claim acknowledgement",
          );
          try {
            database.transaction(() => {
              const queues = database.readStore("prompt-queues")!.value as Record<
                string,
                Record<string, unknown>
              >;
              expect(queues[queueKey]!.outstandingClaim).toMatchObject({ token });
              const { outstandingClaim: _claim, ...queue } = queues[queueKey]!;
              queues[queueKey] = { ...queue, revision: (queue.revision as number) + 1 };
              database.writeStoreInTransaction("prompt-queues", queues);
            });
          } finally {
            await release();
          }
        })();
        try {
          expect((await peer.getPromptQueue(queueKey))?.outstandingClaim?.token).toBe(token);
          // Normalizing a different expired claim and saving it writes the entire store.
          const otherKey = "codex\0other-tab";
          await storage.enqueuePromptQueueMessage(otherKey, identity.environmentId, {
            id: "other",
          });
          seedLegacyPromptQueueClaim(storage.getDataDir(), otherKey, "other", { expiresAt: 1 });
          await storage.savePromptQueue(otherKey, identity.environmentId, []);
          expect(
            readStoredValue<Record<string, unknown>>(storage.getDataDir(), "prompt-queues.json")?.[
              queueKey
            ],
          ).toMatchObject({ messages: [], outstandingClaim: { token } });
          await dispatcher.forTesting().drainPromptQueues();
          await dispatcher.drainPromptQueueForSession(identity);
          expect(host.dispatchPrompt).not.toHaveBeenCalled();
          expect(submit.mock.calls.length + dispatch.mock.calls.length).toBe(1);
        } finally {
          releaseAck.resolve();
          await Promise.all([acknowledgement, dispatcher.forTesting().drainPromptQueues()]);
        }
        const clock = spyOn(Date, "now").mockReturnValue(expiresAt + 1);
        try {
          await dispatcher.forTesting().drainPromptQueues();
          expect(host.dispatchPrompt).not.toHaveBeenCalled();
          expect(submit.mock.calls.length + dispatch.mock.calls.length).toBe(1);
          expect((await storage.getPromptQueue(queueKey))?.messages).toEqual([]);
        } finally {
          clock.mockRestore();
        }
      } finally {
        peer.close();
      }
    });
  });

  test.each(["head", undefined, "", "  ", 42])(
    "the recurring scan dispatches an expired claim with id %p exactly once",
    async (id) => {
      await withPersistedQueue(async (storage, { dispatcher, host }) => {
        // Save accepts opaque legacy rows; restoration must repair invalid ids.
        await storage.savePromptQueue(queueKey, identity.environmentId, [
          { id, text: "recovered", attachments: [] },
        ]);
        seedLegacyPromptQueueClaim(storage.getDataDir(), queueKey, id as string, { expiresAt: 1 });
        const first = await storage.getPromptQueue(queueKey);
        const head = first?.messages[0] as { id: string };
        expect(head.id.trim().length).toBeGreaterThan(0);
        expect((await storage.getPromptQueue(queueKey))?.messages).toEqual(first?.messages);
        await dispatcher.forTesting().drainPromptQueues();
        expect(host.dispatchPrompt).toHaveBeenCalledTimes(1);
        expect(host.dispatchPrompt).toHaveBeenCalledWith(
          expect.objectContaining({ requestId: head.id, prompt: "recovered" }),
        );
        await dispatcher.forTesting().drainPromptQueues();
        expect(host.dispatchPrompt).toHaveBeenCalledTimes(1);
        expect(await storage.getPromptQueue(queueKey)).toMatchObject({ messages: [] });
        expect(await storage.getPromptQueue(queueKey)).not.toHaveProperty("outstandingClaim");
      });
    },
  );
});

test("queue holds while limit recovery is pending, then releases the head", async () => {
  await withPersistedQueue(async (storage, { dispatcher, host }) => {
    await storage.enqueuePromptQueueMessage(queueKey, identity.environmentId, {
      id: "head",
      text: "queued",
    });
    let pending = true;
    host.usageLimitResendPending = () => pending;
    host.provider = async () =>
      ({ status: async () => "error" }) as unknown as NativeAgentRuntimeProvider;
    await dispatcher.drainPromptQueueForSession(identity);
    expect(host.dispatchPrompt).not.toHaveBeenCalled();
    expect((await storage.getPromptQueue(queueKey))?.inFlight).toBeUndefined();
    pending = false;
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
    try {
      await dispatcher.drainPromptQueueForSession(identity);
      expect(host.dispatchPrompt).not.toHaveBeenCalled();
      expect(dispatcher.forTesting().queueAttempts.get(queueKey)).toBe(1);
      host.provider = async () =>
        ({ status: async () => "idle" }) as unknown as NativeAgentRuntimeProvider;
      clock.mockReturnValue(Date.now() + 60000);
      await dispatcher.drainPromptQueueForSession(identity);
      expect(host.dispatchPrompt).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
});
