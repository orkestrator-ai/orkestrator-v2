import {
  VERIFICATION_VERDICT_SCHEMA,
  isLegacyVerificationVerdict,
  isVerificationVerdict,
} from "@orkestrator/protocol/build-pipeline";
import {
  parseFeaturePlannerStateValue,
  parseStoryRefinementValue,
} from "@orkestrator/protocol/feature-planning";
import { parseReviewValidationPlan } from "@orkestrator/protocol/review-workflow";
import {
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  safeParseStructuredReviewReport,
  type ReviewContractValidationIssue,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import {
  type GraphProvenancePlan,
  type GraphProvenanceWording,
  validateGraphProvenance,
} from "@orkestrator/protocol/graphs/provenance";
import { validateWorkflowJsonSchema } from "@orkestrator/protocol/workflow-json-schema";
import {
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultToolName,
  type WorkflowResultKind,
  type WorkflowResultSlotInput,
  type WorkflowResultValidationIssue,
} from "@orkestrator/protocol/workflow-results";
import {
  REVIEW_RECONCILIATION_RESULT_JSON_SCHEMA,
  REVIEW_FIX_RESULT_JSON_SCHEMA,
  REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
  REVIEW_PR_RESULT_JSON_SCHEMA,
  parseFixResult,
  parsePrResult,
  parseReviewPreparationResult,
} from "./review-prompts.js";
import { REVIEW_VALIDATION_PLAN_SCHEMA } from "./review-validation-prompts.js";
import { graphOutputKindDefinition } from "./workflow-result-graph-output.js";
import {
  WORKFLOW_RESULT_MAX_ISSUES,
  registerWorkflowResultKind,
  registeredWorkflowResultKinds,
  validateRegisteredWorkflowResult,
  workflowResultKindDefinition,
  type WorkflowResultKindDefinition,
  type WorkflowResultSlotView,
} from "./workflow-result-registry.js";

const MAX_ISSUES = WORKFLOW_RESULT_MAX_ISSUES;
const PLACEHOLDER_VALUES = new Set([
  "asdf",
  "dummy",
  "lorem ipsum",
  "placeholder",
  "probe",
  "sample",
  "tbd",
  "test",
  "testing",
  "todo",
  // Filler a model uses to shrink a payload until a call goes through.
  "x",
  "xx",
  "xxx",
]);
const PLACEHOLDER_PHRASE =
  /^(?:(?:this|that) is (?:a )?)?(?:dummy|placeholder|probe|sample|tbd|test|testing|todo)(?: (?:content|only|result|value))?[.!]?$/;

function issue(path: string, code: string, message: string): WorkflowResultValidationIssue {
  return { path: path.slice(0, 256), code, message: message.slice(0, 512) };
}

function fromReviewIssue(value: ReviewContractValidationIssue): WorkflowResultValidationIssue {
  return issue(value.path, value.code, value.message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function inspectFinalText(
  issues: WorkflowResultValidationIssue[],
  candidate: unknown,
  path: string,
): void {
  if (typeof candidate !== "string") return;
  const normalized = candidate.trim().toLocaleLowerCase("en-US");
  if (!PLACEHOLDER_VALUES.has(normalized) && !PLACEHOLDER_PHRASE.test(normalized)) return;
  issues.push(
    issue(
      path,
      "placeholder_value",
      "A workflow result must contain final content, not a probe or placeholder.",
    ),
  );
}

function inspectTextArray(
  issues: WorkflowResultValidationIssue[],
  candidate: unknown,
  path: string,
): void {
  if (!Array.isArray(candidate)) return;
  candidate.forEach((entry, index) => inspectFinalText(issues, entry, `${path}[${index}]`));
}

function inspectReviewFindingNarratives(
  issues: WorkflowResultValidationIssue[],
  candidate: unknown,
  path: string,
): void {
  if (!record(candidate)) return;
  for (const field of [
    "title",
    "description",
    "evidence",
    "suggestion",
    "verification",
    "untestedBehavior",
  ]) {
    inspectFinalText(issues, candidate[field], `${path}.${field}`);
  }
  inspectTextArray(issues, candidate.alternativeFixes, `${path}.alternativeFixes`);
}

function inspectReviewFindingArray(
  issues: WorkflowResultValidationIssue[],
  candidate: unknown,
  path: string,
): void {
  if (!Array.isArray(candidate)) return;
  candidate.forEach((entry, index) =>
    inspectReviewFindingNarratives(issues, entry, `${path}[${index}]`),
  );
}

function validateReviewNarratives(value: Record<string, unknown>): WorkflowResultValidationIssue[] {
  const issues: WorkflowResultValidationIssue[] = [];
  const reviewScope = record(value.reviewScope) ? value.reviewScope : undefined;
  if (reviewScope) {
    inspectTextArray(issues, reviewScope.limitations, "$.reviewScope.limitations");
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
  if (record(value.whatChanged)) {
    inspectFinalText(issues, value.whatChanged.overview, "$.whatChanged.overview");
    inspectFinalText(issues, value.whatChanged.before, "$.whatChanged.before");
    inspectFinalText(issues, value.whatChanged.after, "$.whatChanged.after");
    inspectFinalText(issues, value.whatChanged.userImpact, "$.whatChanged.userImpact");
    if (Array.isArray(value.whatChanged.keyCodeChanges)) {
      value.whatChanged.keyCodeChanges.forEach((entry, index) => {
        if (record(entry))
          inspectFinalText(
            issues,
            entry.description,
            `$.whatChanged.keyCodeChanges[${index}].description`,
          );
      });
    }
  }
  if (record(value.riskProfile))
    inspectFinalText(issues, value.riskProfile.reasoning, "$.riskProfile.reasoning");
  if (record(value.verdict))
    inspectFinalText(issues, value.verdict.reasoning, "$.verdict.reasoning");
  if (Array.isArray(value.strengths)) {
    value.strengths.forEach((entry, index) => {
      if (record(entry))
        inspectFinalText(issues, entry.description, `$.strengths[${index}].description`);
    });
  }
  inspectReviewFindingArray(issues, value.issues, "$.issues");
  inspectReviewFindingArray(issues, value.testCoverageGaps, "$.testCoverageGaps");
  inspectFinalText(issues, value.summaryOfChange, "$.summaryOfChange");
  inspectFinalText(issues, value.reviewSummary, "$.reviewSummary");
  return issues.slice(0, MAX_ISSUES);
}

/** Collects one kind's final-content issues, bounded like every validation. */
function finalContent(
  inspect: (issues: WorkflowResultValidationIssue[]) => void,
): WorkflowResultValidationIssue[] {
  const issues: WorkflowResultValidationIssue[] = [];
  inspect(issues);
  return issues.slice(0, MAX_ISSUES);
}

function finalFeaturePlanState(value: Record<string, unknown>): WorkflowResultValidationIssue[] {
  return finalContent((issues) => {
    inspectFinalText(issues, value.title, "$.title");
    inspectFinalText(issues, value.summary, "$.summary");
    if (Array.isArray(value.stories)) {
      value.stories.forEach((story, index) => {
        if (!record(story)) return;
        inspectFinalText(issues, story.title, `$.stories[${index}].title`);
        inspectFinalText(issues, story.description, `$.stories[${index}].description`);
        inspectTextArray(
          issues,
          story.acceptanceCriteria,
          `$.stories[${index}].acceptanceCriteria`,
        );
      });
    }
  });
}

function finalStoryRefinement(value: Record<string, unknown>): WorkflowResultValidationIssue[] {
  return finalContent((issues) => {
    inspectFinalText(issues, value.title, "$.title");
    inspectFinalText(issues, value.description, "$.description");
    inspectTextArray(issues, value.acceptanceCriteria, "$.acceptanceCriteria");
  });
}

function finalValidationPlan(value: Record<string, unknown>): WorkflowResultValidationIssue[] {
  return finalContent((issues) => inspectTextArray(issues, value.limitations, "$.limitations"));
}

function finalReviewPreparation(value: Record<string, unknown>): WorkflowResultValidationIssue[] {
  return finalContent((issues) => {
    inspectTextArray(issues, value.limitations, "$.limitations");
    if (Array.isArray(value.validation)) {
      value.validation.forEach((entry, index) => {
        if (record(entry))
          inspectFinalText(issues, entry.limitation, `$.validation[${index}].limitation`);
      });
    }
    if (Array.isArray(value.uncommittedFiles)) {
      value.uncommittedFiles.forEach((entry, index) => {
        if (record(entry))
          inspectFinalText(issues, entry.reason, `$.uncommittedFiles[${index}].reason`);
      });
    }
  });
}

function finalReviewReconciliation(
  value: Record<string, unknown>,
): WorkflowResultValidationIssue[] {
  return finalContent((issues) => {
    inspectReviewFindingArray(issues, value.newIssues, "$.newIssues");
    inspectReviewFindingArray(issues, value.newCoverageGaps, "$.newCoverageGaps");
    for (const field of ["issueUpdates", "coverageGapUpdates"]) {
      if (!Array.isArray(value[field])) continue;
      value[field].forEach((entry, index) => {
        if (record(entry))
          inspectReviewFindingNarratives(issues, entry.finding, `$.${field}[${index}].finding`);
      });
    }
  });
}

function finalFixResult(value: Record<string, unknown>): WorkflowResultValidationIssue[] {
  return finalContent((issues) => {
    inspectFinalText(issues, value.summary, "$.summary");
    inspectTextArray(issues, value.notes, "$.notes");
    inspectTextArray(issues, value.limitations, "$.limitations");
    if (Array.isArray(value.commandsRun)) {
      value.commandsRun.forEach((entry, index) => {
        if (record(entry))
          inspectFinalText(issues, entry.summary, `$.commandsRun[${index}].summary`);
      });
    }
  });
}

function finalVerificationResult(value: Record<string, unknown>): WorkflowResultValidationIssue[] {
  return finalContent((issues) => inspectFinalText(issues, value.rationale, "$.rationale"));
}

function finalPrResult(value: Record<string, unknown>): WorkflowResultValidationIssue[] {
  return finalContent((issues) => inspectFinalText(issues, value.summary, "$.summary"));
}

type ConsolidationContext = Extract<
  NonNullable<WorkflowResultSlotInput["context"]>,
  { type: "consolidated-review" }
>;

/**
 * Multi Review consolidation as a provenance plan (report §5.9): every merged
 * issue and coverage gap cites at least one source finding of its own class,
 * and leaves `reviewModels` to the backend. Wording keeps the diagnostics the
 * consolidator has always seen.
 */
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

function validateConsolidationContext(
  value: Record<string, unknown>,
  context: ConsolidationContext,
): WorkflowResultValidationIssue[] {
  return validateGraphProvenance(
    value,
    REVIEW_CONSOLIDATION_PROVENANCE,
    context.sources,
    REVIEW_CONSOLIDATION_WORDING,
  ).slice(0, MAX_ISSUES);
}

function validateReconciliationContext(
  value: Record<string, unknown>,
  context: Extract<
    NonNullable<WorkflowResultSlotInput["context"]>,
    { type: "review-reconciliation" }
  >,
): WorkflowResultValidationIssue[] {
  const reconciliation = value as {
    newIssues: unknown[];
    issueUpdates: Array<{ poolId: string; finding: unknown }>;
    newCoverageGaps: unknown[];
    coverageGapUpdates: Array<{ poolId: string; finding: unknown }>;
    issueOutcomes: Array<{ reportIndex: number; outcome: string; poolId: string | null }>;
    coverageGapOutcomes: Array<{
      reportIndex: number;
      outcome: string;
      poolId: string | null;
    }>;
  };
  const issues: WorkflowResultValidationIssue[] = [];
  const inspect = (
    findings: unknown[],
    outcomes: typeof reconciliation.issueOutcomes,
    additions: unknown[],
    updates: Array<{ poolId: string; finding: unknown }>,
    ids: Set<string>,
    label: string,
    path: string,
  ): void => {
    if (outcomes.length !== findings.length)
      issues.push(issue(path, "missing_outcome", `Reconciliation must cover every ${label}.`));
    const byIndex = new Map(outcomes.map((entry) => [entry.reportIndex, entry]));
    if (byIndex.size !== outcomes.length)
      issues.push(issue(path, "duplicate_index", `Reconciliation repeats a ${label} index.`));
    let addition = 0;
    const usedUpdates = new Set<string>();
    const updateById = new Map(updates.map((entry) => [entry.poolId, entry.finding]));
    findings.forEach((finding, index) => {
      const outcome = byIndex.get(index);
      if (!outcome) {
        issues.push(issue(`${path}[${index}]`, "missing_outcome", `Missing ${label} outcome.`));
        return;
      }
      if (outcome.outcome === "new") {
        if (!same(additions[addition++], finding))
          issues.push(
            issue(
              `${path}[${index}]`,
              "addition_mismatch",
              `${label} addition differs from the report.`,
            ),
          );
        return;
      }
      const poolId = outcome.poolId;
      if (!poolId || !ids.has(poolId)) {
        issues.push(
          issue(`${path}[${index}].poolId`, "unknown_pool_id", `Unknown ${label} pool ID.`),
        );
      } else if (outcome.outcome === "updated") {
        const update = updateById.get(poolId);
        if (!update || usedUpdates.has(poolId) || !same(update, finding))
          issues.push(
            issue(
              `${path}[${index}]`,
              "update_mismatch",
              `${label} update differs from the report.`,
            ),
          );
        usedUpdates.add(poolId);
      }
    });
    if (addition !== additions.length || usedUpdates.size !== updates.length)
      issues.push(
        issue(
          path,
          "unaccounted_operation",
          `Reconciliation contains unaccounted ${label} operations.`,
        ),
      );
  };
  inspect(
    context.report.issues,
    reconciliation.issueOutcomes,
    reconciliation.newIssues,
    reconciliation.issueUpdates,
    new Set(context.pool.issues.map((entry) => entry.poolId)),
    "issue",
    "$.issueOutcomes",
  );
  inspect(
    context.report.testCoverageGaps,
    reconciliation.coverageGapOutcomes,
    reconciliation.newCoverageGaps,
    reconciliation.coverageGapUpdates,
    new Set(context.pool.coverageGaps.map((entry) => entry.poolId)),
    "coverage gap",
    "$.coverageGapOutcomes",
  );
  return issues.slice(0, MAX_ISSUES);
}

// Shared with the browser so graph designers validate examples the same way.
export { validateWorkflowJsonSchema };

const FEATURE_PLAN_STATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["phase", "title", "summary"],
  properties: {
    phase: { type: "string", enum: ["collecting", "confirming", "stories"] },
    title: { type: "string", maxLength: 500 },
    summary: { type: "string", maxLength: 100_000 },
    stories: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "acceptanceCriteria"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 256 },
          title: { type: "string", minLength: 1, maxLength: 500 },
          description: { type: "string", maxLength: 100_000 },
          acceptanceCriteria: {
            type: "array",
            maxItems: 100,
            items: { type: "string", maxLength: 10_000 },
          },
        },
      },
    },
  },
} satisfies JsonSchema;

