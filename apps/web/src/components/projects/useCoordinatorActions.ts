import { useCallback, useState } from "react";

/**
 * Git actions and conversation actions are independent on the backend (Git is
 * serialized per repository root, conversations per project), so one running
 * never disables the other's controls.
 */
export type CoordinatorActionKind = "fetch" | "sync" | "switch" | "conversation";

export interface CoordinatorActionOptions {
  /** Shown when the failure carries no message of its own. */
  failureMessage: string;
  /** A failure that is expected here is neither shown nor passed to `onFailure`. */
  ignoreFailure?: (cause: unknown) => boolean;
  onFailure?: () => void;
}

/**
 * The panel's one pattern for an action the user sees: it marks its kind busy,
 * clears the earlier error, reports its own failure and always lets go. Never
 * rejects, so a caller can start one without handling it.
 */
export function useCoordinatorActions() {
  const [running, setRunning] = useState<readonly { kind: CoordinatorActionKind }[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const runAction = useCallback(
    async (
      kind: CoordinatorActionKind,
      action: () => Promise<unknown>,
      options: CoordinatorActionOptions,
    ): Promise<void> => {
      // Each action lets go of its own entry, so the first of two overlapping
      // actions to finish does not report the other as finished too.
      const entry = { kind };
      setRunning((current) => [...current, entry]);
      setActionError(null);
      try {
        await action();
      } catch (cause) {
        if (options.ignoreFailure?.(cause)) return;
        setActionError(cause instanceof Error ? cause.message : options.failureMessage);
        options.onFailure?.();
      } finally {
        setRunning((current) => current.filter((item) => item !== entry));
      }
    },
    [],
  );
  return {
    runAction,
    actionError,
    setActionError,
    gitBusy: running.some((item) => item.kind !== "conversation"),
    fetching: running.some((item) => item.kind === "fetch"),
    conversationBusy: running.some((item) => item.kind === "conversation"),
  };
}

export type RunCoordinatorAction = ReturnType<typeof useCoordinatorActions>["runAction"];
