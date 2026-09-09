import type { JsonSchema, StructuredOutputProvider } from "./structured-output.js";
import type { ReviewFindingPool, StructuredReviewReport } from "./structured-review.js";

export const WORKFLOW_RESULT_STORE_VERSION = 1;
export const WORKFLOW_RESULT_SCHEMA_VERSION = 1;
export const WORKFLOW_RESULT_MAX_BYTES = 384 * 1024;
export const WORKFLOW_RESULT_MAX_ENTRIES = 4096;
export const WORKFLOW_RESULT_MAX_REJECTIONS = 4;
export const WORKFLOW_RESULT_MAX_PENDING_CALLS = 64;
export const WORKFLOW_RESULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;
export const WORKFLOW_RESULT_MAX_PENDING_CALLS_PER_KEY = 2;

export const WORKFLOW_RESULT_KINDS = [
  "feature-plan-state",
  "story-refinement",
  "validation-plan",
  "review-preparation",
  "review-report",
  "consolidated-review",
  "review-reconciliation",
  "fix-result",
  "verification-result",
  "pr-result",
] as const;

export type WorkflowResultKind = (typeof WORKFLOW_RESULT_KINDS)[number];
export type WorkflowResultTransport = "tool-v1" | "structured-output-v1" | "planner-block-v1";
export type WorkflowResultLifecycle =
  | "open"
  | "accepted"
  | "consumed"
  | "cancelled"
  | "superseded"
  | "exhausted";

export interface WorkflowResultReceipt {
  version: 1;
  resultKey: string;
  receiptId: string;
  kind: WorkflowResultKind;
  schemaVersion: number;
  acceptedAt: string;
}

export interface WorkflowResultValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface WorkflowResultError {
  code:
    | "invalid_result"
    | "result_too_large"
    | "attempt_closed"
    | "submission_conflict"
    | "capability_denied"
    | "correction_budget_exhausted"
    | "storage_unavailable"
    | "backpressure"
    | "result_status_unavailable";
  nextAction: "correct" | "lookup_or_resubmit" | "reconcile" | "stop";
  message: string;
  issues?: WorkflowResultValidationIssue[];
  omittedIssueCount?: number;
}

export type WorkflowResultSubmission =
  | {
      ok: true;
      receipt: WorkflowResultReceipt;
      lifecycle: WorkflowResultLifecycle;
      duplicate: boolean;
    }
  | { ok: false; error: WorkflowResultError };

export interface WorkflowResultStatus {
  resultKey: string;
  lifecycle: WorkflowResultLifecycle;
  completion: "pending" | "completed" | "blocked";
  receipt?: WorkflowResultReceipt;
}

export interface WorkflowResultSlotInput {
  resultKey: string;
  kind: WorkflowResultKind;
  environmentId: string;
  projectId: string;
  provider: StructuredOutputProvider;
  schema?: JsonSchema;
  /** Trusted contextual fence for a story-refinement slot. */
  expectedStoryId?: string;
  /** Trusted context needed to reject stale or invented cross-result references. */
  context?:
    | {
        type: "review-reconciliation";
        pool: ReviewFindingPool;
        report: StructuredReviewReport;
      }
    | {
        type: "consolidated-review";
        sources: Record<string, "issue" | "coverage-gap">;
      };
}

export function isWorkflowResultKind(value: unknown): value is WorkflowResultKind {
  return typeof value === "string" && (WORKFLOW_RESULT_KINDS as readonly string[]).includes(value);
}

const WORKFLOW_RESULT_TOOL_NAMES: Record<WorkflowResultKind, string> = {
  "feature-plan-state": "submit_feature_plan_state",
  "story-refinement": "submit_story_refinement",
  "validation-plan": "submit_validation_plan",
  "review-preparation": "submit_review_preparation",
  "review-report": "submit_review_report",
  "consolidated-review": "submit_consolidated_review",
  "review-reconciliation": "submit_review_reconciliation",
  "fix-result": "submit_fix_result",
  "verification-result": "submit_verification_result",
  "pr-result": "submit_pr_result",
};

export function workflowResultToolName(kind: WorkflowResultKind): string {
  return WORKFLOW_RESULT_TOOL_NAMES[kind];
}

