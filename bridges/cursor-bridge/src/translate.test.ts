import { describe, expect, test } from "bun:test";
import { InteractionUpdateSchema } from "@cursor/sdk";
import { newSessionState } from "./agent-session.js";
import { publicContextUsage } from "./public.js";
import type { BridgeToolPart, SessionState } from "./state.js";
import { applyInteractionUpdate, applyStreamUsage, settleBackgroundChildren } from "./translate.js";

function running(): SessionState {
  const state = newSessionState();
  state.status = "running";
  return state;
}

function toolParts(state: SessionState): BridgeToolPart[] {
  return state.messages.flatMap((message) =>
    message.parts.filter((part): part is BridgeToolPart => part.type === "tool-invocation"),
  );
}

describe("text and thinking deltas", () => {
  test("coalesces consecutive text deltas into one part and the message body", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "text-delta", text: "Hello" });
    applyInteractionUpdate(state, { type: "text-delta", text: " world" });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.role).toBe("assistant");
    expect(state.messages[0]!.parts).toHaveLength(1);
    expect(state.messages[0]!.parts[0]).toMatchObject({ type: "text", content: "Hello world" });
    expect(state.messages[0]!.content).toBe("Hello world");
  });

  test("keeps thinking in its own part and out of the message body", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "thinking-delta", text: "hmm" });
    applyInteractionUpdate(state, { type: "text-delta", text: "answer" });

    expect(state.messages[0]!.parts.map((part) => part.type)).toEqual(["thinking", "text"]);
    expect(state.messages[0]!.content).toBe("answer");
  });

  test("accumulates structured-output text only when a schema turn asked for it", () => {
    const plain = running();
    applyInteractionUpdate(plain, { type: "text-delta", text: "{}" });
    expect(plain.currentTurnOutput).toBeNull();

    const structured = running();
    structured.currentTurnOutput = "";
    applyInteractionUpdate(structured, { type: "text-delta", text: '{"a":1}' });
    expect(structured.currentTurnOutput).toBe('{"a":1}');
  });

  test("keeps prose in one block when reasoning is interleaved with it", () => {
    // The shape that produced a transcript chopped mid-sentence into dozens of
    // alternating fragments: Cursor emits reasoning between prose chunks, so
    // "the trailing part" is the wrong block to continue.
    const state = running();
    applyInteractionUpdate(state, { type: "text-delta", text: "Should " });
    applyInteractionUpdate(state, { type: "thinking-delta", text: "The bot still loads" });
    applyInteractionUpdate(state, { type: "text-delta", text: "a process " });
    applyInteractionUpdate(state, { type: "thinking-delta", text: " rules.txt" });
    applyInteractionUpdate(state, { type: "text-delta", text: "manager?" });

    const parts = state.messages[0]!.parts;
    expect(parts.map((part) => part.type)).toEqual(["text", "thinking"]);
    expect(parts[0]!.content).toBe("Should a process manager?");
    expect(parts[1]!.content).toBe("The bot still loads rules.txt");
    expect(state.messages[0]!.content).toBe("Should a process manager?");
  });

  test("a completed reasoning block does not absorb the next one", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "thinking-delta", text: "first" });
    applyInteractionUpdate(state, { type: "thinking-completed", thinkingDurationMs: 10 });
    applyInteractionUpdate(state, { type: "thinking-delta", text: "second" });

    const thinking = state.messages[0]!.parts.filter((part) => part.type === "thinking");
    expect(thinking.map((part) => part.content)).toEqual(["first", "second"]);
  });

  test("a tool call separates the prose before it from the prose after", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "text-delta", text: "Reading the file." });
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "c1",
      modelCallId: "m1",
      toolCall: { type: "read", args: { path: "a.ts" } },
    });
    applyInteractionUpdate(state, { type: "text-delta", text: "It defines two exports." });

    // Folding the later prose back into the first block would render it above
    // the card that produced it.
    expect(state.messages[0]!.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-invocation",
      "text",
    ]);
  });

  test("a sub-agent's prose never continues the parent's block", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "text-delta", text: "Delegating." });
    applyInteractionUpdate(state, {
      type: "tool-call-delta",
      callId: "launch",
      modelCallId: "m1",
      taskUpdate: { type: "text-delta", text: "child output" },
    });
    applyInteractionUpdate(state, { type: "text-delta", text: " Done." });

    const texts = state.messages[0]!.parts.filter((part) => part.type === "text");
    expect(texts.map((part) => [part.parentTaskUseId, part.content])).toEqual([
      [undefined, "Delegating. Done."],
      ["launch", "child output"],
    ]);
  });

  test("an unknown update type is ignored rather than fatal", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "some-future-frame", payload: 1 });
    applyInteractionUpdate(state, null);
    applyInteractionUpdate(state, { noType: true });
    expect(state.messages).toHaveLength(0);
  });
});

