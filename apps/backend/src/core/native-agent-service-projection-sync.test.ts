/**
 * The remote synchronization surface: conditional tokens, bounded deltas, the
 * fixed live tail, and independently paged history.
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
  test("returns unchanged envelopes, bounded deltas, and independent history pages", async () => {
    let messages = Array.from({ length: 150 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `content-${index}`,
      parts: [{ type: "text", content: `content-${index}` }],
      createdAt: new Date(index * 1_000).toISOString(),
    }));
    messages[50] = { ...messages[50]!, id: `long-anchor-${"x".repeat(2_000)}` };
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
        expect(first.historyCursor).toBeString();
        expect(first.historyCursor!.length).toBeLessThan(1_024);

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

        const page = await service.getMessagePage({
          ...identity,
          syncVersion: 1,
          before: changed.historyCursor!,
        });
        expect(page.messages).toHaveLength(50);
        expect(page.nextCursor).toBeUndefined();
        expect(page.complete).toBe(true);
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

  test("anchors history at the first message actually sent in a byte-limited live tail", async () => {
    const messages = Array.from({ length: 130 }, (_, index) => ({
      id: `large-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${index}:${"x".repeat(12 * 1024)}`,
      parts: [{ type: "text", content: `${index}:${"x".repeat(12 * 1024)}` }],
      createdAt: new Date(index * 1_000).toISOString(),
    }));
    const stub = createProviderStub("cursor", {
      interactiveSnapshot: async () => ({ status: "idle", messages, messagesComplete: true }),
    });
    await withService(
      { prefix: "orkestrator-native-sync-bytes-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-sync-bytes",
        };
        await service.ensureSession(identity);
        const first = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
        });
        if (first.status !== "snapshot") throw new Error("Expected sync snapshot");
        expect(first.projection.messages.length).toBeLessThan(100);

        const collected = [...first.projection.messages];
        let cursor = first.historyCursor;
        while (cursor) {
          const page = await service.getMessagePage({
            ...identity,
            syncVersion: 1,
            before: cursor,
          });
          collected.unshift(...page.messages);
          cursor = page.nextCursor;
        }
        expect(new Set(collected.map((message) => (message as { id: string }).id)).size).toBe(130);
      },
    );
  });
});