export function workflowResultInstruction(kind: WorkflowResultKind, resultKey: string): string {
  return `The following result-tool instructions replace any earlier instruction to emit final JSON, a tagged state block, or a provider-enforced schema for this turn. When your work is complete, call the Orkestrator \`${workflowResultToolName(kind)}\` tool with resultKey ${JSON.stringify(resultKey)} and the complete ${kind.replaceAll("-", " ")} in \`result\`. If the tool rejects the result, correct only the reported contract problems and call it again. If delivery is uncertain, call \`get_workflow_result_status\` with the same resultKey before resubmitting. After the tool accepts the result, finish with a concise prose response. Do not print the result as JSON in your final response. The backend decides when the workflow advances.`;
}

/**
 * Backend-projected delivery state for one attempt's result slot.
 *
 * This is the only submission detail a renderer sees. It deliberately carries
 * no receipt id, digest, capability material, or diagnostic text.
 */
export type WorkflowResultSubmissionState =
  | "preparing"
  | "correcting"
  | "received"
  | "needs-attention";

export function isWorkflowResultSubmissionState(
  value: unknown,
): value is WorkflowResultSubmissionState {
  return (
    value === "preparing" ||
    value === "correcting" ||
    value === "received" ||
    value === "needs-attention"
  );
}

const PLANNING_RESULT_KINDS = new Set<WorkflowResultKind>([
  "feature-plan-state",
  "story-refinement",
]);

const REPORT_RESULT_KINDS = new Set<WorkflowResultKind>([
  "review-report",
  "consolidated-review",
  "review-reconciliation",
]);

/** Noun used in user-facing submission status text for one result kind. */
export function workflowResultNoun(kind: WorkflowResultKind): string {
  if (PLANNING_RESULT_KINDS.has(kind)) return "plan";
  if (REPORT_RESULT_KINDS.has(kind)) return "report";
  return "result";
}

/**
 * User-facing status text. `accepted` is deliberately not presented as a
 * passing or completed outcome: the backend still has checks to run, and a
 * report can be accepted while its verdict is negative.
 */
export function workflowResultSubmissionLabel(
  state: WorkflowResultSubmissionState,
  kind: WorkflowResultKind,
): string {
  const noun = workflowResultNoun(kind);
  if (state === "preparing") return `Preparing ${noun}`;
  if (state === "correcting") return `Correcting ${noun} format`;
  if (state === "received")
    return `${noun[0]!.toUpperCase()}${noun.slice(1)} received; finishing checks`;
  return `${noun[0]!.toUpperCase()}${noun.slice(1)} needs attention`;
}

/** Providers with a qualified per-turn tool attachment and reconnect story. */
export const QUALIFIED_WORKFLOW_RESULT_TOOL_PROVIDERS: readonly StructuredOutputProvider[] = [
  "claude",
  "codex",
];

/**
 * Backend-owned rollout configuration. Deliberately not a user-facing transport
 * choice: operators enable combinations as each one passes qualification, and a
 * change only affects attempts admitted after it.
 */
export interface WorkflowResultToolsSettings {
  /** Master switch for admitting new tool-mode attempts. */
  enabled: boolean;
  providers: StructuredOutputProvider[];
  kinds: WorkflowResultKind[];
}

export const DEFAULT_WORKFLOW_RESULT_TOOLS_SETTINGS: WorkflowResultToolsSettings = {
  enabled: true,
  providers: [...QUALIFIED_WORKFLOW_RESULT_TOOL_PROVIDERS],
  kinds: [...WORKFLOW_RESULT_KINDS],
};

export const STRUCTURED_OUTPUT_PROVIDER_VALUES: readonly StructuredOutputProvider[] = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "grok",
  "pi",
];

/**
 * Reads persisted rollout settings defensively. A malformed stored value falls
 * back to the qualified defaults rather than widening or disabling admission by
 * accident.
 */
export function normalizeWorkflowResultToolsSettings(value: unknown): WorkflowResultToolsSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_WORKFLOW_RESULT_TOOLS_SETTINGS };
  }
  const candidate = value as Partial<Record<keyof WorkflowResultToolsSettings, unknown>>;
  const providers = Array.isArray(candidate.providers)
    ? candidate.providers.filter((entry): entry is StructuredOutputProvider =>
        STRUCTURED_OUTPUT_PROVIDER_VALUES.includes(entry as StructuredOutputProvider),
      )
    : undefined;
  const kinds = Array.isArray(candidate.kinds)
    ? candidate.kinds.filter(isWorkflowResultKind)
    : undefined;
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
    providers: providers ?? [...QUALIFIED_WORKFLOW_RESULT_TOOL_PROVIDERS],
    kinds: kinds ?? [...WORKFLOW_RESULT_KINDS],
  };
}
