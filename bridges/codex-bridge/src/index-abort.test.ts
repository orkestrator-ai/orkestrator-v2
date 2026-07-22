import { beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransformStream } from "node:stream/web";
import type { BridgeModel } from "./models-cache.js";
import {
  persistSessionTitle,
  readPersistedSessionTitles,
} from "./session-titles.js";

process.env.CODEX_BRIDGE_NO_SERVER = "1";
globalThis.TransformStream = TransformStream as typeof globalThis.TransformStream;

const { app, __testing } = await import("./index.js");

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

function createRestorableStaleSession(id: string) {
  return createSession({
    id,
    title: "Stale session",
    threadId: "thread-1",
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: "Previous prompt",
        parts: [{ type: "text", content: "Previous prompt" }],
        createdAt: "2026-04-15T10:00:00.000Z",
      },
    ],
    lastAccessed: Date.now() - 31 * 60 * 1000,
  });
}

function compactStaleSession(id: string) {
  const staleSession = createRestorableStaleSession(id);
  __testing.sessions.set(staleSession.id, staleSession);

  __testing.cleanupIdleSessions();

  expect(__testing.sessions.has(id)).toBe(false);
  expect(__testing.expiredSessions.has(id)).toBe(true);
  return staleSession;
}

async function withBridgeEnv<T>(
  fn: (env: { codexHome: string; cwd: string }) => T | Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "orkestrator-codex-bridge-routes-"));
  const codexHome = join(root, "codex-home");
  const cwd = join(root, "workspace");
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCwd = process.env.CWD;
  const previousCodexPath = process.env.CODEX_PATH;

  mkdirSync(codexHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.CWD = cwd;
  process.env.CODEX_PATH = join(root, "missing-codex");

  try {
    return await fn({ codexHome, cwd });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }

    if (previousCwd === undefined) {
      delete process.env.CWD;
    } else {
      process.env.CWD = previousCwd;
    }

    if (previousCodexPath === undefined) {
      delete process.env.CODEX_PATH;
    } else {
      process.env.CODEX_PATH = previousCodexPath;
    }

    rmSync(root, { recursive: true, force: true });
  }
}

