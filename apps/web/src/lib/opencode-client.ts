// OpenCode SDK client wrapper
// Provides typed functions for interacting with the OpenCode server

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { resolveGatewayLoopbackBaseUrl } from "./gateway-url";
import { isEditTool } from "./tool-names";
import { createUuid } from "./uuid";
import type {
  NativeMessage,
  NativeMessagePart,
  NativeToolDiffMetadata,
} from "./chat/native-message-types";
import {
  structuredOutputFailure,
  type JsonSchema,
  type StructuredOutputResult,
  StructuredOutputReadUnavailableError,
} from "@orkestrator/protocol/structured-output";
import {
  boundedOpenCodeMessageHistory,
  findOpenCodeMessageId,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  OpenCodeMessageIdCoordinator,
  openCodeRequestMarker,
} from "@orkestrator/protocol/opencode-message-id";
import type { ContextUsageSnapshot } from "./context-usage";

export { type OpencodeClient };

const PREFERRED_VARIANT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const INTERACTION_RECONCILIATION_TIMEOUT_MS = 5_000;

/**
 * Result of answering or dismissing an OpenCode blocking interaction.
 *
 * `gone` deliberately does not mean `applied`: an interaction can disappear
 * because it expired, another window answered it, or the server restarted.
 */
export type OpenCodeInteractionResponseResult =
  | "applied"
  | "pending"
  | "gone"
  | "unknown";

export interface OpenCodeModel {
  id: string;
  name: string;
  provider: string;
  /** Available model variants (e.g., low/high/xhigh) */
  variants?: string[];
  /** Input cost per token (0 means free) */
  inputCost?: number;
  /** Output cost per token (0 means free) */
  outputCost?: number;
  contextWindow?: number;
  /**
   * Whether the model accepts image input. Mirrors the SDK's
   * `capabilities.input.image`; `undefined` means the catalog did not report
   * it (assume the model may read images rather than blocking the attach).
   */
  supportsImageInput?: boolean;
}

export interface OpenCodeModelDefaults {
  modelId?: string;
  variant?: string;
}

export interface OpenCodeModelsResponse {
  models: OpenCodeModel[];
  defaults: OpenCodeModelDefaults;
}

const SELECTABLE_OPENCODE_PROVIDERS = new Set(["opencode", "opencode-go"]);

/**
 * Restrict Orkestrator's OpenCode picker to the two managed provider
 * catalogues. The raw SDK catalogue intentionally remains available to lower
 * level callers because it describes every provider known to OpenCode.
 */
export function restrictOpenCodeModelCatalog(
  response: OpenCodeModelsResponse,
): OpenCodeModelsResponse {
  const models = response.models.filter((model) =>
    SELECTABLE_OPENCODE_PROVIDERS.has(model.provider)
  );
  const defaultIsSelectable = response.defaults.modelId !== undefined
    && models.some((model) => model.id === response.defaults.modelId);
  return {
    models,
    defaults: defaultIsSelectable ? response.defaults : {},
  };
}

export interface OpenCodeSlashCommand {
  name: string;
  description?: string;
  hints?: string[];
}

function normalizeSlashCommandName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveDefaultModelId(defaultConfig: unknown): string | undefined {
  if (!defaultConfig || typeof defaultConfig !== "object") return undefined;

  const config = defaultConfig as Record<string, unknown>;

  const directModelId = config.model;
  if (typeof directModelId === "string" && directModelId.includes("/")) {
    return directModelId;
  }

  const nestedModel = config.model;
  if (nestedModel && typeof nestedModel === "object") {
    const nested = nestedModel as Record<string, unknown>;
    const providerID = nested.providerID;
    const modelID = nested.modelID;
    if (typeof providerID === "string" && typeof modelID === "string") {
      return `${providerID}/${modelID}`;
    }
  }

  const providerID = config.providerID;
  const modelID = config.modelID;
  if (typeof providerID === "string" && typeof modelID === "string") {
    return `${providerID}/${modelID}`;
  }

  const provider = config.provider;
  const model = config.model;
  if (typeof provider === "string" && typeof model === "string") {
    return `${provider}/${model}`;
  }

  return undefined;
}

function resolveDefaultVariant(defaultConfig: unknown): string | undefined {
  if (!defaultConfig || typeof defaultConfig !== "object") return undefined;

  const config = defaultConfig as Record<string, unknown>;

  if (typeof config.variant === "string") {
    return config.variant;
  }

  const nestedModel = config.model;
  if (nestedModel && typeof nestedModel === "object") {
    const nested = nestedModel as Record<string, unknown>;
    if (typeof nested.variant === "string") {
      return nested.variant;
    }
  }

  return undefined;
}

export type ToolDiffMetadata = NativeToolDiffMetadata;
export type OpenCodeMessagePart = NativeMessagePart;
export type OpenCodeMessage = NativeMessage & {
  /** Whether the SDK marked this assistant message as failed. Raw error data is intentionally not retained. */
  hasError?: boolean;
  /**
   * The error's discriminator (`MessageAbortedError`, …) when the SDK reported
   * one. Kept alongside {@link hasError} so an intentional interrupt can be
   * told apart from a real failure; the error payload itself is still dropped.
   */
  errorName?: string;
  /**
   * Provider finish reason reported by OpenCode's final `step-finish` part.
   *
   * OpenCode currently treats an unrecognized provider finish reason as
   * terminal even when the assistant produced reasoning but no final text.
   * Recovery for that incomplete outcome is backend-owned (the native agent
   * service inspects the authoritative transcript on the turn-end edge and
   * dispatches one continuation); the reason is kept here as display metadata.
   */
  finishReason?: string;
  providerUsage?: {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens?: number;
    modelId: string;
    agent?: string;
    durationMs?: number;
  };
};

export interface OpenCodeSession {
  id: string;
  title?: string;
  createdAt: string;
  /**
   * When the session was last touched.
   *
   * The resume picker orders on this. It used to order on `createdAt`, which
   * buried the session the user had most recently worked in. Falls back to
   * `createdAt` when the server does not report an update time.
   */
  updatedAt: string;
}

/** OpenCode conversation mode */
export type OpenCodeConversationMode = "plan" | "build";

/** Question option for multiple choice questions */
export interface QuestionOption {
  /** Display text (1-5 words, concise) */
  label: string;
  /** Longer description explaining the option */
  description?: string;
}

/** Question info structure */
export interface QuestionInfo {
  /** Complete question text */
  question: string;
  /** Very short label (max 12 chars) */
  header: string;
  /** Available choices */
  options: QuestionOption[];
  /** Allow selecting multiple choices */
  multiple?: boolean;
  /** Allow typing a custom answer (default: true) */
  custom?: boolean;
}

/** Question request from OpenCode */
export interface QuestionRequest {
  /** Request ID */
  id: string;
  /**
   * Session ID.
   *
   * Spelled `sessionId` to match Claude and Codex; the SDK's own wire field is
   * `sessionID` and is normalized at the boundary.
   */
  sessionId: string;
  /** Questions to ask */
  questions: QuestionInfo[];
  /** Associated tool info */
  tool?: {
    messageID: string;
    callID: string;
  };
}

/** Permission request from OpenCode */
export interface PermissionRequest {
  /** Request ID */
  id: string;
  /** Session ID. See `QuestionRequest.sessionId` on the spelling. */
  sessionId: string;
  /** Permission type (e.g. read, edit, bash) */
  permission: string;
  /** Requested path patterns */
  patterns: string[];
  /** Additional metadata from the tool invocation */
  metadata: Record<string, unknown>;
  /** Patterns that can be persisted with "always" */
  always: string[];
  /** Associated tool info */
  tool?: {
    messageID: string;
    callID: string;
  };
}

/**
 * Normalize the SDK's wire shape onto our request types.
 *
 * The only real difference is the session-id spelling: the SDK sends
 * `sessionID`, we store `sessionId` so all three agents agree. These used to be
 * blind casts, which is how the mismatch went unnoticed.
 */
function normalizeQuestionRequest(raw: unknown): QuestionRequest {
  const record = isRecord(raw) ? raw : {};
  return {
    ...(record as Omit<QuestionRequest, "sessionId">),
    sessionId: readSessionId(record),
  };
}

function normalizePermissionRequest(raw: unknown): PermissionRequest {
  const record = isRecord(raw) ? raw : {};
  return {
    ...(record as Omit<PermissionRequest, "sessionId">),
    sessionId: readSessionId(record),
  };
}

/** Accepts either spelling; the SDK has used both across versions. */
function readSessionId(record: Record<string, unknown>): string {
  for (const value of [record.sessionID, record.sessionId]) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

/** Answer to a question (array of selected labels or typed text) */
export type QuestionAnswer = string[];

/** Reply to a permission request */
export type PermissionReply = "once" | "always" | "reject";

/** Prefix for client-side error message IDs (used to preserve errors across message refreshes) */
export const ERROR_MESSAGE_PREFIX = "error-";

/** Prefix for client-side system message IDs (used to preserve system messages across message refreshes) */
export const SYSTEM_MESSAGE_PREFIX = "system-";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return undefined;
}

function toDisplayString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_KEY_FRAGMENTS = [
  "authorization",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "cookie",
  "credential",
  "privatekey",
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/=]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, `$1${REDACTED_VALUE}`);
}

function redactSensitiveData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, seen));
  }

  if (isRecord(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);

    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        redacted[key] = REDACTED_VALUE;
        continue;
      }

      redacted[key] = redactSensitiveData(child, seen);
    }

    return redacted;
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  return value;
}

function safeJSONStringify(value: unknown, maxLength = 4000): string | undefined {
  try {
    const sanitized = redactSensitiveData(value);
    const json = JSON.stringify(sanitized, null, 2);
    if (!json || json === "{}") {
      return undefined;
    }

    if (json.length <= maxLength) {
      return json;
    }

    return `${json.slice(0, maxLength)}\n... (details truncated)`;
  } catch {
    return undefined;
  }
}

