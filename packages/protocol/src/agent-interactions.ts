/**
 * Provider-neutral coordination contract for blocking agent interactions.
 *
 * This is deliberately a presentation and policy contract, not a replacement
 * for provider wire formats. Bridges retain the exact upstream payload,
 * generation identity and response mapper in {@link AgentInteractionAdapterRequest}.
 */

export const AGENT_INTERACTION_CONTRACT_VERSION = 1 as const;
export const AGENT_INTERACTION_POLICY_VERSION = 1 as const;
export const AGENT_INTERACTION_JOURNAL_VERSION = 1 as const;
export const AGENT_INTERACTION_SUMMARY_VERSION = 1 as const;

export const AGENT_INTERACTION_LIMITS = Object.freeze({
  maxPendingRequests: 64,
  maxQuestionsPerRequest: 16,
  maxOptionsPerQuestion: 32,
  maxTextLength: 16_384,
  maxAnswerCount: 16,
  maxFreeTextBytes: 16_384,
  maxSerializedPayloadBytes: 256 * 1024,
  maxIdLength: 512,
  maxProviderValueLength: 4_096,
  maxJournalEntries: 512,
  maxWorkflowSummaries: 64,
} as const);

/** Terminal journal records are retained for seven days during normal cleanup. */
export const AGENT_INTERACTION_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const AGENT_INTERACTION_PROVIDERS = [
  "claude",
  "opencode",
  "codex",
] as const;
export type AgentInteractionProvider =
  (typeof AGENT_INTERACTION_PROVIDERS)[number];

export const AGENT_INTERACTION_KINDS = [
  "question",
  "plan-approval",
  "command-approval",
  "file-approval",
  "permission",
  "mcp-form",
  "mcp-url",
  "elicitation",
  "terminal-selection",
] as const;
export type AgentInteractionKind = (typeof AGENT_INTERACTION_KINDS)[number];

export const AGENT_INTERACTION_ORIGINS = [
  "interactive-native",
  "interactive-tmux",
  "build-pipeline",
  "looped-review",
] as const;
export type AgentInteractionOrigin = (typeof AGENT_INTERACTION_ORIGINS)[number];

export const AGENT_INTERACTION_STATES = [
  "pending",
  "answering",
  "resolved",
  "declined",
  "denied",
  "cancelled",
  "withdrawn",
  "expired",
  "failed",
] as const;
export type AgentInteractionState = (typeof AGENT_INTERACTION_STATES)[number];

export const AGENT_INTERACTION_RESOLUTION_ACTIONS = [
  "answer",
  "decline",
  "deny",
  "cancel",
] as const;
export type AgentInteractionResolutionAction =
  (typeof AGENT_INTERACTION_RESOLUTION_ACTIONS)[number];

export const AGENT_INTERACTION_APPLY_RESULTS = [
  "applied",
  "stale",
  "already-resolved",
  "rejected",
  "provider-unavailable",
] as const;
export type AgentInteractionApplyResult =
  (typeof AGENT_INTERACTION_APPLY_RESULTS)[number];

export interface AgentInteractionOption {
  /** Stable identity submitted by clients. */
  id: string;
  label: string;
  /** Exact value supplied to the provider by its adapter; never inferred from label. */
  providerValue: string;
  description?: string;
}

export interface AgentInteractionQuestion {
  id: string;
  prompt: string;
  description?: string;
  required: boolean;
  multiple: boolean;
  /** Secret values may only travel in a live provider response. */
  secret: boolean;
  allowFreeText: boolean;
  options: AgentInteractionOption[];
}

export interface AgentInteractionPresentation {
  title: string;
  body?: string;
  questions: AgentInteractionQuestion[];
  /** Presented only to the user. Content-free serializers always omit it. */
  url?: string;
  confirmLabel?: string;
  declineLabel?: string;
}

