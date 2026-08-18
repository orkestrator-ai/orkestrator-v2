import {
  REVIEW_CHANGE_TYPES,
  REVIEW_ISSUE_CATEGORIES,
  REVIEW_OVERALL_RISKS,
  REVIEW_SEVERITIES,
  REVIEW_VERDICTS,
  type ReviewContractName,
  type ReviewFindingPool,
  type ReviewReconciliation,
  type StructuredReviewReport,
} from "./types.js";

export type ReviewContractValidationCode =
  | "invalid_type"
  | "missing_field"
  | "unknown_field"
  | "invalid_value"
  | "duplicate_id"
  | "inconsistent_value";

export interface ReviewContractValidationIssue {
  path: string;
  code: ReviewContractValidationCode;
  message: string;
}

export class ReviewContractValidationError extends Error {
  readonly contract: ReviewContractName;
  readonly issues: readonly ReviewContractValidationIssue[];

  constructor(contract: ReviewContractName, issues: readonly ReviewContractValidationIssue[]) {
    const suffix = issues.length === 1 ? "issue" : "issues";
    super(
      `Invalid ${contract}: ${issues.length} validation ${suffix}. ${
        issues[0]?.path ?? "$"
      }: ${issues[0]?.message ?? "Validation failed."}`,
    );
    this.name = "ReviewContractValidationError";
    this.contract = contract;
    this.issues = [...issues];
  }
}

export type ReviewContractParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: ReviewContractValidationError };

type JsonObject = Record<string, unknown>;
type Issues = ReviewContractValidationIssue[];
const MISSING_FIELD = Symbol("missing-review-contract-field");

const hasOwn = (object: JsonObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function addIssue(
  issues: Issues,
  path: string,
  code: ReviewContractValidationCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function readObject(
  value: unknown,
  path: string,
  issues: Issues,
  allowedKeys: readonly string[],
): JsonObject | null {
  if (value === MISSING_FIELD) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    addIssue(issues, path, "invalid_type", `Expected object, received ${describeType(value)}.`);
    return null;
  }

  const object = value as JsonObject;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      addIssue(issues, `${path}.${key}`, "unknown_field", `Unknown field "${key}".`);
    }
  }
  return object;
}

function readRequired(object: JsonObject, key: string, path: string, issues: Issues): unknown {
  if (!hasOwn(object, key)) {
    addIssue(issues, `${path}.${key}`, "missing_field", `Required field "${key}" is missing.`);
    return MISSING_FIELD;
  }
  return object[key];
}

function validateString(value: unknown, path: string, issues: Issues): boolean {
  if (value === MISSING_FIELD) return false;
  if (typeof value !== "string") {
    addIssue(issues, path, "invalid_type", `Expected string, received ${describeType(value)}.`);
    return false;
  }
  return true;
}

function validateNonEmptyString(value: unknown, path: string, issues: Issues): boolean {
  if (!validateString(value, path, issues)) return false;
  if ((value as string).length === 0) {
    addIssue(issues, path, "invalid_value", "Expected a non-empty string.");
    return false;
  }
  return true;
}

function validateInteger(
  value: unknown,
  path: string,
  issues: Issues,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): boolean {
  if (value === MISSING_FIELD) return false;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    addIssue(issues, path, "invalid_type", `Expected integer, received ${describeType(value)}.`);
    return false;
  }
  if (value < minimum || value > maximum) {
    addIssue(
      issues,
      path,
      "invalid_value",
      `Expected an integer from ${minimum} through ${maximum}, received ${value}.`,
    );
    return false;
  }
  return true;
}

function validateNullableLine(value: unknown, path: string, issues: Issues): boolean {
  return value === null || validateInteger(value, path, issues, 1);
}

function validateEnum(
  value: unknown,
  path: string,
  issues: Issues,
  allowed: readonly string[],
): boolean {
  if (!validateString(value, path, issues)) return false;
  if (!allowed.includes(value as string)) {
    addIssue(issues, path, "invalid_value", `Expected one of ${allowed.join(", ")}.`);
    return false;
  }
  return true;
}