/** Format OpenCode/SDK errors into a user-readable detailed message. */
export function formatOpenCodeError(error: unknown): string {
  if (typeof error === "string") {
    return redactSensitiveText(error);
  }

  const fallbackFromError = error instanceof Error
    ? firstNonEmptyString([error.message, error.name])
    : undefined;

  if (!isRecord(error)) {
    return fallbackFromError || "An unknown error occurred";
  }

  const data = isRecord(error.data) ? error.data : undefined;
  const summary = firstNonEmptyString([
    data?.message,
    data?.detail,
    data?.error,
    error.message,
    error.detail,
    error.error,
  ]);
  const errorType = firstNonEmptyString([
    data?.errorType,
    data?.type,
    error.errorType,
    error.type,
    error.name,
  ]);

  let headline = summary || errorType || fallbackFromError || "An unknown error occurred";
  if (summary && errorType && !summary.toLowerCase().includes(errorType.toLowerCase())) {
    headline = `${errorType}: ${summary}`;
  }
  headline = redactSensitiveText(headline);

  const detailLines: string[] = [];
  const code = toDisplayString(data?.code ?? error.code);
  const status = toDisplayString(data?.status ?? data?.statusCode ?? error.status ?? error.statusCode);
  const requestId = firstNonEmptyString([
    data?.requestID,
    data?.requestId,
    error.requestID,
    error.requestId,
  ]);

  if (code) {
    detailLines.push(`Code: ${code}`);
  }
  if (status) {
    detailLines.push(`Status: ${status}`);
  }
  if (requestId) {
    detailLines.push(`Request ID: ${requestId}`);
  }

  const rawDetails = safeJSONStringify(error);
  if (rawDetails) {
    detailLines.push(`Raw error:\n${rawDetails}`);
  }

  if (detailLines.length === 0) {
    return headline;
  }

  return `${headline}\n\n${detailLines.join("\n")}`;
}

/** The SDK's `NamedError` discriminator for an intentionally interrupted turn. */
const OPENCODE_MESSAGE_ABORTED_ERROR = "MessageAbortedError";

/**
 * True when OpenCode is reporting an intentionally interrupted turn.
 *
 * Matches the `name` discriminator only. The abort is also reported as an
 * `Error` instance on some paths, so `name` is read through the prototype
 * chain rather than requiring an own property. A payload that merely quotes
 * the string in its message is a real failure and must not match.
 */
export function isOpenCodeMessageAbortedError(error: unknown): boolean {
  return isRecord(error) && error.name === OPENCODE_MESSAGE_ABORTED_ERROR;
}

function openCodeResponseError(operation: string, error: unknown): Error {
  if (error === undefined || error === null) {
    return new Error(operation);
  }

  return new Error(`${operation}: ${formatOpenCodeError(error)}`);
}

/** Structure for filediff metadata from the SDK */
interface FileDiffMetadata {
  file?: string;
  before?: string;
  after?: string;
}

function stringifyToolPayload(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseOpenCodeCreatedAt(value: unknown): string {
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return new Date().toISOString();
}

function isOpenCodeTaskTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "task" || normalized === "agent";
}

function stringRecordValue(
  value: unknown,
  ...keys: string[]
): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function parseTaskEnvelope(output: string | undefined): {
  sessionId?: string;
  state?: "running" | "completed" | "error";
} {
  if (!output) return {};
  const match = output.match(
    /<task\s+id=["']([^"']+)["'](?:\s+state=["'](running|completed|error)["'])?/i,
  );
  if (!match) return {};
  return {
    sessionId: match[1],
    state: match[2]?.toLowerCase() as "running" | "completed" | "error" | undefined,
  };
}

function countOpenCodeToolActions(parts: OpenCodeMessagePart[]): number {
  let count = 0;
  for (const part of parts) {
    if (part.type === "tool-invocation") count++;
    if (part.type === "subagent" && part.subagentActions) {
      count += countOpenCodeToolActions(part.subagentActions);
    }
  }
  return count;
}

function flattenOpenCodeSubagentActions(messages: OpenCodeMessage[]): OpenCodeMessagePart[] {
  return messages.flatMap((message) =>
    message.role === "assistant" ? message.parts : [],
  );
}

function mapOpenCodeParts(
  parts: OpenCodeMessagePart[],
  mapper: (part: OpenCodeMessagePart) => OpenCodeMessagePart,
): { parts: OpenCodeMessagePart[]; changed: boolean } {
  let changed = false;
  const nextParts = parts.map((part) => {
    let nextPart = part;
    if (part.type === "subagent" && part.subagentActions?.length) {
      const nested = mapOpenCodeParts(part.subagentActions, mapper);
      if (nested.changed) {
        nextPart = { ...part, subagentActions: nested.parts };
      }
    }
    nextPart = mapper(nextPart);
    if (nextPart !== part) changed = true;
    return nextPart;
  });
  return { parts: changed ? nextParts : parts, changed };
}

/** Return true when a transcript contains an OpenCode Task backed by this child session. */
export function hasOpenCodeSubagentSession(
  messages: OpenCodeMessage[],
  childSessionId: string,
): boolean {
  return messages.some((message) => {
    let found = false;
    mapOpenCodeParts(message.parts, (part) => {
      if (part.type === "subagent" && part.subagentId === childSessionId) {
        found = true;
      }
      return part;
    });
    return found;
  });
}

/**
 * Attach an authoritative child-session transcript to every matching Task part.
 * Nested Tasks are traversed as well, so child SSE events can update their
 * corresponding yellow Agent row without rebuilding the parent transcript.
 */
export function mergeOpenCodeSubagentTranscript(
  messages: OpenCodeMessage[],
  childSessionId: string,
  childMessages: OpenCodeMessage[],
  state?: "success" | "failure" | "pending",
): OpenCodeMessage[] {
  const actions = flattenOpenCodeSubagentActions(childMessages);
  const actionCount = countOpenCodeToolActions(actions);
  let changed = false;

  const nextMessages = messages.map((message) => {
    const mapped = mapOpenCodeParts(message.parts, (part) => {
      if (part.type !== "subagent" || part.subagentId !== childSessionId) {
        return part;
      }
      const nextState =
        state === "failure" || part.toolState === "failure"
          ? "failure"
          : part.toolState === "success"
            ? "success"
            : state ?? part.toolState;
      return {
        ...part,
        toolState: nextState,
        subagentActions: actions,
        subagentActionCount: actionCount,
      };
    });
    if (!mapped.changed) return message;
    changed = true;
    return { ...message, parts: mapped.parts };
  });

  return changed ? nextMessages : messages;
}

/**
 * Per-message and per-transcript caches for {@link collectOpenCodeSubagentIds}.
 *
 * Messages and transcript arrays are replaced (never mutated) by the stores, so
 * a WeakMap keyed on the object reference is a correct cache: a streaming tick
 * replaces exactly one message object and the surrounding array, which means a
 * lookup re-scans only the message that actually changed instead of deep
 * traversing every part of every message of every session per SSE frame.
 */
const transcriptSubagentIdsCache = new WeakMap<
  readonly OpenCodeMessage[],
  ReadonlySet<string>
>();
const messageSubagentIdsCache = new WeakMap<OpenCodeMessage, readonly string[]>();

/**
 * Collect every child session id referenced by a Task part in this transcript.
 *
 * O(1) amortized per call thanks to reference-keyed caching — see the cache
 * comment above. Use this instead of {@link hasOpenCodeSubagentSession} on hot
 * paths such as per-event routing.
 */
export function collectOpenCodeSubagentIds(
  messages: OpenCodeMessage[],
): ReadonlySet<string> {
  const cached = transcriptSubagentIdsCache.get(messages);
  if (cached) return cached;

  const ids = new Set<string>();
  for (const message of messages) {
    let messageIds = messageSubagentIdsCache.get(message);
    if (!messageIds) {
      const collected: string[] = [];
      mapOpenCodeParts(message.parts, (part) => {
        if (part.type === "subagent" && part.subagentId) {
          collected.push(part.subagentId);
        }
        return part;
      });
      messageIds = collected;
      messageSubagentIdsCache.set(message, messageIds);
    }
    for (const id of messageIds) ids.add(id);
  }
  transcriptSubagentIdsCache.set(messages, ids);
  return ids;
}

/**
 * Apply a `message.updated` event payload (`properties.info`) to an existing
 * message without refetching the transcript.
 *
 * The event carries only message-level metadata — role, error flag, token
 * usage — never parts; those stream separately via `message.part.updated`.
 * Returns null when the payload has no usable identity, in which case the
 * caller must fall back to an authoritative refetch.
 */
export function mergeOpenCodeMessageInfo(
  existing: OpenCodeMessage | undefined,
  rawInfo: unknown,
): OpenCodeMessage | null {
  const info = rawInfo as { id?: unknown } | null | undefined;
  if (!info || typeof info !== "object" || typeof info.id !== "string" || !info.id) {
    return null;
  }
  const normalized = normalizeOpenCodeMessage({ info: rawInfo, parts: [] });
  if (!normalized) return null;
  if (!existing) return normalized;
  const merged: OpenCodeMessage = {
    ...existing,
    role: normalized.role,
    // `info` is the whole message record, not a patch, so its error field is
    // authoritative in both directions: a message the server no longer reports
    // as errored (a retried turn) must lose the badge, not keep it forever.
    ...(normalized.hasError ? { hasError: true } : {}),
    ...(normalized.errorName ? { errorName: normalized.errorName } : {}),
    // Model and usage are only present once the backend has resolved them.
    // An early streaming `info` legitimately omits them, so absence means
    // "not known yet" rather than "cleared" — blanking would drop the
    // backend-confirmed model badge for the whole streaming turn.
    ...(normalized.modelId ? { modelId: normalized.modelId } : {}),
    ...(normalized.providerUsage
      ? { providerUsage: normalized.providerUsage }
      : {}),
  };
  if (!normalized.hasError) delete merged.hasError;
  if (!normalized.errorName) delete merged.errorName;
  return merged;
}

/**
 * Preserve already-hydrated subagent transcripts when replacing a transcript
 * with one fetched via `includeSubagents: false`.
 *
 * Streaming-triggered refetches skip the recursive child-session hydration for
 * cost; without this carry-over they would blank every expanded Agent row until
 * the next final (`session.idle`) reconcile re-hydrated it.
 */
export function carryOverOpenCodeSubagentHydration(
  previous: OpenCodeMessage[],
  next: OpenCodeMessage[],
): OpenCodeMessage[] {
  const hydratedBySubagentId = new Map<string, OpenCodeMessagePart>();
  for (const message of previous) {
    mapOpenCodeParts(message.parts, (part) => {
      if (
        part.type === "subagent" &&
        part.subagentId &&
        part.subagentActions?.length
      ) {
        hydratedBySubagentId.set(part.subagentId, part);
      }
      return part;
    });
  }
  if (hydratedBySubagentId.size === 0) return next;

  let changed = false;
  const merged = next.map((message) => {
    const mapped = mapOpenCodeParts(message.parts, (part) => {
      if (part.type !== "subagent" || !part.subagentId) return part;
      if (part.subagentActions?.length) return part;
      const hydrated = hydratedBySubagentId.get(part.subagentId);
      if (!hydrated) return part;
      return {
        ...part,
        subagentActions: hydrated.subagentActions,
        subagentActionCount: hydrated.subagentActionCount,
        // A cheap parent-only refresh often reports a still-running Task part
        // even though the hydrated child snapshot already proved it terminal.
        // Do not regress a completed child to pending until the authoritative
        // final hydration replaces it.
        toolState:
          hydrated.toolState === "success" || hydrated.toolState === "failure"
            ? hydrated.toolState
            : part.toolState ?? hydrated.toolState,
      };
    });
    if (!mapped.changed) return message;
    changed = true;
    return { ...message, parts: mapped.parts };
  });
  return changed ? merged : next;
}

function isOpenCodeReasoningInProgress(part: Record<string, unknown>): boolean {
  if (!part.time || typeof part.time !== "object") return false;

  const time = part.time as Record<string, unknown>;
  if (typeof time.start === "number") return time.end === undefined;
  return false;
}

function stripOpenCodeReasoningBoldMarkers(
  content: string,
  allowStreamingOpeningMarker: boolean,
): string {
  if (!content.replace(/\*\*/g, "").trim()) return "";

  const leadingMarker = content.match(/^(\s*)\*\*/);
  if (!leadingMarker) return content;

  const markerCount = content.match(/\*\*/g)?.length ?? 0;
  const trailingMarker = content.match(/\*\*(\s*)$/);

  // OpenCode wraps completed reasoning in a balanced outer bold pair. Remove
  // both delimiters together so inline or trailing Markdown is not corrupted.
  if (trailingMarker && markerCount === 2) {
    return `${leadingMarker[1]}${content.slice(
      leadingMarker[0].length,
      content.length - trailingMarker[0].length,
    )}${trailingMarker[1]}`;
  }

  // During streaming, the first delimiter can arrive before its closing pair.
  return allowStreamingOpeningMarker && markerCount === 1
    ? `${leadingMarker[1]}${content.slice(leadingMarker[0].length)}`
    : content;
}

export function normalizeOpenCodePart(part: unknown): OpenCodeMessagePart | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = part as any;
  if (!p || typeof p !== "object") return null;

  const sourcePartId = typeof p.id === "string" ? p.id : undefined;
  const sourceMessageId = typeof p.messageID === "string" ? p.messageID : undefined;
  const partType = p.type;

  if (partType === "reasoning") {
    const reasoningContent = typeof p.text === "string" ? p.text : "";
    if (!reasoningContent) return null;
    const normalizedContent = stripOpenCodeReasoningBoldMarkers(
      reasoningContent,
      isOpenCodeReasoningInProgress(p),
    );
    if (!normalizedContent.trim()) return null;
    return {
      type: "thinking",
      content: normalizedContent,
      sourcePartId,
      sourceMessageId,
    };
  }

  if (partType === "text" && typeof p.text === "string") {
    return {
      type: "text",
      content: p.text,
      sourcePartId,
      sourceMessageId,
    };
  }

  if (partType === "tool") {
    const toolName = typeof p.tool === "string" ? p.tool : "Unknown tool";
    const toolStatus = p.state?.status;

    let mappedState: "success" | "failure" | "pending" | undefined;
    if (toolStatus === "completed") mappedState = "success";
    else if (toolStatus === "error") mappedState = "failure";
    else if (toolStatus === "pending" || toolStatus === "running") mappedState = "pending";

    const toolTitle = p.state?.title as string | undefined;
    const toolOutput = stringifyToolPayload(p.state?.output);
    const toolError = stringifyToolPayload(p.state?.error);

    if (isOpenCodeTaskTool(toolName)) {
      const input = p.state?.input;
      const metadata = p.state?.metadata ?? p.metadata;
      const taskEnvelope = parseTaskEnvelope(toolOutput);
      const subagentId =
        stringRecordValue(metadata, "sessionId", "sessionID", "jobId") ??
        taskEnvelope.sessionId;
      const description =
        stringRecordValue(input, "description") ?? toolTitle ?? toolName;
      const role = stringRecordValue(input, "subagent_type", "agent");
      const prompt = stringRecordValue(input, "prompt");

      if (taskEnvelope.state === "running") mappedState = "pending";
      else if (taskEnvelope.state === "completed") mappedState = "success";
      else if (taskEnvelope.state === "error") mappedState = "failure";

      return {
        type: "subagent",
        content: description,
        sourcePartId,
        sourceMessageId,
        toolName,
        toolArgs: input,
        toolState: mappedState,
        toolTitle,
        toolOutput,
        toolError,
        subagentId,
        subagentName: description,
        subagentRole: role,
        subagentPrompt: prompt,
        subagentActions: [],
        subagentActionCount: 0,
      };
    }

    let toolDiff: ToolDiffMetadata | undefined;
    if (isEditTool(toolName)) {
      const input = p.state?.input || {};
      const meta = p.state?.metadata || {};
      const filediff = meta.filediff as FileDiffMetadata | undefined;

      const filePath = (input.filePath || input.file_path || input.path || input.file ||
        meta.file || meta.filePath || meta.path || filediff?.file) as string | undefined;

      const oldString = typeof input.oldString === "string" ? input.oldString :
        typeof input.old_string === "string" ? input.old_string : undefined;
      const newString = typeof input.newString === "string" ? input.newString :
        typeof input.new_string === "string" ? input.new_string :
        typeof input.content === "string" ? input.content : undefined;
      const metaBefore = typeof filediff?.before === "string" ? filediff.before :
        typeof meta.before === "string" ? meta.before : undefined;
      const metaAfter = typeof filediff?.after === "string" ? filediff.after :
        typeof meta.after === "string" ? meta.after : undefined;

      const unifiedDiff = typeof meta.diff === "string" ? meta.diff :
        typeof input.patch === "string" ? input.patch :
        typeof input.diff === "string" ? input.diff : undefined;

      const beforeValue = oldString ?? metaBefore;
      const afterValue = newString ?? metaAfter;

      let additions: number | undefined;
      let deletions: number | undefined;

      if (typeof meta.additions === "number" && typeof meta.deletions === "number") {
        additions = meta.additions as number;
        deletions = meta.deletions as number;
      } else if (unifiedDiff) {
        let addCount = 0;
        let delCount = 0;
        const lines = unifiedDiff.split("\n");
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) addCount++;
          else if (line.startsWith("-") && !line.startsWith("---")) delCount++;
        }
        additions = addCount;
        deletions = delCount;
      } else if (toolOutput && toolOutput.includes("@@") && (toolOutput.includes("\n+") || toolOutput.includes("\n-"))) {
        let addCount = 0;
        let delCount = 0;
        const lines = toolOutput.split("\n");
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) addCount++;
          else if (line.startsWith("-") && !line.startsWith("---")) delCount++;
        }
        if (addCount > 0 || delCount > 0) {
          additions = addCount;
          deletions = delCount;
        }
      } else if (beforeValue !== undefined || afterValue !== undefined) {
        const oldLines = beforeValue ? beforeValue.split("\n").length : 0;
        const newLines = afterValue ? afterValue.split("\n").length : 0;
        if (beforeValue && afterValue) {
          deletions = oldLines;
          additions = newLines;
        } else if (afterValue) {
          additions = newLines;
          deletions = 0;
        } else if (beforeValue) {
          additions = 0;
          deletions = oldLines;
        }
      }

      toolDiff = {
        filePath,
        additions,
        deletions,
        before: beforeValue,
        after: afterValue,
        diff: unifiedDiff,
      };
    }

    return {
      type: "tool-invocation",
      content: toolName,
      sourcePartId,
      sourceMessageId,
      toolName,
      toolArgs: p.state?.input,
      toolState: mappedState,
      toolDiff,
      toolTitle,
      toolOutput,
      toolError,
    };
  }

  if (partType === "file") {
    const filePath = p.filename || p.url || "";
    return {
      type: "file",
      content: filePath,
      sourcePartId,
      sourceMessageId,
      fileUrl: typeof p.url === "string" ? p.url : undefined,
    };
  }

  return null;
}

