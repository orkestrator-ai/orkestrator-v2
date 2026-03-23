import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { NativeMessage } from "./NativeMessage";

function makeMessage(
  parts: Array<{ type: "thinking" | "text"; content: string }>,
  overrides?: Partial<{
    id: string;
    role: "user" | "assistant";
    content: string;
  }>,
) {
  return {
    id: overrides?.id ?? "assistant-1",
    role: overrides?.role ?? ("assistant" as const),
    content: overrides?.content ?? "",
    createdAt: "2026-03-21T10:00:00.000Z",
    parts,
  };
}

describe("NativeMessage task list rendering", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders task list in a collapsible thinking block that expands on click", () => {
    const message = makeMessage([
      {
        type: "thinking",
        content: "- [x] Finished task\n- [ ] Next task",
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    // Initially collapsed — content is hidden
    expect(container.textContent).toContain("task list");
    expect(container.textContent).not.toContain("Finished task");

    // Click the trigger to expand
    const trigger = screen.getByRole("button", { name: /thinking/i });
    fireEvent.click(trigger);

    // Now the task list content should be visible
    expect(container.textContent).not.toContain("[x]");
    expect(container.textContent).not.toContain("[ ]");

    const completedTask = screen.getByText("Finished task");
    expect(completedTask.className).toContain("line-through");

    const checkboxIcons = container.querySelectorAll(
      '[data-task-list-icon="true"]',
    );
    expect(checkboxIcons).toHaveLength(2);
    expect(checkboxIcons[0]?.getAttribute("data-state")).toBe("checked");
    expect(checkboxIcons[1]?.getAttribute("data-state")).toBe("unchecked");
  });

  test("renders regular thinking parts as collapsed single-line summary", () => {
    const message = makeMessage([
      {
        type: "thinking",
        content: "Let me analyze the code structure here",
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    expect(container.textContent).toContain(
      "Let me analyze the code structure here",
    );
    // Should NOT have a collapsible trigger (no chevron button)
    expect(container.querySelector("button")).toBeNull();
  });

  test("text parts with task lists render checkboxes directly (no collapsible)", () => {
    const message = makeMessage([
      {
        type: "text",
        content: "Here is a checklist:\n- [x] Done\n- [ ] Todo",
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    const checkboxIcons = container.querySelectorAll(
      '[data-task-list-icon="true"]',
    );
    expect(checkboxIcons).toHaveLength(2);
    expect(container.textContent).not.toContain("[x]");
    expect(container.textContent).not.toContain("[ ]");
  });

  test("handles mixed content in thinking: task list plus prose", () => {
    const content =
      "I need to work through several items:\n\n- [x] Read the file\n- [ ] Write the fix\n\nLet me start with the fix.";
    const message = makeMessage([{ type: "thinking", content }]);

    const { container } = render(<NativeMessage message={message} />);

    // Should detect the task list and use the collapsible variant
    const trigger = screen.getByRole("button", { name: /thinking/i });
    fireEvent.click(trigger);

    expect(container.textContent).toContain("Read the file");
    expect(container.textContent).toContain("Write the fix");
    expect(container.textContent).toContain("Let me start with the fix.");
  });

  test("handles empty task list items gracefully", () => {
    const message = makeMessage([
      {
        type: "text",
        content: "- [ ] \n- [x] Has text",
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    // Should render without crashing
    const checkboxIcons = container.querySelectorAll(
      '[data-task-list-icon="true"]',
    );
    expect(checkboxIcons.length).toBeGreaterThanOrEqual(1);
  });
});