export interface AgentInteractionRequest {
  version: typeof AGENT_INTERACTION_CONTRACT_VERSION;
  /** Opaque, stable for this upstream request's lifetime. */
  id: string;
  provider: AgentInteractionProvider;
  kind: AgentInteractionKind;
  origin: AgentInteractionOrigin;
  sessionId: string;
  state: AgentInteractionState;
  revision: number;
  presentation: AgentInteractionPresentation;
  /** Authority-owned absolute epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  /** Absent only when the authority publishes no deadline. */
  expiresAt?: number;
}

export interface AgentInteractionSnapshot {
  version: typeof AGENT_INTERACTION_CONTRACT_VERSION;
  revision: number;
  requests: AgentInteractionRequest[];
}

export interface AgentInteractionQuestionAnswer {
  questionId: string;
  optionIds?: string[];
  freeText?: string;
}

export interface AgentInteractionAnswer {
  version: typeof AGENT_INTERACTION_CONTRACT_VERSION;
  interactionId: string;
  sessionId: string;
  answers: AgentInteractionQuestionAnswer[];
}

export interface AgentInteractionResolution {
  version: typeof AGENT_INTERACTION_CONTRACT_VERSION;
  interactionId: string;
  sessionId: string;
  action: AgentInteractionResolutionAction;
  answer?: AgentInteractionAnswer;
  resolvedAt: number;
}

export interface AgentInteractionApplyOutcome {
  result: AgentInteractionApplyResult;
  interactionId: string;
  sessionId: string;
  revision: number;
}

/**
 * Adapter-only identity and exact upstream payload. It must not be copied into
 * presentation snapshots, workflow summaries, logs, telemetry, or journals.
 */
export interface AgentInteractionAdapterRequest<TPayload = unknown> {
  interactionId: string;
  provider: AgentInteractionProvider;
  providerRequestId: string;
  providerSessionId: string;
  generation?: string | number;
  threadId?: string;
  itemId?: string;
  payload: TPayload;
}

export type AgentInteractionPolicyMode = "interactive" | "unattended";
export type AgentInteractionPolicyAction =
  | "await-user"
  | "decline-and-continue"
  | "deny-and-fail";

export interface AgentInteractionPolicy {
  version: typeof AGENT_INTERACTION_POLICY_VERSION;
  mode: AgentInteractionPolicyMode;
  input: AgentInteractionPolicyAction;
  authorization: AgentInteractionPolicyAction;
  unknown: "deny-and-fail";
}

export const INTERACTIVE_AGENT_INTERACTION_POLICY: AgentInteractionPolicy =
  Object.freeze({
    version: AGENT_INTERACTION_POLICY_VERSION,
    mode: "interactive",
    input: "await-user",
    authorization: "await-user",
    unknown: "deny-and-fail",
  });

export const UNATTENDED_AGENT_INTERACTION_POLICY: AgentInteractionPolicy =
  Object.freeze({
    version: AGENT_INTERACTION_POLICY_VERSION,
    mode: "unattended",
    input: "decline-and-continue",
    authorization: "deny-and-fail",
    unknown: "deny-and-fail",
  });

export const AGENT_INTERACTION_JOURNAL_STATES = [
  "claimed",
  "provider-resolved",
  "workflow-recorded",
] as const;
export type AgentInteractionJournalState =
  (typeof AGENT_INTERACTION_JOURNAL_STATES)[number];

export const AGENT_INTERACTION_OUTCOMES = [
  "answered",
  "auto-declined",
  "denied",
  "cancelled",
  "withdrawn",
  "expired",
  "failed",
  "stale",
] as const;
export type AgentInteractionOutcome = (typeof AGENT_INTERACTION_OUTCOMES)[number];

export interface AgentInteractionResolutionClaim {
  workflowType: "build-pipeline" | "looped-review";
  workflowId: string;
  phase: string;
  /** Pipeline/review revision or generation fencing this claim. */
  fence: string | number;
  claimedAt: number;
}

export interface AgentInteractionResolutionJournalEntry {
  id: string;
  interactionId: string;
  provider: AgentInteractionProvider;
  kind: AgentInteractionKind;
  sessionId: string;
  state: AgentInteractionJournalState;
  claim: AgentInteractionResolutionClaim;
  outcome?: AgentInteractionOutcome;
  providerResolvedAt?: number;
  workflowRecordedAt?: number;
}