export function normalizeOpenCodeMessage(rawMessage: unknown): OpenCodeMessage | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = rawMessage as any;
  if (!msg || typeof msg !== "object") return null;

  const info = msg.info;
  const createdAt = parseOpenCodeCreatedAt(info?.time?.created);
  const parsedParts: OpenCodeMessagePart[] = [];
  let textContent = "";
  let finishReason: string | undefined;
  const modelId =
    typeof info?.modelID === "string" && info.modelID.trim().length > 0
      ? typeof info?.providerID === "string" && info.providerID.trim().length > 0
        ? `${info.providerID.trim()}/${info.modelID.trim()}`
        : info.modelID.trim()
        : undefined;

  if (Array.isArray(msg.parts)) {
    for (const part of msg.parts) {
      if (
        part
        && typeof part === "object"
        && part.type === "step-finish"
        && typeof part.reason === "string"
        && part.reason.trim().length > 0
      ) {
        // A message can contain more than one step marker in malformed or
        // replayed data. The final marker is the terminal reason that matters.
        finishReason = part.reason.trim();
      }
      const parsedPart = normalizeOpenCodePart(part);
      if (!parsedPart) continue;
      parsedParts.push(parsedPart);
      if (parsedPart.type === "text") {
        textContent += parsedPart.content;
      }
    }
  }

  return {
    id: info?.id || createUuid(),
    role: (info?.role as "user" | "assistant") || "assistant",
    content: textContent,
    parts: parsedParts,
    createdAt,
    ...(info?.role === "assistant" && modelId ? { modelId } : {}),
    ...(info?.role === "assistant" && finishReason ? { finishReason } : {}),
    ...(info?.error !== undefined && info?.error !== null
      ? {
          hasError: true,
          // The discriminator only — enough to tell an intentional interrupt
          // from a real failure without retaining the error payload.
          ...(isRecord(info.error) && typeof info.error.name === "string"
            ? { errorName: info.error.name }
            : {}),
        }
      : {}),
    ...(info?.role === "assistant" && info?.tokens
      ? {
          providerUsage: {
            cost: typeof info.cost === "number" ? info.cost : 0,
            inputTokens: Number(info.tokens.input) || 0,
            outputTokens: Number(info.tokens.output) || 0,
            reasoningTokens: Number(info.tokens.reasoning) || 0,
            cacheReadTokens: Number(info.tokens.cache?.read) || 0,
            cacheWriteTokens: Number(info.tokens.cache?.write) || 0,
            totalTokens:
              typeof info.tokens.total === "number"
                ? info.tokens.total
                : undefined,
            // Keep usage parsing tolerant of older OpenCode payloads whose
            // model id was not typed as a string. The top-level `modelId`
            // displayed in the footer remains strict and backend-confirmed.
            modelId:
              typeof info.providerID === "string" && typeof info.modelID === "string"
                ? `${info.providerID}/${info.modelID}`
                : String(info.modelID ?? ""),
            agent: typeof info.agent === "string" ? info.agent : undefined,
            durationMs:
              typeof info.time?.completed === "number"
              && typeof info.time?.created === "number"
                ? Math.max(0, info.time.completed - info.time.created)
                : undefined,
          },
        }
      : {}),
  };
}

