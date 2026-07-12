import { describe, expect, test } from "bun:test";
import type { ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-client";
import { collapseTaskToolUpdates } from "./task-tool-snapshots";

function assistantMessage(id: string, parts: ClaudeMessagePart[]): ClaudeMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp: "2026-01-01T00:00:00Z",
    parts,
  };
}

function taskTool(
  toolName: string,
  toolUseId: string,
  toolArgs: Record<string, unknown>,
  toolState: ClaudeMessagePart["toolState"] = "success",
  toolOutput?: string,
): ClaudeMessagePart {
  return {
    type: "tool-invocation",
    toolName,
    toolUseId,
    toolArgs,
    toolState,
    toolOutput,
  };
}

describe("collapseTaskToolUpdates", () => {
  test("renders repeated TaskCreate and TaskUpdate calls as one current task list", () => {
    const collapsed = collapseTaskToolUpdates([
      assistantMessage("a1", [
        taskTool("TaskCreate", "create-1", {
          name: "Add server-side X API client to web app",
        }),
        taskTool("TaskCreate", "create-2", {
          name: "Wire X bearer token env config",
        }),
        {
          type: "text",
          content: "Starting with task 1 - server-side X API client.",
        },
        taskTool("TaskUpdate", "update-1", {
          taskId: "1",
          status: "in_progress",
        }),
      ]),
    ]);

    expect(collapsed).toHaveLength(1);
    const parts = collapsed[0]!.parts;
    expect(parts.map((part) => part.type)).toEqual(["text", "tool-invocation"]);

    const snapshot = parts[1]!;
    expect(snapshot.toolName).toBe("TaskList");
    expect(snapshot.toolArgs).toEqual({
      todos: [
        {
          content: "Add server-side X API client to web app",
          status: "in_progress",
        },
        {
          content: "Wire X bearer token env config",
          status: "pending",
        },
      ],
    });
  });

  test("keeps only the newest task snapshot across assistant messages", () => {
    const collapsed = collapseTaskToolUpdates([
      assistantMessage("create-only", [
        taskTool("TaskCreate", "create-1", { subject: "Inspect renderer" }),
      ]),
      assistantMessage("update-only", [
        taskTool("TaskUpdate", "update-1", {
          taskId: "1",
          status: "completed",
        }),
      ]),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.id).toBe("update-only");
    expect(collapsed[0]!.parts[0]?.toolName).toBe("TaskList");
    expect(collapsed[0]!.parts[0]?.toolArgs).toEqual({
      todos: [{ content: "Inspect renderer", status: "completed" }],
    });
  });

  test("replaces prior state from TaskList items without explicit ids", () => {
    const collapsed = collapseTaskToolUpdates([
      assistantMessage("create", [
        taskTool("TaskCreate", "create-1", { subject: "Stale task" }),
      ]),
      assistantMessage("list", [
        taskTool("TaskList", "list-1", {
          todos: [
            { content: "Inspect renderer", status: "completed" },
            { content: "Add UI tests", status: "in_progress" },
          ],
        }),
      ]),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.id).toBe("list");
    expect(collapsed[0]!.parts[0]?.toolArgs).toEqual({
      todos: [
        { content: "Inspect renderer", status: "completed" },
        { content: "Add UI tests", status: "in_progress" },
      ],
    });
  });

  test("continues implicit ids after a replacement TaskList snapshot", () => {
    const collapsed = collapseTaskToolUpdates([
      assistantMessage("list", [
        taskTool("TaskList", "list-1", {
          todos: [
            { content: "Inspect renderer", status: "completed" },
            { content: "Add UI tests", status: "pending" },
          ],
        }),
      ]),
      assistantMessage("create", [
        taskTool("TaskCreate", "create-1", { subject: "Run typecheck" }),
      ]),
      assistantMessage("update", [
        taskTool("TaskUpdate", "update-1", {
          taskId: "3",
          status: "in_progress",
        }),
      ]),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.parts[0]?.toolArgs).toEqual({
      todos: [
        { content: "Inspect renderer", status: "completed" },
        { content: "Add UI tests", status: "pending" },
        { content: "Run typecheck", status: "in_progress" },
      ],
    });
  });

  test("falls back to JSON output when task args do not contain task details", () => {
    const collapsed = collapseTaskToolUpdates([
      assistantMessage("output-only", [
        taskTool(
          "TaskCreate",
          "create-1",
          {},
          "success",
          JSON.stringify({
            tasks: [
              { id: "7", title: "Use output payload", status: "done" },
              { taskId: "8", content: "Keep pending work", status: "open" },
            ],
          }),
        ),
      ]),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.parts[0]?.toolArgs).toEqual({
      todos: [
        { content: "Use output payload", status: "completed" },
        { content: "Keep pending work", status: "pending" },
      ],
    });
  });

  test("keeps malformed task output visible instead of throwing", () => {
    const messages = [
      assistantMessage("bad-output", [
        taskTool("TaskCreate", "create-1", {}, "success", "{not json"),
      ]),
    ];

    const collapsed = collapseTaskToolUpdates(messages);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.parts[0]?.toolName).toBe("TaskCreate");
  });

  test("renders unknown TaskUpdate ids as placeholder task rows", () => {
    const collapsed = collapseTaskToolUpdates([
      assistantMessage("unknown-update", [
        taskTool("TaskUpdate", "update-1", {
          taskId: "42",
          status: "completed",
        }),
      ]),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.parts[0]?.toolArgs).toEqual({
      todos: [{ content: "Task #42", status: "completed" }],
    });
  });

  test("leaves messages without task tools unchanged", () => {
    const messages = [
      assistantMessage("a1", [taskTool("Bash", "bash-1", { command: "bun test" })]),
    ];

    expect(collapseTaskToolUpdates(messages)).toBe(messages);
  });
});
