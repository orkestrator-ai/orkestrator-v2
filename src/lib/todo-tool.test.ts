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

  describe("isTaskTodoTool", () => {
    test("recognizes only task todo tool names", () => {
      expect(isTaskTodoTool("TaskCreate")).toBe(true);
      expect(isTaskTodoTool("task_update")).toBe(true);
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
      expect(isTodoTool("task_create")).toBe(true);
      expect(isTodoTool("task_update")).toBe(true);
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
    });
  });
});
