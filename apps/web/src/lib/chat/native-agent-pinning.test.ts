import { describe, expect, test } from "bun:test";
import type { NativeMessage } from "./native-message-types";
import { normalizeOpenCodeNativeMessage } from "./native-message-adapters";
import {
  pinActiveNativeAgentParts,
  separateActiveNativeAgentParts,
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

describe("pinActiveNativeAgentParts", () => {
  test.each([
    ["active", true],
    ["finished", false],
  ] as const)(
    "keeps an unparented sibling tool visible when the ACP Task is %s",
    (agentState, shouldPinTask) => {
      const normalized = normalizeOpenCodeNativeMessage(assistantMessage(
        `assistant-${agentState}`,
        [
          {
            type: "tool-invocation",
            content: "Task: Validate the change",
            toolName: "task",
            toolUseId: "cursor-task-1",
            toolState: "success",
            agentState,
          },
          {
            type: "tool-invocation",
            content: "Parent edit",
            toolName: "Edit",
            toolUseId: "parent-edit-1",
            toolState: "success",
          },
        ],
      ));

      const separated = separateActiveNativeAgentParts([normalized]);

      expect(separated.activeAgents).toHaveLength(shouldPinTask ? 1 : 0);
      expect(separated.messages).toHaveLength(1);
      const visibleToolIds = separated.messages[0]!.parts.flatMap((part) =>
        part.type === "tool-group"
          ? part.parts.map((child) => child.toolUseId)
          : part.type === "task-group"
            ? [part.task.toolUseId]
            : [],
      );
      expect(visibleToolIds).toContain("parent-edit-1");
      expect(visibleToolIds.includes("cursor-task-1")).toBe(!shouldPinTask);
    },
  );

  test("separates active agents for a composer rail and retains surrounding transcript", () => {
    const activeTask = {
      type: "task-group" as const,
      content: "Task: Validate the change",
      task: {
        type: "tool-invocation" as const,
        content: "Task: Validate the change",
        toolUseId: "cursor-task-1",
        toolState: "success" as const,
        agentState: "active" as const,
      },
      childTools: [],
    };
    const separated = separateActiveNativeAgentParts([
      assistantMessage("assistant-1", [
        { type: "text", content: "Parent response" },
        activeTask,
      ]),
      assistantMessage("assistant-2", [{ type: "text", content: "Later" }]),
    ]);

    expect(separated.messages.map((message) => message.id)).toEqual([
      "assistant-1",
      "assistant-2",
    ]);
    expect(separated.messages[0]?.parts).toEqual([{ type: "text", content: "Parent response" }]);
    expect(separated.activeAgents).toEqual([activeTask]);
  });

  test("drops an otherwise empty source row when its active agent moves to the rail", () => {
    const separated = separateActiveNativeAgentParts([
      assistantMessage("assistant-1", [{
        type: "subagent",
        content: "Researcher",
        agentState: "active",
      }]),
    ]);

    expect(separated.messages).toEqual([]);
    expect(separated.activeAgents).toHaveLength(1);
  });

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

    const pinned = pinActiveNativeAgentParts(messages);

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

    const pinned = pinActiveNativeAgentParts(messages);

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

    const pinned = pinActiveNativeAgentParts(messages);

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

    const pinned = pinActiveNativeAgentParts(messages);

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

    expect(pinActiveNativeAgentParts(messages).map((message) => message.id)).toEqual([
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

    expect(pinActiveNativeAgentParts(messages).map((message) => message.id)).toEqual([
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

    const pinned = pinActiveNativeAgentParts(messages);

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

    const pinned = pinActiveNativeAgentParts(messages);

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

    const pinned = pinActiveNativeAgentParts(messages);

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
    const pinned = pinActiveNativeAgentParts([normalized]);

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

    const pinned = pinActiveNativeAgentParts([normalized]);

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

    const pinned = pinActiveNativeAgentParts(messages);

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

    const grouped = pinActiveNativeAgentParts([activeMessage]);
    expect(grouped.map((message) => message.id)).toEqual([
      "assistant-1:active-agents",
    ]);

    const partiallyComplete = pinActiveNativeAgentParts([
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

    const complete = pinActiveNativeAgentParts([
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

    const pinned = pinActiveNativeAgentParts(messages);

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
});