function validateArray(
  value: unknown,
  path: string,
  issues: Issues,
  validateItem: (item: unknown, itemPath: string, issues: Issues) => void,
): value is unknown[] {
  if (value === MISSING_FIELD) return false;
  if (!Array.isArray(value)) {
    addIssue(issues, path, "invalid_type", `Expected array, received ${describeType(value)}.`);
    return false;
  }
  value.forEach((item, index) => validateItem(item, `${path}[${index}]`, issues));
  return true;
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: Issues,
  unique = false,
): value is string[] {
  if (!validateArray(value, path, issues, validateString)) return false;
  if (unique) {
    const seen = new Set<string>();
    value.forEach((item, index) => {
      if (typeof item === "string" && seen.has(item)) {
        addIssue(
          issues,
          `${path}[${index}]`,
          "invalid_value",
          `Duplicate value "${item}" is not allowed.`,
        );
      }
      if (typeof item === "string") seen.add(item);
    });
  }
  return true;
}

function validateEnumArray(
  value: unknown,
  path: string,
  issues: Issues,
  allowed: readonly string[],
): void {
  if (
    validateArray(value, path, issues, (item, itemPath, nestedIssues) => {
      validateEnum(item, itemPath, nestedIssues, allowed);
    })
  ) {
    const seen = new Set<string>();
    value.forEach((item, index) => {
      if (typeof item === "string" && seen.has(item)) {
        addIssue(
          issues,
          `${path}[${index}]`,
          "invalid_value",
          `Duplicate value "${item}" is not allowed.`,
        );
      }
      if (typeof item === "string") seen.add(item);
    });
  }
}

function validateCommit(value: unknown, path: string, issues: Issues): void {
  if (value === null) return;
  const object = readObject(value, path, issues, ["sha", "subject"]);
  if (!object) return;
  validateString(readRequired(object, "sha", path, issues), `${path}.sha`, issues);
  validateString(readRequired(object, "subject", path, issues), `${path}.subject`, issues);
}

function validateScopedFile(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, ["file", "reason"]);
  if (!object) return;
  validateString(readRequired(object, "file", path, issues), `${path}.file`, issues);
  validateString(readRequired(object, "reason", path, issues), `${path}.reason`, issues);
}

function validateCommandResult(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, ["command", "result", "summary"]);
  if (!object) return;
  validateString(readRequired(object, "command", path, issues), `${path}.command`, issues);
  validateEnum(readRequired(object, "result", path, issues), `${path}.result`, issues, [
    "passed",
    "failed",
  ]);
  validateString(readRequired(object, "summary", path, issues), `${path}.summary`, issues);
}

function validateSkippedCommand(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, ["command", "reason"]);
  if (!object) return;
  validateString(readRequired(object, "command", path, issues), `${path}.command`, issues);
  validateString(readRequired(object, "reason", path, issues), `${path}.reason`, issues);
}

function validateReviewScope(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, [
    "targetBranch",
    "baseRef",
    "commit",
    "filesReviewed",
    "filesSkipped",
    "filesLeftUncommitted",
    "commandsRun",
    "commandsNotRun",
    "limitations",
  ]);
  if (!object) return;

  validateString(
    readRequired(object, "targetBranch", path, issues),
    `${path}.targetBranch`,
    issues,
  );
  validateString(readRequired(object, "baseRef", path, issues), `${path}.baseRef`, issues);
  validateCommit(readRequired(object, "commit", path, issues), `${path}.commit`, issues);
  validateStringArray(
    readRequired(object, "filesReviewed", path, issues),
    `${path}.filesReviewed`,
    issues,
  );
  validateArray(
    readRequired(object, "filesSkipped", path, issues),
    `${path}.filesSkipped`,
    issues,
    validateScopedFile,
  );
  validateArray(
    readRequired(object, "filesLeftUncommitted", path, issues),
    `${path}.filesLeftUncommitted`,
    issues,
    validateScopedFile,
  );
  validateArray(
    readRequired(object, "commandsRun", path, issues),
    `${path}.commandsRun`,
    issues,
    validateCommandResult,
  );
  validateArray(
    readRequired(object, "commandsNotRun", path, issues),
    `${path}.commandsNotRun`,
    issues,
    validateSkippedCommand,
  );
  validateStringArray(
    readRequired(object, "limitations", path, issues),
    `${path}.limitations`,
    issues,
  );
}

