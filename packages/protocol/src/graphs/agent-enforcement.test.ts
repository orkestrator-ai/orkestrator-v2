import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "../native-agent.js";
import {
  GRAPH_RESEARCHER_ON_CLAUDE_REASON,
  graphActivationEnforcementView,
  graphAgentFloorMessage,
  graphAgentNodeEnforcement,
  graphBindingFloorProblems,
  graphRoleProviderChoices,
} from "./agent-enforcement.js";
import { compileGraphCapabilities } from "./capability-profiles.js";
import { compile } from "./compile.js";
import { graphTemplateExample } from "./examples.js";
import type { CompiledGraphPlan } from "./plan.js";

const environment: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};
const sandboxed = { claudeSandbox: true };
const unsandboxed = { claudeSandbox: false, claudeSandboxReason: "No bubblewrap here." };

function multiReviewPlan(): CompiledGraphPlan {
  const result = compile(graphTemplateExample("multi-review"));
  if (!result.plan) throw new Error("the example must compile");
  return result.plan;
}

describe("graphAgentNodeEnforcement", () => {
  test("a reviewer is a read-only turn, enforced on sandboxed Claude and configured without it", () => {
    const reviewer = compileGraphCapabilities({ spec: { profile: "reviewer" }, environment });
    expect(graphAgentNodeEnforcement(reviewer, "claude", sandboxed)).toEqual({
      tier: "enforced",
      turnMode: "read-only",
    });
    const dropped = graphAgentNodeEnforcement(reviewer, "claude", unsandboxed);
    expect(dropped.tier).toBe("provider-configured");
    expect(dropped.reason).toContain("No bubblewrap here.");
  });

  test("a researcher on Claude runs as an ordinary turn, at most provider-configured", () => {
    const researcher = compileGraphCapabilities({ spec: { profile: "researcher" }, environment });
    expect(graphAgentNodeEnforcement(researcher, "claude", sandboxed)).toEqual({
      tier: "provider-configured",
      reason: GRAPH_RESEARCHER_ON_CLAUDE_REASON,
      turnMode: "build",
    });
    expect(graphAgentNodeEnforcement(researcher, "codex", sandboxed).turnMode).toBe("read-only");
  });

  test("the floor message names the provider, tier, floor and reason", () => {
    const node = { id: "review", minEnforcement: "enforced" as const };
    expect(graphAgentFloorMessage(node, "claude", { tier: "enforced" })).toBeNull();
    expect(graphAgentFloorMessage({ id: "review" }, "grok", { tier: "advisory" })).toBeNull();
    expect(
      graphAgentFloorMessage(node, "claude", { tier: "provider-configured", reason: "Why." }),
    ).toBe(
      "Claude Code holds step review only at provider-configured on this host, below the step's floor (enforced), so it was not started. Why.",
    );
  });
});

describe("graphRoleProviderChoices", () => {
  test("filters each role's providers by its nodes' floors", () => {
    const plan = multiReviewPlan();
    const choices = graphRoleProviderChoices(plan, sandboxed, ["claude", "opencode", "grok"]);
    const reviewer = choices.find((entry) => entry.role === "reviewer")!;
    expect(reviewer.nodes).toEqual(["review"]);
    expect(reviewer.floor).toBe("provider-configured");
    expect(
      reviewer.choices.map((choice) => [choice.platform, choice.tier, choice.allowed]),
    ).toEqual([
      ["claude", "enforced", true],
      ["opencode", "provider-configured", true],
      ["grok", "advisory", false],
    ]);
    expect(reviewer.choices[2]?.blockedBy).toEqual({
      nodeId: "review",
      tier: "advisory",
      floor: "provider-configured",
    });
    // A builder role has no floor: every provider is offered.
    const fixer = choices.find((entry) => entry.role === "fixer")!;
    expect(fixer.floor).toBeUndefined();
    expect(fixer.choices.every((choice) => choice.allowed)).toBe(true);
  });
});

describe("graphBindingFloorProblems", () => {
  test("names every bound model below a floor, panel members included", () => {
    const plan = multiReviewPlan();
    const roles = {
      preparer: { platform: "claude" as const },
      reviewer: [{ platform: "claude" as const }, { platform: "grok" as const }],
      consolidator: { platform: "claude" as const },
      fixer: { platform: "grok" as const },
      describer: { platform: "claude" as const },
    };
    const problems = graphBindingFloorProblems(plan, roles, sandboxed);
    expect(problems.map((problem) => [problem.role, problem.nodeId, problem.platform])).toEqual([
      ["reviewer", "review", "grok"],
    ]);
    expect(problems[0]?.message).toContain("below the step's floor (provider-configured)");
    expect(graphBindingFloorProblems(plan, { ...roles, reviewer: [] }, sandboxed)).toEqual([]);
  });
});

describe("graphActivationEnforcementView", () => {
  test("labels the guard results and says whether a guard failed the activation", () => {
    const at = "2026-10-29T00:00:00.000Z";
    const view = graphActivationEnforcementView({
      enforcement: "provider-configured",
      enforcementReason: "Why.",
      guards: [
        { guard: "enforcement", outcome: "passed", at },
        { guard: "remote-ref", outcome: "violated", at, detail: "pushed" },
      ],
      errorCause: "guard-violation",
    });
    expect(view).toMatchObject({
      tier: "provider-configured",
      reason: "Why.",
      failedOnGuard: true,
    });
    expect(view.guards.map((entry) => entry.label)).toEqual(["Enforcement floor", "No pushes"]);
    expect(graphActivationEnforcementView({}).guards).toEqual([]);
  });
});
