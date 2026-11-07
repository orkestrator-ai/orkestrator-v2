import {
  NATIVE_AGENT_ACTIVITY_EVENT,
  orderNativeObservationStamp,
  parseNativeAgentActivityAnnouncement,
} from "@orkestrator/protocol/native-agent-observation";
import type { ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import { nativeAgentSessionActivityEvent } from "@orkestrator/protocol/contract/domains/events";
import type { NativeEvent, UnlistenFn } from "@/lib/native/events";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot, listenInScope } from "@/lib/node-scope-slots";

const log = createLogger("web.resource-sync");

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
 * One transport listener per node scope serves every view of that node (plan
 * item 3009): the stamps are one node's observer lifetime, so two nodes'
 * announcements must never be ordered against each other. This is what lets
 * an idle view of a qualified provider read less often: it is told when it
 * must read.
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
        log.error("observation.listener-threw", { error: formatLogError(error) });
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
        log.error("observation.subscribe-failed", { error: formatLogError(error) });
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

/** The node's one listener, created on first subscription and stopped on dispose. */
const sharedEvents = defineScopedSlot<{ events: NativeObservationEvents | null }>(
  "native-observation-events",
  (scope) => {
    const slot: { events: NativeObservationEvents | null } = { events: null };
    scope.onDispose("native-observation-events", () => {
      slot.events?.dispose();
      slot.events = null;
    });
    return slot;
  },
);

function eventsFor(scope: NodeScope): NativeObservationEvents {
  const slot = sharedEvents(scope);
  // The one event it listens to, by its definition (plan item 7011), on the
  // app's command scope (`@/lib/native/events`, what suites emit) or the
  // scope's own client.
  slot.events ??= createNativeObservationEvents(
    <T>(_event: string, handler: (event: NativeEvent<T>) => unknown) =>
      listenInScope(scope, nativeAgentSessionActivityEvent, (payload) =>
        handler({ payload: payload as T }),
      ),
  );
  return slot.events;
}

/**
 * Subscribe a mounted view to its node's shared observation invalidations
 * (the app's command scope when `scope` is omitted).
 */
export function subscribeNativeObservationInvalidations(
  listener: Listener,
  scope: NodeScope = appCommandScope(),
): () => void {
  return eventsFor(scope).subscribe(listener);
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

export function resetNativeObservationEventsForTests(scope: NodeScope = appCommandScope()): void {
  const slot = sharedEvents(scope);
  slot.events?.dispose();
  slot.events = null;
}
