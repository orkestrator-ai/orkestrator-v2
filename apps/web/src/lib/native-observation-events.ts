import {
  NATIVE_AGENT_ACTIVITY_EVENT,
  orderNativeObservationStamp,
  parseNativeAgentActivityAnnouncement,
} from "@orkestrator/protocol/native-agent-observation";
import type { ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import { listen as nativeListen, type NativeEvent, type UnlistenFn } from "@/lib/native/events";

/**
 * Backend observation invalidations for mounted native-agent views
 * (recurring-processes step 07).
 *
 * The backend's activity observer announces every session activity transition
 * with the session's identity and a stamp. This turns them into read
 * coordinator invalidations:
 *
 * - `session`: the announcement names one session (or, from an older backend,
 *   a whole environment); only matching views re-read.
 * - `all`: a stamp gap (a transition was missed) or a new observer lifetime
 *   (backend restart). Every mounted view re-reads once.
 *
 * One transport listener serves every view. This is what lets an idle view of
 * a qualified provider read less often: it is told when it must read.
 */
export type NativeObservationInvalidation =
  | { kind: "session"; environmentId: string; agent?: string; logicalSessionKey?: string }
  | { kind: "all"; reason: "gap" | "reset" };

type Listener = (invalidation: NativeObservationInvalidation) => void;
type Listen = <T>(
  event: string,
  handler: (event: NativeEvent<T>) => unknown,
) => Promise<UnlistenFn>;

export interface NativeObservationEvents {
  subscribe(listener: Listener): () => void;
  /** For tests and diagnostics: the last accepted stamp. */
  lastStamp(): ViewRevisionStamp | null;
  dispose(): void;
}

export function createNativeObservationEvents(listen: Listen): NativeObservationEvents {
  const listeners = new Set<Listener>();
  let last: ViewRevisionStamp | null = null;
  let attachment: Promise<UnlistenFn | null> | null = null;
  let disposed = false;

  const notify = (invalidation: NativeObservationInvalidation) => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(invalidation);
      } catch (error) {
        console.error("[native-observation] Listener threw:", error);
      }
    }
  };

  const handle = (payload: unknown) => {
    const announcement = parseNativeAgentActivityAnnouncement(payload);
    if (!announcement) return;
    if (announcement.stamp) {
      const order = orderNativeObservationStamp(last, announcement.stamp);
      if (order === "duplicate") return;
      last = announcement.stamp;
      if (order === "gap" || order === "reset") {
        notify({ kind: "all", reason: order });
        return;
      }
    }
    notify({
      kind: "session",
      environmentId: announcement.environmentId,
      ...(announcement.agent ? { agent: announcement.agent } : {}),
      ...(announcement.logicalSessionKey
        ? { logicalSessionKey: announcement.logicalSessionKey }
        : {}),
    });
  };

  const attach = () => {
    if (attachment || disposed) return;
    attachment = listen<unknown>(NATIVE_AGENT_ACTIVITY_EVENT, (event) => handle(event.payload))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return null;
        }
        return unlisten;
      })
      .catch((error: unknown) => {
        console.error("[native-observation] Could not subscribe:", error);
        attachment = null;
        return null;
      });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      attach();
      return () => {
        listeners.delete(listener);
      };
    },
    lastStamp: () => last,
    dispose() {
      disposed = true;
      listeners.clear();
      void attachment?.then((unlisten) => unlisten?.());
      attachment = null;
    },
  };
}

let shared: NativeObservationEvents | null = null;

/** Subscribe a mounted view to the shared observation invalidations. */
export function subscribeNativeObservationInvalidations(listener: Listener): () => void {
  shared ??= createNativeObservationEvents(nativeListen);
  return shared.subscribe(listener);
}

/** Whether an invalidation applies to one native session view. */
export function nativeObservationInvalidationMatches(
  invalidation: NativeObservationInvalidation,
  view: { environmentId: string; agent: string; logicalSessionKey: string },
): boolean {
  if (invalidation.kind === "all") return true;
  if (invalidation.environmentId !== view.environmentId) return false;
  // An older backend names only the environment: every view in it re-reads.
  if (invalidation.agent === undefined) return true;
  if (invalidation.agent !== view.agent) return false;
  return (
    invalidation.logicalSessionKey === undefined ||
    invalidation.logicalSessionKey === view.logicalSessionKey
  );
}

export function resetNativeObservationEventsForTests(): void {
  shared?.dispose();
  shared = null;
}
