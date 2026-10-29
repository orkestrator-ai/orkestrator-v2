/**
 * Multi Review's consolidation contract as a provenance plan (report §5.9):
 * every merged issue and coverage gap cites at least one source finding of
 * its own class, and leaves `reviewModels` to the backend. The bespoke
 * consolidation step (`workflow-result-contracts.ts`) and a graph node whose
 * prompt is the consolidation built-in (`workflow-result-graph-output.ts`,
 * item 301) both check it, with the wording the consolidator has always seen.
 */
import type {
  GraphProvenanceField,
  GraphProvenancePlan,
  GraphProvenanceWording,
} from "@orkestrator/protocol/graphs/provenance";

export const REVIEW_CONSOLIDATION_PROVENANCE: GraphProvenancePlan = Object.freeze({
  mode: "cite",
  fields: [
    {
      segments: ["issues", "[]", "reviewSourceIds"],
      sourceClass: "issue",
      minCitations: 1,
      derivedFields: ["reviewModels"],
    },
    {
      segments: ["testCoverageGaps", "[]", "reviewSourceIds"],
      sourceClass: "coverage-gap",
      minCitations: 1,
      derivedFields: ["reviewModels"],
    },
  ],
}) as GraphProvenancePlan;

export const REVIEW_CONSOLIDATION_WORDING: GraphProvenanceWording = Object.freeze({
  item: "consolidated finding",
  sourceItem: "source finding",
  inputs: "the supplied reviewer reports",
  derived: Object.freeze({
    reviewModels: "Cite source IDs; the backend derives contributing review models.",
  }),
});

/** A copy of the contract's fields, for a plan of another mode. */
export function reviewConsolidationProvenanceFields(): GraphProvenanceField[] {
  return REVIEW_CONSOLIDATION_PROVENANCE.fields.map((field) => structuredClone(field));
}

/** Whether a plan carries exactly the contract's fields (any mode). */
export function isReviewConsolidationProvenance(
  plan: Pick<GraphProvenancePlan, "fields">,
): boolean {
  return JSON.stringify(plan.fields) === JSON.stringify(REVIEW_CONSOLIDATION_PROVENANCE.fields);
}
