import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import {
  addEnvironment,
  createProviderStub,
  createStorage,
} from "./native-agent-service-projection-test-support.js";
import {
  nativeAgentSessionStorageKey,
  type CommandInvoker,
  type NativeAgentRuntimeProvider,
  type StorageService,
} from "./native-agent-service-shared.js";
import {
  NativeAgentTranscriptProjection,
  type NativeAgentTranscriptProjectionHost,
} from "./native-agent-transcript-projection.js";

const identity = {
  environmentId: "env-1",
  agent: "opencode" as const,
  logicalSessionKey: "env-env-1:tab-direct",
};
const sessionKey = nativeAgentSessionStorageKey(
  identity.environmentId,
  identity.agent,
  identity.logicalSessionKey,
);

function textMessage(id: string, content: string) {
  return {
    id,
    role: "assistant",
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

/**
 * A projection wired directly to real storage and a stub provider, with the
 * service's callbacks replaced by the smallest honest stand-ins.
 */
async function withProjection(
  provider: NativeAgentRuntimeProvider,
  run: (context: {
    projection: NativeAgentTranscriptProjection;
    storage: StorageService;
    host: NativeAgentTranscriptProjectionHost;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-transcript-projection-"));
  const storage = await createStorage(dataDir);
  await addEnvironment(storage);
  await storage.getOrCreateNativeAgentSession(
    {
      key: sessionKey,
      environmentId: identity.environmentId,
      agent: identity.agent,
      logicalSessionKey: identity.logicalSessionKey,
    },
    async () => "provider-session",
  );
  const catalogs = new NativeAgentCatalogCache({
    invoke: (async () => []) as CommandInvoker,
    now: () => Date.now(),
    announce: () => undefined,
  });
  const host: NativeAgentTranscriptProjectionHost = {
    storage,
    options: {},
    catalogs,
    observedActivity: () => undefined,
    providerGeneration: () => "generation-1",
    now: () => Date.now(),
    isStopped: () => false,
    assertProjectionInput: () => undefined,
    resolveProjectionSession: async (input) => {
      const key = nativeAgentSessionStorageKey(
        input.environmentId,
        input.agent,
        input.logicalSessionKey,
      );
      const session = await storage.getNativeAgentSession(key);
      return session ? { key, session, provider, transient: false } : null;
    },
    provider: async () => provider,
    recordAsyncQuestionAttention: mock(async () => undefined),
    scheduleAmbiguousDispatchSettle: mock(() => undefined),
    scheduleAmbiguousSteerSettle: mock(() => undefined),
  };
  const projection = new NativeAgentTranscriptProjection(host);
  try {
    await run({ projection, storage, host });
  } finally {
    await Promise.allSettled(projection.pendingRefreshes());
    await projection.settleAndClearProgressiveReads();
    projection.clear();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("NativeAgentTranscriptProjection", () => {
  test("a refresh projects the provider transcript and caches it for in-memory readers", async () => {
    const stub = createProviderStub("opencode", {
      messages: async () => [textMessage("m1", "hello")],
    });
    await withProjection(stub.provider, async ({ projection }) => {
      expect(
        projection.cachedProjectionSnapshot(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        ),
      ).toBeNull();

      const projected = await projection.refreshProjection(identity, true);
      expect(projected?.messages.map((message) => (message as { id: string }).id)).toEqual(["m1"]);
      expect(
        projection.cachedProjectionSnapshot(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        ),
      ).toBe(projected);
    });
  });

  test("an unknown session projects to null", async () => {
    const stub = createProviderStub("opencode");
    await withProjection(stub.provider, async ({ projection }) => {
      await expect(
        projection.refreshProjection({ ...identity, logicalSessionKey: "missing" }, true),
      ).resolves.toBeNull();
    });
  });

  test("invalidation drops the cached view and bumps the session epoch", async () => {
    const stub = createProviderStub("opencode", {
      messages: async () => [textMessage("m1", "hello")],
    });
    await withProjection(stub.provider, async ({ projection }) => {
      await projection.refreshProjection(identity, true);
      const state = projection.forTesting();
      const before = state.projectionEpochs.get(sessionKey) ?? 0;

      projection.invalidateProjection(sessionKey);

      expect(
        projection.cachedProjectionSnapshot(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        ),
      ).toBeNull();
      expect(state.projectionEpochs.get(sessionKey) ?? 0).toBeGreaterThan(before);
    });
  });

  test("a recorded stop notice appears once, on the next authoritative projection", async () => {
    const stub = createProviderStub("opencode", {
      messages: async () => [textMessage("m1", "hello")],
    });
    await withProjection(stub.provider, async ({ projection }) => {
      projection.recordStopNotice(sessionKey, "The turn stopped after a graceful interrupt.");
      const contents = (value: { messages: unknown[] } | null) =>
        (value?.messages ?? []).map((message) => (message as { content?: unknown }).content);

      expect(contents(await projection.refreshProjection(identity, true))).toContain(
        "The turn stopped after a graceful interrupt.",
      );
      projection.invalidateProjection(sessionKey);
      expect(contents(await projection.refreshProjection(identity, true))).not.toContain(
        "The turn stopped after a graceful interrupt.",
      );
    });
  });

  test("stop notices stay bounded at 256 sessions", async () => {
    const stub = createProviderStub("opencode");
    await withProjection(stub.provider, async ({ projection }) => {
      for (let index = 0; index < 300; index += 1) {
        projection.recordStopNotice(`session-${index}`, "stopped");
      }
      const { stopNotices } = projection.forTesting();
      expect(stopNotices.size).toBe(256);
      expect(stopNotices.has("session-0")).toBe(false);
      expect(stopNotices.has("session-299")).toBe(true);
    });
  });

  test("clear drops every legacy cache", async () => {
    const stub = createProviderStub("opencode", {
      messages: async () => [textMessage("m1", "hello")],
    });
    await withProjection(stub.provider, async ({ projection }) => {
      await projection.refreshProjection(identity, true);
      await Promise.allSettled(projection.pendingRefreshes());
      projection.clear();
      const state = projection.forTesting();
      expect(state.projectionCache.size).toBe(0);
      expect(state.projectionEpochs.size).toBe(0);
      expect(state.toolDetailCacheBytes()).toBe(0);
      expect(
        projection.cachedProjectionSnapshot(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        ),
      ).toBeNull();
    });
  });
});
