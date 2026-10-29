/**
 * Domain validators of the built-in artifact types (report §5.3).
 *
 * A built-in type names one validator id. Each id has a pure check that runs
 * anywhere (the backend at submit time, the designer, mock runs) and wraps the
 * existing protocol function for that payload, so a graph artifact passes
 * exactly when today's flows would accept it. Some ids also have checks only
 * the backend can make (a commit exists, a sealed file still hashes the same,
 * prose is not a placeholder); `backend` names them so the result-kind
 * registry (item 103) can bind them. Custom types never name a validator.
 */
import { isVerificationVerdict } from "../build-pipeline.js";
import { parseFixResult, parsePrResult } from "../review-results.js";
import {
  isReviewPackageReference,
  isSafeReviewTargetBranch,
  parseReviewValidationPlan,
} from "../review-workflow.js";
import {
  type ReviewContractValidationIssue,
  safeParseStructuredReviewFindings,
  safeParseStructuredReviewReport,
  structuredReviewReportBudgetIssues,
} from "../structured-review.js";
import { TICKET_SECTION_LIMITS } from "../ticket-sections.js";
import type { WorkflowResultValidationIssue } from "../workflow-results.js";

export const GRAPH_BUILT_IN_VALIDATOR_IDS = [
  "ticket-sections",
  "workspace-commit",
  "validation-plan",
  "review-package-reference",
  "structured-review-report",
  "review-finding",
  "verification-verdict",
  "fix-result",
  "pr-result",
  "pr-description",
  "check-summary",
  "decision-choice",
  "file-list-paths",
] as const;
export type GraphBuiltInValidatorId = (typeof GRAPH_BUILT_IN_VALIDATOR_IDS)[number];

/** What a port knows about the value beyond its type. */
export interface GraphTypeValidationContext {
  /** `decision@1`: the choices the producing port declares. */
  choices?: readonly string[];
  /** `verification-verdict@1`: the criterion IDs of the ticket being verified. */
  criterionIds?: readonly string[];
}

export type GraphTypeDomainCheck = (
  value: unknown,
  context: GraphTypeValidationContext,
) => WorkflowResultValidationIssue[];

export interface GraphBuiltInValidator {
  id: GraphBuiltInValidatorId;
  /** What it checks, for the designer and the docs. */
  summary: string;
  /** The existing protocol function the pure check wraps (`module#function`). */
  wraps: string;
  check: GraphTypeDomainCheck;
  /**
   * Checks only the backend can make. `existing` names today's function when
   * there is one; otherwise the runtime item named in `checks` builds it.
   */
  backend?: { checks: string; existing?: string };
}

const MAX_ISSUES = 32;
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
/** GitHub's limit on a pull request title. */
export const GRAPH_PR_TITLE_MAX_CHARS = 256;