/**
 * Compute a stable identity key for a message part so incremental streaming
 * updates (`message.part.updated`) can replace the matching part in place.
 *
 * Prefers the SDK source part id; falls back to a composite key derived from
 * the source message id and the part's distinguishing fields. Returns null
 * when the part has no source identity (in which case it cannot be matched).
 */
export function getOpenCodePartKey(part: OpenCodeMessagePart): string | null {
  if (part.sourcePartId) return part.sourcePartId;
  if (part.sourceMessageId) {
    return [
      part.sourceMessageId,
      part.type,
      part.toolName,
      part.fileUrl,
      part.content,
    ].filter(Boolean).join(":");
  }
  return null;
}

/**
 * Build (or update) an OpenCode message from a single streamed part.
 *
 * If the part matches an existing part (by {@link getOpenCodePartKey}) it is
 * replaced in place; otherwise it is appended. When the incoming part carries
 * no content but a text `delta`, the delta is appended to the existing part's
 * content (incremental text streaming). The aggregate `content` is recomputed
 * from all text parts. Role/createdAt are preserved from the existing message,
 * defaulting to an assistant message created now. `existing` is partial so a
 * caller that only knows the echo's role/createdAt (e.g. a streamed part that
 * arrived before its `message.updated`) can seed the message without supplying
 * the parts it will be built from.
 */
