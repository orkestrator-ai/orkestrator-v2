import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { SegmentedSelector } from "./segmented-selector";

describe("SegmentedSelector", () => {
  test("exposes controlled button semantics", () => {
    const select = mock(() => undefined);
    render(
      <SegmentedSelector
        value="feature"
        ariaLabel="Build intent"
        onValueChange={select}
        options={[
          { value: "feature", label: "A feature" },
          { value: "prompt", label: "With a prompt" },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "A feature" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "With a prompt" }));
    expect(select).toHaveBeenCalledWith("prompt");
  });

  test("moves and selects tabs with arrow, Home, and End keys", () => {
    const select = mock(() => undefined);
    render(
      <SegmentedSelector
        value="coordinator"
        semantics="tabs"
        ariaLabel="Project navigation"
        onValueChange={select}
        options={[
          { value: "coordinator", label: "Coordinator", panelId: "coordinator-panel" },
          { value: "kanban", label: "Kanban", panelId: "kanban-panel" },
          { value: "github", label: "GitHub", panelId: "github-panel" },
        ]}
      />,
    );
    const coordinator = screen.getByRole("tab", { name: "Coordinator" });
    coordinator.focus();
    fireEvent.keyDown(coordinator, { key: "End" });
    expect(select).toHaveBeenLastCalledWith("github");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "GitHub" }));
    fireEvent.keyDown(screen.getByRole("tab", { name: "GitHub" }), { key: "Home" });
    expect(select).toHaveBeenLastCalledWith("coordinator");
  });
});