function validateCodeChange(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, ["file", "line", "description"]);
  if (!object) return;
  validateString(readRequired(object, "file", path, issues), `${path}.file`, issues);
  validateNullableLine(readRequired(object, "line", path, issues), `${path}.line`, issues);
  validateString(readRequired(object, "description", path, issues), `${path}.description`, issues);
}

function validateWhatChanged(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, [
    "overview",
    "before",
    "after",
    "keyCodeChanges",
    "userImpact",
  ]);
  if (!object) return;
  for (const key of ["overview", "before", "after", "userImpact"] as const) {
    validateString(readRequired(object, key, path, issues), `${path}.${key}`, issues);
  }
  validateArray(
    readRequired(object, "keyCodeChanges", path, issues),
    `${path}.keyCodeChanges`,
    issues,
    validateCodeChange,
  );
}

function validateRiskProfile(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, [
    "changeTypes",
    "riskAreas",
    "overallRisk",
    "reasoning",
  ]);
  if (!object) return;
  validateEnumArray(
    readRequired(object, "changeTypes", path, issues),
    `${path}.changeTypes`,
    issues,
    REVIEW_CHANGE_TYPES,
  );
  validateStringArray(
    readRequired(object, "riskAreas", path, issues),
    `${path}.riskAreas`,
    issues,
    true,
  );
  validateEnum(
    readRequired(object, "overallRisk", path, issues),
    `${path}.overallRisk`,
    issues,
    REVIEW_OVERALL_RISKS,
  );
  validateString(readRequired(object, "reasoning", path, issues), `${path}.reasoning`, issues);
}

function validateTestFailure(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, ["testName", "file", "errorMessage"]);
  if (!object) return;
  for (const key of ["testName", "file", "errorMessage"] as const) {
    validateString(readRequired(object, key, path, issues), `${path}.${key}`, issues);
  }
}

function validateTestResults(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, [
    "total",
    "passed",
    "failed",
    "notRun",
    "failures",
  ]);
  if (!object) return;

  const total = readRequired(object, "total", path, issues);
  const passed = readRequired(object, "passed", path, issues);
  const failed = readRequired(object, "failed", path, issues);
  const notRun = readRequired(object, "notRun", path, issues);
  const failures = readRequired(object, "failures", path, issues);
  const validTotal = validateInteger(total, `${path}.total`, issues, 0);
  const validPassed = validateInteger(passed, `${path}.passed`, issues, 0);
  const validFailed = validateInteger(failed, `${path}.failed`, issues, 0);
  const validNotRun = validateInteger(notRun, `${path}.notRun`, issues, 0);
  const validFailures = validateArray(failures, `${path}.failures`, issues, validateTestFailure);

  if (
    validTotal &&
    validPassed &&
    validFailed &&
    validNotRun &&
    (total as number) !== (passed as number) + (failed as number) + (notRun as number)
  ) {
    addIssue(
      issues,
      `${path}.total`,
      "inconsistent_value",
      "Total must equal passed plus failed plus notRun.",
    );
  }
  if (validFailed && validFailures && (failed as number) !== (failures as unknown[]).length) {
    addIssue(
      issues,
      `${path}.failures`,
      "inconsistent_value",
      "Failure details count must equal failed.",
    );
  }
}

function validateStrength(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, ["description", "file", "line"]);
  if (!object) return;
  validateString(readRequired(object, "description", path, issues), `${path}.description`, issues);
  validateString(readRequired(object, "file", path, issues), `${path}.file`, issues);
  validateNullableLine(readRequired(object, "line", path, issues), `${path}.line`, issues);
}

