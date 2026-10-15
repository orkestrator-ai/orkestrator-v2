import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionState, SSEEvent } from "../../types/index.js";
import { eventEmitter } from "../event-emitter.js";
import { createPromptStreamState } from "../session-manager-prompt-stream.js";
import { captureTurnStartup, createTurnState } from "../session-manager-prompt-turn.js";
import type { PromptMessageContext } from "./context.js";
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
    beforeStartup: captureTurnStartup(session),
    abortController: new AbortController(),
    turnGeneration: 1,
    stream,
    bootstrapClaudeUsage: false,
    transcriptHydrationFailed: false,
  });
  const reclaimed: unknown[] = [];
  const published: unknown[] = [];
  const context: PromptMessageContext = {
    session,
    sessionId: session.id,
    turn,
    reclaimReleasedTurnForAssistant: (message) => reclaimed.push(message),
    publishStreamUsage: (message) => published.push(message),
  };
  return { session, turn, context, reclaimed, published };
}

function dispatch(context: PromptMessageContext, message: Record<string, unknown>): SSEEvent[] {
  const handler = leafMessageHandler(message.type);
  if (!handler) throw new Error(`no leaf handler for ${String(message.type)}`);
  const events: SSEEvent[] = [];
  const stop = eventEmitter.subscribe((event) => events.push(event));
  try {
    void handler(context, message as unknown as SDKMessage);
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
    const { session, context } = fixture();
    const events = dispatch(context, { type: "prompt_suggestion", suggestion });
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
    const { session, context } = fixture();
    session.messages.push({
      id: "earlier",
      role: "user",
      content: "hi",
      parts: [{ type: "text", content: "hi" }],
      createdAt: new Date().toISOString(),
    });
    const events = dispatch(context, message);
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
    const { session, turn, context } = fixture();
    const trigger = mock(async () => {});
    turn.structuredUsageRefresh = { trigger } as unknown as typeof turn.structuredUsageRefresh;
    const events = dispatch(context, {
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
    ["message_start", 1],
    ["ping", 0],
  ])("stream_event %p reclaims %p times and always publishes usage", (eventType, reclaims) => {
    const { context, reclaimed, published } = fixture();
    const message = { type: "stream_event", event: { type: eventType }, parent_tool_use_id: null };
    dispatch(context, message);
    expect(reclaimed).toHaveLength(reclaims);
    expect(published).toEqual([message]);
  });

  test("tool_progress for a call no row holds changes nothing", () => {
    const { session, context } = fixture();
    const events = dispatch(context, {
      type: "tool_progress",
      tool_use_id: "toolu_unknown",
      tool_name: "Bash",
      elapsed_time_seconds: 3,
    });
    expect(session.messages).toEqual([]);
    expect(events).toEqual([]);
  });
});
