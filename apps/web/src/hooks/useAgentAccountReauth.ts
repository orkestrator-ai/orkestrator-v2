import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelAgentAccountLogin,
  getAgentAccountLogin,
  listAgentAccounts,
  startAgentAccountLogin,
} from "@/lib/backend";
import type {
  AgentAccountLoginProgress,
  AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";

const POLL_INTERVAL_MS = 1_500;
const IDLE: AgentAccountLoginProgress = { state: "idle" };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Backend-owned sign-in survives unmount; reads are serialized and fenced by lifecycle. */
export function useAgentAccountReauth(
  platform: AgentAccountPlatform,
  enabled = true,
  failureAt?: string,
) {
  const [progress, setProgress] = useState<AgentAccountLoginProgress>(IDLE);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const current = useRef(IDLE);
  const epoch = useRef(0);
  const pending = progress.state === "pending";

  const adopt = useCallback(
    (next: AgentAccountLoginProgress) => {
      if (next.platform !== platform || next.mode !== "reauthenticate") {
        // A result remains visible after another reader dismisses it.
        if (current.current.state === "succeeded" || current.current.state === "failed") return;
        next = IDLE;
      }
      current.current = next;
      setProgress(next);
      setError(next.state === "failed" ? (next.error ?? "The sign-in did not complete") : null);
      // Keep terminal results in the backend so every remounted card can recover
      // them. A successful poll must never cancel a different operation.
    },
    [platform],
  );

  useEffect(() => {
    const version = ++epoch.current;
    current.current = IDLE;
    setProgress(IDLE);
    setError(null);
    if (enabled) {
      void getAgentAccountLogin()
        .then(async (existing) => {
          if (
            existing.completedAt &&
            failureAt &&
            Date.parse(existing.completedAt) < Date.parse(failureAt)
          )
            return;
          if (existing.operationId && existing.accountId && existing.state !== "pending") {
            const accounts = await listAgentAccounts();
            if (accounts.active[platform] !== existing.accountId) return;
          }
          if (epoch.current === version) adopt(existing);
        })
        .catch(() => undefined);
    }
    return () => {
      epoch.current += 1;
    };
  }, [adopt, enabled, platform, failureAt]);

  useEffect(() => {
    if (!enabled || !pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const version = epoch.current;
    const poll = async () => {
      try {
        const next = await getAgentAccountLogin();
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
  }, [enabled, pending, adopt]);

  const start = useCallback(async () => {
    if (!enabled) return;
    const version = ++epoch.current;
    current.current = IDLE;
    setProgress(IDLE);
    setError(null);
    setStarting(true);
    try {
      const next = await startAgentAccountLogin(platform, { reauthenticate: true });
      if (epoch.current === version) adopt(next);
    } catch (cause) {
      if (epoch.current === version) setError(messageOf(cause));
    } finally {
      if (epoch.current === version) setStarting(false);
    }
  }, [adopt, enabled, platform]);

  const cancel = useCallback(async () => {
    const operationId = current.current.operationId;
    if (!operationId) return;
    const version = ++epoch.current;
    current.current = IDLE;
    setProgress(IDLE);
    setError(null);
    try {
      const next = await cancelAgentAccountLogin(operationId);
      if (epoch.current === version) adopt(next);
    } catch (cause) {
      if (epoch.current === version) setError(messageOf(cause));
    }
  }, [adopt]);

  return { progress, error, starting, start, cancel, reportError: setError };
}