function writePersistedThread(codexHome: string, cwd: string, threadId: string) {
  const sessionsDir = join(codexHome, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({
      id: threadId,
      thread_name: "Saved session",
      updated_at: "2026-04-15T10:30:00.000Z",
    })}\n`,
  );
  writeFileSync(
    join(sessionsDir, `${threadId}.jsonl`),
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: threadId,
          cwd,
          timestamp: "2026-04-15T10:30:00.000Z",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-04-15T10:31:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Saved prompt" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-04-15T10:32:00.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Saved answer" }],
        },
      }),
      "",
    ].join("\n"),
  );
}

function writeRollout(
  codexHome: string,
  filenameThreadId: string,
  records: Record<string, unknown>[],
) {
  const sessionsDir = join(codexHome, "sessions", "2026", "07", "17");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `rollout-${filenameThreadId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

describe("codex bridge abort handling", () => {
  beforeEach(() => {
    for (const session of __testing.sessions.values()) {
      session.subagentRefreshController?.stop();
    }
    __testing.sessions.clear();
    __testing.expiredSessions.clear();
    __testing.setBeforePromptExecutionForTesting(null);
    __testing.setBeforeAssistantMessageCommitForTesting(null);
    __testing.setAfterStreamEventLogForTesting(null);
    __testing.setSessionTitleGeneratorForTesting(null);
    __testing.setFreshThreadFactoryForTesting(null);
  });

  test("abort route aborts execution but preserves transcript reconciliation state", async () => {
    const abortController = new AbortController();
    let settlementCount = 0;
    const session = createSession({
      id: "abort-session",
      title: "Abort me",
      status: "running",
      error: "previous error",
      abortController,
      currentTurnId: "turn-1",
      currentAssistantTurnStartedAt: "2026-04-15T10:00:00.000Z",
      subagentRefreshController: {
        refreshNow: async () => {},
        markParentSettled: () => { settlementCount += 1; },
        stop: () => {},
        isStopped: () => false,
      },
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
    expect(session.currentAssistantTurnStartedAt).toBe("2026-04-15T10:00:00.000Z");
    expect(session.abortController).toBeUndefined();
    expect(session.pendingAttachments).toEqual([]);
    expect(settlementCount).toBe(1);
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

  test("drops every event kind when the turn changes across the logging boundary", async () => {
    const cases = [
      {
        event: { type: "thread.started", thread_id: "stale-thread" },
        verify: (session: ReturnType<typeof createSession>) => {
          expect(session.threadId).toBeNull();
        },
      },
      {
        event: {
          type: "item.completed",
          item: { id: "stale-item", type: "agent_message", text: "STALE" },
        },
        verify: (session: ReturnType<typeof createSession>) => {
          expect(session.currentItemOrder).toEqual([]);
        },
      },
      {
        event: { type: "turn.completed", usage: {} },
        verify: (session: ReturnType<typeof createSession>) => {
          expect(session.status).toBe("running");
        },
      },
      {
        event: { type: "turn.failed", error: { message: "stale failure" } },
        verify: (session: ReturnType<typeof createSession>) => {
          expect(session.error).toBeUndefined();
        },
      },
      {
        event: { type: "unknown-event" },
        verify: (session: ReturnType<typeof createSession>) => {
          expect(session.status).toBe("running");
        },
      },
    ];

    for (const { event, verify } of cases) {
      const session = createSession({
        thread: {
          runStreamed: async () => ({
            events: (async function* () {
              yield event;
            })(),
          }),
        },
      });
      __testing.setAfterStreamEventLogForTesting(() => {
        session.currentTurnId = "replacement-turn";
      });

      await __testing.runPrompt(session, "stale boundary event");

      expect(session.currentTurnId).toBe("replacement-turn");
      verify(session);
      __testing.setAfterStreamEventLogForTesting(null);
    }
  });

  test("contains primary and recovery stream failures after cancellation", async () => {
    const primary = createSession({
      thread: {
        runStreamed: async () => {
          primary.abortController?.abort();
          throw new Error("primary failure after abort");
        },
      },
    });

    await expect(__testing.runPrompt(primary, "cancel primary")).resolves.toBeUndefined();
    expect(primary.error).toBeUndefined();
    expect(primary.abortController).toBeUndefined();

    const recovery = createSession({
      threadId: "missing-thread",
      thread: {
        runStreamed: async () => {
          throw new Error(
            "thread/resume failed: no rollout found for thread id missing-thread",
          );
        },
      },
    });
    __testing.setFreshThreadFactoryForTesting(() => ({
      runStreamed: async () => {
        recovery.abortController?.abort();
        throw new Error("recovery failure after abort");
      },
    } as any));

    await expect(__testing.runPrompt(recovery, "cancel recovery")).resolves.toBeUndefined();
    expect(recovery.error).toBeUndefined();
    expect(recovery.abortController).toBeUndefined();
  });

  test("stops accepted prompt setup when a newer turn appears after the setup hook", async () => {
    let threadStarted = false;
    const session = createSession({
      currentTurnId: "accepted-turn",
      thread: {
        runStreamed: async () => {
          threadStarted = true;
          return { events: (async function* () {})() };
        },
      },
    });
    __testing.setBeforePromptExecutionForTesting(() => {
      session.currentTurnId = "newer-turn";
    });

    await __testing.runPrompt(session, "accepted prompt", "accepted-turn");

    expect(threadStarted).toBe(false);
    expect(session.currentTurnId).toBe("newer-turn");
    expect(session.messages).toEqual([]);
  });

  test("runPrompt updates the assistant timestamp as stream item events arrive", async () => {
    const streams: ReturnType<typeof createStreamController>[] = [];
    const session = createSession({
      thread: {
        runStreamed: async () => {
          const stream = createStreamController();
          streams.push(stream);
          return { events: stream.events() };
        },
      },
    });

    const promptRun = __testing.runPrompt(session, "stream a response");
    await waitUntil(() => streams.length === 1);

    const assistantMessage = session.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantMessage).toBeDefined();
    const initialTimestamp = assistantMessage!.createdAt;
    await waitUntil(() => Date.now() > new Date(initialTimestamp).getTime());

    streams[0]!.push({
      type: "item.updated",
      item: { id: "answer", type: "agent_message", text: "First chunk" },
    });
    await waitUntil(() => assistantMessage!.content === "First chunk");

    const firstStreamTimestamp = assistantMessage!.createdAt;
    expect(new Date(firstStreamTimestamp).getTime()).toBeGreaterThan(
      new Date(initialTimestamp).getTime(),
    );
    await waitUntil(() => Date.now() > new Date(firstStreamTimestamp).getTime());

    streams[0]!.push({
      type: "item.completed",
      item: { id: "answer", type: "agent_message", text: "Final chunk" },
    });
    streams[0]!.close();
    await promptRun;

    expect(assistantMessage!.content).toBe("Final chunk");
    expect(new Date(assistantMessage!.createdAt).getTime()).toBeGreaterThan(
      new Date(firstStreamTimestamp).getTime(),
    );
    expect(session.status).toBe("idle");
  });

  test("collaboration stream events rebuild inline agents and reset cleanly for the next turn", async () => {
    const streams: ReturnType<typeof createStreamController>[] = [];
    const session = createSession({
      id: "collaboration-stream-session",
      thread: {
        runStreamed: async () => {
          const stream = createStreamController();
          streams.push(stream);
          return { events: stream.events() };
        },
      },
    });
    __testing.sessions.set(session.id, session);

    const firstRun = __testing.runPrompt(session, "delegate the review");
    await waitUntil(() => streams.length === 1);
    streams[0]!.push({
      type: "item.completed",
      item: {
        id: "spawn-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Review the bridge",
        receiver_thread_ids: ["agent-1"],
        agents_states: { "agent-1": { status: "running" } },
        status: "completed",
      },
    });
    await waitUntil(() => session.messages.some(
      (message: { role: string; parts: Array<{ subagentId?: string }> }) =>
        message.role === "assistant"
        && message.parts.some((part) => part.subagentId === "agent-1"),
    ));
    streams[0]!.push({
      type: "item.completed",
      item: { id: "reasoning", type: "reasoning", text: "Parent review" },
    });
    streams[0]!.push({
      type: "item.completed",
      item: {
        id: "wait-1",
        type: "collab_tool_call",
        tool: "wait",
        receiver_thread_ids: ["agent-1"],
        agents_states: {
          "agent-1": { status: "completed", message: "Agent review complete" },
        },
        status: "completed",
      },
    });
    streams[0]!.push({ type: "turn.completed", usage: {} });
    await firstRun;

    const firstAssistant = session.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(firstAssistant?.parts).toEqual([
      { type: "thinking", content: "Parent review" },
      expect.objectContaining({
        type: "subagent",
        subagentId: "agent-1",
        subagentPrompt: "Review the bridge",
        toolState: "success",
        subagentActions: [{ type: "text", content: "Agent review complete" }],
      }),
    ]);
    const messagesResponse = await app.request(`/session/${session.id}/messages`);
    expect(messagesResponse.status).toBe(200);
    expect(await messagesResponse.json()).toMatchObject({
      messages: [
        expect.any(Object),
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({ subagentId: "agent-1", toolState: "success" }),
          ]),
        }),
      ],
    });

    const priorGeneration = session.currentTimelineGeneration;
    const secondRun = __testing.runPrompt(session, "answer directly");
    await waitUntil(() => streams.length === 2);
    expect(session.currentTimelineGeneration).toBeGreaterThan(priorGeneration);
    expect(session.currentItemOrder).toEqual([]);
    expect(session.currentTimelineOrder).toEqual([]);
    expect(session.currentSubagentParts.size).toBe(0);
    expect(session.currentSubagentFingerprints.size).toBe(0);

    streams[1]!.push({
      type: "item.completed",
      item: { id: "answer-2", type: "agent_message", text: "Direct answer" },
    });
    streams[1]!.push({ type: "turn.completed", usage: {} });
    await secondRun;
    const assistants = session.messages.filter(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistants[1]?.parts).toEqual([{ type: "text", content: "Direct answer" }]);
  });

  test("periodic transcript refresh discovers child activity after the parent settles", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      const parentThreadId = "settled-parent-thread";
      const childThreadId = "late-child-thread";
      writeRollout(codexHome, parentThreadId, [{
        timestamp: "2026-07-17T17:02:00.000Z",
        type: "session_meta",
        payload: { id: parentThreadId, cwd },
      }]);

      const assistantMessage = {
        id: "settled-assistant",
        role: "assistant",
        content: "",
        parts: [],
        createdAt: "2026-07-17T17:02:00.000Z",
      };
      const session = createSession({
        id: "settled-transcript-session",
        threadId: parentThreadId,
        status: "idle",
        currentAssistantMessageId: assistantMessage.id,
        currentAssistantTurnStartedAt: "2026-07-17T17:02:00.000Z",
        messages: [assistantMessage],
        currentItems: new Map(),
        currentItemOrder: [],
      });
      const controller = __testing.startTurnSubagentRefreshForTesting(session, () => false, {
        intervalMs: 10,
        settleGraceMs: 500,
        settleTimeoutMs: 2_000,
      });
      controller.markParentSettled();

      try {
        // Let the scheduled watcher observe the initial transcript before the
        // late child records arrive; discovery below must come from a later tick.
        await Bun.sleep(20);
        writeRollout(codexHome, parentThreadId, [
          {
            timestamp: "2026-07-17T17:02:00.000Z",
            type: "session_meta",
            payload: { id: parentThreadId, cwd },
          },
          {
            timestamp: "2026-07-17T17:02:01.000Z",
            type: "response_item",
            payload: {
              type: "function_call",
              name: "spawn_agent",
              call_id: "late-spawn",
              arguments: JSON.stringify({ task_name: "late_review", message: "Review late output" }),
            },
          },
          {
            timestamp: "2026-07-17T17:02:01.100Z",
            type: "event_msg",
            payload: {
              type: "sub_agent_activity",
              event_id: "late-spawn",
              agent_thread_id: childThreadId,
              agent_path: "/root/late_review",
            },
          },
        ]);
        writeRollout(codexHome, childThreadId, [
          {
            timestamp: "2026-07-17T17:02:01.100Z",
            type: "session_meta",
            payload: { id: childThreadId, cwd, agent_nickname: "Noether" },
          },
          {
            timestamp: "2026-07-17T17:02:02.000Z",
            type: "event_msg",
            payload: { type: "task_complete" },
          },
        ]);

        await waitUntil(() => assistantMessage.parts.some(
          (part: { subagentId?: string }) => part.subagentId === childThreadId,
        ));
        expect(assistantMessage.parts).toEqual([
          expect.objectContaining({
            type: "subagent",
            subagentId: childThreadId,
            subagentName: "Noether",
            subagentPrompt: "Review late output",
            toolState: "success",
          }),
        ]);
      } finally {
        controller.stop();
      }
    });
  });

  test("rebuilds task-name-only spawns with actions from the streamed child thread ID", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      const parentThreadId = "parent-thread-id";
      const childThreadId = "child-thread-id";
      const sessionsDir = join(codexHome, "sessions", "2026", "07", "17");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        join(sessionsDir, `rollout-${parentThreadId}.jsonl`),
        [
          JSON.stringify({
            timestamp: "2026-07-17T17:02:00.000Z",
            type: "session_meta",
            payload: { id: parentThreadId, cwd },
          }),
          JSON.stringify({
            timestamp: "2026-07-17T17:02:45.778Z",
            type: "response_item",
            payload: {
              type: "function_call",
              name: "spawn_agent",
              call_id: "call-spawn",
              arguments: JSON.stringify({ task_name: "review", message: "encrypted" }),
            },
          }),
          JSON.stringify({
            timestamp: "2026-07-17T17:02:45.922Z",
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "call-spawn",
              output: JSON.stringify({ task_name: "/root/review" }),
            },
          }),
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(sessionsDir, `rollout-${childThreadId}.jsonl`),
        [
          JSON.stringify({
            timestamp: "2026-07-17T17:02:45.916Z",
            type: "session_meta",
            payload: { id: childThreadId, cwd, agent_nickname: "Ampere" },
          }),
          JSON.stringify({
            timestamp: "2026-07-17T17:02:46.000Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              name: "exec",
              call_id: "child-call",
              input: "git diff --check",
              status: "completed",
              output: "clean",
            },
          }),
          JSON.stringify({
            timestamp: "2026-07-17T17:02:47.000Z",
            type: "event_msg",
            payload: { type: "task_complete" },
          }),
          "",
        ].join("\n"),
      );

      const assistantMessage = {
        id: "assistant-message",
        role: "assistant",
        content: "",
        parts: [],
        createdAt: "2026-07-17T17:02:00.000Z",
      };
      const session = createSession({
        id: "task-name-spawn-session",
        threadId: parentThreadId,
        status: "running",
        currentAssistantMessageId: assistantMessage.id,
        currentAssistantTurnStartedAt: "2026-07-17T17:02:00.000Z",
        messages: [assistantMessage],
        currentItems: new Map([
          [
            "spawn",
            {
              id: "spawn",
              type: "collab_tool_call",
              tool: "spawn_agent",
              receiver_thread_ids: [childThreadId],
              agents_states: { [childThreadId]: { status: "completed" } },
              status: "completed",
            },
          ],
        ]),
        currentItemOrder: ["spawn"],
      });

      await __testing.rebuildAssistantMessage(session);

      expect(assistantMessage.parts).toEqual([
        expect.objectContaining({
          type: "subagent",
          subagentId: childThreadId,
          subagentName: "Ampere",
          subagentActionCount: 1,
          toolState: "success",
          subagentActions: [
            expect.objectContaining({
              type: "tool-invocation",
              toolName: "exec",
              toolState: "success",
              toolOutput: "clean",
            }),
          ],
        }),
      ]);
    });
  });

  test("maps multiple streamed spawns to matching transcript calls with mixed ID sources", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      const parentThreadId = "mixed-parent-thread";
      const authoritativeChildId = "authoritative-child-thread";
      const fallbackChildId = "fallback-child-thread";
      writeRollout(codexHome, parentThreadId, [
        {
          timestamp: "2026-07-17T18:00:00.000Z",
          type: "session_meta",
          payload: { id: parentThreadId, cwd },
        },
        {
          timestamp: "2026-07-17T18:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            call_id: "call-authoritative",
            arguments: JSON.stringify({ message: "Handle the authoritative task" }),
          },
        },
        {
          timestamp: "2026-07-17T18:00:01.100Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-authoritative",
            output: JSON.stringify({
              agent_id: authoritativeChildId,
              nickname: "Authoritative",
            }),
          },
        },
        {
          timestamp: "2026-07-17T18:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            call_id: "call-fallback",
            arguments: JSON.stringify({ task_name: "fallback", message: "Handle fallback" }),
          },
        },
        {
          timestamp: "2026-07-17T18:00:02.100Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-fallback",
            output: JSON.stringify({ task_name: "/root/fallback" }),
          },
        },
      ]);
      writeRollout(codexHome, authoritativeChildId, [
        {
          timestamp: "2026-07-17T18:00:01.050Z",
          type: "session_meta",
          payload: { id: authoritativeChildId, cwd, agent_nickname: "Ada" },
        },
        {
          timestamp: "2026-07-17T18:00:01.200Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "authoritative-action",
            input: "bun test authoritative",
            status: "completed",
            output: "authoritative clean",
          },
        },
      ]);
      writeRollout(codexHome, fallbackChildId, [
        {
          timestamp: "2026-07-17T18:00:02.050Z",
          type: "session_meta",
          payload: { id: fallbackChildId, cwd, agent_nickname: "Grace" },
        },
        {
          timestamp: "2026-07-17T18:00:02.200Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "fallback-action",
            input: "bun test fallback",
            status: "completed",
            output: "fallback clean",
          },
        },
      ]);

      const assistantMessage = {
        id: "mixed-assistant-message",
        role: "assistant",
        content: "",
        parts: [],
        createdAt: "2026-07-17T18:00:00.000Z",
      };
      const session = createSession({
        id: "mixed-spawn-session",
        threadId: parentThreadId,
        status: "running",
        currentAssistantMessageId: assistantMessage.id,
        currentAssistantTurnStartedAt: "2026-07-17T18:00:00.000Z",
        messages: [assistantMessage],
        currentItems: new Map([
          [
            "spawn-authoritative",
            {
              id: "spawn-authoritative",
              type: "collab_tool_call",
              tool: "spawn_agent",
              receiver_thread_ids: [authoritativeChildId],
              agents_states: { [authoritativeChildId]: { status: "completed" } },
              status: "completed",
            },
          ],
          [
            "spawn-fallback",
            {
              id: "spawn-fallback",
              type: "collab_tool_call",
              tool: "spawn_agent",
              receiver_thread_ids: [fallbackChildId],
              agents_states: { [fallbackChildId]: { status: "completed" } },
              status: "completed",
            },
          ],
        ]),
        currentItemOrder: ["spawn-authoritative", "spawn-fallback"],
      });

      await __testing.rebuildAssistantMessage(session);

      expect(assistantMessage.parts).toHaveLength(2);
      expect(assistantMessage.parts).toEqual([
        expect.objectContaining({
          subagentId: authoritativeChildId,
          subagentName: "Ada",
          subagentPrompt: "Handle the authoritative task",
          subagentActions: [
            expect.objectContaining({
              toolName: "exec",
              toolOutput: "authoritative clean",
            }),
          ],
        }),
        expect.objectContaining({
          subagentId: fallbackChildId,
          subagentName: "Grace",
          subagentPrompt: "Handle fallback",
          subagentActions: [
            expect.objectContaining({
              toolName: "exec",
              toolOutput: "fallback clean",
            }),
          ],
        }),
      ]);
    });
  });

  test("rebuilds collaboration state when parent or child transcript metadata is unavailable", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      const parentThreadId = "missing-child-parent";
      const missingChildId = "missing-child-thread";
      writeRollout(codexHome, parentThreadId, [
        {
          timestamp: "2026-07-17T19:00:00.000Z",
          type: "session_meta",
          payload: { id: parentThreadId, cwd },
        },
        {
          timestamp: "2026-07-17T19:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            call_id: "call-missing-child",
            arguments: JSON.stringify({ message: "Inspect unavailable child" }),
          },
        },
        {
          timestamp: "2026-07-17T19:00:01.100Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-missing-child",
            output: JSON.stringify({ agent_id: missingChildId }),
          },
        },
      ]);

      const assistantMessage = {
        id: "missing-child-assistant",
        role: "assistant",
        content: "",
        parts: [],
        createdAt: "2026-07-17T19:00:00.000Z",
      };
      const session = createSession({
        id: "missing-child-session",
        threadId: parentThreadId,
        status: "running",
        currentAssistantMessageId: assistantMessage.id,
        currentAssistantTurnStartedAt: "2026-07-17T19:00:00.000Z",
        messages: [assistantMessage],
        currentItems: new Map([
          [
            "spawn-missing-child",
            {
              id: "spawn-missing-child",
              type: "collab_tool_call",
              tool: "spawn_agent",
              prompt: "Inspect unavailable child",
              receiver_thread_ids: [missingChildId],
              agents_states: {
                [missingChildId]: {
                  status: "errored",
                  message: "Child transcript unavailable",
                },
              },
              status: "failed",
            },
          ],
        ]),
        currentItemOrder: ["spawn-missing-child"],
      });

      await expect(__testing.rebuildAssistantMessage(session)).resolves.toBe(assistantMessage);
      expect(assistantMessage.parts).toEqual([
        expect.objectContaining({
          type: "subagent",
          subagentId: missingChildId,
          subagentPrompt: "Inspect unavailable child",
          toolState: "failure",
          subagentActions: [{ type: "text", content: "Child transcript unavailable" }],
        }),
      ]);

      session.threadId = "missing-parent-thread";
      session.currentTimelineGeneration += 1;
      await expect(__testing.rebuildAssistantMessage(session)).resolves.toBe(assistantMessage);
      expect(assistantMessage.parts).toEqual([
        expect.objectContaining({
          subagentId: missingChildId,
          toolState: "failure",
        }),
      ]);
    });
  });

  test("runPrompt appends changed todo lists at their stream positions", async () => {
    const streams: ReturnType<typeof createStreamController>[] = [];
    const session = createSession({
      thread: {
        runStreamed: async () => {
          const stream = createStreamController();
          streams.push(stream);
          return { events: stream.events() };
        },
      },
    });

    const promptRun = __testing.runPrompt(session, "work through the tasks");
    await waitUntil(() => streams.length === 1);

    streams[0]!.push({
      type: "item.started",
      item: { id: "todo", type: "todo_list", items: [] },
    });
    streams[0]!.push({
      type: "item.updated",
      item: {
        id: "todo",
        type: "todo_list",
        items: [
          { text: "Inspect the code", completed: false },
          { text: "Add coverage", completed: false },
        ],
      },
    });
    streams[0]!.push({
      type: "item.completed",
      item: {
        id: "todo",
        type: "todo_list",
        items: [
          { text: "Inspect the code", completed: false },
          { text: "Add coverage", completed: false },
        ],
      },
    });
    streams[0]!.push({
      type: "item.completed",
      item: { id: "reasoning", type: "reasoning", text: "Inspection finished" },
    });
    streams[0]!.push({
      type: "item.updated",
      item: {
        id: "todo",
        type: "todo_list",
        items: [
          { text: "Inspect the code", completed: true },
          { text: "Add coverage", completed: false },
        ],
      },
    });
    streams[0]!.push({
      type: "item.completed",
      item: {
        id: "command",
        type: "command_execution",
        command: "bun test",
        aggregated_output: "pass",
        status: "completed",
        exit_code: 0,
      },
    });
    streams[0]!.push({
      type: "item.updated",
      item: {
        id: "todo",
        type: "todo_list",
        items: [
          { text: "Inspect the code", completed: true },
          { text: "Add coverage", completed: true },
        ],
      },
    });
    streams[0]!.push({ type: "turn.completed", usage: {} });
    await promptRun;

    const assistantMessage = session.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantMessage?.parts.map(
      (part: { type: string; toolName?: string }) => part.toolName ?? part.type,
    )).toEqual(["todo_list", "thinking", "todo_list", "bash", "todo_list"]);
    expect(
      assistantMessage?.parts
        .filter((part: { toolName?: string }) => part.toolName === "todo_list")
        .map((part: { toolArgs?: { todos?: Array<{ status: string }> } }) =>
          part.toolArgs?.todos?.map((todo) => todo.status)
        ),
    ).toEqual([
      ["pending", "pending"],
      ["completed", "pending"],
      ["completed", "completed"],
    ]);
  });

  test("runPrompt keeps todo snapshots independent when the SDK mutates an emitted item", async () => {
    const streams: ReturnType<typeof createStreamController>[] = [];
    const session = createSession({
      thread: {
        runStreamed: async () => {
          const stream = createStreamController();
          streams.push(stream);
          return { events: stream.events() };
        },
      },
    });
    const todoItem = {
      id: "mutable-todo",
      type: "todo_list" as const,
      items: [{ text: "Keep the original state", completed: false }],
    };

    const promptRun = __testing.runPrompt(session, "track a mutable todo");
    await waitUntil(() => streams.length === 1);
    streams[0]!.push({ type: "item.updated", item: todoItem });
    await waitUntil(() => {
      const assistant = session.messages.find(
        (message: { role: string }) => message.role === "assistant",
      );
      return assistant?.parts[0]?.toolArgs?.todos?.[0]?.status === "pending";
    });

    todoItem.items[0]!.completed = true;
    streams[0]!.push({
      type: "item.completed",
      item: { id: "reasoning", type: "reasoning", text: "Trigger a rebuild" },
    });
    streams[0]!.push({ type: "turn.completed", usage: {} });
    await promptRun;

    const assistantMessage = session.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantMessage?.parts[0]?.toolArgs?.todos).toEqual([
      { content: "Keep the original state", status: "pending" },
    ]);
  });

  test("runPrompt preserves a meaningful empty todo state before repopulation", async () => {
    const streams: ReturnType<typeof createStreamController>[] = [];
    const session = createSession({
      thread: {
        runStreamed: async () => {
          const stream = createStreamController();
          streams.push(stream);
          return { events: stream.events() };
        },
      },
    });

    const promptRun = __testing.runPrompt(session, "replace the plan");
    await waitUntil(() => streams.length === 1);
    streams[0]!.push({
      type: "item.started",
      item: { id: "todo", type: "todo_list", items: [] },
    });
    streams[0]!.push({
      type: "item.updated",
      item: {
        id: "todo",
        type: "todo_list",
        items: [{ text: "Original task", completed: false }],
      },
    });
    streams[0]!.push({
      type: "item.completed",
      item: { id: "reasoning", type: "reasoning", text: "Replace the plan" },
    });
    streams[0]!.push({
      type: "item.updated",
      item: { id: "todo", type: "todo_list", items: [] },
    });
    streams[0]!.push({
      type: "item.completed",
      item: {
        id: "command",
        type: "command_execution",
        command: "inspect replacement",
        aggregated_output: "done",
        status: "completed",
        exit_code: 0,
      },
    });
    streams[0]!.push({
      type: "item.updated",
      item: {
        id: "todo",
        type: "todo_list",
        items: [{ text: "Replacement task", completed: false }],
      },
    });
    streams[0]!.push({ type: "turn.completed", usage: {} });
    await promptRun;

    const assistantMessage = session.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantMessage?.parts.map(
      (part: { type: string; toolName?: string }) => part.toolName ?? part.type,
    )).toEqual(["todo_list", "thinking", "todo_list", "bash", "todo_list"]);
    expect(
      assistantMessage?.parts
        .filter((part: { toolName?: string }) => part.toolName === "todo_list")
        .map((part: { toolArgs?: { todos?: unknown[] } }) => part.toolArgs?.todos),
    ).toEqual([
      [{ content: "Original task", status: "pending" }],
      [],
      [{ content: "Replacement task", status: "pending" }],
    ]);
  });

  test("runPrompt finalizes on turn.completed even if the event stream remains open", async () => {
    const streams: ReturnType<typeof createStreamController>[] = [];
    const session = createSession({
      thread: {
        runStreamed: async () => {
          const stream = createStreamController();
          streams.push(stream);
          return { events: stream.events() };
        },
      },
    });

    const promptRun = __testing.runPrompt(session, "stream a response");
    await waitUntil(() => streams.length === 1);

    streams[0]!.push({
      type: "item.completed",
      item: { id: "answer", type: "agent_message", text: "Final response" },
    });
    streams[0]!.push({
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    });

    await Promise.race([
      promptRun,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("runPrompt did not finish after turn.completed")), 100),
      ),
    ]);

    expect(session.status).toBe("idle");
    expect(session.abortController).toBeUndefined();
    expect(
      session.messages.some(
        (message: { role: string; content: string }) =>
          message.role === "assistant" && message.content === "Final response",
      ),
    ).toBe(true);
  });

  test("runPrompt records the thread id from a thread.started event on the primary stream", async () => {
    const session = createSession({
      threadId: null,
      thread: {
        runStreamed: async () => ({
          events: (async function* () {
            yield { type: "thread.started", thread_id: "primary-thread" };
            yield {
              type: "item.completed",
              item: { id: "answer", type: "agent_message", text: "Primary response" },
            };
            yield {
              type: "turn.completed",
              usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
            };
          })(),
        }),
      },
    });

    await __testing.runPrompt(session, "start a new thread");

    expect(session.threadId).toBe("primary-thread");
    expect(session.status).toBe("idle");
    expect(session.abortController).toBeUndefined();
    expect(
      session.messages.some(
        (message: { role: string; content: string }) =>
          message.role === "assistant" && message.content === "Primary response",
      ),
    ).toBe(true);
  });

  test("runPrompt marks the session errored on a non-recoverable turn.failed event", async () => {
    const session = createSession({
      threadId: "live-thread",
      thread: {
        runStreamed: async () => ({
          events: (async function* () {
            yield {
              type: "turn.failed",
              error: { message: "model refused the request" },
            };
          })(),
        }),
      },
    });

    await __testing.runPrompt(session, "do something");

    expect(session.status).toBe("error");
    expect(session.error).toBe("model refused the request");
    // Non-rollout failures must not trigger fresh-thread recovery.
    expect(session.threadId).toBe("live-thread");
    expect(session.currentTurnId).toBeUndefined();
    expect(session.currentTurnStartedAt).toBeUndefined();
    expect(session.abortController).toBeUndefined();
  });

  test("runPrompt marks the session errored on an error event", async () => {
    const session = createSession({
      threadId: "live-thread",
      thread: {
        runStreamed: async () => ({
          events: (async function* () {
            yield { type: "error", message: "stream transport failure" };
          })(),
        }),
      },
    });

    await __testing.runPrompt(session, "do something");

    expect(session.status).toBe("error");
    expect(session.error).toBe("stream transport failure");
    expect(session.threadId).toBe("live-thread");
    expect(session.currentTurnId).toBeUndefined();
    expect(session.abortController).toBeUndefined();
  });

  test("runPrompt contains ordinary stream exceptions and non-Error rejections", async () => {
    for (const [failure, expectedMessage] of [
      [new Error("stream iteration exploded"), "stream iteration exploded"],
      ["non-error rejection", "Codex execution failed"],
    ] as const) {
      const session = createSession({
        thread: {
          runStreamed: async () => ({
            events: (async function* () {
              throw failure;
            })(),
          }),
        },
      });

      await expect(__testing.runPrompt(session, "do something")).resolves.toBeUndefined();

      expect(session.status).toBe("error");
      expect(session.error).toBe(expectedMessage);
      expect(session.currentTurnId).toBeUndefined();
      expect(session.abortController).toBeUndefined();
    }
  });

  test("runPrompt clears file-change cache between turns while preserving baselines", async () => {
    await withBridgeEnv(async ({ cwd }) => {
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Test User"], {
        cwd,
        stdio: "ignore",
      });
      const filePath = join(cwd, "example.txt");
      writeFileSync(filePath, "one\n", "utf8");
      execFileSync("git", ["add", "example.txt"], { cwd, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd,
        stdio: "ignore",
      });

      let promptCount = 0;
      const session = createSession({
        id: "diff-session",
        thread: {
          runStreamed: async () => {
            promptCount += 1;
            return {
              events: (async function* () {
                if (promptCount === 1) {
                  writeFileSync(filePath, "one\ntwo\n", "utf8");
                  yield {
                    type: "item.completed",
                    item: {
                      id: "patch-1",
                      type: "file_change",
                      changes: [{ path: "example.txt", kind: "update" }],
                      status: "completed",
                    },
                  };
                  return;
                }

                writeFileSync(filePath, "one\ntwo\nthree\n", "utf8");
                yield {
                  type: "item.completed",
                  item: {
                    id: "patch-2",
                    type: "file_change",
                    changes: [{ path: "example.txt", kind: "update" }],
                    status: "completed",
                  },
                };
              })(),
            };
          },
        },
      });

      await __testing.runPrompt(session, "first patch");
      await __testing.runPrompt(session, "second patch");

      const assistantMessages = session.messages.filter(
        (message: { role: string }) => message.role === "assistant",
      );
      const firstDiff = assistantMessages[0]?.parts[0]?.toolDiff?.diff;
      const secondDiff = assistantMessages[1]?.parts[0]?.toolDiff?.diff;

      expect(firstDiff).toContain("+two");
      expect(firstDiff).not.toContain("+three");
      expect(secondDiff).toContain("+three");
      expect(secondDiff).not.toContain("+two");
      expect(session.status).toBe("idle");
    });
  });

  test("Codex-native /goal slash commands bypass plan-mode prompt wrapping", async () => {
    let observedInput = "";
    const session = createSession({
      conversationMode: "plan",
      thread: {
        runStreamed: async (input: string) => {
          observedInput = input;
          return { events: (async function* () {})() };
        },
      },
    });

    await __testing.runPrompt(session, "/goal finish the release notes");

    expect(observedInput).toBe("/goal finish the release notes");
    expect(observedInput).not.toContain("Orkestrator plan mode");
    expect(session.status).toBe("idle");
  });

  test("built-in help and models commands respond locally without starting Codex", async () => {
    await withBridgeEnv(async ({ cwd }) => {
      mkdirSync(join(cwd, ".codex", "prompts"), { recursive: true });
      writeFileSync(
        join(cwd, ".codex", "prompts", "review.md"),
        "---\ndescription: Review this branch\n---\nReview the branch\n",
      );
      mkdirSync(join(cwd, ".codex", "prompts", "nested"), { recursive: true });
      writeFileSync(
        join(cwd, ".codex", "prompts", "nested", "inspect.md"),
        "Inspect nested files\n",
      );
      let runCount = 0;
      const session = createSession({
        thread: {
          runStreamed: async () => {
            runCount += 1;
            return { events: (async function* () {})() };
          },
        },
      });

      await __testing.runPrompt(session, "/help");
      await __testing.runPrompt(session, "/models");

      const assistantMessages = session.messages.filter(
        (message: { role: string }) => message.role === "assistant",
      );
      expect(runCount).toBe(0);
      expect(assistantMessages[0]?.content).toContain("Available Codex slash commands:");
      expect(assistantMessages[0]?.content).toContain("/review: Review this branch");
      expect(assistantMessages[0]?.content).toContain("/nested/inspect: Inspect nested files");
      expect(assistantMessages[1]?.content).toContain("Available Codex models:");
    });
  });

  test("prompt templates expand arguments and inline command success and failure output", async () => {
    await withBridgeEnv(async ({ cwd }) => {
      mkdirSync(join(cwd, ".codex", "prompts"), { recursive: true });
      writeFileSync(
        join(cwd, ".codex", "prompts", "inspect.md"),
        [
          "Target: $ARGUMENTS",
          "Success: !`printf inline-success`",
          "Failure: !`printf inline-failure >&2; exit 1`",
          "Silent failure: !`exit 1`",
          "",
        ].join("\n"),
      );
      let observedInput = "";
      const session = createSession({
        thread: {
          runStreamed: async (input: string) => {
            observedInput = input;
            return { events: (async function* () {})() };
          },
        },
      });

      await __testing.runPrompt(session, "/inspect src/index.ts");

      expect(observedInput).toContain("Target: src/index.ts");
      expect(observedInput).toContain("Success: inline-success");
      expect(observedInput).toContain("Failure: inline-failure");
      expect(observedInput).toContain("Silent failure: Command failed:");
    });
  });

  test("plain and unknown slash commands take the expected prompt paths", async () => {
    await withBridgeEnv(async ({ cwd }) => {
      mkdirSync(join(cwd, ".codex", "prompts"), { recursive: true });
      writeFileSync(join(cwd, ".codex", "prompts", "plain.md"), "Plain $ARGUMENTS\n");
      const observedInputs: string[] = [];
      const session = createSession({
        thread: {
          runStreamed: async (input: string) => {
            observedInputs.push(input);
            return { events: (async function* () {})() };
          },
        },
      });

      await __testing.runPrompt(session, "/plain value");
      await __testing.runPrompt(session, "/unknown value");

      expect(observedInputs).toEqual(["Plain value\n", "/unknown value"]);
    });
  });

  test("help explains when no prompt commands are installed", async () => {
    await withBridgeEnv(async () => {
      const session = createSession();

      await __testing.runPrompt(session, "/help");

      expect(session.messages.at(-1)?.content).toContain(
        "No Codex prompt commands were discovered in this environment.",
      );
    });
  });

  test("marks generated plan-mode assistant responses as plan reviews", async () => {
    const session = createSession({
      conversationMode: "plan",
      thread: {
        runStreamed: async () => ({
          events: (async function* () {
            yield {
              type: "item.completed",
              item: {
                id: "plan-answer",
                type: "agent_message",
                text: "Plan:\n1. Inspect the current flow.",
              },
            };
          })(),
        }),
      },
    });

    await __testing.runPrompt(session, "Plan the fix");

    const assistantMessage = session.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantMessage?.planReview).toBe(true);
  });

  test("does not mark Codex-native slash command responses as plan reviews", async () => {
    const session = createSession({
      conversationMode: "plan",
      thread: {
        runStreamed: async () => ({
          events: (async function* () {
            yield {
              type: "item.completed",
              item: {
                id: "goal-answer",
                type: "agent_message",
                text: "Goal set.",
              },
            };
          })(),
        }),
      },
    });

    await __testing.runPrompt(session, "/goal finish the release notes");

    const assistantMessage = session.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantMessage?.planReview).toBeUndefined();
  });

  test("message route preserves plan-review metadata from a completed plan turn", async () => {
    const session = createSession({
      id: "plan-route-session",
      conversationMode: "plan",
      thread: {
        runStreamed: async () => ({
          events: (async function* () {
            yield {
              type: "item.completed",
              item: {
                id: "plan-route-answer",
                type: "agent_message",
                text: "Plan:\n1. Inspect the current flow.",
              },
            };
          })(),
        }),
      },
    });
    __testing.sessions.set(session.id, session);

    const promptResponse = await app.request("/session/plan-route-session/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: "Plan the fix" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(promptResponse.status).toBe(202);
    await waitUntil(() => session.status === "idle");

    const messagesResponse = await app.request("/session/plan-route-session/messages");
    expect(messagesResponse.status).toBe(200);
    const body = await messagesResponse.json();
    const assistantMessage = body.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantMessage).toMatchObject({
      content: "Plan:\n1. Inspect the current flow.",
      planReview: true,
    });
  });

  test("missing rollout resume errors recover on a fresh thread with transcript context", async () => {
    let recoveryInput = "";
    const session = createSession({
      threadId: "old-thread",
      thread: {
        runStreamed: async () => {
          throw new Error(
            "Codex Exec exited with code 1: Reading prompt from stdin...\nError: thread/resume: thread/resume failed: no rollout found for thread id old-thread",
          );
        },
      },
      messages: [
        {
          id: "review-user",
          role: "user",
          content: "Review the implementation.",
          parts: [{ type: "text", content: "Review the implementation." }],
          createdAt: "2026-04-15T10:00:00.000Z",
        },
        {
          id: "review-assistant",
          role: "assistant",
          content: "Issue: add test coverage for the retry path.",
          parts: [{ type: "text", content: "Issue: add test coverage for the retry path." }],
          createdAt: "2026-04-15T10:01:00.000Z",
        },
      ],
    });

    __testing.setFreshThreadFactoryForTesting(() => ({
      runStreamed: async (input: string) => {
        recoveryInput = input;
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: "new-thread" };
            yield {
              type: "item.completed",
              item: { id: "recovered-item", type: "agent_message", text: "Recovered response" },
            };
            yield {
              type: "turn.completed",
              usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
            };
          })(),
        };
      },
    } as any));

    await __testing.runPrompt(session, "Please address all the above issues.");

    expect(session.threadId).toBe("new-thread");
    expect(session.status).toBe("idle");
    expect(recoveryInput).toContain("previous Codex thread could not be resumed");
    expect(recoveryInput).toContain("Issue: add test coverage for the retry path.");
    expect(recoveryInput).toContain("Please address all the above issues.");
    expect(
      session.messages.filter(
        (message: { role: string; content: string }) =>
          message.role === "user" && message.content === "Please address all the above issues.",
      ),
    ).toHaveLength(1);
    expect(
      session.messages.some(
        (message: { role: string; content: string }) =>
          message.role === "assistant" && message.content === "Recovered response",
      ),
    ).toBe(true);
  });

  test("missing rollout stream failure events recover on a fresh thread", async () => {
    let recoveryInput = "";
    const session = createSession({
      threadId: "old-thread",
      thread: {
        runStreamed: async () => ({
          events: (async function* () {
            yield {
              type: "turn.failed",
              error: {
                message: "thread/resume failed: no rollout found for thread id old-thread",
              },
            };
          })(),
        }),
      },
      messages: [
        {
          id: "previous-user",
          role: "user",
          content: "Original request",
          parts: [{ type: "text", content: "Original request" }],
          createdAt: "2026-04-15T10:00:00.000Z",
        },
      ],
    });

    __testing.setFreshThreadFactoryForTesting(() => ({
      runStreamed: async (input: string) => {
        recoveryInput = input;
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: "new-thread" };
            yield {
              type: "item.completed",
              item: { id: "recovered-item", type: "agent_message", text: "Recovered from event" },
            };
          })(),
        };
      },
    } as any));

    await __testing.runPrompt(session, "Continue after stream failure.");

    expect(session.threadId).toBe("new-thread");
    expect(session.status).toBe("idle");
    expect(recoveryInput).toContain("Original request");
    expect(
      session.messages.some(
        (message: { role: string; content: string }) =>
          message.role === "assistant" && message.content === "Recovered from event",
      ),
    ).toBe(true);
  });

  test("fresh thread recovery failures leave the session errored and clean up turn state", async () => {
    const session = createSession({
      threadId: "old-thread",
      thread: {
        runStreamed: async () => {
          throw new Error("thread/resume failed: no rollout found for thread id old-thread");
        },
      },
    });

    __testing.setFreshThreadFactoryForTesting(() => ({
      runStreamed: async () => {
        throw new Error("fresh thread failed");
      },
    } as any));

    await __testing.runPrompt(session, "Recover this prompt.");

    expect(session.threadId).toBeNull();
    expect(session.status).toBe("error");
    expect(session.error).toBe("fresh thread failed");
    expect(session.currentTurnId).toBeUndefined();
    expect(session.currentTurnStartedAt).toBeUndefined();
    expect(session.abortController).toBeUndefined();
  });

  test("resume recovery prompt trims long transcripts from the front", () => {
    const prompt = __testing.buildResumeRecoveryPromptForTesting(
      [
        {
          id: "long-message",
          role: "assistant",
          content: `START_MARKER${"x".repeat(41_000)}END_MARKER`,
          parts: [],
          createdAt: "2026-04-15T10:00:00.000Z",
        },
      ],
      "Current work",
    );

    expect(prompt).not.toContain("START_MARKER");
    expect(prompt).toContain("END_MARKER");
    expect(prompt).toContain("Current work");
  });

  test("resume recovery uses message part text when normalized content is empty", () => {
    const prompt = __testing.buildResumeRecoveryPromptForTesting(
      [
        {
          id: "parts-only",
          role: "assistant",
          content: "",
          parts: [
            { type: "thinking", content: "  reasoning from parts  " },
            { type: "text", content: "answer from parts" },
            { type: "tool-invocation" },
          ],
          createdAt: "2026-04-15T10:00:00.000Z",
        },
      ],
      "Continue the request",
    );

    expect(prompt).toContain("reasoning from parts\nanswer from parts");
    expect(prompt).toContain("Continue the request");
  });

  test("prompt route marks a session running before async execution starts", async () => {
    const session = createSession({
      id: "route-session",
      thread: {
        runStreamed: async () => ({
          events: (async function* () {
            await new Promise(() => {});
          })(),
        }),
      },
    });
    __testing.sessions.set(session.id, session);

    const firstResponse = await app.request("/session/route-session/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: "first prompt" }),
      headers: { "Content-Type": "application/json" },
    });
    const secondResponse = await app.request("/session/route-session/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: "second prompt" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(409);
    expect(session.status).toBe("running");
    session.abortController?.abort();
  });

  test("prompt route ignores stale async setup failures after a newer turn starts", async () => {
    let rejectPromptSetup: ((error: Error) => void) | undefined;
    __testing.setBeforePromptExecutionForTesting(
      () => new Promise<void>((_resolve, reject) => {
        rejectPromptSetup = reject;
      }),
    );

    const session = createSession({ id: "stale-route-session" });
    __testing.sessions.set(session.id, session);

    const response = await app.request("/session/stale-route-session/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: "first prompt" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(202);
    session.currentTurnId = "newer-turn";
    session.status = "running";
    session.error = undefined;

    rejectPromptSetup?.(new Error("setup failed after stale turn"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.status).toBe("running");
    expect(session.error).toBeUndefined();
    expect(session.currentTurnId).toBe("newer-turn");
  });

  test("prompt route records current async setup failures and clears accepted turn state", async () => {
    const originalConsoleError = console.error;
    console.error = () => {};
    __testing.setBeforePromptExecutionForTesting(() => {
      throw new Error("runtime setup failed");
    });
    const session = createSession({ id: "failed-route-session" });
    __testing.sessions.set(session.id, session);

    try {
      const response = await app.request("/session/failed-route-session/prompt", {
        method: "POST",
        body: JSON.stringify({ prompt: "first prompt" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(202);
      await waitUntil(() => session.status === "error");
      expect(session.error).toBe("runtime setup failed");
      expect(session.currentTurnId).toBeUndefined();
      expect(session.currentTurnStartedAt).toBeUndefined();
      expect(session.abortController).toBeUndefined();
      expect(session.pendingAttachments).toEqual([]);
    } finally {
      console.error = originalConsoleError;
      __testing.setBeforePromptExecutionForTesting(null);
    }
  });

  for (const [method, path] of [
    ["POST", "/session/missing/config"],
    ["GET", "/session/missing/messages"],
    ["GET", "/session/missing/status"],
    ["POST", "/session/missing/prompt"],
    ["POST", "/session/missing/abort"],
    ["DELETE", "/session/missing"],
  ] as const) {
    test(`${method} ${path} returns not found`, async () => {
      const response = await app.request(path, { method });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Session not found" });
    });
  }

  test("resume rejects missing and blank thread ids", async () => {
    for (const body of [{}, { threadId: "   " }]) {
      const response = await app.request("/session/resume", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "threadId is required" });
    }
  });

  test("config rejects updates while a session is running", async () => {
    const session = createSession({ id: "running-config", status: "running" });
    __testing.sessions.set(session.id, session);

    const response = await app.request("/session/running-config/config", {
      method: "POST",
      body: JSON.stringify({ mode: "plan" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Cannot update settings while session is running",
    });
    expect(session.conversationMode).toBe("build");
  });

  test("messages route rebuilds the current assistant message while running", async () => {
    const assistantMessage = {
      id: "assistant-running",
      role: "assistant",
      content: "",
      parts: [],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    const session = createSession({
      id: "running-messages",
      status: "running",
      currentAssistantMessageId: assistantMessage.id,
      currentItems: new Map([
        ["answer", { id: "answer", type: "agent_message", text: "Latest streamed text" }],
      ]),
      currentItemOrder: ["answer"],
      messages: [assistantMessage],
    });
    __testing.sessions.set(session.id, session);

    const response = await app.request("/session/running-messages/messages");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      messages: [{
        id: "assistant-running",
        content: "Latest streamed text",
        parts: [{ type: "text", content: "Latest streamed text" }],
      }],
    });
  });

  test("messages route reconciles the last assistant message after the turn becomes idle", async () => {
    const assistantMessage = {
      id: "assistant-idle",
      role: "assistant",
      content: "",
      parts: [],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    const session = createSession({
      id: "idle-messages",
      status: "idle",
      currentAssistantMessageId: assistantMessage.id,
      currentAssistantTurnStartedAt: "2026-04-15T10:00:00.000Z",
      currentItems: new Map([
        ["answer", { id: "answer", type: "agent_message", text: "Final response" }],
      ]),
      currentItemOrder: ["answer"],
      messages: [assistantMessage],
    });
    __testing.sessions.set(session.id, session);

    const response = await app.request("/session/idle-messages/messages");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      messages: [{
        id: "assistant-idle",
        content: "Final response",
        parts: [{ type: "text", content: "Final response" }],
      }],
    });
  });

  test("prompt route filters malformed attachments and accepts the valid image", async () => {
    let observedInput: unknown;
    const session = createSession({
      id: "attachment-session",
      thread: {
        runStreamed: async (input: unknown) => {
          observedInput = input;
          return { events: (async function* () {})() };
        },
      },
    });
    __testing.sessions.set(session.id, session);

    const response = await app.request("/session/attachment-session/prompt", {
      method: "POST",
      body: JSON.stringify({
        prompt: "Describe the image",
        attachments: [
          null,
          {},
          { type: "file", path: "/tmp/not-an-image.txt" },
          { type: "image", path: 42 },
          {
            type: "image",
            path: "/tmp/valid.png",
            filename: "valid.png",
            dataUrl: "data:image/png;base64,AA==",
          },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(202);
    await waitUntil(() => session.status === "idle");
    expect(observedInput).toEqual([
      { type: "text", text: "Describe the image" },
      { type: "local_image", path: "/tmp/valid.png" },
    ]);
    expect(session.messages[0]?.parts).toEqual([
      {
        type: "text",
        content: "Describe the image",
      },
      {
        type: "file",
        content: "valid.png",
        fileUrl: "data:image/png;base64,AA==",
      },
    ]);

    const invalidOnlyResponse = await app.request("/session/attachment-session/prompt", {
      method: "POST",
      body: JSON.stringify({
        prompt: "",
        attachments: [{ type: "file", path: "/tmp/not-an-image.txt" }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(invalidOnlyResponse.status).toBe(400);
    expect(await invalidOnlyResponse.json()).toEqual({
      error: "Prompt or image attachment is required",
    });
  });

  test("delete aborts and removes an active session", async () => {
    const abortController = new AbortController();
    let stopCount = 0;
    const session = createSession({
      id: "active-delete",
      status: "running",
      abortController,
      subagentRefreshController: {
        refreshNow: async () => {},
        markParentSettled: () => {},
        stop: () => { stopCount += 1; },
        isStopped: () => false,
      },
    });
    __testing.sessions.set(session.id, session);

    const response = await app.request("/session/active-delete", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "deleted" });
    expect(abortController.signal.aborted).toBe(true);
    expect(stopCount).toBe(1);
    expect(__testing.sessions.has(session.id)).toBe(false);
  });

  test("idle cleanup stops transcript watchers before compacting sessions", () => {
    let stopCount = 0;
    const session = createRestorableStaleSession("watched-stale-session");
    session.subagentRefreshController = {
      refreshNow: async () => {},
      markParentSettled: () => {},
      stop: () => { stopCount += 1; },
      isStopped: () => false,
    };
    __testing.sessions.set(session.id, session);

    __testing.cleanupIdleSessions();

    expect(stopCount).toBe(1);
    expect(__testing.sessions.has(session.id)).toBe(false);
    expect(__testing.expiredSessions.has(session.id)).toBe(true);
  });

  test("idle cleanup compacts sessions that can be restored by the same session id", async () => {
    compactStaleSession("stale-session");

    const response = await app.request("/session/stale-session/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "idle",
      title: "Stale session",
    });
    expect(__testing.sessions.has("stale-session")).toBe(true);
    expect(__testing.expiredSessions.has("stale-session")).toBe(false);
  });

  test("restored compacted sessions preserve messages and accept config updates", async () => {
    compactStaleSession("message-session");

    const messagesResponse = await app.request("/session/message-session/messages");

    expect(messagesResponse.status).toBe(200);
    expect(await messagesResponse.json()).toMatchObject({
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Previous prompt",
        },
      ],
    });

    const configResponse = await app.request("/session/message-session/config", {
      method: "POST",
      body: JSON.stringify({
        mode: "plan",
        fastMode: true,
        modelReasoningEffort: "ultra",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toEqual({ status: "updated" });
    expect(__testing.sessions.get("message-session")?.conversationMode).toBe("plan");
    expect(__testing.sessions.get("message-session")?.fastMode).toBe(true);
    expect(
      __testing.sessions.get("message-session")?.threadOptions.modelReasoningEffort,
    ).toBe("ultra");
  });

  test("prompt and abort routes restore compacted sessions before handling requests", async () => {
    compactStaleSession("prompt-session");

    const promptResponse = await app.request("/session/prompt-session/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: "" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(promptResponse.status).toBe(400);
    expect(__testing.sessions.has("prompt-session")).toBe(true);
    expect(__testing.expiredSessions.has("prompt-session")).toBe(false);

    compactStaleSession("abort-restored-session");

    const abortResponse = await app.request("/session/abort-restored-session/abort", {
      method: "POST",
    });

    expect(abortResponse.status).toBe(200);
    expect(await abortResponse.json()).toEqual({ status: "aborted" });
    expect(__testing.sessions.has("abort-restored-session")).toBe(true);
    expect(__testing.expiredSessions.has("abort-restored-session")).toBe(false);
  });

  test("delete removes compacted sessions without restoring them", async () => {
    compactStaleSession("delete-session");

    const response = await app.request("/session/delete-session", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "deleted" });
    expect(__testing.sessions.has("delete-session")).toBe(false);
    expect(__testing.expiredSessions.has("delete-session")).toBe(false);
  });

  test("idle cleanup removes compacted sessions retained for more than one week", () => {
    compactStaleSession("old-compacted-session");
    compactStaleSession("recent-compacted-session");

    __testing.expiredSessions.get("old-compacted-session").compactedAt =
      Date.now() - __testing.EXPIRED_SESSION_RETENTION_MS - 60_000;
    __testing.expiredSessions.get("recent-compacted-session").compactedAt =
      Date.now() - __testing.EXPIRED_SESSION_RETENTION_MS + 60_000;

    __testing.cleanupIdleSessions();

    expect(__testing.expiredSessions.has("old-compacted-session")).toBe(false);
    expect(__testing.expiredSessions.has("recent-compacted-session")).toBe(true);
  });

  test("global routes return health, models, and slash commands", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      mkdirSync(join(cwd, ".codex", "prompts"), { recursive: true });
      writeFileSync(
        join(cwd, ".codex", "prompts", "review.md"),
        [
          "---",
          "description: Review the current branch",
          "argument_hint: <target>",
          "---",
          "Review $ARGUMENTS",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(codexHome, "models_cache.json"),
        JSON.stringify({
          models: [
            {
              slug: "test-codex-model",
              display_name: "Test Codex Model",
              supported_in_api: true,
            },
          ],
        }),
      );

      const healthResponse = await app.request("/global/health");
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({ status: "ok", version: "1.0.0" });

      const modelsResponse = await app.request("/global/models");
      expect(modelsResponse.status).toBe(200);
      const modelsBody = await modelsResponse.json();
      expect(modelsBody.models.length).toBeGreaterThan(0);
      expect(["cache", "fallback"]).toContain(modelsBody.source);

      const commandsResponse = await app.request("/global/slash-commands");
      expect(commandsResponse.status).toBe(200);
      expect(await commandsResponse.json()).toMatchObject({
        cwd,
        commands: expect.arrayContaining([
          expect.objectContaining({ name: "/goal", source: "builtin" }),
          expect.objectContaining({ name: "/help", source: "builtin" }),
          expect.objectContaining({ name: "/models", source: "builtin" }),
          expect.objectContaining({
            name: "/review",
            description: "Review the current branch",
            argumentHint: "<target>",
            source: "prompt",
          }),
        ]),
      });
    });
  });

  test("rejects stale bridge model caches and writes the current version", async () => {
    await withBridgeEnv(async ({ codexHome }) => {
      const cacheDir = join(codexHome, "orkestrator-bridge");
      const cachePath = join(cacheDir, "models-cache.json");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachePath, JSON.stringify({
        version: __testing.BRIDGE_MODEL_CACHE_VERSION - 1,
        models: [{ id: "stale", name: "Stale" }],
      }));

      await expect(__testing.readPersistedBridgeCache()).resolves.toBeNull();

      const models: BridgeModel[] = [{
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        reasoningEfforts: ["max", "ultra"],
        reasoningOptions: [
          { effort: "max", label: "Max" },
          { effort: "ultra", label: "Ultra" },
        ],
        defaultReasoningEffort: "max",
      }];
      await __testing.writePersistedBridgeCache(models);

      const persisted = JSON.parse(readFileSync(cachePath, "utf8"));
      expect(persisted.version).toBe(__testing.BRIDGE_MODEL_CACHE_VERSION);
      expect(persisted.models).toEqual(models);
      await expect(__testing.readPersistedBridgeCache()).resolves.toEqual(models);
    });
  });

  test("model cache persistence contains malformed reads and write failures", async () => {
    await withBridgeEnv(async ({ codexHome }) => {
      const cacheDir = join(codexHome, "orkestrator-bridge");
      const cachePath = join(cacheDir, "models-cache.json");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachePath, "{not-json");
      await expect(__testing.readPersistedBridgeCache()).resolves.toBeNull();

      rmSync(cacheDir, { recursive: true, force: true });
      writeFileSync(cacheDir, "blocks directory creation");
      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args); };
      try {
        await expect(__testing.writePersistedBridgeCache([])).resolves.toBeUndefined();
      } finally {
        console.warn = originalWarn;
      }
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.[0]).toBe("[codex-bridge] Failed to persist model cache:");
    });
  });

  test("buildThreadOptions accepts new efforts and rejects unknown values", () => {
    expect(__testing.buildThreadOptions({ modelReasoningEffort: "max" }).modelReasoningEffort)
      .toBe("max");
    expect(__testing.buildThreadOptions({ modelReasoningEffort: "ultra" }).modelReasoningEffort)
      .toBe("ultra");
    expect(__testing.buildThreadOptions({ modelReasoningEffort: "turbo" }).modelReasoningEffort)
      .toBeUndefined();
  });

  test("buildThreadOptions normalizes model, mode, and working-directory defaults", () => {
    const previousCwd = process.env.CWD;
    process.env.CWD = "/tmp/codex-bridge-working-directory";
    try {
      expect(__testing.buildThreadOptions({ mode: "plan", model: "  gpt-test  " }))
        .toEqual(expect.objectContaining({
          workingDirectory: "/tmp/codex-bridge-working-directory",
          approvalPolicy: "never",
          sandboxMode: "read-only",
          networkAccessEnabled: true,
          model: "gpt-test",
        }));
      expect(__testing.buildThreadOptions({ mode: "invalid", model: "   " }))
        .toEqual(expect.objectContaining({
          sandboxMode: "danger-full-access",
          model: undefined,
        }));
    } finally {
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
    }
  });

  test("routes use safe defaults for malformed JSON request bodies", async () => {
    const createResponse = await app.request("/session/create", {
      method: "POST",
      body: "{not-json",
      headers: { "Content-Type": "application/json" },
    });
    expect(createResponse.status).toBe(201);
    const { sessionId } = await createResponse.json();
    expect(__testing.sessions.get(sessionId)).toMatchObject({
      conversationMode: "build",
      fastMode: false,
      threadOptions: expect.objectContaining({ sandboxMode: "danger-full-access" }),
    });

    const configResponse = await app.request(`/session/${sessionId}/config`, {
      method: "POST",
      body: "{not-json",
      headers: { "Content-Type": "application/json" },
    });
    expect(configResponse.status).toBe(200);
    expect(__testing.sessions.get(sessionId)).toMatchObject({
      conversationMode: "build",
      fastMode: false,
      threadOptions: expect.objectContaining({ sandboxMode: "danger-full-access" }),
    });

    const promptResponse = await app.request(`/session/${sessionId}/prompt`, {
      method: "POST",
      body: "{not-json",
      headers: { "Content-Type": "application/json" },
    });
    expect(promptResponse.status).toBe(400);
    expect(await promptResponse.json()).toEqual({
      error: "Prompt or image attachment is required",
    });

    const resumeResponse = await app.request("/session/resume", {
      method: "POST",
      body: "{not-json",
      headers: { "Content-Type": "application/json" },
    });
    expect(resumeResponse.status).toBe(400);
    expect(await resumeResponse.json()).toEqual({ error: "threadId is required" });
  });

  test("session discovery falls back to archived transcripts and hydration skips invalid records", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      const archivedDir = join(codexHome, "archived_sessions");
      mkdirSync(archivedDir, { recursive: true });
      writeFileSync(
        join(archivedDir, "archived-thread.jsonl"),
        [
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: "archived-thread",
              cwd,
              timestamp: "2026-04-15T09:00:00.000Z",
            },
          }),
          "not-json",
          JSON.stringify({ type: "response_item", payload: { type: "message", role: "tool" } }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-04-15T09:00:30.000Z",
            payload: {
              type: "message",
              role: "user",
              content: [{
                type: "input_text",
                text: "<recommended_plugins>\nHere is a list of plugins that are available but not installed.",
              }],
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-04-15T09:01:00.000Z",
            payload: {
              type: "message",
              role: "user",
              content: [{
                type: "input_text",
                text: "# AGENTS.md instructions for /tmp/untrusted",
              }],
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-04-15T09:02:00.000Z",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Real archived prompt" }],
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-04-15T09:03:00.000Z",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Real archived answer" }],
            },
          }),
          "",
        ].join("\n"),
      );

      const listResponse = await app.request("/session/list");
      expect(listResponse.status).toBe(200);
      expect(await listResponse.json()).toMatchObject({
        sessions: [{
          id: "archived-thread",
          updatedAt: "2026-04-15T09:00:00.000Z",
        }],
      });

      const resumeResponse = await app.request("/session/resume", {
        method: "POST",
        body: JSON.stringify({ threadId: "archived-thread" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(resumeResponse.status).toBe(201);
      const resumeBody = await resumeResponse.json();
      expect(resumeBody.messages.map((message: { content: string }) => message.content)).toEqual([
        "Real archived prompt",
        "Real archived answer",
      ]);
    });
  });

  test("session discovery skips malformed metadata and resolves index aliases and orphan transcripts", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      const sessionsDir = join(codexHome, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        join(codexHome, "session_index.jsonl"),
        [
          "not-json",
          JSON.stringify({ thread_name: "Missing id" }),
          JSON.stringify({
            id: "alias-thread",
            thread_name: "Alias title",
            updated_at: "2026-04-16T10:00:00.000Z",
          }),
          JSON.stringify({
            id: "missing-transcript",
            thread_name: "Missing transcript",
            updated_at: "2026-04-16T11:00:00.000Z",
          }),
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(sessionsDir, "no-session-meta.jsonl"),
        `${JSON.stringify({ type: "response_item", payload: { type: "message" } })}\n`,
      );
      writeFileSync(
        join(sessionsDir, "empty-id.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "", cwd } })}\n`,
      );
      writeFileSync(
        join(sessionsDir, "rollout-alias-thread.jsonl"),
        `${JSON.stringify({
          type: "session_meta",
          payload: {
            id: "canonical-thread",
            cwd,
            timestamp: "2026-04-16T12:00:00.000Z",
          },
        })}\n`,
      );
      writeFileSync(
        join(sessionsDir, "rollout-orphan-thread.jsonl"),
        `${JSON.stringify({
          type: "response_item",
          timestamp: "2026-04-16T13:00:00.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Recovered without metadata" }],
          },
        })}\n`,
      );

      const listResponse = await app.request("/session/list");
      expect(listResponse.status).toBe(200);
      expect(await listResponse.json()).toMatchObject({
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: "alias-thread", title: "Alias title" }),
          expect.objectContaining({ id: "canonical-thread" }),
        ]),
      });

      const resumeResponse = await app.request("/session/resume", {
        method: "POST",
        body: JSON.stringify({ threadId: "orphan-thread" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(resumeResponse.status).toBe(201);
      expect(await resumeResponse.json()).toMatchObject({
        threadId: "orphan-thread",
        messages: [
          expect.objectContaining({ content: "Recovered without metadata" }),
        ],
      });
    });
  });

  test("session discovery derives titles from the first user prompt when Codex has no name", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      writeRollout(codexHome, "unnamed-thread", [
        {
          type: "session_meta",
          payload: {
            id: "unnamed-thread",
            cwd,
            timestamp: "2026-07-17T10:00:00.000Z",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "# AGENTS.md instructions for /workspace\nInternal repository guidance",
            }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "<recommended_plugins>\nHere is a list of plugins that are available but not installed.",
            }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "Investigate why background Codex sessions lose their status updates",
            }],
          },
        },
      ]);

      const response = await app.request("/session/list");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        sessions: [expect.objectContaining({
          id: "unnamed-thread",
          title: "Investigate why background Codex sessions lose their",
        })],
      });
    });
  });

  test("generates and persists an AI title after the first prompt", async () => {
    await withBridgeEnv(async ({ codexHome }) => {
      const events: unknown[] = [];
      const session = createSession({
        id: "generated-title-session",
        thread: {
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: "thread.started", thread_id: "generated-title-thread" };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              };
            })(),
          }),
        },
      });
      __testing.sessions.set(session.id, session);
      __testing.setSessionTitleGeneratorForTesting(async () => "Improve Codex session names");
      const unsubscribe = __testing.subscribeForTesting((event: unknown) => {
        events.push(event);
      });

      try {
        await __testing.runPrompt(session, "Show useful names instead of hashes");
        await waitUntil(() => session.title === "Improve Codex session names");
      } finally {
        unsubscribe();
      }

      expect(events).toContainEqual({
        type: "session.title-updated",
        sessionId: session.id,
        data: { title: "Improve Codex session names" },
      });
      const persisted = readFileSync(
        join(codexHome, "orkestrator-bridge", "session-titles.jsonl"),
        "utf8",
      );
      expect(persisted).toContain('"threadId":"generated-title-thread"');
      expect(persisted).toContain('"title":"Improve Codex session names"');
    });
  });

  test("generated titles survive list, resume, and status while Codex names retain precedence", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      const records = [
        {
          type: "session_meta",
          payload: {
            id: "generated-round-trip",
            cwd,
            timestamp: "2026-07-17T10:00:00.000Z",
          },
        },
        {
          type: "response_item",
          timestamp: "2026-07-17T10:01:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fallback prompt title" }],
          },
        },
      ];
      writeRollout(codexHome, "generated-round-trip", records);
      await persistSessionTitle(
        codexHome,
        "generated-round-trip",
        "Generated round trip title",
        { source: "generated" },
      );

      const listResponse = await app.request("/session/list");
      expect(await listResponse.json()).toMatchObject({
        sessions: [expect.objectContaining({
          id: "generated-round-trip",
          title: "Generated round trip title",
        })],
      });
      const resumeResponse = await app.request("/session/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: "generated-round-trip" }),
      });
      const resumed = await resumeResponse.json() as { sessionId: string; title: string };
      expect(resumed.title).toBe("Generated round trip title");
      const statusResponse = await app.request(`/session/${resumed.sessionId}/status`);
      expect(await statusResponse.json()).toMatchObject({
        status: "idle",
        title: "Generated round trip title",
      });

      writeFileSync(
        join(codexHome, "session_index.jsonl"),
        `${JSON.stringify({
          id: "generated-round-trip",
          thread_name: "Codex authoritative title",
          updated_at: "2026-07-17T10:02:00.000Z",
        })}\n`,
      );
      const codexList = await app.request("/session/list");
      expect(await codexList.json()).toMatchObject({
        sessions: [expect.objectContaining({ title: "Codex authoritative title" })],
      });
      const codexResume = await app.request("/session/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: "generated-round-trip" }),
      });
      expect(await codexResume.json()).toMatchObject({ title: "Codex authoritative title" });
    });
  });

  test("a local help response remains eligible for one substantive title generation", async () => {
    await withBridgeEnv(async ({ codexHome }) => {
      const prompts: string[] = [];
      let threadCounter = 0;
      const session = createSession({
        id: "help-title-session",
        thread: {
          runStreamed: async () => ({
            events: (async function* () {
              threadCounter += 1;
              yield { type: "thread.started", thread_id: `help-title-thread-${threadCounter}` };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              };
            })(),
          }),
        },
      });
      __testing.sessions.set(session.id, session);
      __testing.setSessionTitleGeneratorForTesting(async (prompt: string) => {
        prompts.push(prompt);
        return "Generated substantive title";
      });

      await __testing.runPrompt(session, "/help");
      expect(session.title).toBe("/help");
      expect(session.titleSource).toBe("prompt");
      expect(prompts).toEqual([]);

      await __testing.runPrompt(session, "Investigate the background lifecycle");
      await waitUntil(() => session.title === "Generated substantive title");
      await __testing.runPrompt(session, "Continue the investigation");

      expect(prompts).toEqual(["Investigate the background lifecycle"]);
      expect(session.titleSource).toBe("generated");
      expect(Array.from((await readPersistedSessionTitles(codexHome)).values()))
        .toContain("Generated substantive title");
    });
  });

  test("explicit titles are never replaced by generated titles", async () => {
    const prompts: string[] = [];
    const session = createSession({
      id: "explicit-title-session",
      title: "Explicit title",
      titleSource: "explicit",
      titleGenerationAttempted: true,
      thread: {
        runStreamed: async () => ({
          events: (async function* () {
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
              },
            };
          })(),
        }),
      },
    });
    __testing.sessions.set(session.id, session);
    __testing.setSessionTitleGeneratorForTesting(async (prompt: string) => {
      prompts.push(prompt);
      return "Unexpected generated title";
    });

    await __testing.runPrompt(session, "Do work");
    expect(prompts).toEqual([]);
    expect(session.title).toBe("Explicit title");
  });

  test("stale title completion cannot mutate, persist, or emit after session replacement", async () => {
    await withBridgeEnv(async ({ codexHome }) => {
      let resolveTitle!: (title: string) => void;
      const generated = new Promise<string>((resolve) => {
        resolveTitle = resolve;
      });
      const events: unknown[] = [];
      const session = createSession({
        id: "stale-title-session",
        thread: {
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: "thread.started", thread_id: "stale-title-thread" };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              };
            })(),
          }),
        },
      });
      const replacement = createSession({ id: session.id, title: "Replacement title" });
      __testing.sessions.set(session.id, session);
      __testing.setSessionTitleGeneratorForTesting(() => generated);
      const unsubscribe = __testing.subscribeForTesting((event: unknown) => events.push(event));
      try {
        await __testing.runPrompt(session, "Original prompt fallback");
        __testing.sessions.set(session.id, replacement);
        resolveTitle("Stale generated title");
        await Bun.sleep(0);
      } finally {
        unsubscribe();
      }

      expect(session.title).toBe("Original prompt fallback");
      expect(replacement.title).toBe("Replacement title");
      expect(await readPersistedSessionTitles(codexHome)).toEqual(new Map());
      expect(events).not.toContainEqual(expect.objectContaining({
        type: "session.title-updated",
        data: { title: "Stale generated title" },
      }));
    });
  });

  test("generation after thread start persists the generated title", async () => {
    await withBridgeEnv(async ({ codexHome }) => {
      let resolveTitle!: (title: string) => void;
      const generated = new Promise<string>((resolve) => {
        resolveTitle = resolve;
      });
      const stream = createStreamController();
      const session = createSession({
        id: "late-title-session",
        thread: { runStreamed: async () => ({ events: stream.events() }) },
      });
      __testing.sessions.set(session.id, session);
      __testing.setSessionTitleGeneratorForTesting(() => generated);

      const promptRun = __testing.runPrompt(session, "Late generated title prompt");
      stream.push({ type: "thread.started", thread_id: "late-title-thread" });
      await waitUntil(() => session.threadId === "late-title-thread");
      resolveTitle("Late generated title");
      await waitUntil(() => session.title === "Late generated title");
      stream.push({
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      });
      await promptRun;
      await waitUntil(() => existsSync(
        join(codexHome, "orkestrator-bridge", "session-titles.jsonl"),
      ));

      expect(await readPersistedSessionTitles(codexHome)).toEqual(new Map([
        ["late-title-thread", "Late generated title"],
      ]));
    });
  });

  test("generation rejection preserves the fallback and is attempted only once", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    let attempts = 0;
    const session = createSession({ id: "rejected-title-session" });
    __testing.sessions.set(session.id, session);
    __testing.setSessionTitleGeneratorForTesting(async () => {
      attempts += 1;
      throw new Error("model unavailable");
    });
    try {
      await __testing.runPrompt(session, "Keep this fallback title");
      await Bun.sleep(0);
      await __testing.runPrompt(session, "Do not retry title generation");
    } finally {
      console.warn = originalWarn;
    }

    expect(attempts).toBe(1);
    expect(session.title).toBe("Keep this fallback title");
    expect(warnings).toContainEqual([
      "[codex-bridge] Failed to generate session title; using prompt fallback",
    ]);
  });

  test("title persistence failures are contained without failing the prompt", async () => {
    await withBridgeEnv(async ({ codexHome }) => {
      writeFileSync(join(codexHome, "orkestrator-bridge"), "blocked");
      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args);
      const session = createSession({
        id: "persistence-failure-session",
        title: "Explicit persisted title",
        titleSource: "explicit",
        titleGenerationAttempted: true,
        thread: {
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: "thread.started", thread_id: "persistence-failure-thread" };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              };
            })(),
          }),
        },
      });
      __testing.sessions.set(session.id, session);
      try {
        await expect(__testing.runPrompt(session, "Continue safely")).resolves.toBeUndefined();
      } finally {
        console.warn = originalWarn;
      }
      expect(session.status).toBe("idle");
      expect(warnings).toContainEqual([
        "[codex-bridge] Failed to persist session title:",
        expect.any(Error),
      ]);
    });
  });

  test("session create, list, and resume routes cover persisted sessions", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      writePersistedThread(codexHome, cwd, "thread-1");

      const createResponse = await app.request("/session/create", {
        method: "POST",
        body: JSON.stringify({ title: "New session", mode: "plan", fastMode: true }),
        headers: { "Content-Type": "application/json" },
      });

      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      expect(createBody.title).toBe("New session");
      expect(typeof createBody.sessionId).toBe("string");
      expect(__testing.sessions.get(createBody.sessionId)?.conversationMode).toBe("plan");
      expect(__testing.sessions.get(createBody.sessionId)?.fastMode).toBe(true);

      const listResponse = await app.request("/session/list");

      expect(listResponse.status).toBe(200);
      expect(await listResponse.json()).toMatchObject({
        cwd,
        sessions: [
          {
            id: "thread-1",
            title: "Saved session",
            updatedAt: "2026-04-15T10:30:00.000Z",
          },
        ],
      });

      const resumeResponse = await app.request("/session/resume", {
        method: "POST",
        body: JSON.stringify({ threadId: "thread-1", mode: "plan" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(resumeResponse.status).toBe(201);
      const resumeBody = await resumeResponse.json();
      expect(resumeBody.threadId).toBe("thread-1");
      expect(resumeBody.messages.map((message: { content: string }) => message.content)).toEqual([
        "Saved prompt",
        "Saved answer",
      ]);
      expect(resumeBody.messages.map((message: { planReview?: boolean }) => message.planReview)).toEqual([
        undefined,
        undefined,
      ]);
      expect(__testing.sessions.get(resumeBody.sessionId)?.conversationMode).toBe("plan");
    });
  });

  test("event subscription route delivers updates and removes aborted subscribers", async () => {
    const controller = new AbortController();
    const response = await app.request("/event/subscribe", {
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const firstChunk = await reader!.read();
      const text = new TextDecoder().decode(firstChunk.value);

      expect(firstChunk.done).toBe(false);
      expect(text).toContain("event: connected");
      expect(text).toContain('"status":"connected"');
      await waitUntil(() => __testing.getSubscriberCountForTesting() === 1);

      __testing.emitForTesting({
        type: "session.idle",
        sessionId: "event-session",
        data: { title: "Finished" },
      });
      const updateChunk = await reader!.read();
      const updateText = new TextDecoder().decode(updateChunk.value);
      expect(updateText).toContain("event: session.idle");
      expect(updateText).toContain('"sessionId":"event-session"');
      expect(updateText).toContain('"title":"Finished"');
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await waitUntil(() => __testing.getSubscriberCountForTesting() === 0);
    }
  });

  test("SSE keepalive scheduler writes timestamped keepalive events", async () => {
    const events: Array<{ event: string; data: string }> = [];
    const timer = __testing.startSseKeepaliveForTesting(async (event) => {
      events.push(event);
    }, 1);

    try {
      await waitUntil(() => events.length > 0);
    } finally {
      clearInterval(timer);
    }

    expect(events[0]?.event).toBe("keepalive");
    expect(JSON.parse(events[0]!.data)).toEqual({
      timestamp: expect.any(String),
    });
  });

  test("SSE keepalive scheduler contains write failures", async () => {
    const errors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    const timer = __testing.startSseKeepaliveForTesting(
      async () => Promise.reject(new Error("stream closed")),
      1,
    );

    try {
      await waitUntil(() => errors.length > 0);
    } finally {
      clearInterval(timer);
      console.error = originalConsoleError;
    }

    expect(errors[0]?.[0]).toBe("[codex-bridge] Failed to write SSE keepalive:");
    expect(errors[0]?.[1]).toBeInstanceOf(Error);
  });

  test("raw stream logging sanitizes filenames and contains log I/O failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "orkestrator-codex-raw-log-test-"));
    const rawLogDir = join(root, "raw-logs");
    const bridgeRoot = join(import.meta.dir, "..");
    const script = [
      'process.env.CODEX_BRIDGE_NO_SERVER = "1";',
      'const { __testing } = await import("./src/index.ts");',
      'const circular = { type: "unknown.event" };',
      'circular.self = circular;',
      'const session = {',
      '  id: "../unsafe/session", conversationMode: "build", fastMode: false,',
      '  thread: { runStreamed: async () => ({ events: (async function* () {',
      '    yield circular;',
      '  })() }) },',
      '  threadOptions: {}, threadId: null, messages: [], status: "idle",',
      '  currentItems: new Map(), currentItemOrder: [], pendingAttachments: [],',
      '  lastAccessed: Date.now(),',
      '};',
      'await __testing.runPrompt(session, "log this");',
      'process.exit(0);',
    ].join("\n");

    try {
      const logged = spawnSync(process.execPath, ["-e", script], {
        cwd: bridgeRoot,
        env: {
          ...process.env,
          CODEX_BRIDGE_NO_SERVER: "1",
          ORKESTRATOR_CODEX_RAW_LOG_DIR: rawLogDir,
        },
        encoding: "utf8",
      });
      expect(logged.status).toBe(0);
      const logPath = join(rawLogDir, ".._unsafe_session.jsonl");
      const entries = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries.map((entry) => entry.kind)).toEqual([
        "stream.start",
        "stream.event",
      ]);
      expect(entries[1]).toMatchObject({
        sessionId: "../unsafe/session",
        eventType: "unknown.event",
        event: "[object Object]",
      });

      const blockedPath = join(root, "not-a-directory");
      writeFileSync(blockedPath, "occupied");
      const failed = spawnSync(process.execPath, ["-e", script], {
        cwd: bridgeRoot,
        env: {
          ...process.env,
          CODEX_BRIDGE_NO_SERVER: "1",
          ORKESTRATOR_CODEX_RAW_LOG_DIR: blockedPath,
        },
        encoding: "utf8",
      });
      expect(failed.status).toBe(0);
      expect(failed.stderr).toContain("[codex-bridge] Failed to write raw Codex log:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
