import { describe, expect, test } from "bun:test";
import {
  REVIEW_FINDING_POOL_JSON_SCHEMA,
  REVIEW_RECONCILIATION_JSON_SCHEMA,
} from "../../structured-review.js";
import { compile } from "../compile.js";
import {
  findingPoolType,
  LOOPED_REVIEW_DEFAULT_ALLOWANCE,
  LOOPED_REVIEW_MAX_ALLOWANCE,
  LOOPED_REVIEW_MIN_ALLOWANCE,
  loopedReviewBuiltInTemplate,
  loopedReviewRoundAllowances,
  loopedReviewTemplate,
  loopedReviewTemplateStages,
  nextLoopedReviewAllowance,
  reviewReconciliationType,
} from "./looped-review.js";

describe("Looped Review built-in", () => {
  test("rounds halve the pass allowance, rounding up, down to one", () => {
    expect(nextLoopedReviewAllowance(6)).toBe(3);
    expect(nextLoopedReviewAllowance(3)).toBe(2);
    expect(nextLoopedReviewAllowance(1)).toBe(1);
    expect(loopedReviewRoundAllowances()).toEqual([6, 3, 2, 1]);
    expect(loopedReviewRoundAllowances(LOOPED_REVIEW_MAX_ALLOWANCE)).toEqual([10, 5, 3, 2, 1]);
    expect(loopedReviewRoundAllowances(LOOPED_REVIEW_MIN_ALLOWANCE)).toEqual([1]);
    for (const bad of [0, 11, 2.5, Number.NaN]) {
      expect(() => loopedReviewRoundAllowances(bad)).toThrow(RangeError);
    }
  });

  test("the built-in is the default starting allowance", () => {
    expect(LOOPED_REVIEW_DEFAULT_ALLOWANCE).toBe(6);
    expect(loopedReviewBuiltInTemplate()).toEqual(loopedReviewTemplate(6));
  });

  test("every starting allowance compiles cleanly, one bounded loop of passes per round", () => {
    for (let allowance = 1; allowance <= LOOPED_REVIEW_MAX_ALLOWANCE; allowance += 1) {
      const template = loopedReviewTemplate(allowance);
      const result = compile(template);
      expect({ allowance, diagnostics: result.diagnostics }).toEqual({
        allowance,
        diagnostics: [],
      });
      expect(result.launchable).toBe(true);
      const allowances = loopedReviewRoundAllowances(allowance);
      expect(result.plan!.loops.map((loop) => loop.maxIterations).sort()).toEqual(
        [...allowances].sort(),
      );
      expect(result.cost!.agentSessions.worst).toBe(template.limits.maxAgentSessions);
      expect(Object.keys(loopedReviewTemplateStages(allowance)).sort()).toEqual(
        template.nodes.map((node) => node.id).sort(),
      );
    }
  });

  test("its types are the review workflow's pool and reconciliation contracts", () => {
    expect(findingPoolType().schema).toEqual(REVIEW_FINDING_POOL_JSON_SCHEMA as never);
    const reconciliation = reviewReconciliationType().schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(reconciliation.required).toEqual([
      ...REVIEW_RECONCILIATION_JSON_SCHEMA.required,
      "issueOutcomes",
      "coverageGapOutcomes",
    ]);
    expect(reconciliation.properties).toMatchObject(
      REVIEW_RECONCILIATION_JSON_SCHEMA.properties as never,
    );
  });

  test("a round's discovery stops on a pass that adds or updates nothing", () => {
    const plan = compile(loopedReviewBuiltInTemplate()).plan!;
    const first = plan.loops.find((loop) => loop.id === "passes-r1")!;
    expect(first.members).toEqual(["discover-r1", "reconcile-r1"]);
    expect(first.until).toEqual({
      all: ["newIssues", "issueUpdates", "newCoverageGaps", "coverageGapUpdates"].map((field) => ({
        path: `reconcile-r1.reconciliation.${field}`,
        op: "empty",
      })),
    });
  });
});
