import { describe, expect, test } from "bun:test";
import { deriveTranscriptSubagentPartsForTurn } from "./subagent-transcript-parts.js";
import type { TranscriptRecord } from "./subagent-transcript.js";

function transcript(records: TranscriptRecord[]) {
  return { records };
}

function validFernetEnvelope(): string {
  return Buffer.concat([
    Buffer.from([0x80]),
    Buffer.alloc(8),
    Buffer.alloc(16),
    Buffer.alloc(16),
    Buffer.alloc(32),
  ]).toString("base64url");
}

describe("deriveTranscriptSubagentPartsForTurn", () => {
  test("returns empty before loading when required turn identity is missing", async () => {
    let loadCount = 0;
    const options = {
      loadSessionMeta: async () => {
        loadCount += 1;
        return { transcriptPath: "/tmp/parent.jsonl" };
      },
      loadTranscript: async () => transcript([]),
    };

    expect(await deriveTranscriptSubagentPartsForTurn(options)).toEqual([]);
    expect(await deriveTranscriptSubagentPartsForTurn({
      ...options,
      threadId: "thread-1",
    })).toEqual([]);
    expect(await deriveTranscriptSubagentPartsForTurn({
      ...options,
      currentTurnStartedAt: "2026-07-17T17:02:00.000Z",
    })).toEqual([]);
    expect(loadCount).toBe(0);
  });

  test("returns empty when parent metadata or its transcript path is missing", async () => {
    for (const parentMeta of [null, {}, { transcriptPath: null }]) {
      let transcriptLoads = 0;
      const parts = await deriveTranscriptSubagentPartsForTurn({
        threadId: "thread-1",
        currentTurnStartedAt: "2026-07-17T17:02:00.000Z",
        loadSessionMeta: async () => parentMeta,
        loadTranscript: async () => {
          transcriptLoads += 1;
          return transcript([]);
        },
      });

      expect(parts).toEqual([]);
      expect(transcriptLoads).toBe(0);
    }
  });

  test("returns empty when the current turn timestamp is invalid", async () => {
    const parts = await deriveTranscriptSubagentPartsForTurn({
      threadId: "thread-1",
      currentTurnStartedAt: "not-a-date",
      loadSessionMeta: async () => ({ transcriptPath: "/tmp/parent.jsonl" }),
      loadTranscript: async () => transcript([]),
    });

    expect(parts).toEqual([]);
  });

  test("filters parent transcript records to the current turn and keeps missing child transcripts pending", async () => {
    const parentRecords: TranscriptRecord[] = [
      {
        timestamp: "2026-04-16T11:16:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "explorer",
            message: "Old turn",
          }),
          call_id: "call-old",
        },
      },
      {
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "worker",
            message: "Current turn",
          }),
          call_id: "call-current",
        },
      },
      {
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-current",
          output: JSON.stringify({
            agent_id: "agent-current",
            nickname: "Shannon",
          }),
        },
      },
    ];

    const parts = await deriveTranscriptSubagentPartsForTurn({
      threadId: "thread-1",
      currentTurnStartedAt: "2026-04-16T11:17:00.000Z",
      loadSessionMeta: async (id) => {
        if (id === "thread-1") {
          return { transcriptPath: "/tmp/parent.jsonl" };
        }

        return null;
      },
      loadTranscript: async () => transcript(parentRecords),
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]?.subagentPrompt).toBe("Current turn");
    expect(parts[0]?.toolState).toBe("pending");
    expect(parts[0]?.subagentActions).toEqual([]);
  });

  test("loads child transcripts and derives completed subagent activity", async () => {
    const parentRecords: TranscriptRecord[] = [
      {
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "explorer",
            message: "Inspect the bridge",
          }),
          call_id: "call-current",
        },
      },
      {
        timestamp: "2026-04-16T11:17:23.681Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-current",
          output: JSON.stringify({
            agent_id: "agent-current",
            nickname: "Hopper",
          }),
        },
      },
    ];
    const childRecords: TranscriptRecord[] = [
      {
        timestamp: "2026-04-16T11:17:23.700Z",
        type: "session_meta",
        payload: {
          id: "agent-current",
          agent_nickname: "Hopper",
          agent_role: "explorer",
        },
      },
      {
        timestamp: "2026-04-16T11:17:24.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          phase: "commentary",
          message: "Checking the transcript.",
        },
      },
      {
        timestamp: "2026-04-16T11:17:25.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
        },
      },
    ];

    const parts = await deriveTranscriptSubagentPartsForTurn({
      threadId: "thread-1",
      currentTurnStartedAt: "2026-04-16T11:17:00.000Z",
      loadSessionMeta: async (id) => {
        if (id === "thread-1") {
          return { transcriptPath: "/tmp/parent.jsonl" };
        }
        if (id === "agent-current") {
          return { transcriptPath: "/tmp/agent-current.jsonl" };
        }

        return null;
      },
      loadTranscript: async (path) =>
        path.endsWith("parent.jsonl") ? transcript(parentRecords) : transcript(childRecords),
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]?.toolState).toBe("success");
    expect(parts[0]?.subagentActions).toEqual([
      {
        type: "text",
        content: "Checking the transcript.",
      },
    ]);
  });

  test("uses streamed receiver IDs when spawn outputs contain only task names", async () => {
    const parentRecords: TranscriptRecord[] = [
      {
        timestamp: "2026-07-17T17:02:45.778Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ task_name: "review", message: "encrypted" }),
          call_id: "call-spawn",
        },
      },
      {
        timestamp: "2026-07-17T17:02:45.922Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn",
          output: JSON.stringify({ task_name: "/root/review" }),
        },
      },
    ];
    const childRecords: TranscriptRecord[] = [
      {
        timestamp: "2026-07-17T17:02:45.916Z",
        type: "session_meta",
        payload: {
          id: "child-thread-id",
          agent_nickname: "Ampere",
        },
      },
      {
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
      },
      {
        timestamp: "2026-07-17T17:02:47.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      },
    ];
    const requestedThreadIds: string[] = [];

    const parts = await deriveTranscriptSubagentPartsForTurn({
      threadId: "parent-thread-id",
      currentTurnStartedAt: "2026-07-17T17:02:00.000Z",
      fallbackAgentIdsInSpawnOrder: ["child-thread-id"],
      loadSessionMeta: async (id) => {
        requestedThreadIds.push(id);
        if (id === "parent-thread-id") {
          return { transcriptPath: "/tmp/parent.jsonl" };
        }
        if (id === "child-thread-id") {
          return { transcriptPath: "/tmp/child.jsonl" };
        }
        return null;
      },
      loadTranscript: async (path) =>
        path.endsWith("parent.jsonl") ? transcript(parentRecords) : transcript(childRecords),
    });

    expect(requestedThreadIds).toEqual(["parent-thread-id", "child-thread-id"]);
    expect(parts).toEqual([
      expect.objectContaining({
        subagentId: "child-thread-id",
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

  test("resolves multi-agent v2 spawns via sub_agent_activity ahead of positional fallbacks", async () => {
    const parentRecords: TranscriptRecord[] = [
      {
        timestamp: "2026-07-17T20:43:07.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            task_name: "coverage_review",
            message: validFernetEnvelope(),
          }),
          call_id: "call-spawn-v2",
        },
      },
      {
        timestamp: "2026-07-17T20:43:08.706Z",
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          event_id: "call-spawn-v2",
          agent_thread_id: "activity-thread-id",
          agent_path: "/root/coverage_review",
          kind: "started",
        },
      },
      {
        timestamp: "2026-07-17T20:43:08.800Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-spawn-v2",
          output: JSON.stringify({ task_name: "/root/coverage_review" }),
        },
      },
    ];
    const childRecords: TranscriptRecord[] = [
      {
        timestamp: "2026-07-17T20:43:08.701Z",
        type: "session_meta",
        payload: { id: "activity-thread-id", agent_nickname: "Hypatia" },
      },
      {
        timestamp: "2026-07-17T20:43:09.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Audit test coverage." },
      },
      {
        timestamp: "2026-07-17T20:43:10.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "child-call",
          input: "bun test",
          status: "completed",
          output: "all green",
        },
      },
      {
        timestamp: "2026-07-17T20:44:00.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      },
    ];
    const requestedThreadIds: string[] = [];

    const parts = await deriveTranscriptSubagentPartsForTurn({
      threadId: "parent-thread-id",
      currentTurnStartedAt: "2026-07-17T20:43:00.000Z",
      fallbackAgentIdsInSpawnOrder: ["stale-fallback-id"],
      loadSessionMeta: async (id) => {
        requestedThreadIds.push(id);
        if (id === "parent-thread-id") {
          return { transcriptPath: "/tmp/parent.jsonl" };
        }
        if (id === "activity-thread-id") {
          return { transcriptPath: "/tmp/child.jsonl" };
        }
        return null;
      },
      loadTranscript: async (path) =>
        path.endsWith("parent.jsonl") ? transcript(parentRecords) : transcript(childRecords),
    });

    expect(requestedThreadIds).toEqual(["parent-thread-id", "activity-thread-id"]);
    expect(parts).toEqual([
      expect.objectContaining({
        subagentId: "activity-thread-id",
        subagentName: "Hypatia",
        subagentRole: "coverage_review",
        subagentPrompt: undefined,
        subagentActionCount: 1,
        toolState: "success",
      }),
    ]);
  });

  test("keeps positional fallbacks aligned across multiple spawns and prefers matching output IDs", async () => {
    const parentRecords: TranscriptRecord[] = [
      {
        timestamp: "2026-07-17T17:02:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: "Use the fallback" }),
          call_id: "call-fallback",
        },
      },
      {
        timestamp: "2026-07-17T17:02:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-fallback",
          output: JSON.stringify({ task_name: "/root/fallback" }),
        },
      },
      {
        timestamp: "2026-07-17T17:02:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: "Use the output" }),
          call_id: "call-output",
        },
      },
      {
        timestamp: "2026-07-17T17:02:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-output",
          output: JSON.stringify({ agent_id: "output-agent" }),
        },
      },
    ];
    const loadedIds: string[] = [];

    const parts = await deriveTranscriptSubagentPartsForTurn({
      threadId: "parent-thread-id",
      currentTurnStartedAt: "2026-07-17T17:02:00.000Z",
      fallbackAgentIdsInSpawnOrder: ["fallback-agent", "ignored-fallback"],
      loadSessionMeta: async (id) => {
        loadedIds.push(id);
        return { transcriptPath: `/tmp/${id}.jsonl` };
      },
      loadTranscript: async (path) => path.endsWith("parent-thread-id.jsonl")
        ? transcript(parentRecords)
        : transcript([{ type: "event_msg", payload: { type: "task_complete" } }]),
    });

    expect(loadedIds).toEqual(["parent-thread-id", "fallback-agent", "output-agent"]);
    expect(parts.map((part) => [part.subagentPrompt, part.subagentId, part.toolState])).toEqual([
      ["Use the fallback", "fallback-agent", "success"],
      ["Use the output", "output-agent", "success"],
    ]);
  });

  test("does not shift a later fallback into a spawn whose positional slot is blank", async () => {
    const parentRecords: TranscriptRecord[] = [
      {
        timestamp: "2026-07-17T17:02:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: "No receiver" }),
          call_id: "call-one",
        },
      },
      {
        timestamp: "2026-07-17T17:02:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: "Has receiver" }),
          call_id: "call-two",
        },
      },
    ];
    const loadedIds: string[] = [];

    const parts = await deriveTranscriptSubagentPartsForTurn({
      threadId: "parent",
      currentTurnStartedAt: "2026-07-17T17:02:00.000Z",
      fallbackAgentIdsInSpawnOrder: [undefined, "agent-two"],
      loadSessionMeta: async (id) => {
        loadedIds.push(id);
        return { transcriptPath: `/tmp/${id}.jsonl` };
      },
      loadTranscript: async (path) => path.endsWith("parent.jsonl")
        ? transcript(parentRecords)
        : transcript([]),
    });

    expect(loadedIds).toEqual(["parent", "agent-two"]);
    expect(parts.map((part) => [part.subagentPrompt, part.subagentId])).toEqual([
      ["No receiver", undefined],
      ["Has receiver", "agent-two"],
    ]);
  });

  test("leaves output-less spawns unresolved when fallbacks are absent or whitespace", async () => {
    const parentRecords: TranscriptRecord[] = ["call-absent", "call-blank"].map((callId, index) => ({
      timestamp: `2026-07-17T17:02:0${index + 1}.000Z`,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: JSON.stringify({ message: callId }),
        call_id: callId,
      },
    }));
    const childLoads: string[] = [];

    const partsWithoutFallbacks = await deriveTranscriptSubagentPartsForTurn({
      threadId: "parent",
      currentTurnStartedAt: "2026-07-17T17:02:00.000Z",
      loadSessionMeta: async (id) => ({ transcriptPath: `/tmp/${id}.jsonl` }),
      loadTranscript: async (path) => path.endsWith("parent.jsonl")
        ? transcript(parentRecords)
        : (childLoads.push(path), transcript([])),
    });
    const partsWithBlankFallbacks = await deriveTranscriptSubagentPartsForTurn({
      threadId: "parent",
      currentTurnStartedAt: "2026-07-17T17:02:00.000Z",
      fallbackAgentIdsInSpawnOrder: ["", "   "],
      loadSessionMeta: async (id) => ({ transcriptPath: `/tmp/${id}.jsonl` }),
      loadTranscript: async (path) => path.endsWith("parent.jsonl")
        ? transcript(parentRecords)
        : (childLoads.push(path), transcript([])),
    });

    expect(partsWithoutFallbacks.map((part) => part.subagentId)).toEqual([undefined, undefined]);
    expect(partsWithBlankFallbacks.map((part) => part.subagentId)).toEqual([undefined, undefined]);
    expect(childLoads).toEqual([]);
  });

  test("ignores malformed, mismatched, and timestamp-less spawn outputs", async () => {
    const parentRecords: TranscriptRecord[] = [
      {
        timestamp: "2026-07-17T17:02:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: "Current spawn" }),
          call_id: "call-current",
        },
      },
      {
        timestamp: "2026-07-17T17:02:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-current",
          output: "{broken",
        },
      },
      {
        timestamp: "2026-07-17T17:02:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "different-call",
          output: JSON.stringify({ agent_id: "wrong-agent" }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-current",
          output: JSON.stringify({ agent_id: "timestamp-less-agent" }),
        },
      },
      {
        timestamp: "invalid-date",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-current",
          output: JSON.stringify({ agent_id: "invalid-date-agent" }),
        },
      },
    ];
    const loadedIds: string[] = [];

    const parts = await deriveTranscriptSubagentPartsForTurn({
      threadId: "parent",
      currentTurnStartedAt: "2026-07-17T17:02:00.000Z",
      fallbackAgentIdsInSpawnOrder: ["fallback-agent"],
      loadSessionMeta: async (id) => {
        loadedIds.push(id);
        return { transcriptPath: `/tmp/${id}.jsonl` };
      },
      loadTranscript: async (path) => path.endsWith("parent.jsonl")
        ? transcript(parentRecords)
        : transcript([]),
    });

    expect(loadedIds).toEqual(["parent", "fallback-agent"]);
    expect(parts).toEqual([
      expect.objectContaining({ subagentId: "fallback-agent", subagentPrompt: "Current spawn" }),
    ]);
  });

  test("loads a duplicate child transcript once while retaining both spawn parts", async () => {
    const parentRecords: TranscriptRecord[] = ["call-one", "call-two"].map((callId, index) => ({
      timestamp: `2026-07-17T17:02:0${index + 1}.000Z`,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: JSON.stringify({ message: `Prompt ${index + 1}` }),
        call_id: callId,
      },
    }));
    let childMetaLoads = 0;
    let childTranscriptLoads = 0;

    const parts = await deriveTranscriptSubagentPartsForTurn({
      threadId: "parent",
      currentTurnStartedAt: "2026-07-17T17:02:00.000Z",
      fallbackAgentIdsInSpawnOrder: ["shared-agent", "shared-agent"],
      loadSessionMeta: async (id) => {
        if (id === "shared-agent") childMetaLoads += 1;
        return { transcriptPath: `/tmp/${id}.jsonl` };
      },
      loadTranscript: async (path) => {
        if (path.endsWith("parent.jsonl")) return transcript(parentRecords);
        childTranscriptLoads += 1;
        return transcript([]);
      },
    });

    expect(parts.map((part) => part.subagentId)).toEqual(["shared-agent", "shared-agent"]);
    expect(childMetaLoads).toBe(1);
    expect(childTranscriptLoads).toBe(1);
  });

  test("returns empty when every parent record is outside the current turn", async () => {
    const parts = await deriveTranscriptSubagentPartsForTurn({
      threadId: "parent",
      currentTurnStartedAt: "2026-07-17T17:02:00.000Z",
      loadSessionMeta: async () => ({ transcriptPath: "/tmp/parent.jsonl" }),
      loadTranscript: async () => transcript([
        { timestamp: "2026-07-17T17:01:59.999Z", type: "response_item", payload: {} },
        { timestamp: "invalid", type: "response_item", payload: {} },
        { type: "response_item", payload: {} },
      ]),
    });

    expect(parts).toEqual([]);
  });

  test("propagates rejected metadata and transcript loaders", async () => {
    const validSpawn: TranscriptRecord = {
      timestamp: "2026-07-17T17:02:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: "{}",
        call_id: "call-spawn",
      },
    };
    const options = {
      threadId: "parent",
      currentTurnStartedAt: "2026-07-17T17:02:00.000Z",
      fallbackAgentIdsInSpawnOrder: ["child"],
    };

    await expect(deriveTranscriptSubagentPartsForTurn({
      ...options,
      loadSessionMeta: async () => { throw new Error("parent meta failed"); },
      loadTranscript: async () => transcript([]),
    })).rejects.toThrow("parent meta failed");

    await expect(deriveTranscriptSubagentPartsForTurn({
      ...options,
      loadSessionMeta: async () => ({ transcriptPath: "/tmp/parent.jsonl" }),
      loadTranscript: async () => { throw new Error("parent transcript failed"); },
    })).rejects.toThrow("parent transcript failed");

    await expect(deriveTranscriptSubagentPartsForTurn({
      ...options,
      loadSessionMeta: async (id) => {
        if (id === "child") throw new Error("child meta failed");
        return { transcriptPath: "/tmp/parent.jsonl" };
      },
      loadTranscript: async () => transcript([validSpawn]),
    })).rejects.toThrow("child meta failed");

    await expect(deriveTranscriptSubagentPartsForTurn({
      ...options,
      loadSessionMeta: async (id) => ({ transcriptPath: `/tmp/${id}.jsonl` }),
      loadTranscript: async (path) => {
        if (path.endsWith("child.jsonl")) throw new Error("child transcript failed");
        return transcript([validSpawn]);
      },
    })).rejects.toThrow("child transcript failed");
  });
});
