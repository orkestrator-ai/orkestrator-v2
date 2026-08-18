/**
 * Provider-neutral transport contract for a schema-constrained native-agent turn.
 *
 * Domain validation (for example, validating a code-review report) deliberately
 * lives above this layer. This contract only answers whether the provider
 * produced a structured payload at all, or why it could not.
 */
export type JsonSchema = Record<string, unknown>;

export type StructuredOutputProvider = "claude" | "codex" | "opencode" | "cursor" | "grok";

export type StructuredOutputFailureCode =
  | "schema_retry_exhausted"
  | "malformed_output"
  | "provider_error"
  | "interrupted";

const STRUCTURED_OUTPUT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "schema_retry_exhausted",
  "malformed_output",
  "provider_error",
  "interrupted",
]);

export interface StructuredOutputFailure {
  code: StructuredOutputFailureCode;
  message: string;
  provider: StructuredOutputProvider;
  /** Structured-output failures are safe to retry with a fresh native turn. */
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type StructuredOutputResult<T = unknown> =
  | {
      ok: true;
      value: T;
      provider: StructuredOutputProvider;
      requestId?: string;
    }
  | {
      ok: false;
      error: StructuredOutputFailure;
      provider: StructuredOutputProvider;
      requestId?: string;
    };

/**
 * The authoritative structured-output channel could not be read.
 *
 * This is deliberately not a `StructuredOutputResult`: a transport outage says
 * nothing about whether the provider turn is still running or already completed.
 * Callers can therefore retry/reconcile the same request ID without mistaking an
 * observation failure for a provider-authored terminal result.
 */
export class StructuredOutputReadUnavailableError extends Error {
  readonly code = "structured_output_read_unavailable";
  readonly retryable = true;
  readonly provider: StructuredOutputProvider;
  readonly requestId?: string;

  constructor(
    provider: StructuredOutputProvider,
    message: string,
    options: {
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StructuredOutputReadUnavailableError";
    this.provider = provider;
    this.requestId = options.requestId;
  }
}

export function isStructuredOutputReadUnavailableError(
  value: unknown,
): value is StructuredOutputReadUnavailableError {
  return value instanceof StructuredOutputReadUnavailableError;
}

export function isJsonSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStructuredOutputResult(value: unknown): value is StructuredOutputResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (
    result.provider !== "claude" &&
    result.provider !== "codex" &&
    result.provider !== "opencode" &&
    result.provider !== "cursor" &&
    result.provider !== "grok"
  ) {
    return false;
  }
  if (result.requestId !== undefined && typeof result.requestId !== "string") {
    return false;
  }
  if (result.ok === true) {
    return Object.hasOwn(result, "value") && result.value !== undefined;
  }
  if (result.ok !== false || result.error === null || typeof result.error !== "object") {
    return false;
  }
  const error = result.error as Record<string, unknown>;
  return (
    typeof error.code === "string" &&
    STRUCTURED_OUTPUT_FAILURE_CODES.has(error.code) &&
    typeof error.message === "string" &&
    error.provider === result.provider &&
    typeof error.retryable === "boolean" &&
    (error.details === undefined ||
      (error.details !== null &&
        typeof error.details === "object" &&
        !Array.isArray(error.details)))
  );
}

export {
  STRUCTURED_OUTPUT_RECOVERY_CANDIDATES,
  STRUCTURED_OUTPUT_RECOVERY_CHARS,
  STRUCTURED_OUTPUT_RECOVERY_TAGS,
  tryParseStructuredOutputText,
} from "./structured-output-text.js";

export function structuredOutputFailure(
  provider: StructuredOutputProvider,
  code: StructuredOutputFailureCode,
  message: string,
  options: {
    requestId?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  } = {},
): StructuredOutputResult<never> {
  return {
    ok: false,
    provider,
    requestId: options.requestId,
    error: {
      code,
      message,
      provider,
      retryable: options.retryable ?? code !== "interrupted",
      details: options.details,
    },
  };
}
