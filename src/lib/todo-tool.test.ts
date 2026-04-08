import { describe, expect, test } from "bun:test";
import {
  getTodoItems,
  isTodoItem,
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
});
