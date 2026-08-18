import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { TodoToolPart } from "./TodoToolPart";
import type { TaskListSnapshot } from "@orkestrator/protocol/task-list";

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
    expect(screen.getByRole("button", { name: /todo write/i }).parentElement?.className).toContain(
      "my-0",
    );
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

  test("displays 'Todo Write' label for Grok todo_write tool", () => {
    const { container } = render(
      <TodoToolPart
        toolName="todo_write"
        toolState="success"
        toolArgs={{
          todos: [
            { id: "1", content: "Inspect renderer", status: "completed" },
            { id: "2", content: "Stamp Grok todos", status: "pending" },
          ],
        }}
      />,
    );

    expect(container.textContent).toContain("Todo Write");
    expect(container.textContent).not.toContain("todo_write");
    expect(container.textContent).toContain("1/2 complete");
  });

  test("displays 'Update TODOs' label for Cursor updateTodos tool", () => {
    const { container } = render(
      <TodoToolPart
        toolName="updateTodos"
        toolState="success"
        toolArgs={{
          todos: [
            { id: "1", content: "Inspect renderer", status: "completed" },
            { id: "2", content: "Stamp Cursor todos", status: "pending" },
          ],
        }}
      />,
    );

    expect(container.textContent).toContain("Update TODOs");
    expect(container.textContent).not.toContain("updateTodos");
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
      <TodoToolPart toolName="TodoWrite" toolState="failure" toolError="Something went wrong" />,
    );

    fireEvent.click(container.querySelector("button")!);

    expect(container.textContent).toContain("Something went wrong");
    expect(container.textContent).toContain("failure");
  });

  test("shows raw toolOutput when no structured todos are available", () => {
    const { container } = render(
      <TodoToolPart toolName="TodoWrite" toolState="success" toolOutput="plain text output" />,
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
    const { container } = render(<TodoToolPart toolName="TodoWrite" toolState="success" />);

    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    expect(trigger!.hasAttribute("disabled")).toBe(true);
  });

  describe("task snapshots", () => {
    const items = [
      { id: "1", subject: "Cache threadId", status: "completed" as const },
      { id: "2", subject: "Fix cache thrash", status: "in_progress" as const },
      { id: "3", subject: "Throttle transcript probe", status: "pending" as const },
    ];
    /** As the backend ships it: the list, plus which task the call changed. */
    const snapshotOf = (changedTaskId?: string): TaskListSnapshot => ({
      items,
      complete: true,
      ...(changedTaskId ? { changedTaskId } : {}),
    });
    const snapshot = snapshotOf();

    test("renders the whole list for a single-task create", () => {
      const { container } = render(
        <TodoToolPart
          toolName="TaskCreate"
          toolState="success"
          toolArgs={{ subject: "Throttle transcript probe", description: "..." }}
          toolOutput="Task #3 created successfully: Throttle transcript probe"
          taskSnapshot={snapshotOf("3")}
        />,
      );

      // The count reflects the list, not this one call.
      expect(container.textContent).toContain("1/3 complete");

      fireEvent.click(container.querySelector("button")!);
      expect(container.textContent).toContain("Cache threadId");
      expect(container.textContent).toContain("Fix cache thrash");
      expect(container.textContent).toContain("Throttle transcript probe");
    });

    test("shows the real subject for a status-only update", () => {
      const { container } = render(
        <TodoToolPart
          toolName="TaskUpdate"
          toolState="success"
          toolArgs={{ taskId: "2", status: "in_progress" }}
          toolOutput="Updated task #2 status"
          taskSnapshot={snapshot}
        />,
      );

      fireEvent.click(container.querySelector("button")!);

      expect(container.textContent).toContain("Fix cache thrash");
      expect(container.textContent).not.toContain("Task #2");
    });

    test("highlights the task the backend says the call changed", () => {
      const { container } = render(
        <TodoToolPart
          toolName="TaskUpdate"
          toolState="success"
          // Deliberately inconsistent args: the highlight follows the backend's
          // changedTaskId, never anything re-parsed here.
          toolArgs={{ taskId: "1", status: "in_progress" }}
          toolOutput="Updated task #1 status"
          taskSnapshot={snapshotOf("2")}
        />,
      );

      fireEvent.click(container.querySelector("button")!);

      const rows = Array.from(container.querySelectorAll("div")).filter((row) =>
        row.className.includes("bg-muted/50"),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain("Fix cache thrash");
    });

    test("highlights nothing when the snapshot reports no changed task", () => {
      // TaskList and TaskGet read without mutating, so the backend sends no
      // changedTaskId and no row is singled out.
      const { container } = render(
        <TodoToolPart
          toolName="TaskList"
          toolState="success"
          toolOutput="#1 [completed] Cache threadId"
          taskSnapshot={snapshot}
        />,
      );

      fireEvent.click(container.querySelector("button")!);

      const highlighted = Array.from(container.querySelectorAll("div")).filter((row) =>
        row.className.includes("bg-muted/50"),
      );
      expect(highlighted).toHaveLength(0);
    });

    test("does not claim a total for a list known to be incomplete", () => {
      const { container } = render(
        <TodoToolPart
          toolName="TaskUpdate"
          toolState="success"
          toolArgs={{ taskId: "7", status: "in_progress" }}
          toolOutput="Updated task #7 status"
          taskSnapshot={{
            items: [{ id: "7", subject: "Task #7", status: "in_progress" }],
            complete: false,
            changedTaskId: "7",
          }}
        />,
      );

      // "0/1 complete" would assert this is the whole list, which it is not.
      expect(container.textContent).not.toContain("0/1 complete");
      expect(container.textContent).toContain("1 task tracked");

      fireEvent.click(container.querySelector("button")!);
      expect(container.textContent).toContain("not shown");
    });

    test("pluralizes the tracked count for an incomplete list", () => {
      const { container } = render(
        <TodoToolPart
          toolName="TaskUpdate"
          toolState="success"
          taskSnapshot={{ items, complete: false }}
        />,
      );

      expect(container.textContent).toContain("3 tasks tracked");
    });

    test("surfaces tasks dropped by the size cap rather than hiding them", () => {
      const { container } = render(
        <TodoToolPart
          toolName="TaskList"
          toolState="success"
          taskSnapshot={{ items, complete: true, truncated: 12 }}
        />,
      );

      expect(container.textContent).toContain("+12 more");

      fireEvent.click(container.querySelector("button")!);
      expect(container.textContent).toContain("12 more tasks not shown");
    });

    test("prefers the snapshot over per-call args", () => {
      const { container } = render(
        <TodoToolPart
          toolName="TaskCreate"
          toolState="success"
          toolArgs={{ subject: "Only this one", description: "..." }}
          taskSnapshot={snapshot}
        />,
      );

      expect(container.textContent).toContain("1/3 complete");
    });

    test("renders an genuinely empty snapshot as an empty list", () => {
      // Every task deleted: a real state the backend vouches for.
      const { container } = render(
        <TodoToolPart
          toolName="TaskList"
          toolState="success"
          toolOutput="No tasks found."
          taskSnapshot={{ items: [], complete: true }}
        />,
      );

      expect(container.textContent).toContain("no tasks");

      fireEvent.click(container.querySelector("button")!);
      expect(container.textContent).toContain("Task list is empty.");
    });

    test("does not assert emptiness for an empty list known to be incomplete", () => {
      const { container } = render(
        <TodoToolPart
          toolName="TaskList"
          toolState="success"
          taskSnapshot={{ items: [], complete: false }}
        />,
      );

      expect(container.textContent).toContain("no tasks tracked");

      fireEvent.click(container.querySelector("button")!);
      expect(container.textContent).not.toContain("Task list is empty.");
    });

    test("shows the raw output when the backend could not parse the call", () => {
      // No snapshot at all — the backend is saying "I don't know", which must
      // not render as an empty list.
      const { container } = render(
        <TodoToolPart toolName="TaskList" toolState="success" toolOutput="unparsed blob" />,
      );

      expect(container.textContent).not.toContain("no tasks");

      fireEvent.click(container.querySelector("button")!);
      expect(container.textContent).not.toContain("Task list is empty.");
      expect(container.textContent).toContain("unparsed blob");
    });

    test("falls back to per-call parsing when no snapshot is supplied", () => {
      // Messages recorded before the backend tracked task state.
      const { container } = render(
        <TodoToolPart
          toolName="TaskCreate"
          toolState="success"
          toolArgs={{ subject: "Legacy task", description: "..." }}
        />,
      );

      expect(container.textContent).toContain("0/1 complete");

      fireEvent.click(container.querySelector("button")!);
      expect(container.textContent).toContain("Legacy task");
    });
  });
});
