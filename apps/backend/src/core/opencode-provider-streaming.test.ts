import { describe, expect, test } from "bun:test";
import {
  openCodeActivityProvider,
  openCodeFake,
  waitUntil,
} from "./agent-provider-test-support.js";
import type {
  ProviderInteractiveSnapshot,
  ProviderSessionStateSnapshot,
} from "./agent-provider-contract.js";
import { AmbiguousPromptDispatchError, PromptRejectedError } from "./native-agent-provider.js";
import { OpenCodeStreamState } from "./opencode-stream-state.js";

type SnapshotProvider = {
  interactiveSnapshot?(sessionId: string): Promise<ProviderInteractiveSnapshot>;
  sessionStateSnapshot?(sessionId: string): Promise<ProviderSessionStateSnapshot>;
};

async function waitForSnapshot(
  provider: SnapshotProvider,
  predicate: (
    snapshot: Awaited<ReturnType<NonNullable<SnapshotProvider["interactiveSnapshot"]>>>,
  ) => boolean,
) {
  let latest;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await provider.interactiveSnapshot?.("owned-session");
    if (latest && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for OpenCode projection");
}

async function waitForSessionState(
  provider: SnapshotProvider,
  predicate: (snapshot: ProviderSessionStateSnapshot) => boolean,
) {
  let latest;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await provider.sessionStateSnapshot?.("owned-session");
    if (latest && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for OpenCode session state");
}

function textMessage(text: string) {
  return {
    info: {
      id: "assistant-1",
      sessionID: "owned-session",
      role: "assistant",
      time: { created: 1_700_000_000_000 },
    },
    parts: [{ id: "part-1", messageID: "assistant-1", type: "text", text }],
  };
}

function indexedTextMessage(index: number) {
  return {
    info: {
      id: `assistant-${index}`,
      sessionID: "owned-session",
      role: "assistant",
      time: { created: 1_700_000_000_000 + index },
    },
    parts: [
      {
        id: `part-${index}`,
        messageID: `assistant-${index}`,
        type: "text",
        text: `message-${index}`,
      },
    ],
  };
}

describe("OpenCode provider v1 SSE projection", () => {
  test("publishes one stable backend clock for each running turn", async () => {
    const fake = openCodeFake();
    let now = 0;
    const provider = openCodeActivityProvider(fake, {
      now: () => now,
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(
        () =>
          fake.subscriptions.length === 1 &&
          fake.statusCallCount > 0 &&
          fake.messageCalls.length > 0,
      );
      const initial = await provider.sessionStateSnapshot?.("owned-session");
      expect(initial?.status).toBe("idle");

      // No renderer state read happens while the prompt starts. The provider
      // clock still begins at dispatch and survives until the tab returns.
      now = 1_000;
      await provider.send("owned-session", "Keep working", { requestId: "request-1" });
      const stream = fake.subscriptions[0]!;
      stream.push({
        type: "session.status",
        properties: { sessionID: "owned-session", status: { type: "busy" } },
      });
      now = 9_000;
      const first = await waitForSessionState(
        provider,
        (snapshot) => snapshot.status === "running",
      );
      expect(first).toMatchObject({ status: "running", turnStartedAt: 1_000 });

      now = 10_000;
      const later = await provider.sessionStateSnapshot?.("owned-session");
      expect(later).toMatchObject({ status: "running", turnStartedAt: 1_000 });

      stream.push({
        type: "session.idle",
        properties: { sessionID: "owned-session" },
      });
      const idle = await waitForSessionState(provider, (snapshot) => snapshot.status === "idle");
      expect(idle.turnStartedAt).toBeUndefined();

      now = 12_000;
      stream.push({
        type: "session.status",
        properties: { sessionID: "owned-session", status: { type: "busy" } },
      });
      const next = await waitForSessionState(provider, (snapshot) => snapshot.status === "running");
      expect(next.turnStartedAt).toBe(12_000);
    } finally {
      await provider.dispose?.();
    }
  });

  test("does not republish or restamp the turn clock after a streamed error", async () => {
    const fake = openCodeFake();
    let now = 0;
    const provider = openCodeActivityProvider(fake, {
      now: () => now,
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1 && fake.statusCallCount > 0);
      now = 1_000;
      await provider.send("owned-session", "Keep working", { requestId: "request-1" });
      const stream = fake.subscriptions[0]!;
      stream.push({
        type: "session.status",
        properties: { sessionID: "owned-session", status: { type: "busy" } },
      });
      const started = await waitForSessionState(
        provider,
        (snapshot) => snapshot.status === "running",
      );
      expect(started.turnStartedAt).toBe(1_000);

      // The lifecycle cache stays running; only the stream error ends the turn.
      stream.push({
        type: "session.error",
        properties: {
          sessionID: "owned-session",
          error: { name: "ProviderError", data: { message: "provider unavailable" } },
        },
      });
      const failedState = await waitForSessionState(
        provider,
        (snapshot) => snapshot.status === "error",
      );
      expect(failedState.turnStartedAt).toBeUndefined();
      const failedInteractive = await waitForSnapshot(
        provider,
        (snapshot) => snapshot.status === "error",
      );
      expect(failedInteractive.turnStartedAt).toBeUndefined();

      // An error-status read at a later time must not plant a fresh clock.
      now = 500_000;
      const restamped = await provider.sessionStateSnapshot?.("owned-session");
      expect(restamped?.status).toBe("error");
      expect(restamped?.turnStartedAt).toBeUndefined();

      stream.push({
        type: "session.status",
        properties: { sessionID: "owned-session", status: { type: "busy" } },
      });
      const next = await waitForSessionState(provider, (snapshot) => snapshot.status === "running");
      expect(next.turnStartedAt).toBe(500_000);
    } finally {
      await provider.dispose?.();
    }
  });

  test("clears a stale turn clock when an authoritative read reports the session idle", async () => {
    const fake = openCodeFake();
    let now = 0;
    const provider = openCodeActivityProvider(fake, {
      now: () => now,
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1 && fake.statusCallCount > 0);
      now = 1_000;
      await provider.send("owned-session", "Keep working", { requestId: "request-1" });
      const stream = fake.subscriptions[0]!;
      stream.push({
        type: "session.status",
        properties: { sessionID: "owned-session", status: { type: "busy" } },
      });
      await waitForSessionState(provider, (snapshot) => snapshot.status === "running");

      // The idle transition is lost. Only the authoritative reconnect read can
      // settle the turn, and it must not leave the old clock behind.
      fake.setStatusResponse({ data: { "owned-session": { type: "idle" } } });
      stream.push({ type: "server.instance.disposed", properties: {} });
      const idle = await waitForSessionState(provider, (snapshot) => snapshot.status === "idle");
      expect(idle.turnStartedAt).toBeUndefined();

      await waitUntil(() => fake.subscriptions.length >= 2, 2_000);
      now = 500_000;
      fake.subscriptions.at(-1)!.push({
        type: "session.status",
        properties: { sessionID: "owned-session", status: { type: "busy" } },
      });
      const next = await waitForSessionState(provider, (snapshot) => snapshot.status === "running");
      expect(next.turnStartedAt).toBe(500_000);
    } finally {
      await provider.dispose?.();
    }
  });

  test("clears the turn clock when the turn is aborted", async () => {
    const fake = openCodeFake();
    let now = 0;
    const provider = openCodeActivityProvider(fake, {
      now: () => now,
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1 && fake.statusCallCount > 0);
      now = 1_000;
      await provider.send("owned-session", "Keep working", { requestId: "request-1" });
      fake.subscriptions[0]!.push({
        type: "session.status",
        properties: { sessionID: "owned-session", status: { type: "busy" } },
      });
      await waitForSessionState(provider, (snapshot) => snapshot.status === "running");

      await provider.abort("owned-session");
      // The lifecycle cache still reports running, so the cleared clock proves
      // abort settled it rather than waiting for a missed idle event.
      const after = await provider.sessionStateSnapshot?.("owned-session");
      expect(after?.turnStartedAt).toBeUndefined();
    } finally {
      await provider.dispose?.();
    }
  });

  test("does not manufacture a turn clock for a turn only the provider observed", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
    let now = 0;
    const provider = openCodeActivityProvider(fake, {
      now: () => now,
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1 && fake.statusCallCount > 0);
      now = 1_000;
      const state = await waitForSessionState(
        provider,
        (snapshot) => snapshot.status === "running",
      );
      // No dispatch and no busy transition: the renderer must fall back to the
      // persisted user-message clock instead of a snapshot observation time.
      expect(state.turnStartedAt).toBeUndefined();

      now = 50_000;
      const later = await provider.sessionStateSnapshot?.("owned-session");
      expect(later?.turnStartedAt).toBeUndefined();
    } finally {
      await provider.dispose?.();
    }
  });

  test("clears an abandoned dispatch clock when the prompt request throws", async () => {
    const fake = openCodeFake();
    let now = 0;
    const provider = openCodeActivityProvider(fake, {
      now: () => now,
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1 && fake.statusCallCount > 0);
      now = 1_000;
      fake.setPromptError(new Error("socket hang up"));
      await expect(
        provider.send("owned-session", "prompt", { requestId: "request-1" }),
      ).rejects.toBeInstanceOf(AmbiguousPromptDispatchError);

      now = 7_000;
      fake.subscriptions[0]!.push({
        type: "session.status",
        properties: { sessionID: "owned-session", status: { type: "busy" } },
      });
      const running = await waitForSessionState(
        provider,
        (snapshot) => snapshot.status === "running",
      );
      expect(running.turnStartedAt).toBe(7_000);
    } finally {
      await provider.dispose?.();
    }
  });

  test("clears the dispatch clock when OpenCode rejects the prompt", async () => {
    const fake = openCodeFake();
    let now = 0;
    const provider = openCodeActivityProvider(fake, {
      now: () => now,
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1 && fake.statusCallCount > 0);
      now = 1_000;
      fake.setPromptResponse({ error: { name: "ProviderError" }, response: { status: 400 } });
      await expect(
        provider.send("owned-session", "prompt", { requestId: "request-1" }),
      ).rejects.toBeInstanceOf(PromptRejectedError);

      now = 7_000;
      fake.subscriptions[0]!.push({
        type: "session.status",
        properties: { sessionID: "owned-session", status: { type: "busy" } },
      });
      const running = await waitForSessionState(
        provider,
        (snapshot) => snapshot.status === "running",
      );
      expect(running.turnStartedAt).toBe(7_000);
    } finally {
      await provider.dispose?.();
    }
  });

  test("merges transcript, lifecycle, metadata, runtime, interaction and MCP events", async () => {
    const fake = openCodeFake();
    fake.setMessagesResponse({ data: [textMessage("Before")] });
    fake.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
    let mcpStatuses: Record<string, unknown> = { alpha: { status: "connected" } };
    Object.assign(fake.client as object, {
      mcp: { status: async () => ({ data: mcpStatuses }) },
    });
    const provider = openCodeActivityProvider(fake, {
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      const baseline = await provider.interactiveSnapshot?.("owned-session");
      expect(baseline?.status).toBe("running");
      expect(baseline?.runtime?.mcpServers).toBe(1);
      const baselineMessageReads = fake.messageCalls.length;
      const baselineStatusReads = fake.statusCallCount;

      const stream = fake.subscriptions[0]!;
      stream.push({
        id: "event-message",
        type: "message.updated",
        properties: {
          sessionID: "owned-session",
          info: {
            id: "assistant-1",
            sessionID: "owned-session",
            role: "assistant",
            time: { created: 1_700_000_000_000 },
          },
        },
      });
      stream.push({
        id: "event-part",
        type: "message.part.updated",
        properties: {
          sessionID: "owned-session",
          time: 1_700_000_000_000,
          part: { id: "part-1", messageID: "assistant-1", type: "text", text: "Hel" },
        },
      });
      stream.push({
        id: "event-delta",
        type: "message.part.delta",
        properties: {
          sessionID: "owned-session",
          messageID: "assistant-1",
          partID: "part-1",
          field: "text",
          delta: "lo",
        },
      });
      stream.push({
        id: "event-todo",
        type: "todo.updated",
        properties: { sessionID: "owned-session", todos: [{ id: "one" }, { id: "two" }] },
      });
      stream.push({
        id: "event-diff",
        type: "session.diff",
        properties: { sessionID: "owned-session", diff: [{ file: "one.ts" }] },
      });
      stream.push({
        id: "event-title",
        type: "session.updated",
        properties: {
          sessionID: "owned-session",
          info: {
            id: "owned-session",
            title: "Streamed title",
            permission: [{ permission: "edit", pattern: "*", action: "ask" }],
          },
        },
      });
      stream.push({
        id: "event-idle",
        type: "session.idle",
        properties: { sessionID: "owned-session" },
      });
      stream.push({
        id: "event-compacted",
        type: "session.compacted",
        properties: { sessionID: "owned-session" },
      });
      stream.push({
        id: "event-permission",
        type: "permission.replied",
        properties: {
          sessionID: "owned-session",
          requestID: "permission-1",
          reply: "reject",
        },
      });
      mcpStatuses = {
        alpha: { status: "connected" },
        beta: { status: "disabled" },
      };
      stream.push({
        id: "event-mcp",
        type: "mcp.tools.changed",
        properties: { server: "alpha" },
      });

      await waitUntil(() => fake.permissionListCallCount > 0);
      const streamed = await provider.interactiveSnapshot?.("owned-session");
      expect(streamed).toMatchObject({
        status: "idle",
        title: "Streamed title",
        runtime: { todos: 2, files: 1, mcpServers: 2 },
      });
      expect(streamed?.messages[0]).toMatchObject({ content: "Hello" });
      expect(
        streamed?.messages.some((message) =>
          (message as { parts?: Array<{ type?: string }> }).parts?.some(
            (part) => part.type === "compaction",
          ),
        ),
      ).toBe(true);
      // A warm projection consumes events and performs no transcript/status
      // poll; status is reconciled on the deliberately longer interval.
      expect(fake.messageCalls).toHaveLength(baselineMessageReads);
      expect(fake.statusCallCount).toBe(baselineStatusReads);

      stream.push({
        id: "event-error",
        type: "session.error",
        properties: {
          sessionID: "owned-session",
          error: { name: "ProviderError", data: { message: "provider unavailable" } },
        },
      });
      const failed = await waitForSnapshot(provider, (snapshot) => snapshot.status === "error");
      expect(failed?.notices).toContainEqual({ kind: "error", message: "provider unavailable" });

      stream.push({
        id: "event-deleted",
        type: "session.deleted",
        properties: { sessionID: "owned-session", info: { id: "owned-session" } },
      });
      await waitForSnapshot(provider, (snapshot) => snapshot.status === "missing");
    } finally {
      await provider.dispose?.();
    }
  });

  test("recovers a dropped transcript event from the authoritative reconnect sweep", async () => {
    const fake = openCodeFake();
    fake.setMessagesResponse({ data: [textMessage("Before gap")] });
    const provider = openCodeActivityProvider(fake, {
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      await provider.interactiveSnapshot?.("owned-session");

      // The replacement was never emitted. Closing the stream marks its cache
      // dirty; the next subscribed generation reconciles from session.messages.
      fake.setMessagesResponse({ data: [textMessage("Recovered after gap")] });
      fake.subscriptions[0]!.close();
      await waitUntil(() => fake.subscriptions.length >= 2, 2_000);
      await waitUntil(() => fake.messageCalls.length >= 2, 2_000);

      const recovered = await provider.interactiveSnapshot?.("owned-session");
      expect(recovered?.messages[0]).toMatchObject({ content: "Recovered after gap" });
    } finally {
      await provider.dispose?.();
    }
  });

  test("keeps a reconnect snapshot bounded for a long transcript", async () => {
    const fake = openCodeFake();
    const transcript = Array.from({ length: 65 }, (_, index) => indexedTextMessage(index));
    fake.setMessagesHandler(async (parameters) => ({
      data: transcript.slice(-Number(parameters?.limit ?? transcript.length)),
    }));
    const provider = openCodeActivityProvider(fake, {
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.close();
      await waitUntil(() => fake.subscriptions.length >= 2, 2_000);
      await waitUntil(() => fake.messageCalls.length >= 1, 2_000);

      const snapshot = await provider.interactiveSnapshot?.("owned-session");
      expect(snapshot?.messages).toHaveLength(64);
      expect(fake.messageCalls.at(-1)).toMatchObject({ limit: 64 });
      expect(snapshot?.messages[0]).toMatchObject({ content: "message-1" });
    } finally {
      await provider.dispose?.();
    }
  });

  test("invalidates a stale reconnect snapshot when a delta arrives during its read", async () => {
    const fake = openCodeFake();
    fake.setMessagesResponse({ data: [textMessage("Before")] });
    const provider = openCodeActivityProvider(fake, {
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      await provider.interactiveSnapshot?.("owned-session");

      let releaseRead!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let gated = true;
      fake.setMessagesHandler(async () => {
        if (gated) {
          gated = false;
          await readGate;
          return { data: [textMessage("Before")] };
        }
        return { data: [textMessage("Before+")] };
      });
      fake.subscriptions[0]!.close();
      await waitUntil(() => fake.subscriptions.length >= 2, 2_000);
      await waitUntil(() => fake.messageCalls.length >= 2, 2_000);
      fake.subscriptions[1]!.push({
        type: "message.part.delta",
        properties: {
          sessionID: "owned-session",
          messageID: "assistant-1",
          partID: "part-1",
          field: "text",
          delta: "+",
        },
      });
      releaseRead();
      const snapshot = await provider.interactiveSnapshot?.("owned-session");
      expect(fake.messageCalls.length).toBeGreaterThanOrEqual(3);
      expect(snapshot?.messages[0]).toMatchObject({ content: "Before+" });
    } finally {
      await provider.dispose?.();
    }
  });

  test("keeps an interactive rejection out of unattended failure state", async () => {
    const fake = openCodeFake();
    const provider = openCodeActivityProvider(fake, {
      monitorRetryMs: 1,
      openCodeStatusReconcileIntervalMs: 60_000,
    });
    provider.registerSession?.("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      const internal = provider as unknown as { handleRequest(event: unknown): Promise<void> };
      await internal.handleRequest({
        type: "question.rejected",
        properties: { id: "question-1", sessionID: "owned-session" },
      });
      await expect(provider.status("owned-session")).resolves.toBe("idle");
    } finally {
      await provider.dispose?.();
    }
  });
});

describe("OpenCode stream state bounds", () => {
  test("rejects oversized authoritative message, part and byte snapshots", () => {
    const state = new OpenCodeStreamState();
    expect(
      state.replaceMessages(
        "count",
        Array.from({ length: 1_026 }, () => ({})),
      ),
    ).toBe(false);
    expect(state.currentMessages("count")).toBeUndefined();
    expect(
      state.replaceMessages("parts", [
        { info: { id: "message" }, parts: Array.from({ length: 2_049 }, () => ({})) },
      ]),
    ).toBe(false);
    expect(state.currentMessages("parts")).toBeUndefined();
    expect(
      state.replaceMessages("bytes", [
        { info: { id: "message" }, parts: [{ type: "text", text: "x".repeat(16_777_216) }] },
      ]),
    ).toBe(false);
    expect(state.currentMessages("bytes")).toBeUndefined();
  });

  test("applies thousands of deltas without remeasuring the full transcript", () => {
    const state = new OpenCodeStreamState();
    state.replaceMessages("owned-session", [textMessage("start")]);
    for (let index = 0; index < 3_000; index += 1) {
      state.apply({
        type: "message.part.delta",
        properties: {
          sessionID: "owned-session",
          messageID: "assistant-1",
          partID: "part-1",
          field: "text",
          delta: "x",
        },
      } as never);
    }
    const messages = state.currentMessages("owned-session") as Array<{
      parts: Array<{ text: string }>;
    }>;
    expect(messages[0]?.parts[0]?.text).toBe(`start${"x".repeat(3_000)}`);
  });
});
