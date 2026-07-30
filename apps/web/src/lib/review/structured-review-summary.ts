/**
 * The one-line summary that stands in for a collapsed structured review report.
 *
 * A pure module rather than a helper on the renderer: the transcript's find
 * index has to produce the same string the collapsed disclosure shows, and it
 * must be able to do that without importing the report renderer and everything
 * that renderer pulls in.
 */

import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** One line of substance for a report whose sections are all collapsed. */
export function structuredReviewVerdictSummary(
  report: StructuredReviewReport,
): string {
  return [
    `Ready: ${report.verdict.ready}`,
    plural(report.issues.length, "issue"),
    plural(report.testCoverageGaps.length, "coverage gap"),
    `${report.riskProfile.overallRisk} risk`,
  ].join(" · ");
}
