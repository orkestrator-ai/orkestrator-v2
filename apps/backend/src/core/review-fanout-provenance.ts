/**
 * Report provenance for the reviewer fan-out (`review-fanout.ts`).
 *
 * Provider output cannot identify its own launch model, so every reviewer
 * finding is attributed by the backend, and a consolidated finding must cite
 * the source findings it merges; the backend derives its review models.
 */
import type { ReviewerModelSelection, ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import {
  stripStructuredReviewProvenance,
  type ReviewContractValidationIssue,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type { createMultiReviewConsolidationPrompt } from "./multi-review-prompts.js";

export function reviewerProvenanceLabel(
  reviewer: Pick<ReviewerModelSelection, "agent" | "model">,
): string {
  return `${reviewer.agent}/${reviewer.model}`;
}

/** Provider output cannot authoritatively identify its own launch model. */
export function attributeReportFindings(
  report: StructuredReviewReport,
  reviewer: Pick<ReviewerModelSelection, "agent" | "model">,
): StructuredReviewReport {
  const clean = stripStructuredReviewProvenance(report);
  const label = reviewerProvenanceLabel(reviewer);
  return {
    ...clean,
    issues: clean.issues.map((issue) => ({ ...issue, reviewModels: [label] })),
    testCoverageGaps: clean.testCoverageGaps.map((gap) => ({
      ...gap,
      reviewModels: [label],
    })),
  };
}

type SourceFindingKind = "issue" | "coverage-gap";

interface ProvenanceSource {
  kind: SourceFindingKind;
  model: string;
}

function sourceFindingId(
  reviewerIndex: number,
  kind: SourceFindingKind,
  findingIndex: number,
): string {
  return `reviewer-${reviewerIndex + 1}/${kind}-${findingIndex + 1}`;
}

export function consolidationReports(
  reviewers: readonly ReviewerRecord[],
): Parameters<typeof createMultiReviewConsolidationPrompt>[0]["reports"] {
  return reviewers.flatMap((reviewer, reviewerIndex) => {
    if (reviewer.status !== "completed" || !reviewer.report) return [];
    return [
      {
        reviewerId: reviewer.id,
        agent: reviewer.agent,
        model: reviewer.model,
        report: {
          ...reviewer.report,
          issues: reviewer.report.issues.map((issue, findingIndex) => ({
            ...issue,
            reviewSourceIds: [sourceFindingId(reviewerIndex, "issue", findingIndex)],
          })),
          testCoverageGaps: reviewer.report.testCoverageGaps.map((gap, findingIndex) => ({
            ...gap,
            reviewSourceIds: [sourceFindingId(reviewerIndex, "coverage-gap", findingIndex)],
          })),
        },
      },
    ];
  });
}

function provenanceSources(
  reviewers: readonly ReviewerRecord[],
): ReadonlyMap<string, ProvenanceSource> {
  const sources = new Map<string, ProvenanceSource>();
  reviewers.forEach((reviewer, reviewerIndex) => {
    if (reviewer.status !== "completed" || !reviewer.report) return;
    const model = reviewerProvenanceLabel(reviewer);
    reviewer.report.issues.forEach((_issue, findingIndex) => {
      sources.set(sourceFindingId(reviewerIndex, "issue", findingIndex), {
        kind: "issue",
        model,
      });
    });
    reviewer.report.testCoverageGaps.forEach((_gap, findingIndex) => {
      sources.set(sourceFindingId(reviewerIndex, "coverage-gap", findingIndex), {
        kind: "coverage-gap",
        model,
      });
    });
  });
  return sources;
}

export function consolidationResultContext(reviewers: readonly ReviewerRecord[]): {
  type: "consolidated-review";
  sources: Record<string, SourceFindingKind>;
} {
  return {
    type: "consolidated-review",
    sources: Object.fromEntries(
      Array.from(provenanceSources(reviewers), ([sourceId, source]) => [sourceId, source.kind]),
    ),
  };
}

export function deriveConsolidatedProvenance(
  report: StructuredReviewReport,
  reviewers: readonly ReviewerRecord[],
): { report: StructuredReviewReport; issues: ReviewContractValidationIssue[] } {
  const issues: ReviewContractValidationIssue[] = [];
  const sources = provenanceSources(reviewers);
  const inspect = (
    reviewModels: string[] | undefined,
    reviewSourceIds: string[] | undefined,
    kind: SourceFindingKind,
    path: string,
  ): string[] => {
    if (reviewModels?.length) {
      issues.push({
        path: `${path}.reviewModels`,
        code: "invalid_value",
        message: "Consolidated findings must cite source IDs; the backend derives review models.",
      });
    }
    if (!reviewSourceIds?.length) {
      issues.push({
        path: `${path}.reviewSourceIds`,
        code: "missing_field",
        message: "Every consolidated finding must cite at least one source finding ID.",
      });
      return [];
    }
    const models: string[] = [];
    reviewSourceIds.forEach((sourceId, index) => {
      const source = sources.get(sourceId);
      if (!source || source.kind !== kind) {
        issues.push({
          path: `${path}.reviewSourceIds[${index}]`,
          code: "invalid_value",
          message: `Source finding ${JSON.stringify(sourceId)} does not identify a ${kind} in the supplied reviewer reports.`,
        });
      } else if (!models.includes(source.model)) {
        models.push(source.model);
      }
    });
    return models;
  };

  const derived = stripStructuredReviewProvenance(report);
  return {
    issues,
    report: {
      ...derived,
      issues: report.issues.map((finding, index) => ({
        ...derived.issues[index]!,
        reviewModels: inspect(
          finding.reviewModels,
          finding.reviewSourceIds,
          "issue",
          `$.issues[${index}]`,
        ),
      })),
      testCoverageGaps: report.testCoverageGaps.map((finding, index) => ({
        ...derived.testCoverageGaps[index]!,
        reviewModels: inspect(
          finding.reviewModels,
          finding.reviewSourceIds,
          "coverage-gap",
          `$.testCoverageGaps[${index}]`,
        ),
      })),
    },
  };
}
