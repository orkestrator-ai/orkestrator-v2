import { describe, expect, test } from "bun:test";
import type { NativeSubagentPart, NativeTaskGroupPart } from "./native-message-types";
import { getNativeAgentStatus, isNativeAgentActive } from "./native-agent-status";

function subagent(overrides: Partial<NativeSubagentPart> = {}): NativeSubagentPart {
  return {
    type: "subagent",
    content: "worker",
    subagentId: "agent-1",
    ...overrides,
  };
}

function taskGroup(overrides: Partial<NativeTaskGroupPart> = {}): NativeTaskGroupPart {
  return {
    type: "task-group",
    content: "worker",
    task: {
      type: "tool-invocation",
      content: "worker",
      toolName: "Agent",
      toolUseId: "task-1",
      toolState: "pending",
    },
    childTools: [],
    ...overrides,
  };
}

describe("getNativeAgentStatus", () => {
  test("uses explicit lifecycle before the launch tool result", () => {
    expect(
      getNativeAgentStatus(
        subagent({
          agentState: "active",
          toolState: "success",
        }),
      ),
    ).toBe("active");
    expect(
      getNativeAgentStatus(
        subagent({
          agentState: "finished",
          toolState: "pending",
        }),
      ),
    ).toBe("finished");
    expect(
      getNativeAgentStatus(
        subagent({
          agentState: "failed",
          toolState: "success",
        }),
      ),
    ).toBe("failed");
  });

  test("treats terminal parent results as authoritative over stale descendants", () => {
    const staleAction = {
      type: "tool-invocation" as const,
      content: "stale child",
      toolName: "Read",
      toolState: "pending" as const,
    };

    expect(
      getNativeAgentStatus(
        subagent({
          toolState: "success",
          subagentActions: [staleAction],
        }),
      ),
    ).toBe("finished");
    expect(
      getNativeAgentStatus(
        taskGroup({
          task: {
            type: "tool-invocation",
            content: "worker",
            toolName: "Agent",
            toolUseId: "task-1",
            toolState: "failure",
          },
          childTools: [staleAction],
        }),
      ),
    ).toBe("failed");
  });

  test("finds active descendants through nested agent and tool groups", () => {
    const nested = taskGroup({
      task: {
        type: "tool-invocation",
        content: "parent",
        toolName: "Agent",
        toolUseId: "task-parent",
        toolState: "pending",
      },
      childTools: [
        {
          type: "tool-group",
          content: "",
          parts: [
            {
              type: "agent-group",
              content: "",
              parts: [
                subagent({ subagentId: "finished", toolState: "success" }),
                subagent({
                  subagentId: "active",
                  toolState: "pending",
                  subagentActions: [
                    {
                      type: "tool-group",
                      content: "",
                      parts: [
                        {
                          type: "tool-invocation",
                          content: "running",
                          toolName: "Bash",
                          toolState: "pending",
                        },
                      ],
                    },
                  ],
                }),
              ],
            },
          ],
        },
      ],
    });

    expect(getNativeAgentStatus(nested)).toBe("active");
    expect(isNativeAgentActive(nested)).toBe(true);
  });

  test("defaults non-terminal agents to active without descendants", () => {
    expect(getNativeAgentStatus(subagent())).toBe("active");
    expect(getNativeAgentStatus(subagent({ toolState: "pending" }))).toBe("active");
    expect(isNativeAgentActive(subagent({ toolState: "success" }))).toBe(false);
  });
});
