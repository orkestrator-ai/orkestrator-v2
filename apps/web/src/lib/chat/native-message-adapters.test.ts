import { describe, expect, test } from "bun:test";
import type { ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-client";
import type { NativeMessage } from "./native-message-types";
import {
  applyClaudeBackgroundTaskStates,
  dedupeStreamedNativeParts,
  dropEmptyThinkingParts,
  findPreviousNativeMessage,
  getClaudeSourceMessageId,
  groupNativeAgentActivity,
  groupNativeToolActivity,
  messageHasVisibleContent,
  normalizeClaudeMessage,
  normalizeClaudeMessages,
  normalizeClaudeMessagesForDisplay,
  normalizeClaudePart,
  normalizeCodexNativeMessage,
  normalizeNativeMessage,
  normalizeOpenCodeNativeMessage,
  parseNativeAttachmentsFromContent,
  splitClaudeAssistantTextBlocks,
} from "./native-message-adapters";

describe("native message adapters", () => {
  test("joins authoritative Claude background-agent state by tool use id", () => {
    const messages: ClaudeMessage[] = [{
      id: "assistant-background-agent",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [{
        type: "tool-invocation", content: "Agent",
        toolName: "Agent",
        toolUseId: "agent-launch",
        toolState: "success",
      }],
    }];

    const active = applyClaudeBackgroundTaskStates(messages, {
      "child-task": {
        id: "child-task",
        toolUseId: "agent-launch",
        status: "running",
      },
    });
    expect(active[0]?.parts[0]).toMatchObject({
      toolState: "success",
      agentState: "active",
    });
    expect(messages[0]?.parts[0]?.agentState).toBeUndefined();

    const finished = applyClaudeBackgroundTaskStates(messages, {
      "child-task": {
        id: "child-task",
        toolUseId: "agent-launch",
        status: "completed",
      },
    });
    expect(finished[0]?.parts[0]).toMatchObject({ agentState: "finished" });
  });

  test.each([
    ["pending", "active"],
    ["running", "active"],
    ["paused", "active"],
    ["completed", "finished"],
    ["failed", "failed"],
    ["killed", "failed"],
  ] as const)(
    "maps Claude background task status %s to agent state %s",
    (status, expectedAgentState) => {
      const messages: ClaudeMessage[] = [{
        id: `assistant-${status}`,
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [{
          type: "tool-invocation", content: "Agent",
          toolName: "Agent",
          toolUseId: "agent-launch",
          toolState: "success",
        }],
      }];

      const updated = applyClaudeBackgroundTaskStates(messages, {
        task: {
          id: "task",
          toolUseId: "agent-launch",
          status,
        },
      });

      expect(updated[0]?.parts[0]?.agentState).toBe(expectedAgentState);
    },
  );

  test("ignores background tasks and message parts without a usable correlation", () => {
    const nonToolPart: ClaudeMessagePart = {
      type: "text",
      content: "Agent",
    };
    const missingToolUseId: ClaudeMessagePart = {
      type: "tool-invocation", content: "",
      toolName: "Agent",
      toolState: "success",
    };
    const nonAgentTool: ClaudeMessagePart = {
      type: "tool-invocation", content: "",
      toolName: "Read",
      toolUseId: "read-tool",
      toolState: "success",
    };
    const messages: ClaudeMessage[] = [{
      id: "assistant-guards",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [nonToolPart, missingToolUseId, nonAgentTool],
    }];

    expect(applyClaudeBackgroundTaskStates(messages, {
      missingToolUseId: {
        id: "missingToolUseId",
        status: "running",
      },
      unmatched: {
        id: "unmatched",
        toolUseId: "different-tool",
        status: "completed",
      },
      read: {
        id: "read",
        toolUseId: "read-tool",
        status: "failed",
      },
    })).toBe(messages);
  });

  test("preserves message and part identity when the agent state is already current", () => {
    const part: ClaudeMessagePart = {
      type: "tool-invocation", content: "",
      toolName: "Task",
      toolUseId: "task-launch",
      toolState: "success",
      agentState: "active",
    };
    const message: ClaudeMessage = {
      id: "assistant-current-state",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [part],
    };
    const messages = [message];

    const updated = applyClaudeBackgroundTaskStates(messages, {
      task: {
        id: "task",
        toolUseId: "task-launch",
        status: "running",
      },
    });

    expect(updated).toBe(messages);
    expect(updated[0]).toBe(message);
    expect(updated[0]?.parts[0]).toBe(part);
  });

  test("never correlates Claude background tasks by description", () => {
    const messages: ClaudeMessage[] = [{
      id: "assistant-unmatched-agent",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [{
        type: "tool-invocation", content: "",
        toolName: "Task",
        toolUseId: "different-tool-use",
        toolState: "success",
        toolArgs: { description: "Same description" },
      }],
    }];

    expect(applyClaudeBackgroundTaskStates(messages, {
      task: {
        id: "task",
        toolUseId: "actual-tool-use",
        description: "Same description",
        status: "running",
      },
    })).toBe(messages);
  });

  test("recovers background task names for launch, output, and stop rows from transcript results", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "assistant-launch",
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [{
          type: "tool-invocation", content: "",
          toolName: "Bash",
          toolUseId: "bash-launch",
          toolState: "success",
          toolArgs: {
            command: "sleep 300; echo waited",
            description: "Wait for remaining review thread",
            run_in_background: true,
          },
          toolOutput:
            "Command running in background with ID: bg-wait. Output is being written to: /tmp/bg-wait.output.",
        }],
      },
      {
        id: "assistant-output",
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:01:00.000Z",
        parts: [{
          type: "tool-invocation", content: "",
          toolName: "TaskOutput",
          toolState: "success",
          toolArgs: { task_id: "bg-wait" },
        }],
      },
      {
        id: "assistant-stop",
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:02:00.000Z",
        parts: [{
          type: "tool-invocation", content: "",
          toolName: "TaskStop",
          toolState: "success",
          toolArgs: { task_id: "bg-wait" },
        }],
      },
    ];

    const updated = applyClaudeBackgroundTaskStates(messages, {});

    for (const message of updated) {
      expect(message.parts[0]?.backgroundTask).toEqual({
        id: "bg-wait",
        description: "Wait for remaining review thread",
        status: undefined,
      });
    }
    expect(messages[0]?.parts[0]?.backgroundTask).toBeUndefined();
  });

  test("uses authoritative lifecycle status and description on background command and stop rows", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "assistant-launch",
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [{
          type: "tool-invocation", content: "",
          toolName: "Bash",
          toolUseId: "bash-launch",
          toolState: "success",
          toolArgs: {
            command: "bun test",
            description: "Old description",
            run_in_background: true,
          },
        }],
      },
      {
        id: "assistant-stop",
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:01:00.000Z",
        parts: [{
          type: "tool-invocation", content: "",
          toolName: "TaskStop",
          toolState: "success",
          toolArgs: { task_id: "bg-suite" },
        }],
      },
    ];

    const updated = applyClaudeBackgroundTaskStates(messages, {
      "bg-suite": {
        id: "bg-suite",
        toolUseId: "bash-launch",
        description: "Run the full suite",
        status: "killed",
      },
    });

    expect(updated[0]?.parts[0]?.backgroundTask).toEqual({
      id: "bg-suite",
      description: "Run the full suite",
      status: "killed",
    });
    expect(updated[1]?.parts[0]?.backgroundTask).toEqual({
      id: "bg-suite",
      description: "Run the full suite",
      status: "killed",
    });
    expect(normalizeClaudePart(updated[1]!.parts[0]!)?.backgroundTask).toEqual({
      id: "bg-suite",
      description: "Run the full suite",
      status: "killed",
    });
  });

  const backgroundLaunchNotes = [
    [
      "started in the background",
      "Command running in background with ID: bg-wait. Output is being written to: /tmp/bg-wait.output.",
    ],
    [
      "manually backgrounded by the user",
      "Command was manually backgrounded by user with ID: bg-wait. Output is being written to: /tmp/bg-wait.output",
    ],
    [
      "moved to the background after a timeout",
      "Command did not complete within its 120s timeout and was moved to the background (ID: bg-wait). Output is being written to: /tmp/bg-wait.output.",
    ],
  ] as const;

  test.each(backgroundLaunchNotes)(
    "recovers the task id from a command %s",
    (_label, toolOutput) => {
      const messages: ClaudeMessage[] = [
        {
          id: "assistant-launch",
          role: "assistant",
          content: "",
          createdAt: "2026-06-18T12:00:00.000Z",
          parts: [{
            type: "tool-invocation", content: "",
            toolName: "Bash",
            toolState: "success",
            toolArgs: {
              command: "sleep 300; echo waited",
              description: "Wait for remaining review thread",
              run_in_background: true,
            },
            toolOutput,
          }],
        },
        {
          id: "assistant-stop",
          role: "assistant",
          content: "",
          createdAt: "2026-06-18T12:02:00.000Z",
          parts: [{
            type: "tool-invocation", content: "",
            toolName: "TaskStop",
            toolState: "success",
            toolArgs: { task_id: "bg-wait" },
          }],
        },
      ];

      const updated = applyClaudeBackgroundTaskStates(messages, {});

      for (const message of updated) {
        expect(message.parts[0]?.backgroundTask).toEqual({
          id: "bg-wait",
          description: "Wait for remaining review thread",
          status: undefined,
        });
      }
    },
  );

  test.each(["backgroundTaskId", "task_id", "taskId"] as const)(
    "recovers the task id from a structured launch result carrying %s",
    (idField) => {
      const messages: ClaudeMessage[] = [{
        id: "assistant-launch",
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [{
          type: "tool-invocation", content: "",
          toolName: "Bash",
          toolState: "success",
          toolArgs: {
            command: "bun test",
            description: "Run the full suite",
            run_in_background: true,
          },
          toolOutput: JSON.stringify({ [idField]: "bg-suite" }),
        }],
      }];

      expect(
        applyClaudeBackgroundTaskStates(messages, {})[0]?.parts[0]?.backgroundTask,
      ).toEqual({
        id: "bg-suite",
        description: "Run the full suite",
        status: undefined,
      });
    },
  );

  test("reapplying the same lifecycle leaves every message and part identical", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "assistant-launch",
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [{
          type: "tool-invocation", content: "",
          toolName: "Bash",
          toolUseId: "bash-launch",
          toolState: "success",
          toolArgs: {
            command: "bun test",
            description: "Run the full suite",
            run_in_background: true,
          },
        }],
      },
      {
        id: "assistant-stop",
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:01:00.000Z",
        parts: [{
          type: "tool-invocation", content: "",
          toolName: "TaskStop",
          toolState: "success",
          toolArgs: { task_id: "bg-suite" },
        }],
      },
    ];
    const tasks = {
      "bg-suite": {
        id: "bg-suite",
        toolUseId: "bash-launch",
        description: "Run the full suite",
        status: "killed",
      },
    } as const;

    // The join must converge: the memo that calls this re-runs on every
    // streamed update, so a second pass that keeps producing new objects would
    // re-render the whole transcript forever.
    const once = applyClaudeBackgroundTaskStates(messages, tasks);
    const twice = applyClaudeBackgroundTaskStates(once, tasks);

    expect(twice).toBe(once);
    expect(twice[0]).toBe(once[0]!);
    expect(twice[0]?.parts[0]).toBe(once[0]!.parts[0]!);
    expect(twice[1]?.parts[0]).toBe(once[1]!.parts[0]!);
  });

  test("leaves a transcript untouched when there is no background work to join", () => {
    const messages: ClaudeMessage[] = [{
      id: "assistant-plain",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation", content: "",
          toolName: "Bash",
          toolUseId: "bash-foreground",
          toolState: "success",
          toolArgs: { command: "bun test", description: "Run the full suite" },
        },
        {
          // A launch whose id was never persisted stays undecorated rather
          // than inventing an identity from the description.
          type: "tool-invocation", content: "",
          toolName: "Bash",
          toolState: "success",
          toolArgs: {
            command: "sleep 300",
            description: "Wait a while",
            run_in_background: true,
          },
          toolOutput: "Command completed with no id in the result.",
        },
        {
          // A stop for a task with no launch and no snapshot behind it.
          type: "tool-invocation", content: "",
          toolName: "TaskStop",
          toolState: "success",
          toolArgs: { task_id: "bg-unknown" },
        },
      ],
    }];

    expect(applyClaudeBackgroundTaskStates(messages, {})).toBe(messages);
  });

  test("does not decorate a task action whose id matches no known task", () => {
    const messages: ClaudeMessage[] = [
      {
        id: "assistant-launch",
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [{
          type: "tool-invocation", content: "",
          toolName: "Bash",
          toolState: "success",
          toolArgs: {
            command: "bun test",
            description: "Run the full suite",
            run_in_background: true,
          },
          toolOutput: "Command running in background with ID: bg-suite.",
        }],
      },
      {
        id: "assistant-stop",
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:01:00.000Z",
        parts: [{
          type: "tool-invocation", content: "",
          toolName: "TaskStop",
          toolState: "success",
          toolArgs: { task_id: "bg-other" },
        }],
      },
    ];

    const updated = applyClaudeBackgroundTaskStates(messages, {});

    expect(updated[0]?.parts[0]?.backgroundTask).toEqual({
      id: "bg-suite",
      description: "Run the full suite",
      status: undefined,
    });
    expect(updated[1]?.parts[0]?.backgroundTask).toBeUndefined();
    expect(updated[1]).toBe(messages[1]!);
  });

  test.each([
    ["TaskStop", "task_id"],
    ["taskstop", "taskId"],
    ["task_stop", "task_id"],
    [" TaskOutput ", "taskId"],
    ["task_output", "task_id"],
  ] as const)(
    "joins a %s row addressed by %s",
    (toolName, idKey) => {
      const messages: ClaudeMessage[] = [{
        id: "assistant-action",
        role: "assistant",
        content: "",
        createdAt: "2026-06-18T12:01:00.000Z",
        parts: [{
          type: "tool-invocation", content: "",
          toolName,
          toolState: "success",
          toolArgs: { [idKey]: "bg-suite" },
        }],
      }];

      const updated = applyClaudeBackgroundTaskStates(messages, {
        "bg-suite": {
          id: "bg-suite",
          description: "Run the full suite",
          status: "running",
        },
      });

      expect(updated[0]?.parts[0]?.backgroundTask).toEqual({
        id: "bg-suite",
        description: "Run the full suite",
        status: "running",
      });
    },
  );

  test("treats a backgrounded Agent launch as an agent, not a background command", () => {
    const messages: ClaudeMessage[] = [{
      id: "assistant-agent-launch",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [{
        type: "tool-invocation", content: "",
        toolName: "Agent",
        toolUseId: "agent-launch",
        toolState: "success",
        toolArgs: {
          description: "Review the diff",
          run_in_background: true,
        },
      }],
    }];

    const updated = applyClaudeBackgroundTaskStates(messages, {
      "child-task": {
        id: "child-task",
        toolUseId: "agent-launch",
        description: "Review the diff",
        status: "running",
      },
    });

    expect(updated[0]?.parts[0]?.agentState).toBe("active");
    expect(updated[0]?.parts[0]?.backgroundTask).toBeUndefined();
  });

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
      createdAt: "2026-06-18T12:00:00.000Z",
      modelId: "claude-opus-5",
      parts: [
        {
          type: "text",
          content: "First",
          createdAt: "2026-06-18T12:00:00.000Z",
        },
        {
          type: "thinking",
          content: "Inspecting",
          createdAt: "2026-06-18T12:01:00.000Z",
        },
        {
          type: "text",
          content: "Second",
          createdAt: "2026-06-18T12:03:00.000Z",
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
      createdAt: "2026-06-18T12:00:00.000Z",
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
      createdAt: "2026-06-18T12:01:00.000Z",
      parts: [{ type: "text", content: "ignored raw xml" }],
    };

    const normalized = normalizeClaudeMessage(message);

    expect(normalized.createdAt).toBe(message.createdAt);
    expect(normalized.content).toBe("Inspect this");
    expect(normalized.parts).toEqual([
      { type: "text", content: "Inspect this" },
      {
        type: "file",
        content: "/workspace/screen.png",
        fileUrl: "/workspace/screen.png",
        filename: "screen.png",
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
        createdAt: textTimestamp,
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
        createdAt: thinkingTimestamp,
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
      createdAt: "2026-06-18T12:02:00.000Z",
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
      createdAt: "2026-06-18T12:02:30.000Z",
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

  test("associates an adjacent child tool positionally when no parent id is available", () => {
    const message: ClaudeMessage = {
      id: "claude-agent-positional-child",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:02:30.000Z",
      parts: [
        {
          type: "tool-invocation",
          toolName: "Agent",
          content: "Run reviewer",
          toolUseId: "agent-positional",
        },
        {
          type: "tool-invocation",
          toolName: "Read",
          content: "Read without parent metadata",
          toolUseId: "read-positional",
        },
      ],
    };

    const normalized = normalizeClaudeMessage(message);

    expect(normalized.parts).toHaveLength(1);
    expect(normalized.parts[0]?.type).toBe("task-group");
    if (normalized.parts[0]?.type === "task-group") {
      expect(normalized.parts[0].task.toolUseId).toBe("agent-positional");
      expect(normalized.parts[0].childTools).toEqual([
        expect.objectContaining({
          toolName: "Read",
          toolUseId: "read-positional",
        }),
      ]);
    }
  });

  test("discards standalone Claude tool-result parts from display grouping", () => {
    const message: ClaudeMessage = {
      id: "claude-standalone-tool-result",
      role: "assistant",
      content: "",
      createdAt: "2026-06-18T12:02:30.000Z",
      parts: [{
        type: "tool-result",
        toolName: "Read",
        content: "raw provider result",
        toolState: "success",
      }],
    };

    expect(normalizeClaudeMessage(message).parts).toEqual([]);
  });

  test("keeps subagent thinking, text, and edits inside the Agent group", () => {
    const message: ClaudeMessage = {
      id: "claude-agent-activity",
      role: "assistant",
      content: "Subagent answer",
      createdAt: "2026-07-28T08:00:00.000Z",
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
          type: "tool-invocation", content: "Edit",
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
      createdAt: "2026-06-18T12:02:30.000Z",
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
      createdAt: "2026-06-18T12:02:30.000Z",
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
      createdAt: "2026-06-18T12:02:30.000Z",
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
        filename: "a.png",
      },
      {
        type: "file",
        content: "/workspace/readme.md",
        fileUrl: undefined,
        filename: "readme.md",
      },
      {
        type: "file",
        content: "/workspace/b.jpg",
        fileUrl: "/workspace/b.jpg",
        filename: "b.jpg",
      },
    ]);
  });

  test("parses initial-prompt attachments for every native agent", () => {
    const rawContent = [
      "Compare this layout",
      '<attached-files><attachment type="image" path="/tmp/layout&amp;notes.png" filename="layout&amp;notes.png" /></attached-files>',
    ].join("\n");
    const message: NativeMessage = {
      id: "native-initial-prompt",
      role: "user",
      content: rawContent,
      createdAt: "2026-08-14T18:00:00.000Z",
      parts: [{ type: "text", content: rawContent }],
    };

    const normalized = normalizeNativeMessage(message);

    expect(normalized.content).toBe("Compare this layout");
    expect(normalized.parts).toEqual([
      { type: "text", content: "Compare this layout" },
      {
        type: "file",
        content: "/tmp/layout&notes.png",
        fileUrl: "/tmp/layout&notes.png",
        filename: "layout&notes.png",
      },
    ]);
  });

  test("deduplicates a structured file part and preserves the XML filename", () => {
    const rawContent = [
      "Inspect this",
      '<attached-files><attachment type="image" path="/workspace/generated-a.png" filename="original-a.png" /></attached-files>',
    ].join("\n");
    const message: NativeMessage = {
      id: "native-structured-initial-prompt",
      role: "user",
      content: rawContent,
      createdAt: "2026-08-14T18:00:00.000Z",
      parts: [
        { type: "text", content: rawContent },
        {
          type: "file",
          content: "/workspace/generated-a.png",
          fileUrl: "/workspace/generated-a.png",
        },
      ],
    };

    const normalized = normalizeNativeMessage(message);

    expect(normalized.parts.filter((part) => part.type === "file")).toEqual([{
      type: "file",
      content: "/workspace/generated-a.png",
      fileUrl: "/workspace/generated-a.png",
      filename: "original-a.png",
    }]);
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
      { type: "text", content: "", sourcePartId: "text-id" },
      { type: "thinking", content: "Reason", sourcePartId: "thinking-id" },
      { type: "file", content: "/workspace/a.txt" },
      {
        type: "tool-invocation", content: "Read",
        toolName: "Read",
        toolUseId: "tool-1",
        toolState: "pending",
      },
      {
        type: "tool-result", content: "contents",
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
        type: "tool-invocation", content: "Read",
        toolName: "Read",
        toolUseId: "tool-1",
        toolState: "pending",
      }),
      expect.objectContaining({
        type: "tool-result", content: "contents",
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
      type: "tool-invocation", content: "",
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
      type: "tool-invocation", content: "",
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
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [],
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "Answer",
        createdAt: "2026-06-18T12:00:01.000Z",
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
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            createdAt: "2026-06-18T12:00:00.000Z",
          },
          {
            type: "tool-invocation", content: "Read",
            toolName: "Read",
          },
          {
            type: "text",
            content: "Second",
            createdAt: "2026-06-18T12:01:00.000Z",
          },
          {
            type: "tool-invocation", content: "Bash",
            toolName: "Bash",
          },
          {
            type: "text",
            content: "Third",
            createdAt: "2026-06-18T12:02:00.000Z",
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
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            createdAt: "2026-06-18T12:00:00.000Z",
          },
          {
            type: "tool-invocation", content: "Read",
            toolName: "Read",
          },
          {
            type: "text",
            content: "Second",
            createdAt: "2026-06-18T12:01:30.000Z",
          },
          {
            type: "tool-invocation", content: "Bash",
            toolName: "Bash",
          },
          {
            type: "text",
            content: "Third",
            createdAt: "2026-06-18T12:02:01.000Z",
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
      createdAt: messageTimestamp,
      parts: [
        {
          type: "text",
          content: "First",
          createdAt: firstTextTimestamp,
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
            type: "tool-invocation", content: "Read",
            toolName: "Read",
          },
          {
            type: "text",
            content: "Second",
            createdAt: delayedTextTimestamp,
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
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            createdAt: "2026-06-18T12:00:00.000Z",
          },
          {
            type: "thinking",
            content: "I should inspect another path.",
            createdAt: "2026-06-18T12:01:00.000Z",
          },
          {
            type: "text",
            content: "Second",
            createdAt: "2026-06-18T12:02:01.000Z",
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
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            createdAt: firstTimestamp,
          },
          {
            type: "tool-invocation", content: "Read",
            toolName: "Read",
          },
          {
            type: "text",
            content: "Second",
            createdAt: secondTimestamp,
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
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            createdAt: "2026-06-18T12:00:00.000Z",
          },
          {
            type: "tool-invocation", content: "Read",
            toolName: "Read",
          },
          {
            type: "text",
            content: "Second",
            createdAt: "2026-06-18T12:02:01.000Z",
          },
          {
            type: "tool-invocation", content: "Bash",
            toolName: "Bash",
          },
          {
            type: "text",
            content: "Third",
            createdAt: "2026-06-18T12:04:02.000Z",
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
        createdAt: "2026-06-18T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            createdAt: "2026-06-18T12:00:00.000Z",
          },
          {
            type: "text",
            content: "Second",
            createdAt: "2026-06-18T12:05:00.000Z",
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
          type: "tool-invocation", content: "Bash",
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
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [
        { type: "text", content: "Hello", createdAt: "2026-06-18T12:00:00.000Z" },
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

describe("messageHasVisibleContent", () => {
  const makeMessage = (
    parts: NativeMessage["parts"],
    content = "",
  ): NativeMessage => ({
    id: "native-content-1",
    role: "assistant",
    content,
    createdAt: "2026-06-18T12:00:00.000Z",
    parts,
  });

  test("treats an info-only message with no parts as empty", () => {
    expect(messageHasVisibleContent(makeMessage([]))).toBe(false);
  });

  test("treats concatenated text content as visible", () => {
    expect(messageHasVisibleContent(makeMessage([], "Streamed answer"))).toBe(true);
  });

  test("treats whitespace-only message content as empty", () => {
    // The `content` short-circuit trims, so an assistant whose only payload is
    // layout whitespace is still an empty block.
    expect(messageHasVisibleContent(makeMessage([], "   \n\t "))).toBe(false);
  });

  test("treats non-empty text and thinking parts as visible", () => {
    expect(
      messageHasVisibleContent(
        makeMessage([{ type: "text", content: "Answer" }]),
      ),
    ).toBe(true);
    expect(
      messageHasVisibleContent(
        makeMessage([{ type: "thinking", content: "Reasoning" }]),
      ),
    ).toBe(true);
  });

  test("treats an empty text part as empty until content streams in", () => {
    expect(
      messageHasVisibleContent(makeMessage([{ type: "text", content: "" }])),
    ).toBe(false);
  });

  test("treats whitespace-only text and thinking parts as empty", () => {
    expect(
      messageHasVisibleContent(makeMessage([{ type: "text", content: "   " }])),
    ).toBe(false);
    expect(
      messageHasVisibleContent(
        makeMessage([{ type: "thinking", content: "\n\t " }]),
      ),
    ).toBe(false);
  });

  test("treats an empty thinking part as empty", () => {
    expect(
      messageHasVisibleContent(makeMessage([{ type: "thinking", content: "" }])),
    ).toBe(false);
  });

  test("treats a lone tool result as empty since it renders nothing", () => {
    expect(
      messageHasVisibleContent(
        makeMessage([{ type: "tool-result", content: "" }]),
      ),
    ).toBe(false);
  });

  test("treats a tool result as empty even when it carries output", () => {
    // The result renders inline with its invocation, so its content never
    // reaches the transcript on its own — having output changes nothing.
    expect(
      messageHasVisibleContent(
        makeMessage([
          { type: "tool-result", content: "exit 0\n42 files changed" },
        ]),
      ),
    ).toBe(false);
  });

  test("treats empty tool and agent groups as empty", () => {
    // Both group renderers return null at zero children, so classifying them
    // as visible would hang a model label above a row that paints nothing.
    expect(
      messageHasVisibleContent(
        makeMessage([{ type: "tool-group", content: "", parts: [] }]),
      ),
    ).toBe(false);
    expect(
      messageHasVisibleContent(
        makeMessage([{ type: "agent-group", content: "", parts: [] }]),
      ),
    ).toBe(false);
  });

  test("treats populated tool and agent groups as visible", () => {
    expect(
      messageHasVisibleContent(
        makeMessage([
          {
            type: "tool-group",
            content: "",
            parts: [
              { type: "tool-invocation", content: "", toolName: "Read", toolState: "success" },
            ],
          },
        ]),
      ),
    ).toBe(true);
    expect(
      messageHasVisibleContent(
        makeMessage([
          {
            type: "agent-group",
            content: "",
            parts: [
              {
                type: "subagent",
                content: "Reviewer",
                subagentName: "Reviewer",
                toolState: "pending",
                subagentActions: [],
              },
            ],
          },
        ]),
      ),
    ).toBe(true);
  });

  test("treats tool invocations, files, and agent activity as visible", () => {
    expect(
      messageHasVisibleContent(
        makeMessage([
          { type: "tool-invocation", content: "", toolName: "Read", toolState: "success" },
        ]),
      ),
    ).toBe(true);
    expect(
      messageHasVisibleContent(
        makeMessage([{ type: "file", content: "/tmp/a.txt" }]),
      ),
    ).toBe(true);
    expect(
      messageHasVisibleContent(
        makeMessage([
          {
            type: "subagent",
            content: "Reviewer",
            subagentName: "Reviewer",
            toolState: "pending",
            subagentActions: [],
          },
        ]),
      ),
    ).toBe(true);
  });

  test("agrees with itself before and after normalization", () => {
    // `findPreviousNativeMessage` classifies raw list messages while
    // `NativeMessage` classifies the normalized copy. If those two verdicts
    // diverge, a row's predecessor and its own footer disagree about whether
    // the same message counts as content.
    const shapes: NativeMessage["parts"][] = [
      [],
      [{ type: "text", content: "Answer" }],
      [{ type: "text", content: "   " }],
      [{ type: "thinking", content: "" }],
      [{ type: "tool-result", content: "output" }],
      [{ type: "tool-group", content: "", parts: [] }],
      [{ type: "agent-group", content: "", parts: [] }],
      [
        { type: "thinking", content: "Reasoning" },
        { type: "tool-result", content: "output" },
      ],
    ];

    for (const parts of shapes) {
      const raw = makeMessage(parts);
      expect({
        parts: JSON.stringify(parts),
        visible: messageHasVisibleContent(normalizeNativeMessage(raw)),
      }).toEqual({
        parts: JSON.stringify(parts),
        visible: messageHasVisibleContent(raw),
      });
    }
  });

  test("treats an unknown future part type as visible until the renderer says otherwise", () => {
    // The switch defaults to visible so a new part type the classifier has not
    // been taught about cannot silently strip attribution from a rendered row.
    // Casting keeps this honest about the fallback rather than pretending the
    // type is a real member of the union.
    const unknownPart = {
      type: "future-part",
      content: "Whatever it renders, it is not nothing",
    } as unknown as NativeMessage["parts"][number];
    expect(messageHasVisibleContent(makeMessage([unknownPart]))).toBe(true);
  });
});

describe("findPreviousNativeMessage", () => {
  const assistant = (
    id: string,
    parts: NativeMessage["parts"],
    content = "",
  ): NativeMessage => ({
    id,
    role: "assistant",
    content,
    createdAt: "2026-06-18T12:00:00.000Z",
    parts,
  });
  const user = (id: string): NativeMessage => ({
    id,
    role: "user",
    content: "Question",
    createdAt: "2026-06-18T11:59:00.000Z",
    parts: [],
  });

  test("returns null for the first message", () => {
    expect(findPreviousNativeMessage([assistant("a", [])], 0)).toBeNull();
  });

  test("returns null for an empty list", () => {
    expect(findPreviousNativeMessage([], 0)).toBeNull();
  });

  test("returns null for a negative index", () => {
    // Virtuoso should never hand us one, but the loop must not read backwards
    // off the front of the array if it ever does.
    expect(findPreviousNativeMessage([assistant("a", [])], -1)).toBeNull();
  });

  test("scans back from the end when the index is past the last message", () => {
    const messages = [
      user("u"),
      assistant("content", [{ type: "text", content: "Answer" }]),
    ];
    expect(findPreviousNativeMessage(messages, 10)).toBe(messages[1]!);
  });

  test("skips holes in a sparse list", () => {
    const messages = [
      user("u"),
      assistant("content", [{ type: "text", content: "Answer" }]),
    ];
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [messages[0]!, , messages[1]!] as NativeMessage[];
    expect(findPreviousNativeMessage(sparse, 2)).toBe(messages[0]!);
  });

  test("returns the immediate predecessor when it carries content", () => {
    const messages = [
      assistant("a", [{ type: "text", content: "Answer" }]),
      assistant("b", [{ type: "text", content: "More" }]),
    ];
    expect(findPreviousNativeMessage(messages, 1)).toBe(messages[0]!);
  });

  test("skips empty assistant messages so content anchors on the user", () => {
    const messages = [
      user("u"),
      assistant("empty", []),
      assistant("content", [{ type: "text", content: "Answer" }]),
    ];
    expect(findPreviousNativeMessage(messages, 2)).toBe(messages[0]!);
  });

  test("skips a run of empty assistant messages", () => {
    const messages = [
      user("u"),
      assistant("empty-1", []),
      assistant("empty-2", []),
      assistant("content", [{ type: "text", content: "Answer" }]),
    ];
    expect(findPreviousNativeMessage(messages, 3)).toBe(messages[0]!);
  });

  test("skips an empty message interleaved between two content messages", () => {
    const messages = [
      assistant("content-1", [{ type: "text", content: "First" }]),
      assistant("empty", []),
      assistant("content-2", [{ type: "text", content: "Second" }]),
    ];
    expect(findPreviousNativeMessage(messages, 2)).toBe(messages[0]!);
  });

  test("returns null when only empty assistant messages precede", () => {
    const messages = [
      assistant("empty-1", []),
      assistant("empty-2", []),
    ];
    expect(findPreviousNativeMessage(messages, 1)).toBeNull();
  });

  test("returns non-assistant predecessors even when they are empty", () => {
    const systemMessage: NativeMessage = {
      id: "sys",
      role: "system",
      content: "",
      createdAt: "2026-06-18T12:00:00.000Z",
      parts: [],
    };
    const messages = [systemMessage, assistant("content", [])];
    expect(findPreviousNativeMessage(messages, 1)).toBe(systemMessage);
  });
});
