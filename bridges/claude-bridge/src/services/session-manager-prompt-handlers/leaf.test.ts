import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionState, SSEEvent } from "../../types/index.js";
import { eventEmitter } from "../event-emitter.js";
import { sessions } from "../session-manager-core.js";
import { createPromptStreamState } from "../session-manager-prompt-stream.js";
import {
  captureTurnStartup,
  createTurnState,
  type TurnState,
} from "../session-manager-prompt-turn.js";
import { leafMessageHandler } from "./leaf.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const session = {
    id: "session-leaf",
    messages: [],
    status: "running",
    createdAt: new Date(),
    lastActivity: new Date(),
  } as unknown as SessionState;
  const stream = createPromptStreamState(session, session.id, {
    flushIntervalMs: 100,
    maxBlockIndex: 4_095,
  });
  cleanups.push(() => stream.clearFlushTimer());
  const turn = createTurnState(session, session.id, {
    dispatchRequestId: undefined,
    retainedContinuationTimeoutMs: undefined,
    beforeStartup: captureTurnStartup(session),
    abortController: new AbortController(),
    turnGeneration: 1,
    stream,
    bootstrapClaudeUsage: false,
    transcriptHydrationFailed: false,
  });
  return { session, turn };
}

function dispatch(turn: TurnState, message: Record<string, unknown>): SSEEvent[] {
  const handler = leafMessageHandler(message.type);
  if (!handler) throw new Error(`no leaf handler for ${String(message.type)}`);
  const events: SSEEvent[] = [];
  const stop = eventEmitter.subscribe((event) => events.push(event));
  try {
    void handler(turn, message as unknown as SDKMessage);
  } finally {
    stop();
  }
  return events;
}

describe("leaf message handlers", () => {
  test.each([
    "system",
    "assistant",
    "user",
    "result",
    "command_lifecycle",
    "constructor",
    "toString",
    undefined,
  ])("%p is left to the rest of the dispatch", (type) => {
    expect(leafMessageHandler(type)).toBeUndefined();
  });

  test.each([
    ["  try the tests  ", "try the tests"],
    ["   ", undefined],
  ])("prompt_suggestion %p records %p", (suggestion, expected) => {
    const { session, turn } = fixture();
    const events = dispatch(turn, { type: "prompt_suggestion", suggestion });
    expect(session.promptSuggestion).toBe(expected);
    expect(events).toEqual(
      expected
        ? [
            {
              type: "session.updated",
              sessionId: session.id,
              data: { promptSuggestion: expected },
            },
          ]
        : [],
    );
  });

  test.each([
    [{ type: "tool_use_summary", summary: " Ran the suite " }, "Ran the suite", "info"],
    [
      { type: "auth_status", isAuthenticating: false, output: [], error: "expired" },
      "Claude authentication failed: expired",
      "error",
    ],
    [
      { type: "conversation_reset", trigger: "clear" },
      "Conversation cleared with /clear. The agent no longer has the earlier history.",
      "warning",
    ],
    [
      { type: "conversation_reset", trigger: "constructor" },
      "Conversation cleared. The agent no longer has the earlier history.",
      "warning",
    ],
  ])("%p appends one status row", (message, content, severity) => {
    const { session, turn } = fixture();
    session.messages.push({
      id: "earlier",
      role: "user",
      content: "hi",
      parts: [{ type: "text", content: "hi" }],
      createdAt: new Date().toISOString(),
    });
    const events = dispatch(turn, message);
    const rows =
      message.type === "conversation_reset" ? session.messages : session.messages.slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "system",
      parts: [{ type: "status", content, severity }],
    });
    expect(events.map((event) => event.type)).toEqual(["message.updated"]);
  });

  test("rate_limit_event merges the window and asks for a structured refresh", () => {
    const { session, turn } = fixture();
    const trigger = mock(async () => {});
    turn.structuredUsageRefresh = { trigger } as unknown as typeof turn.structuredUsageRefresh;
    const events = dispatch(turn, {
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "five_hour", utilization: 0.5 },
    });
    expect(session.rateLimits?.length).toBe(1);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "session.updated", sessionId: session.id, data: { rateLimits: session.rateLimits } },
    ]);
  });

  test.each([
    ["message_start", "running"],
    ["ping", "idle"],
  ])("stream_event %p on a released turn leaves the session %p", (eventType, status) => {
    const { session, turn } = fixture();
    sessions.set(session.id, session);
    cleanups.push(() => sessions.delete(session.id));
    session.status = "idle";
    session.latestTurnGeneration = turn.turnGeneration;
    turn.turnReleasedToBackgroundTasks = true;
    dispatch(turn, { type: "stream_event", event: { type: eventType }, parent_tool_use_id: null });
    expect(session.status as string).toBe(status);
    expect(session.abortController).toBe(status === "running" ? turn.abortController : undefined);
  });

  test("tool_progress for a call no row holds changes nothing", () => {
    const { session, turn } = fixture();
    const events = dispatch(turn, {
      type: "tool_progress",
      tool_use_id: "toolu_unknown",
      tool_name: "Bash",
      elapsed_time_seconds: 3,
    });
    expect(session.messages).toEqual([]);
    expect(events).toEqual([]);
  });
});
