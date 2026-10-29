import { describe, expect, test } from "bun:test";
import { compile, type GraphPlanAgentNode } from "./compile.js";
import { agentOf, baseTemplate, withPanel } from "./compile-fixtures.test-support.js";
import { GraphBranchError, graphNodeBranches } from "./run-branches.js";
import { graphActivationKey } from "./run-identity.js";
import {
  GRAPH_ITEM_ID_MAX_CHARS,
  graphAcceptedItemIds,
  graphArtifactItemIds,
  graphItemIdLabel,
  graphItemIds,
} from "./run-items.js";
import { GRAPH_RUN_INPUT_PRODUCER } from "./run-model.js";

const ITEMS = { path: "issues", idPrefix: "issue" };
const producer = (activation: string, nodeId = "review") => ({
  nodeId,
  activation,
  port: "report",
});

describe("item ids (report §5.8)", () => {
  test("<node>[/iter-<n>][/<branch>]/<prefix>-<k>, 1-based", () => {
    expect(graphItemIds({ nodeId: "review", iteration: 1 }, "issue", 2)).toEqual([
      "review/issue-1",
      "review/issue-2",
    ]);
    expect(
      graphItemIds({ nodeId: "review", iteration: 1, branchKey: "panel.3" }, "issue", 1),
    ).toEqual(["review/panel.3/issue-1"]);
    expect(
      graphItemIds({ nodeId: "review", iteration: 2, branchKey: "panel.1+lens.api" }, "issue", 1),
    ).toEqual(["review/iter-2/panel.1+lens.api/issue-1"]);
  });

  test("ids stay within the guard's bound with a stable shortened branch", () => {
    const branchKey = `lens.${"x".repeat(90)}`;
    const owner = { nodeId: `n${"a".repeat(63)}`, iteration: 12, branchKey };
    const ids = graphItemIds(owner, "p".repeat(32), 10_000);
    for (const id of ids.slice(-1)) expect(id.length).toBeLessThanOrEqual(GRAPH_ITEM_ID_MAX_CHARS);
    expect(graphItemIdLabel(owner, "p".repeat(32), 10_000)).toBe(
      graphItemIdLabel(owner, "p".repeat(32), 10_000),
    );
    expect(
      graphItemIdLabel({ ...owner, branchKey: `${branchKey}y` }, "p".repeat(32), 10_000),
    ).not.toBe(graphItemIdLabel(owner, "p".repeat(32), 10_000));
  });

  test("an artifact's ids: recorded when they match, else derived from its producer", () => {
    const key = graphActivationKey({
      nodeId: "review",
      iteration: 1,
      branchKey: "panel.2",
      attempt: 3,
    });
    const value = { issues: [{}, {}] };
    expect(graphArtifactItemIds({ producer: producer(key) }, ITEMS, { value })).toEqual([
      "review/panel.2/issue-1",
      "review/panel.2/issue-2",
    ]);
    // The attempt is not part of the id: a retry keeps its branch's ids.
    const retried = key.replace("attempt=3", "attempt=1");
    expect(graphArtifactItemIds({ producer: producer(retried) }, ITEMS, { value })).toEqual(
      graphArtifactItemIds({ producer: producer(key) }, ITEMS, { value }),
    );
    expect(
      graphArtifactItemIds({ producer: producer(key), itemIds: ["a", "b"] }, ITEMS, { value }),
    ).toEqual(["a", "b"]);
    expect(
      graphArtifactItemIds({ producer: producer(key), itemIds: ["a"] }, ITEMS, { value }),
    ).toEqual(["review/panel.2/issue-1", "review/panel.2/issue-2"]);
    expect(graphArtifactItemIds({ producer: producer(key) }, undefined, { value })).toEqual([]);
    const input = {
      nodeId: GRAPH_RUN_INPUT_PRODUCER,
      activation: GRAPH_RUN_INPUT_PRODUCER,
      port: "ticket",
    };
    expect(
      graphArtifactItemIds(
        { producer: input },
        { path: "criteria", idPrefix: "criterion" },
        {
          value: { criteria: [{}] },
        },
      ),
    ).toEqual(["$input/ticket/criterion-1"]);
  });

  test("accept time records the same ids; nested paths and empty lists", () => {
    const owner = { nodeId: "fix", iteration: 2 };
    expect(graphAcceptedItemIds(ITEMS, { issues: [{}] }, owner)).toEqual(["fix/iter-2/issue-1"]);
    expect(graphAcceptedItemIds(ITEMS, { issues: [] }, owner)).toBeUndefined();
    expect(graphAcceptedItemIds(undefined, { issues: [{}] }, owner)).toBeUndefined();
    expect(
      graphAcceptedItemIds(
        { path: "result.rows", idPrefix: "row" },
        { result: { rows: [1, 2] } },
        owner,
      ),
    ).toEqual(["fix/iter-2/row-1", "fix/iter-2/row-2"]);
  });
});

describe("branches (report §4.4)", () => {
  test("a product never runs more than 32 branches, whatever the bindings", () => {
    const template = withPanel(baseTemplate());
    template.roles = template.roles.map((role) =>
      role.key === "panel" ? { ...role, maxPanel: 16 } : role,
    );
    template.limits = { ...template.limits, maxAgentSessions: 200, maxConcurrentAgents: 32 };
    agentOf(template, "review").replicate = {
      over: "cross",
      axes: [
        { over: "panel", role: "panel" },
        {
          over: "lenses",
          lenses: [
            { key: "a", label: "A", instruction: "A" },
            { key: "b", label: "B", instruction: "B" },
          ],
        },
      ],
    };
    const compiled = compile(template);
    expect(compiled.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const plan = compiled.plan!;
    const node = plan.nodes.find((entry) => entry.id === "review") as GraphPlanAgentNode;
    const panel = (count: number) => ({
      panel: Array.from({ length: count }, (_, index) => ({
        platform: "claude" as const,
        model: `m${index}`,
      })),
    });
    expect(graphNodeBranches(node, panel(16))).toHaveLength(32);
    expect(() => graphNodeBranches(node, panel(17))).toThrow(GraphBranchError);
  });
});
