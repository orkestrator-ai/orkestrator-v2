export interface TimedSessionState {
  isLoading: boolean;
  loadingStartedAt?: number;
  lastCompletedElapsedSeconds?: number | null;
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
): T {
  if (isLoading) {
    if (session.isLoading && session.loadingStartedAt !== undefined) {
      return session;
    }

    return {
      ...session,
      isLoading: true,
      loadingStartedAt: session.loadingStartedAt ?? now,
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
