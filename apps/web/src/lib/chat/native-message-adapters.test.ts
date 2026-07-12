import { describe, expect, test } from "bun:test";
import type { ClaudeMessage } from "@/lib/claude-client";
import type { NativeMessage } from "./native-message-types";
import {
  normalizeClaudeMessage,
  normalizeCodexNativeMessage,
  normalizeOpenCodeNativeMessage,
} from "./native-message-adapters";

describe("native message adapters", () => {
  test("groups consecutive native tool activity into a tool group", () => {
    const message: NativeMessage = {
      id: "native-1",
      role: "assistant",
      content: "Done",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [
        { type: "text", content: "Before" },
        { type: "tool-invocation", content: "Read", toolName: "Read" },
        { type: "tool-invocation", content: "Grep", toolName: "Grep" },
        { type: "text", content: "After" },
      ],
    };

    const normalized = normalizeOpenCodeNativeMessage(message);

    expect(normalized.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-group",
      "text",
    ]);
    expect(normalized.parts[1]?.type).toBe("tool-group");
    if (normalized.parts[1]?.type === "tool-group") {
      expect(normalized.parts[1].parts.map((part) => part.toolName)).toEqual([
        "Read",
        "Grep",
      ]);
    }
  });

  test("groups thinking with adjacent tool activity", () => {
    const message: NativeMessage = {
      id: "native-thinking-tools",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [
        { type: "thinking", content: "Looking around" },
        { type: "tool-invocation", content: "Bash", toolName: "Bash" },
        { type: "text", content: "Done" },
      ],
    };

    const normalized = normalizeOpenCodeNativeMessage(message);

    expect(normalized.parts.map((part) => part.type)).toEqual([
      "tool-group",
      "text",
    ]);
    expect(normalized.parts[0]?.type).toBe("tool-group");
    if (normalized.parts[0]?.type === "tool-group") {
      expect(normalized.parts[0].parts.map((part) => part.type)).toEqual([
        "thinking",
        "tool-invocation",
      ]);
    }
  });

  test("collapses adjacent streamed text and thinking prefixes", () => {
    const message: NativeMessage = {
      id: "native-stream-prefixes",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [
        { type: "thinking", content: "I" },
        { type: "thinking", content: "I should inspect the project" },
        { type: "text", content: "I'll take a look" },
        { type: "text", content: "I'll take a look" },
        { type: "text", content: "I'll take a look at the files." },
      ],
    };

    const normalized = normalizeOpenCodeNativeMessage(message);

    expect(normalized.parts.map((part) => part.type)).toEqual([
      "tool-group",
      "text",
    ]);
    expect(normalized.parts[0]?.type).toBe("tool-group");
    if (normalized.parts[0]?.type === "tool-group") {
      expect(normalized.parts[0].parts).toEqual([
        { type: "thinking", content: "I should inspect the project" },
      ]);
    }
    expect(normalized.parts[1]).toEqual({
      type: "text",
      content: "I'll take a look at the files.",
    });
  });

  test("normalizes Claude timestamps, attachments, and user text", () => {
    const message: ClaudeMessage = {
      id: "claude-user",
      role: "user",
      content: `Inspect this\n<attached-files>\n<attachment type="image" path="/workspace/screen.png" filename="screen.png" />\n</attached-files>`,
      timestamp: "2026-06-18T12:01:00.000Z",
      parts: [{ type: "text", content: "ignored raw xml" }],
    };

    const normalized = normalizeClaudeMessage(message);

    expect(normalized.createdAt).toBe(message.timestamp);
    expect(normalized.content).toBe("Inspect this");
    expect(normalized.parts).toEqual([
      { type: "text", content: "Inspect this" },
      {
        type: "file",
        content: "/workspace/screen.png",
        fileUrl: "/workspace/screen.png",
      },
    ]);
  });

  test("normalizes Claude Task tools into native task groups", () => {
    const message: ClaudeMessage = {
      id: "claude-assistant",
      role: "assistant",
      content: "",
      timestamp: "2026-06-18T12:02:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "Task",
          content: "Run subagent",
          toolUseId: "task-1",
        },
        {
          type: "tool-invocation",
          toolName: "Read",
          content: "Read",
          parentTaskUseId: "task-1",
        },
      ],
    };

    const normalized = normalizeClaudeMessage(message);

    expect(normalized.parts).toHaveLength(1);
    expect(normalized.parts[0]?.type).toBe("task-group");
    if (normalized.parts[0]?.type === "task-group") {
      expect(normalized.parts[0].task.toolName).toBe("Task");
      expect(normalized.parts[0].childTools.map((part) => part.toolName)).toEqual(["Read"]);
    }
  });

  test("normalizes Claude Agent tools into native task groups", () => {
    const message: ClaudeMessage = {
      id: "claude-agent-assistant",
      role: "assistant",
      content: "",
      timestamp: "2026-06-18T12:02:30.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "Agent",
          content: "Run presentation reviewer",
          toolUseId: "agent-1",
          toolArgs: {
            description: "Review presentation polish",
            prompt: "Inspect the SwiftUI views.",
            subagent_type: "explorer",
          },
        },
        {
          type: "tool-invocation",
          toolName: "Read",
          content: "Read",
          parentTaskUseId: "agent-1",
        },
      ],
    };

    const normalized = normalizeClaudeMessage(message);

    expect(normalized.parts).toHaveLength(1);
    expect(normalized.parts[0]?.type).toBe("task-group");
    if (normalized.parts[0]?.type === "task-group") {
      expect(normalized.parts[0].task.toolName).toBe("Agent");
      expect(normalized.parts[0].task.toolArgs?.description).toBe("Review presentation polish");
      expect(normalized.parts[0].childTools.map((part) => part.toolName)).toEqual(["Read"]);
    }
  });

  test("carries external tmux usage counts onto the normalized task part", () => {
    const message: ClaudeMessage = {
      id: "claude-agent-usage",
      role: "assistant",
      content: "",
      timestamp: "2026-06-18T12:02:30.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "Agent",
          content: "Run reviewer",
          toolUseId: "agent-usage",
          toolUseCount: 8,
          tokenCount: 20_400,
          tokenCountText: "20.4k tokens",
          agentUsageDisplay: "token-only",
        },
      ],
    };

    const normalized = normalizeClaudeMessage(message);

    expect(normalized.parts[0]?.type).toBe("task-group");
    if (normalized.parts[0]?.type === "task-group") {
      expect(normalized.parts[0].task.toolUseCount).toBe(8);
      expect(normalized.parts[0].task.tokenCount).toBe(20_400);
      expect(normalized.parts[0].task.tokenCountText).toBe("20.4k tokens");
      expect(normalized.parts[0].task.agentUsageDisplay).toBe("token-only");
    }
  });

  test("matches the agent task tool case-insensitively", () => {
    const message: ClaudeMessage = {
      id: "claude-agent-upper",
      role: "assistant",
      content: "",
      timestamp: "2026-06-18T12:02:30.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "AGENT",
          content: "Run reviewer",
          toolUseId: "agent-2",
        },
        {
          type: "tool-invocation",
          toolName: "Read",
          content: "Read",
          parentTaskUseId: "agent-2",
        },
      ],
    };

    const normalized = normalizeClaudeMessage(message);

    expect(normalized.parts[0]?.type).toBe("task-group");
    if (normalized.parts[0]?.type === "task-group") {
      expect(normalized.parts[0].task.toolName).toBe("AGENT");
      expect(normalized.parts[0].childTools.map((part) => part.toolName)).toEqual(["Read"]);
    }
  });

  test("does not treat tool names that merely contain 'agent' as task tools", () => {
    const message: ClaudeMessage = {
      id: "claude-agentic",
      role: "assistant",
      content: "",
      timestamp: "2026-06-18T12:02:30.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "agentic",
          content: "Agentic tool",
          toolUseId: "agentic-1",
        },
        {
          type: "tool-invocation",
          toolName: "Read",
          content: "Read",
          parentTaskUseId: "agentic-1",
        },
      ],
    };

    const normalized = normalizeClaudeMessage(message);

    // No task-group should be created; the parts stay as plain grouped tools.
    const taskGroupTypes = normalized.parts.flatMap((part) =>
      part.type === "tool-group"
        ? part.parts.map((child) => child.type)
        : [part.type],
    );
    expect(taskGroupTypes).not.toContain("task-group");
  });

  test("keeps agent parts in their own block outside grouped tool activity", () => {
    const message: NativeMessage = {
      id: "codex-1",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:03:00.000Z",
      parts: [
        { type: "subagent", content: "worker", subagentName: "worker" },
        { type: "tool-invocation", content: "Read", toolName: "Read" },
      ],
    };

    const normalized = normalizeCodexNativeMessage(message);

    expect(normalized.parts.map((part) => part.type)).toEqual([
      "subagent",
      "tool-group",
    ]);
    expect(normalized.parts[0]?.type).toBe("subagent");
    expect(normalized.parts[1]?.type).toBe("tool-group");
    if (normalized.parts[1]?.type === "tool-group") {
      expect(normalized.parts[1].parts.map((part) => part.toolName)).toEqual(["Read"]);
    }
  });
});
