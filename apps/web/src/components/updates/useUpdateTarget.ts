import { useCallback, useEffect, useMemo } from "react";
import { isTerminalUpdatePhase, type UpdateStatusSnapshot } from "@orkestrator/protocol/updates";
import {
  parseUpdateError,
  updatesApi,
  type UpdateTransport,
  type UpdatesApi,
} from "@/lib/updates/update-client";
import { selectUpdateTarget, useUpdateStore, type UpdateTargetState } from "@/stores/updateStore";

/** While a job runs, also poll: a restart drops the event stream for a while. */
export const ACTIVE_JOB_POLL_MS = 2_000;

export type UpdateTargetHandle = UpdateTargetState & {
  api: UpdatesApi;
  refresh(): Promise<void>;
  /** Runs a command, applies the snapshot it returns, and records its error. */
  run(action: (api: UpdatesApi) => Promise<UpdateStatusSnapshot>): Promise<boolean>;
};

/**
 * Keeps one update target fresh: an authoritative read on mount, live
 * snapshots from the event stream, a re-read whenever events may have been
 * missed (a reconnect, a stale revision), and polling while a job runs.
 * Background work lives in the backend, so unmounting only stops watching.
 */
export function useUpdateTarget(transport: UpdateTransport, options: { watch?: boolean } = {}) {
  const watch = options.watch ?? true;
  const key = transport.key;
  const state = useUpdateStore(selectUpdateTarget(key));
  const api = useMemo(() => updatesApi(transport), [transport]);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await api.status();
      if (!snapshot || typeof snapshot.revision !== "number") {
        throw new Error("The backend returned no update status");
      }
      useUpdateStore.getState().applySnapshot(key, snapshot, true);
    } catch (error) {
      useUpdateStore.getState().setError(key, parseUpdateError(error));
    }
  }, [api, key]);

  useEffect(() => {
    if (!watch) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void transport
      .subscribe(
        (event) => {
          if (useUpdateStore.getState().applySnapshot(key, event.snapshot, false) === "stale") {
            void refresh();
          }
        },
        () => void refresh(),
      )
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else stop = unsubscribe;
      })
      .catch(() => undefined);
    void refresh();
    return () => {
      disposed = true;
      stop?.();
    };
  }, [key, refresh, transport, watch]);

  const jobActive = Boolean(
    state.snapshot?.job && !isTerminalUpdatePhase(state.snapshot.job.phase),
  );
  useEffect(() => {
    if (!watch || !jobActive) return;
    const timer = setInterval(() => void refresh(), ACTIVE_JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [jobActive, refresh, watch]);

  const run = useCallback(
    async (action: (api: UpdatesApi) => Promise<UpdateStatusSnapshot>) => {
      const store = useUpdateStore.getState();
      store.setBusy(key, true);
      try {
        store.applySnapshot(key, await action(api), true);
        return true;
      } catch (error) {
        useUpdateStore.getState().setError(key, parseUpdateError(error));
        return false;
      } finally {
        useUpdateStore.getState().setBusy(key, false);
      }
    },
    [api, key],
  );

  return { ...state, api, refresh, run } satisfies UpdateTargetHandle;
}
