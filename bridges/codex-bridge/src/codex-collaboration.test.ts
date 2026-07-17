import { describe, expect, test } from "bun:test";
import type { TranscriptSubagentPart } from "./subagent-transcript.js";
import {
  applyCodexCollabStateToSubagentParts,
  getCodexSpawnedAgentIdsInOrder,
  isCodexCollabToolCallItem,
  normalizeCodexCollabToolCallItem,
  reconcileCodexSubagentTimeline,
} from "./codex-collaboration.js";

function makeAgent(
  id?: string,
  overrides: Partial<TranscriptSubagentPart> = {},
): TranscriptSubagentPart {
  return {
    type: "subagent",
    content: id ?? "subagent",
    subagentId: id,
    subagentActions: [],
    subagentActionCount: 0,
    toolState: "pending",
    ...overrides,
  };
}

describe("Codex collaboration payload normalization", () => {
  test("rejects malformed required fields and leaves transcript parts unchanged", () => {
    const transcript = [makeAgent("existing")];
    for (const value of [
      null,
      [],
      { type: "collab_tool_call", id: "", tool: "spawn_agent" },
      { type: "collab_tool_call", id: "spawn", tool: 42 },
      { type: "agent_message", id: "message", tool: "spawn_agent" },
    ]) {
      expect(normalizeCodexCollabToolCallItem(value)).toBeNull();
      expect(applyCodexCollabStateToSubagentParts(transcript, [value])).toBe(transcript);
    }
  });

  test("normalizes identifiers and ignores malformed optional state", () => {
    const normalized = normalizeCodexCollabToolCallItem({
      id: " spawn-1 ",
      type: "collab_tool_call",
      tool: " spawn_agent ",
      sender_thread_id: 42,
      receiver_thread_ids: [" agent-1 ", "", 7, "agent-1"],
      prompt: 42,
      agents_states: {
        " agent-1 ": { status: "future-status", message: 42 },
        "agent-2": null,
      },
      status: "future-status",
    });

    expect(normalized).toEqual({
      id: "spawn-1",
      type: "collab_tool_call",
      tool: "spawn_agent",
      receiver_thread_ids: ["agent-1"],
      agents_states: { "agent-1": {} },
    });
    expect(isCodexCollabToolCallItem({
      id: "spawn-1",
      type: "collab_tool_call",
      tool: "spawn_agent",
      agents_states: { "agent-1": { message: 42 } },
    })).toBe(false);
    expect(() => applyCodexCollabStateToSubagentParts([], [normalized])).not.toThrow();
  });

  test("returns spawned receiver thread IDs in invocation order", () => {
    expect(getCodexSpawnedAgentIdsInOrder([
      {
        id: "spawn-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        receiver_thread_ids: ["agent-1"],
      },
      {
        id: "wait-1",
        type: "collab_tool_call",
        tool: "wait",
        receiver_thread_ids: ["agent-1"],
      },
      {
        id: "spawn-2",
        type: "collab_tool_call",
        tool: "spawn",
        agents_states: { "agent-2": { status: "running" } },
      },
    ])).toEqual(["agent-1", "agent-2"]);
  });
});

describe("Codex collaboration state", () => {
  test("creates all identified running agents before transcripts are available", () => {
    const parts = applyCodexCollabStateToSubagentParts([], [
      {
        id: "spawn-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Review the bridge event handling",
        receiver_thread_ids: ["thread-agent-1", "thread-agent-2"],
        agents_states: {
          "thread-agent-1": { status: "running" },
          "thread-agent-2": { status: "pending_init" },
        },
        status: "completed",
      },
    ]);

    expect(parts.map((part) => ({
      id: part.subagentId,
      prompt: part.subagentPrompt,
      state: part.toolState,
    }))).toEqual([
      {
        id: "thread-agent-1",
        prompt: "Review the bridge event handling",
        state: "pending",
      },
      {
        id: "thread-agent-2",
        prompt: "Review the bridge event handling",
        state: "pending",
      },
    ]);
  });

  test("maps every terminal and active agent status", () => {
    const cases = [
      ["pending_init", "pending"],
      ["running", "pending"],
      ["completed", "success"],
      ["shutdown", "success"],
      ["interrupted", "failure"],
      ["errored", "failure"],
      ["not_found", "failure"],
    ] as const;

    for (const [status, expected] of cases) {
      const [part] = applyCodexCollabStateToSubagentParts(
        [makeAgent("agent-1")],
        [{
          id: `wait-${status}`,
          type: "collab_tool_call",
          tool: "wait",
          receiver_thread_ids: ["agent-1"],
          agents_states: { "agent-1": { status } },
          status: "completed",
        }],
      );
      expect(part?.toolState).toBe(expected);
    }
  });

  test("preserves the original spawn prompt over follow-up messages", () => {
    const [part] = applyCodexCollabStateToSubagentParts([], [
      {
        id: "spawn-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Original task",
        receiver_thread_ids: ["agent-1"],
      },
      {
        id: "send-1",
        type: "collab_tool_call",
        tool: "send_message",
        prompt: "Follow-up detail",
        receiver_thread_ids: ["agent-1"],
      },
    ]);

    expect(part?.subagentPrompt).toBe("Original task");
  });

  test("marks a failed spawn without a receiver as failed", () => {
    const [part] = applyCodexCollabStateToSubagentParts(
      [makeAgent(undefined, { subagentPrompt: "Transcript task" })],
      [{
        id: "spawn-failed",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Runtime task",
        status: "failed",
      }],
    );

    expect(part?.toolState).toBe("failure");
    expect(part?.subagentPrompt).toBe("Transcript task");
  });

  test("matches known agents and appends an unmatched earlier-turn agent", () => {
    const parts = applyCodexCollabStateToSubagentParts(
      [makeAgent(undefined), makeAgent("agent-2")],
      [
        {
          id: "spawn-1",
          type: "collab_tool_call",
          tool: "spawn_agent",
          prompt: "First task",
          receiver_thread_ids: ["agent-1"],
        },
        {
          id: "spawn-2",
          type: "collab_tool_call",
          tool: "spawn_agent",
          prompt: "Second task",
          receiver_thread_ids: ["agent-2"],
        },
        {
          id: "wait-old",
          type: "collab_tool_call",
          tool: "wait",
          receiver_thread_ids: ["agent-old"],
          agents_states: {
            "agent-old": { status: "completed", message: "Old work complete" },
          },
        },
      ],
    );

    expect(parts.map((part) => part.subagentId)).toEqual([
      "agent-1",
      "agent-2",
      "agent-old",
    ]);
    expect(parts[0]?.subagentPrompt).toBe("First task");
    expect(parts[1]?.subagentPrompt).toBe("Second task");
    expect(parts[2]).toMatchObject({
      toolState: "success",
      subagentActions: [{ type: "text", content: "Old work complete" }],
    });
  });

  test("applies only the latest state and does not duplicate final messages", () => {
    const source = makeAgent("thread-agent-1", {
      subagentActions: [{ type: "text", content: "Review complete" }],
    });
    const parts = applyCodexCollabStateToSubagentParts(
      [source],
      [
        {
          id: "wait-1",
          type: "collab_tool_call",
          tool: "wait",
          receiver_thread_ids: ["thread-agent-1"],
          agents_states: {
            "thread-agent-1": { status: "running", message: "Still working" },
          },
        },
        {
          id: "wait-2",
          type: "collab_tool_call",
          tool: "wait",
          receiver_thread_ids: ["thread-agent-1"],
          agents_states: {
            "thread-agent-1": { status: "completed", message: "Review complete" },
          },
        },
      ],
    );

    expect(parts[0]?.toolState).toBe("success");
    expect(parts[0]?.subagentActions).toEqual([
      { type: "text", content: "Review complete" },
    ]);
    expect(parts[0]).not.toBe(source);
    expect(source.toolState).toBe("pending");
  });
});

