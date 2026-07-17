import { describe, expect, test } from "bun:test";
import type { TranscriptSubagentPart } from "./subagent-transcript.js";
import {
  applyCodexCollabStateToSubagentParts,
  reconcileCodexSubagentTimeline,
} from "./codex-collaboration.js";

function makeAgent(
  id: string,
  overrides: Partial<TranscriptSubagentPart> = {},
): TranscriptSubagentPart {
  return {
    type: "subagent",
    content: id,
    subagentId: id,
    subagentActions: [],
    subagentActionCount: 0,
    toolState: "pending",
    ...overrides,
  };
}

describe("Codex collaboration state", () => {
  test("creates an identified running agent before its transcript is available", () => {
    const parts = applyCodexCollabStateToSubagentParts([], [
      {
        id: "spawn-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Review the bridge event handling",
        receiver_thread_ids: ["thread-agent-1"],
        agents_states: {
          "thread-agent-1": { status: "running" },
        },
        status: "completed",
      },
    ]);

    expect(parts).toEqual([
      {
        type: "subagent",
        content: "subagent",
        subagentId: "thread-agent-1",
        subagentPrompt: "Review the bridge event handling",
        subagentActions: [],
        subagentActionCount: 0,
        toolState: "pending",
      },
    ]);
  });

  test("applies the latest completion state and message to transcript activity", () => {
    const parts = applyCodexCollabStateToSubagentParts(
      [makeAgent("thread-agent-1")],
      [
        {
          id: "wait-1",
          type: "collab_tool_call",
          tool: "wait",
          receiver_thread_ids: ["thread-agent-1"],
          agents_states: {
            "thread-agent-1": {
              status: "completed",
              message: "The bridge drops collab_tool_call items.",
            },
          },
          status: "completed",
        },
      ],
    );

    expect(parts[0]?.toolState).toBe("success");
    expect(parts[0]?.subagentActions).toEqual([
      { type: "text", content: "The bridge drops collab_tool_call items." },
    ]);
  });
});

describe("Codex subagent timeline reconciliation", () => {
  test("moves an agent only when its visible snapshot changes", () => {
    const timeline = ["item:spawn"];
    const currentParts = new Map<string, TranscriptSubagentPart>();
    const fingerprints = new Map<string, string>();
    const initial = makeAgent("thread-agent-1");

    reconcileCodexSubagentTimeline(
      [initial],
      timeline,
      currentParts,
      fingerprints,
    );
    expect(timeline).toEqual(["item:spawn", "subagent:0"]);

    timeline.push("item:parent-update");
    reconcileCodexSubagentTimeline(
      [initial],
      timeline,
      currentParts,
      fingerprints,
    );
    expect(timeline).toEqual([
      "item:spawn",
      "subagent:0",
      "item:parent-update",
    ]);

    const updated = makeAgent("thread-agent-1", {
      subagentActions: [{ type: "text", content: "Review complete" }],
      toolState: "success",
    });
    reconcileCodexSubagentTimeline(
      [updated],
      timeline,
      currentParts,
      fingerprints,
    );
    expect(timeline).toEqual([
      "item:spawn",
      "item:parent-update",
      "subagent:0",
    ]);
  });

  test("places agents updated together next to each other", () => {
    const timeline = ["item:delegating"];
    const currentParts = new Map<string, TranscriptSubagentPart>();
    const fingerprints = new Map<string, string>();

    reconcileCodexSubagentTimeline(
      [makeAgent("agent-1"), makeAgent("agent-2")],
      timeline,
      currentParts,
      fingerprints,
    );

    expect(timeline).toEqual([
      "item:delegating",
      "subagent:0",
      "subagent:1",
    ]);
  });
});
