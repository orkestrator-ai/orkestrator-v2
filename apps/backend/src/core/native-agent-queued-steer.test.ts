import { describe, expect, mock, spyOn, test } from "bun:test";
import type { NativeAgentSessionActionOutcome } from "@orkestrator/protocol/native-agent";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";
import { StorageService, isPersistedNativeAgentSession } from "./storage.js";
import { storageInternals } from "./storage-test-support.js";

const identity = {
  environmentId: "env-1",
  agent: "cursor" as const,
  logicalSessionKey: "env-env-1:queued-steer",
};
const key = nativeAgentSessionStorageKey(
  identity.environmentId,
  identity.agent,
  identity.logicalSessionKey,
);
const queueKey = `${identity.agent}\0${identity.logicalSessionKey}`;
const item = {
  id: "queued-item",
  requestId: "stable-queued-request",
  text: "Keep the changes small",
  model: "model-a",
  mode: "build",
  reasoningEffort: "high",
  fastMode: true,
  includeLocalSettings: false,
};
const tail = { id: "tail", text: "Next task" };

type Context = Parameters<Parameters<typeof withService>[1]>[0];
async function fixture(
  run: (
    context: Context & {
      perform: ReturnType<typeof mock>;
      setStatus: (value: "dispatched" | "absent" | "unknown") => void;
      setResponse: (value: NativeAgentSessionActionOutcome | Error) => void;
    },
  ) => Promise<void>,
) {
  let status: "dispatched" | "absent" | "unknown" = "unknown";
  let response: NativeAgentSessionActionOutcome | Error = { outcome: "applied" };
  const stub = createProviderStub("cursor", { status: async () => "running" });
  const perform = mock(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  Object.assign(stub.provider, {
    activeSteerRun: async () => ({ state: "running", runId: "run-1" }),
    steerStatus: async () => status,
    performSessionAction: perform,
  });
  await withService(
    { prefix: "queued-steer-", provider: async () => stub.provider },
    async (context) => {
      await context.service.ensureSession(identity);
      await context.storage.enqueuePromptQueueMessage(queueKey, identity.environmentId, item);
      await context.storage.enqueuePromptQueueMessage(queueKey, identity.environmentId, tail);
      await run({
        ...context,
        perform,
        setStatus: (value) => {
          status = value;
        },
        setResponse: (value) => {
          response = value;
        },
      });
    },
  );
}

async function reopened(storage: StorageService) {
  const next = new StorageService(storage.getDataDir());
  await next.init();
  return next;
}

describe("durable queue-to-steer handoff", () => {
  test("a lost applied response cannot dispatch the item twice", async () => {
    await fixture(async ({ service, storage, perform }) => {
      await service.steerQueuedPrompt({ ...identity, messageId: item.id }); // caller loses this response
      expect((await storage.getPromptQueue(queueKey))?.messages).toEqual([tail]);
      expect(await service.steerQueuedPrompt({ ...identity, messageId: item.id })).toBeNull();
      expect(perform).toHaveBeenCalledTimes(1);
      const action = perform.mock.calls[0] as unknown[];
      expect(action[1]).toMatchObject({ requestId: item.requestId, expectedRunId: "run-1" });
    });
  });

  test("a thrown provider response stays reserved across reload and reconciles delivery", async () => {
    await fixture(async ({ service, storage, perform, setResponse, setStatus }) => {
      setResponse(new Error("Response lost after admission"));
      expect(await service.steerQueuedPrompt({ ...identity, messageId: item.id })).toEqual({
        outcome: "unknown",
        requestId: item.requestId,
      });
      await storage.enqueuePromptQueueMessage(queueKey, identity.environmentId, item); // retry a lost enqueue response
      const next = await reopened(storage);
      expect((await next.getPromptQueue(queueKey))?.messages).toEqual([tail]);
      expect((await next.getPromptQueue(queueKey))?.inFlight?.message).toEqual(item);
      expect(await service.steerQueuedPrompt({ ...identity, messageId: item.id })).toEqual({
        outcome: "unknown",
        requestId: item.requestId,
      });
      expect(perform).toHaveBeenCalledTimes(1);
      setStatus("dispatched");
      await service.drainPromptQueueForSession(identity);
      expect((await next.getPromptQueue(queueKey))?.inFlight).toBeUndefined();
      expect((await next.getPromptQueue(queueKey))?.messages).toEqual([tail]);
      expect((await next.getNativeAgentSession(key))?.dispatchedRequestIds).toContain(
        item.requestId,
      );
    });
  });

  for (const outcome of ["idle", "mismatch", "rejected"] as const) {
    test(`unknown followed by ${outcome} restores all metadata exactly once`, async () => {
      await fixture(async ({ service, storage, setResponse }) => {
        setResponse({ outcome: "unknown" });
        await service.steerQueuedPrompt({ ...identity, messageId: item.id });
        setResponse(
          outcome === "rejected"
            ? { outcome, requestId: item.requestId, reason: "steer-not-recorded" }
            : { outcome },
        );
        await service.retryRecoverableDispatch({ ...identity, requestId: item.requestId });
        const next = await reopened(storage);
        await next.recoverPromptQueueSteer(key, item.requestId);
        await next.recoverPromptQueueSteer(key, item.requestId);
        expect((await next.getPromptQueue(queueKey))?.messages).toEqual([item, tail]);
        expect((await next.getNativeAgentSession(key))?.pendingSteer).toBeUndefined();
      });
    });
  }

  test("absent reconciliation restores the reserved item with no mounted renderer", async () => {
    await fixture(async ({ service, storage, setResponse, setStatus, perform }) => {
      setResponse({ outcome: "unknown" });
      await service.steerQueuedPrompt({ ...identity, messageId: item.id });
      setStatus("absent");
      await service.drainPromptQueueForSession(identity);
      const next = await reopened(storage);
      expect((await next.getPromptQueue(queueKey))?.messages).toEqual([item, tail]);
      expect((await next.getNativeAgentSession(key))?.pendingSteer).toBeUndefined();
      expect(perform).toHaveBeenCalledTimes(1);
    });
  });

  test("another pending steer never takes ownership of this item", async () => {
    await fixture(async ({ service, storage, setResponse, perform }) => {
      setResponse({ outcome: "unknown" });
      await service.performProjectionAction({
        ...identity,
        action: { kind: "steer", text: "Composer instruction" },
      });
      await expect(
        service.steerQueuedPrompt({ ...identity, messageId: item.id }),
      ).rejects.toThrow();
      expect((await storage.getPromptQueue(queueKey))?.messages).toEqual([item, tail]);
      expect(perform).toHaveBeenCalledTimes(1);
    });
  });

  test("interruption after queue reservation but before the receipt restores safely", async () => {
    await fixture(async ({ service, storage, perform }) => {
      const internal = storageInternals(storage).repos.nativeAgentSessions as unknown as {
        saveNativeAgentSession: (...args: unknown[]) => Promise<void>;
      };
      const write = spyOn(internal, "saveNativeAgentSession").mockRejectedValueOnce(
        new Error("Interrupted receipt write"),
      );
      try {
        await expect(
          service.steerQueuedPrompt({ ...identity, messageId: item.id }),
        ).rejects.toThrow("Interrupted");
      } finally {
        write.mockRestore();
      }
      const next = await reopened(storage);
      await next.recoverPromptQueueSteer(key, item.requestId);
      expect((await next.getPromptQueue(queueKey))?.messages).toEqual([item, tail]);
      expect(perform).not.toHaveBeenCalled();
    });
  });

  for (const settlement of ["applied", "restore", "discard"] as const) {
    test(`restart finishes durable ${settlement} settlement without resending`, async () => {
      await fixture(async ({ service, storage, perform, setResponse }) => {
        setResponse({ outcome: "unknown" });
        await service.steerQueuedPrompt({ ...identity, messageId: item.id });
        const internal = storageInternals(storage).repos.nativeAgentDeliveries as unknown as {
          settlePromptQueueSteerSource: (...args: unknown[]) => Promise<void>;
        };
        const write = spyOn(internal, "settlePromptQueueSteerSource").mockRejectedValueOnce(
          new Error("Interrupted settlement"),
        );
        try {
          const operation =
            settlement === "applied"
              ? storage.confirmNativeAgentSteer(key, item.requestId)
              : storage.clearPendingNativeAgentSteer(key, item.requestId, settlement === "discard");
          await expect(operation).rejects.toThrow("Interrupted");
        } finally {
          write.mockRestore();
        }
        const next = await reopened(storage);
        await next.recoverPromptQueueSteer(key, item.requestId);
        expect((await next.getPromptQueue(queueKey))?.messages).toEqual(
          settlement === "restore" ? [item, tail] : [tail],
        );
        expect((await next.getNativeAgentSession(key))?.pendingSteer).toBeUndefined();
        expect(perform).toHaveBeenCalledTimes(1);
      });
    });
  }

  test("reconciliation cannot use an absent read taken before an in-flight send", async () => {
    await fixture(async ({ storage }) => {
      const pending = await storage.reservePromptQueueSteer(key, item.id, "run-1");
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let admitted = false;
      const sending = storage.dispatchNativeAgentSteerOnce(key, pending!, async () => {
        entered();
        await gate;
        admitted = true;
        return { outcome: "unknown" };
      });
      await started;
      const read = mock(async () => (admitted ? ("dispatched" as const) : ("absent" as const)));
      const reconciling = storage.reconcileNativeAgentSteer(key, item.requestId, read);
      try {
        expect(read).not.toHaveBeenCalled();
      } finally {
        release();
      }
      await sending;
      expect(await reconciling).toBe("dispatched");
      expect((await storage.getPromptQueue(queueKey))?.messages).toEqual([tail]);
    });
  });

  test("a reservation settled absent before handoff cannot be recreated and sent", async () => {
    await fixture(async ({ storage }) => {
      const pending = await storage.reservePromptQueueSteer(key, item.id, "run-1");
      await storage.reconcileNativeAgentSteer(key, item.requestId, async () => "absent");
      const send = mock(async () => ({ outcome: "applied" as const }));
      expect(await storage.dispatchNativeAgentSteerOnce(key, pending!, send)).toEqual({
        outcome: "mismatch",
      });
      expect(send).not.toHaveBeenCalled();
      expect((await storage.getPromptQueue(queueKey))?.messages).toEqual([item, tail]);
    });
  });

  test("malformed settlement data cannot turn a reserved source into a discard", async () => {
    await fixture(async ({ storage }) => {
      await storage.reservePromptQueueSteer(key, item.id, "run-1");
      const session = await storage.getNativeAgentSession(key);
      for (const queueSettlement of [["applied"], ["restore"], ["discard"], {}, null]) {
        expect(
          isPersistedNativeAgentSession(
            { ...session, pendingSteer: { ...session!.pendingSteer, queueSettlement } },
            key,
          ),
        ).toBe(false);
      }
    });
  });

  test("manual steering rejects async answers, attachments, commands, and annotations on the backend", async () => {
    await fixture(async ({ service, storage, perform }) => {
      for (const blocked of [
        { id: "async-question:q", text: "Answer" },
        { id: "command", text: "/test", command: {} },
        { id: "image", text: "See this", attachments: [{}] },
        {
          id: "annotation",
          text: "Note",
          origin: { kind: "web-annotation", requestId: "req", bodyHash: "hash" },
        },
      ]) {
        await storage.enqueuePromptQueueMessage(queueKey, identity.environmentId, blocked);
        await expect(
          service.steerQueuedPrompt({ ...identity, messageId: blocked.id }),
        ).rejects.toThrow("cannot be steered");
      }
      expect(perform).not.toHaveBeenCalled();
    });
  });
});
