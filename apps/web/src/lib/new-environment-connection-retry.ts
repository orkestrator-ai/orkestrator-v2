const NEW_ENVIRONMENT_RETRY_WINDOW_MS = 60_000;

/**
 * Keep retrying for almost the entire one-minute startup window. The previous
 * four-entry schedule exhausted itself after only 7.5 seconds, so the window
 * below was mostly theoretical and slower first launches still surfaced a
 * terminal error while their bridge was becoming ready.
 */
const NEW_ENVIRONMENT_RETRY_DELAYS_MS = [
  500,
  1_000,
  2_000,
  4_000,
  8_000,
  8_000,
  8_000,
  8_000,
  8_000,
  8_000,
] as const;

export interface NewEnvironmentConnectionRetryDecision {
  delayMs: number;
  retryWindowStartedAt: number;
  retryWindowExpiresAt: number;
}

export interface NewEnvironmentConnectionRetryOptions {
  createdAt: string | undefined;
  attempt: number;
  retryWindowStartedAt: number | null;
  setupPendingObserved: boolean;
  now?: number;
}

/**
 * Marks a failure from the bridge-startup/status phase. The outer
 * initialization catch must never infer retryability from a generic network
 * error: later operations such as session creation are not necessarily
 * idempotent.
 */
export class RetryableNewEnvironmentConnectionError extends Error {
  constructor(error: unknown, fallbackMessage = "Agent bridge is still starting") {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : fallbackMessage;
    super(message, { cause: error });
    this.name = "RetryableNewEnvironmentConnectionError";
  }
}

// Health-timeout and early-exit wrappers are deliberately absent. The backend
// uses those messages for every child failure, including permanent executable
// and configuration errors, so the wrapper alone cannot establish retryability.
const TRANSIENT_STARTUP_MESSAGE =
  /\b(?:still starting|not ready|became ready|delayed by setup|container is not running|container is restarting|worktree is not available|temporar(?:y|ily)|unavailable|connection refused|timed? out|timeout|econnrefused|econnreset|fetch failed|network error|socket hang up)\b/i;
const GENERIC_STARTUP_FAILURE_MESSAGE =
  /\b(?:did not become healthy|before becoming healthy)\b/i;

function connectionErrorMessage(
  error: unknown,
  fallbackMessage = "Agent bridge startup failed",
): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return fallbackMessage;
}

/**
 * Converts only recognizably transient startup/status failures into the marker
 * consumed by the automatic retry path. Permanent command/configuration errors
 * keep their original identity and surface immediately.
 */
export function classifyNewEnvironmentConnectionStartupError(
  error: unknown,
): Error {
  const message = connectionErrorMessage(error);
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : Number.NaN;
  const retryableStatus = status === 425 || status === 429 || status === 502
    || status === 503 || status === 504;
  if (
    retryableStatus
    || (
      !GENERIC_STARTUP_FAILURE_MESSAGE.test(message)
      && TRANSIENT_STARTUP_MESSAGE.test(message)
    )
  ) {
    return new RetryableNewEnvironmentConnectionError(error);
  }
  return error instanceof Error
    ? error
    : new Error(message);
}

export function isRetryableNewEnvironmentConnectionError(
  error: unknown,
): error is RetryableNewEnvironmentConnectionError {
  return error instanceof RetryableNewEnvironmentConnectionError;
}

/**
 * Starts the retry clock at the first eligible connection attempt, rather than
 * at environment creation. A tab can observe setup for longer than a minute
 * before it is allowed to initialize, and must still receive the same bounded
 * startup grace period once setup releases it.
 */
export function getNewEnvironmentConnectionRetryDecision({
  createdAt,
  attempt,
  retryWindowStartedAt,
  setupPendingObserved,
  now = Date.now(),
}: NewEnvironmentConnectionRetryOptions): NewEnvironmentConnectionRetryDecision | null {
  if (
    !Number.isInteger(attempt)
    || attempt < 0
    || attempt >= NEW_ENVIRONMENT_RETRY_DELAYS_MS.length
  ) {
    return null;
  }

  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const environmentAgeMs = now - createdAtMs;
  if (
    !Number.isFinite(createdAtMs)
    || environmentAgeMs < 0
    || (
      retryWindowStartedAt === null
      && !setupPendingObserved
      && environmentAgeMs > NEW_ENVIRONMENT_RETRY_WINDOW_MS
    )
  ) {
    return null;
  }

  const startedAt = retryWindowStartedAt ?? now;
  const expiresAt = startedAt + NEW_ENVIRONMENT_RETRY_WINDOW_MS;
  const retryWindowAgeMs = now - startedAt;
  if (
    !Number.isFinite(startedAt)
    || !Number.isFinite(expiresAt)
    || retryWindowAgeMs < 0
    || retryWindowAgeMs > NEW_ENVIRONMENT_RETRY_WINDOW_MS
  ) {
    return null;
  }

  const delayMs = NEW_ENVIRONMENT_RETRY_DELAYS_MS[attempt];
  // A retry is useful only if its timer is expected to fire within the bounded
  // startup window. The callback also checks `retryWindowExpiresAt`, because a
  // backgrounded renderer can throttle an otherwise-valid timer past it.
  return delayMs === undefined || now + delayMs > expiresAt
    ? null
    : {
        delayMs,
        retryWindowStartedAt: startedAt,
        retryWindowExpiresAt: expiresAt,
      };
}