function validateReviewIssue(value: unknown, path: string, issues: Issues, pooled = false): void {
  const allowedKeys = [
    "severity",
    "confidence",
    "category",
    "title",
    "file",
    "line",
    "symbol",
    "description",
    "evidence",
    "suggestion",
    "verification",
    "alternativeFixes",
    ...(pooled ? ["poolId"] : []),
  ];
  const object = readObject(value, path, issues, allowedKeys);
  if (!object) return;

  if (pooled) {
    validateNonEmptyString(readRequired(object, "poolId", path, issues), `${path}.poolId`, issues);
  }
  validateEnum(
    readRequired(object, "severity", path, issues),
    `${path}.severity`,
    issues,
    REVIEW_SEVERITIES,
  );
  validateInteger(
    readRequired(object, "confidence", path, issues),
    `${path}.confidence`,
    issues,
    0,
    100,
  );
  validateEnum(
    readRequired(object, "category", path, issues),
    `${path}.category`,
    issues,
    REVIEW_ISSUE_CATEGORIES,
  );
  for (const key of [
    "title",
    "file",
    "symbol",
    "description",
    "evidence",
    "suggestion",
    "verification",
  ] as const) {
    validateString(readRequired(object, key, path, issues), `${path}.${key}`, issues);
  }
  validateNullableLine(readRequired(object, "line", path, issues), `${path}.line`, issues);
  if (hasOwn(object, "alternativeFixes") && object.alternativeFixes !== null) {
    validateStringArray(object.alternativeFixes, `${path}.alternativeFixes`, issues);
  }
}

function validateCoverageGap(value: unknown, path: string, issues: Issues, pooled = false): void {
  const object = readObject(value, path, issues, [
    "file",
    "untestedBehavior",
    ...(pooled ? ["poolId"] : []),
  ]);
  if (!object) return;
  if (pooled) {
    validateNonEmptyString(readRequired(object, "poolId", path, issues), `${path}.poolId`, issues);
  }
  validateString(readRequired(object, "file", path, issues), `${path}.file`, issues);
  validateString(
    readRequired(object, "untestedBehavior", path, issues),
    `${path}.untestedBehavior`,
    issues,
  );
}

function validateVerdict(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, ["ready", "reasoning"]);
  if (!object) return;
  validateEnum(
    readRequired(object, "ready", path, issues),
    `${path}.ready`,
    issues,
    REVIEW_VERDICTS,
  );
  validateString(readRequired(object, "reasoning", path, issues), `${path}.reasoning`, issues);
}

function validateStructuredReviewReportValue(value: unknown, issues: Issues): void {
  const path = "$";
  const object = readObject(value, path, issues, [
    "reviewScope",
    "whatChanged",
    "riskProfile",
    "testResults",
    "strengths",
    "issues",
    "testCoverageGaps",
    "verdict",
    "summaryOfChange",
    "reviewSummary",
  ]);
  if (!object) return;

  validateReviewScope(readRequired(object, "reviewScope", path, issues), "$.reviewScope", issues);
  validateWhatChanged(readRequired(object, "whatChanged", path, issues), "$.whatChanged", issues);
  validateRiskProfile(readRequired(object, "riskProfile", path, issues), "$.riskProfile", issues);
  validateTestResults(readRequired(object, "testResults", path, issues), "$.testResults", issues);
  validateArray(
    readRequired(object, "strengths", path, issues),
    "$.strengths",
    issues,
    validateStrength,
  );
  validateArray(
    readRequired(object, "issues", path, issues),
    "$.issues",
    issues,
    validateReviewIssue,
  );
  validateArray(
    readRequired(object, "testCoverageGaps", path, issues),
    "$.testCoverageGaps",
    issues,
    validateCoverageGap,
  );
  validateVerdict(readRequired(object, "verdict", path, issues), "$.verdict", issues);
  validateString(
    readRequired(object, "summaryOfChange", path, issues),
    "$.summaryOfChange",
    issues,
  );
  validateString(readRequired(object, "reviewSummary", path, issues), "$.reviewSummary", issues);
}

function reportDuplicatePoolIds(
  entries: unknown,
  path: string,
  issues: Issues,
  seen: Map<string, string>,
): void {
  if (!Array.isArray(entries)) return;
  entries.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
    const poolId = (entry as JsonObject).poolId;
    if (typeof poolId !== "string" || poolId.length === 0) return;
    const idPath = `${path}[${index}].poolId`;
    const firstPath = seen.get(poolId);
    if (firstPath) {
      addIssue(
        issues,
        idPath,
        "duplicate_id",
        `Pool ID "${poolId}" is already used at ${firstPath}.`,
      );
    } else {
      seen.set(poolId, idPath);
    }
  });
}

