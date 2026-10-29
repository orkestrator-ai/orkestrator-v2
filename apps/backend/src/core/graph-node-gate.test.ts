import { describe, expect, test } from "bun:test";
import type { GraphPlanGateNode } from "@orkestrator/protocol/graphs/compile";
import { chooseGraphGateOutlet, graphGateInputRoots } from "./graph-node-gate.js";

const gate = (otherwise?: string): Pick<GraphPlanGateNode, "branches" | "otherwise"> => ({
  branches: [
    { to: "blocked", when: { path: "report.severity", op: "eq", value: "P0" } },
    { to: "minor", when: { not: { path: "report.severity", op: "eq", value: "P0" } } },
    { to: "late", when: { path: "run.iteration", op: "gt", value: 2 } },
  ],
  ...(otherwise !== undefined ? { otherwise } : {}),
});

describe("gate outlets", () => {
  test("the first branch that definitely holds wins, in order", () => {
    expect(
      chooseGraphGateOutlet(gate("rest"), {
        values: { report: { severity: "P0" } },
        run: { iteration: 3 },
      }),
    ).toEqual({ outlet: "blocked", branch: 0 });
    expect(chooseGraphGateOutlet(gate("rest"), { values: { report: { severity: "P2" } } })).toEqual(
      { outlet: "minor", branch: 1 },
    );
  });

  test("an unknown value never holds, even under `not`; then `otherwise`, or no outlet", () => {
    // `severity` is missing: both severity branches are unknown, not true.
    expect(
      chooseGraphGateOutlet(gate("rest"), { values: { report: {} }, run: { iteration: 1 } }),
    ).toEqual({ outlet: "rest", branch: null });
    expect(
      chooseGraphGateOutlet(gate("rest"), { values: { report: {} }, run: { iteration: 3 } }),
    ).toEqual({ outlet: "late", branch: 2 });
    expect(chooseGraphGateOutlet(gate(), { values: {}, run: { iteration: 1 } })).toEqual({
      outlet: null,
      branch: null,
    });
  });

  test("only the input ports the branches read are loaded", () => {
    const node = {
      ...gate("rest"),
      inputs: [
        { name: "report", type: "review-report@1" },
        { name: "code", type: "workspace@1" },
      ],
    } as unknown as GraphPlanGateNode;
    expect([...graphGateInputRoots(node)]).toEqual(["report"]);
  });
});
