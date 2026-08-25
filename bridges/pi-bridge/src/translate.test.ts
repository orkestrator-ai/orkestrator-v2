import { describe, expect, test } from "bun:test";
import { applySessionEvent } from "./translate.js";
import { newSessionState } from "./agent-session.js";
import type { BridgeTextPart, BridgeToolPart, SessionState } from "./state.js";

function running(): SessionState {
  const state = newSessionState();
  state.status = "running";
  return state;
}

function textDelta(delta: string) {
  return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}

function thinkingDelta(delta: string) {
  return { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } };
}

function parts(state: SessionState): Array<BridgeTextPart | BridgeToolPart> {
  return (state.messages.at(-1)?.parts ?? []) as Array<BridgeTextPart | BridgeToolPart>;
}

describe("streaming text", () => {
  test("appends consecutive deltas into one block", () => {
    const state = running();
    applySessionEvent(state, textDelta("Hello"));
    applySessionEvent(state, textDelta(" world"));

    expect(parts(state)).toHaveLength(1);
    expect(parts(state)[0]).toMatchObject({ type: "text", content: "Hello world" });
    expect(state.messages.at(-1)?.content).toBe("Hello world");
  });

  test("keeps prose and reasoning in separate blocks when they interleave", () => {
    const state = running();
    applySessionEvent(state, textDelta("Plan: "));
    applySessionEvent(state, thinkingDelta("weighing options"));
    applySessionEvent(state, textDelta("do the thing"));

    // Three blocks would mean the trailing-part heuristic chopped the prose in
    // half; two means the prose continued its own block across the reasoning.
    expect(parts(state).map((part) => part.type)).toEqual(["text", "thinking"]);
    expect(parts(state)[0]).toMatchObject({ content: "Plan: do the thing" });
  });

  test("excludes reasoning from the flat message body", () => {
    const state = running();
    applySessionEvent(state, thinkingDelta("secret reasoning"));
    applySessionEvent(state, textDelta("answer"));

    expect(state.messages.at(-1)?.content).toBe("answer");
  });

  test("starts a new block after a tool card interrupts the prose", () => {
    const state = running();
    applySessionEvent(state, textDelta("before"));
    applySessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    });
    applySessionEvent(state, textDelta("after"));

    expect(parts(state).map((part) => part.type)).toEqual(["text", "tool-invocation", "text"]);
  });

  test("stops appending once the message ends", () => {
    const state = running();
    applySessionEvent(state, textDelta("first"));
    applySessionEvent(state, { type: "message_end" });
    applySessionEvent(state, textDelta("second"));

    expect(parts(state).map((part) => (part as BridgeTextPart).content)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("tool cards", () => {
  test("patches one card across start, update and end", () => {
    const state = running();
    applySessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "echo hi" },
    });
    applySessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "echo hi" },
      partialResult: { content: [{ type: "text", text: "hi" }] },
    });

    expect(parts(state)).toHaveLength(1);
    expect(parts(state)[0]).toMatchObject({
      toolState: "pending",
      toolTitle: "echo hi",
      toolOutput: "hi",
    });

    applySessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "hi\n" }] },
      isError: false,
    });
    expect(parts(state)).toHaveLength(1);
    expect(parts(state)[0]).toMatchObject({ toolState: "success", toolOutput: "hi\n" });
  });

  test("records a failed call with the text the model also saw", () => {
    const state = running();
    applySessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "missing.ts" },
      result: { content: [{ type: "text", text: "ENOENT: missing.ts" }] },
      isError: true,
    });

    expect(parts(state)[0]).toMatchObject({
      toolState: "failure",
      toolError: "ENOENT: missing.ts",
    });
  });

  test("renders an edit's diff onto the card", () => {
    const state = running();
    applySessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "edit",
      args: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
      result: { content: [], details: { diff: "-a\n+b" } },
      isError: false,
    });

    expect(parts(state)[0]).toMatchObject({
      toolDiff: { filePath: "src/a.ts", diff: "-a\n+b" },
    });
  });

  test("ignores a call with no id rather than opening an unpatchable card", () => {
    const state = running();
    applySessionEvent(state, { type: "tool_execution_start", toolName: "bash", args: {} });
    expect(state.messages).toHaveLength(0);
  });
});

