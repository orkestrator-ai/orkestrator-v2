import { describe, expect, test } from "bun:test";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import {
  createProviderStub,
  internals,
  withService,
} from "./native-agent-service-projection-test-support.js";

/**
 * Restart-preview checkpoints through the real projection path (plan step
 * 07): deletion fences a pending checkpoint, and shutdown drains the newest
 * pending preview instead of discarding it.
 */
const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;

function transcriptProvider(content: string) {
  return createProviderStub("cursor", {
    transcriptSnapshot: async () => ({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content,
          parts: [],
          createdAt: "2026-09-09T00:00:00.000Z",
        },
      ],
      complete: true,
      revision: 1,
      sourceToken: "source-1",
      freshness: "current" as const,
    }),
  });
}

const identity = {
  environmentId: "env-1",
  agent: "cursor" as const,
  logicalSessionKey: "env-env-1:display-tail",
};
const sessionKey = nativeAgentSessionStorageKey(
  identity.environmentId,
  identity.agent,
  identity.logicalSessionKey,
);

describe("native agent display-tail checkpoints", () => {
  test("a checkpoint pending across session invalidation never resurrects the tail", async () => {
    const stub = transcriptProvider("before invalidation");
    await withService(
      { prefix: "orkestrator-display-tail-fence-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        await service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        const session = await storage.getNativeAgentSession(sessionKey);
        expect(session).not.toBeNull();
        // Invalidation deletes the tail while the 2 s checkpoint is pending.
        expect(
          await storage.invalidateNativeAgentSession(sessionKey, session!.providerSessionId),
        ).toBe(true);
        await internals(service).flushDisplayTailPersist(sessionKey);
        expect(await storage.getNativeAgentDisplayTail(sessionKey)).toBeNull();
      },
    );
  });

  test("an environment delete fences a checkpoint captured before it", async () => {
    const stub = transcriptProvider("before delete");
    await withService(
      { prefix: "orkestrator-display-tail-env-fence-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        await service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        const fence = storage.captureNativeAgentDisplayTailFence();
        await storage.deleteNativeAgentSessionsByEnvironment(identity.environmentId);
        await internals(service).flushDisplayTailPersist(sessionKey);
        expect(await storage.getNativeAgentDisplayTail(sessionKey)).toBeNull();
        expect(storage.captureNativeAgentDisplayTailFence()).toBeGreaterThan(fence);
      },
    );
  });

  test("shutdown drains the newest pending preview so a restart can paint it", async () => {
    const stub = transcriptProvider("latest streamed text");
    await withService(
      { prefix: "orkestrator-display-tail-shutdown-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        await service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        expect(await storage.getNativeAgentDisplayTail(sessionKey)).toBeNull();
        await service.shutdown();
        const persisted = await storage.getNativeAgentDisplayTail(sessionKey);
        expect(persisted?.messages).toMatchObject([{ id: "m1", content: "latest streamed text" }]);
        expect(persisted?.historyComplete).toBe(true);
      },
    );
  });
});