describe("Codex subagent timeline reconciliation", () => {
  test("moves an agent only when its visible snapshot changes", () => {
    const timeline = ["item:spawn"];
    const currentParts = new Map<string, TranscriptSubagentPart>();
    const fingerprints = new Map<string, string>();
    const initial = makeAgent("thread-agent-1");
    const key = "subagent:id:thread-agent-1";

    reconcileCodexSubagentTimeline([initial], timeline, currentParts, fingerprints);
    expect(timeline).toEqual(["item:spawn", key]);

    timeline.push("item:parent-update");
    reconcileCodexSubagentTimeline([initial], timeline, currentParts, fingerprints);
    expect(timeline).toEqual(["item:spawn", key, "item:parent-update"]);

    const updated = makeAgent("thread-agent-1", {
      subagentActions: [{ type: "text", content: "Review complete" }],
      toolState: "success",
    });
    reconcileCodexSubagentTimeline([updated], timeline, currentParts, fingerprints);
    expect(timeline).toEqual(["item:spawn", "item:parent-update", key]);
  });

  test("keeps identities stable across reordering and removes missing agents", () => {
    const timeline = ["item:delegating"];
    const currentParts = new Map<string, TranscriptSubagentPart>();
    const fingerprints = new Map<string, string>();
    const agent1 = makeAgent("agent-1");
    const agent2 = makeAgent("agent-2");
    const key1 = "subagent:id:agent-1";
    const key2 = "subagent:id:agent-2";

    reconcileCodexSubagentTimeline([agent1, agent2], timeline, currentParts, fingerprints);
    expect(timeline).toEqual(["item:delegating", key1, key2]);

    timeline.push("item:parent-update");
    reconcileCodexSubagentTimeline([agent2, agent1], timeline, currentParts, fingerprints);
    expect(timeline).toEqual(["item:delegating", key1, key2, "item:parent-update"]);
    expect(currentParts.get(key1)?.subagentId).toBe("agent-1");
    expect(currentParts.get(key2)?.subagentId).toBe("agent-2");

    reconcileCodexSubagentTimeline([agent2], timeline, currentParts, fingerprints);
    expect(timeline).toEqual(["item:delegating", key2, "item:parent-update"]);
    expect(currentParts.has(key1)).toBe(false);
    expect(fingerprints.has(key1)).toBe(false);
  });

  test("keeps duplicate anonymous rows distinct", () => {
    const timeline: string[] = [];
    const currentParts = new Map<string, TranscriptSubagentPart>();
    const fingerprints = new Map<string, string>();
    reconcileCodexSubagentTimeline(
      [makeAgent(undefined), makeAgent(undefined)],
      timeline,
      currentParts,
      fingerprints,
    );
    expect(timeline).toEqual(["subagent:anonymous:0", "subagent:anonymous:1"]);
  });

  test("handles unicode and delimiter characters in agent identities", () => {
    const timeline: string[] = [];
    const currentParts = new Map<string, TranscriptSubagentPart>();
    const fingerprints = new Map<string, string>();
    const id = "agent:💡\uD800";

    expect(() => reconcileCodexSubagentTimeline(
      [makeAgent(id)],
      timeline,
      currentParts,
      fingerprints,
    )).not.toThrow();
    expect(timeline).toHaveLength(1);
    expect(currentParts.get(timeline[0]!)?.subagentId).toBe(id);
  });
});
