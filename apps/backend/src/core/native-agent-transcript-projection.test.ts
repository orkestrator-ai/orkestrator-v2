import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeAgentSessionResumeIdentity } from "./models.js";
import { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import {
  addEnvironment,
  createProviderStub,
  createStorage,
} from "./native-agent-service-projection-test-support.js";
import {
  nativeAgentSessionStorageKey,
  NATIVE_HISTORY_CACHE_MAX_BYTES,
  type CommandInvoker,
  type NativeAgentRuntimeProvider,
  type NativeAgentProjectionInput,
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
  projectionIdentity: NativeAgentProjectionInput = identity,
  options: NativeAgentTranscriptProjectionHost["options"] = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-transcript-projection-"));
  const storage = await createStorage(dataDir);
  await addEnvironment(storage);
  const projectionSessionKey = nativeAgentSessionStorageKey(
    projectionIdentity.environmentId,
    projectionIdentity.agent,
    projectionIdentity.logicalSessionKey,
  );
  await storage.getOrCreateNativeAgentSession(
    {
      key: projectionSessionKey,
      ...projectionIdentity,
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
    options,
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
  test("history capacity eviction clears only the evicted session's direct-history gap", async () => {
    const stub = createProviderStub("opencode");
    await withProjection(stub.provider, async ({ projection }) => {
      const state = projection.forTesting();
      state.updateProjectionHistory(
        sessionKey,
        "provider-session",
        [textMessage("m0", "old")],
        0,
        true,
      );
      state.directHistoryGaps.set(sessionKey, "unpaged-source");
      const otherKey = `${sessionKey}:other`;
      state.directHistoryGaps.set(otherKey, "unnamed-cursor");
      // A single oversized retained history is allowed, but it evicts older entries.
      state.updateProjectionHistory(
        otherKey,
        "other-session",
        ["x".repeat(NATIVE_HISTORY_CACHE_MAX_BYTES)],
        0,
        true,
      );
      expect(state.projectionHistory.has(sessionKey)).toBe(false);
      expect(state.directHistoryGaps.has(sessionKey)).toBe(false);
      expect(state.projectionHistory.has(otherKey)).toBe(true);
      expect(state.directHistoryGaps.get(otherKey)).toBe("unnamed-cursor");
    });
  });

  test("a missing sync-v1 session clears its retained history and direct-history gap", async () => {
    const stub = createProviderStub("opencode", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [textMessage("m0", "old")] }),
    });
    await withProjection(stub.provider, async ({ projection, host }) => {
      const input = { ...identity, representation: "sync-v1" as const };
      await projection.refreshProjection(input, true);
      const state = projection.forTesting();
      expect(state.projectionHistory.has(sessionKey)).toBe(true);
      state.directHistoryGaps.set(sessionKey, "unpaged-source");
      state.directHistoryGaps.set("unrelated-session", "unnamed-cursor");
      host.resolveProjectionSession = async () => null;
      expect(await projection.refreshProjection(input, true)).toBeNull();
      expect(state.projectionHistory.has(sessionKey)).toBe(false);
      expect(state.directHistoryGaps.has(sessionKey)).toBe(false);
      expect(state.directHistoryGaps.get("unrelated-session")).toBe("unnamed-cursor");
    });
  });

  test.each([undefined, "sync-v1"] as const)(
    "a late generated title cannot change a replacement conversation's cached title or revision (%s)",
    async (representation) => {
      const readIdentity = { ...identity, ...(representation ? { representation } : {}) };
      let resolveTitle!: (value: { title: string; strategy: "codex" }) => void;
      const generated = new Promise<{ title: string; strategy: "codex" }>((resolve) => {
        resolveTitle = resolve;
      });
      const generate = mock(() => generated);
      const stub = createProviderStub("opencode", {
        interactiveSnapshot: async (sessionId) => ({
          status: "idle",
          ...(sessionId === "replacement-session" ? { title: "Replacement title" } : {}),
          messages: [{ ...textMessage("u1", "Original request"), role: "user" }],
        }),
      });
      await withProjection(
        stub.provider,
        async ({ projection, storage }) => {
          try {
            await projection.refreshProjection(readIdentity, true);
            expect(generate).toHaveBeenCalledTimes(1);
            await storage.adoptNativeAgentSession({
              key: sessionKey,
              ...identity,
              providerSessionId: "replacement-session",
              expectedProviderSessionId: "provider-session",
            });
            const replacement = await projection.refreshProjection(readIdentity, true);
            expect(replacement?.sessionId).toBe("replacement-session");
            const revision = replacement?.revision;
            const title = replacement?.title;
            resolveTitle({ title: "Stale generated title", strategy: "codex" });
            await Promise.allSettled(projection.pendingRefreshes());
            const cached = projection.cachedProjectionSnapshot(
              identity.environmentId,
              identity.agent,
              identity.logicalSessionKey,
            );
            expect(cached?.sessionId).toBe("replacement-session");
            expect(cached?.title).toBe(title);
            expect(cached?.revision).toBe(revision);
          } finally {
            resolveTitle({ title: "Stale generated title", strategy: "codex" });
          }
        },
        identity,
        { sessionTitles: { generate, shutdown: async () => {} } },
      );
    },
  );

  test("defers a replayed Claude user image and resolves its original bytes", async () => {
    const claudeIdentity = { ...identity, agent: "claude" as const };
    const fileUrl = "data:image/png;base64,iVBORw0KGgo=";
    const image = {
      type: "image",
      content: "image-1.png",
      fileUrl,
      imageSource: "attachment",
    };
    const stub = createProviderStub("claude", {
      messages: async () => [
        {
          id: "claude-user-image",
          role: "user",
          content: "",
          parts: [image],
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    await withProjection(
      stub.provider,
      async ({ projection }) => {
        const projected = await projection.refreshProjection(claudeIdentity, true);
        const messages = projected?.messages as Array<{
          id: string;
          role: string;
          parts: Array<Record<string, unknown>>;
        }>;
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ id: "claude-user-image", role: "user" });
        expect(messages[0]?.parts).toEqual([
          {
            type: "image",
            content: "image-1.png",
            imageSource: "attachment",
            detailRef: expect.any(String),
          },
        ]);
        expect(JSON.stringify(projected)).not.toContain(fileUrl);
        const detailRef = messages[0]!.parts[0]!.detailRef as string;
        expect(await projection.getProjectionToolDetails({ ...claudeIdentity, detailRef })).toEqual(
          {
            detailRef,
            fileDataUrl: fileUrl,
          },
        );
        expect(image.fileUrl).toBe(fileUrl);
      },
      claudeIdentity,
    );
  });

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

  test.each([undefined, "thread-kept"])(
    "a missing snapshot cannot create or overwrite the stored identity (%s)",
    async (stored) => {
      const stub = createProviderStub("opencode", {
        interactiveSnapshot: async () => ({
          status: "missing",
          messages: [],
          resumableSessionId: "thread-unverified",
        }),
        sessionStateSnapshot: async () => ({
          status: "missing",
          resumableSessionId: "thread-unverified",
        }),
      });
      await withProjection(stub.provider, async ({ projection, storage }) => {
        if (stored)
          await storage.recordNativeAgentSessionResumeIdentity(
            sessionKey,
            "provider-session",
            stored,
          );
        const before = await storage.getNativeAgentSession(sessionKey);
        await projection.refreshProjection(identity, true);
        await projection.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        const after = await storage.getNativeAgentSession(sessionKey);
        expect(after && nativeAgentSessionResumeIdentity(after)).toBe(stored);
        expect(after).toEqual(before);
      });
    },
  );

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

describe("permission rules on projection reads", () => {
  test.each(["covered", "unmatched", "transient", "failure"] as const)(
    "%s pending interaction read",
    async (scenario) => {
      const { INTERACTIVE_AGENT_INTERACTION_POLICY, AGENT_INTERACTION_CONTRACT_VERSION: version } =
        await import("@orkestrator/protocol/agent-interactions");
      const { PermissionRuleEnforcer } = await import("./permission-rules/enforcer.js");
      const request = {
        version,
        id: "permission-read",
        provider: "opencode" as const,
        kind: "command-approval" as const,
        origin: "interactive-native" as const,
        sessionId: "provider-session",
        state: "pending" as const,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        presentation: { title: "Run", questions: [] },
      };
      let pending = [request];
      const resolve = mock(async () => {
        pending = [];
        return {
          result: "applied" as const,
          interactionId: request.id,
          sessionId: request.sessionId,
          revision: 2,
        };
      });
      const stub = createProviderStub("opencode", {
        interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
        interactions: {
          listPendingInteractions: async () => ({ version, revision: 1, requests: pending }),
          resolveInteraction: resolve,
          permissionRuleDetail: () => ({
            subject: {
              kind: "command",
              command: scenario === "unmatched" ? "npm publish" : "npm test",
            },
            allowOnceAnswers: [],
          }),
        },
      });
      await withProjection(stub.provider, async ({ projection, storage, host }) => {
        const originalResolve = host.resolveProjectionSession;
        host.resolveProjectionSession = async (input) => {
          const resolved = await originalResolve(input);
          return resolved
            ? {
                ...resolved,
                transient: false,
                session: {
                  ...resolved.session,
                  origin: "interactive-native",
                  interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
                  policy: {
                    id: "interactive-host",
                    sandbox: "none",
                    approvals: "ask",
                    projectResources: true,
                    networkAccess: "full",
                  },
                },
              }
            : null;
        };
        host.permissionRules = new PermissionRuleEnforcer({
          store: () => storage.permissionRuleStore(),
          getEnvironment: (id) => storage.getEnvironment(id),
          now: () => 10_000,
        });
        const environment = await storage.getEnvironment(identity.environmentId);
        storage.permissionRuleStore().create({
          id: "projection-rule",
          provider: "opencode",
          scope: "project",
          projectId: environment!.projectId,
          kind: "command-prefix",
          pattern: "npm test",
          createdAt: 1,
          createdFrom: {
            environmentId: identity.environmentId,
            agent: "opencode",
            interactionId: "origin",
          },
          useCount: 0,
        });
        const originalApply = host.permissionRules.apply.bind(host.permissionRules);
        const apply = mock(
          scenario === "failure"
            ? async () => {
                throw new Error("unavailable");
              }
            : originalApply,
        );
        host.permissionRules.apply = apply;
        const resolved = await host.resolveProjectionSession(identity);
        const result = await projection.refreshProjection(
          identity,
          true,
          scenario === "transient" && resolved ? { ...resolved, transient: true } : undefined,
        );
        expect(result?.interactions).toHaveLength(scenario === "covered" ? 0 : 1);
        expect(resolve).toHaveBeenCalledTimes(scenario === "covered" ? 1 : 0);
        if (scenario === "transient") expect(apply).not.toHaveBeenCalled();
        if (scenario === "failure" || scenario === "transient")
          expect(result?.interactions?.[0]).toEqual(request);
        if (scenario === "unmatched")
          expect(result?.interactions?.[0]?.presentation.ruleOffer?.patterns).toEqual([
            "npm publish",
          ]);
        expect(storage.permissionRuleStore().listApplications()).toHaveLength(
          scenario === "covered" ? 1 : 0,
        );
      });
    },
  );
});
