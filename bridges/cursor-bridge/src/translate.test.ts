import { describe, expect, test } from "bun:test";
import { InteractionUpdateSchema } from "@cursor/sdk";
import { newSessionState } from "./agent-session.js";
import { MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_TITLE_BYTES } from "./config.js";
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

  test("plan mode stamps planReview on the assistant message", () => {
    const state = running();
    state.composer.selectedModeId = "plan";
    applyInteractionUpdate(state, { type: "text-delta", text: "Here is the plan." });
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      planReview: true,
      content: "Here is the plan.",
    });
  });

  test("build mode does not stamp planReview", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "text-delta", text: "Implementing." });
    expect(state.messages[0]!.planReview).toBeUndefined();
  });

  test("keeps live createPlan metadata inside the configured byte bounds", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "plan-1",
      modelCallId: "model-1",
      toolCall: {
        type: "createPlan",
        args: { name: "n".repeat(MAX_TOOL_TITLE_BYTES * 2), plan: "# Plan" },
        result: { status: "success", value: {} },
      },
    });
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "plan-2",
      modelCallId: "model-1",
      toolCall: {
        type: "createPlan",
        args: { plan: `# ${"h".repeat(MAX_TOOL_TITLE_BYTES * 2)}` },
        result: { status: "success", value: {} },
      },
    });

    const plans = toolParts(state);
    expect(plans).toHaveLength(2);
    expect(
      plans.every((plan) => Buffer.byteLength(plan.toolTitle ?? "") <= MAX_TOOL_TITLE_BYTES),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(plans[0]!.toolArgs))).toBeLessThanOrEqual(
      MAX_TOOL_ARGUMENT_BYTES,
    );
    expect(plans[1]!.toolArgs).toBeUndefined();
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

  test("renders a context compaction as a boundary, not a tool card", () => {
    // The synthetic card this replaces read as something the agent chose to
    // run. A compaction is a boundary in the conversation.
    const state = running();
    applyInteractionUpdate(state, { type: "summary", summary: "we did three things" });
    expect(state.messages.at(-1)!.parts.at(-1)).toMatchObject({
      type: "compaction",
      toolState: "success",
      content: "we did three things",
    });
  });

  test("opens the boundary while the summary is still being produced", () => {
    // Compaction can take a while; a session that appears to stall with nothing
    // to explain it is what the pending state fixes.
    const state = running();
    applyInteractionUpdate(state, { type: "summary-started" });
    expect(state.messages.at(-1)!.parts.at(-1)).toMatchObject({
      type: "compaction",
      toolState: "pending",
      content: "",
    });

    applyInteractionUpdate(state, { type: "summary-completed", summary: "kept the plan" });
    const parts = state.messages.at(-1)!.parts.filter((part) => part.type === "compaction");
    // One boundary, settled — not a pending row plus a settled one.
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ toolState: "success", content: "kept the plan" });
  });

  test("a `summary` that arrives after `summary-started` settles the open boundary", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "summary-started" });
    applyInteractionUpdate(state, { type: "summary", summary: "we did three things" });

    const parts = state.messages.at(-1)!.parts.filter((part) => part.type === "compaction");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ toolState: "success", content: "we did three things" });
  });

  test("a completion with no open boundary still records one", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "summary-completed", summary: "late" });
    expect(state.messages.at(-1)!.parts.at(-1)).toMatchObject({
      type: "compaction",
      toolState: "success",
      content: "late",
    });
  });

  test("an appended user message becomes a user row", () => {
    // This is where a steered prompt lands. Without a row the steer vanished
    // and the user was left with an answer to a question they could not see.
    const state = running();
    applyInteractionUpdate(state, {
      type: "user-message-appended",
      userMessage: {
        type: "user_message",
        session_id: "session-1",
        text: "actually, use tabs",
        images: [{ type: "base64", data: "iVBORw0KGgo=" }],
      },
    });

    const message = state.messages.at(-1)!;
    expect(message.role).toBe("user");
    expect(message.content).toBe("actually, use tabs");
  });

  test("an appended user message with no text is not a row", () => {
    const state = running();
    const before = state.messages.length;
    applyInteractionUpdate(state, {
      type: "user-message-appended",
      userMessage: { type: "user_message", session_id: "session-1", text: "" },
    });
    expect(state.messages).toHaveLength(before);
  });
});