function issue(path: string, code: string, message: string): WorkflowResultValidationIssue {
  return { path: path.slice(0, 256), code, message: message.slice(0, 512) };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function fromReview(
  issues: readonly ReviewContractValidationIssue[],
): WorkflowResultValidationIssue[] {
  return issues.slice(0, MAX_ISSUES).map((entry) => issue(entry.path, entry.code, entry.message));
}

/** Run a throwing parser; its message becomes one issue at the root. */
function parses(
  parse: (value: unknown) => unknown,
  value: unknown,
): WorkflowResultValidationIssue[] {
  try {
    parse(value);
    return [];
  } catch (error) {
    return [issue("$", "invalid_value", error instanceof Error ? error.message : String(error))];
  }
}

function checkTicket(value: unknown): WorkflowResultValidationIssue[] {
  if (!record(value)) return [issue("$", "invalid_type", "Expected a ticket")];
  const issues: WorkflowResultValidationIssue[] = [];
  if (blank(value.title)) issues.push(issue("$.title", "empty", "A ticket needs a title"));
  const criteria = Array.isArray(value.criteria) ? value.criteria : [];
  if (criteria.length > TICKET_SECTION_LIMITS.maxAcceptanceCriteria) {
    issues.push(
      issue(
        "$.criteria",
        "too_many_items",
        `A ticket carries at most ${TICKET_SECTION_LIMITS.maxAcceptanceCriteria} acceptance criteria`,
      ),
    );
  }
  const ids = new Set<string>();
  criteria.slice(0, TICKET_SECTION_LIMITS.maxAcceptanceCriteria).forEach((entry, index) => {
    if (!record(entry)) return;
    const path = `$.criteria[${index}]`;
    if (blank(entry.id) || (entry.id as string).length > 64) {
      issues.push(issue(`${path}.id`, "invalid_value", "A criterion id is 1 to 64 characters"));
    } else if (ids.has(entry.id as string)) {
      issues.push(issue(`${path}.id`, "duplicate", "Criterion ids must be unique"));
    } else {
      ids.add(entry.id as string);
    }
    if (blank(entry.text)) {
      issues.push(issue(`${path}.text`, "empty", "A criterion needs text"));
    } else if ((entry.text as string).length > TICKET_SECTION_LIMITS.maxCriterionLength) {
      issues.push(
        issue(
          `${path}.text`,
          "too_long",
          `A criterion is at most ${TICKET_SECTION_LIMITS.maxCriterionLength} characters`,
        ),
      );
    }
  });
  return issues.slice(0, MAX_ISSUES);
}

function checkWorkspace(value: unknown): WorkflowResultValidationIssue[] {
  if (!record(value)) return [issue("$", "invalid_type", "Expected a workspace snapshot")];
  const issues: WorkflowResultValidationIssue[] = [];
  if (!isSafeReviewTargetBranch(value.branch)) {
    issues.push(issue("$.branch", "invalid_value", "Must be a valid git branch name"));
  }
  if (typeof value.headRef !== "string" || !SHA_PATTERN.test(value.headRef)) {
    issues.push(issue("$.headRef", "invalid_value", "Must be a full lower-case commit SHA"));
  }
  if (
    value.baseRef !== null &&
    (typeof value.baseRef !== "string" || !SHA_PATTERN.test(value.baseRef))
  ) {
    issues.push(
      issue("$.baseRef", "invalid_value", "Must be a full lower-case commit SHA or null"),
    );
  }
  return issues;
}

function checkReviewReport(value: unknown): WorkflowResultValidationIssue[] {
  const parsed = safeParseStructuredReviewReport(value);
  if (!parsed.success) return fromReview(parsed.error.issues);
  return fromReview(structuredReviewReportBudgetIssues(value));
}

function checkFinding(value: unknown): WorkflowResultValidationIssue[] {
  const parsed = safeParseStructuredReviewFindings({ issues: [value], testCoverageGaps: [] });
  const rebase = (entries: WorkflowResultValidationIssue[]) =>
    entries.map((entry) => ({ ...entry, path: entry.path.replace(/^\$\.issues\[0\]/, "$") }));
  if (!parsed.success) return rebase(fromReview(parsed.error.issues));
  return rebase(fromReview(structuredReviewReportBudgetIssues({ issues: [value] })));
}

function checkVerdict(
  value: unknown,
  context: GraphTypeValidationContext,
): WorkflowResultValidationIssue[] {
  if (!isVerificationVerdict(value) || value.acceptanceCriteria === undefined) {
    return [
      issue(
        "$",
        "invalid_value",
        "Expected exactly a boolean complete field, a string rationale field and an acceptanceCriteria array",
      ),
    ];
  }
  const issues: WorkflowResultValidationIssue[] = [];
  if (blank(value.rationale)) issues.push(issue("$.rationale", "empty", "Explain the verdict"));
  const known = context.criterionIds ? new Set(context.criterionIds) : undefined;
  const seen = new Set<string>();
  value.acceptanceCriteria.forEach((entry, index) => {
    const path = `$.acceptanceCriteria[${index}].id`;
    if (seen.has(entry.id)) issues.push(issue(path, "duplicate", "Report each criterion once"));
    else if (known && !known.has(entry.id)) {
      issues.push(issue(path, "invalid_value", "Not a criterion of the ticket being verified"));
    }
    seen.add(entry.id);
    if (entry.evidence.length > TICKET_SECTION_LIMITS.maxEvidenceLength) {
      issues.push(
        issue(
          `$.acceptanceCriteria[${index}].evidence`,
          "too_long",
          `Evidence is at most ${TICKET_SECTION_LIMITS.maxEvidenceLength} characters`,
        ),
      );
    }
  });
  return issues.slice(0, MAX_ISSUES);
}

function checkPrDescription(value: unknown): WorkflowResultValidationIssue[] {
  if (!record(value)) return [issue("$", "invalid_type", "Expected a pull request description")];
  const issues: WorkflowResultValidationIssue[] = [];
  if (blank(value.title)) {
    issues.push(issue("$.title", "empty", "A pull request needs a title"));
  } else if (/[\r\n]/.test(value.title as string)) {
    issues.push(issue("$.title", "invalid_value", "A title is one line"));
  } else if ((value.title as string).length > GRAPH_PR_TITLE_MAX_CHARS) {
    issues.push(
      issue("$.title", "too_long", `A title is at most ${GRAPH_PR_TITLE_MAX_CHARS} characters`),
    );
  }
  if (blank(value.body)) issues.push(issue("$.body", "empty", "A pull request needs a body"));
  return issues;
}

function checkCheckSummary(value: unknown): WorkflowResultValidationIssue[] {
  if (!record(value) || !Array.isArray(value.failing)) {
    return [issue("$", "invalid_type", "Expected a check summary")];
  }
  const total = typeof value.total === "number" ? value.total : 0;
  const pending = typeof value.pending === "number" ? value.pending : 0;
  const failing = value.failing.length;
  const issues: WorkflowResultValidationIssue[] = [];
  if (failing + pending > total) {
    issues.push(issue("$.total", "invalid_value", "Failing and pending checks exceed the total"));
  }
  const consistent = (() => {
    switch (value.state) {
      case "none":
        return total === 0;
      case "failed":
        return failing > 0;
      case "pending":
        return failing === 0 && pending > 0;
      case "passed":
        return failing === 0 && pending === 0 && total > 0;
      default:
        return false;
    }
  })();
  if (!consistent) {
    issues.push(
      issue(
        "$.state",
        "invalid_value",
        "state must agree with the counts: none has no checks, failed lists failing checks, pending has pending checks and none failing, passed has neither",
      ),
    );
  }
  return issues;
}

function checkDecision(
  value: unknown,
  context: GraphTypeValidationContext,
): WorkflowResultValidationIssue[] {
  if (!record(value)) return [issue("$", "invalid_type", "Expected a decision")];
  const issues: WorkflowResultValidationIssue[] = [];
  if (blank(value.choice)) {
    issues.push(issue("$.choice", "empty", "A decision names its choice"));
  } else if (context.choices && !context.choices.includes(value.choice as string)) {
    issues.push(
      issue("$.choice", "invalid_enum", `Value must be one of ${context.choices.join(", ")}`),
    );
  }
  if (blank(value.rationale)) issues.push(issue("$.rationale", "empty", "Explain the decision"));
  return issues;
}

/** A normalised repository-relative path: no root, no `.`/`..`, no backslashes. */
export function isGraphRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("/") &&
    !/[\\\0]/.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function checkFileList(value: unknown): WorkflowResultValidationIssue[] {
  if (!record(value) || !Array.isArray(value.files)) {
    return [issue("$", "invalid_type", "Expected a file list")];
  }
  const issues: WorkflowResultValidationIssue[] = [];
  const seen = new Set<string>();
  value.files.forEach((entry, index) => {
    if (issues.length >= MAX_ISSUES || !record(entry)) return;
    const path = `$.files[${index}]`;
    if (!isGraphRelativePath(entry.path)) {
      issues.push(
        issue(`${path}.path`, "invalid_value", "Must be a relative path inside the worktree"),
      );
    } else if (seen.has(entry.path)) {
      issues.push(issue(`${path}.path`, "duplicate", "List each path once"));
    } else {
      seen.add(entry.path);
    }
    if (blank(entry.reason))
      issues.push(issue(`${path}.reason`, "empty", "Say why the file is listed"));
  });
  return issues.slice(0, MAX_ISSUES);
}

const PLACEHOLDER_CHECKS =
  "prose that is a placeholder or probe (workflow-result final-content checks)";
const CONTRACTS_MODULE =
  "apps/backend/src/core/workflow-result-contracts.ts#validateWorkflowResult";

const VALIDATORS: readonly GraphBuiltInValidator[] = [
  {
    id: "ticket-sections",
    summary:
      "A title; at most 100 criteria with unique ids of 1 to 64 characters and non-empty text.",
    wraps: "ticket-sections.ts#TICKET_SECTION_LIMITS",
    check: checkTicket,
  },
  {
    id: "workspace-commit",
    summary: "A valid branch name and full commit SHAs.",
    wraps: "review-workflow.ts#isSafeReviewTargetBranch",
    check: checkWorkspace,
    backend: {
      checks:
        "headRef exists in the environment's repository and is reachable from branch; baseRef, when set, is an ancestor of headRef (new in items 201/207)",
    },
  },
  {
    id: "validation-plan",
    summary:
      "At most 32 commands in dependency order, relative working directories, bounded timeouts, at most 24,000 bytes.",
    wraps: "review-validation.ts#parseReviewValidationPlan",
    check: (value) => parses(parseReviewValidationPlan, value),
    backend: {
      checks: `headRef equals the workspace HEAD being validated; ${PLACEHOLDER_CHECKS}`,
      existing: `${CONTRACTS_MODULE} (kind validation-plan)`,
    },
  },
  {
    id: "review-package-reference",
    summary: "A file reference whose path matches its id and SHA-256.",
    wraps: "review-workflow.ts#isReviewPackageReference",
    check: (value) =>
      isReviewPackageReference(value)
        ? []
        : [
            issue(
              "$",
              "invalid_value",
              "Expected a review package reference whose filePath matches its id and sha256",
            ),
          ],
    backend: {
      checks:
        "the sealed package still has its byte count and SHA-256, and its validation artifacts verify",
      existing: "apps/backend/src/core/commands-review.ts#verifyEnvironmentReviewPackage",
    },
  },
  {
    id: "structured-review-report",
    summary: "The structured review contract and its byte budgets.",
    wraps: "structured-review/validation.ts#safeParseStructuredReviewReport",
    check: checkReviewReport,
    backend: { checks: PLACEHOLDER_CHECKS, existing: `${CONTRACTS_MODULE} (kind review-report)` },
  },
  {
    id: "review-finding",
    summary: "One review issue as the report contract and its budgets accept it.",
    wraps: "structured-review/validation.ts#safeParseStructuredReviewFindings",
    check: checkFinding,
  },
  {
    id: "verification-verdict",
    summary:
      "The verdict contract with per-criterion results; ids belong to the ticket and appear once.",
    wraps: "build-pipeline.ts#isVerificationVerdict",
    check: checkVerdict,
    backend: {
      checks: PLACEHOLDER_CHECKS,
      existing: `${CONTRACTS_MODULE} (kind verification-result)`,
    },
  },
  {
    id: "fix-result",
    summary: "Complete only without failed commands or limitations; incomplete only with one.",
    wraps: "review-results.ts#parseFixResult",
    check: (value) => parses(parseFixResult, value),
    backend: { checks: PLACEHOLDER_CHECKS, existing: `${CONTRACTS_MODULE} (kind fix-result)` },
  },
  {
    id: "pr-result",
    summary: "A created pull request on github.com with a summary.",
    wraps: "review-results.ts#parsePrResult",
    check: (value) => parses(parsePrResult, value),
    backend: { checks: PLACEHOLDER_CHECKS, existing: `${CONTRACTS_MODULE} (kind pr-result)` },
  },
  {
    id: "pr-description",
    summary: `A one-line title of at most ${GRAPH_PR_TITLE_MAX_CHARS} characters and a body.`,
    wraps: "graphs/type-validators.ts (new)",
    check: checkPrDescription,
  },
  {
    id: "check-summary",
    summary: "The rolled-up state agrees with the counts and the failing checks.",
    wraps: "graphs/type-validators.ts (new)",
    check: checkCheckSummary,
  },
  {
    id: "decision-choice",
    summary: "The choice is one the producing port declares; a rationale is given.",
    wraps: "graphs/type-validators.ts (new)",
    check: checkDecision,
  },
  {
    id: "file-list-paths",
    summary: "Unique, normalised relative paths, each with a reason.",
    wraps: "graphs/type-validators.ts (new)",
    check: checkFileList,
    backend: { checks: "each path resolves inside the environment's worktree (new in item 201)" },
  },
];

const BY_ID = new Map(VALIDATORS.map((validator) => [validator.id, validator]));

export function graphBuiltInValidator(id: GraphBuiltInValidatorId): GraphBuiltInValidator {
  return BY_ID.get(id)!;
}

export function graphBuiltInValidators(): readonly GraphBuiltInValidator[] {
  return VALIDATORS;
}

export function isGraphBuiltInValidatorId(value: unknown): value is GraphBuiltInValidatorId {
  return typeof value === "string" && BY_ID.has(value as GraphBuiltInValidatorId);
}