export interface AgentInteractionResolutionJournal {
  version: typeof AGENT_INTERACTION_JOURNAL_VERSION;
  entries: AgentInteractionResolutionJournalEntry[];
}

export interface AgentInteractionWorkflowSummaryEntry {
  provider: AgentInteractionProvider;
  kind: AgentInteractionKind;
  phase: string;
  sessionId: string;
  firstSeenAt: number;
  lastResolvedAt?: number;
  outcome: AgentInteractionOutcome;
  count: number;
}

export interface AgentInteractionWorkflowSummary {
  version: typeof AGENT_INTERACTION_SUMMARY_VERSION;
  entries: AgentInteractionWorkflowSummaryEntry[];
}

const INPUT_KINDS = new Set<AgentInteractionKind>([
  "question",
  "mcp-form",
  "mcp-url",
  "elicitation",
  "terminal-selection",
]);
const AUTHORIZATION_KINDS = new Set<AgentInteractionKind>([
  "plan-approval",
  "command-approval",
  "file-approval",
  "permission",
]);
const PROVIDERS = new Set<string>(AGENT_INTERACTION_PROVIDERS);
const KINDS = new Set<string>(AGENT_INTERACTION_KINDS);
const ORIGINS = new Set<string>(AGENT_INTERACTION_ORIGINS);
const STATES = new Set<string>(AGENT_INTERACTION_STATES);
const RESOLUTION_ACTIONS = new Set<string>(
  AGENT_INTERACTION_RESOLUTION_ACTIONS,
);
const APPLY_RESULTS = new Set<string>(AGENT_INTERACTION_APPLY_RESULTS);
const JOURNAL_STATES = new Set<string>(AGENT_INTERACTION_JOURNAL_STATES);
const OUTCOMES = new Set<string>(AGENT_INTERACTION_OUTCOMES);
const POLICY_ACTIONS = new Set<string>([
  "await-user",
  "decline-and-continue",
  "deny-and-fail",
]);
const TERMINAL_JOURNAL_STATE: AgentInteractionJournalState = "workflow-recorded";

