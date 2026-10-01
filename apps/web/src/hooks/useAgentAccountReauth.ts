import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelAgentAccountLogin,
  getAgentAccountLogin,
  startAgentAccountLogin,
} from "@/lib/backend";
import type {
  AgentAccountLoginProgress,
  AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";

/** How often to ask the backend whether the browser sign-in has finished. */
const POLL_INTERVAL_MS = 1_500;

const IDLE: AgentAccountLoginProgress = { state: "idle" };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Sign the platform's active account in again, driven by the backend.
 *
 * The backend runs the CLI's own login and owns the credential; this only
 * starts it, polls it and relays the pasted code. A sign-in outlives the card
 * that started it, so a remounted caller resumes the one still running.
 */
export function useAgentAccountReauth(platform: AgentAccountPlatform) {
  const [progress, setProgress] = useState<AgentAccountLoginProgress>(IDLE);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);
  const pending = progress.state === "pending";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const adopt = useCallback(
    (next: AgentAccountLoginProgress) => {
      if (!mounted.current) return;
      // An add-account sign-in from Settings is not this card's to show.
      if (next.platform !== platform || next.mode !== "reauthenticate") {
        setProgress(IDLE);
        return;
      }
      setProgress(next);
      if (next.state === "failed") setError(next.error ?? "The sign-in did not complete");
      // The result has been shown; do not leave it for the next reader.
      if (next.state === "succeeded") void cancelAgentAccountLogin().catch(() => undefined);
    },
    [platform],
  );

  useEffect(() => {
    let current = true;
    void getAgentAccountLogin()
      .then((existing) => {
        if (current && existing.state === "pending") adopt(existing);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [adopt]);

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      void getAgentAccountLogin()
        .then(adopt)
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pending, adopt]);

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      adopt(await startAgentAccountLogin(platform, { reauthenticate: true }));
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      if (mounted.current) setStarting(false);
    }
  }, [adopt, platform]);

  const cancel = useCallback(async () => {
    setError(null);
    await cancelAgentAccountLogin().catch(() => undefined);
    if (mounted.current) setProgress(IDLE);
  }, []);

  return { progress, error, starting, start, cancel, reportError: setError };
}
