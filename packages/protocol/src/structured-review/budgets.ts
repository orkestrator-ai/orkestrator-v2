/**
 * Size budgets for structured review reports that feed a consolidation turn.
 *
 * The report contract checks shape and consistency, not size, and the only
 * size bound in the fan-out path used to be the 32 MiB workflow-store cap —
 * far above any model context. A 32-reviewer panel could therefore build a
 * consolidation prompt no provider could accept, and find out only from the
 * provider's context error.
 *
 * These budgets apply to reports *received from a reviewer or consolidation
 * model* in the multi-reviewer fan-out. They are deliberately not part of the
 * base contract: reports already persisted by other review features, and
 * oversized reports stored before these budgets existed, stay readable. They
 * are enforced where a new model answer is accepted, so a violation goes
 * through the existing bounded repair path.
 *
 * Enforcement is at runtime, which is authoritative. The provider JSON schema
 * is intentionally left without `maxLength`/`maxItems`: several provider
 * structured-output implementations reject or silently strip those keywords,
 * so encoding them would trade a dependable parser check for provider-specific
 * failures. The repair feedback states the limits instead.
 *
 * Every limit is measured in UTF-8 bytes, not JavaScript characters. Budget
 * feedback never quotes report content: it names the path and the numbers.
 */
import type { ReviewContractValidationIssue } from "./validation.js";

/** Encoded bytes of one accepted report. */
export const STRUCTURED_REVIEW_MAX_REPORT_BYTES = 1024 * 1024;
/** Encoded bytes of one free-form prose field (description, evidence, summary…). */
export const STRUCTURED_REVIEW_MAX_TEXT_BYTES = 16 * 1024;
/** Encoded bytes of one file path, symbol, identifier or short label. */
export const STRUCTURED_REVIEW_MAX_LABEL_BYTES = 1024;
/** Encoded bytes of one command line. */
export const STRUCTURED_REVIEW_MAX_COMMAND_BYTES = 4 * 1024;

export const STRUCTURED_REVIEW_MAX_ISSUES = 100;
export const STRUCTURED_REVIEW_MAX_COVERAGE_GAPS = 100;
export const STRUCTURED_REVIEW_MAX_STRENGTHS = 50;
/** Reviewed files may legitimately span the whole snapshot. */
export const STRUCTURED_REVIEW_MAX_FILES_REVIEWED = 10_000;
/** Any other list in the report. */
export const STRUCTURED_REVIEW_MAX_LIST_ITEMS = 500;
/** Source finding IDs one consolidated finding may cite. */
export const STRUCTURED_REVIEW_MAX_SOURCE_IDS = 256;
/** Alternative fixes listed on one issue. */
export const STRUCTURED_REVIEW_MAX_ALTERNATIVE_FIXES = 10;

/** Bounds a single issue list: at most this many budget issues are reported. */
const MAX_REPORTED_BUDGET_ISSUES = 20;

/** Paths use `[]` for any array index, e.g. `$.issues[].file`. */
const LIST_LIMITS: Readonly<Record<string, number>> = {
  "$.issues": STRUCTURED_REVIEW_MAX_ISSUES,
  "$.testCoverageGaps": STRUCTURED_REVIEW_MAX_COVERAGE_GAPS,
  "$.strengths": STRUCTURED_REVIEW_MAX_STRENGTHS,
  "$.reviewScope.filesReviewed": STRUCTURED_REVIEW_MAX_FILES_REVIEWED,
  "$.issues[].reviewSourceIds": STRUCTURED_REVIEW_MAX_SOURCE_IDS,
  "$.issues[].reviewModels": STRUCTURED_REVIEW_MAX_SOURCE_IDS,
  "$.testCoverageGaps[].reviewSourceIds": STRUCTURED_REVIEW_MAX_SOURCE_IDS,
  "$.testCoverageGaps[].reviewModels": STRUCTURED_REVIEW_MAX_SOURCE_IDS,
  "$.issues[].alternativeFixes": STRUCTURED_REVIEW_MAX_ALTERNATIVE_FIXES,
};

