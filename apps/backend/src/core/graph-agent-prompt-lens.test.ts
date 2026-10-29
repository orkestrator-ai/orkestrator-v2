import { describe, expect, test } from "bun:test";
import { compile, type GraphPlanAgentNode } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import { graphAgentBranchValues } from "./graph-agent-prompt.js";
import { graphActivationFixture, graphRunFixture } from "./graph-run-test-support.js";

describe("a panel member's launch lens (item 214)", () => {
  test("reaches its branch's prompt values; members without one get none", () => {
    const plan = compile(graphTemplateExample("multi-review")).plan!;
    const node = plan.nodes.find((entry) => entry.id === "review") as GraphPlanAgentNode;
    const run = graphRunFixture({
      plan,
      template: {
        id: plan.template.id,
        revision: plan.template.revision,
        digest: plan.templateDigest,
      },
      bindings: {
        roles: {
          reviewer: [
            { platform: "claude" },
            { platform: "codex", lens: { label: "Security", instruction: "Injection first." } },
          ],
        },
        params: {},
        inputs: {},
      },
    });
    const second = graphAgentBranchValues(
      run,
      node,
      graphActivationFixture("review", { branchKey: "panel.2" }),
    );
    expect(second).toEqual({
      lens: { key: "panel-2", label: "Security", instruction: "Injection first." },
      branch: { index: 2, key: "panel.2", count: 2 },
    });
    const first = graphAgentBranchValues(
      run,
      node,
      graphActivationFixture("review", { branchKey: "panel.1" }),
    );
    expect(first).toEqual({ branch: { index: 1, key: "panel.1", count: 2 } });
  });
});
