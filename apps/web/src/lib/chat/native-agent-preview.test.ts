import { describe, expect, test } from "bun:test";
import type {
  NativeSubagentPart,
  NativeTaskGroupPart,
} from "./native-message-types";
import {
  nativeAgentLatestActivity,
  summarizeNativeAgentAction,
} from "./native-agent-preview";

function taskGroup(
  overrides: Partial<NativeTaskGroupPart> = {},
): NativeTaskGroupPart {
  return {
    type: "task-group",
    content: "Task: Subagent task",
    task: {
      type: "tool-invocation",
      content: "Task: Subagent task",
      toolName: "task",
      toolTitle: "Task: Subagent task",
      toolState: "success",
      agentState: "active",
    },
    childTools: [],
    ...overrides,
  };
}

function subagent(
  overrides: Partial<NativeSubagentPart> = {},
): NativeSubagentPart {
  return {
    type: "subagent",
    content: "Lovelace",
    subagentName: "Lovelace",
    ...overrides,
  };
}

describe("nativeAgentLatestActivity", () => {
  test("returns undefined when no child activity has been captured", () => {
    expect(nativeAgentLatestActivity(taskGroup())).toBeUndefined();
    expect(nativeAgentLatestActivity(subagent({ subagentActions: [] }))).toBeUndefined();
  });

  test("prefers the latest child command, title, or type label", () => {
    expect(nativeAgentLatestActivity(taskGroup({
      childTools: [
        { type: "thinking", content: "planning the search" },
        {
          type: "tool-invocation",
          content: "Search Find",
          toolName: "grep",
          toolTitle: "Search Find",
          toolArgs: { pattern: "ActiveSubagentRail" },
        },
      ],
    }))).toBe("Search Find");

    expect(nativeAgentLatestActivity(subagent({
      subagentActions: [{
        type: "tool-invocation",
        content: "exec_command",
        toolName: "exec_command",
        toolArgs: { command: "rg -n codex src" },
      }],
    }))).toBe("rg -n codex src");
  });
});

describe("summarizeNativeAgentAction", () => {
  test("uses compact labels for thinking, empty text, and unnamed files", () => {
    expect(summarizeNativeAgentAction({ type: "thinking", content: "secret plan" }))
      .toBe("Thinking");
    expect(summarizeNativeAgentAction({ type: "text", content: "  \n" })).toBe("Response");
    expect(summarizeNativeAgentAction({ type: "file", content: "" })).toBe("File");
  });
});
