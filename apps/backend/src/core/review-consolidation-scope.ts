/**
 * The scope lists of a consolidated review, merged by the backend.
 *
 * A consolidation model used to retype every reviewer's reviewed files and
 * validation commands into its report. Those lists are a mechanical union of
 * the reviewer reports, yet they made up about a sixth of a 20–40 KB
 * submission, and a submission that size is where a model's tool-call JSON
 * most often fails to parse (52 of 185 Haiku consolidations on one host in a
 * week, every failure above 15 KB). So when a consolidation runs over the
 * result tool, the slot carries the merged lists in its context, the tool's
 * schema makes them optional, and the backend fills them in before it validates
 * and stores the report. Every consumer still reads a complete
 * `StructuredReviewReport`.
 *
 * Judgement about the scope stays with the model: `targetBranch`, `baseRef`,
 * `commit`, `limitations`, `outcome` and `blockedReason`, and with them the
 * rule that a reviewer who saw a narrower snapshot is recorded as a
 * limitation. The lists below only say what the reviewers looked at and ran;
 * nothing downstream decides on them.
 */
import {
  STRUCTURED_REVIEW_MAX_FILES_REVIEWED,
  STRUCTURED_REVIEW_MAX_LIST_ITEMS,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  utf8Bytes,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import type {
  ConsolidationScopeLists,
  WorkflowResultValidationIssue,
} from "@orkestrator/protocol/workflow-results";
import { inspectFinalText } from "./workflow-result-final-text.js";

/** The `reviewScope` fields the backend fills in, in schema order. */
export const CONSOLIDATION_SCOPE_LIST_FIELDS = [
  "filesReviewed",
  "filesSkipped",
  "filesLeftUncommitted",
  "commandsRun",
  "commandsNotRun",
] as const satisfies readonly (keyof ConsolidationScopeLists)[];

const LIST_LIMITS: Readonly<Record<keyof ConsolidationScopeLists, number>> = {
  filesReviewed: STRUCTURED_REVIEW_MAX_FILES_REVIEWED,
  filesSkipped: STRUCTURED_REVIEW_MAX_LIST_ITEMS,
  filesLeftUncommitted: STRUCTURED_REVIEW_MAX_LIST_ITEMS,
  commandsRun: STRUCTURED_REVIEW_MAX_LIST_ITEMS,
  commandsNotRun: STRUCTURED_REVIEW_MAX_LIST_ITEMS,
};

/**
 * The most the merged lists may take in a slot's context. A merge that does
 * not fit is not offered (`consolidationScopeLists`), and the model writes the
 * full report as before, so the stored context and the filled-in report stay
 * bounded. The lists on one host averaged about 3.5 KB.
 */
export const CONSOLIDATION_SCOPE_MAX_BYTES = 32 * 1024;

/** First occurrence of each key wins; order is the reviewers' order. */
function uniqueBy<T>(items: Iterable<T>, key: (item: T) => string, limit: number): T[] | undefined {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    if (kept.length === limit) return undefined;
    seen.add(id);
    kept.push(item);
  }
  return kept;
}

/**
 * The union of the reviewers' scope lists, deterministic in the reviewers'
 * order. An overflowing list makes the union unavailable for automatic completion.
 *
 * - A file one reviewer skipped and another reviewed counts as reviewed.
 * - A command one reviewer ran is not also listed as not run.
 * - The same command run with the same outcome is listed once, with the first
 *   reviewer's summary; one that passed for one reviewer and failed for
 *   another is listed twice, so the disagreement stays visible.
 */
export function mergeConsolidationScopeLists(
  reports: readonly Pick<StructuredReviewReport, "reviewScope">[],
): ConsolidationScopeLists | undefined {
  const scopes = reports.map((report) => report.reviewScope);
  const filesReviewed = uniqueBy(
    scopes.flatMap((scope) => scope.filesReviewed),
    (file) => file,
    LIST_LIMITS.filesReviewed,
  );
  if (!filesReviewed) return undefined;
  const reviewed = new Set(filesReviewed);
  const commandsRun = uniqueBy(
    scopes.flatMap((scope) => scope.commandsRun),
    (command) => JSON.stringify([command.command, command.result]),
    LIST_LIMITS.commandsRun,
  );
  if (!commandsRun) return undefined;
  const ran = new Set(commandsRun.map((entry) => entry.command));
  const filesSkipped = uniqueBy(
    scopes.flatMap((scope) => scope.filesSkipped).filter((entry) => !reviewed.has(entry.file)),
    (entry) => entry.file,
    LIST_LIMITS.filesSkipped,
  );
  const filesLeftUncommitted = uniqueBy(
    scopes.flatMap((scope) => scope.filesLeftUncommitted),
    (entry) => entry.file,
    LIST_LIMITS.filesLeftUncommitted,
  );
  const commandsNotRun = uniqueBy(
    scopes.flatMap((scope) => scope.commandsNotRun).filter((entry) => !ran.has(entry.command)),
    (entry) => entry.command,
    LIST_LIMITS.commandsNotRun,
  );
  if (!filesSkipped || !filesLeftUncommitted || !commandsNotRun) return undefined;
  return { filesReviewed, filesSkipped, filesLeftUncommitted, commandsRun, commandsNotRun };
}

/**
 * A complete union that fits the slot and passes the result tool's scope checks.
 */
