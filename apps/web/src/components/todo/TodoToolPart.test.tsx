import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { TodoToolPart } from "./TodoToolPart";

describe("TodoToolPart", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders tool name and completion count from args", () => {
    const { container } = render(
      <TodoToolPart
        toolName="todowrite"
        toolState="success"
        toolArgs={{
          todos: [
            { content: "First task", status: "completed" },
            { content: "Second task", status: "pending" },
            { content: "Third task", status: "in_progress" },
          ],
        }}
      />,
    );

    expect(container.textContent).toContain("Todo Write");
    expect(container.textContent).toContain("1/3 complete");
    expect(container.textContent).toContain("success");
    expect(
      screen.getByRole("button", { name: /todo write/i }).parentElement?.className,
    ).toContain("my-0");
  });

  test("displays 'Todo List' label for codex todo_list tool", () => {
    const { container } = render(
      <TodoToolPart
        toolName="todo_list"
        toolState="success"
        toolArgs={{
          todos: [
            { content: "Check tests", status: "completed" },
            { content: "Fix bug", status: "pending" },
          ],
        }}
      />,
    );

    expect(container.textContent).toContain("Todo List");
    expect(container.textContent).not.toContain("todo_list");
    expect(container.textContent).toContain("1/2 complete");
  });

  test("renders TaskCreate tasks with friendly label", () => {
    const { container } = render(
      <TodoToolPart
        toolName="TaskCreate"
        toolState="success"
        toolArgs={{
          tasks: [
            { id: "1", title: "Inspect renderer", status: "completed" },
            { id: "2", title: "Add direct coverage", status: "pending" },
          ],
        }}
      />,
    );

    expect(container.textContent).toContain("Task Create");
    expect(container.textContent).toContain("1/2 complete");

    fireEvent.click(container.querySelector("button")!);

    expect(container.textContent).toContain("#1 Inspect renderer");
    expect(container.textContent).toContain("#2 Add direct coverage");
  });

  test("renders TaskUpdate from JSON output when args are missing", () => {
    const { container } = render(
      <TodoToolPart
        toolName="TaskUpdate"
        toolState="success"
        toolOutput={JSON.stringify({
          taskId: "7",
          content: "Verify output fallback",
          status: "done",
        })}
      />,
    );

    expect(container.textContent).toContain("Task Update");
    expect(container.textContent).toContain("1/1 complete");

    fireEvent.click(container.querySelector("button")!);

    expect(container.textContent).toContain("#7 Verify output fallback");
  });

  test("falls back to 'Todo Write' when toolName is undefined", () => {
    const { container } = render(
      <TodoToolPart toolState="success" toolOutput='[{"content":"a","status":"pending"}]' />,
    );

    expect(container.textContent).toContain("Todo Write");
  });

  test("expands to show todo items with checkboxes on click", () => {
    const { container } = render(
      <TodoToolPart
        toolName="TodoWrite"
        toolState="success"
        toolArgs={{
          todos: [
            { content: "Done task", status: "completed" },
            { content: "Open task", status: "pending" },
          ],
        }}
      />,
    );

    // Items not visible before expanding
    expect(container.textContent).not.toContain("Done task");

    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);

    // Items visible after expanding
    expect(container.textContent).toContain("Done task");
    expect(container.textContent).toContain("Open task");
  });

  test("renders completed items with line-through styling", () => {
    const { container } = render(
      <TodoToolPart
        toolName="TodoWrite"
        toolState="success"
        toolArgs={{
          todos: [{ content: "Finished item", status: "completed" }],
        }}
      />,
    );

    fireEvent.click(container.querySelector("button")!);

    const finishedSpan = screen.getByText("Finished item");
    expect(finishedSpan.className).toContain("line-through");
  });

  test("renders cancelled items with line-through and count", () => {
    const { container } = render(
      <TodoToolPart
        toolName="TodoWrite"
        toolState="success"
        toolArgs={{
          todos: [
            { content: "Cancelled item", status: "cancelled" },
            { content: "Open item", status: "pending" },
          ],
        }}
      />,
    );

    expect(container.textContent).toContain("1 cancelled");

    fireEvent.click(container.querySelector("button")!);

    const cancelledSpan = screen.getByText("Cancelled item");
    expect(cancelledSpan.className).toContain("line-through");
  });

  test("renders in_progress items with font-medium and badge", () => {
    const { container } = render(
      <TodoToolPart
        toolName="TodoWrite"
        toolState="success"
        toolArgs={{
          todos: [{ content: "Active item", status: "in_progress" }],
        }}
      />,
    );

    fireEvent.click(container.querySelector("button")!);

    const activeSpan = screen.getByText("Active item");
    expect(activeSpan.className).toContain("font-medium");
    expect(container.textContent).toContain("in progress");
  });

  test("shows toolError in error section when provided", () => {
    const { container } = render(
      <TodoToolPart
        toolName="TodoWrite"
        toolState="failure"
        toolError="Something went wrong"
      />,
    );

    fireEvent.click(container.querySelector("button")!);

    expect(container.textContent).toContain("Something went wrong");
    expect(container.textContent).toContain("failure");
  });

  test("shows raw toolOutput when no structured todos are available", () => {
    const { container } = render(
      <TodoToolPart
        toolName="TodoWrite"
        toolState="success"
        toolOutput="plain text output"
      />,
    );

    fireEvent.click(container.querySelector("button")!);

    expect(container.textContent).toContain("plain text output");
  });

  test("renders pending state with running indicator", () => {
    const { container } = render(
      <TodoToolPart
        toolName="TodoWrite"
        toolState="pending"
        toolArgs={{
          todos: [{ content: "In progress task", status: "pending" }],
        }}
      />,
    );

    expect(container.textContent).toContain("running...");
  });

  test("disables trigger when there is no expandable content", () => {
    const { container } = render(
      <TodoToolPart toolName="TodoWrite" toolState="success" />,
    );

    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    expect(trigger!.hasAttribute("disabled")).toBe(true);
  });
});