function validateFindingPoolValue(value: unknown, issues: Issues): void {
  const path = "$";
  const object = readObject(value, path, issues, ["issues", "coverageGaps"]);
  if (!object) return;
  const issueEntries = readRequired(object, "issues", path, issues);
  const coverageEntries = readRequired(object, "coverageGaps", path, issues);
  validateArray(issueEntries, "$.issues", issues, (entry, entryPath, nestedIssues) => {
    validateReviewIssue(entry, entryPath, nestedIssues, true);
  });
  validateArray(coverageEntries, "$.coverageGaps", issues, (entry, entryPath, nestedIssues) => {
    validateCoverageGap(entry, entryPath, nestedIssues, true);
  });

  const seen = new Map<string, string>();
  reportDuplicatePoolIds(issueEntries, "$.issues", issues, seen);
  reportDuplicatePoolIds(coverageEntries, "$.coverageGaps", issues, seen);
}

function validateIssueUpdate(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, ["poolId", "finding"]);
  if (!object) return;
  validateNonEmptyString(readRequired(object, "poolId", path, issues), `${path}.poolId`, issues);
  validateReviewIssue(readRequired(object, "finding", path, issues), `${path}.finding`, issues);
}

function validateCoverageGapUpdate(value: unknown, path: string, issues: Issues): void {
  const object = readObject(value, path, issues, ["poolId", "finding"]);
  if (!object) return;
  validateNonEmptyString(readRequired(object, "poolId", path, issues), `${path}.poolId`, issues);
  validateCoverageGap(readRequired(object, "finding", path, issues), `${path}.finding`, issues);
}

function reportDuplicateUpdateIds(
  entries: unknown,
  path: string,
  issues: Issues,
  seen: Map<string, string>,
): void {
  if (!Array.isArray(entries)) return;
  entries.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
    const poolId = (entry as JsonObject).poolId;
    if (typeof poolId !== "string" || poolId.length === 0) return;
    const idPath = `${path}[${index}].poolId`;
    const firstPath = seen.get(poolId);
    if (firstPath) {
      addIssue(
        issues,
        idPath,
        "duplicate_id",
        `Pool ID "${poolId}" is already updated at ${firstPath}.`,
      );
    } else {
      seen.set(poolId, idPath);
    }
  });
}

function validateReconciliationValue(value: unknown, issues: Issues): void {
  const path = "$";
  const object = readObject(value, path, issues, [
    "newIssues",
    "issueUpdates",
    "newCoverageGaps",
    "coverageGapUpdates",
  ]);
  if (!object) return;
  const newIssues = readRequired(object, "newIssues", path, issues);
  const issueUpdates = readRequired(object, "issueUpdates", path, issues);
  const newCoverageGaps = readRequired(object, "newCoverageGaps", path, issues);
  const coverageGapUpdates = readRequired(object, "coverageGapUpdates", path, issues);
  validateArray(newIssues, "$.newIssues", issues, validateReviewIssue);
  validateArray(issueUpdates, "$.issueUpdates", issues, validateIssueUpdate);
  validateArray(newCoverageGaps, "$.newCoverageGaps", issues, validateCoverageGap);
  validateArray(coverageGapUpdates, "$.coverageGapUpdates", issues, validateCoverageGapUpdate);
  const seenUpdateIds = new Map<string, string>();
  reportDuplicateUpdateIds(issueUpdates, "$.issueUpdates", issues, seenUpdateIds);
  reportDuplicateUpdateIds(coverageGapUpdates, "$.coverageGapUpdates", issues, seenUpdateIds);
}

function parseContract<T>(
  contract: ReviewContractName,
  value: unknown,
  validate: (value: unknown, issues: Issues) => void,
): T {
  const issues: Issues = [];
  validate(value, issues);
  if (issues.length > 0) {
    throw new ReviewContractValidationError(contract, issues);
  }
  return normalizeOptionalAlternativeFixes(value) as T;
}

/**
 * Strict provider schemas must require every object property, so the wire
 * representation uses `null` for an omitted optional alternative-fixes list.
 * Keep the provider-independent domain contract ergonomic by removing only
 * those null sentinels after validation.
 */
