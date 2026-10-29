/**
 * Small builders shared by the built-in templates (plan P1.8). Browser-safe.
 */
import type { GraphPredicate } from "../predicate-shape.js";
import type {
  GraphEdgeSource,
  GraphEdgeSpec,
  GraphPortRef,
  GraphPortTarget,
} from "../template-model.js";

/** The revision every built-in template ships at; bump it when a built-in changes. */
export const GRAPH_BUILT_IN_TEMPLATE_REVISION = 1;

export function edge(id: string, from: GraphEdgeSource, to: GraphPortTarget): GraphEdgeSpec {
  return { id, from, to };
}

export function port(node: string, name: string, outlet?: string): GraphPortRef {
  return outlet === undefined ? { node, port: name } : { node, outlet, port: name };
}

export function target(node: string, name: string): GraphPortTarget {
  return { node, port: name };
}

/**
 * A report with issues or test coverage gaps: today's `stageAfterReview` and
 * Multi Review's auto-fix condition, over a `review-report@1` input.
 */
export function reviewReportHasFindings(input: string): GraphPredicate {
  return {
    any: [
      { path: `${input}.issues`, op: "nonEmpty" },
      { path: `${input}.testCoverageGaps`, op: "nonEmpty" },
    ],
  };
}

/** `params.<key> == true`. */
export function paramIsTrue(key: string): GraphPredicate {
  return { path: `params.${key}`, op: "eq", value: true };
}
