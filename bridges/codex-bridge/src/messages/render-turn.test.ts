import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnAccumulator } from "../sessions/turn-accumulator.js";
import { clearTranscriptCache } from "../transcript-cache.js";
import {
  SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS,
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
    expect(state.completedItemParts.size).toBe(0);
    expect(state.subagentParts.size).toBe(0);
    expect(state.subagentFingerprints.size).toBe(0);
    expect(state.fileChange.baselines.size).toBe(0);
    expect(state.fileChange.cache.size).toBe(0);
  });

  test("begins a new turn with baselines retained and per-item state cleared", () => {
    const previous = createTurnRenderState();
    previous.timelineOrder.push("item:old");
    previous.completedItemParts.set("old", { source: null, parts: [] });
    previous.subagentParts.set("agent:old", { type: "subagent", content: "old" });
    previous.subagentFingerprints.set("agent:old", "old");
    previous.fileChange.baselines.set("a.ts", "before");
    previous.fileChange.cache.set("old", { filePath: "a.ts" });

    const next = beginTurnRenderState(previous);
    expect(next.timelineOrder).toEqual([]);
    expect(next.completedItemParts.size).toBe(0);
    expect(next.subagentParts.size).toBe(0);
    expect(next.subagentFingerprints.size).toBe(0);
    expect(next.fileChange.baselines.get("a.ts")).toBe("before");
    expect(next.fileChange.cache.size).toBe(0);
  });

  test("release clears all retained render memory", () => {
    const state = createTurnRenderState();
    state.timelineOrder.push("x");
    state.completedItemParts.set("x", { source: null, parts: [] });
    state.subagentParts.set("a", { type: "subagent", content: "x" });
    state.subagentFingerprints.set("a", "fingerprint");
    state.fileChange.baselines.set("a.ts", "x");
    state.fileChange.cache.set("a", { filePath: "a.ts" });
    releaseTurnRenderState(state);
    expect(state.timelineOrder).toEqual([]);
    expect(state.completedItemParts.size).toBe(0);
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

  test("uses content-channel reasoning when no visible summary is available", () => {
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

  test("hides successful raw patch candidates until the turn is terminal", () => {
    const accumulator = turn();
    accumulator.onDynamicToolStarted({
      id: "raw-patch",
      type: "dynamic_tool_call",
      tool: "apply_patch",
      arguments: "*** Begin Patch",
      content_items: [],
      status: "in_progress",
    });
    accumulator.onDynamicToolOutput("raw-patch", "Done!");

    expect(effectiveItem(
      accumulator,
      accumulator.items.get("raw-patch")!,
    )).toBeNull();

    accumulator.complete("completed");
    expect(effectiveItem(
      accumulator,
      accumulator.items.get("raw-patch")!,
    )).toMatchObject({
      type: "dynamic_tool_call",
      status: "completed",
    });
  });

  test("keeps the structured patch preview visible when the raw call follows it", () => {
    const accumulator = turn();
    // The live diff app-server streams while the model writes the patch. The
    // raw `custom_tool_call` for the same call id arrives afterwards and must
    // not hide it — behind an approval prompt this gap is user-visible for as
    // long as the human takes to answer.
    accumulator.onItemUpdated({
      id: "call-patch",
      type: "file_change",
      changes: [{ path: "src/a.ts", kind: "update" }],
      status: "in_progress",
    });
    accumulator.onDynamicToolStarted({
      id: "call-patch",
      type: "dynamic_tool_call",
      tool: "apply_patch",
      arguments: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+A\n*** End Patch",
      content_items: [],
      status: "in_progress",
    });

    expect(effectiveItem(
      accumulator,
      accumulator.items.get("call-patch")!,
    )).toMatchObject({ type: "file_change", status: "in_progress" });
  });

  test("a failed raw patch is visible immediately, without waiting for the turn", () => {
    const accumulator = turn();
    accumulator.onDynamicToolStarted({
      id: "raw-patch",
      type: "dynamic_tool_call",
      tool: "apply_patch",
      arguments: "*** Begin Patch\n*** Update File: missing.ts\n@@\n-a\n+A\n*** End Patch",
      content_items: [],
      status: "in_progress",
    });
    // No structured `fileChange` is coming for a failure, so holding it back
    // would leave the user with no sign the patch was even attempted.
    accumulator.onDynamicToolOutput(
      "raw-patch",
      "Failed to read file to update: missing.ts",
    );

    expect(accumulator.isTerminal()).toBe(false);
    expect(effectiveItem(
      accumulator,
      accumulator.items.get("raw-patch")!,
    )).toMatchObject({ type: "dynamic_tool_call", status: "failed" });
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
  test("reuses normalized parts for immutable completed items", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({
      id: "completed",
      type: "agent_message",
      text: "stable",
    });
    const state = createTurnRenderState();
    const render = () => renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      loadSubagentParts: async () => [],
    });

    const first = await render();
    accumulator.onTextDelta("streaming", "new");
    const second = await render();

    expect(second.parts[0]).toBe(first.parts[0]);
    expect(second.parts[1]).not.toBe(first.parts[0]);
    expect(state.completedItemParts.size).toBe(1);
  });

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

  test("passes each assistant segment's item and transcript boundaries to rendering", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "before", type: "agent_message", text: "before" });
    const boundary = accumulator.freezeAssistantSegment(
      undefined,
      "2026-07-25T12:00:01.000Z",
    );
    accumulator.startAssistantSegment(
      "message-2",
      boundary,
      "2026-07-25T12:00:01.000Z",
    );
    accumulator.onItemCompleted({ id: "after", type: "agent_message", text: "after" });
    const received: Array<Record<string, unknown>> = [];

    for (const segment of accumulator.assistantSegmentsInOrder()) {
      await renderTurn(accumulator, {
        threadId: "thread-1",
        cwd: "/tmp",
        state: createTurnRenderState(),
        segment,
        loadSubagentParts: async (options) => {
          received.push(options);
          return [];
        },
      });
    }

    expect(received).toEqual([
      {
        threadId: "thread-1",
        turnStartedAt: "2026-07-25T12:00:00.000Z",
        turnEndedAt: "2026-07-25T12:00:01.000Z",
        items: [{ id: "before", type: "agent_message", text: "before" }],
      },
      {
        threadId: "thread-1",
        turnStartedAt: "2026-07-25T12:00:01.000Z",
        items: [{ id: "after", type: "agent_message", text: "after" }],
      },
    ]);
  });

  test("scopes sub-agent discovery by the ids a row's own items claim", async () => {
    const seen: Array<readonly string[] | undefined> = [];
    const derive = async (items: Array<Record<string, unknown>>) => {
      await loadSubagentPartsFromTranscripts({
        threadId: "thread-1",
        turnStartedAt: "2026-07-25T12:00:00.000Z",
        items: items as never,
      }, {
        createTranscriptMetaLoader: () => async (threadId) => ({
          id: threadId,
          updatedAt: "2026-07-25T12:00:00.000Z",
          transcriptPath: `/transcripts/${threadId}.jsonl`,
        }),
        deriveTranscriptParts: async (options) => {
          seen.push(options.ownedSubagentIds);
          return [];
        },
        readTranscript: async () => ({ records: [] }),
      });
    };
    const spawn = (id: string, receiver?: string) => ({
      id,
      type: "collab_tool_call" as const,
      tool: "spawn_agent",
      ...(receiver ? { receiver_thread_ids: [receiver] } : {}),
      status: "completed" as const,
    });

    await derive([spawn("a", "child-1"), spawn("b", "child-2")]);
    // A row that cannot name every spawn it owns must not filter on a partial
    // set, or the ones it failed to name would vanish.
    await derive([spawn("a", "child-1"), spawn("b")]);
    await derive([]);

    expect(seen).toEqual([["child-1", "child-2"], undefined, undefined]);
  });

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

  test("uses the production subagent loader safely when no thread exists yet", async () => {
    const rendered = await renderTurn(turn(), {
      threadId: null,
      cwd: "/tmp",
      state: createTurnRenderState(),
    });

    expect(rendered).toEqual({ parts: [], content: "" });
  });

  test("throttled probes retain the previous snapshot and always run on a terminal turn", async () => {
    const accumulator = turn();
    accumulator.onItemCompleted({ id: "text", type: "agent_message", text: "done" });
    const state = createTurnRenderState();
    let loads = 0;
    const render = () => renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      subagentProbeIntervalMs: 60_000,
      loadSubagentParts: async () => {
        loads += 1;
        return [{
          type: "subagent",
          content: "child",
          subagentId: "child-1",
          toolState: "pending",
        }];
      },
    });

    // First render probes (nothing has probed yet)…
    expect((await render()).parts.map((part) => part.type)).toEqual(["text", "subagent"]);
    expect(loads).toBe(1);

    // …renders inside the interval skip the probe but keep the snapshot…
    expect((await render()).parts.map((part) => part.type)).toEqual(["text", "subagent"]);
    expect(loads).toBe(1);

    // …and a terminal turn probes regardless of the interval.
    accumulator.complete("completed");
    await render();
    expect(loads).toBe(2);
  });

  test("the shipped probe interval actually throttles", async () => {
    // `probeIntervalMs <= 0` means "probe on every render", which is the
    // ~10x/second disk read this constant exists to stop. Nothing else pins the
    // exported value, so a zeroed or negated one would regress silently.
    expect(SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS).toBeGreaterThan(0);

    const accumulator = turn();
    accumulator.onItemCompleted({ id: "text", type: "agent_message", text: "done" });
    const state = createTurnRenderState();
    let loads = 0;
    const render = () => renderTurn(accumulator, {
      threadId: "thread-1",
      cwd: "/tmp",
      state,
      subagentProbeIntervalMs: SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS,
      loadSubagentParts: async () => {
        loads += 1;
        return [];
      },
    });

    await render();
    await render();
    await render();
    expect(loads).toBe(1);
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
      firstState.fileChange.baselines.set("unused.txt", "cold\n");

      await writeFile(path, "one\ntwo\n", "utf8");
      const firstAgain = await renderTurn(firstTurn, {
        threadId: "thread-1",
        cwd,
        state: firstState,
        loadSubagentParts: async () => [],
      });
      // A completed file-change item is immutable. Re-rendering because a newer
      // item streamed must reuse its original normalized diff rather than read
      // the file's newer contents and silently rewrite history.
      expect(firstAgain.parts[0]).toBe(added.parts[0]);
      expect(firstAgain.parts[0]?.toolDiff?.after).toBe("one\n");
      expect([...firstState.fileChange.baselines.keys()]).toEqual([
        "unused.txt",
        "example.txt",
      ]);

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
