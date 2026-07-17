import { describe, expect, test } from "bun:test";
import { deriveTranscriptSubagentPartsForTurn } from "./subagent-transcript-parts.js";
import type { TranscriptRecord } from "./subagent-transcript.js";

function transcript(records: TranscriptRecord[]) {
  return { records };
}

describe("deriveTranscriptSubagentPartsForTurn", () => {
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
});
