/**
 * The remote synchronization surface: conditional tokens, bounded deltas and
 * the fixed live tail. History pages come from the transcript view's direct
 * cursor; the sync-v1 projection names none (0232 task 4).
 */
import { describe, expect, mock, test } from "bun:test";

import { applyNativeAgentProjectionDelta } from "@orkestrator/protocol/native-agent";

import {
  NATIVE_SYNC_MAX_REVISIONS,
  NATIVE_SYNC_REVISION_TTL_MS,
  type NativeAgentRuntimeProvider,
} from "./native-agent-service.js";

import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

describe("native agent remote projection synchronization", () => {
  test("unsets a notice after an authoritative clean projection", async () => {
    let notices = [{ kind: "warning" as const, message: "Provider is using a fallback" }];
    const stub = createProviderStub("cursor", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [], notices }),
    });
    await withService(
      { prefix: "orkestrator-native-sync-notices-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-notices",
        };
        const liveWindow = { messages: 100, targetBytes: 512 * 1024 };
        await service.ensureSession(identity);
        const first = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow,
        });
        if (first.status !== "snapshot") throw new Error("Expected sync snapshot");
        expect(first.projection.notices).toEqual(notices);

        notices = [];
        const recovered = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow,
          knownToken: first.token,
        });
        if (recovered.status !== "delta") throw new Error("Expected sync delta");
        expect(recovered.delta.unsetFields).toContain("notices");
        expect(
          applyNativeAgentProjectionDelta(first.projection, recovered.delta),
        ).not.toHaveProperty("notices");
      },
    );
  });

  test("synchronizes runtime-health authority as an explicit projection field", async () => {
    let authoritative = false;
    const stub = createProviderStub("cursor", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [],
        runtimeHealthAuthoritative: authoritative,
      }),
    });
    await withService(
      { prefix: "orkestrator-native-sync-health-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-health",
        };
        await service.ensureSession(identity);
        const first = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
        });
        if (first.status !== "snapshot") throw new Error("Expected sync snapshot");
        expect(first.projection.runtimeHealthAuthoritative).toBe(false);

        authoritative = true;
        const changed = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
          knownToken: first.token,
        });
        if (changed.status !== "delta") throw new Error("Expected sync delta");
        expect(changed.delta.setFields.runtimeHealthAuthoritative).toBe(true);
        expect(
          applyNativeAgentProjectionDelta(first.projection, changed.delta)
            ?.runtimeHealthAuthoritative,
        ).toBe(true);
      },
    );
  });

  test("returns unchanged envelopes and bounded deltas", async () => {
    let messages = Array.from({ length: 150 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `content-${index}`,
      parts: [{ type: "text", content: `content-${index}` }],
      createdAt: new Date(index * 1_000).toISOString(),
    }));
    const stub = createProviderStub("cursor", {
      interactiveSnapshot: async () => ({
        status: "running",
        messages,
        messagesComplete: true,
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-sync-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-sync",
        };
        await service.ensureSession(identity);

        const first = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
        });
        expect(first.status).toBe("snapshot");
        if (first.status !== "snapshot") throw new Error("Expected sync snapshot");
        expect(first.projection.messages).toHaveLength(100);

        const unchanged = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
          knownToken: first.token,
        });
        expect(unchanged).toEqual({ syncVersion: 1, status: "unchanged", token: first.token });
        expect(Buffer.byteLength(JSON.stringify(unchanged))).toBeLessThan(1_024);

        const unknown = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
          knownToken: "unknown-token",
        });
        expect(unknown).toMatchObject({ status: "snapshot", resetReason: "unknown-token" });

        messages = messages.map((message, index) =>
          index === messages.length - 1
            ? { ...message, content: "streamed", parts: [{ type: "text", content: "streamed" }] }
            : message,
        );
        const changed = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
          knownToken: first.token,
        });
        expect(changed.status).toBe("delta");
        if (changed.status !== "delta") throw new Error("Expected sync delta");
        expect(changed.delta.messageUpserts).toHaveLength(1);
        expect(changed.delta.liveMessageIds).toBeUndefined();
        const fresh = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
          forceSnapshot: true,
        });
        if (fresh.status !== "snapshot") throw new Error("Expected forced snapshot");
        expect(applyNativeAgentProjectionDelta(first.projection, changed.delta)).toEqual(
          fresh.projection,
        );
      },
    );
  });

  test("draws legacy and sync revisions from one sequence per session", async () => {
    let messages = [{ id: "message-0", role: "user" as const, content: "first" }];
    const stub = createProviderStub("cursor", {
      interactiveSnapshot: async () => ({ status: "idle", messages, messagesComplete: true }),
    });
    await withService(
      { prefix: "orkestrator-native-sync-revision-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-revision",
        };
        await service.ensureSession(identity);

        // Poll the sync surface repeatedly, changing the transcript each time
        // so every read commits a new revision.
        let syncRevision = 0;
        for (let index = 0; index < 5; index += 1) {
          messages = [
            ...messages,
            { id: `message-${index + 1}`, role: "user", content: `${index}` },
          ];
          const update = await service.getProjectionUpdate({
            ...identity,
            syncVersion: 1,
            liveWindow: { messages: 100, targetBytes: 512 * 1024 },
            forceSnapshot: true,
          });
          if (update.status !== "snapshot") throw new Error("Expected sync snapshot");
          syncRevision = update.projection.revision;
        }
        expect(syncRevision).toBeGreaterThan(1);

        // A mutation answers on the legacy surface. The renderer compares its
        // revision against the sync one it already holds, so a separate counter
        // would hand back a projection the client discards as stale.
        messages = [...messages, { id: "message-stopped", role: "user", content: "stopped" }];
        const legacy = await service.getProjection(identity);
        const latestSync = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
          forceSnapshot: true,
        });
        if (latestSync.status !== "snapshot") throw new Error("Expected sync snapshot");
        // Same generation, so the renderer compares these revisions directly.
        expect(legacy!.generation).toBe(latestSync.projection.generation);
        expect(legacy!.revision).toBeGreaterThan(syncRevision);
        // And the sequence keeps moving forwards across the representations.
        expect(latestSync.projection.revision).toBeGreaterThan(legacy!.revision);
      },
    );
  });

  test("expires retained revisions so a stale token reconciles from a snapshot", async () => {
    let messages = [{ id: "message-0", role: "user" as const, content: "first" }];
    const stub = createProviderStub("cursor", {
      interactiveSnapshot: async () => ({ status: "idle", messages, messagesComplete: true }),
    });
    let clock = 1_000;
    await withService(
      {
        prefix: "orkestrator-native-sync-ttl-",
        provider: async () => stub.provider,
        now: () => clock,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-ttl",
        };
        await service.ensureSession(identity);
        const first = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
        });
        if (first.status !== "snapshot") throw new Error("Expected sync snapshot");

        // Past the retention window, the base this token names is gone.
        clock += NATIVE_SYNC_REVISION_TTL_MS + 1_000;
        messages = [...messages, { id: "message-1", role: "user", content: "second" }];
        const stale = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
          knownToken: first.token,
        });
        expect(stale.status).toBe("snapshot");
        if (stale.status !== "snapshot") throw new Error("Expected sync snapshot");
        expect(stale.resetReason).toBe("unknown-token");
      },
    );
  });

  test("evicts retained revisions past the per-session count bound", async () => {
    let messages = [{ id: "message-0", role: "user" as const, content: "first" }];
    const stub = createProviderStub("cursor", {
      interactiveSnapshot: async () => ({ status: "idle", messages, messagesComplete: true }),
    });
    await withService(
      { prefix: "orkestrator-native-sync-count-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-count",
        };
        await service.ensureSession(identity);
        const liveWindow = { messages: 100, targetBytes: 512 * 1024 };
        const first = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow,
        });
        if (first.status !== "snapshot") throw new Error("Expected sync snapshot");

        for (let index = 0; index < NATIVE_SYNC_MAX_REVISIONS + 4; index += 1) {
          messages = [{ id: "message-0", role: "user", content: `revision-${index}` }];
          await service.getProjectionUpdate({ ...identity, syncVersion: 1, liveWindow });
        }

        // The base the very first token names has aged out of the bounded ring,
        // so the client is reset rather than handed a delta over a projection
        // the backend no longer holds.
        const stale = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow,
          knownToken: first.token,
        });
        expect(stale.status).toBe("snapshot");
        if (stale.status !== "snapshot") throw new Error("Expected sync snapshot");
        expect(stale.resetReason).toBe("unknown-token");
      },
    );
  });

  test("resets a client whose session identity was replaced underneath it", async () => {
    let messages = [{ id: "message-0", role: "user" as const, content: "first" }];
    const stub = createProviderStub("cursor", {
      interactiveSnapshot: async () => ({ status: "idle", messages, messagesComplete: true }),
    });
    (stub.provider as NativeAgentRuntimeProvider).resumeSession = mock(
      async () => "provider-session-2",
    );
    await withService(
      { prefix: "orkestrator-native-sync-identity-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-identity",
        };
        await service.ensureSession(identity);
        const first = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
        });
        if (first.status !== "snapshot") throw new Error("Expected sync snapshot");

        await service.resumeProjectionSession({
          ...identity,
          providerSessionId: "provider-session-2",
        });
        messages = [...messages, { id: "message-1", role: "user", content: "second" }];

        const afterResume = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
          knownToken: first.token,
        });
        expect(afterResume.status).toBe("snapshot");
        if (afterResume.status !== "snapshot") throw new Error("Expected sync snapshot");
        /*
         * The client's token names a base built for the previous provider
         * session, so a delta over it would splice two conversations together.
         * A resume both drops the cached revisions and changes the recorded
         * identity, so either reset reason is correct; what must not happen is
         * a delta.
         */
        expect(afterResume.resetReason).toBeString();
        expect(["identity-changed", "unknown-token"]).toContain(afterResume.resetReason!);
      },
    );
  });

  test("a row that ages out of the live tail is not a deletion, and a removed row is", async () => {
    let messages = Array.from({ length: 150 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `content-${index}`,
      parts: [{ type: "text", content: `content-${index}` }],
      createdAt: new Date(index * 1_000).toISOString(),
    }));
    const stub = createProviderStub("cursor", {
      interactiveSnapshot: async () => ({ status: "idle", messages, messagesComplete: true }),
    });
    await withService(
      { prefix: "orkestrator-native-sync-deletions-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-sync-deletions",
        };
        const liveWindow = { messages: 100, targetBytes: 512 * 1024 };
        await service.ensureSession(identity);
        const first = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow,
        });
        if (first.status !== "snapshot") throw new Error("Expected sync snapshot");
        const firstIds = first.projection.messages.map((message) => (message as { id: string }).id);
        expect(firstIds[0]).toBe("message-50");

        // Two new rows push the two oldest out of the tail: still history.
        messages = [
          ...messages,
          ...[150, 151].map((index) => ({
            ...messages[0]!,
            id: `message-${index}`,
            content: `content-${index}`,
            parts: [{ type: "text", content: `content-${index}` }],
            createdAt: new Date(index * 1_000).toISOString(),
          })),
        ];
        const grown = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow,
          knownToken: first.token,
        });
        if (grown.status !== "delta") throw new Error("Expected sync delta");
        expect(grown.delta.deletedMessageIds).toEqual([]);
        expect(grown.delta.liveMessageIds?.[0]).toBe("message-52");
        const grownProjection = applyNativeAgentProjectionDelta(first.projection, grown.delta);
        expect(grownProjection?.messages).toHaveLength(100);

        // A row removed from inside the tail is an authoritative deletion.
        messages = messages.filter((message) => message.id !== "message-120");
        const removed = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow,
          knownToken: grown.token,
        });
        if (removed.status !== "delta") throw new Error("Expected sync delta");
        expect(removed.delta.deletedMessageIds).toEqual(["message-120"]);
      },
    );
  });
});
