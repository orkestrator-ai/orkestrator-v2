import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  parseStructuredReviewReport,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";

export function structuredReviewHasFindings(report: StructuredReviewReport): boolean {
  return report.issues.length > 0 || report.testCoverageGaps.length > 0;
}

/**
 * Provider completion events and their durable structured payload can arrive a
 * few frames apart. Poll the authoritative result briefly; never inspect or
 * parse nearby transcript text.
 */
export async function readValidatedBuildReview(
  load: () => Promise<StructuredOutputResult<unknown> | null>,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<StructuredReviewReport> {
  const attempts = options.attempts ?? 12;
  const intervalMs = options.intervalMs ?? 150;
  for (let index = 0; index < attempts; index += 1) {
    const result = await load();
    if (result) {
      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      return parseStructuredReviewReport(result.value);
    }
    if (index + 1 < attempts) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, intervalMs));
    }
  }
  throw new Error("The review session completed without a structured review result.");
}
