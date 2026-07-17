import { describe, expect, test } from "bun:test";
import type { ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-client";
import type { NativeMessage } from "./native-message-types";
import {
  dedupeStreamedNativeParts,
  groupNativeAgentActivity,
  groupNativeToolActivity,
  normalizeClaudeMessage,
  normalizeClaudeMessages,
  normalizeClaudePart,
  normalizeCodexNativeMessage,
  normalizeOpenCodeNativeMessage,
  parseNativeAttachmentsFromContent,
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

  test("collects adjacent agents into one inline agent block", () => {
    const message: NativeMessage = {
      id: "codex-agents",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:04:00.000Z",
      parts: [
        { type: "text", content: "Delegating" },
        { type: "subagent", content: "reviewer", subagentId: "agent-1" },
        { type: "subagent", content: "tester", subagentId: "agent-2" },
        { type: "subagent", content: "researcher", subagentId: "agent-3" },
        { type: "text", content: "Parent continued" },
      ],
    };

    const normalized = normalizeCodexNativeMessage(message);

    expect(normalized.parts.map((part) => part.type)).toEqual([
      "text",
      "agent-group",
      "text",
    ]);
    expect(normalized.parts[1]?.type).toBe("agent-group");
    if (normalized.parts[1]?.type === "agent-group") {
      expect(normalized.parts[1].parts.map((part) => part.subagentId)).toEqual([
        "agent-1",
        "agent-2",
        "agent-3",
      ]);
    }
  });

  test("does not group agents separated by parent activity", () => {
    const message: NativeMessage = {
      id: "codex-separated-agents",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:05:00.000Z",
      parts: [
        { type: "subagent", content: "reviewer", subagentId: "agent-1" },
        { type: "text", content: "Parent update" },
        { type: "subagent", content: "tester", subagentId: "agent-2" },
      ],
    };

    const normalized = normalizeCodexNativeMessage(message);

    expect(normalized.parts.map((part) => part.type)).toEqual([
      "subagent",
      "text",
      "subagent",
    ]);
  });

  test("parses multiple attachment blocks and ignores malformed attachment entries", () => {
    const parsed = parseNativeAttachmentsFromContent(
      [
        "Inspect these",
        '<attached-files><attachment type="image" path="/workspace/a.png" filename="a.png" />',
        '<attachment type="text" path="/workspace/readme.md" filename="readme.md" />',
        '<attachment type="image" filename="missing-path.png" /></attached-files>',
        "then compare",
        '<attached-files><attachment path="/workspace/b.jpg" filename="b.jpg" type="image" /></attached-files>',
      ].join("\n"),
    );

    expect(parsed.cleanContent).toBe("Inspect these\n\nthen compare");
    expect(parsed.attachments).toEqual([
      {
        type: "file",
        content: "/workspace/a.png",
        fileUrl: "/workspace/a.png",
      },
      {
        type: "file",
        content: "/workspace/readme.md",
        fileUrl: undefined,
      },
      {
        type: "file",
        content: "/workspace/b.jpg",
        fileUrl: "/workspace/b.jpg",
      },
    ]);
  });

  test("leaves malformed attachment blocks in message text", () => {
    const content =
      'Keep this <attached-files><attachment type="image" path="/workspace/a.png" />';

    expect(parseNativeAttachmentsFromContent(content)).toEqual({
      cleanContent: content,
      attachments: [],
    });
  });

  test("normalizes every supported Claude part and rejects unknown variants", () => {
    const supported: ClaudeMessagePart[] = [
      { type: "text", content: undefined, _messageUuid: "text-id" },
      { type: "thinking", content: "Reason", _messageUuid: "thinking-id" },
      { type: "file", content: "/workspace/a.txt" },
      {
        type: "tool-invocation",
        content: "Read",
        toolName: "Read",
        toolUseId: "tool-1",
        toolState: "pending",
      },
      {
        type: "tool-result",
        content: "contents",
        toolName: "Read",
        toolState: "success",
        toolOutput: "contents",
      },
    ];

    expect(supported.map(normalizeClaudePart)).toEqual([
      { type: "text", content: "", sourcePartId: "text-id" },
      { type: "thinking", content: "Reason", sourcePartId: "thinking-id" },
      { type: "file", content: "/workspace/a.txt" },
      expect.objectContaining({
        type: "tool-invocation",
        toolName: "Read",
        toolUseId: "tool-1",
        toolState: "pending",
      }),
      expect.objectContaining({
        type: "tool-result",
        content: "contents",
        toolOutput: "contents",
      }),
    ]);
    expect(
      normalizeClaudePart({ type: "unknown" } as unknown as ClaudeMessagePart),
    ).toBeNull();
  });

  test("deduplicates only adjacent non-empty streamed prefixes", () => {
    const deduped = dedupeStreamedNativeParts([
      { type: "text", content: "Complete response" },
      { type: "text", content: "Complete" },
      { type: "text", content: " " },
      { type: "text", content: " " },
      { type: "thinking", content: "Plan" },
      { type: "text", content: "Complete" },
    ]);

    expect(deduped).toEqual([
      { type: "text", content: "Complete response" },
      { type: "text", content: " " },
      { type: "text", content: " " },
      { type: "thinking", content: "Plan" },
      { type: "text", content: "Complete" },
    ]);
  });

  test("groups tools around agent boundaries and discards standalone results", () => {
    const grouped = groupNativeToolActivity([
      { type: "thinking", content: "Plan" },
      { type: "tool-result", content: "hidden result" },
      {
        type: "subagent",
        content: "reviewer",
        subagentId: "agent-1",
      },
      { type: "tool-invocation", content: "Read", toolName: "Read" },
    ]);

    expect(grouped.map((part) => part.type)).toEqual([
      "tool-group",
      "subagent",
      "tool-group",
    ]);
    expect(groupNativeToolActivity(grouped)).toEqual(grouped);
  });

  test("groups mixed and task-only agent runs idempotently", () => {
    const task = {
      type: "task-group" as const,
      content: "Task",
      task: {
        type: "tool-invocation" as const,
        content: "Task",
        toolUseId: "task-1",
      },
      childTools: [],
    };
    const mixed = groupNativeAgentActivity([
      task,
      { type: "subagent", content: "reviewer", subagentId: "agent-1" },
    ]);
    const taskOnly = groupNativeAgentActivity([
      task,
      {
        ...task,
        task: { ...task.task, toolUseId: "task-2" },
      },
    ]);

    expect(mixed[0]?.type).toBe("agent-group");
    expect(taskOnly[0]?.type).toBe("agent-group");
    expect(groupNativeAgentActivity(mixed)).toEqual(mixed);
    expect(groupNativeAgentActivity(taskOnly)).toEqual(taskOnly);
  });

  test("normalizes arrays of Claude messages without changing their order", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "Question",
        timestamp: "2026-06-18T12:00:00.000Z",
        parts: [],
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "Answer",
        timestamp: "2026-06-18T12:00:01.000Z",
        parts: [{ type: "text", content: "Answer" }],
      },
    ];

    expect(normalizeClaudeMessages(messages).map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });
});