const REQUEST_KEYS = new Set([
  "version", "id", "provider", "kind", "origin", "sessionId", "state",
  "revision", "presentation", "createdAt", "updatedAt", "expiresAt",
]);
const PRESENTATION_KEYS = new Set([
  "title", "body", "questions", "url", "confirmLabel", "declineLabel",
]);
const QUESTION_KEYS = new Set([
  "id", "prompt", "description", "required", "multiple", "secret",
  "allowFreeText", "options",
]);
const OPTION_KEYS = new Set(["id", "label", "providerValue", "description"]);
const ANSWER_KEYS = new Set([
  "version", "interactionId", "sessionId", "answers",
]);
const QUESTION_ANSWER_KEYS = new Set(["questionId", "optionIds", "freeText"]);
const RESOLUTION_KEYS = new Set([
  "version", "interactionId", "sessionId", "action", "answer", "resolvedAt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function isBoundedString(
  value: unknown,
  max: number = AGENT_INTERACTION_LIMITS.maxTextLength,
): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isOptionalBoundedString(value: unknown, max?: number): value is string | undefined {
  return value === undefined || isBoundedString(value, max);
}

function isId(value: unknown): value is string {
  return isBoundedString(value, AGENT_INTERACTION_LIMITS.maxIdLength);
}

function isEpochMilliseconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function serializedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isWithinSerializedLimit(value: unknown): boolean {
  return serializedBytes(value) <= AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes;
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isOption(value: unknown): value is AgentInteractionOption {
  if (!isRecord(value) || !hasOnlyKeys(value, OPTION_KEYS)) return false;
  return isId(value.id)
    && isBoundedString(value.label)
    && isBoundedString(
      value.providerValue,
      AGENT_INTERACTION_LIMITS.maxProviderValueLength,
    )
    && isOptionalBoundedString(value.description);
}

function isQuestion(value: unknown): value is AgentInteractionQuestion {
  if (!isRecord(value) || !hasOnlyKeys(value, QUESTION_KEYS)) return false;
  if (
    !isId(value.id)
    || !isBoundedString(value.prompt)
    || !isOptionalBoundedString(value.description)
    || typeof value.required !== "boolean"
    || typeof value.multiple !== "boolean"
    || typeof value.secret !== "boolean"
    || typeof value.allowFreeText !== "boolean"
    || !Array.isArray(value.options)
    || value.options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
    || !value.options.every(isOption)
  ) {
    return false;
  }
  const optionIds = value.options.map((option) => option.id);
  return hasUniqueStrings(optionIds)
    && (value.options.length > 0 || value.allowFreeText);
}

function isPresentation(
  value: unknown,
  kind: AgentInteractionKind,
): value is AgentInteractionPresentation {
  if (!isRecord(value) || !hasOnlyKeys(value, PRESENTATION_KEYS)) return false;
  if (
    !isBoundedString(value.title)
    || !isOptionalBoundedString(value.body)
    || !isOptionalBoundedString(value.url)
    || !isOptionalBoundedString(value.confirmLabel)
    || !isOptionalBoundedString(value.declineLabel)
    || !Array.isArray(value.questions)
    || value.questions.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest
    || !value.questions.every(isQuestion)
  ) {
    return false;
  }
  const questionIds = value.questions.map((question) => question.id);
  if (!hasUniqueStrings(questionIds)) return false;
  if (kind === "mcp-url" && !isBoundedString(value.url)) return false;
  if (
    (kind === "question" || kind === "mcp-form" || kind === "terminal-selection")
    && value.questions.length === 0
  ) {
    return false;
  }
  return true;
}

export function isAgentInteractionRequest(
  value: unknown,
): value is AgentInteractionRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, REQUEST_KEYS)) return false;
  if (
    value.version !== AGENT_INTERACTION_CONTRACT_VERSION
    || !isId(value.id)
    || typeof value.provider !== "string"
    || !PROVIDERS.has(value.provider)
    || typeof value.kind !== "string"
    || !KINDS.has(value.kind)
    || typeof value.origin !== "string"
    || !ORIGINS.has(value.origin)
    || !isId(value.sessionId)
    || typeof value.state !== "string"
    || !STATES.has(value.state)
    || !isNonNegativeInteger(value.revision)
    || !isEpochMilliseconds(value.createdAt)
    || !isEpochMilliseconds(value.updatedAt)
    || value.updatedAt < value.createdAt
    || (value.expiresAt !== undefined
      && (!isEpochMilliseconds(value.expiresAt) || value.expiresAt <= value.createdAt))
  ) {
    return false;
  }
  return isPresentation(value.presentation, value.kind as AgentInteractionKind)
    && isWithinSerializedLimit(value);
}

export function isAgentInteractionSnapshot(
  value: unknown,
): value is AgentInteractionSnapshot {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, new Set(["version", "revision", "requests"]))
    || value.version !== AGENT_INTERACTION_CONTRACT_VERSION
    || !isNonNegativeInteger(value.revision)
    || !Array.isArray(value.requests)
    || value.requests.length > AGENT_INTERACTION_LIMITS.maxPendingRequests
    || !value.requests.every(isAgentInteractionRequest)
  ) {
    return false;
  }
  return hasUniqueStrings(value.requests.map((request) => request.id))
    && isWithinSerializedLimit(value);
}

function isQuestionAnswer(value: unknown): value is AgentInteractionQuestionAnswer {
  if (!isRecord(value) || !hasOnlyKeys(value, QUESTION_ANSWER_KEYS)) return false;
  return isId(value.questionId)
    && (value.optionIds === undefined
      || (Array.isArray(value.optionIds)
        && value.optionIds.length <= AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
        && value.optionIds.every(isId)
        && hasUniqueStrings(value.optionIds)))
    && (value.freeText === undefined
      || (typeof value.freeText === "string"
        && new TextEncoder().encode(value.freeText).byteLength > 0
        && new TextEncoder().encode(value.freeText).byteLength
          <= AGENT_INTERACTION_LIMITS.maxFreeTextBytes))
    && ((value.optionIds?.length ?? 0) > 0 || value.freeText !== undefined);
}

