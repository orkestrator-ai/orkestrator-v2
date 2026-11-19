import { useEffect } from "react";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createWorkflowsApi } from "@/lib/backend/workflows";
import { subscribeNativeObservationInvalidations } from "@/lib/native-observation-events";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";

export type NativeSessionTurnActivity = "working" | "waiting";

/** Bursts of hints (a turn start writes its session record more than once) share one read. */
export const NATIVE_SESSION_ACTIVITY_COALESCE_MS = 150;

/**
 * While any session is working, re-read on this cadence too: a turn can end
 * with the session's raw activity unchanged (background work it launched keeps
 * it `working`), and that end announces no transition.
 */
export const NATIVE_SESSION_ACTIVITY_BUSY_POLL_MS = 10_000;

type SessionActivity = ReadonlyMap<string, NativeSessionTurnActivity>;

const NO_SESSIONS: SessionActivity = new Map();

export interface NativeSessionActivityStoreState {
  /**
   * Per environment, the sessions with a turn in flight, keyed by logical
   * session key. An absent environment or session is idle (or not yet read).
   */
  environments: ReadonlyMap<string, SessionActivity>;
  /** Keeps one environment's activity current while at least one consumer holds it. */
  retain: (environmentId: string) => () => void;
  /** Reads the backend for one environment now. Exported for tests. */
  refresh: (environmentId: string) => Promise<void>;
  /** Stops every subscription and forgets the projection. For tests. */
  reset: () => void;
}

function sameSessions(a: SessionActivity | undefined, b: SessionActivity): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [key, state] of a) if (b.get(key) !== state) return false;
  return true;
}

/**
 * Which native sessions in an environment have a turn in flight, as the tab
 * strip's working tint shows it, per node: an environment's sessions run on
 * its node.
 *
 * Presentation only: the activity lives in the backend's activity observer
 * (`list_native_agent_session_activity`), and this is a projection of it, so
 * a tab whose view is not mounted (any tab but the front one of a pane) still
 * shows its turn. Hints re-read it: an activity announcement for the
 * environment, a session record written, and the transport's resync and
 * safety checks, which also cover a missed hint. A stamp gap or observer
 * restart re-reads every held environment. Hints are coalesced per
 * environment, and one read per environment runs at a time.
 */
export const nativeSessionActivityStore = defineScopedStore<NativeSessionActivityStoreState>(
  "native-session-activity",
  (scope) => (set, get) => {
    const retainers = new Map<string, number>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const inFlight = new Map<string, Promise<void>>();
    const rerun = new Set<string>();
    let subscriptions: Array<() => void> | null = null;
    let busyTimer: ReturnType<typeof setInterval> | null = null;

    const api = () =>
      backendApiForScope(scope, createWorkflowsApi, {
        listNativeAgentSessionActivity: backend.listNativeAgentSessionActivity,
      });

    const anyWorking = () => {
      for (const sessions of get().environments.values()) {
        for (const state of sessions.values()) if (state === "working") return true;
      }
      return false;
    };

    const updateBusyPoll = () => {
      const wanted = retainers.size > 0 && anyWorking();
      if (wanted && !busyTimer) {
        busyTimer = setInterval(() => {
          for (const environmentId of retainers.keys()) schedule(environmentId);
        }, NATIVE_SESSION_ACTIVITY_BUSY_POLL_MS);
      } else if (!wanted && busyTimer) {
        clearInterval(busyTimer);
        busyTimer = null;
      }
    };

    const apply = (environmentId: string, sessions: SessionActivity) => {
      const environments = get().environments;
      if (sameSessions(environments.get(environmentId), sessions)) return;
      const next = new Map(environments);
      if (sessions.size === 0) next.delete(environmentId);
      else next.set(environmentId, sessions);
      set({ environments: next });
    };

    const read = async (environmentId: string): Promise<void> => {
      const running = inFlight.get(environmentId);
      if (running) {
        rerun.add(environmentId);
        return running;
      }
      const task = (async () => {
        try {
          const answer = await api().listNativeAgentSessionActivity(environmentId);
          // Released while the read was out: the answer has no consumer.
          if (!retainers.has(environmentId)) return;
          apply(environmentId, new Map(Object.entries(answer)));
        } catch {
          // A failed read keeps the last answer; the next hint or check reads
          // again. A node that predates the command fails every read and so
          // shows no tint.
        } finally {
          updateBusyPoll();
        }
      })();
      inFlight.set(environmentId, task);
      try {
        await task;
      } finally {
        inFlight.delete(environmentId);
        if (rerun.delete(environmentId)) schedule(environmentId);
      }
    };

    function schedule(environmentId: string): void {
      if (!retainers.has(environmentId) || timers.has(environmentId)) return;
      timers.set(
        environmentId,
        setTimeout(() => {
          timers.delete(environmentId);
          void read(environmentId);
        }, NATIVE_SESSION_ACTIVITY_COALESCE_MS),
      );
    }

    const scheduleAll = () => {
      for (const environmentId of retainers.keys()) schedule(environmentId);
    };

    const subscribe = (): Array<() => void> => [
      // The node's own observation announcements.
      subscribeNativeObservationInvalidations((invalidation) => {
        if (invalidation.kind === "all") scheduleAll();
        else schedule(invalidation.environmentId);
      }, scope),
      onResourceChanged("native-agent-session", (change) => schedule(change.id), scope),
      onResourceResync(() => scheduleAll(), scope),
      onViewSafetyCheck(() => scheduleAll(), scope),
    ];

    const stop = () => {
      for (const unsubscribe of subscriptions ?? []) unsubscribe();
      subscriptions = null;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (busyTimer) clearInterval(busyTimer);
      busyTimer = null;
    };
    // A retainer left mounted when the scope goes leaves no timer or listener.
    scope.onDispose("native-session-activity", stop);

    return {
      environments: new Map(),
      retain: (environmentId) => {
        const count = retainers.get(environmentId) ?? 0;
        retainers.set(environmentId, count + 1);
        if (!subscriptions) subscriptions = subscribe();
        if (count === 0) void read(environmentId);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const remaining = (retainers.get(environmentId) ?? 1) - 1;
          if (remaining > 0) {
            retainers.set(environmentId, remaining);
            return;
          }
          retainers.delete(environmentId);
          const timer = timers.get(environmentId);
          if (timer) clearTimeout(timer);
          timers.delete(environmentId);
          rerun.delete(environmentId);
          if (get().environments.has(environmentId)) {
            const next = new Map(get().environments);
            next.delete(environmentId);
            set({ environments: next });
          }
          if (retainers.size === 0) stop();
          else updateBusyPoll();
        };
      },
      refresh: (environmentId) => read(environmentId),
      reset: () => {
        stop();
        retainers.clear();
        rerun.clear();
        set({ environments: new Map() });
      },
    };
  },
);

/**
 * Reads the nearest node scope's activity; other code uses
 * `scope.store(nativeSessionActivityStore)`.
 */
export const useNativeSessionActivityStore = scopedStoreHook(nativeSessionActivityStore);

/**
 * One environment's sessions with a turn in flight, keyed by logical session
 * key, kept current while the caller is mounted.
 */
export function useNativeSessionActivity(
  environmentId: string | null | undefined,
): SessionActivity {
  const retain = useNativeSessionActivityStore((state) => state.retain);
  useEffect(() => (environmentId ? retain(environmentId) : undefined), [environmentId, retain]);
  return useNativeSessionActivityStore((state) =>
    environmentId ? (state.environments.get(environmentId) ?? NO_SESSIONS) : NO_SESSIONS,
  );
}
