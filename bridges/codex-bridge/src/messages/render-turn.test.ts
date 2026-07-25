import { describe, expect, spyOn, test } from "bun:test";
import { TurnAccumulator } from "../sessions/turn-accumulator.js";
import {
  TRUNCATION_NOTICE,
  beginTurnRenderState,
  createTurnRenderState,
  effectiveItem,
  loadSubagentPartsFromTranscripts,
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
  test("begins the first turn with empty render state", () => {
    const state = beginTurnRenderState(undefined);
    expect(state.timelineOrder).toEqual([]);
    expect(state.subagentParts.size).toBe(0);
    expect(state.subagentFingerprints.size).toBe(0);
    expect(state.fileChange.baselines.size).toBe(0);
    expect(state.fileChange.cache.size).toBe(0);
  });

  test("begins a new turn with baselines retained and per-item state cleared", () => {
    const previous = createTurnRenderState();
    previous.timelineOrder.push("item:old");
    previous.subagentParts.set("agent:old", { type: "subagent", content: "old" });
    previous.subagentFingerprints.set("agent:old", "old");
    previous.fileChange.baselines.set("a.ts", "before");
    previous.fileChange.cache.set("old", { filePath: "a.ts" });

    const next = beginTurnRenderState(previous);
    expect(next.timelineOrder).toEqual([]);
    expect(next.subagentParts.size).toBe(0);
    expect(next.subagentFingerprints.size).toBe(0);
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

  test("uses content reasoning deltas when no non-empty summary is available", () => {
    const accumulator = turn();
    accumulator.onReasoningDelta("reason", "", "summary", 0);
    accumulator.onReasoningDelta("reason", "second", "content", 1);
    accumulator.onReasoningDelta("reason", "first", "content", 0);
    expect(effectiveItem(accumulator, accumulator.items.get("reason")!)).toMatchObject({
      type: "reasoning",
      text: "first\n\nsecond",
    });

    accumulator.onItemStarted({ id: "reason", type: "reasoning", text: "" });
    expect(effectiveItem(accumulator, accumulator.items.get("reason")!)).toMatchObject({
      type: "reasoning",
      text: "first\n\nsecond",
    });
  });

  test("prefers authoritative command, message, and reasoning content", () => {
    const accumulator = turn();
    const command = {
      id: "command",
      type: "command_execution" as const,
      command: "echo final",
      aggregated_output: "final",
      status: "completed" as const,
    };
    accumulator.onItemStarted(command);
    accumulator.onCommandOutputDelta("command", "old");
    expect(effectiveItem(accumulator, accumulator.items.get("command")!)).toBe(command);

    const message = { id: "message", type: "agent_message" as const, text: "final answer" };
    accumulator.onItemStarted(message);
    accumulator.onTextDelta("message", "old answer");
    expect(effectiveItem(accumulator, accumulator.items.get("message")!)).toBe(message);

    const reasoning = { id: "reason", type: "reasoning" as const, text: "final reasoning" };
    accumulator.onItemStarted(reasoning);
    accumulator.onReasoningDelta("reason", "old reasoning", "summary", 0);
    expect(effectiveItem(accumulator, accumulator.items.get("reason")!)).toBe(reasoning);
  });

  test("preserves commands with no output and uncapped live output", () => {
    const accumulator = turn();
    const waiting = {
      id: "waiting",
      type: "command_execution" as const,
      command: "sleep 1",
      aggregated_output: "",
      status: "in_progress" as const,
    };
    accumulator.onItemStarted(waiting);
    expect(effectiveItem(accumulator, accumulator.items.get("waiting")!)).toBe(waiting);

    accumulator.onItemStarted({
      id: "streaming",
      type: "command_execution",
      command: "echo ab",
      aggregated_output: "",
      status: "in_progress",
    });
    accumulator.onCommandOutputDelta("streaming", "ab");
    expect(effectiveItem(accumulator, accumulator.items.get("streaming")!)).toMatchObject({
      aggregated_output: "ab",
    });
  });

  test("passes other authoritative item types through unchanged", () => {
    const accumulator = turn();
    const search = { id: "search", type: "web_search" as const, query: "current docs" };
    accumulator.onItemStarted(search);
    expect(effectiveItem(accumulator, accumulator.items.get("search")!)).toBe(search);
  });
});

describe("renderTurn", () => {
  test("maps transcript fields and folds live collaboration state with injected dependencies", async () => {
    const items = [{
      id: "spawn",
      type: "collab_tool_call" as const,
      tool: "spawn_agent",
      receiver_thread_ids: ["child-1"],
      prompt: "live prompt",
      agents_states: {
        "child-1": { status: "completed" as const, message: "live final response" },
      },
      status: "completed" as const,
    }];
    const parts = await loadSubagentPartsFromTranscripts({
      threadId: "thread-1",
      turnStartedAt: "2026-07-25T12:00:00.000Z",
      items,
    }, {
      createTranscriptMetaLoader: () => async (threadId) => ({
        id: threadId,
        updatedAt: "2026-07-25T12:00:00.000Z",
        transcriptPath: `/transcripts/${threadId}.jsonl`,
      }),
      deriveTranscriptParts: async (options) => {
        expect(options.threadId).toBe("thread-1");
        expect(options.currentTurnStartedAt).toBe("2026-07-25T12:00:00.000Z");
        expect(options.fallbackAgentIdsInSpawnOrder).toEqual(["child-1"]);
        expect(await options.loadSessionMeta("child-1")).toMatchObject({
          id: "child-1",
          transcriptPath: "/transcripts/child-1.jsonl",
        });
        expect(await options.loadTranscript("/transcripts/child-1.jsonl")).toMatchObject({
          fileId: "child-1",
          records: [],
        });
        return [{
          type: "subagent",
          content: "child transcript",
          toolState: "pending",
          subagentId: "child-1",
          subagentName: "Ada",
          subagentRole: "reviewer",
          subagentPrompt: "transcript prompt",
          subagentActions: [{
            type: "tool-invocation",
            content: "checked files",
            toolName: "read",
            toolState: "success",
          }],
          subagentActionCount: 1,
        }];
      },
      readTranscript: async (path) => ({
        fileId: path.includes("child-1") ? "child-1" : "other",
        size: 0,
        modifiedAtNs: "0",
        remainder: "",
        lines: [],
        records: [],
      }),
    });

    expect(parts).toEqual([{
      type: "subagent",
      content: "child transcript",
      toolState: "success",
      subagentId: "child-1",
      subagentName: "Ada",
      subagentRole: "reviewer",
      subagentPrompt: "transcript prompt",
      subagentActions: [
        {
          type: "tool-invocation",
          content: "checked files",
          toolName: "read",
          toolState: "success",
        },
        { type: "text", content: "live final response" },
      ],
      subagentActionCount: 1,
    }]);
  });

  test("uses the production subagent loader safely when no thread exists yet", async () => {
    const rendered = await renderTurn(turn(), {
      threadId: null,
      cwd: "/tmp",
      state: createTurnRenderState(),
    });

    expect(rendered).toEqual({ parts: [], content: "" });
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

  test("renders later parent messages below an inactive subagent until it has new activity", async () => {
    const accumulator = turn();
    const state = createTurnRenderState();
    let subagent = {
      type: "subagent" as const,
      content: "child",
      subagentId: "child-1",
      toolState: "pending" as const,
      subagentActions: [],
    };
    const render = () => renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [subagent],
    });

    accumulator.onItemCompleted({ id: "before-agent", type: "agent_message", text: "Delegating" });
    expect((await render()).parts.map((part) => part.content)).toEqual(["Delegating", "child"]);

    subagent = {
      ...subagent,
      toolState: "success",
      subagentActions: [{ type: "text" as const, content: "Finished" }],
    };
    expect((await render()).parts.map((part) => part.content)).toEqual(["Delegating", "child"]);

    accumulator.onItemCompleted({
      id: "after-agent",
      type: "agent_message",
      text: "Parent continued",
    });
    expect((await render()).parts.map((part) => part.content)).toEqual([
      "Delegating",
      "child",
      "Parent continued",
    ]);

    subagent = {
      ...subagent,
      subagentActions: [
        ...subagent.subagentActions,
        { type: "text" as const, content: "Follow-up finished" },
      ],
    };
    expect((await render()).parts.map((part) => part.content)).toEqual([
      "Delegating",
      "Parent continued",
      "child",
    ]);
  });

  test("removes stale parent, subagent, and unknown timeline keys", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "current", type: "agent_message", text: "current" });
    const state = createTurnRenderState();
    state.timelineOrder.push("item:stale", "unknown:key", "subagent:id:stale");
    state.subagentParts.set("subagent:id:stale", {
      type: "subagent",
      content: "stale child",
      subagentId: "stale",
    });
    state.subagentFingerprints.set("subagent:id:stale", "stale");

    const rendered = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [],
    });

    expect(rendered.parts.map((part) => part.content)).toEqual(["current"]);
    expect(state.timelineOrder).toEqual(["item:current"]);
    expect(state.subagentParts.size).toBe(0);
    expect(state.subagentFingerprints.size).toBe(0);
  });

  test("restores a late-materializing command to its earlier parent-item position", async () => {
    const accumulator = turn();
    const state = createTurnRenderState();
    const render = () => renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [],
    });

    accumulator.onCommandOutputDelta("command", "ab");
    accumulator.onItemCompleted({ id: "message", type: "agent_message", text: "after command" });
    expect((await render()).parts.map((part) => part.content)).toEqual(["after command"]);

    accumulator.onItemStarted({
      id: "command",
      type: "command_execution",
      command: "echo ab",
      aggregated_output: "",
      status: "in_progress",
    });
    expect((await render()).parts.map((part) => part.content)).toEqual([
      "echo ab",
      "after command",
    ]);
  });

  test("orders a parent item that arrives during loading before the changed subagent snapshot", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "before", type: "agent_message", text: "before child" });
    const state = createTurnRenderState();
    let subagent = {
      type: "subagent" as const,
      content: "child",
      subagentId: "child-1",
      toolState: "pending" as const,
    };
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });

    const firstRender = renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => {
        await loadGate;
        return [subagent];
      },
    });
    accumulator.onItemCompleted({
      id: "during-load",
      type: "agent_message",
      text: "parent during load",
    });
    subagent = { ...subagent, toolState: "success" };
    releaseLoad();
    expect((await firstRender).parts.map((part) => part.content)).toEqual([
      "before child",
      "parent during load",
      "child",
    ]);

    const secondRender = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [subagent],
    });
    expect(secondRender.parts.map((part) => part.content)).toEqual([
      "before child",
      "parent during load",
      "child",
    ]);
    expect(secondRender.content).toBe("parent during load");
  });

  test("keeps a parent arriving during loading after an unchanged existing subagent", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "before", type: "agent_message", text: "before child" });
    const state = createTurnRenderState();
    const subagent = {
      type: "subagent" as const,
      content: "child",
      subagentId: "child-1",
      toolState: "success" as const,
    };
    const render = (loadSubagentParts: () => Promise<typeof subagent[]>) =>
      renderTurn(accumulator, {
        threadId: "thread-1",
        cwd: "/tmp",
        state,
        loadSubagentParts,
      });

    expect((await render(async () => [subagent])).parts.map((part) => part.content)).toEqual([
      "before child",
      "child",
    ]);

    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const duringLoad = render(async () => {
      await loadGate;
      return [subagent];
    });
    accumulator.onItemCompleted({
      id: "during-load",
      type: "agent_message",
      text: "parent during load",
    });
    releaseLoad();

    expect((await duringLoad).parts.map((part) => part.content)).toEqual([
      "before child",
      "child",
      "parent during load",
    ]);
    expect((await render(async () => [subagent])).parts.map((part) => part.content)).toEqual([
      "before child",
      "child",
      "parent during load",
    ]);
  });

  test("selects the last assistant message as content", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "first", type: "agent_message", text: "first answer" });
    accumulator.onItemCompleted({ id: "last", type: "agent_message", text: "last answer" });

    const rendered = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state: createTurnRenderState(),
      loadSubagentParts: async () => [],
    });

    expect(rendered.parts.map((part) => part.content)).toEqual(["first answer", "last answer"]);
    expect(rendered.content).toBe("last answer");
  });

  test("falls back to the first text part when the final assistant message is empty", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "first", type: "agent_message", text: "fallback answer" });
    accumulator.onItemCompleted({ id: "empty", type: "agent_message", text: "" });

    const rendered = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state: createTurnRenderState(),
      loadSubagentParts: async () => [],
    });

    expect(rendered.parts.map((part) => part.content)).toEqual(["fallback answer", ""]);
    expect(rendered.content).toBe("fallback answer");
  });

  test("returns empty content for a tool-only turn", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({
      id: "command",
      type: "command_execution",
      command: "true",
      aggregated_output: "",
      status: "completed",
    });

    const rendered = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state: createTurnRenderState(),
      loadSubagentParts: async () => [],
    });

    expect(rendered.parts.map((part) => part.type)).toEqual(["tool-invocation"]);
    expect(rendered.content).toBe("");
  });

  test("subagent loader failure retains the last child snapshot and normal output", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "text", type: "agent_message", text: "kept" });
    const state = createTurnRenderState();
    const first = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [{
        type: "subagent",
        content: "last known child",
        subagentId: "child-1",
        toolState: "pending",
      }],
    });
    expect(first.parts.map((part) => part.content)).toEqual(["kept", "last known child"]);
    accumulator.onItemCompleted({
      id: "after-child",
      type: "agent_message",
      text: "parent after child",
    });

    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const rendered = await renderTurn(accumulator, {
        threadId: "thread-1",
        cwd: "/tmp",
        state,
        loadSubagentParts: async () => {
          throw new Error("transcript unavailable");
        },
      });
      expect(rendered.content).toBe("parent after child");
      expect(rendered.parts.map((part) => part.content)).toEqual([
        "kept",
        "last known child",
        "parent after child",
      ]);
      expect(state.subagentParts.size).toBe(1);
      expect(state.subagentFingerprints.size).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }

    const recovered = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [{
        type: "subagent",
        content: "last known child",
        subagentId: "child-1",
        toolState: "pending",
      }],
    });
    expect(recovered.parts.map((part) => part.content)).toEqual([
      "kept",
      "last known child",
      "parent after child",
    ]);

    const removed = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [],
    });
    expect(removed.parts.map((part) => part.content)).toEqual(["kept", "parent after child"]);
    expect(state.subagentParts.size).toBe(0);
    expect(state.subagentFingerprints.size).toBe(0);
  });
});
