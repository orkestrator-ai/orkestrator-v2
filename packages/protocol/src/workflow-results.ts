import { wrapSystemInstructions } from "./review-evidence-frames.js";
import type { JsonSchema, StructuredOutputProvider } from "./structured-output.js";
import type { WorkflowGraphOutputContext } from "./graphs/output-slots.js";
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
  /**
   * A graph output port (plan P1.3). Its schema and submission tool come from
   * the slot (`schema`, `toolName`), not from the kind.
   */
  "graph-output",
] as const;

export type WorkflowResultKind = (typeof WORKFLOW_RESULT_KINDS)[number];
export type WorkflowResultTransport = "tool-v1" | "structured-output-v1" | "planner-block-v1";
export type WorkflowResultLifecycle =
  "open" | "accepted" | "consumed" | "cancelled" | "superseded" | "exhausted";

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
  /**
   * The contract schema. Built-in kinds own theirs and ignore this; a
   * `graph-output` slot takes its port type's schema from here.
   */
  schema?: JsonSchema;
  /**
   * `graph-output` only: the port's submission tool, `submit_<port>` (see
   * `graphs/output-slots.ts`). Its validation tool is `validate_<port>`.
   * Without it the slot uses the kind's generic tools.
   */
  toolName?: string;
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
      }
    | WorkflowGraphOutputContext;
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
  "graph-output": "submit_graph_output",
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

/** Upper bound on the output slots one graph activation turn declares. */
export const WORKFLOW_RESULT_TURN_MAX_SLOTS = 16;

export const WORKFLOW_RESULT_STATUS_TOOL_NAME = "get_workflow_result_status";

/**
 * The tools a graph activation's credential may list beside its result slots
 * (plan item 204): `report_progress` names one of the slots' keys,
 * `read_artifact` and `ask_human` take no result key.
 */
export const GRAPH_ACTIVATION_EXTRA_TOOLS = [
  "report_progress",
  "read_artifact",
  "ask_human",
] as const;

export type GraphActivationExtraTool = (typeof GRAPH_ACTIVATION_EXTRA_TOOLS)[number];

/** One result slot of a turn: its submission tool and its result key. */
export interface WorkflowResultTurnSlot {
  tool: string;
  resultKey: string;
}

/**
 * The workflow-result attempt a turn runs for, as a bridge is told it: the
 * attempt's submission tool and its result key. A bridge that knows it can let
 * exactly that attempt's own tools through a read-only turn, and only when a
 * call names that key. The attempt's capability still decides on the backend.
 *
 * A graph activation declares every output slot in `slots` (the first is
 * `tool`/`resultKey`) and the extra tools its credential lists in
 * `extraTools`.
 */
export interface WorkflowResultTurn {
  tool: string;
  resultKey: string;
  slots?: readonly WorkflowResultTurnSlot[];
  extraTools?: readonly string[];
}

const GRAPH_PORT_SUBMIT_PREFIX = "submit_";
const GRAPH_PORT_VALIDATE_PREFIX = "validate_";
/**
 * The output-port grammar of `graphs/output-slots.ts` (`GRAPH_KEY_PATTERN`, at
 * most 48 characters, not reserved), restated here because that module
 * imports this one at load time. A test keeps the two in step.
 */
const GRAPH_PORT_PATTERN = /^[a-z][A-Za-z0-9_]*$/;
const GRAPH_PORT_MAX_CHARS = 48;
const WORKFLOW_RESULT_KIND_TOOLS: ReadonlySet<string> = new Set(
  Object.values(WORKFLOW_RESULT_TOOL_NAMES),
);
const RESERVED_GRAPH_PORTS: ReadonlySet<string> = new Set([
  ...[...WORKFLOW_RESULT_KIND_TOOLS].map((tool) => tool.slice(GRAPH_PORT_SUBMIT_PREFIX.length)),
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME.slice(GRAPH_PORT_VALIDATE_PREFIX.length),
]);

/** The output port of a per-port `submit_<port>` tool, or null for any other name. */
export function workflowResultTurnToolPort(tool: unknown): string | null {
  if (typeof tool !== "string" || !tool.startsWith(GRAPH_PORT_SUBMIT_PREFIX)) return null;
  const port = tool.slice(GRAPH_PORT_SUBMIT_PREFIX.length);
  return GRAPH_PORT_PATTERN.test(port) &&
    port.length <= GRAPH_PORT_MAX_CHARS &&
    !RESERVED_GRAPH_PORTS.has(port)
    ? port
    : null;
}

