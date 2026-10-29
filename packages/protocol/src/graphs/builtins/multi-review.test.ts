import { describe, expect, test } from "bun:test";
import { resolveMultiReviewSettings } from "../../agent-settings.js";
import { MULTI_REVIEW_MAX_REVIEWERS } from "../../multi-review.js";
import { multiReviewWorkEstimate } from "../../multi-review-launch.js";
import {
  isReviewerModelSelection,
  isReviewStepModelSelection,
  REVIEW_FANOUT_MAX_REVIEWERS,
} from "../../review-fanout.js";
import { compile, type GraphPlanAgentNode } from "../compile.js";
import { GRAPH_TEMPLATE_BOUNDS } from "../grammar.js";
import { MULTI_REVIEW_TEMPLATE_STAGES, multiReviewBuiltInTemplate } from "./multi-review.js";

// The engine-side pins (steps, routing, turns, role defaults) are in the
// backend's graph-builtin-templates.test.ts.
describe("Multi Review built-in ↔ the protocol's Multi Review contract", () => {
  const template = multiReviewBuiltInTemplate();
  const plan = compile(template).plan!;

  test("the panel is today's reviewer panel, 1 to 32", () => {
    const reviewer = template.roles.find((role) => role.key === "reviewer")!;
    expect(reviewer.maxPanel).toBe(MULTI_REVIEW_MAX_REVIEWERS);
    expect(MULTI_REVIEW_MAX_REVIEWERS).toBe(REVIEW_FANOUT_MAX_REVIEWERS);
    expect(GRAPH_TEMPLATE_BOUNDS.maxBranches).toBe(REVIEW_FANOUT_MAX_REVIEWERS);
    const review = plan.nodes.find((node) => node.id === "review") as GraphPlanAgentNode;
    expect(review.fanOut).toEqual({ min: 1, max: MULTI_REVIEW_MAX_REVIEWERS });
  });

  test("auto-fix and auto-PR default to the saved settings' defaults", () => {
    const saved = resolveMultiReviewSettings({});
    const defaults = Object.fromEntries(
      template.parameters.map((parameter) => [parameter.key, parameter.default]),
    );
    expect(defaults).toEqual({ autoFix: saved.autoFix, autoPr: saved.autoPr });
  });

  test("the worst case runs the turns the launcher's work estimate counts", () => {
    const estimate = multiReviewWorkEstimate({
      reviewerCount: MULTI_REVIEW_MAX_REVIEWERS,
      autoFix: true,
      autoPr: true,
    });
    const turns =
      estimate.preparationTurns +
      estimate.reviewerTurns +
      estimate.consolidationTurns +
      estimate.fixTurns +
      estimate.prTurns;
    expect(compile(template).cost!.agentSessions.worst).toBe(turns);
    expect(template.limits.maxAgentSessions).toBe(turns);
  });

  test("a lens belongs to a reviewer position, chosen with its model", () => {
    const lens = { label: "Security", instruction: "Look for injection." };
    expect(isReviewerModelSelection({ agent: "claude", model: "opus", lens })).toBe(true);
    expect(isReviewStepModelSelection({ agent: "claude", model: "opus", lens })).toBe(false);
    // So the template replicates over the panel, not over a fixed lens list.
    const review = template.nodes.find((node) => node.id === "review");
    expect(review).toMatchObject({ replicate: { over: "panel", role: "reviewer" } });
  });

  test("each stage is described by the nodes the stage map names", () => {
    expect(new Set(Object.values(MULTI_REVIEW_TEMPLATE_STAGES))).toEqual(
      new Set([
        "prepare",
        "validation",
        "reviewer",
        "consolidate",
        "after-consolidation",
        "fix",
        "after-fix",
        "pr",
      ]),
    );
  });
});
