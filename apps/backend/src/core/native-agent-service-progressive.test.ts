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
