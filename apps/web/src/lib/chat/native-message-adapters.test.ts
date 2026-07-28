import { describe, expect, test } from "bun:test";
import type { ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-client";
import type { NativeMessage } from "./native-message-types";
import {
  dedupeStreamedNativeParts,
  dropEmptyThinkingParts,
  getClaudeSourceMessageId,
  groupNativeAgentActivity,
  groupNativeToolActivity,
  normalizeClaudeMessage,
  normalizeClaudeMessages,
  normalizeClaudeMessagesForDisplay,
  normalizeClaudePart,
  normalizeCodexNativeMessage,
  normalizeOpenCodeNativeMessage,
  parseNativeAttachmentsFromContent,
  splitClaudeAssistantTextBlocks,
} from "./native-message-adapters";

describe("native message adapters", () => {
  test("preserves model attribution through provider-neutral normalization", () => {
    const message: NativeMessage = {
      id: "native-model",
      role: "assistant",
      content: "Done",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [{ type: "text", content: "Done" }],
      modelId: "provider/model",
    };

    expect(normalizeCodexNativeMessage(message).modelId).toBe("provider/model");
    expect(normalizeOpenCodeNativeMessage(message).modelId).toBe("provider/model");
  });

  test("propagates Claude model attribution to every timestamp-split row", () => {
    const normalized = normalizeClaudeMessage({
      id: "claude-model",
      role: "assistant",
      content: "FirstSecond",
      timestamp: "2026-06-18T12:00:00.000Z",
      modelId: "claude-opus-5",
      parts: [
        {
          type: "text",
          content: "First",
          timestamp: "2026-06-18T12:00:00.000Z",
        },
        {
          type: "thinking",
          content: "Inspecting",
          timestamp: "2026-06-18T12:01:00.000Z",
        },
        {
          type: "text",
          content: "Second",
          timestamp: "2026-06-18T12:03:00.000Z",
        },
      ],
    });

    expect(normalized.modelId).toBe("claude-opus-5");
    expect(splitClaudeAssistantTextBlocks(normalized).map((row) => row.modelId))
      .toEqual(["claude-opus-5", "claude-opus-5"]);
  });

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

  test("drops thinking parts that carry no text", () => {
    expect(
      dropEmptyThinkingParts([
        { type: "thinking", content: "" },
        { type: "thinking", content: "   \n\t " },
        { type: "thinking", content: "Real reasoning" },
        { type: "text", content: "" },
      ]),
    ).toEqual([
      { type: "thinking", content: "Real reasoning" },
      { type: "text", content: "" },
    ]);
  });

  test("does not build an activity group for empty reasoning alone", () => {
    const message: NativeMessage = {
      id: "native-empty-thinking",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [
        { type: "thinking", content: "" },
        { type: "text", content: "Done" },
      ],
    };

    expect(
      normalizeOpenCodeNativeMessage(message).parts.map((part) => part.type),
    ).toEqual(["text"]);
  });

  test("drops empty Claude reasoning parts during normalization", () => {
    const message: ClaudeMessage = {
      id: "claude-empty-thinking",
      role: "assistant",
      content: "",
      timestamp: "2026-06-18T12:00:00.000Z",
      parts: [
        { type: "thinking", content: "  " },
        { type: "text", content: "Done" },
      ],
    } as ClaudeMessage;

    expect(
      normalizeClaudeMessage(message).parts.map((part) => part.type),
    ).toEqual(["text"]);
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

  test("copies Claude text and thinking timestamps onto native parts", () => {
    const textTimestamp = "2026-06-18T12:01:00.000Z";
    const thinkingTimestamp = "2026-06-18T12:02:00.000Z";

    expect(
      normalizeClaudePart({
        type: "text",
        content: "Answer",
        timestamp: textTimestamp,
      }),
    ).toMatchObject({
      type: "text",
      content: "Answer",
      createdAt: textTimestamp,
    });
    expect(
      normalizeClaudePart({
        type: "thinking",
        content: "Reasoning",
        timestamp: thinkingTimestamp,
      }),
    ).toMatchObject({
      type: "thinking",
      content: "Reasoning",
      createdAt: thinkingTimestamp,
    });
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

  test("keeps subagent thinking, text, and edits inside the Agent group", () => {
    const message: ClaudeMessage = {
      id: "claude-agent-activity",
      role: "assistant",
      content: "Subagent answer",
      timestamp: "2026-07-28T08:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "Agent",
          content: "Run reviewer",
          toolUseId: "agent-activity-1",
        },
        {
          type: "thinking",
          content: "Inspecting files",
          parentTaskUseId: "agent-activity-1",
        },
        {
          type: "text",
          content: "Subagent answer",
          parentTaskUseId: "agent-activity-1",
        },
        {
          type: "tool-invocation",
          toolName: "Edit",
          content: "Edit",
          toolUseId: "edit-1",
          parentTaskUseId: "agent-activity-1",
        },
      ],
    };

    const normalized = normalizeClaudeMessage(message);

    expect(normalized.parts).toHaveLength(1);
    expect(normalized.parts[0]?.type).toBe("task-group");
    if (normalized.parts[0]?.type === "task-group") {
      expect(
        normalized.parts[0].childTools.map((part) => ({
          type: part.type,
          content: part.content,
          parentTaskUseId: part.parentTaskUseId,
        })),
      ).toEqual([
        {
          type: "thinking",
          content: "Inspecting files",
          parentTaskUseId: "agent-activity-1",
        },
        {
          type: "text",
          content: "Subagent answer",
          parentTaskUseId: "agent-activity-1",
        },
        {
          type: "tool-invocation",
          content: "Edit",
          parentTaskUseId: "agent-activity-1",
        },
      ]);
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

  test("carries the backend task snapshot through normalization untouched", () => {
    // The whole task-list feature is invisible if this one field is dropped in
    // translation, and nothing else in the pipeline would fail.
    const part: ClaudeMessagePart = {
      type: "tool-invocation",
      toolName: "TaskUpdate",
      toolState: "success",
      toolArgs: { taskId: "2", status: "in_progress" },
      toolOutput: "Updated task #2 status",
      taskSnapshot: {
        items: [
          { id: "1", subject: "First", status: "completed" },
          { id: "2", subject: "Second", status: "in_progress" },
        ],
        complete: false,
        changedTaskId: "2",
        truncated: 4,
      },
    };

    const normalized = normalizeClaudePart(part);

    expect(normalized?.taskSnapshot).toEqual(part.taskSnapshot!);
  });

  test("leaves the task snapshot absent when the backend supplied none", () => {
    const normalized = normalizeClaudePart({
      type: "tool-invocation",
      toolName: "TaskCreate",
      toolState: "success",
      toolArgs: { subject: "No snapshot" },
    });

    expect(normalized?.taskSnapshot).toBeUndefined();
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

  test("keeps tool-bounded Claude text blocks in one row within two minutes", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "assistant-fast",
        role: "assistant",
        content: "FirstSecondThird",
        timestamp: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            timestamp: "2026-06-18T12:00:00.000Z",
          },
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
          },
          {
            type: "text",
            content: "Second",
            timestamp: "2026-06-18T12:01:00.000Z",
          },
          {
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
          },
          {
            type: "text",
            content: "Third",
            timestamp: "2026-06-18T12:02:00.000Z",
          },
        ],
      },
    ];

    const displayMessages = normalizeClaudeMessagesForDisplay(messages);

    expect(displayMessages).toHaveLength(1);
    expect(displayMessages[0]?.id).toBe("assistant-fast");
    expect(displayMessages[0]?.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-group",
      "text",
      "tool-group",
      "text",
    ]);
  });

  test("splits delayed tool-bounded Claude text into timestamped copy rows", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "assistant-slow",
        role: "assistant",
        content: "FirstSecondThird",
        timestamp: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            timestamp: "2026-06-18T12:00:00.000Z",
          },
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
          },
          {
            type: "text",
            content: "Second",
            timestamp: "2026-06-18T12:01:30.000Z",
          },
          {
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
          },
          {
            type: "text",
            content: "Third",
            timestamp: "2026-06-18T12:02:01.000Z",
          },
        ],
      },
    ];

    const displayMessages = normalizeClaudeMessagesForDisplay(messages);

    expect(displayMessages).toHaveLength(2);
    expect(displayMessages.map((message) => ({
      id: message.id,
      content: message.content,
      createdAt: message.createdAt,
      partTypes: message.parts.map((part) => part.type),
    }))).toEqual([
      {
        id: "assistant-slow",
        content: "FirstSecond",
        createdAt: "2026-06-18T12:00:00.000Z",
        partTypes: ["text", "tool-group", "text", "tool-group"],
      },
      {
        id: "assistant-slow:text-block:4",
        content: "Third",
        createdAt: "2026-06-18T12:02:01.000Z",
        partTypes: ["text"],
      },
    ]);
  });

  test("preserves the first row timestamp when a delayed block causes a split", () => {
    const messageTimestamp = "2026-06-18T12:00:00.000Z";
    const firstTextTimestamp = "2026-06-18T12:03:00.000Z";
    const delayedTextTimestamp = "2026-06-18T12:05:01.000Z";
    const baseMessage: ClaudeMessage = {
      id: "assistant-stable-timestamp",
      role: "assistant",
      content: "First",
      timestamp: messageTimestamp,
      parts: [
        {
          type: "text",
          content: "First",
          timestamp: firstTextTimestamp,
        },
      ],
    };

    const beforeSplit = normalizeClaudeMessagesForDisplay([baseMessage]);
    const afterSplit = normalizeClaudeMessagesForDisplay([
      {
        ...baseMessage,
        content: "FirstSecond",
        parts: [
          ...baseMessage.parts,
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
          },
          {
            type: "text",
            content: "Second",
            timestamp: delayedTextTimestamp,
          },
        ],
      },
    ]);

    expect(beforeSplit[0]?.createdAt).toBe(messageTimestamp);
    expect(afterSplit).toHaveLength(2);
    expect(afterSplit[0]?.id).toBe(baseMessage.id);
    expect(afterSplit[0]?.createdAt).toBe(messageTimestamp);
    expect(afterSplit[1]?.createdAt).toBe(delayedTextTimestamp);
  });

  test("splits delayed Claude text across a reasoning boundary", () => {
    const displayMessages = normalizeClaudeMessagesForDisplay([
      {
        id: "assistant-reasoning-boundary",
        role: "assistant",
        content: "FirstSecond",
        timestamp: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            timestamp: "2026-06-18T12:00:00.000Z",
          },
          {
            type: "thinking",
            content: "I should inspect another path.",
            timestamp: "2026-06-18T12:01:00.000Z",
          },
          {
            type: "text",
            content: "Second",
            timestamp: "2026-06-18T12:02:01.000Z",
          },
        ],
      },
    ]);

    expect(displayMessages).toHaveLength(2);
    expect(displayMessages.map((message) => ({
      content: message.content,
      partTypes: message.parts.map((part) => part.type),
    }))).toEqual([
      {
        content: "First",
        partTypes: ["text", "tool-group"],
      },
      {
        content: "Second",
        partTypes: ["text"],
      },
    ]);
  });

  test.each([
    {
      name: "an absent first timestamp",
      firstTimestamp: undefined,
      secondTimestamp: "2026-06-18T12:05:00.000Z",
    },
    {
      name: "an absent delayed timestamp",
      firstTimestamp: "2026-06-18T12:00:00.000Z",
      secondTimestamp: undefined,
    },
    {
      name: "an invalid first timestamp",
      firstTimestamp: "not-a-timestamp",
      secondTimestamp: "2026-06-18T12:05:00.000Z",
    },
    {
      name: "an invalid delayed timestamp",
      firstTimestamp: "2026-06-18T12:00:00.000Z",
      secondTimestamp: "not-a-timestamp",
    },
    {
      name: "an out-of-order delayed timestamp",
      firstTimestamp: "2026-06-18T12:05:00.000Z",
      secondTimestamp: "2026-06-18T12:00:00.000Z",
    },
  ])("does not split Claude text with $name", ({
    firstTimestamp,
    secondTimestamp,
  }) => {
    const displayMessages = normalizeClaudeMessagesForDisplay([
      {
        id: "assistant-unusable-timestamp",
        role: "assistant",
        content: "FirstSecond",
        timestamp: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            timestamp: firstTimestamp,
          },
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
          },
          {
            type: "text",
            content: "Second",
            timestamp: secondTimestamp,
          },
        ],
      },
    ]);

    expect(displayMessages).toHaveLength(1);
    expect(displayMessages[0]?.content).toBe("FirstSecond");
  });

  test("creates a new row for each successive delayed text block", () => {
    const displayMessages = normalizeClaudeMessagesForDisplay([
      {
        id: "assistant-three-rows",
        role: "assistant",
        content: "FirstSecondThird",
        timestamp: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            timestamp: "2026-06-18T12:00:00.000Z",
          },
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
          },
          {
            type: "text",
            content: "Second",
            timestamp: "2026-06-18T12:02:01.000Z",
          },
          {
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
          },
          {
            type: "text",
            content: "Third",
            timestamp: "2026-06-18T12:04:02.000Z",
          },
        ],
      },
    ]);

    expect(displayMessages.map((message) => ({
      id: message.id,
      content: message.content,
      createdAt: message.createdAt,
    }))).toEqual([
      {
        id: "assistant-three-rows",
        content: "First",
        createdAt: "2026-06-18T12:00:00.000Z",
      },
      {
        id: "assistant-three-rows:text-block:2",
        content: "Second",
        createdAt: "2026-06-18T12:02:01.000Z",
      },
      {
        id: "assistant-three-rows:text-block:4",
        content: "Third",
        createdAt: "2026-06-18T12:04:02.000Z",
      },
    ]);
  });

  test("passes non-assistant messages through without cloning or splitting", () => {
    const message: NativeMessage = {
      id: "system-message",
      role: "system",
      content: "FirstSecond",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: "First",
          createdAt: "2026-06-18T12:00:00.000Z",
        },
        { type: "tool-invocation", content: "Read", toolName: "Read" },
        {
          type: "text",
          content: "Second",
          createdAt: "2026-06-18T12:05:00.000Z",
        },
      ],
    };

    const displayMessages = splitClaudeAssistantTextBlocks(message);

    expect(displayMessages).toEqual([message]);
    expect(displayMessages[0]).toBe(message);
  });

  test("does not split adjacent Claude text without a tool or reasoning boundary", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "assistant-adjacent",
        role: "assistant",
        content: "FirstSecond",
        timestamp: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            timestamp: "2026-06-18T12:00:00.000Z",
          },
          {
            type: "text",
            content: "Second",
            timestamp: "2026-06-18T12:05:00.000Z",
          },
        ],
      },
    ];

    expect(normalizeClaudeMessagesForDisplay(messages)).toHaveLength(1);
  });
});