function isWorkflowResultTurnTool(tool: unknown): tool is string {
  return (
    typeof tool === "string" &&
    (WORKFLOW_RESULT_KIND_TOOLS.has(tool) || workflowResultTurnToolPort(tool) !== null)
  );
}

function isWorkflowResultTurnKey(resultKey: unknown): resultKey is string {
  return (
    typeof resultKey === "string" &&
    resultKey.length > 0 &&
    resultKey.length <= WORKFLOW_RESULT_KEY_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(resultKey)
  );
}

/** The validation tool of a slot's submission tool. */
function workflowResultTurnValidationTool(tool: string): string {
  const port = workflowResultTurnToolPort(tool);
  return port === null
    ? WORKFLOW_RESULT_VALIDATION_TOOL_NAME
    : `${GRAPH_PORT_VALIDATE_PREFIX}${port}`;
}

function parseWorkflowResultTurnSlots(
  slots: unknown,
  tool: string,
  resultKey: string,
): WorkflowResultTurnSlot[] | null {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > WORKFLOW_RESULT_TURN_MAX_SLOTS)
    return null;
  const parsed: WorkflowResultTurnSlot[] = [];
  const keys = new Set<string>();
  const portTools = new Set<string>();
  for (const slot of slots) {
    if (typeof slot !== "object" || slot === null || Array.isArray(slot)) return null;
    const entry = slot as Record<string, unknown>;
    if (!isWorkflowResultTurnTool(entry.tool) || !isWorkflowResultTurnKey(entry.resultKey))
      return null;
    if (keys.has(entry.resultKey)) return null;
    keys.add(entry.resultKey);
    // Kind tools are shared (OpenCode's `submit_graph_output` serves every
    // slot); a port's own tool belongs to one slot.
    if (!WORKFLOW_RESULT_KIND_TOOLS.has(entry.tool)) {
      if (portTools.has(entry.tool)) return null;
      portTools.add(entry.tool);
    }
    parsed.push({ tool: entry.tool, resultKey: entry.resultKey });
  }
  if (parsed[0]!.tool !== tool || parsed[0]!.resultKey !== resultKey) return null;
  return parsed;
}

function parseWorkflowResultTurnExtraTools(extraTools: unknown): string[] | null {
  if (!Array.isArray(extraTools) || extraTools.length > GRAPH_ACTIVATION_EXTRA_TOOLS.length)
    return null;
  const parsed: string[] = [];
  for (const name of extraTools) {
    if (
      typeof name !== "string" ||
      !(GRAPH_ACTIVATION_EXTRA_TOOLS as readonly string[]).includes(name) ||
      parsed.includes(name)
    )
      return null;
    parsed.push(name);
  }
  return parsed;
}

/**
 * Reads the `workflowResultTool` / `workflowResultKey` pair of a prompt body,
 * with a graph activation's `workflowResultSlots` and
 * `workflowResultExtraTools`. Both absent is an ordinary turn; one without the
 * other, an unknown tool, a malformed key, slots that do not start with the
 * pair, or slots or extra tools without the pair are a caller error.
 */
export function parseWorkflowResultTurn(
  tool: unknown,
  resultKey: unknown,
  slots?: unknown,
  extraTools?: unknown,
): { ok: true; turn?: WorkflowResultTurn } | { ok: false; error: string } {
  if (tool === undefined && resultKey === undefined) {
    if (slots !== undefined || extraTools !== undefined) {
      return {
        ok: false,
        error: "workflowResultSlots and workflowResultExtraTools require workflowResultTool",
      };
    }
    return { ok: true };
  }
  if (!isWorkflowResultTurnTool(tool)) {
    return { ok: false, error: "workflowResultTool must name a workflow result tool" };
  }
  if (!isWorkflowResultTurnKey(resultKey)) {
    return { ok: false, error: "workflowResultKey must be a result key" };
  }
  const turn: WorkflowResultTurn = { tool, resultKey };
  if (slots !== undefined) {
    const parsed = parseWorkflowResultTurnSlots(slots, tool, resultKey);
    if (!parsed) {
      return {
        ok: false,
        error: `workflowResultSlots must list 1 to ${WORKFLOW_RESULT_TURN_MAX_SLOTS} distinct result slots, starting with workflowResultTool and workflowResultKey`,
      };
    }
    turn.slots = parsed;
  }
  if (extraTools !== undefined) {
    const parsed = parseWorkflowResultTurnExtraTools(extraTools);
    if (!parsed) {
      return {
        ok: false,
        error: `workflowResultExtraTools may only name ${GRAPH_ACTIVATION_EXTRA_TOOLS.join(", ")}, each once`,
      };
    }
    turn.extraTools = parsed;
  }
  return { ok: true, turn };
}

