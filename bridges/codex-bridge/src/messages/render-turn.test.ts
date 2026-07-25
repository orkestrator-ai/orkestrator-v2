import { describe, expect, spyOn, test } from "bun:test";
import { TurnAccumulator } from "../sessions/turn-accumulator.js";
import {
  TRUNCATION_NOTICE,
  beginTurnRenderState,
  createTurnRenderState,
  effectiveItem,
  releaseTurnRenderState,
  renderTurn,
} from "./render-turn.js";

function turn() {
  return new TurnAccumulator({
    threadId: "thread-1",
    turnId: "turn-1",
    engineGeneration: 1,
    assistantMessageId: "message-1",
    startedAt: "2026-07-25T12:00:00.000Z",
    maxCommandOutputChars: 3,
  });
}

describe("turn render state", () => {
  test("begins a new turn with baselines retained and per-item state cleared", () => {
    const previous = createTurnRenderState();
    previous.timelineOrder.push("item:old");
    previous.subagentParts.set("agent:old", { type: "subagent", content: "old" });
    previous.fileChange.baselines.set("a.ts", "before");
    previous.fileChange.cache.set("old", { filePath: "a.ts" });

    const next = beginTurnRenderState(previous);
    expect(next.timelineOrder).toEqual([]);
    expect(next.subagentParts.size).toBe(0);
    expect(next.fileChange.baselines.get("a.ts")).toBe("before");
    expect(next.fileChange.cache.size).toBe(0);
  });

  test("release clears all retained render memory", () => {
    const state = createTurnRenderState();
    state.timelineOrder.push("x");
    state.subagentParts.set("a", { type: "subagent", content: "x" });
    state.subagentFingerprints.set("a", "fingerprint");
    state.fileChange.baselines.set("a.ts", "x");
    state.fileChange.cache.set("a", { filePath: "a.ts" });
    releaseTurnRenderState(state);
    expect(state.timelineOrder).toEqual([]);
    expect(state.subagentParts.size).toBe(0);
    expect(state.subagentFingerprints.size).toBe(0);
    expect(state.fileChange.baselines.size).toBe(0);
    expect(state.fileChange.cache.size).toBe(0);
  });
});

describe("effectiveItem", () => {
  test("synthesizes streamed text and indexed reasoning before an item arrives", () => {
    const accumulator = turn();
    accumulator.onTextDelta("text", "hello");
    expect(effectiveItem(accumulator, accumulator.items.get("text")!)).toMatchObject({
      type: "agent_message",
      text: "hello",
    });

    accumulator.onReasoningDelta("reason", "second", "summary", 1);
    accumulator.onReasoningDelta("reason", "first", "summary", 0);
    expect(effectiveItem(accumulator, accumulator.items.get("reason")!)).toMatchObject({
      type: "reasoning",
      text: "first\n\nsecond",
    });
    accumulator.onCommandOutputDelta("unknown-command", "out");
    expect(effectiveItem(accumulator, accumulator.items.get("unknown-command")!)).toBeNull();
  });

  test("combines command deltas, truncation, and empty authoritative text", () => {
    const accumulator = turn();
    accumulator.onItemStarted({
      id: "command",
      type: "command_execution",
      command: "echo",
      aggregated_output: "",
      status: "in_progress",
    });
    accumulator.onCommandOutputDelta("command", "abcdef");
    expect(effectiveItem(accumulator, accumulator.items.get("command")!)).toMatchObject({
      aggregated_output: `abc${TRUNCATION_NOTICE}`,
    });

    accumulator.onTextDelta("message", "streamed");
    accumulator.onItemStarted({ id: "message", type: "agent_message", text: "" });
    expect(effectiveItem(accumulator, accumulator.items.get("message")!)).toMatchObject({
      text: "streamed",
    });
  });
});

describe("renderTurn", () => {
  test("omits reasoning items with no visible content", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "reasoning", type: "reasoning", text: "" });
    const rendered = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state: createTurnRenderState(),
      loadSubagentParts: async () => [],
    });

    expect(rendered.parts).toEqual([]);
    expect(rendered.content).toBe("");
  });

  test("renders item parts and interleaves injected subagent activity", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "text", type: "agent_message", text: "done" });
    const state = createTurnRenderState();
    const rendered = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [{
        type: "subagent",
        content: "child",
        subagentId: "child-1",
        toolState: "success",
      }],
    });

    expect(rendered.content).toBe("done");
    expect(rendered.parts.map((part) => part.type)).toEqual(["text", "subagent"]);
    expect(state.timelineOrder).toHaveLength(2);
  });

  test("subagent loader failure is additive and never blanks normal output", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "text", type: "agent_message", text: "kept" });
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const rendered = await renderTurn(accumulator, {
        threadId: "thread-1",
        cwd: "/tmp",
        state: createTurnRenderState(),
        loadSubagentParts: async () => {
          throw new Error("transcript unavailable");
        },
      });
      expect(rendered.content).toBe("kept");
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });
});
