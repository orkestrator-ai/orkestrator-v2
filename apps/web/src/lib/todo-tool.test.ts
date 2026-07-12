import { describe, expect, test } from "bun:test";
import {
  getTodoToolLabel,
  getTodoItems,
  isTodoItem,
  isTaskTodoTool,
  isTodoTool,
  parseTodosFromOutput,
} from "./todo-tool";

describe("todo-tool", () => {
  test("accepts cancelled todos as valid items", () => {
    expect(
      isTodoItem({
        content: "Skip flaky test",
        status: "cancelled",
      }),
    ).toBe(true);
  });

  test("parses todos from nested output payload", () => {
    const output = JSON.stringify({
      todos: [
        { content: "Implement feature", status: "completed" },
        { content: "Document follow-up", status: "pending" },
      ],
    });

    expect(parseTodosFromOutput(output)).toEqual([
      { content: "Implement feature", status: "completed" },
      { content: "Document follow-up", status: "pending" },
    ]);
  });

  test("returns an empty list for malformed output payloads", () => {
    expect(parseTodosFromOutput("{not json")).toEqual([]);
    expect(parseTodosFromOutput()).toEqual([]);
  });

  test("falls back to output todos when args are invalid", () => {
    const todos = getTodoItems(
      {
        todos: [{ content: "Bad status", status: "unknown" }],
      },
      JSON.stringify({
        todos: [
          { content: "Read fallback todos", status: "in_progress" },
          { content: "Ignore old task", status: "cancelled" },
        ],
      }),
    );

    expect(todos).toEqual([
      { content: "Read fallback todos", status: "in_progress" },
      { content: "Ignore old task", status: "cancelled" },
    ]);
  });

  test("prefers valid args todos over output todos", () => {
    const todos = getTodoItems(
      {
        todos: [{ content: "Take args todos", status: "completed" }],
      },
      JSON.stringify({
        todos: [{ content: "Output should not be used", status: "pending" }],
      }),
    );

    expect(todos).toEqual([
      { content: "Take args todos", status: "completed" },
    ]);
  });

  test("normalizes TaskUpdate input into a todo-style task item", () => {
    const todos = getTodoItems(
      {
        taskId: "2",
        status: "completed",
      },
      "Updated task #2 status",
      "TaskUpdate",
    );

    expect(todos).toEqual([
      { content: "Task #2", status: "completed" },
    ]);
  });

  test("normalizes TaskCreate task arrays into todo-style task items", () => {
    const todos = getTodoItems(
      {
        tasks: [
          { id: "1", title: "Inspect renderer", status: "completed" },
          { taskId: 2, content: "Add UI tests", status: "in-progress" },
          "Run typecheck",
        ],
      },
      undefined,
      "TaskCreate",
    );

    expect(todos).toEqual([
      { content: "#1 Inspect renderer", status: "completed" },
      { content: "#2 Add UI tests", status: "in_progress" },
      { content: "Run typecheck", status: "pending" },
    ]);
  });

  test("uses newer Claude task subjects instead of generic task labels", () => {
    const todos = getTodoItems(
      {
        tasks: [
          {
            id: "1",
            content: "task 1",
            subject: "Extract ArchivePage to ArchiveClient component",
            status: "completed",
          },
          {
            id: "2",
            content: "task 2",
            activeForm: "Running typecheck & tests",
            status: "in_progress",
          },
        ],
      },
      undefined,
      "TaskList",
    );

    expect(todos).toEqual([
      {
        content: "#1 Extract ArchivePage to ArchiveClient component",
        status: "completed",
      },
      { content: "#2 Running typecheck & tests", status: "in_progress" },
    ]);
  });

  test("normalizes TaskCreate subject input", () => {
    const todos = getTodoItems(
      {
        subject: "Derive selection from URL pathname",
        description: "Route selection should not be duplicated in state",
      },
      undefined,
      "TaskCreate",
    );

    expect(todos).toEqual([
      {
        content: "Derive selection from URL pathname",
        status: "pending",
      },
    ]);
  });

  test("falls back to TaskCreate JSON output when args do not include tasks", () => {
    const todos = getTodoItems(
      undefined,
      JSON.stringify({
        tasks: [
          { id: "1", title: "From output", status: "done" },
          { taskId: "2", content: "Still open", status: "open" },
        ],
      }),
      "TaskCreate",
    );

    expect(todos).toEqual([
      { content: "#1 From output", status: "completed" },
      { content: "#2 Still open", status: "pending" },
    ]);
  });

  test("normalizes deleted status to cancelled", () => {
    const todos = getTodoItems(
      {
        tasks: [{ id: "1", content: "Removed task", status: "deleted" }],
      },
      undefined,
      "TaskCreate",
    );

    expect(todos).toEqual([{ content: "#1 Removed task", status: "cancelled" }]);
  });

  test("adds task ID prefix even when content contains the ID mid-string", () => {
    const todos = getTodoItems(
      { id: "1", subject: "Fix PR #1 merge conflict" },
      undefined,
      "TaskGet",
    );

    expect(todos).toEqual([
      { content: "#1 Fix PR #1 merge conflict", status: "pending" },
    ]);
  });

  test("does not double-prefix content that already starts with task ID", () => {
    const todos = getTodoItems(
      { id: "1", subject: "#1 Already prefixed subject" },
      undefined,
      "TaskGet",
    );

    expect(todos).toEqual([
      { content: "#1 Already prefixed subject", status: "pending" },
    ]);
  });

  test("skips placeholder-style labels in favour of richer fields", () => {
    // "task1" (no space) is a placeholder — activeForm wins
    expect(
      getTodoItems({ id: "5", content: "task1", activeForm: "Real description" }, undefined, "TaskGet"),
    ).toEqual([{ content: "#5 Real description", status: "pending" }]);

    // bare number is a placeholder — title wins
    expect(
      getTodoItems({ id: "3", content: "3", title: "Fix login bug" }, undefined, "TaskGet"),
    ).toEqual([{ content: "#3 Fix login bug", status: "pending" }]);

    // "task#1" is a placeholder — subject wins
    expect(
      getTodoItems({ id: "1", content: "task#1", subject: "Migrate auth module" }, undefined, "TaskGet"),
    ).toEqual([{ content: "#1 Migrate auth module", status: "pending" }]);

    // "task" alone (no digit) is NOT a placeholder and is used as content
    expect(
      getTodoItems({ id: "7", content: "task" }, undefined, "TaskGet"),
    ).toEqual([{ content: "#7 task", status: "pending" }]);
  });

  test("parses Claude TodoWrite newTodos output when args are unavailable", () => {
    const todos = getTodoItems(
      undefined,
      JSON.stringify({
        newTodos: [
          {
            content: "task 1",
            activeForm: "Typecheck & test",
            status: "in_progress",
          },
        ],
      }),
      "TodoWrite",
    );

    expect(todos).toEqual([
      { content: "Typecheck & test", status: "in_progress" },
    ]);
  });

  describe("isTaskTodoTool", () => {
    test("recognizes only task todo tool names", () => {
      expect(isTaskTodoTool("TaskCreate")).toBe(true);
      expect(isTaskTodoTool("task_update")).toBe(true);
      expect(isTaskTodoTool("TaskList")).toBe(true);
      expect(isTaskTodoTool("TaskGet")).toBe(true);
      expect(isTaskTodoTool("task_get")).toBe(true);
      expect(isTaskTodoTool("TodoWrite")).toBe(false);
      expect(isTaskTodoTool(undefined)).toBe(false);
    });
  });

  describe("isTodoTool", () => {
    test("recognizes TodoWrite (PascalCase)", () => {
      expect(isTodoTool("TodoWrite")).toBe(true);
    });

    test("recognizes todowrite (lowercase)", () => {
      expect(isTodoTool("todowrite")).toBe(true);
    });

    test("recognizes todo_list (codex bridge)", () => {
      expect(isTodoTool("todo_list")).toBe(true);
    });

    test("recognizes task create and update tools", () => {
      expect(isTodoTool("TaskCreate")).toBe(true);
      expect(isTodoTool("TaskUpdate")).toBe(true);
      expect(isTodoTool("TaskList")).toBe(true);
      expect(isTodoTool("task_create")).toBe(true);
      expect(isTodoTool("task_update")).toBe(true);
      expect(isTodoTool("task_list")).toBe(true);
    });

    test("rejects unrelated tool names", () => {
      expect(isTodoTool("Read")).toBe(false);
      expect(isTodoTool("Write")).toBe(false);
      expect(isTodoTool("todo")).toBe(false);
    });

    test("returns false for undefined and empty string", () => {
      expect(isTodoTool(undefined)).toBe(false);
      expect(isTodoTool("")).toBe(false);
    });
  });

  describe("getTodoToolLabel", () => {
    test("returns friendly labels for todo-like task tools", () => {
      expect(getTodoToolLabel("todo_list")).toBe("Todo List");
      expect(getTodoToolLabel("TaskCreate")).toBe("Task Create");
      expect(getTodoToolLabel("TaskUpdate")).toBe("Task Update");
      expect(getTodoToolLabel("TaskList")).toBe("Task List");
      expect(getTodoToolLabel("TaskGet")).toBe("Task Get");
      expect(getTodoToolLabel("task_get")).toBe("Task Get");
    });
  });
});
