import { describe, expect, test } from "bun:test";
import {
  isBuildStepConfigs,
  MAX_BUILD_PIPELINE_ITERATIONS,
  MAX_BUILD_PIPELINE_REVIEWERS,
  stepKeyForSessionPhase,
  VERIFICATION_VERDICT_SCHEMA,
} from "../../build-pipeline.js";
import { compile, type GraphPlanAgentNode } from "../compile.js";
import { GRAPH_TEMPLATE_BOUNDS } from "../grammar.js";
import {
  BUILD_PIPELINE_TEMPLATE_ROUNDS,
  buildPipelineBuiltInTemplate,
  criterionResultType,
} from "./build-pipeline.js";

// The engine-side pins (stage table, routing, turns, role defaults) are in
// the backend's graph-builtin-templates.test.ts.
describe("Build Pipeline built-in ↔ the protocol's pipeline contract", () => {
  const template = buildPipelineBuiltInTemplate();
  const plan = compile(template).plan!;
  const agent = (id: string) => plan.nodes.find((node) => node.id === id) as GraphPlanAgentNode;

  test("rounds: today's default, within the protocol's iteration limit", () => {
    const [rounds] = template.loops!;
    expect(rounds!.maxIterations).toBe(BUILD_PIPELINE_TEMPLATE_ROUNDS);
    expect(rounds!.maxIterations).toBeLessThanOrEqual(MAX_BUILD_PIPELINE_ITERATIONS);
    // A duplicate can raise the bound only as far as the engine allows.
    expect(GRAPH_TEMPLATE_BOUNDS.maxLoopIterations).toBe(MAX_BUILD_PIPELINE_ITERATIONS);
  });

  test("the review panel is today's, 1 to 32 reviewers", () => {
    const reviewer = template.roles.find((role) => role.key === "reviewer")!;
    expect(reviewer.maxPanel).toBe(MAX_BUILD_PIPELINE_REVIEWERS);
    expect(agent("review").fanOut).toEqual({ min: 1, max: MAX_BUILD_PIPELINE_REVIEWERS });
  });

  test("Fix runs under Build's step, so it shares Build's role", () => {
    expect(stepKeyForSessionPhase("fix")).toBe("build");
    expect(agent("fix").role).toBe(agent("build").role);
  });

  test("per-stage instructions and a reviewer focus are launch settings of a step", () => {
    // They are bound with each role's model at launch, not written into the
    // template: the built-in prompts render them after each stage's contract.
    expect(
      isBuildStepConfigs({
        build: { agent: "claude", instructions: "Prefer small commits." },
        review: {
          agent: "codex",
          lens: { label: "Security", instruction: "Look for injection." },
          instructions: "Focus on the API.",
        },
      }),
    ).toBe(true);
  });

  test("the ship gate reads the verdict's criteria in their own shape", () => {
    const verdict = VERIFICATION_VERDICT_SCHEMA as {
      properties: { acceptanceCriteria: { items: unknown } };
    };
    expect(criterionResultType().schema).toEqual(
      verdict.properties.acceptanceCriteria.items as never,
    );
  });

  test("worst case: Build, three full rounds of a 32-reviewer panel, Ship and conflicts", () => {
    const perRound = 1 + 1 + MAX_BUILD_PIPELINE_REVIEWERS + 1 + 1 + 1;
    expect(compile(template).cost!.agentSessions.worst).toBe(
      1 + perRound * BUILD_PIPELINE_TEMPLATE_ROUNDS + 2,
    );
    expect(template.limits.maxAgentSessions).toBe(
      1 + perRound * BUILD_PIPELINE_TEMPLATE_ROUNDS + 2,
    );
  });
});
