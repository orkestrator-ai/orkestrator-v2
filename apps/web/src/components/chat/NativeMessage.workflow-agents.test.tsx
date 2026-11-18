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
  {
    index: 4,
    label: "Lint",
    status: "failed",
    error: "eslint exited 1",
    toolUses: 0,
    totalTokens: 0,
  },
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
        workflowAgentsOmitted: 61,
        workflowAgentCounts: { total: 66, running: 2, queued: 1, finished: 63, failed: 2 },
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
      screen.getByText("2 running · 1 queued · 63/66 done · 2 failed — Build: introductions"),
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
    expect(within(list).getByText(/61 more agents not shown/)).toBeTruthy();
    expect(within(rows[4]!).getByTitle("0 tool uses")).toBeTruthy();
    expect(within(rows[4]!).getByTitle("0 tokens")).toBeTruthy();
    expect(within(rows[3]!).queryByTitle("0 tool uses")).toBeFalsy();
    expect(within(rows[3]!).queryByTitle("0 tokens")).toBeFalsy();
  });

  test("labels counts from older or partial snapshots", () => {
    expect(workflowAgentsStatusLine(agents, undefined, undefined, 5)).toContain("Shown agents: ");
    expect(
      workflowAgentsStatusLine(
        undefined,
        undefined,
        {
          total: 5,
          finished: 3,
          running: 2,
          queued: 0,
          failed: 1,
          partial: true,
        },
        10,
      ),
    ).toBe("Reported agents: 2 running · 3/5 done · 1 failed");
  });

  test("the status line needs agents", () => {
    expect(workflowAgentsStatusLine(undefined, "latest", undefined, undefined)).toBeUndefined();
    expect(workflowAgentsStatusLine([], "latest", undefined, undefined)).toBeUndefined();
    expect(workflowAgentsStatusLine([agents[0]!], undefined, undefined, undefined)).toBe(
      "1/1 done",
    );
  });
});