const STORY_REFINEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["storyId", "title", "description", "acceptanceCriteria"],
  properties: {
    storyId: { type: "string", minLength: 1, maxLength: 256 },
    title: { type: "string", minLength: 1, maxLength: 500 },
    description: { type: "string", maxLength: 100_000 },
    acceptanceCriteria: {
      type: "array",
      maxItems: 100,
      items: { type: "string", maxLength: 10_000 },
    },
  },
} satisfies JsonSchema;

/**
 * A built-in kind: a fixed schema, the kind's own submission tool and the
 * shared `validate_workflow_result`. A slot's `schema` is ignored.
 */
function builtInKind(
  kind: Exclude<WorkflowResultKind, "graph-output">,
  schema: () => JsonSchema,
  checks: Omit<
    WorkflowResultKindDefinition,
    "kind" | "schema" | "toolName" | "validationToolName" | "label"
  > = {},
): WorkflowResultKindDefinition {
  return {
    kind,
    schema,
    toolName: () => workflowResultToolName(kind),
    validationToolName: () => WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    label: () => kind.replaceAll("-", " "),
    ...checks,
  };
}

/** Wraps a parser that throws (or returns false) into a domain validator. */
function parses(parse: (value: unknown) => unknown, failure?: string) {
  return (value: unknown): WorkflowResultValidationIssue[] => {
    if (!parse(value) && failure) throw new Error(failure);
    return [];
  };
}