describe("shell progress", () => {
  function startShell(state: ReturnType<typeof running>) {
    applyInteractionUpdate(state, {
      type: "tool-call-started",
      callId: "call-1",
      toolCall: { type: "shell", args: { command: "bun test" } },
    });
  }

  test("keeps one live progress line beside the accumulating output", () => {
    const state = running();
    startShell(state);
    applyInteractionUpdate(state, {
      type: "shell-output-delta",
      event: { output: "compiling\nlinking\n" },
    });
    applyInteractionUpdate(state, {
      type: "shell-output-delta",
      event: { output: "running tests\n" },
    });

    const progress = state.messages.at(-1)!.parts.filter((part) => part.type === "progress");
    // The newest line only: progress is a hint over the tool state, so a
    // backlog of superseded lines is noise.
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ toolUseId: "call-1", content: "running tests" });
  });

  test("drops the progress line when the call settles", () => {
    const state = running();
    startShell(state);
    applyInteractionUpdate(state, {
      type: "shell-output-delta",
      event: { output: "running tests\n" },
    });
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "call-1",
      toolCall: {
        type: "shell",
        args: { command: "bun test" },
        result: { status: "success", value: {} },
      },
    });

    // A settled row still showing a progress line reports work that has
    // already stopped.
    expect(state.messages.at(-1)!.parts.some((part) => part.type === "progress")).toBe(false);
  });
});

describe("generated images", () => {
  test("becomes an image row pointing at the file, never at the bytes", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "call-img",
      toolCall: {
        type: "generateImage",
        args: { description: "a cat in a hard hat" },
        result: { status: "success", value: { filePath: "/workspace/cat.png" } },
      },
    });

    expect(state.messages.at(-1)!.parts.find((part) => part.type === "image")).toMatchObject({
      type: "image",
      imageSource: "generated",
      content: "a cat in a hard hat",
      fileUrl: "file:///workspace/cat.png",
    });
  });

  test("a re-rendered settled call does not append a second copy", () => {
    const state = running();
    const update = {
      type: "tool-call-completed",
      callId: "call-img",
      toolCall: {
        type: "generateImage",
        args: {},
        result: { status: "success", value: { filePath: "/workspace/cat.png" } },
      },
    };
    applyInteractionUpdate(state, update);
    applyInteractionUpdate(state, update);

    expect(state.messages.at(-1)!.parts.filter((part) => part.type === "image")).toHaveLength(1);
  });
});

/**
 * What this bridge does with a `@cursor/sdk` variant it has no branch for.
 *
 * The SDK is a fast-moving dependency. Before drift recording, a new update
 * type was indistinguishable from a turn that produced nothing at all.
 */
describe("update drift", () => {
  test("an unrecognised update type is counted and named, never thrown", () => {
    const state = newSessionState();

    expect(() =>
      applyInteractionUpdate(state, { type: "conversation-forked", detail: {} }),
    ).not.toThrow();

    expect(state.health.drift()).toEqual({
      unknownEvents: 1,
      unknownKinds: ["conversation-forked"],
    });
  });

  test("known lifecycle boundaries are accepted without hiding an SDK addition", () => {
    const state = newSessionState();
    applyInteractionUpdate(state, { type: "step-started" });
    applyInteractionUpdate(state, { type: "step-completed" });
    applyInteractionUpdate(state, { type: "invented-by-the-sdk" });

    expect(state.health.drift()).toEqual({
      unknownEvents: 1,
      unknownKinds: ["invented-by-the-sdk"],
    });
  });

  test("the payload is never recorded, only the type name", () => {
    const state = newSessionState();
    applyInteractionUpdate(state, {
      type: "secret-update",
      text: "the user's private prompt",
      apiKey: "sk-not-a-real-key",
    });

    const serialized = JSON.stringify(state.health.snapshot());
    expect(serialized).toContain("secret-update");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("sk-not-a-real-key");
  });

  test("types the switch handles do not count as drift", () => {
    const state = newSessionState();
    applyInteractionUpdate(state, { type: "text-delta", text: "hello" });
    applyInteractionUpdate(state, { type: "thinking-completed" });
    applyInteractionUpdate(state, { type: "turn-ended", usage: {} });

    expect(state.health.drift()).toBeUndefined();
  });
});

describe("the run's own system message", () => {
  test("an untyped tool name still reaches the generic card and is counted", () => {
    // `webSearch` and friends are not in the SDK's `ToolCall` union at all, so
    // the exhaustive table cannot see them; they must still render.
    const state = newSessionState();
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "call-1",
      toolCall: { type: "webSearch", args: { query: "orkestrator" } },
    });

    const parts = state.messages.at(-1)?.parts ?? [];
    expect(parts.some((part) => part.type === "tool-invocation")).toBe(true);
    expect(state.health.drift()?.unknownKinds).toEqual(["tool:webSearch"]);
  });

  test("a typed tool the renderer deliberately leaves generic is counted separately", () => {
    const state = newSessionState();
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "call-2",
      toolCall: { type: "recordScreen", args: {} },
    });

    expect(state.health.drift()?.unknownKinds).toEqual(["generic-tool:recordScreen"]);
  });

  test("a tool with its own card is not drift", () => {
    const state = newSessionState();
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "call-3",
      toolCall: { type: "shell", args: { command: "ls" } },
    });

    expect(state.health.drift()).toBeUndefined();
  });
});
