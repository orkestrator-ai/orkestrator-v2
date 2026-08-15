import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ActiveSubagentRail, activeSubagentDetail, activeSubagentLabel } from "./ActiveSubagentRail";

afterEach(cleanup);

describe("ActiveSubagentRail", () => {
  test("renders a composer-themed active state with a reduced-motion spinner", () => {
    render(<ActiveSubagentRail agents={[{
      type: "task-group",
      content: "Task: Subagent task",
      task: {
        type: "tool-invocation",
        content: "Task: Subagent task",
        toolName: "task",
        toolTitle: "Task: Subagent task",
        toolState: "success",
        agentState: "active",
      },
      childTools: [],
    }]} />);

    const rail = screen.getByRole("status", { name: "1 sub-agent working" });
    expect(rail.className).toContain("rounded-2xl");
    expect(rail.className).toContain("bg-zinc-900/90");
    expect(rail.className).toContain("w-[calc(100%_-_0.75rem)]");
    expect(screen.getByText("Subagent task")).toBeTruthy();
    expect(screen.getByTestId("active-subagent-spinner").getAttribute("class"))
      .toContain("motion-reduce:animate-none");
  });

  test("summarizes multiple active children without overflowing the rail", () => {
    render(<ActiveSubagentRail agents={[
      {
        type: "subagent",
        content: "",
        subagentName: "Researcher",
        agentState: "active",
      },
      {
        type: "task-group",
        content: "Task",
        task: {
          type: "tool-invocation",
          content: "Task",
          toolArgs: { description: "Run focused tests" },
          agentState: "active",
        },
        childTools: [],
      },
    ]} />);

    expect(screen.getByRole("status", { name: "2 sub-agents working" })).toBeTruthy();
    expect(screen.getByText("Researcher · Run focused tests")).toBeTruthy();
  });

  test("prefers provider labels in a stable order", () => {
    expect(activeSubagentLabel({
      type: "task-group",
      content: "Task: fallback",
      task: {
        type: "tool-invocation",
        content: "Task: fallback",
        toolTitle: "Task: title",
        toolArgs: { prompt: "prompt", description: "description", name: "worker" },
      },
      childTools: [],
    })).toBe("worker");
  });

  test("appends the latest child action when the transcript has captured one", () => {
    render(<ActiveSubagentRail agents={[{
      type: "task-group",
      content: "Task: Subagent task",
      task: {
        type: "tool-invocation",
        content: "Task: Subagent task",
        toolName: "task",
        toolTitle: "Task: Subagent task",
        toolState: "success",
        agentState: "active",
      },
      childTools: [{
        type: "tool-invocation",
        content: "Search Find",
        toolName: "grep",
        toolTitle: "Search Find",
        toolArgs: { pattern: "ActiveSubagentRail" },
        toolState: "pending",
      }],
    }]} />);

    expect(screen.getByText("Subagent task: Search Find")).toBeTruthy();
  });

  test("keeps the volatile activity line out of the polite live region", () => {
    render(<ActiveSubagentRail agents={[{
      type: "task-group",
      content: "Task: Subagent task",
      task: {
        type: "tool-invocation",
        content: "Task: Subagent task",
        toolName: "task",
        toolTitle: "Task: Subagent task",
        agentState: "active",
      },
      childTools: [{
        type: "tool-invocation",
        content: "Search Find",
        toolName: "grep",
        toolTitle: "Search Find",
      }],
    }]} />);

    // The count is the only thing worth announcing; the detail advances with
    // every child tool call and would otherwise re-read the rail constantly.
    const detail = screen.getByTestId("active-subagent-detail");
    expect(detail.getAttribute("aria-live")).toBe("off");
    // Still reachable by a screen reader on navigation, just not announced.
    expect(detail.getAttribute("aria-hidden")).toBeNull();
    expect(detail.textContent).toBe("Subagent task: Search Find");
    // The count itself stays inside the announced region.
    expect(screen.getByText("1 sub-agent working").closest("[aria-live='off']") === null)
      .toBe(true);
  });

  test("bounds a verbose child action so other agents stay visible", () => {
    const longCommand = `rg --files-with-matches ${"src/deeply/nested/path ".repeat(20)}`;
    render(<ActiveSubagentRail agents={[
      {
        type: "task-group",
        content: "Task",
        task: {
          type: "tool-invocation",
          content: "Task",
          toolArgs: { description: "Explorer" },
          agentState: "active",
        },
        childTools: [{
          type: "tool-invocation",
          content: "Run Command",
          toolName: "bash",
          toolArgs: { command: longCommand },
        }],
      },
      {
        type: "subagent",
        content: "",
        subagentName: "Researcher",
        agentState: "active",
      },
    ]} />);

    const detail = screen.getByTestId("active-subagent-detail");
    // The bound has to leave room for the second agent's name on the same line.
    expect(detail.textContent).toContain("…");
    expect(detail.textContent).toContain("Researcher");
    expect(detail.textContent?.startsWith("Explorer: rg --files-with-matches")).toBe(true);
    expect(detail.textContent?.length).toBeLessThanOrEqual(90);
  });

  test("collapses newlines in a child action into the single rail line", () => {
    expect(activeSubagentDetail({
      type: "subagent",
      content: "Researcher",
      subagentName: "Researcher",
      subagentActions: [{ type: "text", content: "first line\n\nsecond line" }],
    })).toBe("Researcher: first line second line");
  });

  test("does not repeat the label when the latest action matches it", () => {
    expect(activeSubagentDetail({
      type: "subagent",
      content: "Researcher",
      subagentName: "Researcher",
      subagentActions: [{ type: "text", content: "Researcher" }],
    })).toBe("Researcher");
  });

  test("keeps the launch label when child activity has not arrived yet", () => {
    expect(activeSubagentDetail({
      type: "task-group",
      content: "Task: Subagent task",
      task: {
        type: "tool-invocation",
        content: "Task: Subagent task",
        toolTitle: "Task: Subagent task",
      },
      childTools: [],
    })).toBe("Subagent task");
  });

  test("renders nothing when no child work is active", () => {
    const { container } = render(<ActiveSubagentRail agents={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