describe("tool call lifecycle", () => {
  test("patches one card from partial through completed", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "partial-tool-call",
      callId: "c1",
      modelCallId: "m1",
      toolCall: { type: "shell", args: { command: "bun te" } },
    });
    expect(toolParts(state)).toHaveLength(1);
    expect(toolParts(state)[0]!.toolState).toBe("pending");

    applyInteractionUpdate(state, {
      type: "tool-call-started",
      callId: "c1",
      modelCallId: "m1",
      toolCall: { type: "shell", args: { command: "bun test" } },
    });
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "c1",
      modelCallId: "m1",
      toolCall: {
        type: "shell",
        args: { command: "bun test" },
        result: {
          status: "success",
          value: { exitCode: 0, signal: "", stdout: "pass", stderr: "", executionTime: 1 },
        },
      },
    });

    const parts = toolParts(state);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolUseId: "c1",
      toolName: "shell",
      toolState: "success",
      toolOutput: "pass",
    });
  });

  test("a failed call settles as a failure", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "c1",
      modelCallId: "m1",
      toolCall: {
        type: "read",
        args: { path: "gone.ts" },
        result: { status: "error", error: { message: "ENOENT" } },
      },
    });
    expect(toolParts(state)[0]).toMatchObject({ toolState: "failure", toolError: "ENOENT" });
  });

  test("a call without an id is dropped rather than creating an unpatchable card", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "tool-call-started",
      modelCallId: "m1",
      toolCall: { type: "shell", args: { command: "x" } },
    });
    expect(toolParts(state)).toHaveLength(0);
  });

  test("charges only the delta of a patched card against the transcript budget", () => {
    const state = running();
    const start = { type: "tool-call-started", callId: "c1", modelCallId: "m1" };
    applyInteractionUpdate(state, {
      ...start,
      toolCall: { type: "read", args: { path: "a.ts" } },
    });
    const afterFirst = state.uncheckedTranscriptBytes;
    applyInteractionUpdate(state, {
      ...start,
      toolCall: { type: "read", args: { path: "a.ts" } },
    });
    // Re-applying an identical frame adds no bytes: the card was already
    // charged, so a streaming turn cannot re-bill the same payload per frame.
    expect(state.uncheckedTranscriptBytes).toBe(afterFirst);
  });
});

describe("shell output deltas", () => {
  test("streams into the newest pending shell card", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "tool-call-started",
      callId: "c1",
      modelCallId: "m1",
      toolCall: { type: "shell", args: { command: "tail -f log" } },
    });
    applyInteractionUpdate(state, { type: "shell-output-delta", event: { text: "line 1\n" } });
    applyInteractionUpdate(state, { type: "shell-output-delta", event: { chunk: "line 2\n" } });

    expect(toolParts(state)[0]!.toolOutput).toBe("line 1\nline 2\n");
  });

  test("a settled call supersedes its streamed buffer", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "tool-call-started",
      callId: "c1",
      modelCallId: "m1",
      toolCall: { type: "shell", args: { command: "echo hi" } },
    });
    applyInteractionUpdate(state, { type: "shell-output-delta", event: { text: "partial" } });
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "c1",
      modelCallId: "m1",
      toolCall: {
        type: "shell",
        args: { command: "echo hi" },
        result: {
          status: "success",
          value: { exitCode: 0, signal: "", stdout: "hi\n", stderr: "", executionTime: 1 },
        },
      },
    });
    expect(toolParts(state)[0]!.toolOutput).toBe("hi\n");
  });

  test("a delta with no pending shell card is dropped, not misfiled", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "c1",
      modelCallId: "m1",
      toolCall: { type: "read", args: { path: "a.ts" } },
    });
    applyInteractionUpdate(state, { type: "shell-output-delta", event: { text: "stray" } });
    expect(toolParts(state)[0]!.toolOutput).toBeUndefined();
  });
});

