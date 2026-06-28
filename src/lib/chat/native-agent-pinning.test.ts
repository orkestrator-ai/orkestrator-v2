import { describe, expect, test } from "bun:test";
import type { NativeMessage } from "./native-message-types";
import { pinActiveNativeAgentParts } from "./native-agent-pinning";

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
      "assistant-1:active-agent:agent-1",
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
      "assistant-1:active-agent:task-1",
    ]);
    expect(pinned[0]?.parts[0]?.type).toBe("tool-group");
    if (pinned[0]?.parts[0]?.type === "tool-group") {
      expect(pinned[0].parts[0].parts.map((part) => part.type)).toEqual([
        "tool-invocation",
      ]);
    }
    expect(pinned[1]?.parts[0]?.type).toBe("task-group");
  });

  test("omits an empty source message when only active agents remain", () => {
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
    expect(pinned[0]?.id).toBe("assistant-1:active-agent:agent-1");
    expect(pinned[0]?.parts[0]?.type).toBe("subagent");
  });
});
