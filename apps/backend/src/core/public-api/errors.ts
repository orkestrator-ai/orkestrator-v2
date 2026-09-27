import type { PublicErrorCode } from "@orkestrator/protocol/public-api";

/**
 * A structured public failure. Public actions throw these; the dispatcher
 * turns them into error envelopes. Any other exception is reported as
 * `internal-error` (or, after admission, recorded on the operation) — never
 * classified by matching its English message.
 */
export class PublicActionError extends Error {
  readonly code: PublicErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable?: boolean;

  constructor(
    code: PublicErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "PublicActionError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable;
  }
}

export function isPublicActionError(value: unknown): value is PublicActionError {
  return value instanceof PublicActionError;
}

/** Bounded, single-line message for errors that cross the public boundary. */
export function boundedMessage(error: unknown, fallback = "The operation failed"): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const single = raw.replace(/\s+/g, " ").trim() || fallback;
  return single.length <= 500 ? single : `${single.slice(0, 499)}…`;
}
