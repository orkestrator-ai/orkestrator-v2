import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, screen, within } from "@testing-library/react";
import type { NativeAgentWorkflowAgent } from "@orkestrator/protocol/native-agent";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { BackgroundTaskCard } from "./NativeMessage.agent-parts";
import { workflowAgentsStatusLine } from "./NativeMessage.workflow-agents";

afterEach(cleanup);

const agents: NativeAgentWorkflowAgent[] = [
  {
    index: 0,
    label: "Plan",
    status: "completed",
    toolUses: 4,
    totalTokens: 12_000,
    durationMs: 9_000,
  },
  {
    index: 1,
    label: "Build: introductions",
    status: "running",
    phase: "Build",
    agentRole: "Explore",
    activity: "Editing src/app/introductions/page.tsx",
    toolUses: 7,
  },
  { index: 2, label: "Build: saved", status: "running", phase: "Build", lastToolName: "Read" },
  { index: 3, label: "Verify", status: "queued" },
  { index: 4, label: "Lint", status: "failed", error: "eslint exited 1" },
];

function workflowCard(open: boolean) {
  return (
    <BackgroundTaskCard
      task={{
        id: "wz29ruejm",
        status: "running",
        kind: "workflow",
        description: "Build investor Discover, Saved and Introductions",
        workflowName: "build-discover",
        progressSummary: "Build: introductions",
        workflowAgents: agents,
        workflowAgentsOmitted: 2,
        usage: { totalTokens: 541_000, toolUses: 153, durationMs: 60_000 },
      }}
      open={open}
      onOpenChange={() => {}}
    />
  );
}

describe("workflow agents", () => {
  test("the card keeps the workflow's name and summarises its agents", () => {
    renderInAppCommandScope(workflowCard(false));
    expect(
      screen.getByRole("button", {
        name: /Workflow Build investor Discover, Saved and Introductions Running/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("2 running · 1 queued · 2/5 done · 1 failed — Build: introductions"),
    ).toBeTruthy();
  });

  test("the expanded card lists every agent with what it is doing", () => {
    renderInAppCommandScope(workflowCard(true));
    const list = screen.getByRole("region", { name: "5 workflow agents" });
    expect(within(list).getByText("3 active")).toBeTruthy();
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-workflow-agent-status"))).toEqual([
      "completed",
      "running",
      "running",
      "queued",
      "failed",
    ]);
    expect(within(rows[0]!).getByText("9s")).toBeTruthy();
    expect(within(rows[0]!).getByText("12k")).toBeTruthy();
    expect(within(rows[1]!).getByText("Editing src/app/introductions/page.tsx")).toBeTruthy();
    expect(within(rows[1]!).getByText("Explore")).toBeTruthy();
    expect(within(rows[2]!).getByText("Using Read")).toBeTruthy();
    expect(within(rows[4]!).getByText("eslint exited 1")).toBeTruthy();
    expect(within(list).getByText(/2 more agents not shown/)).toBeTruthy();
  });

  test("the status line needs agents", () => {
    expect(workflowAgentsStatusLine(undefined, "latest")).toBeUndefined();
    expect(workflowAgentsStatusLine([], "latest")).toBeUndefined();
    expect(workflowAgentsStatusLine([agents[0]!], undefined)).toBe("1/1 done");
  });
});
