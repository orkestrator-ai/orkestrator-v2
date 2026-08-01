export interface TimedSessionState {
  isLoading: boolean;
  loadingStartedAt?: number;
  lastCompletedElapsedSeconds?: number | null;
}

/** Parse a backend-owned turn timestamp without falling back to renderer time. */
export function parseBackendTurnStartedAt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

/**
 * Providers that expose a transcript but no turn clock can use the latest
 * backend-created user message as the authoritative beginning of a busy turn.
 */
export function findLatestBackendUserTurnStartedAt<
  T extends { role: string; createdAt?: string },
>(
  messages: readonly T[],
  isBackendMessage: (message: T) => boolean = () => true,
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    // The latest user message is still optimistic, so the backend has not yet
    // supplied a clock for this turn. Never fall through to the previous turn.
    if (!isBackendMessage(message)) return undefined;
    const startedAt = parseBackendTurnStartedAt(message.createdAt);
    if (startedAt !== undefined) return startedAt;
  }
  return undefined;
}

export function reconcileTimedSession<T extends TimedSessionState>(
  previous: T | undefined,
  session: T,
  now = Date.now(),
): T {
  if (session.isLoading) {
    return {
      ...session,
      loadingStartedAt: session.loadingStartedAt ?? previous?.loadingStartedAt ?? now,
      lastCompletedElapsedSeconds: session.lastCompletedElapsedSeconds ?? null,
    };
  }

  if (previous?.isLoading && previous.loadingStartedAt !== undefined) {
    return {
      ...session,
      loadingStartedAt: undefined,
      lastCompletedElapsedSeconds:
        session.lastCompletedElapsedSeconds
        ?? Math.floor((now - previous.loadingStartedAt) / 1000),
    };
  }

  return {
    ...session,
    loadingStartedAt: undefined,
    lastCompletedElapsedSeconds: session.lastCompletedElapsedSeconds ?? previous?.lastCompletedElapsedSeconds ?? null,
  };
}

export function updateTimedSessionLoading<T extends TimedSessionState>(
  session: T,
  isLoading: boolean,
  now = Date.now(),
  authoritativeStartedAt?: number,
): T {
  if (isLoading) {
    const loadingStartedAt =
      authoritativeStartedAt ?? session.loadingStartedAt ?? now;
    if (
      session.isLoading
      && session.loadingStartedAt === loadingStartedAt
      && session.lastCompletedElapsedSeconds === null
    ) {
      return session;
    }

    return {
      ...session,
      isLoading: true,
      loadingStartedAt,
      lastCompletedElapsedSeconds: null,
    };
  }

  const lastCompletedElapsedSeconds = session.loadingStartedAt !== undefined
    ? Math.floor((now - session.loadingStartedAt) / 1000)
    : (session.lastCompletedElapsedSeconds ?? null);

  return {
    ...session,
    isLoading: false,
    loadingStartedAt: undefined,
    lastCompletedElapsedSeconds,
  };
}