/** Validates identity, option references, required answers, and all size bounds. */
export function isAgentInteractionAnswer(
  value: unknown,
  request: AgentInteractionRequest,
): value is AgentInteractionAnswer {
  if (!isAgentInteractionRequest(request)) return false;
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ANSWER_KEYS)
    || value.version !== AGENT_INTERACTION_CONTRACT_VERSION
    || value.interactionId !== request.id
    || value.sessionId !== request.sessionId
    || !Array.isArray(value.answers)
    || value.answers.length > AGENT_INTERACTION_LIMITS.maxAnswerCount
    || !value.answers.every(isQuestionAnswer)
  ) {
    return false;
  }

  const answers = value.answers as AgentInteractionQuestionAnswer[];
  if (!hasUniqueStrings(answers.map((answer) => answer.questionId))) return false;
  const answerByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  for (const question of request.presentation.questions) {
    const answer = answerByQuestion.get(question.id);
    if (!answer) {
      if (question.required) return false;
      continue;
    }
    if (!question.allowFreeText && answer.freeText !== undefined) return false;
    if (!question.multiple && (answer.optionIds?.length ?? 0) > 1) return false;
    const optionIds = new Set(question.options.map((option) => option.id));
    if (answer.optionIds?.some((id) => !optionIds.has(id))) return false;
  }
  if (answers.some((answer) => !request.presentation.questions.some(
    (question) => question.id === answer.questionId,
  ))) {
    return false;
  }
  return isWithinSerializedLimit(value);
}

export function isAgentInteractionResolution(
  value: unknown,
  request: AgentInteractionRequest,
): value is AgentInteractionResolution {
  if (
    !isAgentInteractionRequest(request)
    || !isRecord(value)
    || !hasOnlyKeys(value, RESOLUTION_KEYS)
    || value.version !== AGENT_INTERACTION_CONTRACT_VERSION
    || value.interactionId !== request.id
    || value.sessionId !== request.sessionId
    || typeof value.action !== "string"
    || !RESOLUTION_ACTIONS.has(value.action)
    || !isEpochMilliseconds(value.resolvedAt)
    || value.resolvedAt < request.createdAt
  ) {
    return false;
  }
  if (value.action === "answer") {
    return isAgentInteractionAnswer(value.answer, request)
      && isWithinSerializedLimit(value);
  }
  return value.answer === undefined && isWithinSerializedLimit(value);
}

export function isAgentInteractionApplyOutcome(
  value: unknown,
): value is AgentInteractionApplyOutcome {
  return isRecord(value)
    && hasOnlyKeys(value, new Set(["result", "interactionId", "sessionId", "revision"]))
    && typeof value.result === "string"
    && APPLY_RESULTS.has(value.result)
    && isId(value.interactionId)
    && isId(value.sessionId)
    && isNonNegativeInteger(value.revision);
}

export function isAgentInteractionPolicy(
  value: unknown,
): value is AgentInteractionPolicy {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, new Set([
      "version", "mode", "input", "authorization", "unknown",
    ]))
    || value.version !== AGENT_INTERACTION_POLICY_VERSION
    || (value.mode !== "interactive" && value.mode !== "unattended")
    || typeof value.input !== "string"
    || !POLICY_ACTIONS.has(value.input)
    || typeof value.authorization !== "string"
    || !POLICY_ACTIONS.has(value.authorization)
    || value.unknown !== "deny-and-fail"
  ) {
    return false;
  }
  return value.mode === "interactive"
    ? value.input === "await-user" && value.authorization === "await-user"
    : value.input === "decline-and-continue"
      && value.authorization === "deny-and-fail";
}

export function agentInteractionPolicyAction(
  policy: AgentInteractionPolicy,
  kind: unknown,
): AgentInteractionPolicyAction {
  if (!isAgentInteractionPolicy(policy) || typeof kind !== "string" || !KINDS.has(kind)) {
    return "deny-and-fail";
  }
  if (INPUT_KINDS.has(kind as AgentInteractionKind)) return policy.input;
  if (AUTHORIZATION_KINDS.has(kind as AgentInteractionKind)) {
    return policy.authorization;
  }
  return policy.unknown;
}