export function consolidationScopeLists(
  reports: readonly Pick<StructuredReviewReport, "reviewScope">[],
): ConsolidationScopeLists | undefined {
  const scope = mergeConsolidationScopeLists(reports);
  if (!scope || utf8Bytes(JSON.stringify(scope)) > CONSOLIDATION_SCOPE_MAX_BYTES) return undefined;
  const issues: WorkflowResultValidationIssue[] = [];
  inspectScopeListText(issues, scope);
  return issues.length === 0 ? scope : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, limit: number): boolean {
  return Array.isArray(value) && value.length <= limit && value.every((v) => typeof v === "string");
}

function entries(value: unknown, limit: number, keys: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every(
      (entry) =>
        record(entry) &&
        Object.keys(entry).length === keys.length &&
        keys.every((key) => typeof entry[key] === "string"),
    )
  );
}

/** Whether a stored slot context's `scope` has the shape and bounds above. */
export function isConsolidationScopeLists(value: unknown): value is ConsolidationScopeLists {
  if (!record(value)) return false;
  if (Object.keys(value).length !== CONSOLIDATION_SCOPE_LIST_FIELDS.length) return false;
  const commandsRunValid =
    entries(value.commandsRun, LIST_LIMITS.commandsRun, ["command", "result", "summary"]) &&
    (value.commandsRun as { result: string }[]).every(
      (entry) => entry.result === "passed" || entry.result === "failed",
    );
  return (
    utf8Bytes(JSON.stringify(value)) <= CONSOLIDATION_SCOPE_MAX_BYTES &&
    strings(value.filesReviewed, LIST_LIMITS.filesReviewed) &&
    entries(value.filesSkipped, LIST_LIMITS.filesSkipped, ["file", "reason"]) &&
    entries(value.filesLeftUncommitted, LIST_LIMITS.filesLeftUncommitted, ["file", "reason"]) &&
    commandsRunValid &&
    entries(value.commandsNotRun, LIST_LIMITS.commandsNotRun, ["command", "reason"])
  );
}

/** Checks the inherited scope text with the same rules as the final result. */
export function inspectScopeListText(
  issues: WorkflowResultValidationIssue[],
  reviewScope: Record<string, unknown>,
): void {
  for (const field of ["filesSkipped", "filesLeftUncommitted", "commandsNotRun"]) {
    if (!Array.isArray(reviewScope[field])) continue;
    reviewScope[field].forEach((entry, index) => {
      if (record(entry))
        inspectFinalText(issues, entry.reason, `$.reviewScope.${field}[${index}].reason`);
    });
  }
  if (Array.isArray(reviewScope.commandsRun)) {
    reviewScope.commandsRun.forEach((entry, index) => {
      if (record(entry))
        inspectFinalText(issues, entry.summary, `$.reviewScope.commandsRun[${index}].summary`);
    });
  }
}

/** The optional lists also allow full reports from prompts saved before the upgrade. */
function reportSchemaWithOptionalLists(note: string) {
  const full = STRUCTURED_REVIEW_REPORT_JSON_SCHEMA;
  const filled = new Set<string>(CONSOLIDATION_SCOPE_LIST_FIELDS);
  const scope = full.properties.reviewScope;
  return {
    ...full,
    properties: {
      ...full.properties,
      reviewScope: {
        ...scope,
        description: `${scope.description} ${note}`,
        required: scope.required.filter((key) => !filled.has(key)),
      },
    },
  } satisfies JsonSchema;
}

export const CONSOLIDATED_REVIEW_SUBMISSION_JSON_SCHEMA = reportSchemaWithOptionalLists(
  `The backend fills in ${CONSOLIDATION_SCOPE_LIST_FIELDS.join(", ")} from the reviewer reports. Omit them from new submissions.`,
);

/**
 * The OpenCode broker publishes one tool per kind. The service still requires
 * the lists if the slot has no merged scope.
 */
export const CONSOLIDATED_REVIEW_ANY_SLOT_JSON_SCHEMA = reportSchemaWithOptionalLists(
  `When your instructions say the backend fills in ${CONSOLIDATION_SCOPE_LIST_FIELDS.join(", ")}, leave them out; otherwise send them.`,
);

/**
 * The submitted report with the merged lists in `reviewScope`. The backend's
 * lists replace any the model sent, so filling in twice gives the same report.
 * A value without a `reviewScope` object is returned as it is, for validation
 * to report.
 */
export function completeConsolidatedReview(
  value: unknown,
  scope: ConsolidationScopeLists,
): unknown {
  if (!record(value) || !record(value.reviewScope)) return value;
  const reviewScope: Record<string, unknown> = Object.create(null);
  const filled = new Set<string>(CONSOLIDATION_SCOPE_LIST_FIELDS);
  // Rebuilt in schema order, so a stored report reads the same as one the
  // model wrote in full.
  for (const key of STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.properties.reviewScope.required) {
    if (filled.has(key)) reviewScope[key] = scope[key as keyof ConsolidationScopeLists];
    else if (Object.hasOwn(value.reviewScope, key)) reviewScope[key] = value.reviewScope[key];
  }
  for (const [key, entry] of Object.entries(value.reviewScope)) {
    if (!Object.hasOwn(reviewScope, key)) reviewScope[key] = entry;
  }
  return { ...value, reviewScope };
}