describe("getClaudeSourceMessageId", () => {
  test("passes an unsplit id through unchanged", () => {
    expect(getClaudeSourceMessageId("msg-1")).toBe("msg-1");
    expect(getClaudeSourceMessageId("")).toBe("");
  });

  test("resolves a split display row back to its persisted message", () => {
    expect(getClaudeSourceMessageId("msg-1:text-block:7")).toBe("msg-1");
  });

  test("resolves every row a real split produces", () => {
    // The bridge only ever sees the persisted id, so each display row this
    // splitter emits has to map back onto exactly one message on disk.
    const rows = splitClaudeAssistantTextBlocks({
      id: "assistant-1",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: "First",
          createdAt: "2026-06-18T12:00:00.000Z",
        },
        {
          type: "tool-invocation",
          content: "Bash",
          createdAt: "2026-06-18T12:01:00.000Z",
        },
        {
          type: "text",
          content: "Second",
          createdAt: "2026-06-18T12:10:00.000Z",
        },
      ],
    });

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((row) => getClaudeSourceMessageId(row.id))).toEqual(
      rows.map(() => "assistant-1"),
    );
  });

  test("truncates at the first marker so a nested split cannot leak through", () => {
    expect(getClaudeSourceMessageId("msg-1:text-block:2:text-block:5")).toBe(
      "msg-1",
    );
  });
});

