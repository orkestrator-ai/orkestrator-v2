import { describe, expect, mock, test } from "bun:test";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import {
  createProviderStub,
  internals,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;

describe("native agent progressive remainder", () => {
  test("keeps provider-trimmed history reachable when the preview fits the backend window", async () => {
    const prompt = {
      id: "prompt",
      role: "user",
      content: "Original request",
      parts: [],
      createdAt: "2026-09-09T00:00:00.000Z",
    };
    const response = {
      id: "response",
      role: "assistant",
      content: "Latest update",
      parts: [{ type: "text", text: "Earlier response activity" }],
      createdAt: "2026-09-09T00:01:00.000Z",
    };
    // Codex has already trimmed the prompt and older response parts to fit
    // its preview. The surviving message needs no further backend trimming.
    const stub = createProviderStub("codex", {
      transcriptSnapshot: async () => ({
        messages: [{ ...response, parts: [] }],
        complete: false,
        freshness: "current",
      }),
      messages: async () => [prompt, response],
    });
    await withService(
      { prefix: "orkestrator-progressive-trimmed-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:progressive-trimmed",
        };
        await service.ensureSession(identity);
        const preview = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(preview.status).toBe("snapshot");
        if (preview.status !== "snapshot") throw new Error("expected snapshot");
        expect(preview.value.messages).toHaveLength(1);
        expect(preview.value.historyComplete).toBe(false);
        // The tab gates its recovery header on truncated, not canLoadEarlier.
        expect(preview.value.messageWindow).toMatchObject({
          truncated: true,
          canLoadEarlier: true,
        });
        // No local byte/count cut occurred; don't invent a truncation reason.
        expect(preview.value.messageWindow?.truncationReason).toBeUndefined();

        // This is the authoritative read used by "Load earlier messages".
        const recovered = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        expect(recovered.status).toBe("snapshot");
        if (recovered.status !== "snapshot") throw new Error("expected snapshot");
        expect(recovered.projection.messages).toMatchObject([prompt, response]);
        expect(recovered.historyComplete).toBe(true);
      },
    );
  });

  test("shares one legacy interactive snapshot between transcript and state", async () => {
    const interactiveSnapshot = mock(async () => ({
      status: "idle" as const,
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "shared",
          parts: [],
          createdAt: "2026-09-09T00:00:00.000Z",
        },
      ],
    }));
    const stub = createProviderStub("cursor", { interactiveSnapshot });
    await withService(
      { prefix: "orkestrator-progressive-share-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-share",
        };
        await service.ensureSession(identity);
        const [transcript, state] = await Promise.all([
          service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow,
          }),
          service.getSessionStateUpdate({ ...identity, viewVersion: 1 }),
        ]);
        expect(transcript.status).toBe("snapshot");
        expect(state.status).toBe("snapshot");
        expect(interactiveSnapshot).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("schedules one trailing transcript read after an invalidation", async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transcriptSnapshot = mock(async () => {
      calls += 1;
      if (calls === 1) await firstHeld;
      return {
        messages: [
          {
            id: `m${calls}`,
            role: "assistant",
            content: `round-${calls}`,
            parts: [],
            createdAt: "2026-09-09T00:00:00.000Z",
          },
        ],
        complete: true,
        revision: calls,
        sourceToken: `source-${calls}`,
        freshness: "current" as const,
      };
    });
    const stub = createProviderStub("cursor", { transcriptSnapshot });
    await withService(
      { prefix: "orkestrator-progressive-trail-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-trail",
        };
        await service.ensureSession(identity);
        const first = service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        await waitForCondition(() => transcriptSnapshot.mock.calls.length === 1);
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        const before = internals(service).projectionEpochs.get(sessionKey) ?? 0;
        internals(service).invalidateProjection(sessionKey);
        const after = internals(service).projectionEpochs.get(sessionKey) ?? 0;
        expect(after).toBeGreaterThan(before);
        releaseFirst();
        const update = await first;
        expect(update.status).toBe("snapshot");
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        expect(transcriptSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(update.value.messages[0]).toMatchObject({ content: "round-2" });
      },
    );
  });

  test("persists a display tail and serves it after a memory-cache miss", async () => {
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "preview",
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
    await withService(
      { prefix: "orkestrator-progressive-persist-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-persist",
        };
        await service.ensureSession(identity);
        const first = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(first.status).toBe("snapshot");
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        await internals(service).flushDisplayTailPersist(sessionKey);
        const persisted = await storage.getNativeAgentDisplayTail(sessionKey);
        expect(persisted?.messages).toHaveLength(1);
        internals(service).progressiveTranscriptCache.clear();
        const cached = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(cached.status).toBe("snapshot");
        if (cached.status !== "snapshot") throw new Error("expected snapshot");
        expect(cached.value.freshness).toBe("cached");
        expect(cached.value.messages[0]).toMatchObject({ content: "preview" });
      },
    );
  });

  test("returns a transcript delta when only an older message changes", async () => {
    let revision = 1;
    const transcriptSnapshot = mock(async () => ({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: revision === 1 ? "running" : "done",
          parts: [],
          createdAt: "2026-09-09T00:00:00.000Z",
        },
      ],
      complete: true,
      revision,
      sourceToken: `source-${revision}`,
      freshness: "current" as const,
    }));
    const stub = createProviderStub("cursor", { transcriptSnapshot });
    await withService(
      { prefix: "orkestrator-progressive-delta-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-delta",
        };
        await service.ensureSession(identity);
        const first = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(first.status).toBe("snapshot");
        if (first.status !== "snapshot") throw new Error("expected snapshot");
        revision = 2;
        const second = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          knownToken: first.token,
        });
        expect(second.status).toBe("delta");
        if (second.status !== "delta") throw new Error("expected delta");
        expect(second.delta.messageUpserts).toHaveLength(1);
        expect(second.delta.messageUpserts[0]).toMatchObject({ content: "done" });
      },
    );
  });

  test("records transcript metrics without session identifiers", async () => {
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [],
        complete: true,
        revision: 1,
        sourceToken: "source-1",
        freshness: "current" as const,
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-metrics-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-metrics",
        };
        await service.ensureSession(identity);
        await service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        const samples = internals(service).progressiveMetrics.list() as Array<{
          domain: string;
          outcome: string;
        }>;
        expect(samples.some((sample) => sample.domain === "transcript")).toBe(true);
        expect(JSON.stringify(samples)).not.toContain(identity.logicalSessionKey);
      },
    );
  });

  test("held discovery does not delay a progressive transcript snapshot", async () => {
    const discoveryHeld = new Promise<never>(() => undefined);
    const slashCommands = mock(async () => discoveryHeld);
    const modelCatalog = mock(async () => discoveryHeld);
    const stub = createProviderStub("cursor", {
      slashCommands,
      modelCatalog,
      transcriptSnapshot: async () => ({
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "visible",
            parts: [],
            createdAt: "2026-09-09T00:00:00.000Z",
          },
        ],
        complete: true,
        revision: 1,
        sourceToken: "source-1",
        freshness: "current" as const,
      }),
      sessionStateSnapshot: async () => ({ status: "idle" as const }),
    });
    await withService(
      { prefix: "orkestrator-progressive-discovery-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-discovery",
        };
        await service.ensureSession(identity);
        void service.getDiscoveryUpdate({
          ...identity,
          viewVersion: 1,
          sections: ["models", "commands"],
        });
        const transcript = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        expect(transcript.status).toBe("snapshot");
        if (transcript.status !== "snapshot") throw new Error("expected snapshot");
        expect(transcript.value.messages[0]).toMatchObject({ content: "visible" });
      },
    );
  });
});

