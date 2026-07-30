const NEW_ENVIRONMENT_RETRY_WINDOW_MS = 60_000;

const NEW_ENVIRONMENT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;

export interface NewEnvironmentConnectionRetryDecision {
  delayMs: number;
  retryWindowStartedAt: number;
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

const TRANSIENT_STARTUP_MESSAGE =
  /\b(?:still starting|not ready|became ready|did not become healthy|before becoming healthy|delayed by setup|container is not running|container is restarting|worktree is not available|temporar(?:y|ily)|unavailable|connection refused|timed? out|timeout|econnrefused|econnreset|fetch failed|network error|socket hang up)\b/i;

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
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : Number.NaN;
  const retryableStatus = status === 425 || status === 429 || status === 502
    || status === 503 || status === 504;
  if (retryableStatus || TRANSIENT_STARTUP_MESSAGE.test(connectionErrorMessage(error))) {
    return new RetryableNewEnvironmentConnectionError(error);
  }
  return error instanceof Error
    ? error
    : new Error(connectionErrorMessage(error));
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
  const retryWindowAgeMs = now - startedAt;
  if (
    !Number.isFinite(startedAt)
    || retryWindowAgeMs < 0
    || retryWindowAgeMs > NEW_ENVIRONMENT_RETRY_WINDOW_MS
  ) {
    return null;
  }

  const delayMs = NEW_ENVIRONMENT_RETRY_DELAYS_MS[attempt];
  return delayMs === undefined
    ? null
    : { delayMs, retryWindowStartedAt: startedAt };
}
