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
    expect(normalized.parts[0]?.type).toBe("tool-group");
    if (normalized.parts[0]?.type === "tool-group") {
      expect(normalized.parts[0].parts[0]?.type).toBe("task-group");
      const taskGroup = normalized.parts[0].parts[0];
      if (taskGroup?.type === "task-group") {
        expect(taskGroup.task.toolName).toBe("Task");
        expect(taskGroup.childTools.map((part) => part.toolName)).toEqual(["Read"]);
      }
    }
  });

  test("Codex adapter uses the same grouped native shape", () => {
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

    expect(normalized.parts).toHaveLength(1);
    expect(normalized.parts[0]?.type).toBe("tool-group");
  });
});
