/**
 * The built-in templates (plan P1.8, D5): Multi Review, the Build Pipeline and
 * Looped Review, described in the template model. Each carries `engine`: it is
 * described, not run, by the graph runtime. Built-ins are read-only; the
 * designer duplicates one into a user template that runs on the graph runtime.
 *
 * Every accessor returns a fresh copy, so a caller may mutate what it gets.
 * Tests pin each template to its engine (`graph-builtin-templates.test.ts` in
 * the backend, `builtins/*.test.ts` here). Browser-safe.
 */
import type { GraphTemplateEngine, GraphTemplateV1 } from "../template-model.js";
import { BUILD_PIPELINE_TEMPLATE_STAGES, buildPipelineBuiltInTemplate } from "./build-pipeline.js";
import {
  LOOPED_REVIEW_DEFAULT_ALLOWANCE,
  loopedReviewBuiltInTemplate,
  loopedReviewTemplateStages,
} from "./looped-review.js";
import { MULTI_REVIEW_TEMPLATE_STAGES, multiReviewBuiltInTemplate } from "./multi-review.js";

export * from "./build-pipeline.js";
export * from "./looped-review.js";
export * from "./multi-review.js";
export { GRAPH_BUILT_IN_TEMPLATE_REVISION } from "./support.js";

export const GRAPH_BUILT_IN_TEMPLATE_IDS = [
  "multi-review",
  "build-pipeline",
  "looped-review",
] as const satisfies readonly GraphTemplateEngine[];
export type GraphBuiltInTemplateId = (typeof GRAPH_BUILT_IN_TEMPLATE_IDS)[number];

/**
 * `active`: the engine runs the flow today. `retired`: the engine was removed
 * (Looped Review, 2026-10-29); the template records how the flow ran and can
 * only be duplicated onto the graph runtime.
 */
export type GraphBuiltInEngineStatus = "active" | "retired";

export interface GraphBuiltInTemplate {
  id: GraphBuiltInTemplateId;
  engine: GraphTemplateEngine;
  engineStatus: GraphBuiltInEngineStatus;
  template: GraphTemplateV1;
  /**
   * The engine stage each node describes, by node id (gates name the engine
   * decision they stand for). The run view and the pinning tests read it.
   */
  stages: Readonly<Record<string, string>>;
}

const BUILDERS: Record<GraphBuiltInTemplateId, () => Omit<GraphBuiltInTemplate, "id" | "engine">> =
  {
    "multi-review": () => ({
      engineStatus: "active",
      template: multiReviewBuiltInTemplate(),
      stages: MULTI_REVIEW_TEMPLATE_STAGES,
    }),
    "build-pipeline": () => ({
      engineStatus: "active",
      template: buildPipelineBuiltInTemplate(),
      stages: BUILD_PIPELINE_TEMPLATE_STAGES,
    }),
    "looped-review": () => ({
      engineStatus: "retired",
      template: loopedReviewBuiltInTemplate(),
      stages: loopedReviewTemplateStages(LOOPED_REVIEW_DEFAULT_ALLOWANCE),
    }),
  };

export function isGraphBuiltInTemplateId(value: unknown): value is GraphBuiltInTemplateId {
  return (
    typeof value === "string" && (GRAPH_BUILT_IN_TEMPLATE_IDS as readonly string[]).includes(value)
  );
}

/** One built-in template, or undefined for an unknown id. */
export function graphBuiltInTemplate(id: string): GraphBuiltInTemplate | undefined {
  if (!isGraphBuiltInTemplateId(id)) return undefined;
  return { id, engine: id, ...BUILDERS[id]() };
}

/** Every built-in template, in `GRAPH_BUILT_IN_TEMPLATE_IDS` order. */
export function graphBuiltInTemplates(): GraphBuiltInTemplate[] {
  return GRAPH_BUILT_IN_TEMPLATE_IDS.map((id) => graphBuiltInTemplate(id)!);
}
