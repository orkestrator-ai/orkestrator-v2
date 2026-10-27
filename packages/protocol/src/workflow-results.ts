import { wrapSystemInstructions } from "./review-evidence-frames.js";
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
export const WORKFLOW_RESULT_MCP_SERVER_NAME = "orkestrator_workflow_result";

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
    | "result_status_unavailable"
    /** The workflow's own precondition on the environment failed; fix it and retry. */
    | "worktree_changed";
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

export type WorkflowResultValidation =
  | {
      ok: true;
      valid: true;
      /**
       * SHA-256 of the validated payload. The backend holds that payload for a
       * bounded time, so the submission tool can commit it by this digest
       * instead of the model re-emitting a large nested object.
       */
      validatedDigest?: string;
    }
  | { ok: false; error: WorkflowResultError };

/**
 * What the backend has actually received for one slot.
 *
 * A tool call the client rejects before it leaves the model's process (for
 * example arguments that do not parse) never reaches the backend, so these
 * counts are the evidence that separates "the tool is broken" from "my call
 * was malformed". In-memory only: a backend restart resets them.
 */
export interface WorkflowResultDelivery {
  validationCalls: number;
  submissionCalls: number;
  lastValidation?: "valid" | "invalid";
  /** Present while a valid candidate is held and can be committed by digest. */
  validatedDigest?: string;
  hint?: string;
}

export interface WorkflowResultStatus {
  resultKey: string;
  lifecycle: WorkflowResultLifecycle;
  completion: "pending" | "completed" | "blocked";
  receipt?: WorkflowResultReceipt;
  delivery?: WorkflowResultDelivery;
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

export const WORKFLOW_RESULT_VALIDATION_TOOL_NAME = "validate_workflow_result";

/**
 * A Multi Review reviewer's optional progress channel: one finding at a time,
 * shown to the user as provisional until the reviewer's report is accepted.
 * Only the reviewer's own attempt capability can call it.
 */
export const REPORT_FINDING_TOOL_NAME = "report_finding";

/** Upper bound on a result key a bridge accepts in a prompt body. */
export const WORKFLOW_RESULT_KEY_MAX_LENGTH = 128;

/**
 * The workflow-result attempt a turn runs for, as a bridge is told it: the
 * attempt's submission tool and its result key. A bridge that knows it can let
 * exactly that attempt's own tools through a read-only turn, and only when a
 * call names that key. The attempt's capability still decides on the backend.
 */
export interface WorkflowResultTurn {
  tool: string;
  resultKey: string;
}

/**
 * Reads the `workflowResultTool` / `workflowResultKey` pair of a prompt body.
 * Both absent is an ordinary turn; one without the other, an unknown tool or a
 * malformed key is a caller error.
 */
export function parseWorkflowResultTurn(
  tool: unknown,
  resultKey: unknown,
): { ok: true; turn?: WorkflowResultTurn } | { ok: false; error: string } {
  if (tool === undefined && resultKey === undefined) return { ok: true };
  if (
    typeof tool !== "string" ||
    !WORKFLOW_RESULT_KINDS.some((kind) => WORKFLOW_RESULT_TOOL_NAMES[kind] === tool)
  ) {
    return { ok: false, error: "workflowResultTool must name a workflow result tool" };
  }
  if (
    typeof resultKey !== "string" ||
    resultKey.length === 0 ||
    resultKey.length > WORKFLOW_RESULT_KEY_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(resultKey)
  ) {
    return { ok: false, error: "workflowResultKey must be a result key" };
  }
  return { ok: true, turn: { tool, resultKey } };
}

/**
 * The Orkestrator tools a workflow-result turn's attempt server offers: its
 * submission tool, validation and status, and `report_finding` for a reviewer.
 */
export function workflowResultTurnToolNames(turn: WorkflowResultTurn): readonly string[] {
  return [
    turn.tool,
    WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    "get_workflow_result_status",
    ...(turn.tool === WORKFLOW_RESULT_TOOL_NAMES["review-report"]
      ? [REPORT_FINDING_TOOL_NAME]
      : []),
  ];
}

/** Whether a tool call's arguments name the turn's own result key. */
export function callsOwnWorkflowResult(turn: WorkflowResultTurn, args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    !Array.isArray(args) &&
    (args as Record<string, unknown>).resultKey === turn.resultKey
  );
}

