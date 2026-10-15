import { useCallback, useEffect, useMemo, useRef } from "react";
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
/** Failed polls back off to this interval (a restarting or unreachable remote). */
export const MAX_POLL_BACKOFF_MS = 30_000;
/** Polls that keep failing for this long stop; the dialog's refresh re-reads. */
export const POLL_GIVE_UP_MS = 10 * 60 * 1000;

export type UpdateTargetHandle = UpdateTargetState & {
  api: UpdatesApi;
  /** Re-reads the status, or joins the read in flight; false when it failed. */
  refresh(): Promise<boolean>;
  /** Runs a command, applies the snapshot it returns, and records its error. */
  run(action: (api: UpdatesApi) => Promise<UpdateStatusSnapshot>): Promise<boolean>;
};

/**
 * Keeps one update target fresh: an authoritative read on mount, live
 * snapshots from the event stream, a re-read whenever events may have been
 * missed (a reconnect), and polling while a job runs. Background work lives
 * in the backend, so unmounting only stops watching.
 */
export function useUpdateTarget(transport: UpdateTransport, options: { watch?: boolean } = {}) {
  const watch = options.watch ?? true;
  const key = transport.key;
  const state = useUpdateStore(selectUpdateTarget(key));
  const api = useMemo(() => updatesApi(transport), [transport]);

  const inFlight = useRef<Promise<boolean> | null>(null);
  const refresh = useCallback(() => {
    // A slow or unreachable backend must not collect a read per poll tick.
    inFlight.current ??= (async () => {
      try {
        const snapshot = await api.status();
        if (!snapshot || typeof snapshot.revision !== "number") {
          throw new Error("The backend returned no update status");
        }
        useUpdateStore.getState().applySnapshot(key, snapshot, true);
        return true;
      } catch (error) {
        useUpdateStore.getState().setError(key, parseUpdateError(error));
        return false;
      } finally {
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, [api, key]);

  useEffect(() => {
    if (!watch) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void transport
      .subscribe(
        (event) => void useUpdateStore.getState().applySnapshot(key, event.snapshot, false),
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
    let disposed = false;
    let delay = ACTIVE_JOB_POLL_MS;
    let failingSince: number | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const ok = await refresh();
      if (disposed) return;
      if (ok) {
        delay = ACTIVE_JOB_POLL_MS;
        failingSince = null;
      } else {
        failingSince ??= Date.now();
        if (Date.now() - failingSince >= POLL_GIVE_UP_MS) return;
        delay = Math.min(delay * 2, MAX_POLL_BACKOFF_MS);
      }
      timer = setTimeout(() => void poll(), delay);
    };
    timer = setTimeout(() => void poll(), delay);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
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