function reviewReportDomain(value: unknown): WorkflowResultValidationIssue[] {
  const parsed = safeParseStructuredReviewReport(value, { allowLegacyTestResults: true });
  return parsed.success ? [] : parsed.error.issues.map(fromReviewIssue);
}

const BUILT_IN_KINDS: readonly WorkflowResultKindDefinition[] = [
  builtInKind("feature-plan-state", () => FEATURE_PLAN_STATE_SCHEMA, {
    validator: parses(
      parseFeaturePlannerStateValue,
      "Feature planner state failed runtime validation",
    ),
    finalContent: finalFeaturePlanState,
  }),
  builtInKind("story-refinement", () => STORY_REFINEMENT_SCHEMA, {
    validator: parses(parseStoryRefinementValue, "Story refinement failed runtime validation"),
    finalContent: finalStoryRefinement,
  }),
  builtInKind("validation-plan", () => REVIEW_VALIDATION_PLAN_SCHEMA, {
    validator: parses(parseReviewValidationPlan),
    finalContent: finalValidationPlan,
  }),
  builtInKind("review-preparation", () => REVIEW_PREPARATION_RESULT_JSON_SCHEMA, {
    validator: parses(parseReviewPreparationResult),
    finalContent: finalReviewPreparation,
  }),
  builtInKind("review-report", () => STRUCTURED_REVIEW_REPORT_JSON_SCHEMA, {
    validator: reviewReportDomain,
    finalContent: validateReviewNarratives,
  }),
  builtInKind("consolidated-review", () => STRUCTURED_REVIEW_REPORT_JSON_SCHEMA, {
    validator: reviewReportDomain,
    finalContent: validateReviewNarratives,
    contextValidator: (value, slot) =>
      slot.context?.type === "consolidated-review"
        ? validateConsolidationContext(value, slot.context)
        : [],
  }),
  builtInKind("review-reconciliation", () => REVIEW_RECONCILIATION_RESULT_JSON_SCHEMA, {
    finalContent: finalReviewReconciliation,
    contextValidator: (value, slot) =>
      slot.context?.type === "review-reconciliation"
        ? validateReconciliationContext(value, slot.context)
        : [],
  }),
  builtInKind("fix-result", () => REVIEW_FIX_RESULT_JSON_SCHEMA, {
    validator: parses(parseFixResult),
    finalContent: finalFixResult,
  }),
  builtInKind("verification-result", () => VERIFICATION_VERDICT_SCHEMA, {
    // Keep the old two-field shape compatible. The consumer records every
    // omitted snapshot criterion as not checked, including on current turns.
    structural: (value) => (isLegacyVerificationVerdict(value) ? [] : null),
    validator: (value) => {
      if (!isVerificationVerdict(value))
        throw new Error(
          "Expected exactly a boolean complete field, a string rationale field and an acceptanceCriteria array",
        );
      return [];
    },
    finalContent: finalVerificationResult,
  }),
  builtInKind("pr-result", () => REVIEW_PR_RESULT_JSON_SCHEMA, {
    validator: parses(parsePrResult),
    finalContent: finalPrResult,
  }),
];

