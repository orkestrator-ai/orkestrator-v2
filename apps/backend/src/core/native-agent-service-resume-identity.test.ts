import { describe, expect, mock, test } from "bun:test";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { NativeAgentResumeIdentityObserver } from "./native-agent-resume-identity.js";
import { nativeAgentSessionResumeIdentity } from "./models.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const identity = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:tab-resume",
};
const key = nativeAgentSessionStorageKey("env-1", "codex", identity.logicalSessionKey);

/** Real command teardown over the same storage and service as the projection. */
function teardown(context: Pick<CommandContext, "storage" | "nativeAgents">) {
  const recordTabSession = mock(async () => 1);
  const close = mock(async () => Response.json({ closed: true, missing: true }));
  const registry = createCommandRegistry({
    tabTeardown: {
      peekBridge: async () => ({ port: 4000, authToken: "test-token" }),
      fetch: close as unknown as typeof fetch,
    },
  });
  return {
    recordTabSession,
    close,
    run: async () =>
      registry.get("teardown_tab")!(
        { environmentId: "env-1", tabId: "tab-resume", kind: "codex-native" },
        {
          ...context,
          design: { recordTabSession },
          emit: () => undefined,
        } as unknown as CommandContext,
      ),
  };
}

describe("resume identity observation and teardown interleavings", () => {
  test("teardown waits for an observed identity queued behind a provider mutation", async () => {
    let missing = false;
    const stub = createProviderStub("codex", {
      sessionStateSnapshot: async () => ({
        status: missing ? "missing" : "idle",
        resumableSessionId: "thread-queued",
      }),
    });
    await withService(
      { prefix: "ork-resume-queued-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const session = await service.ensureSession(identity);
        const leased = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const captureQueued = Promise.withResolvers<void>();
        const teardownQueued = Promise.withResolvers<void>();
        const record = storage.recordNativeAgentSessionResumeIdentity.bind(storage);
        const read = storage.getNativeAgentSessionAfterMutations.bind(storage);
        storage.recordNativeAgentSessionResumeIdentity = (...args) => {
          const pending = record(...args);
          captureQueued.resolve();
          return pending;
        };
        storage.getNativeAgentSessionAfterMutations = (...args) => {
          const pending = read(...args);
          teardownQueued.resolve();
          return pending;
        };
        const mutation = storage.updateNativeAgentSessionControls(
          key,
          session.providerSessionId,
          {},
          async () => {
            leased.resolve();
            await release.promise;
          },
        );
        const closing = teardown({ storage, nativeAgents: service });
        let stateSettled = false;
        let state: Promise<unknown> | undefined;
        let close: Promise<unknown> | undefined;
        try {
          await leased.promise;
          state = service.getSessionStateUpdate({ ...identity, viewVersion: 1 }).then((result) => {
            stateSettled = true;
            return result;
          });
          await captureQueued.promise;
          missing = true;
          close = closing.run();
          await teardownQueued.promise;
          expect(stateSettled).toBe(false);
          expect(closing.close).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await Promise.all([mutation, state, close]);
        }
        expect(closing.recordTabSession).toHaveBeenCalledWith({
          environmentId: "env-1",
          tabId: "tab-resume",
          platform: "codex",
          providerSessionId: "thread-queued",
        });
        expect(await storage.getNativeAgentSession(key)).toBeNull();
        expect(closing.close).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("a full projection delayed by metadata cannot replace a newer progressive thread", async () => {
    const metadataStarted = Promise.withResolvers<void>();
    const releaseMetadata = Promise.withResolvers<void>();
    let missing = false;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        resumableSessionId: "thread-A",
      }),
      sessionStateSnapshot: async () => ({
        status: missing ? "missing" : "idle",
        resumableSessionId: "thread-B",
      }),
      slashCommands: async () => {
        metadataStarted.resolve();
        await releaseMetadata.promise;
        return [];
      },
    });
    await withService(
      { prefix: "ork-resume-metadata-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        const full = service.getProjection(identity);
        try {
          await metadataStarted.promise;
          await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
          const current = await storage.getNativeAgentSession(key);
          expect(current && nativeAgentSessionResumeIdentity(current)).toBe("thread-B");
        } finally {
          releaseMetadata.resolve();
          await full;
        }
        const current = await storage.getNativeAgentSession(key);
        expect(current && nativeAgentSessionResumeIdentity(current)).toBe("thread-B");
        missing = true;
        const closing = teardown({ storage, nativeAgents: service });
        await closing.run();
        expect(closing.recordTabSession).toHaveBeenCalledWith(
          expect.objectContaining({ providerSessionId: "thread-B" }),
        );
      },
    );
  });

  test("snapshot reads and captures serialize even when the older read is still in flight", async () => {
    const stub = createProviderStub("codex");
    await withService(
      { prefix: "ork-resume-read-order-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        const session = (await storage.getNativeAgentSession(key))!;
        const release = Promise.withResolvers<void>();
        const observer = new NativeAgentResumeIdentityObserver(storage);
        const secondRead = mock(async () => ({ status: "idle", resumableSessionId: "thread-B" }));
        const full = observer.read(session, async () => {
          await release.promise;
          return { status: "idle", resumableSessionId: "thread-A" };
        });
        const progressive = observer.read(session, secondRead);
        try {
          expect(secondRead).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await Promise.all([full, progressive]);
        }
        expect(secondRead).toHaveBeenCalledTimes(1);
        const current = await storage.getNativeAgentSession(key);
        expect(current && nativeAgentSessionResumeIdentity(current)).toBe("thread-B");
        // A failed source does not poison the lane or retain its queue entry.
        await expect(
          observer.read(session, async () => {
            throw new Error("read failed");
          }),
        ).rejects.toThrow("read failed");
        await observer.read(session, async () => ({
          status: "idle",
          resumableSessionId: "thread-C",
        }));
        const recovered = await storage.getNativeAgentSession(key);
        expect(recovered && nativeAgentSessionResumeIdentity(recovered)).toBe("thread-C");
      },
    );
  });
});
