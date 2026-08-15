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
