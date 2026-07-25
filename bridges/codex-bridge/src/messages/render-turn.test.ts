import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnAccumulator } from "../sessions/turn-accumulator.js";
import { clearTranscriptCache } from "../transcript-cache.js";
import type { NormalizedPart } from "./types.js";
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
  test("begins the first turn with fresh empty state", () => {
    const state = beginTurnRenderState(undefined);

    expect(state).toEqual({
      timelineOrder: [],
      subagentParts: new Map(),
      subagentFingerprints: new Map(),
      fileChange: { baselines: new Map(), cache: new Map() },
    });
  });

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

  test("uses content-channel reasoning when no summary is available", () => {
    const accumulator = turn();
    accumulator.onReasoningDelta("reason", "second content", "content", 1);
    accumulator.onReasoningDelta("reason", "first content", "content", 0);

    expect(effectiveItem(accumulator, accumulator.items.get("reason")!)).toMatchObject({
      type: "reasoning",
      text: "first content\n\nsecond content",
    });

    accumulator.onReasoningDelta("invisible-summary", "\u0085\u200B", "summary", 0);
    accumulator.onReasoningDelta("invisible-summary", "visible content", "content", 0);
    expect(
      effectiveItem(accumulator, accumulator.items.get("invisible-summary")!),
    ).toMatchObject({
      type: "reasoning",
      text: "visible content",
    });
  });

  test("falls back from empty authoritative reasoning but keeps nonempty authoritative text", () => {
    const accumulator = turn();
    accumulator.onReasoningDelta("empty-final", "streamed summary", "summary", 0);
    accumulator.onItemStarted({ id: "empty-final", type: "reasoning", text: "" });
    expect(effectiveItem(accumulator, accumulator.items.get("empty-final")!)).toMatchObject({
      type: "reasoning",
      text: "streamed summary",
    });

    accumulator.onReasoningDelta("nonempty-final", "stale delta", "summary", 0);
    accumulator.onItemStarted({
      id: "nonempty-final",
      type: "reasoning",
      text: "authoritative reasoning",
    });
    expect(effectiveItem(accumulator, accumulator.items.get("nonempty-final")!)).toMatchObject({
      type: "reasoning",
      text: "authoritative reasoning",
    });
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

  test("uses authoritative command output and preserves untruncated command deltas", () => {
    const accumulator = turn();
    accumulator.onCommandOutputDelta("authoritative", "streamed");
    accumulator.onItemStarted({
      id: "authoritative",
      type: "command_execution",
      command: "echo authoritative",
      aggregated_output: "final output",
      status: "completed",
    });
    expect(effectiveItem(accumulator, accumulator.items.get("authoritative")!)).toMatchObject({
      aggregated_output: "final output",
    });

    accumulator.onItemStarted({
      id: "streaming",
      type: "command_execution",
      command: "echo streaming",
      aggregated_output: "",
      status: "in_progress",
    });
    accumulator.onCommandOutputDelta("streaming", "ok");
    expect(effectiveItem(accumulator, accumulator.items.get("streaming")!)).toMatchObject({
      aggregated_output: "ok",
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

  test("omits Unicode-only invisible reasoning and preserves meaningful emoji with joiners", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({
      id: "unicode-invisible",
      type: "reasoning",
      text: "\u0085\u200B\u2060",
    });
    const meaningful = "  👩‍💻 investigated the stream  ";
    accumulator.onItemCompleted({
      id: "emoji-reasoning",
      type: "reasoning",
      text: meaningful,
    });

    const rendered = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state: createTurnRenderState(),
      loadSubagentParts: async () => [],
    });

    expect(rendered.parts).toEqual([{ type: "thinking", content: meaningful }]);
  });

  test("passes the effective turn snapshot to the subagent loader", async () => {
    const accumulator = turn();
    accumulator.onTextDelta("streamed", "hello");
    accumulator.onCommandOutputDelta("unknown", "cannot render without command metadata");
    let received:
      | {
          threadId: string | null;
          turnStartedAt?: string;
          items: Array<{ id: string; type: string }>;
        }
      | undefined;

    await renderTurn(accumulator, {
      threadId: null,
      cwd: "/tmp",
      state: createTurnRenderState(),
      loadSubagentParts: async (options) => {
        received = options;
        return [];
      },
    });

    expect(received).toEqual({
      threadId: null,
      turnStartedAt: "2026-07-25T12:00:00.000Z",
      items: [{ id: "streamed", type: "agent_message", text: "hello" }],
    });
  });

  test("loads subagent activity through the real on-disk transcript path", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "orkestrator-render-transcripts-"));
    const sessions = join(codexHome, "sessions");
    const previousCodexHome = process.env.CODEX_HOME;
    await mkdir(sessions, { recursive: true });

    const parentRecords = [
      {
        timestamp: "2026-07-25T12:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "thread-parent",
          cwd: "/workspace",
          timestamp: "2026-07-25T12:00:00.000Z",
        },
      },
      {
        timestamp: "2026-07-25T12:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "worker",
            message: "Inspect the real transcript loader",
          }),
          call_id: "call-spawn",
        },
      },
      {
        timestamp: "2026-07-25T12:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn",
          output: JSON.stringify({ agent_id: "thread-child" }),
        },
      },
    ];
    const childRecords = [
      {
        timestamp: "2026-07-25T12:00:02.000Z",
        type: "session_meta",
        payload: {
          id: "thread-child",
          cwd: "/workspace",
          timestamp: "2026-07-25T12:00:02.000Z",
          agent_nickname: "Verifier",
          agent_role: "worker",
        },
      },
      {
        timestamp: "2026-07-25T12:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          phase: "commentary",
          message: "Checked the persisted transcript.",
        },
      },
      {
        timestamp: "2026-07-25T12:00:04.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      },
    ];

    await Promise.all([
      writeFile(
        join(sessions, "thread-parent.jsonl"),
        `${parentRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      ),
      writeFile(
        join(sessions, "thread-child.jsonl"),
        `${childRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      ),
    ]);

    process.env.CODEX_HOME = codexHome;
    clearTranscriptCache();
    try {
      const accumulator = turn();
      accumulator.onItemCompleted({
        id: "answer",
        type: "agent_message",
        text: "Parent complete",
      });
      const rendered = await renderTurn(accumulator, {
        threadId: "thread-parent",
        cwd: "/workspace",
        state: createTurnRenderState(),
      });

      expect(rendered.parts).toContainEqual(expect.objectContaining({
        type: "subagent",
        subagentId: "thread-child",
        subagentName: "Verifier",
        subagentRole: "worker",
        subagentPrompt: "Inspect the real transcript loader",
        toolState: "success",
        subagentActions: [{
          type: "text",
          content: "Checked the persisted transcript.",
        }],
      }));
    } finally {
      clearTranscriptCache();
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await rm(codexHome, { recursive: true, force: true });
    }
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

  test("keeps subagent identities stable across repeated renders, reordering, updates, and removal", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "first", type: "agent_message", text: "first" });
    const state = createTurnRenderState();
    const agent1: NormalizedPart = {
      type: "subagent",
      content: "agent one",
      subagentId: "agent-1",
      toolState: "pending",
    };
    const agent2: NormalizedPart = {
      type: "subagent",
      content: "agent two",
      subagentId: "agent-2",
      toolState: "pending",
    };

    const first = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [agent1, agent2],
    });
    expect(first.parts.map((part) => part.content)).toEqual([
      "first",
      "agent one",
      "agent two",
    ]);
    expect(state.timelineOrder).toEqual([
      "item:first",
      "subagent:id:agent-1",
      "subagent:id:agent-2",
    ]);

    accumulator.onItemCompleted({ id: "second", type: "agent_message", text: "second" });
    const reordered = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [agent2, agent1],
    });
    expect(reordered.parts.map((part) => part.content)).toEqual([
      "first",
      "second",
      "agent one",
      "agent two",
    ]);
    expect(state.timelineOrder).toEqual([
      "item:first",
      "item:second",
      "subagent:id:agent-1",
      "subagent:id:agent-2",
    ]);

    const updatedAgent2: NormalizedPart = {
      ...agent2,
      content: "agent two complete",
      toolState: "success",
    };
    const updated = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [updatedAgent2],
    });
    expect(updated.parts.map((part) => ({
      content: part.content,
      state: part.toolState,
    }))).toEqual([
      { content: "first", state: undefined },
      { content: "second", state: undefined },
      { content: "agent two complete", state: "success" },
    ]);
    expect(state.timelineOrder).toEqual([
      "item:first",
      "item:second",
      "subagent:id:agent-2",
    ]);
    expect(state.subagentParts.has("subagent:id:agent-1")).toBe(false);
    expect(state.subagentFingerprints.has("subagent:id:agent-1")).toBe(false);
  });

  test("carries file baselines across turns and renders tool-only turns without message content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orkestrator-render-turn-"));
    try {
      const path = join(cwd, "example.txt");
      await writeFile(path, "one\n", "utf8");
      const firstTurn = turn();
      firstTurn.onItemCompleted({
        id: "add",
        type: "file_change",
        changes: [{ path: "example.txt", kind: "add" }],
        status: "completed",
      });
      const firstState = createTurnRenderState();
      const added = await renderTurn(firstTurn, {
        threadId: "thread-1",
        cwd,
        state: firstState,
        loadSubagentParts: async () => [],
      });
      expect(added.content).toBe("");
      expect(added.parts[0]).toMatchObject({
        type: "tool-invocation",
        toolName: "apply_patch",
        toolDiff: {
          before: undefined,
          after: "one\n",
          additions: 1,
          deletions: 0,
        },
      });

      await writeFile(path, "one\ntwo\n", "utf8");
      const secondTurn = turn();
      secondTurn.onItemCompleted({
        id: "update",
        type: "file_change",
        changes: [{ path: "example.txt", kind: "update" }],
        status: "completed",
      });
      const secondState = beginTurnRenderState(firstState);
      const updated = await renderTurn(secondTurn, {
        threadId: "thread-1",
        cwd,
        state: secondState,
        loadSubagentParts: async () => [],
      });
      expect(updated.content).toBe("");
      expect(updated.parts[0]).toMatchObject({
        type: "tool-invocation",
        toolName: "apply_patch",
        toolDiff: {
          before: "one\n",
          after: "one\ntwo\n",
          additions: 1,
          deletions: 0,
        },
      });
      expect(updated.parts[0]?.toolDiff?.diff).toContain("+two");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("uses the last assistant message and falls back past an empty final message", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "first", type: "agent_message", text: "first answer" });
    accumulator.onItemCompleted({ id: "second", type: "agent_message", text: "last answer" });
    const options = {
      threadId: "thread-1",
      cwd: "/tmp",
      state: createTurnRenderState(),
      loadSubagentParts: async () => [],
    };

    const multiple = await renderTurn(accumulator, options);
    expect(multiple.content).toBe("last answer");

    accumulator.onItemCompleted({ id: "empty-final", type: "agent_message", text: "" });
    const withEmptyFinal = await renderTurn(accumulator, options);
    expect(withEmptyFinal.parts.filter((part) => part.type === "text").map((part) => part.content))
      .toEqual(["first answer", "last answer", ""]);
    expect(withEmptyFinal.content).toBe("last answer");
  });

  test("keeps content empty for tool- and subagent-only turns", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({
      id: "command",
      type: "command_execution",
      command: "echo done",
      aggregated_output: "done",
      status: "completed",
    });

    const rendered = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state: createTurnRenderState(),
      loadSubagentParts: async () => [{
        type: "subagent",
        content: "child complete",
        subagentId: "child-1",
        toolState: "success",
      }],
    });

    expect(rendered.parts.map((part) => part.type)).toEqual([
      "tool-invocation",
      "subagent",
    ]);
    expect(rendered.content).toBe("");
  });

  test("subagent loader failure is additive and never blanks normal output", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "text", type: "agent_message", text: "kept" });
    const state = createTurnRenderState();
    const first = await renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [{
        type: "subagent",
        content: "last known child detail",
        subagentId: "child-1",
        toolState: "pending",
      }],
    });
    expect(first.parts.map((part) => part.type)).toEqual(["text", "subagent"]);

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
      expect(rendered.content).toBe("kept");
      expect(rendered.parts).toContainEqual(expect.objectContaining({
        type: "subagent",
        content: "last known child detail",
        subagentId: "child-1",
      }));
      expect(state.subagentParts.has("subagent:id:child-1")).toBe(true);
      expect(error).toHaveBeenCalledTimes(1);

      const authoritativeRemoval = await renderTurn(accumulator, {
        threadId: "thread-1",
        cwd: "/tmp",
        state,
        loadSubagentParts: async () => [],
      });
      expect(authoritativeRemoval.parts.map((part) => part.type)).toEqual(["text"]);
      expect(state.subagentParts.size).toBe(0);
    } finally {
      error.mockRestore();
    }
  });
});
