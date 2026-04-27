import { beforeEach, describe, expect, test } from "bun:test";
import { app, __testing } from "./index.js";

type StreamEntry =
  | { done: true }
  | { value: unknown };

function createStreamController() {
  const queue: StreamEntry[] = [];
  let resolveNext: ((entry: StreamEntry) => void) | undefined;

  const enqueue = (entry: StreamEntry) => {
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = undefined;
      resolve(entry);
      return;
    }

    queue.push(entry);
  };

  const next = async (): Promise<StreamEntry> => {
    const queued = queue.shift();
    if (queued) {
      return queued;
    }

    return new Promise((resolve) => {
      resolveNext = resolve;
    });
  };

  return {
    async *events() {
      while (true) {
        const entry = await next();
        if ("done" in entry) {
          return;
        }
        yield entry.value;
      }
    },
    push(value: unknown) {
      enqueue({ value });
    },
    close() {
      enqueue({ done: true });
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for condition");
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    conversationMode: "build",
    fastMode: false,
    thread: {
      runStreamed: async () => ({ events: (async function* () {})() }),
    },
    threadOptions: {},
    threadId: null,
    messages: [],
    status: "idle",
    currentItems: new Map(),
    currentItemOrder: [],
    pendingAttachments: [],
    lastAccessed: Date.now(),
    ...overrides,
  };
}

describe("codex bridge abort handling", () => {
  beforeEach(() => {
    __testing.sessions.clear();
  });

  test("abort route aborts the controller and clears active turn state", async () => {
    const abortController = new AbortController();
    const session = createSession({
      id: "abort-session",
      title: "Abort me",
      status: "running",
      error: "previous error",
      abortController,
      currentTurnId: "turn-1",
      currentTurnStartedAt: "2026-04-15T10:00:00.000Z",
      pendingAttachments: [{ type: "image", path: "/tmp/screenshot.png" }],
    });
    __testing.sessions.set(session.id, session);

    const response = await app.request("/session/abort-session/abort", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "aborted" });
    expect(abortController.signal.aborted).toBe(true);
    expect(session.status).toBe("idle");
    expect(session.error).toBeUndefined();
    expect(session.currentTurnId).toBeUndefined();
    expect(session.currentTurnStartedAt).toBeUndefined();
    expect(session.abortController).toBeUndefined();
    expect(session.pendingAttachments).toEqual([]);
  });

  test("stale stream events cannot overwrite a newer turn after abort", async () => {
    const streams: ReturnType<typeof createStreamController>[] = [];
    const signals: AbortSignal[] = [];
    const session = createSession({
      thread: {
        runStreamed: async (_input: unknown, options: { signal: AbortSignal }) => {
          signals.push(options.signal);
          const stream = createStreamController();
          streams.push(stream);
          return { events: stream.events() };
        },
      },
    });

    const firstRun = __testing.runPrompt(session, "first prompt");
    await waitUntil(() => streams.length === 1);

    session.abortController?.abort();
    session.status = "idle";
    session.error = undefined;
    session.currentTurnId = undefined;
    session.currentTurnStartedAt = undefined;
    session.abortController = undefined;
    session.pendingAttachments = [];

    const secondRun = __testing.runPrompt(session, "second prompt");
    await waitUntil(() => streams.length === 2);

    streams[0]!.push({
      type: "item.completed",
      item: { id: "old-item", type: "agent_message", text: "OLD RESPONSE" },
    });
    await firstRun;

    streams[1]!.push({
      type: "item.completed",
      item: { id: "new-item", type: "agent_message", text: "NEW RESPONSE" },
    });
    streams[1]!.close();
    await secondRun;

    const assistantContent = session.messages
      .filter((message: { role: string }) => message.role === "assistant")
      .map((message: { content: string }) => message.content)
      .join("\n");

    expect(signals[0]?.aborted).toBe(true);
    expect(assistantContent).toContain("NEW RESPONSE");
    expect(assistantContent).not.toContain("OLD RESPONSE");
    expect(session.status).toBe("idle");
  });
});