/**
 * Guidance for a rejected tool call that never reached the backend. Shared by
 * the first-turn instruction and the reminder turn so the two cannot drift.
 *
 * Models read a generic "failed to parse arguments" rejection as a size,
 * formatting or quoting problem and burn minutes shrinking or reformatting a
 * payload that was fine. The observed fault is a brace count that is off by
 * one in either direction, so the guidance names both.
 */
export const WORKFLOW_RESULT_MALFORMED_CALL_GUIDANCE =
  "A call rejected with a JSON parse error or `Failed to parse arguments string as JSON object` was malformed. It is not a sign that the tool is broken, and it is not a size, line-length or formatting problem. The usual cause is a brace count that is off by one: a missing closing brace, or one extra `}` at the very end, which is easy to add when the call is wrapped in another object. Recount the closing braces, keep the same content, and call the same tool again. Never shorten the report or replace its findings with placeholder text to get a call through.";

export function workflowResultToolName(kind: WorkflowResultKind): string {
  return WORKFLOW_RESULT_TOOL_NAMES[kind];
}

export function workflowResultInstruction(
  kind: WorkflowResultKind,
  resultKey: string,
  options: {
    capability?: string;
    /** The attempt also takes `report_finding` (a Multi Review reviewer). */
    provisionalFindings?: boolean;
  } = {},
): string {
  const capabilityArgument = options.capability
    ? ` and capability ${JSON.stringify(options.capability)}`
    : "";
  const findings =
    options.provisionalFindings && kind === "review-report"
      ? ` While you review, you are encouraged, but not required, to call \`${REPORT_FINDING_TOOL_NAME}\` with the same resultKey${capabilityArgument} and one finding in \`finding\` as soon as you are confident in it, using the fields of one entry of the report's \`issues\`. The user sees these findings as provisional progress while you work. Report each finding once, and carry on if a call is refused. They never replace your report: the report you submit must still list every finding, including the ones you already reported, and only that report counts.`
      : "";
  return wrapSystemInstructions(
    `The following result-tool instructions replace any earlier instruction to emit final JSON, a tagged state block, or a provider-enforced schema for this turn. Never call the submission tool with a probe, placeholder, partial draft, or transport test: the first accepted payload is final and cannot be replaced. If you need to check a completed payload before committing it, call \`${WORKFLOW_RESULT_VALIDATION_TOOL_NAME}\` with resultKey ${JSON.stringify(resultKey)}${capabilityArgument} and the complete ${kind.replaceAll("-", " ")} in \`result\`; validation is read-only. When validation accepts the payload it returns a \`validatedDigest\`: submit that exact payload by calling \`${workflowResultToolName(kind)}\` with the same resultKey${capabilityArgument} and \`validatedDigest\` instead of \`result\`, so the large object is sent only once. Otherwise, when your work is complete, call the Orkestrator \`${workflowResultToolName(kind)}\` tool with the same resultKey${capabilityArgument} and complete result. When using a generic \`CallDynamicTool\` wrapper, pass \`arguments\` as a raw object, never as a quoted or JSON-stringified object. Emit the arguments as exactly one JSON object with balanced braces and brackets, and keep prose fields concise. ${WORKFLOW_RESULT_MALFORMED_CALL_GUIDANCE} If the submission tool rejects the result, correct only the reported contract problems and call it again. Only retry an accepted submission with the exact same payload. If delivery is uncertain, call \`get_workflow_result_status\` with the same resultKey${capabilityArgument} before resubmitting.${findings} After the tool accepts the result, finish with a concise prose response. Do not print the result as JSON in your final response. The backend decides when the workflow advances.`,
  );
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

/** Providers with qualified result-tool delivery and reconnect behavior. */
export const QUALIFIED_WORKFLOW_RESULT_TOOL_PROVIDERS: readonly StructuredOutputProvider[] = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
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