function workflowResultTurnSlots(turn: WorkflowResultTurn): readonly WorkflowResultTurnSlot[] {
  return turn.slots ?? [{ tool: turn.tool, resultKey: turn.resultKey }];
}

/**
 * The Orkestrator tools a workflow-result turn's attempt server offers: each
 * slot's submission and validation tool, status, `report_finding` for a
 * reviewer, and a graph activation's extra tools.
 */
export function workflowResultTurnToolNames(turn: WorkflowResultTurn): readonly string[] {
  const names = new Set<string>();
  const slots = workflowResultTurnSlots(turn);
  for (const slot of slots) {
    names.add(slot.tool);
    names.add(workflowResultTurnValidationTool(slot.tool));
  }
  names.add(WORKFLOW_RESULT_STATUS_TOOL_NAME);
  if (slots.some((slot) => slot.tool === WORKFLOW_RESULT_TOOL_NAMES["review-report"])) {
    names.add(REPORT_FINDING_TOOL_NAME);
  }
  for (const name of turn.extraTools ?? []) names.add(name);
  return [...names];
}

/**
 * Whether a bare tool name belongs to some workflow-result attempt, whichever
 * turn declared it: a kind's tools, a graph output port's `submit_<port>` /
 * `validate_<port>`, status, `report_finding`, or a graph activation's extra
 * tools. A bridge holding calls to its turn's attempt gates these and leaves
 * every other tool (mail, artifacts) alone.
 */
export function isWorkflowResultAttemptTool(name: string): boolean {
  if (
    WORKFLOW_RESULT_KIND_TOOLS.has(name) ||
    name === WORKFLOW_RESULT_VALIDATION_TOOL_NAME ||
    name === WORKFLOW_RESULT_STATUS_TOOL_NAME ||
    name === REPORT_FINDING_TOOL_NAME ||
    (GRAPH_ACTIVATION_EXTRA_TOOLS as readonly string[]).includes(name) ||
    workflowResultTurnToolPort(name) !== null
  )
    return true;
  return (
    name.startsWith(GRAPH_PORT_VALIDATE_PREFIX) &&
    workflowResultTurnToolPort(
      `${GRAPH_PORT_SUBMIT_PREFIX}${name.slice(GRAPH_PORT_VALIDATE_PREFIX.length)}`,
    ) !== null
  );
}

function argumentsResultKey(args: unknown): unknown {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>).resultKey
    : undefined;
}

/**
 * Whether a read-only turn may let this call to an Orkestrator tool through.
 * A slot's submission and validation tools must name that slot's own key
 * (`report_finding`, a reviewer slot's key); status and `report_progress` any
 * slot's key; `read_artifact` and `ask_human` only need to be listed in
 * `extraTools`. Anything else is not the turn's own.
 */
export function workflowResultTurnAllows(
  turn: WorkflowResultTurn,
  toolName: string,
  args: unknown,
): boolean {
  const slots = workflowResultTurnSlots(turn);
  const key = argumentsResultKey(args);
  const extraTools = turn.extraTools ?? [];
  if (toolName === WORKFLOW_RESULT_STATUS_TOOL_NAME) {
    return slots.some((slot) => slot.resultKey === key);
  }
  if (toolName === REPORT_FINDING_TOOL_NAME) {
    return slots.some(
      (slot) => slot.tool === WORKFLOW_RESULT_TOOL_NAMES["review-report"] && slot.resultKey === key,
    );
  }
  if ((GRAPH_ACTIVATION_EXTRA_TOOLS as readonly string[]).includes(toolName)) {
    if (!extraTools.includes(toolName)) return false;
    return toolName === "report_progress" ? slots.some((slot) => slot.resultKey === key) : true;
  }
  return slots.some(
    (slot) =>
      slot.resultKey === key &&
      (toolName === slot.tool || toolName === workflowResultTurnValidationTool(slot.tool)),
  );
}