function isResolutionClaim(value: unknown): value is AgentInteractionResolutionClaim {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set([
    "workflowType", "workflowId", "phase", "fence", "claimedAt",
  ]))) return false;
  return (value.workflowType === "build-pipeline" || value.workflowType === "looped-review")
    && isId(value.workflowId)
    && isBoundedString(value.phase, 256)
    && ((typeof value.fence === "string" && isId(value.fence))
      || isNonNegativeInteger(value.fence))
    && isEpochMilliseconds(value.claimedAt);
}

function isJournalEntry(value: unknown): value is AgentInteractionResolutionJournalEntry {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set([
    "id", "interactionId", "provider", "kind", "sessionId", "state", "claim",
    "outcome", "providerResolvedAt", "workflowRecordedAt",
  ]))) return false;
  if (
    !isId(value.id)
    || !isId(value.interactionId)
    || typeof value.provider !== "string"
    || !PROVIDERS.has(value.provider)
    || typeof value.kind !== "string"
    || !KINDS.has(value.kind)
    || !isId(value.sessionId)
    || typeof value.state !== "string"
    || !JOURNAL_STATES.has(value.state)
    || !isResolutionClaim(value.claim)
    || (value.outcome !== undefined
      && (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)))
    || (value.providerResolvedAt !== undefined
      && !isEpochMilliseconds(value.providerResolvedAt))
    || (value.workflowRecordedAt !== undefined
      && !isEpochMilliseconds(value.workflowRecordedAt))
  ) return false;

  if (value.state === "claimed") {
    return value.outcome === undefined
      && value.providerResolvedAt === undefined
      && value.workflowRecordedAt === undefined;
  }
  if (value.outcome === undefined || value.providerResolvedAt === undefined) return false;
  if (value.providerResolvedAt < value.claim.claimedAt) return false;
  if (value.state === "provider-resolved") return value.workflowRecordedAt === undefined;
  return value.workflowRecordedAt !== undefined
    && value.workflowRecordedAt >= value.providerResolvedAt;
}

export function isAgentInteractionResolutionJournal(
  value: unknown,
): value is AgentInteractionResolutionJournal {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, new Set(["version", "entries"]))
    || value.version !== AGENT_INTERACTION_JOURNAL_VERSION
    || !Array.isArray(value.entries)
    || value.entries.length > AGENT_INTERACTION_LIMITS.maxJournalEntries
    || !value.entries.every(isJournalEntry)
  ) return false;
  const entries = value.entries as AgentInteractionResolutionJournalEntry[];
  return hasUniqueStrings(entries.map((entry) => entry.id))
    && hasUniqueStrings(entries.map((entry) => `${entry.sessionId}\0${entry.interactionId}`))
    && isWithinSerializedLimit(value);
}

function isWorkflowSummaryEntry(value: unknown): value is AgentInteractionWorkflowSummaryEntry {
  return isRecord(value)
    && hasOnlyKeys(value, new Set([
      "provider", "kind", "phase", "sessionId", "firstSeenAt",
      "lastResolvedAt", "outcome", "count",
    ]))
    && typeof value.provider === "string"
    && PROVIDERS.has(value.provider)
    && typeof value.kind === "string"
    && KINDS.has(value.kind)
    && isBoundedString(value.phase, 256)
    && isId(value.sessionId)
    && isEpochMilliseconds(value.firstSeenAt)
    && (value.lastResolvedAt === undefined
      || (isEpochMilliseconds(value.lastResolvedAt)
        && value.lastResolvedAt >= value.firstSeenAt))
    && typeof value.outcome === "string"
    && OUTCOMES.has(value.outcome)
    && Number.isSafeInteger(value.count)
    && (value.count as number) > 0;
}

