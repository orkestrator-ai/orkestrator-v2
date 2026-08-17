import { describe, expect, test } from "bun:test";
import type { NativeMessage } from "./native-message-types";
import {
  applyClaudeBackgroundTaskStates,
  normalizeNativeMessages,
  normalizeOpenCodeNativeMessage,
} from "./native-message-adapters";
import {
  pinNativeAgentParts,
  snapshotNativeAgentActivity,
} from "./native-agent-pinning";

function assistantMessage(
  id: string,
  parts: NativeMessage["parts"],
  content = "",
): NativeMessage {
  return {
    id,
    role: "assistant",
    content,
    parts,
    createdAt: "2026-06-28T12:00:00.000Z",
  };
}

describe("pinNativeAgentParts", () => {
  test.each([
    ["running", true],
    ["completed", false],
  ] as const)(
    "pins a %s background task card: %s",
    (status, expectPinned) => {
      const messages = normalizeNativeMessages(
        applyClaudeBackgroundTaskStates([
          assistantMessage("assistant-launch", [{
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
            toolUseId: "bash-1",
            toolState: "success",
            toolArgs: { command: "bun run dev", run_in_background: true },
          }]),
          assistantMessage("assistant-later", [{ type: "text", content: "Still working" }]),
        ], {
          "bg-dev": { id: "bg-dev", toolUseId: "bash-1", status },
        }),
      );

      const pinned = pinNativeAgentParts(messages);
      const last = pinned.at(-1);

      // A task the user can still stop belongs beside the composer; a finished
      // one belongs in the transcript where it happened.
      expect(last?.id.endsWith(":active-agents")).toBe(expectPinned);
    },
  );

  test("moves active subagents to the bottom as temporary message rows", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [
        { type: "text", content: "Starting work" },
        {
          type: "subagent",
          content: "worker",
          subagentId: "agent-1",
          subagentName: "worker",
          toolState: "pending",
        },
        { type: "text", content: "Continuing parent turn" },
      ]),
      assistantMessage("assistant-2", [{ type: "text", content: "Later message" }]),
    ];

    const pinned = pinNativeAgentParts(messages);

    expect(pinned.map((message) => message.id)).toEqual([
      "assistant-1",
      "assistant-2",
      "assistant-1:active-agents",
    ]);
    expect(pinned[0]?.parts.map((part) => part.type)).toEqual(["text", "text"]);
    expect(pinned[2]?.parts).toEqual([
      expect.objectContaining({
        type: "subagent",
        subagentId: "agent-1",
        toolState: "pending",
      }),
    ]);
  });

  test("leaves successful agents in their source message", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [
        { type: "text", content: "Starting work" },
        {
          type: "subagent",
          content: "worker",
          subagentId: "agent-1",
          toolState: "success",
        },
        { type: "text", content: "Done" },
      ]),
    ];

    const pinned = pinNativeAgentParts(messages);

    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.id).toBe("assistant-1");
    expect(pinned[0]?.parts.map((part) => part.type)).toEqual([
      "text",
      "subagent",
      "text",
    ]);
  });

  test("leaves successful task groups in their source message", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [
        { type: "text", content: "Starting work" },
        {
          type: "task-group",
          content: "Agent",
          task: {
            type: "tool-invocation",
            content: "Agent",
            toolName: "Agent",
            toolUseId: "task-1",
            toolState: "success",
          },
          childTools: [],
        },
        { type: "text", content: "Done" },
      ]),
    ];

    const pinned = pinNativeAgentParts(messages);

    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.id).toBe("assistant-1");
    expect(pinned[0]?.parts.map((part) => part.type)).toEqual([
      "text",
      "task-group",
      "text",
    ]);
  });

  test("leaves terminal launches in place despite stale descendant tools", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [
        {
          type: "task-group",
          content: "Agent",
          task: {
            type: "tool-invocation",
            content: "Agent",
            toolName: "Agent",
            toolUseId: "task-1",
            toolState: "success",
          },
          childTools: [
            {
              type: "tool-invocation",
              content: "Run tests",
              toolName: "Bash",
              toolState: "pending",
            },
          ],
        },
      ]),
      assistantMessage("assistant-2", [{ type: "text", content: "Later message" }]),
    ];

    const pinned = pinNativeAgentParts(messages);

    expect(pinned.map((message) => message.id)).toEqual([
      "assistant-1",
      "assistant-2",
    ]);
    expect(pinned[0]?.parts[0]?.type).toBe("task-group");
  });

  test("pins a successful background launch with authoritative active state", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [{
        type: "task-group",
        content: "Agent",
        task: {
          type: "tool-invocation",
          content: "Agent",
          toolName: "Agent",
          toolUseId: "task-background",
          toolState: "success",
          agentState: "active",
        },
        childTools: [],
      }]),
    ];

    expect(pinNativeAgentParts(messages).map((message) => message.id)).toEqual([
      "assistant-1:active-agents",
    ]);
  });

  test("releases an agent when authoritative lifecycle finishes despite stale child work", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [{
        type: "task-group",
        content: "Agent",
        task: {
          type: "tool-invocation",
          content: "Agent",
          toolName: "Agent",
          toolUseId: "task-background",
          toolState: "success",
          agentState: "finished",
        },
        childTools: [{
          type: "tool-invocation",
          content: "Stale child",
          toolName: "Read",
          toolState: "pending",
        }],
      }]),
    ];

    expect(pinNativeAgentParts(messages).map((message) => message.id)).toEqual([
      "assistant-1",
    ]);
  });

  test("leaves terminal subagents in place despite stale descendant tools", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [
        {
          type: "subagent",
          content: "worker",
          subagentId: "agent-1",
          toolState: "success",
          subagentActions: [
            {
              type: "tool-invocation",
              content: "Inspect files",
              toolName: "Read",
              toolState: "pending",
            },
          ],
        },
      ]),
    ];

    const pinned = pinNativeAgentParts(messages);

    expect(pinned.map((message) => message.id)).toEqual(["assistant-1"]);
    expect(pinned[0]?.parts[0]?.type).toBe("subagent");
  });

  test("extracts active task groups from legacy tool groups", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [
        {
          type: "tool-group",
          content: "",
          parts: [
            { type: "tool-invocation", content: "Read", toolName: "Read" },
            {
              type: "task-group",
              content: "Agent",
              task: {
                type: "tool-invocation",
                content: "Agent",
                toolName: "Agent",
                toolUseId: "task-1",
                toolState: "pending",
              },
              childTools: [],
            },
          ],
        },
      ]),
    ];

    const pinned = pinNativeAgentParts(messages);

    expect(pinned.map((message) => message.id)).toEqual([
      "assistant-1",
      "assistant-1:active-agents",
    ]);
    expect(pinned[0]?.parts[0]?.type).toBe("tool-group");
    if (pinned[0]?.parts[0]?.type === "tool-group") {
      expect(pinned[0].parts[0].parts.map((part) => part.type)).toEqual([
        "tool-invocation",
      ]);
    }
    expect(pinned[1]?.parts[0]?.type).toBe("task-group");
  });

  test("leaves failed agents in their source message as terminal activity", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [
        {
          type: "subagent",
          content: "worker",
          subagentId: "agent-1",
          toolState: "failure",
        },
      ]),
    ];

    const pinned = pinNativeAgentParts(messages);

    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.id).toBe("assistant-1");
    expect(pinned[0]?.parts[0]?.type).toBe("subagent");
  });

  test("extracts active children from normalized agent groups and retains terminal children", () => {
    const normalized = normalizeOpenCodeNativeMessage(
      assistantMessage("assistant-1", [
        {
          type: "subagent",
          content: "active",
          subagentId: "agent-active",
          toolState: "pending",
        },
        {
          type: "subagent",
          content: "complete",
          subagentId: "agent-complete",
          toolState: "success",
        },
        {
          type: "task-group",
          content: "failed task",
          task: {
            type: "tool-invocation",
            content: "failed task",
            toolUseId: "task-failed",
            toolState: "failure",
          },
          childTools: [],
        },
      ]),
    );

    expect(normalized.parts[0]?.type).toBe("agent-group");
    const pinned = pinNativeAgentParts([normalized]);

    expect(pinned.map((message) => message.id)).toEqual([
      "assistant-1",
      "assistant-1:active-agents",
    ]);
    expect(pinned[0]?.parts[0]?.type).toBe("agent-group");
    if (pinned[0]?.parts[0]?.type === "agent-group") {
      expect(pinned[0].parts[0].parts.map((part) => part.type)).toEqual([
        "subagent",
        "task-group",
      ]);
    }
  });

  test("pins adjacent active agents in one shared group", () => {
    const normalized = normalizeOpenCodeNativeMessage(
      assistantMessage("assistant-1", [
        {
          type: "subagent",
          content: "first",
          subagentId: "agent-1",
          toolState: "pending",
        },
        {
          type: "subagent",
          content: "second",
          subagentId: "agent-2",
        },
      ]),
    );

    const pinned = pinNativeAgentParts([normalized]);

    expect(pinned.map((message) => message.id)).toEqual([
      "assistant-1:active-agents",
    ]);
    expect(pinned[0]?.parts[0]?.type).toBe("agent-group");
    if (pinned[0]?.parts[0]?.type === "agent-group") {
      expect(pinned[0].parts[0].parts.map((part) => part.subagentId)).toEqual([
        "agent-1",
        "agent-2",
      ]);
    }
  });

  test("uses the same source-scoped row id for singleton agents without stable child ids", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [
        {
          type: "subagent",
          content: "worker",
          subagentName: "worker",
          toolState: "pending",
        },
      ]),
    ];

    const pinned = pinNativeAgentParts(messages);

    expect(pinned.map((message) => message.id)).toEqual([
      "assistant-1:active-agents",
    ]);
    expect(pinned[0]?.parts[0]?.type).toBe("subagent");
  });

  test("keeps the pinned row stable while grouped agents complete one at a time", () => {
    const activeMessage = assistantMessage("assistant-1", [
      {
        type: "subagent",
        content: "first",
        subagentId: "agent-1",
        toolState: "pending",
      },
      {
        type: "subagent",
        content: "second",
        subagentId: "agent-2",
        toolState: "pending",
      },
    ]);

    const grouped = pinNativeAgentParts([activeMessage]);
    expect(grouped.map((message) => message.id)).toEqual([
      "assistant-1:active-agents",
    ]);

    const partiallyComplete = pinNativeAgentParts([
      {
        ...activeMessage,
        parts: activeMessage.parts.map((part) =>
          part.type === "subagent" && part.subagentId === "agent-2"
            ? { ...part, toolState: "success" as const }
            : part
        ),
      },
    ]);
    expect(partiallyComplete.map((message) => message.id)).toEqual([
      "assistant-1",
      "assistant-1:active-agents",
    ]);
    expect(partiallyComplete[0]?.parts).toEqual([
      expect.objectContaining({
        type: "subagent",
        subagentId: "agent-2",
        toolState: "success",
      }),
    ]);
    expect(partiallyComplete[1]?.parts).toEqual([
      expect.objectContaining({
        type: "subagent",
        subagentId: "agent-1",
        toolState: "pending",
      }),
    ]);

    const complete = pinNativeAgentParts([
      {
        ...activeMessage,
        parts: activeMessage.parts.map((part) =>
          part.type === "subagent"
            ? { ...part, toolState: "success" as const }
            : part
        ),
      },
    ]);
    expect(complete.map((message) => message.id)).toEqual(["assistant-1"]);
    expect(complete[0]?.parts).toHaveLength(2);
  });

  test("groups non-adjacent and nested active agents in traversal order", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [
        {
          type: "subagent",
          content: "first",
          subagentId: "agent-1",
          toolState: "pending",
        },
        { type: "text", content: "Parent continued" },
        {
          type: "tool-group",
          content: "",
          parts: [
            {
              type: "tool-invocation",
              content: "Read",
              toolName: "Read",
              toolState: "success",
            },
            {
              type: "task-group",
              content: "second",
              task: {
                type: "tool-invocation",
                content: "second",
                toolUseId: "task-2",
                toolState: "pending",
              },
              childTools: [],
            },
          ],
        },
        {
          type: "agent-group",
          content: "",
          parts: [
            {
              type: "subagent",
              content: "complete",
              subagentId: "agent-complete",
              toolState: "success",
            },
            {
              type: "subagent",
              content: "third",
              subagentId: "agent-3",
              toolState: "pending",
            },
          ],
        },
      ]),
    ];

    const pinned = pinNativeAgentParts(messages);

    expect(pinned.map((message) => message.id)).toEqual([
      "assistant-1",
      "assistant-1:active-agents",
    ]);
    expect(pinned[0]?.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-group",
      "agent-group",
    ]);
    expect(pinned[1]?.parts[0]?.type).toBe("agent-group");
    if (pinned[1]?.parts[0]?.type === "agent-group") {
      expect(
        pinned[1].parts[0].parts.map((part) =>
          part.type === "task-group"
            ? part.task.toolUseId
            : part.subagentId
        ),
      ).toEqual(["agent-1", "task-2", "agent-3"]);
    }
  });

  /*
   * Placement is a pure function of what the backend reported: the child's
   * settle stamp against the transcript's own clocks. None of these tests feed
   * the module a prior "running" observation first, because there is nothing to
   * observe — which is the same reason a reload and a second tab agree.
   */
  const at = (
    id: string,
    createdAt: string,
    parts: NativeMessage["parts"],
    content = "",
  ): NativeMessage => ({ id, role: "assistant", content, parts, createdAt });

  const settledWorker = (settledAt?: string): NativeMessage["parts"][number] => ({
    type: "subagent",
    content: "worker",
    subagentId: "agent-1",
    toolState: "success",
    ...(settledAt ? { settledAt } : {}),
  });

  test("places a settled agent where the backend recorded it stopping", () => {
    const messages = [
      at("assistant-1", "2026-06-28T12:00:00.000Z", [
        { type: "text", content: "Delegating" },
        settledWorker("2026-06-28T12:02:30.000Z"),
      ]),
      at("assistant-2", "2026-06-28T12:01:00.000Z", [
        { type: "text", content: "Meanwhile" },
      ]),
      at("assistant-3", "2026-06-28T12:05:00.000Z", [
        { type: "text", content: "Afterwards" },
      ]),
    ];

    // It stopped after assistant-2 and before assistant-3, so that is where the
    // card sits — not back at assistant-1, which launched it.
    const pinned = pinNativeAgentParts(messages);
    expect(pinned.map((message) => message.id)).toEqual([
      "assistant-1",
      "assistant-2",
      "assistant-2:settled-agents",
      "assistant-3",
    ]);
    expect(pinned[0]?.parts.map((part) => part.type)).toEqual(["text"]);
    expect(pinned[2]?.parts[0]?.type).toBe("subagent");
  });

  test("puts the same transcript in the same order every time it is read", () => {
    // The property the backend stamp buys: no first render, no prior sighting of
    // the child running, and therefore no difference after a reload or in a
    // second tab looking at the same session.
    const messages = [
      at("assistant-1", "2026-06-28T12:00:00.000Z", [settledWorker("2026-06-28T12:02:00.000Z")]),
      at("assistant-2", "2026-06-28T12:01:00.000Z", [{ type: "text", content: "Meanwhile" }]),
    ];

    const first = pinNativeAgentParts(messages).map((message) => message.id);
    expect(pinNativeAgentParts(messages).map((message) => message.id)).toEqual(first);
    expect(first).toEqual(["assistant-2", "assistant-2:settled-agents"]);
  });

  test("pins a running agent to the bottom whatever else it carries", () => {
    const messages = [
      at("assistant-1", "2026-06-28T12:00:00.000Z", [
        { type: "text", content: "Delegating" },
        { type: "subagent", content: "worker", subagentId: "agent-1", toolState: "pending" },
      ]),
      at("assistant-2", "2026-06-28T12:01:00.000Z", [{ type: "text", content: "Meanwhile" }]),
    ];

    expect(pinNativeAgentParts(messages).map((message) => message.id)).toEqual([
      "assistant-1",
      "assistant-2",
      "assistant-1:active-agents",
    ]);
  });

  test("leaves an agent the backend never stamped in its launch row", () => {
    // A bridge that predates the field reports no position, and a guess would be
    // worse than the row the transcript already put it in.
    const messages = [
      at("assistant-1", "2026-06-28T12:00:00.000Z", [
        { type: "text", content: "Delegating" },
        settledWorker(),
      ]),
      at("assistant-2", "2026-06-28T12:01:00.000Z", [{ type: "text", content: "Meanwhile" }]),
    ];

    expect(pinNativeAgentParts(messages).map((message) => message.id))
      .toEqual(["assistant-1", "assistant-2"]);
    expect(pinNativeAgentParts(messages)[0]?.parts.map((part) => part.type))
      .toEqual(["text", "subagent"]);
  });

  test("leaves an agent that settled before the loaded transcript in place", () => {
    // The window was trimmed past the row it stopped at, so there is no position
    // to hold. Teleporting it to the top of what remains would be a lie.
    const messages = [
      at("assistant-1", "2026-06-28T12:00:00.000Z", [
        { type: "text", content: "Delegating" },
        settledWorker("2026-06-28T09:00:00.000Z"),
      ]),
    ];

    expect(pinNativeAgentParts(messages).map((message) => message.id))
      .toEqual(["assistant-1"]);
  });

  test("groups agents that settled at the same position into one row", () => {
    const messages = [
      at("assistant-1", "2026-06-28T12:00:00.000Z", [{
        type: "subagent",
        content: "first",
        subagentId: "agent-1",
        toolState: "success",
        settledAt: "2026-06-28T12:04:00.000Z",
      }]),
      at("assistant-2", "2026-06-28T12:01:00.000Z", [{
        type: "subagent",
        content: "second",
        subagentId: "agent-2",
        toolState: "success",
        settledAt: "2026-06-28T12:04:30.000Z",
      }]),
      at("assistant-3", "2026-06-28T12:02:00.000Z", [{ type: "text", content: "Meanwhile" }]),
    ];

    const pinned = pinNativeAgentParts(messages);
    expect(pinned.map((message) => message.id)).toEqual([
      "assistant-3",
      "assistant-3:settled-agents",
    ]);
    expect(pinned[1]?.parts[0]?.type).toBe("agent-group");
    if (pinned[1]?.parts[0]?.type === "agent-group") {
      expect(pinned[1].parts[0].parts.map((part) => part.subagentId)).toEqual([
        "agent-1",
        "agent-2",
      ]);
    }
  });

  test("holds a card at the bottom when its anchor row is consumed", () => {
    // The launch row held nothing but the child, so releasing it leaves the
    // message the anchor names with nothing to render.
    const messages = [
      at("assistant-1", "2026-06-28T12:00:00.000Z", [settledWorker("2026-06-28T12:00:30.000Z")]),
      at("assistant-2", "2026-06-28T12:05:00.000Z", [{ type: "text", content: "Afterwards" }]),
    ];

    expect(pinNativeAgentParts(messages).map((message) => message.id))
      .toEqual(["assistant-2", "assistant-1:settled-agents"]);
  });

  test("does not let a tab's own rowless card become a position", () => {
    /*
     * A card a tab adds for a task with no launch row carries a settle stamp of
     * its own. Treating it as a transcript position would let one such card
     * anchor to another and drag it away from the conversation it belongs
     * beside, so only real transcript rows are offered as anchors.
     */
    const transcript = [
      at("assistant-1", "2026-06-28T12:00:00.000Z", [{ type: "text", content: "Working" }]),
    ];
    const rowless = at("background-task:bg-2", "2026-06-28T12:09:00.000Z", [{
      type: "subagent",
      content: "second",
      subagentId: "agent-2",
      toolState: "success",
      settledAt: "2026-06-28T12:09:00.000Z",
    }]);
    const earlier = at("background-task:bg-1", "2026-06-28T12:08:00.000Z", [{
      type: "subagent",
      content: "first",
      subagentId: "agent-1",
      toolState: "success",
      settledAt: "2026-06-28T12:08:00.000Z",
    }]);

    const pinned = pinNativeAgentParts([...transcript, earlier, rowless], transcript);

    // Both settle after the only transcript row, so both sit under it together.
    expect(pinned.map((message) => message.id)).toEqual([
      "assistant-1",
      "assistant-1:settled-agents",
    ]);
    expect(pinned[1]?.parts[0]?.type).toBe("agent-group");
  });

  test("places a settled background task from the backend's terminal edge", () => {
    const transcript = (
      status: "running" | "completed",
      endedAt?: number,
    ) => normalizeNativeMessages(
      applyClaudeBackgroundTaskStates([
        at("assistant-launch", "2026-06-28T12:00:00.000Z", [{
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolUseId: "bash-1",
          toolState: "success",
          toolArgs: { command: "bun run dev", run_in_background: true },
        }]),
        at("assistant-later", "2026-06-28T12:01:00.000Z", [
          { type: "text", content: "Still working" },
        ]),
      ], {
        "bg-dev": { id: "bg-dev", toolUseId: "bash-1", status, ...(endedAt ? { endedAt } : {}) },
      }),
    );

    // Live: at the bottom, where its stop control cannot scroll away.
    expect(pinNativeAgentParts(transcript("running")).at(-1)?.id)
      .toBe("assistant-launch:active-agents");

    // Settled: under the row the conversation had reached when the bridge
    // recorded it ending.
    expect(
      pinNativeAgentParts(transcript("completed", Date.parse("2026-06-28T12:02:00.000Z")))
        .map((message) => message.id),
    ).toEqual(["assistant-later", "assistant-later:settled-agents"]);
  });

  test("snapshots accessible labels and keeps the newest reusable-agent lifecycle", () => {
    const messages: NativeMessage[] = [
      assistantMessage("assistant-1", [{
        type: "task-group",
        content: "Task: fallback",
        task: {
          type: "tool-invocation",
          content: "Task: fallback",
          toolUseId: "task-1",
          toolState: "success",
          agentState: "active",
          toolArgs: { description: "Validate the implementation" },
        },
        childTools: [],
      }]),
      assistantMessage("assistant-2", [{
        type: "subagent",
        content: "generic",
        subagentId: "agent-reusable",
        subagentName: "Lovelace",
        subagentRole: "correctness_review",
        toolState: "pending",
      }]),
      assistantMessage("assistant-3", [{
        type: "subagent",
        content: "generic",
        subagentId: "agent-reusable",
        subagentName: "Lovelace",
        subagentRole: "correctness_review",
        toolState: "failure",
      }]),
    ];

    expect(snapshotNativeAgentActivity(messages)).toEqual([
      {
        id: "task-group:task-1",
        label: "Validate the implementation",
        status: "active",
        kind: "subagent",
      },
      {
        id: "subagent:agent-reusable",
        label: "Lovelace",
        status: "failed",
        kind: "subagent",
      },
    ]);
  });

  test("snapshots a provider-owned task with its full lifecycle", () => {
    const messages = normalizeNativeMessages(
      applyClaudeBackgroundTaskStates([
        assistantMessage("assistant-task", [{
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolUseId: "bash-task",
          toolState: "success",
          toolArgs: {
            command: "bun test",
            description: "Run the full suite",
            run_in_background: true,
          },
        }]),
      ], {
        "bg-suite": {
          id: "bg-suite",
          toolUseId: "bash-task",
          description: "Run the full suite",
          status: "paused",
        },
      }),
    );

    expect(snapshotNativeAgentActivity(messages)).toEqual([{
      id: "background-task:bg-suite",
      label: "Run the full suite",
      status: "active",
      kind: "background-task",
      backgroundTaskStatus: "paused",
    }]);
  });
});