function normalizeOptionalAlternativeFixes(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const normalized = value.map((entry) => {
      const next = normalizeOptionalAlternativeFixes(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  let changed = false;
  const normalized: JsonObject = {};
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    if (key === "alternativeFixes" && entry === null) {
      changed = true;
      continue;
    }
    const next = normalizeOptionalAlternativeFixes(entry);
    changed ||= next !== entry;
    normalized[key] = next;
  }
  return changed ? normalized : value;
}

/**
 * Back-fills `testResults.notRun` for reports written before the field existed.
 *
 * Structured reviews originally described tests as only passed or failed, so a
 * run with skipped tests produced a report the totals rule now rejects. This is
 * the migration for that data, and it is deliberately **opt-in**: callers that
 * read a durable, previously-written report ask for it, while a live provider
 * reply is held to the schema it was given. Silently inferring a count there
 * would fabricate a test summary instead of reporting a malfunction.
 *
 * The inference is clamped at zero and scoped to `$.testResults` by path, not
 * by object shape, so it cannot fire on some other object that happens to carry
 * the same keys. A report whose counts are genuinely inconsistent
 * (`total < passed + failed`) still fails validation afterwards.
 */
export function backfillLegacyTestResults(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const testResults = value.testResults;
  if (
    !isPlainObject(testResults) ||
    Object.hasOwn(testResults, "notRun") ||
    typeof testResults.total !== "number" ||
    typeof testResults.passed !== "number" ||
    typeof testResults.failed !== "number"
  ) {
    return value;
  }
  return {
    ...value,
    testResults: {
      ...testResults,
      notRun: Math.max(0, testResults.total - testResults.passed - testResults.failed),
    },
  };
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeParseContract<T>(
  contract: ReviewContractName,
  value: unknown,
  validate: (value: unknown, issues: Issues) => void,
): ReviewContractParseResult<T> {
  try {
    return { success: true, data: parseContract<T>(contract, value, validate) };
  } catch (error) {
    if (error instanceof ReviewContractValidationError) {
      return { success: false, error };
    }
    throw error;
  }
}

export interface StructuredReviewParseOptions {
  /**
   * Accept a report written before `testResults.notRun` existed, inferring the
   * count from the other totals. Only for durable data this app wrote earlier —
   * see {@link backfillLegacyTestResults}.
   */
  allowLegacyTestResults?: boolean;
}

function toReportCandidate(value: unknown, options?: StructuredReviewParseOptions): unknown {
  return options?.allowLegacyTestResults ? backfillLegacyTestResults(value) : value;
}

export function parseStructuredReviewReport(
  value: unknown,
  options?: StructuredReviewParseOptions,
): StructuredReviewReport {
  return parseContract(
    "structured-review-report",
    toReportCandidate(value, options),
    validateStructuredReviewReportValue,
  );
}

export function safeParseStructuredReviewReport(
  value: unknown,
  options?: StructuredReviewParseOptions,
): ReviewContractParseResult<StructuredReviewReport> {
  return safeParseContract(
    "structured-review-report",
    toReportCandidate(value, options),
    validateStructuredReviewReportValue,
  );
}

export function isStructuredReviewReport(
  value: unknown,
  options?: StructuredReviewParseOptions,
): value is StructuredReviewReport {
  return safeParseStructuredReviewReport(value, options).success;
}

export function parseReviewFindingPool(value: unknown): ReviewFindingPool {
  return parseContract("review-finding-pool", value, validateFindingPoolValue);
}

export function safeParseReviewFindingPool(
  value: unknown,
): ReviewContractParseResult<ReviewFindingPool> {
  return safeParseContract("review-finding-pool", value, validateFindingPoolValue);
}

export function isReviewFindingPool(value: unknown): value is ReviewFindingPool {
  return safeParseReviewFindingPool(value).success;
}

export function parseReviewReconciliation(value: unknown): ReviewReconciliation {
  return parseContract("review-reconciliation", value, validateReconciliationValue);
}

export function safeParseReviewReconciliation(
  value: unknown,
): ReviewContractParseResult<ReviewReconciliation> {
  return safeParseContract("review-reconciliation", value, validateReconciliationValue);
}

export function isReviewReconciliation(value: unknown): value is ReviewReconciliation {
  return safeParseReviewReconciliation(value).success;
}