export function isAgentInteractionWorkflowSummary(
  value: unknown,
): value is AgentInteractionWorkflowSummary {
  return isRecord(value)
    && hasOnlyKeys(value, new Set(["version", "entries"]))
    && value.version === AGENT_INTERACTION_SUMMARY_VERSION
    && Array.isArray(value.entries)
    && value.entries.length <= AGENT_INTERACTION_LIMITS.maxWorkflowSummaries
    && value.entries.every(isWorkflowSummaryEntry)
    && isWithinSerializedLimit(value);
}

/** Normal cleanup preserves every unfinished claim and bounds terminal history. */
export function pruneAgentInteractionResolutionJournal(
  journal: AgentInteractionResolutionJournal,
  now = Date.now(),
): AgentInteractionResolutionJournal {
  if (!isAgentInteractionResolutionJournal(journal) || !isEpochMilliseconds(now)) {
    throw new Error("Invalid interaction resolution journal cleanup input");
  }
  const cutoff = now - AGENT_INTERACTION_JOURNAL_RETENTION_MS;
  const unfinished = journal.entries.filter(
    (entry) => entry.state !== TERMINAL_JOURNAL_STATE,
  );
  const terminal = journal.entries
    .filter((entry) => entry.state === TERMINAL_JOURNAL_STATE)
    .filter((entry) => (entry.workflowRecordedAt ?? 0) >= cutoff)
    .sort((a, b) => (b.workflowRecordedAt ?? 0) - (a.workflowRecordedAt ?? 0));
  const available = Math.max(
    0,
    AGENT_INTERACTION_LIMITS.maxJournalEntries - unfinished.length,
  );
  return {
    version: AGENT_INTERACTION_JOURNAL_VERSION,
    entries: [...unfinished, ...terminal.slice(0, available)],
  };
}

function assertSerializable(value: unknown, label: string): string {
  const bytes = serializedBytes(value);
  if (bytes > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes) {
    throw new Error(`${label} exceeds the serialized interaction payload limit`);
  }
  return JSON.stringify(value);
}

/**
 * The only app-owned answer persistence format. Secret-bearing answers are
 * categorically rejected rather than relying on callers to remember to redact.
 */
export function serializeAgentInteractionDraft(
  request: AgentInteractionRequest,
  answer: AgentInteractionAnswer,
): string {
  if (!isAgentInteractionAnswer(answer, request)) {
    throw new Error("Invalid interaction draft answer");
  }
  const secretQuestionIds = new Set(
    request.presentation.questions
      .filter((question) => question.secret)
      .map((question) => question.id),
  );
  if (answer.answers.some((item) => secretQuestionIds.has(item.questionId))) {
    throw new Error("Secret interaction answers cannot be persisted as drafts");
  }
  return assertSerializable(answer, "Interaction draft");
}

/** Content-free transcript marker; exact answer content remains provider-owned. */
export function serializeAgentInteractionTranscriptEvent(
  request: AgentInteractionRequest,
  resolution: AgentInteractionResolution,
): string {
  if (!isAgentInteractionResolution(resolution, request)) {
    throw new Error("Invalid interaction transcript resolution");
  }
  return assertSerializable({
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: request.id,
    provider: request.provider,
    kind: request.kind,
    origin: request.origin,
    sessionId: request.sessionId,
    action: resolution.action,
    resolvedAt: resolution.resolvedAt,
  }, "Interaction transcript event");
}

/** Content-free workflow/failure serializer. */
export function serializeAgentInteractionWorkflowSummary(
  summary: AgentInteractionWorkflowSummary,
): string {
  if (!isAgentInteractionWorkflowSummary(summary)) {
    throw new Error("Invalid interaction workflow summary");
  }
  return assertSerializable(summary, "Interaction workflow summary");
}

/** Content-free telemetry record: never add presentation, URL, or answer fields. */
export function serializeAgentInteractionTelemetry(
  request: AgentInteractionRequest,
  outcome: AgentInteractionOutcome,
): string {
  if (!isAgentInteractionRequest(request) || !OUTCOMES.has(outcome)) {
    throw new Error("Invalid interaction telemetry input");
  }
  return assertSerializable({
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    provider: request.provider,
    kind: request.kind,
    origin: request.origin,
    state: request.state,
    outcome,
  }, "Interaction telemetry");
}