const LABEL_FIELDS = new Set([
  "file",
  "symbol",
  "sha",
  "targetBranch",
  "baseRef",
  "testName",
  "title",
  "subject",
]);

function textLimit(normalizedPath: string, key: string): number {
  if (key === "command") return STRUCTURED_REVIEW_MAX_COMMAND_BYTES;
  if (LABEL_FIELDS.has(key)) return STRUCTURED_REVIEW_MAX_LABEL_BYTES;
  // Bare list items: file paths, risk labels, source IDs, limitations.
  if (
    normalizedPath === "$.reviewScope.filesReviewed[]" ||
    normalizedPath.endsWith(".reviewSourceIds[]") ||
    normalizedPath.endsWith(".reviewModels[]") ||
    normalizedPath === "$.riskProfile.riskAreas[]"
  ) {
    return STRUCTURED_REVIEW_MAX_LABEL_BYTES;
  }
  return STRUCTURED_REVIEW_MAX_TEXT_BYTES;
}

export function utf8Bytes(value: string): number {
  // TextEncoder is available in every runtime this protocol package targets.
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Returns content-free budget violations for a report that already passed
 * shape validation. An empty array means the report is within budget.
 */
export function structuredReviewReportBudgetIssues(
  report: unknown,
  options: { maxIssues?: number; maxCoverageGaps?: number; preserveFindings?: boolean } = {},
): ReviewContractValidationIssue[] {
  const issues: ReviewContractValidationIssue[] = [];
  let encoded: string;
  try {
    encoded = JSON.stringify(report) ?? "";
  } catch {
    return [{ path: "$", code: "invalid_value", message: "The report is not serializable." }];
  }
  const totalBytes = utf8Bytes(encoded);
  if (totalBytes > STRUCTURED_REVIEW_MAX_REPORT_BYTES) {
    // Past the hard budget, field-level detail would only invite a partial
    // trim. Ask for a concise regeneration using numbers alone.
    return [
      {
        path: "$",
        code: "invalid_value",
        message: `The report is ${totalBytes} bytes; the limit is ${STRUCTURED_REVIEW_MAX_REPORT_BYTES}. Regenerate it concisely: keep every distinct finding, shorten prose, and quote only the minimum evidence.`,
      },
    ];
  }

  const visit = (value: unknown, path: string, normalizedPath: string, key: string): void => {
    if (issues.length >= MAX_REPORTED_BUDGET_ISSUES) return;
    if (typeof value === "string") {
      const bytes = utf8Bytes(value);
      const limit = textLimit(normalizedPath, key);
      if (bytes > limit) {
        issues.push({
          path,
          code: "invalid_value",
          message: `This text is ${bytes} bytes; the limit is ${limit}. Shorten it.`,
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      const limit =
        normalizedPath === "$.issues"
          ? (options.maxIssues ?? STRUCTURED_REVIEW_MAX_ISSUES)
          : normalizedPath === "$.testCoverageGaps"
            ? (options.maxCoverageGaps ?? STRUCTURED_REVIEW_MAX_COVERAGE_GAPS)
            : (LIST_LIMITS[normalizedPath] ?? STRUCTURED_REVIEW_MAX_LIST_ITEMS);
      if (value.length > limit) {
        issues.push({
          path,
          code: "invalid_value",
          message: options.preserveFindings
            ? `This list has ${value.length} entries; the limit is ${limit}. Keep every distinct source finding and merge only duplicates.`
            : `This list has ${value.length} entries; the limit is ${limit}. Merge or drop the least important entries.`,
        });
        return;
      }
      value.forEach((entry, index) =>
        visit(entry, `${path}[${index}]`, `${normalizedPath}[]`, key),
      );
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [childKey, child] of Object.entries(value)) {
        visit(child, `${path}.${childKey}`, `${normalizedPath}.${childKey}`, childKey);
      }
    }
  };
  visit(report, "$", "$", "");
  return issues;
}
