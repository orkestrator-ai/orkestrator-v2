import { type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { NativeMessage, NativeMessagePart, NativeToolDiffMetadata } from "./chat/native-message-types";

export { type OpencodeClient };

export const PREFERRED_VARIANT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export const INTERACTION_RECONCILIATION_TIMEOUT_MS = 5_000;

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

export interface OpenCodeSlashCommand {
  name: string;
  description?: string;
  hints?: string[];
}

export function normalizeSlashCommandName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function resolveDefaultModelId(defaultConfig: unknown): string | undefined {
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

export function resolveDefaultVariant(defaultConfig: unknown): string | undefined {
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
export function normalizeQuestionRequest(raw: unknown): QuestionRequest {
  const record = isRecord(raw) ? raw : {};
  return {
    ...(record as Omit<QuestionRequest, "sessionId">),
    sessionId: readSessionId(record),
  };
}

export function normalizePermissionRequest(raw: unknown): PermissionRequest {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function firstNonEmptyString(values: unknown[]): string | undefined {
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

export function toDisplayString(value: unknown): string | undefined {
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

export function redactSensitiveData(value: unknown, seen = new WeakSet<object>()): unknown {
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

export function safeJSONStringify(value: unknown, maxLength = 4000): string | undefined {
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
export const OPENCODE_MESSAGE_ABORTED_ERROR = "MessageAbortedError";

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

export function openCodeResponseError(operation: string, error: unknown): Error {
  if (error === undefined || error === null) {
    return new Error(operation);
  }

  return new Error(`${operation}: ${formatOpenCodeError(error)}`);
}

/** Structure for filediff metadata from the SDK */

/** Normalize SDK timestamps across epoch and ISO server formats. */
export function toIsoTimestamp(value: unknown): string | null {
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