export function buildOpenCodeMessageFromPart(
  existing: Partial<OpenCodeMessage> | undefined,
  messageId: string,
  part: OpenCodeMessagePart,
  delta?: string,
): OpenCodeMessage {
  const nextParts = [...(existing?.parts ?? [])];
  const incomingKey = getOpenCodePartKey(part);
  const existingIndex = incomingKey
    ? nextParts.findIndex((existingPart) => getOpenCodePartKey(existingPart) === incomingKey)
    : -1;
  const existingPart = existingIndex >= 0 ? nextParts[existingIndex] : undefined;
  const nextPart =
    part.content === "" && delta && existingPart?.type === part.type
      ? { ...part, content: `${existingPart.content}${delta}` }
      : part;

  if (existingIndex >= 0) {
    nextParts[existingIndex] = nextPart;
  } else {
    nextParts.push(nextPart);
  }

  const content = nextParts
    .filter((candidate) => candidate.type === "text")
    .map((candidate) => candidate.content)
    .join("");

  return {
    ...existing,
    id: messageId,
    role: existing?.role ?? "assistant",
    content,
    parts: nextParts,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Create an OpenCode SDK client connected to a server
 */
function openCodeAuthHeaders(authToken?: string): Record<string, string> | undefined {
  if (!authToken) return undefined;
  return {
    // Direct loopback requests use the Basic header OpenCode supports.
    Authorization: `Basic ${globalThis.btoa(`opencode:${authToken}`)}`,
    // A remote Orkestrator gateway consumes Authorization for its own bearer
    // token. It translates this dedicated credential header back to Basic on
    // the authenticated server-side hop.
    "X-Orkestrator-OpenCode-Token": authToken,
  };
}

const openCodeClientConnections = new WeakMap<
  OpencodeClient,
  { baseUrl: string; authToken?: string }
>();

export function createClient(
  baseUrl: string,
  directory?: string,
  authToken?: string,
): OpencodeClient {
  const client = createOpencodeClient({
    baseUrl: resolveGatewayLoopbackBaseUrl(baseUrl),
    directory,
    headers: openCodeAuthHeaders(authToken),
  });
  openCodeClientConnections.set(client, { baseUrl, authToken });
  return client;
}

/**
 * Check server health.
 *
 * Mirrors claude-client's checkHealth. The SDK client does not expose its base
 * URL, so this takes the URL directly and probes the same GET /global/health
 * route the backend polls for readiness.
 */
export async function checkHealth(baseUrl: string, authToken?: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${resolveGatewayLoopbackBaseUrl(baseUrl)}/global/health`,
      { headers: openCodeAuthHeaders(authToken) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Validate a cached SDK client against the exact per-process credential it was
 * created with. This is the OpenCode equivalent of `checkHealth(client)` in
 * the Claude/Codex wrappers and prevents a server restart from leaving a
 * renderer stuck retrying an obsolete Basic password.
 */
export function checkClientHealth(client: OpencodeClient): Promise<boolean> {
  const connection = openCodeClientConnections.get(client);
  if (!connection) return Promise.resolve(false);
  return checkHealth(connection.baseUrl, connection.authToken);
}

type ProviderLike = {
  id?: string;
  models?: unknown;
};

type ProviderCatalogLike = {
  all?: unknown;
  providers?: unknown;
  default?: unknown;
};

function normalizeProviders(value: unknown): ProviderLike[] {
  if (Array.isArray(value)) {
    return value.filter((provider): provider is ProviderLike => {
      return !!provider && typeof provider === "object";
    });
  }

  // Handle object-map format: { anthropic: {...}, openai: {...} }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, v]) => !!v && typeof v === "object")
      .map(([key, v]) => {
        const provider = v as ProviderLike;
        // If the provider doesn't have an id, use the object key
        return provider.id ? provider : { ...provider, id: key };
      });
  }

  return [];
}

function getProvidersFromCatalog(value: unknown): ProviderLike[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const catalog = value as ProviderCatalogLike;

  if (catalog.all) {
    return normalizeProviders(catalog.all);
  }

  if (catalog.providers) {
    return normalizeProviders(catalog.providers);
  }

  return [];
}

function normalizeProviderModels(models: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(models)) {
    return models.filter((model): model is Record<string, unknown> => {
      return !!model && typeof model === "object";
    });
  }

  if (models && typeof models === "object") {
    return Object.entries(models)
      .filter(([, model]) => !!model && typeof model === "object")
      .map(([key, model]) => {
        const record = model as Record<string, unknown>;
        return typeof record.id === "string" ? record : { ...record, id: key };
      });
  }

  return [];
}

/**
 * Get available models/providers from the server
 */
export async function getModels(client: OpencodeClient): Promise<OpenCodeModel[]> {
  const response = await getModelsWithDefaults(client);
  return response.models;
}

/**
 * Get available models/providers plus server defaults from model.json
 */
export async function getModelsWithDefaults(client: OpencodeClient): Promise<OpenCodeModelsResponse> {
  try {
    // Prefer provider.list() because it exposes the full provider/model catalog
    // used by the OpenCode TUI. Fall back to config.providers() for older servers.
    let responseData: unknown;

    try {
      const providerResponse = await client.provider.list();
      responseData = providerResponse.data;
    } catch (err) {
      console.debug("[opencode-client] provider.list() unavailable, falling back to config.providers()", err);
      const configResponse = await client.config.providers();
      responseData = configResponse.data;
    }

    if (!responseData || typeof responseData !== "object") {
      return { models: [], defaults: {} };
    }

    const models: OpenCodeModel[] = [];

    // provider.list() returns: { all: Provider[], default: {...}, connected: [...] }
    // config.providers() returns: { providers: Provider[] | { [id]: Provider }, default: {...} }
    // Each Provider has: { id, name, models: { [modelId]: Model } | Model[] }
    // Each Model has: { id, name, providerID, ... }
    const providers = getProvidersFromCatalog(responseData);
    for (const provider of providers) {
      if (provider && provider.id && provider.models) {
        for (const model of normalizeProviderModels(provider.models)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const m = model as any;
          const modelId = typeof m.id === "string" ? m.id : undefined;
          const modelName = typeof m.name === "string" ? m.name : modelId;

          if (!modelId) {
            continue;
          }

          // Cost fields may be in cost.input/cost.output or directly as inputCost/outputCost
          const inputCost = m.cost?.input ?? m.inputCost ?? m.input_cost;
          const outputCost = m.cost?.output ?? m.outputCost ?? m.output_cost;
          const contextWindow = m.limit?.context ?? m.contextWindow ?? m.context_window;

          // Image input support lives under capabilities.input.image on the
          // provider catalog. The server rejects image attachments to models
          // without it, so surface it on the model so the compose bar can warn
          // before the send instead of surfacing the server's raw error.
          const supportsImageInput =
            typeof m.capabilities?.input?.image === "boolean"
              ? m.capabilities.input.image
              : undefined;

          // Variants are provider/model specific (e.g. low/high/xhigh)
          // Response shape: variants: { [variantName]: { disabled?: boolean, ... } }
          const variantEntries = m.variants && typeof m.variants === "object"
            ? Object.entries(m.variants as Record<string, { disabled?: boolean }>)
            : [];

          const variants = variantEntries
            .filter(([, variantConfig]) => {
              if (!variantConfig || typeof variantConfig !== "object") return false;
              return variantConfig.disabled !== true;
            })
            .map(([variantName]) => variantName)
            .sort((a, b) => {
              const aIndex = PREFERRED_VARIANT_ORDER.indexOf(a);
              const bIndex = PREFERRED_VARIANT_ORDER.indexOf(b);

              if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
              if (aIndex >= 0) return -1;
              if (bIndex >= 0) return 1;

              return a.localeCompare(b);
            });

          models.push({
            id: `${provider.id}/${modelId}`,
            name: modelName || modelId,
            provider: provider.id,
            variants: variants.length > 0 ? variants : undefined,
            inputCost: typeof inputCost === "number" ? inputCost : undefined,
            outputCost: typeof outputCost === "number" ? outputCost : undefined,
            // A non-positive window is not a window. Keeping a `0` here would
            // reach `summarizeOpenCodeUsage` and produce `0/0` -> `NaN%`.
            contextWindow:
              typeof contextWindow === "number"
              && Number.isFinite(contextWindow)
              && contextWindow > 0
                ? contextWindow
                : undefined,
            supportsImageInput,
          });
        }
      }
    }

    const catalog = responseData as ProviderCatalogLike;
    const defaults = catalog.default && typeof catalog.default === "object"
      ? {
          modelId: resolveDefaultModelId(catalog.default),
          variant: resolveDefaultVariant(catalog.default),
        }
      : {};

    return { models, defaults };
  } catch (error) {
    console.error("[opencode-client] Failed to get models:", error);
    return { models: [], defaults: {} };
  }
}

/** Get the provider-restricted catalogue used by Orkestrator's model picker. */
export async function getSelectableModelsWithDefaults(
  client: OpencodeClient,
): Promise<OpenCodeModelsResponse> {
  return restrictOpenCodeModelCatalog(await getModelsWithDefaults(client));
}

/**
 * Get available slash commands from the OpenCode server.
 */
export async function getAvailableSlashCommands(
  client: OpencodeClient,
  directory?: string,
): Promise<OpenCodeSlashCommand[]> {
  try {
    type CommandListResponse = {
      data?: Array<{
        name: string;
        description?: string;
        subtask?: boolean;
        hints: Array<string>;
      }>;
    };

    // Make two calls: one without directory (server uses its own CWD for full
    // discovery) and one with directory (for project-specific commands).
    const requests: Array<{
      source: "global" | "directory";
      promise: Promise<CommandListResponse>;
    }> = [
      {
        source: "global",
        promise: client.command.list(),
      },
    ];

    if (directory) {
      requests.push({
        source: "directory",
        promise: client.command.list({ directory }),
      });
    }

    const settled = await Promise.allSettled(
      requests.map((request) => request.promise),
    );

    const responsesBySource = new Map<"global" | "directory", CommandListResponse>();

    for (let index = 0; index < settled.length; index += 1) {
      const source = requests[index]?.source;
      const result = settled[index];

      if (!source || !result) continue;

      if (result.status === "fulfilled") {
        responsesBySource.set(source, result.value);
      } else {
        console.warn("[opencode-client] Failed to get slash commands from source:", {
          source,
          error: result.reason,
        });
      }
    }

    // Prefer directory metadata for duplicate command names when available,
    // while still using global metadata to fill missing fields.
    const sourcePriority: Array<"global" | "directory"> = directory
      ? ["directory", "global"]
      : ["global"];

    const commandMap = new Map<string, OpenCodeSlashCommand>();

    for (const source of sourcePriority) {
      const response = responsesBySource.get(source);
      if (!response?.data) continue;

      for (const command of response.data) {
        const normalizedName = normalizeSlashCommandName(command.name || "");
        if (!normalizedName) {
          continue;
        }

        const hints = Array.isArray(command.hints)
          ? command.hints.filter(
              (hint): hint is string =>
                typeof hint === "string" && hint.trim().length > 0,
            )
          : [];

        const description =
          typeof command.description === "string" && command.description.trim().length > 0
            ? command.description.trim()
            : hints[0];

        const mappedCommand: OpenCodeSlashCommand = {
          name: normalizedName,
          description,
          hints: hints.length > 0 ? hints : undefined,
        };

        const existing = commandMap.get(normalizedName);
        if (!existing) {
          commandMap.set(normalizedName, mappedCommand);
          continue;
        }

        commandMap.set(normalizedName, {
          ...existing,
          description: existing.description ?? mappedCommand.description,
          hints: existing.hints ?? mappedCommand.hints,
        });
      }
    }

    return Array.from(commandMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error("[opencode-client] Failed to get slash commands:", error);
    return [];
  }
}

/**
 * Create a new chat session
 */
export async function createSession(
  client: OpencodeClient,
  title?: string
): Promise<OpenCodeSession> {
  const response = await client.session.create({
    title,
  });

  if (!response.data) {
    throw new Error("OpenCode returned an empty session response");
  }

  const createdAt = toIsoTimestamp(response.data.time?.created)
    ?? new Date().toISOString();

  return {
    id: response.data.id,
    title: response.data.title,
    createdAt,
    // A session that has just been created has not been touched since.
    updatedAt: toIsoTimestamp(response.data.time?.updated) ?? createdAt,
  };
}

/**
 * Get messages for a session
 */
export async function getSessionMessages(
  client: OpencodeClient,
  sessionId: string,
  options: { throwOnError?: boolean; includeSubagents?: boolean } = {},
): Promise<OpenCodeMessage[]> {
  try {
    const response = await client.session.messages({
      sessionID: sessionId,
    }, {
      throwOnError: options.throwOnError,
    });

    if (!response.data) {
      if (options.throwOnError) {
        throw openCodeResponseError(
          "Failed to get OpenCode session messages",
          response.error,
        );
      }
      return [];
    }

    let messages = response.data
      .map((msg) => normalizeOpenCodeMessage(msg))
      .filter((message): message is OpenCodeMessage => message !== null);

    if (options.includeSubagents !== false) {
      messages = await hydrateOpenCodeSubagentTranscripts(
        client,
        sessionId,
        messages,
        new Set([sessionId]),
        undefined,
        options.throwOnError === true,
      );
    }

    return messages;
  } catch (error) {
    console.error("[opencode-client] Failed to get messages:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get OpenCode session messages");
    }
    return [];
  }
}

type OpenCodeChildSession = {
  id: string;
  title?: string;
  agent?: string;
};

type OpenCodeSessionStatusMap = Record<
  string,
  { type?: "idle" | "busy" | "retry" }
>;

function findUnidentifiedTaskParts(messages: OpenCodeMessage[]): OpenCodeMessagePart[] {
  const result: OpenCodeMessagePart[] = [];
  for (const message of messages) {
    mapOpenCodeParts(message.parts, (part) => {
      if (part.type === "subagent" && !part.subagentId) result.push(part);
      return part;
    });
  }
  return result;
}

async function getOpenCodeChildSessions(
  client: OpencodeClient,
  parentSessionId: string,
  throwOnError = false,
): Promise<OpenCodeChildSession[]> {
  try {
    const response = await client.session.children(
      { sessionID: parentSessionId },
      { throwOnError },
    );
    if (!response.data && throwOnError) {
      throw openCodeResponseError(
        "Failed to get OpenCode child sessions",
        response.error,
      );
    }
    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.warn("[opencode-client] Failed to get child sessions:", error);
    if (throwOnError) throw error;
    return [];
  }
}

function assignOpenCodeChildSessionIds(
  messages: OpenCodeMessage[],
  children: OpenCodeChildSession[],
): OpenCodeMessage[] {
  const claimed = new Set<string>();
  for (const message of messages) {
    mapOpenCodeParts(message.parts, (part) => {
      if (part.type === "subagent" && part.subagentId) claimed.add(part.subagentId);
      return part;
    });
  }

  let changed = false;
  const nextMessages = messages.map((message) => {
    const mapped = mapOpenCodeParts(message.parts, (part) => {
      if (part.type !== "subagent" || part.subagentId) return part;
      const child = children.find((candidate) => {
        if (claimed.has(candidate.id)) return false;
        const title = candidate.title?.trim();
        if (!title) return false;
        return title === part.content || title.startsWith(`${part.content} (@`);
      });
      if (!child) return part;
      claimed.add(child.id);
      return {
        ...part,
        subagentId: child.id,
        subagentRole: part.subagentRole ?? child.agent,
      };
    });
    if (!mapped.changed) return message;
    changed = true;
    return { ...message, parts: mapped.parts };
  });
  return changed ? nextMessages : messages;
}

async function getOpenCodeSessionStatusMap(
  client: OpencodeClient,
  throwOnError = false,
): Promise<OpenCodeSessionStatusMap | undefined> {
  const status = (client.session as unknown as {
    status?: (
      parameters?: unknown,
      options?: { throwOnError?: boolean },
    ) => Promise<{ data?: OpenCodeSessionStatusMap; error?: unknown }>;
  }).status;
  if (typeof status !== "function") return undefined;
  try {
    const response = await status.call(client.session, undefined, { throwOnError });
    if (!response.data) {
      if (throwOnError) {
        throw openCodeResponseError(
          "Failed to get OpenCode subagent session statuses",
          response.error,
        );
      }
      return undefined;
    }
    return isRecord(response.data) && !Array.isArray(response.data)
      ? response.data as OpenCodeSessionStatusMap
      : undefined;
  } catch (error) {
    console.warn("[opencode-client] Failed to get subagent session statuses:", error);
    if (throwOnError) throw error;
    return undefined;
  }
}

/**
 * Whether a child transcript ended in a genuine failure.
 *
 * An intentionally interrupted turn also carries an error, but stopping a turn
 * is not a subagent failure — and the "failure" state latches in
 * {@link mergeOpenCodeSubagentTranscript}, so treating one as such would leave
 * the Agent row red permanently.
 */
function hasOpenCodeAssistantError(messages: OpenCodeMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant"
      && message.hasError === true
      && message.errorName !== OPENCODE_MESSAGE_ABORTED_ERROR,
  );
}

async function hydrateOpenCodeSubagentTranscripts(
  client: OpencodeClient,
  parentSessionId: string,
  initialMessages: OpenCodeMessage[],
  ancestors: Set<string> = new Set([parentSessionId]),
  statusMap?: OpenCodeSessionStatusMap,
  throwOnError = false,
): Promise<OpenCodeMessage[]> {
  let messages = initialMessages;
  if (findUnidentifiedTaskParts(messages).length > 0) {
    const children = await getOpenCodeChildSessions(client, parentSessionId, throwOnError);
    messages = assignOpenCodeChildSessionIds(messages, children);
  }

  const childIds = new Set<string>();
  for (const message of messages) {
    mapOpenCodeParts(message.parts, (part) => {
      if (part.type === "subagent" && part.subagentId && !ancestors.has(part.subagentId)) {
        childIds.add(part.subagentId);
      }
      return part;
    });
  }

  const resolvedStatusMap =
    statusMap ??
    (childIds.size > 0
      ? await getOpenCodeSessionStatusMap(client, throwOnError)
      : undefined);

  const transcripts = await Promise.all(
    Array.from(childIds, async (childSessionId) => {
      const childMessages = await getSessionMessages(client, childSessionId, {
        includeSubagents: false,
        throwOnError: true,
      });
      const hydrated = await hydrateOpenCodeSubagentTranscripts(
        client,
        childSessionId,
        childMessages,
        new Set([...ancestors, childSessionId]),
        resolvedStatusMap,
        throwOnError,
      );
      return { childSessionId, messages: hydrated };
    }),
  );

  for (const transcript of transcripts) {
    const childStatus = resolvedStatusMap?.[transcript.childSessionId]?.type;
    const state =
      hasOpenCodeAssistantError(transcript.messages)
        ? "failure"
        : childStatus === "busy" || childStatus === "retry"
        ? "pending"
        : childStatus === "idle"
          ? "success"
          : undefined;
    messages = mergeOpenCodeSubagentTranscript(
      messages,
      transcript.childSessionId,
      transcript.messages,
      state,
    );
  }
  return messages;
}

export type OpenCodeSessionStatus = "idle" | "busy" | "retry";

export type OpenCodeSessionStatusLookupResult =
  | { kind: "found"; status: OpenCodeSessionStatus }
  | { kind: "missing" }
  | { kind: "unavailable"; error: Error };

/**
 * Read the current server-side status for one session. The v2 SDK returns a
 * map for every session, so callers can distinguish a missing session from an
 * unavailable status channel.
 */
export async function lookupSessionStatus(
  client: OpencodeClient,
  sessionId: string,
): Promise<OpenCodeSessionStatusLookupResult> {
  try {
    const response = await client.session.status();
    if (!response.data) {
      return {
        kind: "unavailable",
        error: openCodeResponseError(
          "Failed to get OpenCode session status",
          response.error,
        ),
      };
    }

    const status = response.data[sessionId];
    if (status === undefined) {
      return { kind: "missing" };
    }
    if (
      status?.type !== "idle" &&
      status?.type !== "busy" &&
      status?.type !== "retry"
    ) {
      return {
        kind: "unavailable",
        error: new Error("OpenCode session status response was malformed"),
      };
    }
    return { kind: "found", status: status.type };
  } catch (error) {
    return {
      kind: "unavailable",
      error: error instanceof Error
        ? error
        : new Error("Failed to get OpenCode session status"),
    };
  }
}

/**
 * Retains the legacy null-on-missing-or-unavailable behavior. Reconciliation
 * callers should use lookupSessionStatus so outages do not look like deletion.
 */
export async function getSessionStatus(
  client: OpencodeClient,
  sessionId: string,
  options: { throwOnError?: boolean } = {},
): Promise<OpenCodeSessionStatus | null> {
  const result = await lookupSessionStatus(client, sessionId);
  if (result.kind === "found") return result.status;
  if (result.kind === "unavailable") {
    console.error("[opencode-client] Failed to get session status:", result.error);
    if (options.throwOnError) throw result.error;
  }
  return null;
}

/** Attachment input for sendPrompt */
export interface PromptAttachment {
  type: "file" | "image";
  path: string;
  /** Data URL for the content (e.g., base64 encoded image) */
  dataUrl?: string;
  /** Original filename */
  filename?: string;
}

export interface SendPromptResult {
  success: boolean;
  error?: string;
  /** Stable OpenCode user-message id for structured-output reconciliation. */
  requestId?: string;
}

function assertNoTraversalSegments(segments: string[]): void {
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Attachment path must not contain traversal segments");
  }
}

/**
 * Construct a file URL without letting URL parsing reinterpret filesystem
 * characters such as `#`, `?`, or percent-encoded dot segments.
 *
 * `URL.pathname = path` is not suitable here: pathname assignment treats `%`
 * sequences as URL escapes and normalizes `%2e%2e` before serializing. Encoding
 * each filesystem segment first preserves the selected filename exactly.
 */
function filePathToUrl(path: string): string {
  if (path.includes("\0")) {
    throw new Error("Attachment path must not contain null bytes");
  }

  const windowsDriveMatch = /^([A-Za-z]:)[\\/](.*)$/.exec(path);
  if (windowsDriveMatch) {
    const segments = (windowsDriveMatch[2] ?? "").split(/[\\/]/);
    assertNoTraversalSegments(segments);
    const encodedPath = segments.map(encodeURIComponent).join("/");
    return `file:///${windowsDriveMatch[1]}/${encodedPath}`;
  }

  if (!path.startsWith("/")) {
    throw new Error("Attachment path must be absolute");
  }

  const segments = path.split("/");
  assertNoTraversalSegments(segments);
  return `file://${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * Splits a model id into its provider half and its model half.
 *
 * Model ids are built as `${provider.id}/${modelId}` and the model id may itself
 * contain slashes (openrouter-style `openrouter/anthropic/claude-…`), so only
 * the **first** slash separates the two. `split("/")` and a destructure silently
 * truncate such an id to its middle segment and send the wrong model.
 *
 * Returns null when there is no slash at all; each caller decides what a bare id
 * means, because they disagree — see {@link toOpenCodeModelRef} and
 * {@link splitOpenCodeModelId}.
 */
function splitModelIdOnFirstSlash(
  model: string,
): { providerHalf: string; modelHalf: string } | null {
  const separator = model.indexOf("/");
  if (separator === -1) return null;
  return {
    providerHalf: model.slice(0, separator),
    modelHalf: model.slice(separator + 1),
  };
}

/**
 * Builds the `{ providerID, modelID }` pair `session.promptAsync` expects.
 *
 * A bare id with no slash is deliberately sent as *both* halves, which is the
 * long-standing behaviour of this path — the server resolves it. The store's
 * `"default"` sentinel never reaches here: the native-agent runtime maps it to
 * `undefined` before calling, so this helper only ever sees a real id.
 */
function toOpenCodeModelRef(model: string): { providerID: string; modelID: string } {
  const split = splitModelIdOnFirstSlash(model);
  if (!split) return { providerID: model, modelID: model };
  return {
    providerID: split.providerHalf || "",
    modelID: split.modelHalf || model,
  };
}

const openCodeMessageIdsByClient = new WeakMap<object, OpenCodeMessageIdCoordinator>();

function openCodeMessageIds(client: OpencodeClient): OpenCodeMessageIdCoordinator {
  const key = client as object;
  const existing = openCodeMessageIdsByClient.get(key);
  if (existing) return existing;
  const created = new OpenCodeMessageIdCoordinator();
  openCodeMessageIdsByClient.set(key, created);
  return created;
}

async function withCallerOwnedOpenCodeMessageId<T>(
  client: OpencodeClient,
  sessionId: string,
  requestId: string | undefined,
  operation: (messageId: string | undefined) => Promise<T>,
): Promise<T> {
  if (requestId === undefined) return operation(undefined);
  // Validate before provider I/O so a malformed local ID cannot be mistaken for
  // an ambiguous dispatch.
  openCodeRequestMarker(requestId);
  const coordinator = openCodeMessageIds(client);
  return coordinator.runExclusive(sessionId, async () => {
    const response = await client.session.messages(
      { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
      { throwOnError: false },
    );
    if (response.error) {
      throw new Error(formatOpenCodeError(response.error));
    }
    const history = boundedOpenCodeMessageHistory(response.data);
    // History is authoritative across renderer reloads. The bounded in-memory
    // reservation closes the interval before a just-accepted message appears.
    const messageId = coordinator.resolve(sessionId, history, requestId);
    return operation(messageId);
  });
}

/**
 * Send a prompt to a session
 */
export async function sendPrompt(
  client: OpencodeClient,
  sessionId: string,
  message: string,
  options?: {
    model?: string;
    variant?: string;
    mode?: OpenCodeConversationMode;
    attachments?: PromptAttachment[];
    outputSchema?: JsonSchema;
    structuredOutputRetryCount?: number;
    requestId?: string;
    command?: {
      name: string;
      arguments?: string;
    };
    agent?: string;
    directory?: string;
  }
): Promise<SendPromptResult> {
  try {
    // Build the parts array with proper typing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [
      { type: "text" as const, text: message },
    ];

    if (options?.attachments) {
      for (const attachment of options.attachments) {
        // SDK FilePartInput requires: type, mime, url
        // Determine MIME type based on attachment type and filename
        let mime = "application/octet-stream";
        const ext = attachment.filename?.split(".").pop()?.toLowerCase();
        if (attachment.type === "image") {
          mime = "image/png"; // Default for clipboard images
          if (ext === "jpg" || ext === "jpeg") {
            mime = "image/jpeg";
          } else if (ext === "gif") {
            mime = "image/gif";
          } else if (ext === "webp") {
            mime = "image/webp";
          }
        } else if (attachment.filename) {
          // Try to infer MIME type from filename for files
          if (ext === "txt") mime = "text/plain";
          else if (ext === "json") mime = "application/json";
          else if (ext === "js" || ext === "mjs") mime = "text/javascript";
          else if (ext === "ts" || ext === "tsx") mime = "text/typescript";
          else if (ext === "md") mime = "text/markdown";
          else if (ext === "html") mime = "text/html";
          else if (ext === "css") mime = "text/css";
          else if (ext === "py") mime = "text/x-python";
          else if (ext === "rs") mime = "text/x-rust";
        }

        // Use data URL if available, otherwise construct file:// URL
        const url = attachment.dataUrl || filePathToUrl(attachment.path);

        parts.push({
          type: "file" as const,
          mime,
          url,
          filename: attachment.filename,
        });
      }
    }

    const requestId = options?.outputSchema
      ? (options.requestId ?? createUuid())
      : options?.requestId;
    const response = await withCallerOwnedOpenCodeMessageId(
      client,
      sessionId,
      requestId,
      async (messageID) => options?.command
        ? client.session.command({
          sessionID: sessionId,
          directory: options.directory,
          messageID,
          command: options.command.name.replace(/^\//, ""),
          // `arguments` is a *required* field on the server's command request
          // body, so a bare `/init` must still send an empty string. Passing
          // `undefined` drops the key in `JSON.stringify` and the server answers
          // 400 — which the caller reads as a failed send and then deletes the
          // user's own message from the transcript.
          arguments: options.command.arguments ?? "",
          model: options.model,
          agent: options.agent ?? options.mode,
          variant: options.variant,
          parts: parts.filter((part) => part.type === "file"),
        })
        : client.session.promptAsync({
          sessionID: sessionId,
          directory: options?.directory,
          messageID,
          parts,
          model: options?.model ? toOpenCodeModelRef(options.model) : undefined,
          agent: options?.agent ?? options?.mode,
          variant: options?.variant,
          format: options?.outputSchema
            ? {
                type: "json_schema",
                schema: options.outputSchema,
                retryCount: options.structuredOutputRetryCount,
              }
            : undefined,
        }),
    );

    if (response && "error" in response && response.error) {
      return {
        success: false,
        requestId,
        error: formatOpenCodeError(response.error),
      };
    }

    if (requestId !== undefined) {
      openCodeMessageIds(client).markAccepted(sessionId, requestId);
    }

    return { success: true, requestId };
  } catch (error) {
    console.error("[opencode-client] Failed to send prompt:", error);
    return {
      success: false,
      error: formatOpenCodeError(error),
    };
  }
}

export interface OpenCodeAgent {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  native?: boolean;
  hidden?: boolean;
  modelId?: string;
  variant?: string;
}

export interface OpenCodeRuntimeHealth {
  agents: OpenCodeAgent[];
  skills: Array<{ name: string; description?: string; location?: string }>;
  mcpServers: Array<{ name: string; status: string; error?: string }>;
  lspServers: Array<{ id: string; name: string; root: string; status: string }>;
  formatters: Array<{ name: string; enabled: boolean; extensions: string[] }>;
  todos?: Array<{ content: string; status: string; priority: string }>;
  diffs?: Array<{
    file?: string;
    patch?: string;
    additions: number;
    deletions: number;
    status?: "added" | "deleted" | "modified";
  }>;
  fetchedAt: string;
}

type OpenCodeProviderUsage = NonNullable<OpenCodeMessage["providerUsage"]>;

/**
 * Tokens this turn occupies in the context window.
 *
 * `totalTokens` is the provider's own figure when it reports one; the sum is the
 * fallback. A reported `0` is not trusted as a total — the SDK zero-initialises
 * `tokens` on an in-flight assistant message, so a literal zero means "not
 * counted yet", not "this turn was free".
 */
function openCodeTurnTokens(turn: OpenCodeProviderUsage): number {
  if (typeof turn.totalTokens === "number" && turn.totalTokens > 0) {
    return turn.totalTokens;
  }
  return turn.inputTokens + turn.outputTokens + turn.cacheReadTokens;
}

export function summarizeOpenCodeUsage(
  messages: OpenCodeMessage[],
  models: OpenCodeModel[],
): ContextUsageSnapshot | null {
  const turns = messages
    .map((message) => message.providerUsage)
    .filter((usage): usage is OpenCodeProviderUsage => !!usage);
  // `AssistantMessage.tokens` is required and zero-initialised while the turn
  // streams, so the in-flight turn always carries an all-zero usage block.
  // Anchoring on `turns.at(-1)` would therefore collapse the reading to 0% for
  // the whole duration of every turn. Anchor on the last turn that actually
  // reported tokens instead; the session-level reduce below is unaffected
  // because an all-zero turn contributes nothing to any sum.
  const latest = turns.findLast((turn) => openCodeTurnTokens(turn) > 0);
  if (!latest) return null;

  const model = models.find((candidate) => candidate.id === latest.modelId);
  const contextWindow = model?.contextWindow;
  // Without a catalogue context window there is no denominator. Synthesising one
  // from the used tokens would report exactly 100% for every model missing from
  // the catalogue — including every mount before the async model list arrives.
  if (
    typeof contextWindow !== "number"
    || !Number.isFinite(contextWindow)
    || contextWindow <= 0
  ) {
    return null;
  }

  const session = turns.reduce(
    (sum, turn) => ({
      cost: sum.cost + turn.cost,
      input: sum.input + turn.inputTokens,
      output: sum.output + turn.outputTokens,
      reasoning: sum.reasoning + turn.reasoningTokens,
      cacheRead: sum.cacheRead + turn.cacheReadTokens,
      cacheWrite: sum.cacheWrite + turn.cacheWriteTokens,
      duration: sum.duration + (turn.durationMs ?? 0),
    }),
    {
      cost: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      duration: 0,
    },
  );
  const usedTokens = openCodeTurnTokens(latest);

  return {
    usedTokens,
    totalTokens: contextWindow,
    percentUsed: Math.max(0, Math.min(100, (usedTokens / contextWindow) * 100)),
    modelId: latest.modelId,
    inputTokens: session.input,
    outputTokens: session.output,
    cacheReadTokens: session.cacheRead,
    cacheWriteTokens: session.cacheWrite,
    reasoningTokens: session.reasoning,
    lastTurnTokens: usedTokens,
    sessionTokens:
      session.input + session.output + session.cacheRead + session.cacheWrite,
    costUsd: session.cost,
    durationMs: session.duration,
    // Provider-exact counters against a catalogue context window: never inferred.
    estimated: false,
    source: "opencode",
    updatedAt: new Date().toISOString(),
  };
}

export async function getOpenCodeRuntimeHealth(
  client: OpencodeClient,
  directory?: string,
  sessionId?: string,
): Promise<OpenCodeRuntimeHealth> {
  // Some managed OpenCode installations and test doubles expose only a subset of
  // the v2 surface. Defer each lookup into its own promise so a missing namespace
  // becomes one unavailable capability rather than aborting the whole snapshot.
  const attempt = <T,>(operation: () => Promise<T>): Promise<T> =>
    Promise.resolve().then(operation);
  const [agents, skills, mcp, lsp, formatters, todos, diffs] = await Promise.allSettled([
    attempt(() => client.app.agents({ directory })),
    attempt(() => client.app.skills({ directory })),
    attempt(() => client.mcp.status({ directory })),
    attempt(() => client.lsp.status({ directory })),
    attempt(() => client.formatter.status({ directory })),
    sessionId
      ? attempt(() => client.session.todo({ sessionID: sessionId, directory }))
      : Promise.resolve({ data: [] }),
    sessionId
      ? attempt(() => client.session.diff({ sessionID: sessionId, directory }))
      : Promise.resolve({ data: [] }),
  ]);

  const data = <T,>(result: PromiseSettledResult<{ data?: T }>, fallback: T): T =>
    result.status === "fulfilled" && result.value.data !== undefined
      ? result.value.data
      : fallback;
  const mcpData = data<Record<string, { status?: string; error?: string }>>(mcp, {});

  return {
    agents: data<Array<{
      name: string;
      description?: string;
      mode: "subagent" | "primary" | "all";
      native?: boolean;
      hidden?: boolean;
      model?: { providerID: string; modelID: string };
      variant?: string;
    }>>(agents, [])
      .filter((agent) => !agent.hidden)
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
        native: agent.native,
        hidden: agent.hidden,
        modelId: agent.model
          ? `${agent.model.providerID}/${agent.model.modelID}`
          : undefined,
        variant: agent.variant,
      })),
    skills: data<Array<{ name: string; description?: string; location?: string }>>(skills, []),
    mcpServers: Object.entries(mcpData).map(([name, status]) => ({
      name,
      status: status.status ?? "unknown",
      error: status.error,
    })),
    lspServers: data<
      Array<{ id: string; name: string; root: string; status: string }>
    >(lsp, []),
    formatters: data<
      Array<{ name: string; enabled: boolean; extensions: string[] }>
    >(formatters, []),
    todos: data<Array<{ content: string; status: string; priority: string }>>(
      todos,
      [],
    ),
    diffs: data<Array<{
      file?: string;
      patch?: string;
      additions: number;
      deletions: number;
      status?: "added" | "deleted" | "modified";
    }>>(diffs, []),
    fetchedAt: new Date().toISOString(),
  };
}

export async function forkOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
  messageId?: string,
): Promise<OpenCodeSession> {
  const response = await client.session.fork({
    sessionID: sessionId,
    messageID: messageId,
  }, { throwOnError: true });
  if (!response.data) {
    throw new Error("OpenCode returned an empty fork response");
  }
  const createdAt = toIsoTimestamp(response.data.time?.created)
    ?? new Date().toISOString();

  return {
    id: response.data.id,
    title: response.data.title,
    createdAt,
    // A fork that has just been created has not been touched since.
    updatedAt: toIsoTimestamp(response.data.time?.updated) ?? createdAt,
  };
}

/**
 * Splits a stored model id into an *optional* provider/model override.
 *
 * Shares {@link splitModelIdOnFirstSlash} with the prompting path, but disagrees
 * with it about a bare id: compaction takes an override the server may ignore, so
 * anything that cannot name both halves is safer as "no override" than as a
 * half-specified one that would resolve a provider naming no model.
 *
 * `"default"` is the store's sentinel for "no explicit model" and the info-panel
 * caller passes the raw stored value straight through, so it is filtered here —
 * destructuring it yielded `providerID: "default", modelID: undefined`.
 */
export function splitOpenCodeModelId(
  model: string | undefined,
): { providerID?: string; modelID?: string } {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "default") return {};
  const split = splitModelIdOnFirstSlash(trimmed);
  if (!split || !split.providerHalf || !split.modelHalf) return {};
  return { providerID: split.providerHalf, modelID: split.modelHalf };
}

export async function compactOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
  model?: string,
): Promise<void> {
  const { providerID, modelID } = splitOpenCodeModelId(model);
  const response = await client.session.summarize({
    sessionID: sessionId,
    providerID,
    modelID,
    auto: false,
  }, { throwOnError: true });
  void response;
}

export async function revertOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
  messageId?: string,
): Promise<void> {
  const response = await client.session.revert({
    sessionID: sessionId,
    messageID: messageId,
  }, { throwOnError: true });
  void response;
}

export async function unrevertOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
): Promise<void> {
  const response = await client.session.unrevert({
    sessionID: sessionId,
  }, { throwOnError: true });
  void response;
}

export async function shareOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
): Promise<string | undefined> {
  const response = await client.session.share({
    sessionID: sessionId,
  }, { throwOnError: true });
  if (!response.data) {
    throw new Error("OpenCode returned an empty share response");
  }
  const share = (response.data as { share?: { url?: string } }).share;
  return share?.url;
}

export async function unshareOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
): Promise<void> {
  const response = await client.session.unshare({
    sessionID: sessionId,
  }, { throwOnError: true });
  void response;
}

/** Dispatch a constrained native OpenCode turn while leaving its tools enabled. */
export async function sendStructuredPrompt(
  client: OpencodeClient,
  sessionId: string,
  message: string,
  outputSchema: JsonSchema,
  options: {
    model?: string;
    variant?: string;
    mode?: OpenCodeConversationMode;
    attachments?: PromptAttachment[];
    retryCount?: number;
    requestId?: string;
  } = {},
): Promise<SendPromptResult> {
  return sendPrompt(client, sessionId, message, {
    ...options,
    outputSchema,
    structuredOutputRetryCount: options.retryCount,
  });
}

function openCodeStructuredFailure(
  error: unknown,
  requestId?: string,
): StructuredOutputResult<never> {
  const record = isRecord(error) ? error : {};
  const name = typeof record.name === "string" ? record.name : "";
  const data = isRecord(record.data) ? record.data : {};
  const message = firstNonEmptyString([
    data.message,
    record.message,
  ]) ?? "OpenCode failed to produce structured output.";
  const retries = typeof data.retries === "number" ? data.retries : undefined;
  return structuredOutputFailure(
    "opencode",
    name === "StructuredOutputError"
      ? "schema_retry_exhausted"
      : name === OPENCODE_MESSAGE_ABORTED_ERROR
        ? "interrupted"
        : "provider_error",
    message,
    {
      requestId,
      retryable: true,
      details: retries === undefined ? undefined : { retries },
    },
  );
}

/**
 * Read a completed structured result from OpenCode's authoritative message
 * history. Ordinary text parts are deliberately never parsed as a fallback.
 */
export async function getStructuredOutput<T = unknown>(
  client: OpencodeClient,
  sessionId: string,
  requestId?: string,
): Promise<StructuredOutputResult<T> | null> {
  // Reject malformed correlation IDs before touching the authoritative
  // transcript. Falling back to the latest turn for an explicit blank ID could
  // associate an unrelated result with the caller's request.
  if (requestId !== undefined) openCodeRequestMarker(requestId);
  let response: { data?: unknown; error?: unknown };
  try {
    response = await client.session.messages(
      { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
      { throwOnError: false },
    );
  } catch (error) {
    throw new StructuredOutputReadUnavailableError(
      "opencode",
      error instanceof Error
        ? error.message
        : "Failed to read OpenCode structured output.",
      { requestId, cause: error },
    );
  }

  if (!response.data) {
    return response.error
      ? openCodeStructuredFailure(response.error, requestId)
      : null;
  }
  let boundedEntries: readonly unknown[];
  try {
    boundedEntries = boundedOpenCodeMessageHistory(response.data);
  } catch {
    return structuredOutputFailure(
      "opencode",
      "malformed_output",
      "OpenCode returned malformed or oversized message history for structured output.",
      { requestId },
    );
  }
  if (boundedEntries.some((entry) => !isRecord(entry) || !isRecord(entry.info))) {
    return structuredOutputFailure(
      "opencode",
      "malformed_output",
      "OpenCode returned malformed message history for structured output.",
      { requestId },
    );
  }

  const entries = boundedEntries as Array<{ info: Record<string, unknown> }>;
  const latestStructuredUserId = entries
    .filter((entry) => {
      const format = isRecord(entry.info.format) ? entry.info.format : {};
      return entry.info.role === "user" && format.type === "json_schema";
    })
    .at(-1)?.info.id;
  const providerMessageId = requestId === undefined
    ? undefined
    : findOpenCodeMessageId(entries, requestId);
  const expectedParentId = requestId === undefined
    ? (typeof latestStructuredUserId === "string" ? latestStructuredUserId : undefined)
    : providerMessageId;
  if (!expectedParentId) return null;
  // Keep the provider-neutral correlation ID on the public result. Only the
  // transcript lookup uses OpenCode's provider-qualified message ID.
  const resultRequestId = requestId ?? expectedParentId;

  const assistant = entries
    .filter((entry) =>
      entry.info.role === "assistant"
      && entry.info.parentID === expectedParentId
    )
    .at(-1);
  if (!assistant) return null;
  if (assistant.info.error) {
    return openCodeStructuredFailure(
      assistant.info.error,
      resultRequestId,
    );
  }
  if (!isRecord(assistant.info.time)) {
    return structuredOutputFailure(
      "opencode",
      "malformed_output",
      "OpenCode returned malformed assistant timing data.",
      { requestId: resultRequestId },
    );
  }
  if (!assistant.info.time.completed) return null;
  if (assistant.info.structured === undefined) {
    return structuredOutputFailure(
      "opencode",
      "malformed_output",
      "OpenCode completed the turn without a structured result.",
      { requestId: resultRequestId },
    );
  }
  return {
    ok: true,
    provider: "opencode",
    requestId: resultRequestId,
    value: assistant.info.structured as T,
  };
}

/** Event types from OpenCode SSE stream */
export interface OpenCodeEvent {
  type: "message.updated" | "session.updated" | "session.error" | "file.edited" | "file.watcher.updated" | "permission.asked" | "permission.replied" | "question.asked" | "question.replied" | "question.rejected" | string;
  properties?: {
    sessionID?: string;
    info?: {
      id?: string;
      role?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    };
    error?: string;
    /** For question.asked events - the question request */
    id?: string;
    questions?: QuestionInfo[];
    tool?: {
      messageID: string;
      callID: string;
    };
    /** For permission.asked events */
    permission?: string;
    patterns?: string[];
    metadata?: Record<string, unknown>;
    always?: string[];
    /** For permission.replied events */
    reply?: PermissionReply;
    /** For question.replied events */
    requestID?: string;
    answers?: QuestionAnswer[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
}

/**
 * Subscribe to events from the server
 * Returns an async iterator for SSE events
 */
export async function subscribeToEvents(client: OpencodeClient): Promise<AsyncIterable<OpenCodeEvent> | null> {
  try {
    // event.subscribe() returns { stream: AsyncGenerator }
    const response = await client.event.subscribe();

    // The response has a stream property that is the async generator
    if (response && "stream" in response) {
      return response.stream as AsyncIterable<OpenCodeEvent>;
    }

    // Fallback - try to iterate the response directly
    if (response && Symbol.asyncIterator in Object(response)) {
      return response as unknown as AsyncIterable<OpenCodeEvent>;
    }

    return null;
  } catch (error) {
    console.error("[opencode-client] Failed to subscribe to events:", error);
    return null;
  }
}

/**
 * Get list of existing sessions
 */
/**
 * Normalize the SDK's timestamps, which may arrive as epoch millis or as an
 * ISO string depending on server version.
 */
function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export async function listSessions(client: OpencodeClient): Promise<OpenCodeSession[]> {
  try {
    const response = await client.session.list();
    if (!response.data) return [];

    return response.data.map((session): OpenCodeSession => {
      const createdAt = toIsoTimestamp(session.time?.created)
        ?? new Date().toISOString();

      return {
        id: session.id,
        title: session.title,
        createdAt,
        updatedAt: toIsoTimestamp(session.time?.updated) ?? createdAt,
      };
    });
  } catch (error) {
    console.error("[opencode-client] Failed to list sessions:", error);
    throw error instanceof Error
      ? error
      : new Error("Failed to list OpenCode sessions");
  }
}

/**
 * Delete a session
 */
export async function deleteSession(client: OpencodeClient, sessionId: string): Promise<boolean> {
  try {
    const response = await client.session.delete(
      { sessionID: sessionId },
      { throwOnError: false },
    );
    if (response?.error) {
      console.error("[opencode-client] Failed to delete session:", response.error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to delete session:", error);
    return false;
  }
}

/**
 * Abort a running session/prompt.
 *
 * The SDK only throws on a non-2xx response or a transport failure when the
 * caller passes `throwOnError`; otherwise both are handed back as
 * `response.error`. Returning `true` on the strength of "it did not throw"
 * would report a failed abort as a successful one, and the caller writes a
 * "stopped" marker and promotes the queued prompt on that answer.
 */
export async function abortSession(client: OpencodeClient, sessionId: string): Promise<boolean> {
  try {
    const response = await client.session.abort(
      { sessionID: sessionId },
      { throwOnError: false },
    );
    if (response?.error) {
      console.error("[opencode-client] Failed to abort session:", response.error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to abort session:", error);
    return false;
  }
}

/**
 * Get pending question requests
 */
export async function getPendingQuestions(
  client: OpencodeClient,
  options: { throwOnError?: boolean; signal?: AbortSignal } = {},
): Promise<QuestionRequest[]> {
  try {
    const response = await client.question.list(undefined, {
      throwOnError: options.throwOnError,
      signal: options.signal,
    });
    if (!response.data) {
      if (options.throwOnError) {
        throw openCodeResponseError(
          "Failed to get pending OpenCode questions",
          response.error,
        );
      }
      return [];
    }
    return response.data.map(normalizeQuestionRequest);
  } catch (error) {
    console.error("[opencode-client] Failed to get pending questions:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get pending OpenCode questions");
    }
    return [];
  }
}

/**
 * Get pending permission requests
 */
export async function getPendingPermissions(
  client: OpencodeClient,
  options: { throwOnError?: boolean; signal?: AbortSignal } = {},
): Promise<PermissionRequest[]> {
  try {
    const response = await client.permission.list(undefined, {
      throwOnError: options.throwOnError,
      signal: options.signal,
    });
    if (!response.data) {
      if (options.throwOnError) {
        throw openCodeResponseError(
          "Failed to get pending OpenCode permissions",
          response.error,
        );
      }
      return [];
    }
    return response.data.map(normalizePermissionRequest);
  } catch (error) {
    console.error("[opencode-client] Failed to get pending permissions:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get pending OpenCode permissions");
    }
    return [];
  }
}

async function reconcileInteractionResponse(
  requestId: string,
  loadPending: (signal: AbortSignal) => Promise<Array<{ id: string }>>,
): Promise<Exclude<OpenCodeInteractionResponseResult, "applied">> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("OpenCode interaction reconciliation timed out"));
    }, INTERACTION_RECONCILIATION_TIMEOUT_MS);
  });

  try {
    const pending = await Promise.race([
      loadPending(controller.signal),
      timeout,
    ]);
    return pending.some((request) => request.id === requestId) ? "pending" : "gone";
  } catch (error) {
    console.error("[opencode-client] Failed to reconcile interaction response:", error);
    return "unknown";
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Reply to a question request
 * @param client The SDK client
 * @param requestId The question request ID
 * @param answers Array of answers (each answer is an array of selected option labels or typed text)
 */
export async function replyToQuestion(
  client: OpencodeClient,
  requestId: string,
  answers: QuestionAnswer[]
): Promise<OpenCodeInteractionResponseResult> {
  try {
    await client.question.reply(
      {
        requestID: requestId,
        answers,
      },
      { throwOnError: true },
    );
    return "applied";
  } catch (error) {
    console.error("[opencode-client] Failed to reply to question:", error);
    return reconcileInteractionResponse(
      requestId,
      (signal) => getPendingQuestions(client, { throwOnError: true, signal }),
    );
  }
}

/**
 * Reply to a permission request
 */
export async function replyToPermission(
  client: OpencodeClient,
  requestId: string,
  reply: PermissionReply,
  message?: string
): Promise<OpenCodeInteractionResponseResult> {
  try {
    await client.permission.reply(
      {
        requestID: requestId,
        reply,
        message,
      },
      { throwOnError: true },
    );
    return "applied";
  } catch (error) {
    console.error("[opencode-client] Failed to reply to permission:", error);
    return reconcileInteractionResponse(
      requestId,
      (signal) => getPendingPermissions(client, { throwOnError: true, signal }),
    );
  }
}

/**
 * Reject/dismiss a question request
 */
export async function rejectQuestion(
  client: OpencodeClient,
  requestId: string
): Promise<OpenCodeInteractionResponseResult> {
  try {
    await client.question.reject(
      { requestID: requestId },
      { throwOnError: true },
    );
    return "applied";
  } catch (error) {
    console.error("[opencode-client] Failed to reject question:", error);
    return reconcileInteractionResponse(
      requestId,
      (signal) => getPendingQuestions(client, { throwOnError: true, signal }),
    );
  }
}
