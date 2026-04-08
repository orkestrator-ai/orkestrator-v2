import { describe, expect, test } from "bun:test";
import { summarizeTodoList, mapTodoArgs } from "./todo-helpers.js";

describe("summarizeTodoList", () => {
  test("renders completed items with [x] and pending items with [ ]", () => {
    const result = summarizeTodoList([
      { text: "Done task", completed: true },
      { text: "Open task", completed: false },
    ]);

    expect(result).toBe("[x] Done task\n[ ] Open task");
  });

  test("returns empty string for empty list", () => {
    expect(summarizeTodoList([])).toBe("");
  });

  test("handles single item", () => {
    expect(summarizeTodoList([{ text: "Only task", completed: false }])).toBe(
      "[ ] Only task",
    );
  });
});

describe("mapTodoArgs", () => {
  test("maps completed items to 'completed' status", () => {
    const result = mapTodoArgs([
      { text: "Finished", completed: true },
    ]);

    expect(result).toEqual({
      todos: [{ content: "Finished", status: "completed" }],
    });
  });

  test("maps incomplete items to 'pending' status", () => {
    const result = mapTodoArgs([
      { text: "Not done", completed: false },
    ]);

    expect(result).toEqual({
      todos: [{ content: "Not done", status: "pending" }],
    });
  });

  test("maps mixed completed and pending items", () => {
    const result = mapTodoArgs([
      { text: "Task A", completed: true },
      { text: "Task B", completed: false },
      { text: "Task C", completed: true },
    ]);

    expect(result).toEqual({
      todos: [
        { content: "Task A", status: "completed" },
        { content: "Task B", status: "pending" },
        { content: "Task C", status: "completed" },
      ],
    });
  });

  test("returns empty todos array for empty input", () => {
    expect(mapTodoArgs([])).toEqual({ todos: [] });
  });
});