describe("normalization identity cache", () => {
  const makeMessage = (): NativeMessage => ({
    id: "native-1",
    role: "assistant",
    content: "Done",
    createdAt: "2026-06-18T12:00:00.000Z",
    parts: [
      { type: "text", content: "Before" },
      { type: "tool-invocation", content: "Read", toolName: "Read" },
      { type: "text", content: "After" },
    ],
  });

  test("returns the identical normalized object for an unchanged source message", () => {
    const message = makeMessage();

    const first = normalizeCodexNativeMessage(message);
    const second = normalizeCodexNativeMessage(message);
    const third = normalizeOpenCodeNativeMessage(message);

    expect(second).toBe(first);
    // Codex and OpenCode share the provider-neutral normalizer, so the cache
    // must be shared too.
    expect(third).toBe(first);
    // Normalized content is still correct.
    expect(first.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-group",
      "text",
    ]);
  });

  test("returns a new normalized object when the source message object changes", () => {
    const message = makeMessage();
    const first = normalizeCodexNativeMessage(message);

    // Stores replace the message object on every update, so a changed message
    // is a new object and must miss the cache.
    const updated: NativeMessage = {
      ...message,
      parts: [...message.parts, { type: "text", content: "More" }],
    };
    const second = normalizeCodexNativeMessage(updated);

    expect(second).not.toBe(first);
    expect(second.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-group",
      "text",
      "text",
    ]);
    expect(second.parts.at(-1)?.content).toBe("More");
  });

  test("caches Claude normalization and display splitting per source object", () => {
    const claudeMessage: ClaudeMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "Hello",
      timestamp: "2026-06-18T12:00:00.000Z",
      parts: [
        { type: "text", content: "Hello", timestamp: "2026-06-18T12:00:00.000Z" },
      ],
    };

    expect(normalizeClaudeMessage(claudeMessage)).toBe(
      normalizeClaudeMessage(claudeMessage),
    );

    const [firstRows, secondRows] = [
      normalizeClaudeMessagesForDisplay([claudeMessage]),
      normalizeClaudeMessagesForDisplay([claudeMessage]),
    ];
    expect(firstRows[0]).toBe(secondRows[0]!);
  });
});