describe("session events", () => {
  test("accumulates usage across the turns of one prompt", () => {
    const state = running();
    applySessionEvent(state, {
      type: "turn_end",
      message: { usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, reasoning: 3 } },
    });
    applySessionEvent(state, {
      type: "turn_end",
      message: { usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 4 } },
    });

    expect(state.currentTurnUsage).toEqual({
      inputTokens: 17,
      outputTokens: 7,
      cacheReadTokens: 1,
      cacheWriteTokens: 4,
      reasoningTokens: 3,
    });
  });

  test("tracks the steering and follow-up queue", () => {
    const state = running();
    applySessionEvent(state, {
      type: "queue_update",
      steering: ["stop and check"],
      followUp: ["then summarize", 42],
    });

    expect(state.queue).toEqual({ steering: ["stop and check"], followUp: ["then summarize"] });
  });

  test("reports compaction as work in flight and settles it with a card", () => {
    const state = running();
    applySessionEvent(state, { type: "compaction_start", reason: "threshold" });
    expect(state.compacting).toBe(true);

    applySessionEvent(state, {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      result: { summary: "kept the plan" },
    });
    expect(state.compacting).toBe(false);
    expect(parts(state)[0]).toMatchObject({
      toolName: "compact_context",
      toolState: "success",
      toolOutput: "kept the plan",
    });
  });

  test("leaves no card when compaction was aborted", () => {
    const state = running();
    applySessionEvent(state, { type: "compaction_start", reason: "manual" });
    applySessionEvent(state, { type: "compaction_end", reason: "manual", aborted: true });

    expect(state.compacting).toBe(false);
    expect(state.messages).toHaveLength(0);
  });

  test("renders a retry as a visible notice", () => {
    const state = running();
    applySessionEvent(state, {
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 1000,
      errorMessage: "overloaded",
    });

    expect(parts(state)[0]).toMatchObject({
      toolName: "notice",
      toolTitle: "Retrying (2/5): overloaded",
    });
  });

  test("adopts the thinking level Pi actually settled on", () => {
    const state = running();
    state.composer = { ...state.composer, selectedReasoningId: "max" };

    // Pi clamps a requested level to what the model supports, so the level in
    // flight is not always the one the picker asked for. Without this the
    // control keeps showing a selection the run is not using — and a clamped
    // turn succeeds, so nothing else would ever say so.
    applySessionEvent(state, { type: "thinking_level_changed", level: "high" });

    expect(state.composer.selectedReasoningId).toBe("high");
  });

  test("ignores a thinking level that changes nothing or names nothing", () => {
    const state = running();
    state.composer = { ...state.composer, selectedReasoningId: "high" };
    const before = state.revision;

    applySessionEvent(state, { type: "thinking_level_changed", level: "high" });
    applySessionEvent(state, { type: "thinking_level_changed", level: "" });
    applySessionEvent(state, { type: "thinking_level_changed" });

    expect(state.composer.selectedReasoningId).toBe("high");
    expect(state.revision).toBe(before);
  });

  test("adopts a session name as the transcript title", () => {
    const state = running();
    applySessionEvent(state, { type: "session_info_changed", name: "Fix the parser" });
    expect(state.title).toBe("Fix the parser");
  });

  test("ignores frames it has no vocabulary for", () => {
    const state = running();
    const before = state.revision;
    applySessionEvent(state, { type: "some_future_event", payload: { a: 1 } });
    applySessionEvent(state, "not an event");
    applySessionEvent(state, null);

    expect(state.messages).toHaveLength(0);
    expect(state.revision).toBe(before);
  });
});
