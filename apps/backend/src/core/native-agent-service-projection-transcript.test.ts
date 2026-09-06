/**
 * What a projection puts in front of a reader: the windowed transcript, its
 * byte bounds, expandable tool details, and background-task cards.
 */
import { describe, expect, test } from "bun:test";

import { NATIVE_PROJECTION_MAX_BYTES } from "./native-agent-service.js";

import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

describe("NativeAgentService transcript projection", () => {
  test("orders resumable sessions by most recent activity", async () => {
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    (stub.provider as { listResumableSessions?: unknown }).listResumableSessions = async () => [
      { sessionId: "older", updatedAt: "2026-08-01T00:00:00.000Z" },
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
          agent: "claude" as const,
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