/** Whether a tool call's arguments name the turn's own result key. */
export function callsOwnWorkflowResult(turn: WorkflowResultTurn, args: unknown): boolean {
  return argumentsResultKey(args) === turn.resultKey;
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

/** Opening sentence of every result-tool instruction. */
export const WORKFLOW_RESULT_INSTRUCTION_PREAMBLE =
  "The following result-tool instructions replace any earlier instruction to emit final JSON, a tagged state block, or a provider-enforced schema for this turn.";

/** How to pass arguments through a generic dynamic-tool wrapper. */
export const WORKFLOW_RESULT_ARGUMENT_GUIDANCE =
  "When using a generic `CallDynamicTool` wrapper, pass `arguments` as a raw object, never as a quoted or JSON-stringified object. Emit the arguments as exactly one JSON object with balanced braces and brackets, and keep prose fields concise.";

/** Closing sentences: the prose turn after acceptance, and who advances the workflow. */
export const WORKFLOW_RESULT_INSTRUCTION_CLOSING =
  "Do not print the result as JSON in your final response. The backend decides when the workflow advances.";

/** ` and capability "…"`, or nothing. */
export function workflowResultCapabilityArgument(capability: string | undefined): string {
  return capability ? ` and capability ${JSON.stringify(capability)}` : "";
}

/**
 * One result slot's tools, as its instruction names them. A workflow kind
 * uses the shared tools (`submit_<kind>`, `validate_workflow_result`,
 * `get_workflow_result_status`); a graph node's output port uses its own
 * (`submit_<port>`, `validate_<port>`, `result_status`; item 105).
 */
export interface WorkflowResultSlotInstructionInput {
  /** What is submitted, in words: `review report`. */
  noun: string;
  submitTool: string;
  validateTool: string;
  statusTool: string;
  resultKey: string;
  capability?: string;
  /** Optional progress-channel guidance, appended before the closing (starts with a space). */
  progress?: string;
}

/** The result-tool instruction for one slot, as one system-instructions frame. */
export function workflowResultSlotInstruction(input: WorkflowResultSlotInstructionInput): string {
  const capabilityArgument = workflowResultCapabilityArgument(input.capability);
  return wrapSystemInstructions(
    `${WORKFLOW_RESULT_INSTRUCTION_PREAMBLE} Never call the submission tool with a probe, placeholder, partial draft, or transport test: the first accepted payload is final and cannot be replaced. If you need to check a completed payload before committing it, call \`${input.validateTool}\` with resultKey ${JSON.stringify(input.resultKey)}${capabilityArgument} and the complete ${input.noun} in \`result\`; validation is read-only. When validation accepts the payload it returns a \`validatedDigest\`: submit that exact payload by calling \`${input.submitTool}\` with the same resultKey${capabilityArgument} and \`validatedDigest\` instead of \`result\`, so the large object is sent only once. Otherwise, when your work is complete, call the Orkestrator \`${input.submitTool}\` tool with the same resultKey${capabilityArgument} and complete result. ${WORKFLOW_RESULT_ARGUMENT_GUIDANCE} ${WORKFLOW_RESULT_MALFORMED_CALL_GUIDANCE} If the submission tool rejects the result, correct only the reported contract problems and call it again. Only retry an accepted submission with the exact same payload. If delivery is uncertain, call \`${input.statusTool}\` with the same resultKey${capabilityArgument} before resubmitting.${input.progress ?? ""} After the tool accepts the result, finish with a concise prose response. ${WORKFLOW_RESULT_INSTRUCTION_CLOSING}`,
  );
}

export function workflowResultInstruction(
  kind: WorkflowResultKind,
  resultKey: string,
  options: {
    capability?: string;
    /** The attempt also takes `report_finding` (a Multi Review reviewer). */
    provisionalFindings?: boolean;
    /** A slot with its own tools (a graph output port): `submit_<port>` and `validate_<port>`. */
    tools?: { submit: string; validate: string };
  } = {},
): string {
  const capabilityArgument = workflowResultCapabilityArgument(options.capability);
  const findings =
    options.provisionalFindings && kind === "review-report"
      ? ` While you review, you are encouraged, but not required, to call \`${REPORT_FINDING_TOOL_NAME}\` with the same resultKey${capabilityArgument} and one finding in \`finding\` as soon as you are confident in it, using the fields of one entry of the report's \`issues\`. The user sees these findings as provisional progress while you work. Report each finding once, and carry on if a call is refused. They never replace your report: the report you submit must still list every finding, including the ones you already reported, and only that report counts.`
      : "";
  return workflowResultSlotInstruction({
    noun: kind.replaceAll("-", " "),
    submitTool: options.tools?.submit ?? workflowResultToolName(kind),
    validateTool: options.tools?.validate ?? WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    statusTool: "get_workflow_result_status",
    resultKey,
    ...(options.capability ? { capability: options.capability } : {}),
    progress: findings,
  });
}

/**
 * Backend-projected delivery state for one attempt's result slot.
 *
 * This is the only submission detail a renderer sees. It deliberately carries
 * no receipt id, digest, capability material, or diagnostic text.
 */
export type WorkflowResultSubmissionState =
  "preparing" | "correcting" | "received" | "needs-attention";

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
