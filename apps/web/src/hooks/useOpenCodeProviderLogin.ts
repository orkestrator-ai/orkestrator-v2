import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelOpenCodeProviderLogin,
  getOpenCodeProviderLogin,
  startOpenCodeProviderLogin,
} from "@/lib/backend";
import type { OpenCodeProviderLoginProgress } from "@orkestrator/protocol/opencode-provider-auth";

const POLL_INTERVAL_MS = 1_500;
const IDLE: OpenCodeProviderLoginProgress = { state: "idle" };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * One provider's OAuth sign-in, as the backend runs it. The sign-in outlives
 * the component, so a remount picks a running one back up; a sign-in for
 * another provider reads as idle here.
 */
export function useOpenCodeProviderLogin(providerId: string, onSucceeded?: () => void) {
  const [progress, setProgress] = useState<OpenCodeProviderLoginProgress>(IDLE);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const current = useRef(IDLE);
  const epoch = useRef(0);
  const onSucceededRef = useRef(onSucceeded);
  const pending = progress.state === "pending";

  useEffect(() => {
    onSucceededRef.current = onSucceeded;
  }, [onSucceeded]);

  const adopt = useCallback(
    (next: OpenCodeProviderLoginProgress) => {
      if (next.providerId !== providerId) next = IDLE;
      const previous = current.current;
      current.current = next;
      setProgress(next);
      setError(next.state === "failed" ? (next.error ?? "The sign-in did not complete") : null);
      if (
        next.state === "succeeded" &&
        previous.state === "pending" &&
        previous.operationId === next.operationId
      ) {
        onSucceededRef.current?.();
      }
    },
    [providerId],
  );

  useEffect(() => {
    const version = ++epoch.current;
    // Only a sign-in still running is resumed; a finished one belongs to
    // whichever view started it. Each view is mounted for one provider, so
    // there is no earlier provider's state to clear first.
    void getOpenCodeProviderLogin()
      .then((existing) => {
        if (epoch.current === version && existing.state === "pending") adopt(existing);
      })
      .catch(() => undefined);
    return () => {
      epoch.current += 1;
    };
  }, [adopt]);

  useEffect(() => {
    if (!pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const version = epoch.current;
    const poll = async () => {
      try {
        const next = await getOpenCodeProviderLogin();
        if (active && epoch.current === version) adopt(next);
      } catch {
        /* Retry transient read failures while pending. */
      }
      if (active && epoch.current === version && current.current.state === "pending") {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pending, adopt]);

  const start = useCallback(
    async (input: { providerLabel?: string; method: number; inputs?: Record<string, string> }) => {
      const version = ++epoch.current;
      current.current = IDLE;
      setProgress(IDLE);
      setError(null);
      setStarting(true);
      try {
        const next = await startOpenCodeProviderLogin({ providerId, ...input });
        if (epoch.current === version) adopt(next);
      } catch (cause) {
        if (epoch.current === version) setError(messageOf(cause));
      } finally {
        if (epoch.current === version) setStarting(false);
      }
    },
    [adopt, providerId],
  );

  const cancel = useCallback(async () => {
    const operationId = current.current.operationId;
    if (!operationId) return;
    const version = ++epoch.current;
    current.current = IDLE;
    setProgress(IDLE);
    setError(null);
    try {
      const next = await cancelOpenCodeProviderLogin(operationId);
      if (epoch.current === version) adopt(next);
    } catch (cause) {
      if (epoch.current === version) setError(messageOf(cause));
    }
  }, [adopt]);

  return { progress, error, starting, start, cancel, reportError: setError };
}