for (const definition of BUILT_IN_KINDS) registerWorkflowResultKind(definition);
registerWorkflowResultKind(graphOutputKindDefinition);

// Every kind the protocol names has a definition; a missing one is a startup bug.
for (const kind of WORKFLOW_RESULT_KINDS) {
  if (!registeredWorkflowResultKinds().includes(kind))
    throw new Error(`Workflow result kind ${kind} has no registered definition`);
}

/**
 * The schema a slot's values are validated against: the kind's own, or for
 * `graph-output` the slot's port type (`schema`). Delegates to the registry.
 */
export function workflowResultJsonSchema(
  kind: WorkflowResultKind,
  schema?: JsonSchema,
): JsonSchema {
  return workflowResultKindDefinition(kind).schema({ schema });
}

/**
 * Validates one candidate result against its kind (the registry's shared
 * path): structure, domain checks, final content and the trusted context.
 */
export function validateWorkflowResult(
  kind: WorkflowResultKind,
  value: unknown,
  schema?: JsonSchema,
  context?: WorkflowResultSlotInput["context"],
): WorkflowResultValidationIssue[] {
  const slot: WorkflowResultSlotView = { schema, context };
  return validateRegisteredWorkflowResult(kind, value, slot);
}

/** The reusable final-content check of a built-in kind (graph types bind it, report §5.3). */
export function workflowResultFinalContent(
  kind: WorkflowResultKind,
  value: Record<string, unknown>,
): WorkflowResultValidationIssue[] {
  return workflowResultKindDefinition(kind).finalContent?.(value, {}) ?? [];
}
