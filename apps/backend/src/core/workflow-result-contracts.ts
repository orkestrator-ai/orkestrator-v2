import {
  VERIFICATION_VERDICT_SCHEMA,
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
import type {
  WorkflowResultKind,
  WorkflowResultSlotInput,
  WorkflowResultValidationIssue,
} from "@orkestrator/protocol/workflow-results";
import {
  LOOPED_REVIEW_RECONCILIATION_JSON_SCHEMA,
  REVIEW_FIX_RESULT_JSON_SCHEMA,
  REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
  REVIEW_PR_RESULT_JSON_SCHEMA,
  parseFixResult,
  parsePrResult,
  parseReviewPreparationResult,
} from "./looped-review-prompts.js";
import { REVIEW_VALIDATION_PLAN_SCHEMA } from "./review-validation-prompts.js";

const MAX_ISSUES = 32;

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

function validateConsolidationContext(
  value: Record<string, unknown>,
  context: Extract<
    NonNullable<WorkflowResultSlotInput["context"]>,
    { type: "consolidated-review" }
  >,
): WorkflowResultValidationIssue[] {
  const issues: WorkflowResultValidationIssue[] = [];
  const inspect = (findings: unknown, kind: "issue" | "coverage-gap", path: string): void => {
    if (!Array.isArray(findings)) return;
    findings.forEach((finding, index) => {
      if (!record(finding)) return;
      if (Array.isArray(finding.reviewModels) && finding.reviewModels.length > 0) {
        issues.push(
          issue(
            `${path}[${index}].reviewModels`,
            "invalid_value",
            "Cite source IDs; the backend derives contributing review models.",
          ),
        );
      }
      if (!Array.isArray(finding.reviewSourceIds) || finding.reviewSourceIds.length === 0) {
        issues.push(
          issue(
            `${path}[${index}].reviewSourceIds`,
            "missing_field",
            "Every consolidated finding must cite at least one source finding ID.",
          ),
        );
        return;
      }
      finding.reviewSourceIds.forEach((sourceId, sourceIndex) => {
        if (typeof sourceId !== "string" || context.sources[sourceId] !== kind) {
          issues.push(
            issue(
              `${path}[${index}].reviewSourceIds[${sourceIndex}]`,
              "invalid_value",
              `The source does not identify a ${kind} in the supplied reviewer reports.`,
            ),
          );
        }
      });
    });
  };
  inspect(value.issues, "issue", "$.issues");
  inspect(value.testCoverageGaps, "coverage-gap", "$.testCoverageGaps");
  return issues.slice(0, MAX_ISSUES);
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

function schemaTypeMatches(type: unknown, value: unknown): boolean {
  if (type === "object") return record(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

/** Bounded validator for the JSON-Schema subset used by workflow result contracts. */
export function validateWorkflowJsonSchema(
  schema: JsonSchema | undefined,
  value: unknown,
): WorkflowResultValidationIssue[] {
  if (!schema) return [];
  const issues: WorkflowResultValidationIssue[] = [];
  const visit = (
    candidateSchema: unknown,
    candidate: unknown,
    path: string,
    depth: number,
  ): void => {
    if (issues.length >= MAX_ISSUES) return;
    if (depth > 32) {
      issues.push(issue(path, "too_deep", "Result exceeds the maximum nesting depth"));
      return;
    }
    if (!record(candidateSchema)) return;
    if (Array.isArray(candidateSchema.anyOf)) {
      const alternatives = candidateSchema.anyOf;
      if (
        !alternatives.some(
          (alternative) =>
            validateWorkflowJsonSchema(alternative as JsonSchema, candidate).length === 0,
        )
      ) {
        issues.push(issue(path, "invalid_type", "Value does not match any allowed shape"));
      }
      return;
    }
    if (candidateSchema.const !== undefined && candidate !== candidateSchema.const) {
      issues.push(
        issue(path, "invalid_value", `Value must equal ${JSON.stringify(candidateSchema.const)}`),
      );
      return;
    }
    if (Array.isArray(candidateSchema.enum) && !candidateSchema.enum.includes(candidate)) {
      issues.push(
        issue(
          path,
          "invalid_enum",
          `Value must be one of ${candidateSchema.enum.map(String).join(", ")}`,
        ),
      );
      return;
    }
    if (!schemaTypeMatches(candidateSchema.type, candidate)) {
      issues.push(issue(path, "invalid_type", `Expected ${String(candidateSchema.type)}`));
      return;
    }
    if (typeof candidate === "number") {
      if (typeof candidateSchema.minimum === "number" && candidate < candidateSchema.minimum)
        issues.push(issue(path, "too_small", `Value must be at least ${candidateSchema.minimum}`));
      if (typeof candidateSchema.maximum === "number" && candidate > candidateSchema.maximum)
        issues.push(issue(path, "too_large", `Value must be at most ${candidateSchema.maximum}`));
    }
    if (typeof candidate === "string") {
      if (
        typeof candidateSchema.minLength === "number" &&
        candidate.length < candidateSchema.minLength
      )
        issues.push(
          issue(
            path,
            "too_short",
            `Text must contain at least ${candidateSchema.minLength} characters`,
          ),
        );
      if (
        typeof candidateSchema.maxLength === "number" &&
        candidate.length > candidateSchema.maxLength
      )
        issues.push(
          issue(
            path,
            "too_long",
            `Text must contain at most ${candidateSchema.maxLength} characters`,
          ),
        );
    }
    if (Array.isArray(candidate) && candidateSchema.items !== undefined) {
      if (
        typeof candidateSchema.minItems === "number" &&
        candidate.length < candidateSchema.minItems
      )
        issues.push(
          issue(
            path,
            "too_few_items",
            `Array must contain at least ${candidateSchema.minItems} items`,
          ),
        );
      if (
        typeof candidateSchema.maxItems === "number" &&
        candidate.length > candidateSchema.maxItems
      )
        issues.push(
          issue(
            path,
            "too_many_items",
            `Array must contain at most ${candidateSchema.maxItems} items`,
          ),
        );
      candidate
        .slice(0, 4096)
        .forEach((entry, index) =>
          visit(candidateSchema.items, entry, `${path}[${index}]`, depth + 1),
        );
      if (candidate.length > 4096)
        issues.push(issue(path, "too_many_items", "Array exceeds the validation item limit"));
      return;
    }
    if (!record(candidate)) return;
    const properties = record(candidateSchema.properties) ? candidateSchema.properties : {};
    const required = Array.isArray(candidateSchema.required)
      ? candidateSchema.required.filter((key): key is string => typeof key === "string")
      : [];
    for (const key of required) {
      if (!Object.hasOwn(candidate, key))
        issues.push(issue(`${path}.${key}`, "missing_field", "Required field is missing"));
    }
    if (candidateSchema.additionalProperties === false) {
      for (const key of Object.keys(candidate)) {
        if (!Object.hasOwn(properties, key))
          issues.push(issue(`${path}.${key}`, "unknown_field", "Field is not allowed"));
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(candidate, key))
        visit(propertySchema, candidate[key], `${path}.${key}`, depth + 1);
    }
  };
  visit(schema, value, "$", 0);
  return issues.slice(0, MAX_ISSUES);
}

export function workflowResultJsonSchema(
  kind: WorkflowResultKind,
  schema?: JsonSchema,
): JsonSchema {
  return (() => {
    if (kind === "feature-plan-state")
      return {
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
    if (kind === "story-refinement")
      return {
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
    if (kind === "validation-plan") return REVIEW_VALIDATION_PLAN_SCHEMA;
    if (kind === "review-preparation") return REVIEW_PREPARATION_RESULT_JSON_SCHEMA;
    if (kind === "review-report" || kind === "consolidated-review")
      return STRUCTURED_REVIEW_REPORT_JSON_SCHEMA;
    if (kind === "review-reconciliation") return LOOPED_REVIEW_RECONCILIATION_JSON_SCHEMA;
    if (kind === "fix-result") return REVIEW_FIX_RESULT_JSON_SCHEMA;
    if (kind === "verification-result") return VERIFICATION_VERDICT_SCHEMA;
    if (kind === "pr-result") return REVIEW_PR_RESULT_JSON_SCHEMA;
    return schema ?? {};
  })();
}

export function validateWorkflowResult(
  kind: WorkflowResultKind,
  value: unknown,
  schema?: JsonSchema,
  context?: WorkflowResultSlotInput["context"],
): WorkflowResultValidationIssue[] {
  const registeredSchema = workflowResultJsonSchema(kind, schema);
  const structural = validateWorkflowJsonSchema(registeredSchema, value);
  if (structural.length > 0) return structural;
  try {
    if (kind === "feature-plan-state" && !parseFeaturePlannerStateValue(value))
      throw new Error("Feature planner state failed runtime validation");
    else if (kind === "story-refinement" && !parseStoryRefinementValue(value))
      throw new Error("Story refinement failed runtime validation");
    else if (kind === "validation-plan") parseReviewValidationPlan(value);
    else if (kind === "review-preparation") parseReviewPreparationResult(value);
    else if (kind === "fix-result") parseFixResult(value);
    else if (kind === "pr-result") parsePrResult(value);
    else if (kind === "verification-result" && !isVerificationVerdict(value))
      throw new Error("Expected exactly a boolean complete field and a string rationale field");
    else if (kind === "review-report" || kind === "consolidated-review") {
      const parsed = safeParseStructuredReviewReport(value, { allowLegacyTestResults: true });
      if (!parsed.success) return parsed.error.issues.map(fromReviewIssue).slice(0, MAX_ISSUES);
    }
  } catch (error) {
    return [issue("$", "invalid_value", error instanceof Error ? error.message : String(error))];
  }
  if (!record(value)) return [];
  if (kind === "consolidated-review" && context?.type === "consolidated-review")
    return validateConsolidationContext(value, context);
  if (kind === "review-reconciliation" && context?.type === "review-reconciliation")
    return validateReconciliationContext(value, context);
  return [];
}