describe("nested sub-agent updates", () => {
  test("attributes a nested tool call to its launch card", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "tool-call-started",
      callId: "launch",
      modelCallId: "m1",
      toolCall: { type: "task", args: { description: "Review", prompt: "look" } },
    });
    applyInteractionUpdate(state, {
      type: "tool-call-delta",
      callId: "launch",
      modelCallId: "m1",
      taskUpdate: {
        type: "tool-call-started",
        callId: "child",
        modelCallId: "m2",
        toolCall: { type: "read", args: { path: "b.ts" } },
      },
    });
    applyInteractionUpdate(state, {
      type: "tool-call-delta",
      callId: "launch",
      modelCallId: "m1",
      taskUpdate: { type: "text-delta", text: "child says hi" },
    });

    const parts = toolParts(state);
    expect(parts.find((part) => part.toolUseId === "child")?.parentTaskUseId).toBe("launch");
    const nestedText = state.messages[0]!.parts.find(
      (part) => part.type === "text" && part.parentTaskUseId === "launch",
    );
    expect(nestedText).toMatchObject({ content: "child says hi" });
    // Nested prose belongs in its own card, not in the parent message body.
    expect(state.messages[0]!.content).toBe("");
  });

  test("a foreground sub-agent settles when its launch completes", () => {
    const state = running();
    const launch = { type: "task", args: { description: "Inline", prompt: "p" } };
    applyInteractionUpdate(state, {
      type: "tool-call-started",
      callId: "l1",
      modelCallId: "m1",
      toolCall: launch,
    });
    expect(state.activeSubagentDescriptors.size).toBe(1);

    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "l1",
      modelCallId: "m1",
      toolCall: {
        ...launch,
        result: {
          status: "success",
          value: { isBackground: false, backgroundReason: "unspecified" },
        },
      },
    });
    expect(state.activeSubagentDescriptors.size).toBe(0);
    expect(toolParts(state)[0]!.agentState).toBe("finished");
  });

  test("a background sub-agent holds the session busy past its launch", () => {
    const state = running();
    const launch = { type: "task", args: { description: "Background", prompt: "p" } };
    applyInteractionUpdate(state, {
      type: "tool-call-started",
      callId: "l1",
      modelCallId: "m1",
      toolCall: launch,
    });
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "l1",
      modelCallId: "m1",
      toolCall: {
        ...launch,
        result: {
          status: "success",
          value: { isBackground: true, backgroundReason: "agentRequest", agentId: "a1" },
        },
      },
    });
    expect(state.activeSubagentDescriptors.size).toBe(1);
    expect(toolParts(state)[0]!.agentState).toBe("active");

    settleBackgroundChildren(state);
    expect(state.activeSubagentDescriptors.size).toBe(0);
    expect(toolParts(state)[0]!.agentState).toBe("finished");
    expect(toolParts(state)[0]!.toolOutput).toContain("still running in the background");
  });

  test("a failed background launch settles immediately", () => {
    const state = running();
    const launch = { type: "task", args: { description: "Bad", prompt: "p" } };
    applyInteractionUpdate(state, {
      type: "tool-call-started",
      callId: "l1",
      modelCallId: "m1",
      toolCall: launch,
    });
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "l1",
      modelCallId: "m1",
      toolCall: { ...launch, result: { status: "error", error: { message: "no capacity" } } },
    });
    expect(state.activeSubagentDescriptors.size).toBe(0);
    expect(toolParts(state)[0]!.agentState).toBe("failed");
  });
});

