/**
 * What a projection puts in front of a reader: the windowed transcript, its
 * byte bounds, expandable tool details, and background-task cards.
 */
import { describe, expect, mock, test } from "bun:test";

import { nativeAsyncQuestionRequestId } from "@orkestrator/protocol/native-agent";

import {
  NATIVE_FILE_DETAIL_MAX_BYTES,
  NATIVE_PROJECTION_MAX_BYTES,
  nativeAgentSessionStorageKey,
} from "./native-agent-service.js";

import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

describe("NativeAgentService transcript projection", () => {
  test("persists async-question attention once and projects a queued response", async () => {
    const itemId = "question/item-1";
    const requestId = nativeAsyncQuestionRequestId(itemId);
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "Which target?",
        parts: [
          {
            type: "async-question",
            content: "Which target?",
            asyncQuestion: {
              itemId,
              questions: [{ id: `${itemId}:0`, title: "Which target?", options: ["Staging"] }],
            },
          },
        ],
        createdAt: "2026-08-15T10:00:00.000Z",
      },
    ];
    const attention = mock(() => undefined);
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "running", messages }),
    });

    await withService(
      {
        prefix: "orkestrator-native-async-question-",
        provider: async () => stub.provider,
        onAsyncQuestionAttention: attention,
      },
      async ({ storage, service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-question",
        };
        await service.ensureSession(identity);
        await storage.savePromptQueue("codex\0env-env-1:tab-question", "env-1", [
          { id: requestId, text: "Answers to your questions:\n\n- Which target?: Staging" },
        ]);

        const projection = await service.getProjection(identity);
        expect(projection?.asyncQuestionResponses).toEqual([
          { itemId, requestId, state: "queued" },
        ]);
        expect(attention).toHaveBeenCalledTimes(1);
        expect((await storage.getEnvironment("env-1"))?.hasUnreadWork).toBe(true);

        await storage.setEnvironmentUnread("env-1", false);
        await service.getProjection(identity);
        expect(attention).toHaveBeenCalledTimes(1);
        expect((await storage.getEnvironment("env-1"))?.hasUnreadWork).toBe(false);
      },
    );
  });

  test("rehydrates a sent async-question response from the dispatch journal", async () => {
    const itemId = "question-2";
    const requestId = nativeAsyncQuestionRequestId(itemId);
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    await withService(
      {
        prefix: "orkestrator-native-async-answer-",
        provider: async () => stub.provider,
      },
      async ({ storage, service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-answer",
        };
        await service.ensureSession(identity);
        await storage.dispatchNativeAgentPromptOnce(
          nativeAgentSessionStorageKey("env-1", "codex", identity.logicalSessionKey),
          requestId,
          async () => undefined,
        );

        const projection = await service.getProjection(identity);
        expect(projection?.asyncQuestionResponses).toEqual([{ itemId, requestId, state: "sent" }]);
      },
    );
  });

  test("prefers durable sent state over simultaneous failed and queued state", async () => {
    const itemId = "question-priority";
    const requestId = nativeAsyncQuestionRequestId(itemId);
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    await withService(
      {
        prefix: "orkestrator-native-async-answer-priority-",
        provider: async () => stub.provider,
      },
      async ({ storage, service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-answer-priority",
        };
        await service.ensureSession(identity);
        await storage.dispatchNativeAgentPromptOnce(
          nativeAgentSessionStorageKey("env-1", "codex", identity.logicalSessionKey),
          requestId,
          async () => undefined,
        );
        const queueKey = `codex\0${identity.logicalSessionKey}`;
        await storage.savePromptQueue(queueKey, "env-1", [{ id: requestId, text: "Answer once" }]);
        const reservation = await storage.reservePromptQueueHeadForDispatch(queueKey);
        expect(reservation?.requestId).toBe(requestId);
        await storage.failPromptQueueDispatch(queueKey, requestId, "temporary failure");

        const projection = await service.getProjection(identity);
        expect(projection?.asyncQuestionResponses).toEqual([{ itemId, requestId, state: "sent" }]);
      },
    );
  });

  test("returns the transcript when attention persistence fails", async () => {
    const messages = [
      {
        id: "assistant-attention-failure",
        role: "assistant" as const,
        content: "Question",
        parts: [
          {
            type: "async-question",
            content: "Question",
            asyncQuestion: {
              itemId: "question-attention-failure",
              questions: [{ id: "question-attention-failure:0", title: "Proceed?", options: [] }],
            },
          },
        ],
        createdAt: "2026-09-06T10:00:00.000Z",
      },
    ];
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService(
      {
        prefix: "orkestrator-native-attention-read-failure-",
        provider: async () => stub.provider,
      },
      async ({ storage, service }) => {
        const original = storage.recordEnvironmentAgentAttention.bind(storage);
        const warn = console.warn;
        storage.recordEnvironmentAgentAttention = async () => {
          throw new Error("disk unavailable");
        };
        console.warn = mock(() => undefined) as typeof console.warn;
        try {
          const identity = {
            environmentId: "env-1",
            agent: "codex" as const,
            logicalSessionKey: "env-env-1:tab-attention-failure",
          };
          await service.ensureSession(identity);
          const projection = await service.getProjection(identity);
          expect(projection?.messages).toHaveLength(1);
          expect(projection?.messages[0]).toMatchObject({ id: "assistant-attention-failure" });
        } finally {
          storage.recordEnvironmentAgentAttention = original;
          console.warn = warn;
        }
      },
    );
  });

  test("orders resumable sessions by most recent activity", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      sessionStateSnapshot: async () => ({
        status: "idle",
        resumableSessionId: "current-thread",
      }),
    });
    (stub.provider as { listResumableSessions?: unknown }).listResumableSessions = async () => [
      { sessionId: "older", updatedAt: "2026-08-01T00:00:00.000Z" },
      { sessionId: "current-thread", updatedAt: "2026-08-15T00:00:00.000Z" },
      { sessionId: "undated" },
      { sessionId: "newest", updatedAt: "2026-08-14T00:00:00.000Z", status: "running" as const },
    ];
    await withService(
      {
        prefix: "orkestrator-native-projection-resume-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-resume",
        };
        await service.ensureSession(identity);
        const entries = await service.listProjectionResumableSessions(identity);
        // Providers return their own order; the picker must not have to know
        // which field each provider sorts on. Undated entries sink.
        expect(entries.map((entry) => entry.sessionId)).toEqual(["newest", "older", "undated"]);
        expect(entries[0]?.status).toBe("running");
      },
    );
  });

  test("filters the stored provider session when no state snapshot is available", async () => {
    const stub = createProviderStub("codex");
    (stub.provider as { listResumableSessions?: unknown }).listResumableSessions = async () => [
      { sessionId: "provider-session" },
      { sessionId: "other-thread" },
    ];
    await withService(
      {
        prefix: "orkestrator-native-projection-resume-fallback-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-resume-fallback",
        };
        await service.ensureSession(identity);
        await expect(service.listProjectionResumableSessions(identity)).resolves.toEqual([
          { sessionId: "other-thread" },
        ]);
      },
    );
  });

  test("falls back to the stored provider session when state snapshot fails", async () => {
    const stub = createProviderStub("codex", {
      sessionStateSnapshot: async () => {
        throw new Error("status unavailable");
      },
    });
    (stub.provider as { listResumableSessions?: unknown }).listResumableSessions = async () => [
      { sessionId: "provider-session" },
      { sessionId: "other-thread" },
    ];
    await withService(
      {
        prefix: "orkestrator-native-projection-resume-status-failure-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-resume-status-failure",
        };
        await service.ensureSession(identity);
        const entries = await service.listProjectionResumableSessions(identity);
        expect(entries.map((entry) => entry.sessionId)).toEqual(["other-thread"]);
        expect(stub.sessionStateSnapshot).toHaveBeenCalledWith("provider-session");
      },
    );
  });

  test("filters an ACP-backed agent's external resumable identity", async () => {
    const externalSessionId = "acp-session:c2Vzc2lvbi0x.signature";
    const stub = createProviderStub("grok", {
      sessionStateSnapshot: async () => ({
        status: "idle",
        resumableSessionId: externalSessionId,
      }),
    });
    (stub.provider as { listResumableSessions?: unknown }).listResumableSessions = async () => [
      { sessionId: externalSessionId, title: "Current Grok conversation" },
      { sessionId: "acp-session:b3RoZXI.signature", title: "Other Grok conversation" },
    ];
    await withService(
      {
        prefix: "orkestrator-native-projection-resume-grok-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "grok" as const,
          logicalSessionKey: "env-env-1:tab-grok-resume",
        };
        await service.ensureSession(identity);
        const entries = await service.listProjectionResumableSessions(identity);
        expect(entries).toEqual([
          { sessionId: "acp-session:b3RoZXI.signature", title: "Other Grok conversation" },
        ]);
      },
    );
  });

  test("windows a long transcript and reports that it was truncated", async () => {
    const messages = Array.from({ length: 600 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant" as const,
      content: `line ${index}`,
      parts: [],
      createdAt: "2026-08-14T10:00:00.000Z",
    }));
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService(
      {
        prefix: "orkestrator-native-projection-window-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:tab-window",
        };
        await service.ensureSession(identity);
        const bounded = await service.getProjection(identity);
        expect(bounded?.messages).toHaveLength(512);
        expect(bounded?.messageWindow).toEqual({
          limit: 512,
          truncated: true,
          truncationReason: "count",
          // The expanded read below proves it: the limit, not the byte
          // ceiling, is what is holding the other 88 messages back.
          canLoadEarlier: true,
        });

        const expanded = await service.getProjection({ ...identity, messageLimit: 1_024 });
        expect(expanded?.messages).toHaveLength(600);
        expect(expanded?.messageWindow).toEqual({ limit: 1_024, truncated: false });

        // A caller that asks for nothing — the reconciler, the info panel —
        // inherits the expanded window instead of collapsing the tab's view.
        const inherited = await service.getProjection(identity);
        expect(inherited?.messages).toHaveLength(600);
      },
    );
  });

  test("uses a byte-aware tail instead of failing an oversized projection", async () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant" as const,
      content: String(index).repeat(1024 * 1024),
      parts: [],
      createdAt: "2026-08-15T10:00:00.000Z",
    }));
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService(
      {
        prefix: "orkestrator-native-byte-window-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-byte-window",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.connection).toBe("connected");
        expect(projection?.messageWindow).toMatchObject({
          truncated: true,
          truncationReason: "bytes",
        });
        expect(Buffer.byteLength(JSON.stringify(projection?.messages))).toBeLessThanOrEqual(
          NATIVE_PROJECTION_MAX_BYTES,
        );
        expect(projection?.messages.length).toBeLessThan(messages.length);
        expect((projection?.messages.at(-1) as { id?: string })?.id).toBe("message-19");
      },
    );
  });

  test("reports a non-serializable transcript as an unavailable provider", async () => {
    // The bound measures with `JSON.stringify`, so a circular part surfaces
    // there. It is a transport violation, not something to hand a renderer.
    const circular: Record<string, unknown> = { type: "text", content: "loop" };
    circular.self = circular;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({
        status: "idle",
        messages: [
          {
            id: "assistant-1",
            role: "assistant" as const,
            content: "done",
            parts: [circular],
            createdAt: "2026-08-15T10:00:00.000Z",
          },
        ],
      }),
    });
    await withService(
      {
        prefix: "orkestrator-native-unserializable-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-unserializable",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.connection).toBe("error");
      },
    );
  });

  test("refuses a tool detail reference belonging to another session", async () => {
    // `detailRef` is a bearer token for transcript content. It is hashed with
    // the session key precisely so one tab cannot read another tab's output by
    // replaying a reference, and the lookup must enforce that rather than trust
    // the hash to be unguessable.
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "done",
        parts: [
          {
            type: "tool-invocation",
            content: "cat secrets.txt",
            toolName: "bash",
            toolState: "success",
            toolOutput: "the other tab's output",
          },
        ],
        createdAt: "2026-08-15T10:00:00.000Z",
      },
    ];
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService(
      {
        prefix: "orkestrator-native-detail-scope-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const owner = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-owner",
        };
        const other = { ...owner, logicalSessionKey: "env-env-1:tab-other" };
        await service.ensureSession(owner);
        await service.ensureSession(other);
        const projection = await service.getProjection(owner);
        const detailRef = (
          projection!.messages[0] as {
            parts: Array<{ detailRef?: string }>;
          }
        ).parts[0]?.detailRef;
        expect(detailRef).toBeString();

        // The owning tab reads it back.
        expect(
          await service.getProjectionToolDetails({ ...owner, detailRef: detailRef! }),
        ).toMatchObject({ toolOutput: "the other tab's output" });
        // A different logical session presenting the same reference does not.
        await expect(
          service.getProjectionToolDetails({ ...other, detailRef: detailRef! }),
        ).rejects.toThrow("no longer available");
      },
    );
  });

  test("preserves a bounded background-task id when launch output is deferred", async () => {
    const messages = [
      {
        id: "assistant-background",
        role: "assistant" as const,
        content: "",
        parts: [
          {
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
            toolState: "success",
            toolArgs: { command: "bun test", run_in_background: true },
            toolOutput:
              "Command running in background with ID: bg-suite. Output is being written elsewhere.",
          },
          {
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
            toolState: "success",
            toolArgs: { command: "bun run dev", run_in_background: true },
            toolOutput: `Command running in background with ID: ${"x".repeat(513)}.`,
          },
        ],
        createdAt: "2026-08-15T10:00:00.000Z",
      },
    ];
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });

    await withService(
      {
        prefix: "orkestrator-native-background-correlation-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:tab-background",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        const parts = (
          projection!.messages[0] as {
            parts: Array<{
              backgroundTaskId?: string;
              detailRef?: string;
              toolOutput?: string;
            }>;
          }
        ).parts;
        const part = parts[0];

        expect(part).toMatchObject({
          backgroundTaskId: "bg-suite",
          detailRef: expect.any(String),
        });
        expect(part?.toolOutput).toBeUndefined();
        expect(parts[1]?.backgroundTaskId).toBeUndefined();
      },
    );
  });

  test("recovers a launch id a command was backgrounded into after it started", async () => {
    /*
     * Ctrl+B and a foreground timeout both background a command that was
     * launched without `run_in_background`, so the argument cannot decide this.
     * Since the projection strips every `toolOutput`, refusing to scan these
     * rows would leave the renderer with no way to reach the id at all.
     */
    const messages = [
      {
        id: "assistant-backgrounded",
        role: "assistant" as const,
        content: "",
        parts: [
          {
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
            toolState: "success",
            toolArgs: { command: "bun run dev" },
            toolOutput: "Command was manually backgrounded by user with ID: bg-dev",
          },
          {
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
            toolState: "success",
            toolArgs: { command: "bun run build" },
            toolOutput:
              "Command exceeded its timeout and was moved to the background (ID: bg-build). Use BashOutput.",
          },
          {
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
            toolState: "success",
            toolArgs: { command: "bun test" },
            toolOutput: '{"task_id":"bg-json"}',
          },
          {
            // Reading a file that quotes the note is not a launch. Decorating it
            // would put a stop control on an id naming somebody else's work.
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
            toolState: "success",
            toolArgs: { file_path: "/repo/native-message-adapters.ts" },
            toolOutput: "Command running in background with ID: bg-suite. …",
          },
        ],
        createdAt: "2026-08-15T10:00:00.000Z",
      },
    ];
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });

    await withService(
      {
        prefix: "orkestrator-native-background-late-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:tab-late-background",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        const parts = (
          projection!.messages[0] as {
            parts: Array<{ backgroundTaskId?: string }>;
          }
        ).parts;

        expect(parts.map((part) => part.backgroundTaskId)).toEqual([
          "bg-dev",
          "bg-build",
          "bg-json",
          undefined,
        ]);
      },
    );
  });

  test("rejects a blank or oversized tool detail reference", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    await withService(
      {
        prefix: "orkestrator-native-detail-validation-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-validation",
        };
        await service.ensureSession(identity);

        await expect(
          service.getProjectionToolDetails({ ...identity, detailRef: "   " }),
        ).rejects.toThrow("invalid");
        await expect(
          service.getProjectionToolDetails({ ...identity, detailRef: "a".repeat(129) }),
        ).rejects.toThrow("invalid");
      },
    );
  });

  test("re-reads the provider when a cached tool detail was evicted", async () => {
    // The detail cache is bounded and shared across every session, so a busy
    // host will evict entries the renderer still has references to. Expanding
    // that row must recover from the authoritative provider snapshot rather
    // than report the output as lost.
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "done",
        parts: [
          {
            type: "tool-invocation",
            content: "bun test",
            toolName: "bash",
            toolState: "success",
            toolOutput: "recovered after eviction",
          },
        ],
        createdAt: "2026-08-15T10:00:00.000Z",
      },
    ];
    let snapshots = 0;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => {
        snapshots += 1;
        return { status: "idle", messages };
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-detail-eviction-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-eviction",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        const detailRef = (
          projection!.messages[0] as {
            parts: Array<{ detailRef?: string }>;
          }
        ).parts[0]?.detailRef;
        expect(detailRef).toBeString();

        // Simulate capacity eviction of exactly this entry.
        (
          service as unknown as {
            toolDetailCache: Map<string, unknown>;
            toolDetailCacheBytes: number;
          }
        ).toolDetailCache.clear();
        (service as unknown as { toolDetailCacheBytes: number }).toolDetailCacheBytes = 0;
        const snapshotsBefore = snapshots;

        expect(
          await service.getProjectionToolDetails({ ...identity, detailRef: detailRef! }),
        ).toMatchObject({ toolOutput: "recovered after eviction" });
        expect(snapshots).toBeGreaterThan(snapshotsBefore);
      },
    );
  });

  test("re-reads the provider when a deferred image detail was evicted", async () => {
    // A pasted attachment has no readable path, so its bytes live only behind
    // the detail reference. If the bounded cache drops that entry, opening the
    // image again must rebuild it from the provider rather than report the
    // picture as lost.
    const messages = [
      {
        id: "assistant-image",
        role: "assistant" as const,
        content: "done",
        parts: [
          {
            type: "image",
            content: "clipboard.png",
            filename: "clipboard.png",
            imageSource: "attachment" as const,
            fileUrl: "data:image/png;base64,deferred-image-bytes",
          },
        ],
        createdAt: "2026-08-15T10:00:00.000Z",
      },
    ];
    let snapshots = 0;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => {
        snapshots += 1;
        return { status: "idle", messages };
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-image-detail-eviction-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-image-eviction",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        const detailRef = (projection!.messages[0] as { parts: Array<{ detailRef?: string }> })
          .parts[0]?.detailRef;
        expect(detailRef).toBeString();

        // Simulate capacity eviction of exactly this entry.
        (
          service as unknown as {
            toolDetailCache: Map<string, unknown>;
            toolDetailCacheBytes: number;
          }
        ).toolDetailCache.clear();
        (service as unknown as { toolDetailCacheBytes: number }).toolDetailCacheBytes = 0;
        const snapshotsBefore = snapshots;

        expect(
          await service.getProjectionToolDetails({ ...identity, detailRef: detailRef! }),
        ).toMatchObject({ fileDataUrl: "data:image/png;base64,deferred-image-bytes" });
        expect(snapshots).toBeGreaterThan(snapshotsBefore);
      },
    );
  });

  test("keeps an image inline when it is too large to defer", async () => {
    // Above the detail ceiling there is nowhere to move the bytes, so the inline
    // copy is kept rather than deferring to a cache-limit error stub.
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    await withService(
      {
        prefix: "orkestrator-native-image-over-ceiling-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const inlineFileUrl = `data:image/png;base64,${"c".repeat(NATIVE_FILE_DETAIL_MAX_BYTES)}`;
        const projected = (
          service as unknown as {
            projectionPart(
              sessionKey: string,
              messageId: string,
              raw: unknown,
              partPath: string,
            ): Record<string, unknown>;
          }
        ).projectionPart(
          "session",
          "message",
          { type: "image", content: "enormous.png", fileUrl: inlineFileUrl },
          "0",
        );
        expect(projected.fileUrl).toBe(inlineFileUrl);
        expect(projected.detailRef).toBeUndefined();
      },
    );
  });

  test("pins a requested visible detail while capacity recovery rebuilds the cache", async () => {
    const messages = [
      {
        id: "assistant-capacity",
        role: "assistant" as const,
        content: "done",
        parts: Array.from({ length: 3 }, (_, index) => ({
          type: "tool-invocation",
          content: `tool-${index}`,
          toolName: "bash",
          toolState: "success" as const,
          toolOutput: `${index}:${"x".repeat(1_200)}`,
        })),
        createdAt: "2026-08-15T10:00:00.000Z",
      },
    ];
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService(
      {
        prefix: "orkestrator-native-detail-capacity-",
        provider: async () => stub.provider,
        toolDetailCacheMaxBytes: 2_700,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-capacity",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        const refs = (
          projection!.messages[0] as {
            parts: Array<{ detailRef?: string }>;
          }
        ).parts.map((part) => part.detailRef!);
        const cache = (
          service as unknown as {
            toolDetailCache: Map<string, unknown>;
          }
        ).toolDetailCache;
        expect(cache.has(refs[0]!)).toBe(false);

        await expect(
          service.getProjectionToolDetails({
            ...identity,
            detailRef: refs[0]!,
          }),
        ).resolves.toMatchObject({ toolOutput: expect.stringMatching(/^0:/) });
      },
    );
  });

  test("replaces tool details that exceed the deferred display limit", async () => {
    // The per-entry cap is a memory bound on the detail cache. Exceeding it
    // must degrade to an explicit notice, never to a silent empty expansion.
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "done",
        parts: [
          {
            type: "tool-invocation",
            content: "bun run build",
            toolName: "bash",
            toolState: "success",
            toolOutput: "x".repeat(5 * 1024 * 1024),
          },
        ],
        createdAt: "2026-08-15T10:00:00.000Z",
      },
    ];
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "idle", messages }),
    });
    await withService(
      {
        prefix: "orkestrator-native-detail-limit-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-detail-limit",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        const detailRef = (
          projection!.messages[0] as {
            parts: Array<{ detailRef?: string }>;
          }
        ).parts[0]?.detailRef;

        const details = await service.getProjectionToolDetails({
          ...identity,
          detailRef: detailRef!,
        });
        expect(details.toolOutput).toBeUndefined();
        expect(details.toolError).toBe("Tool details exceeded the deferred display limit.");
      },
    );
  });
});
