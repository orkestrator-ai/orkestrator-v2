import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelOpenCodeProviderLogin,
  getOpenCodeProviderLogin,
  startOpenCodeProviderLogin,
  submitOpenCodeProviderLoginCode,
} from "@/lib/backend";
import type { OpenCodeProviderLoginProgress } from "@orkestrator/protocol/opencode-provider-auth";
import { useAccountMachine } from "@/components/settings/account-machine";

const POLL_INTERVAL_MS = 1_500;
const IDLE: OpenCodeProviderLoginProgress = { state: "idle" };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Observe the backend-owned operation, including another provider's pending login.
 * Without a provider id, watch all operations for the Settings section. */
export function useOpenCodeProviderLogin(providerId?: string, onSucceeded?: () => void) {
  const [observed, setObserved] = useState<OpenCodeProviderLoginProgress>(IDLE);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const current = useRef(IDLE);
  const epoch = useRef(0);
  const onSucceededRef = useRef(onSucceeded);
  const pending = observed.state === "pending";
  // Settings may be pointed at another machine; a tab never is.
  const { machine } = useAccountMachine();

  useEffect(() => {
    onSucceededRef.current = onSucceeded;
  }, [onSucceeded]);

  const adopt = useCallback(
    (next: OpenCodeProviderLoginProgress) => {
      const previous = current.current;
      // A read captured before code submission may arrive after its response.
      if (
        previous.operationId === next.operationId &&
        previous.codeSubmitted &&
        next.state === "pending"
      ) {
        next = { ...next, codeSubmitted: true };
      }
      current.current = next;
      setObserved(next);
      const matches = !providerId || next.providerId === providerId;
      setError(
        matches && next.state === "failed" ? (next.error ?? "The sign-in did not complete") : null,
      );
      if (
        matches &&
        next.state === "succeeded" &&
        ((previous.state === "pending" && previous.operationId === next.operationId) ||
          (!providerId && previous.operationId !== next.operationId))
      )
        onSucceededRef.current?.();
    },
    [providerId],
  );

  useEffect(() => {
    const version = ++epoch.current;
    void getOpenCodeProviderLogin(machine)
      .then((existing) => {
        if (epoch.current === version && existing.state === "pending") adopt(existing);
      })
      .catch(() => undefined);
    return () => {
      epoch.current += 1;
    };
  }, [adopt, machine]);

  useEffect(() => {
    if (!pending && providerId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = epoch.current;
      try {
        const next = await getOpenCodeProviderLogin(machine);
        if (active && epoch.current === version) adopt(next);
      } catch {
        /* Retry transient read failures while observing backend state. */
      }
      if (active) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pending, providerId, adopt, machine]);

  const start = useCallback(
    async (input: { providerLabel?: string; method: number; inputs?: Record<string, string> }) => {
      if (!providerId || starting || current.current.state === "pending") return;
      const version = ++epoch.current;
      setError(null);
      setStarting(true);
      try {
        const next = await startOpenCodeProviderLogin({ providerId, ...input }, machine);
        if (epoch.current === version) adopt(next);
      } catch (cause) {
        if (epoch.current === version) setError(messageOf(cause));
      } finally {
        if (epoch.current === version) setStarting(false);
      }
    },
    [adopt, providerId, starting, machine],
  );

  const cancel = useCallback(async () => {
    const operationId = current.current.operationId;
    if (!operationId || current.current.state !== "pending") return;
    const version = ++epoch.current;
    setError(null);
    try {
      const next = await cancelOpenCodeProviderLogin(operationId, machine);
      if (epoch.current === version) adopt(next);
    } catch (cause) {
      if (epoch.current === version) setError(messageOf(cause));
    }
  }, [adopt, machine]);

  const submitCode = useCallback(
    async (code: string) => {
      const version = ++epoch.current;
      const next = await submitOpenCodeProviderLoginCode(code, machine);
      if (epoch.current === version) adopt(next);
    },
    [adopt, machine],
  );

  const matches = !providerId || observed.providerId === providerId;
  return {
    progress: matches ? observed : IDLE,
    otherPending: !matches && pending ? observed : undefined,
    error,
    starting,
    start,
    cancel,
    submitCode,
    reportError: setError,
  };
}