describe("session-wide state", () => {
  test("holds the newest todo list for restart recovery", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "c1",
      modelCallId: "m1",
      toolCall: {
        type: "updateTodos",
        args: { todos: [] },
        result: {
          status: "success",
          value: { todos: [{ content: "ship it", status: "inProgress" }], totalCount: 1 },
        },
      },
    });
    expect(state.todos).toEqual([{ content: "ship it", status: "in_progress" }]);
  });

  test("records turn usage from turn-ended", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "turn-ended",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
        reasoningTokens: 7,
      },
    });
    expect(state.currentTurnUsage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      reasoningTokens: 7,
    });
    expect(state.currentRunUsage).toEqual(state.currentTurnUsage);
  });

  test("publishes token-delta progress before the first exact usage frame", () => {
    const state = running();
    state.composer.selectedModelId = "grok-4.6";
    state.currentRunModelId = "grok-4.6";

    applyInteractionUpdate(state, { type: "token-delta", tokens: 12 });
    applyInteractionUpdate(state, { type: "token-delta", tokens: 8.9 });

    expect(state.currentRunUsage).toBeUndefined();
    expect(state.currentTurnOutputTokenEstimate).toBe(20);
    expect(publicContextUsage(state)).toMatchObject({
      modelId: "grok-4.6",
      usedTokens: 20,
      lastTurnTokens: 20,
      sessionTokens: 20,
      estimated: true,
    });
  });

  test("keeps persisted context occupancy while only output is estimated", () => {
    const state = running();
    state.composer.selectedModelId = "grok-4.6";
    state.currentRunModelId = "grok-4.6";
    state.usage = {
      turn: { inputTokens: 150_000, outputTokens: 2_000 },
      context: { inputTokens: 150_000, outputTokens: 2_000 },
      sessionTokenFloor: 152_000,
      modelId: "grok-4.6",
      updatedAt: new Date(1).toISOString(),
    };
    // This is the prompt-start state before the first exact frame of the new
    // turn. An output delta must advance the gauge from its prior occupancy,
    // not replace that occupancy with a tiny output-only number.
    state.currentTurnUsage = {};

    applyInteractionUpdate(state, { type: "token-delta", tokens: 17 });

    expect(publicContextUsage(state)).toMatchObject({
      usedTokens: 152_017,
      lastTurnTokens: 17,
      sessionTokens: 152_017,
      estimated: true,
    });
  });

  test("accepts token deltas parsed by the pinned Cursor SDK contract", () => {
    const state = running();
    const updates = [
      InteractionUpdateSchema.parse({ type: "token-delta", tokens: 3 }),
      InteractionUpdateSchema.parse({ type: "token-delta", tokens: 4 }),
    ];

    for (const update of updates) applyInteractionUpdate(state, update);

    expect(state.currentTurnOutputTokenEstimate).toBe(7);
  });

  test("ignores unusable token deltas without changing observable state", () => {
    const state = running();
    const revision = state.revision;
    const values: unknown[] = ["5", Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 0.9];

    for (const tokens of values) applyInteractionUpdate(state, { type: "token-delta", tokens });

    expect(state.currentTurnOutputTokenEstimate).toBeUndefined();
    expect(state.currentRunUsageUpdatedAt).toBeUndefined();
    expect(state.revision).toBe(revision);
  });

  test("reconciles token-delta progress to exact usage at each turn boundary", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "token-delta", tokens: 10 });
    applyInteractionUpdate(state, {
      type: "turn-ended",
      usage: { inputTokens: 100, outputTokens: 8, cacheReadTokens: 20, cacheWriteTokens: 0 },
    });

    expect(state.currentTurnOutputTokenEstimate).toBeUndefined();
    expect(publicContextUsage(state)).toMatchObject({
      lastTurnTokens: 128,
      sessionTokens: 128,
    });
    expect(publicContextUsage(state)).not.toHaveProperty("estimated");

    applyInteractionUpdate(state, { type: "token-delta", tokens: 5 });
    expect(publicContextUsage(state)).toMatchObject({
      lastTurnTokens: 133,
      sessionTokens: 133,
      estimated: true,
    });
  });

  test("does not charge a nested sub-agent token estimate to the parent run", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "tool-call-delta",
      callId: "child-launch",
      taskUpdate: { type: "token-delta", tokens: 500 },
    });

    expect(state.currentTurnOutputTokenEstimate).toBeUndefined();
    expect(publicContextUsage(state)).toBeUndefined();
  });

  test("accumulates completed model-call usage while retaining the latest context", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "turn-ended",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 },
    });
    applyInteractionUpdate(state, {
      type: "turn-ended",
      usage: { inputTokens: 140, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 1 },
    });

    expect(state.currentTurnUsage).toEqual({
      inputTokens: 140,
      outputTokens: 30,
      cacheReadTokens: 10,
      cacheWriteTokens: 1,
    });
    expect(state.currentRunUsage).toEqual({
      inputTokens: 240,
      outputTokens: 50,
      cacheReadTokens: 15,
      cacheWriteTokens: 1,
    });
    expect(state.currentRunUsageUpdatedAt).toBeDefined();
    expect(publicContextUsage(state)).toMatchObject({
      usedTokens: 181,
      lastTurnTokens: 306,
      sessionTokens: 306,
    });
  });

  test("retains omitted latest-call categories and ignores empty usage updates", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "turn-ended",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 },
    });
    const revision = state.revision;

    applyInteractionUpdate(state, { type: "turn-ended", usage: {} });
    expect(state.revision).toBe(revision);
    applyInteractionUpdate(state, { type: "turn-ended", usage: { outputTokens: 7 } });

    expect(state.currentTurnUsage).toEqual({
      inputTokens: 100,
      outputTokens: 7,
      cacheReadTokens: 5,
    });
    expect(state.currentRunUsage).toEqual({
      inputTokens: 100,
      outputTokens: 27,
      cacheReadTokens: 5,
    });
  });

  test("takes the larger independent usage source without double-counting it", () => {
    const state = running();
    const first = { inputTokens: 100, outputTokens: 20 };
    applyInteractionUpdate(state, { type: "turn-ended", usage: first });
    applyStreamUsage(state, { ...first, totalTokens: 120 }, first);

    expect(state.currentRunUsage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });

    const second = { inputTokens: 40, outputTokens: 10 };
    applyInteractionUpdate(state, { type: "turn-ended", usage: second });
    applyStreamUsage(state, { inputTokens: 140, outputTokens: 30, totalTokens: 170 }, second);
    expect(state.currentRunUsage).toEqual({
      inputTokens: 140,
      outputTokens: 30,
      totalTokens: 170,
    });
  });

  test("does not charge a nested sub-agent turn to the parent run", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "tool-call-delta",
      callId: "child-launch",
      taskUpdate: {
        type: "turn-ended",
        usage: { inputTokens: 500, outputTokens: 50 },
      },
    });

    expect(state.currentTurnUsage).toBeUndefined();
    expect(state.currentRunUsage).toBeUndefined();
  });

  test("uses the active run model instead of durable usage from a previous model", () => {
    const state = running();
    state.composer.models = [
      {
        platform: "cursor",
        id: "old-model",
        label: "Old",
        providerLabel: "Cursor",
        contextWindow: 1_000,
      },
      {
        platform: "cursor",
        id: "new-model",
        label: "New",
        providerLabel: "Cursor",
        contextWindow: 2_000,
      },
    ];
    state.composer.selectedModelId = "new-model";
    state.usage = {
      turn: { inputTokens: 100, outputTokens: 10 },
      modelId: "old-model",
      sessionTokenFloor: 110,
      updatedAt: new Date(0).toISOString(),
    };
    state.currentRunModelId = "new-model";
    state.currentRunUsage = { inputTokens: 20, outputTokens: 5 };
    state.currentTurnUsage = { inputTokens: 20, outputTokens: 5 };
    state.currentRunUsageUpdatedAt = new Date(1).toISOString();

    expect(publicContextUsage(state)).toMatchObject({
      modelId: "new-model",
      maximumTokens: 2_000,
      usedTokens: 25,
      lastTurnTokens: 25,
      sessionTokens: 135,
    });
  });

  test("renders a context compaction as its own card", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "summary", summary: "we did three things" });
    expect(toolParts(state)[0]).toMatchObject({
      toolName: "compact_context",
      toolState: "success",
      toolOutput: "we did three things",
    });
  });
});