describe("native agent progressive failure and lifecycle", () => {
  test("reports an unavailable transcript rather than an absent session", async () => {
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => {
        throw new Error("bridge refused the transcript read");
      },
    });
    await withService(
      { prefix: "orkestrator-progressive-transcript-error-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-transcript-error",
        };
        await service.ensureSession(identity);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
        });
        // `missing` would tell the renderer the session is gone, which it would
        // act on by dropping the tab. A failed read is not that answer.
        expect(update.status).toBe("unavailable");
        if (update.status !== "unavailable") throw new Error("expected unavailable");
        expect(update.retryable).toBe(true);
        expect(update.error).toContain("bridge refused the transcript read");
      },
    );
  });

  test("keeps the cached identity when a session-state read fails", async () => {
    let failing = false;
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [],
        complete: true,
        revision: 1,
        freshness: "current" as const,
      }),
      sessionStateSnapshot: async () => {
        if (failing) throw new Error("status endpoint timed out");
        return { status: "idle" as const };
      },
    });
    await withService(
      { prefix: "orkestrator-progressive-state-error-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-state-error",
        };
        await service.ensureSession(identity);
        const first = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        expect(first.status).toBe("snapshot");
        failing = true;
        const second = await service.getSessionStateUpdate({
          ...identity,
          viewVersion: 1,
          forceSnapshot: true,
        });
        expect(second.status).toBe("unavailable");
        if (second.status !== "unavailable") throw new Error("expected unavailable");
        expect(second.retryable).toBe(true);
        expect(second.error).toContain("status endpoint timed out");
        // The identity is what lets the renderer tell "this session failed a
        // read" apart from "some other session answered".
        expect(second.identity?.logicalSessionKey).toBe(identity.logicalSessionKey);
      },
    );
  });

  test("reports a missing session once the provider has no session to read", async () => {
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => ({
        messages: [],
        complete: true,
        freshness: "current" as const,
      }),
    });
    await withService(
      { prefix: "orkestrator-progressive-missing-", provider: async () => stub.provider },
      async ({ service }) => {
        const update = await service.getTranscriptUpdate({
          environmentId: "env-1",
          agent: "cursor",
          logicalSessionKey: "env-env-1:never-created",
          viewVersion: 1,
          liveWindow,
        });
        expect(update.status).toBe("missing");
      },
    );
  });

  test("an invalidation during a discovery read leaves the epoch prunable", async () => {
    let releaseDiscovery!: () => void;
    const heldDiscovery = new Promise<null>((resolve) => {
      releaseDiscovery = () => resolve(null);
    });
    const stub = createProviderStub("cursor", {
      authStatus: async () => heldDiscovery as never,
      transcriptSnapshot: async () => ({
        messages: [],
        complete: true,
        freshness: "current" as const,
      }),
      sessionStateSnapshot: async () => ({ status: "idle" as const }),
    });
    await withService(
      { prefix: "orkestrator-progressive-prune-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-prune",
        };
        await service.ensureSession(identity);
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        await service.getDiscoveryUpdate({
          ...identity,
          viewVersion: 1,
          sections: ["auth"],
        });
        const view = internals(service);
        await waitForCondition(() =>
          Array.from(view.progressiveReads.keys()).some((key) => key.includes("discovery:")),
        );
        view.invalidateProjection(sessionKey);
        // Discovery has no trailing read that could ever consume a follow-up
        // marker, so marking it would pin this session's epoch forever.
        expect(
          Array.from(view.progressiveDirtyFollowUps.keys()).filter((key) =>
            key.includes("discovery:"),
          ),
        ).toEqual([]);
        releaseDiscovery();
        await waitForCondition(() => view.progressiveReads.size === 0);
        view.projectionCache.delete(sessionKey);
        view.projectionEpochs.set(sessionKey, 4);
        view.pruneProjectionEpoch(sessionKey);
        expect(view.projectionEpochs.has(sessionKey)).toBe(false);
      },
    );
  });

  test("clears the trailing follow-up marker even when a second read is needed", async () => {
    // Two invalidations, each landing while a read is in flight. The first
    // schedules the trailing read; the second lands inside it, which is the
    // only path that re-reads and used to return without clearing the marker.
    let calls = 0;
    const gates = new Map<number, () => void>();
    const held = (call: number) =>
      new Promise<void>((resolve) => {
        gates.set(call, resolve);
      });
    const holds = new Map<number, Promise<void>>([
      [1, held(1)],
      [2, held(2)],
    ]);
    const stub = createProviderStub("cursor", {
      transcriptSnapshot: async () => {
        calls += 1;
        await holds.get(calls);
        return {
          messages: [
            {
              id: `m${calls}`,
              role: "assistant",
              content: `round-${calls}`,
              parts: [],
              createdAt: "2026-09-09T00:00:00.000Z",
            },
          ],
          complete: true,
          revision: calls,
          freshness: "current" as const,
        };
      },
    });
    await withService(
      { prefix: "orkestrator-progressive-marker-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:progressive-marker",
        };
        await service.ensureSession(identity);
        const sessionKey = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        const view = internals(service);
        const inFlight = service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        await waitForCondition(() => calls === 1);
        view.invalidateProjection(sessionKey);
        gates.get(1)!();

        await waitForCondition(() => calls === 2);
        view.invalidateProjection(sessionKey);
        gates.get(2)!();

        await inFlight;
        await waitForCondition(() => view.progressiveTrailing.size === 0);
        expect(calls).toBeGreaterThanOrEqual(3);
        expect(Array.from(view.progressiveDirtyFollowUps.keys())).toEqual([]);
      },
    );
  });
});
