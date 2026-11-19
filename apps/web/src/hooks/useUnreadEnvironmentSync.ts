import { useEffect, useRef } from "react";
import { showEnvironmentUnreadToast } from "@/components/environments/environmentUnreadToast";
import { useNodeScope } from "@/lib/node-scope/providers";
import { unreadAcknowledgement } from "@/lib/unread-acknowledgement";
import { useWindowForeground } from "@/lib/window-foreground";
import { environmentStore, useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";
import { useVisibleEnvironmentId } from "./useVisibleEnvironmentId";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { useScopeBackend } from "@/hooks/useScopeBackend";

const log = createLogger("web.environment");

/** The response may be applied only if no newer activity arrived meanwhile. */
function persistedIsCurrent(current: Environment, persisted: Environment): boolean {
  const currentActivityAt = current.lastActivityAt ?? null;
  const persistedActivityAt = persisted.lastActivityAt ?? null;
  return (
    currentActivityAt === persistedActivityAt ||
    (persistedActivityAt !== null &&
      Number.isFinite(Date.parse(persistedActivityAt)) &&
      (currentActivityAt === null ||
        Date.parse(persistedActivityAt) >= Date.parse(currentActivityAt)))
  );
}

/**
 * Clears an environment's unread badge once this client has shown the result
 * that lit it.
 *
 * Lives at app level rather than in a selection handler so it holds however the
 * user got there — sidebar click, keyboard, or a selection restored on startup.
 * Selection alone is not viewing: the window must be in the foreground (visible
 * and focused), and when the backend attributes the badge to agent sessions
 * (`unreadSessionKeys`), one of those sessions' tabs must be on screen. Opening
 * a different tab in the environment leaves the badge alone. The activity
 * token sent with the clear stops a view of an older result from clearing a
 * newer one. The store is updated optimistically and the backend write is what
 * tells every other client the work has been seen.
 */
export function useUnreadEnvironmentSync(): void {
  const nodeBackend = useScopeBackend();
  const selectedEnvironmentId = useVisibleEnvironmentId();
  // The node whose environments this watches: the one the selector below reads.
  const scope = useNodeScope();
  const environments = useEnvironmentStore((state) => state.environments);
  const foreground = useWindowForeground();
  // Narrow selections: the per-environment record has a stable reference, so
  // layout changes in other environments do not re-run the effect.
  const layout = usePaneLayoutStore((state) =>
    selectedEnvironmentId ? state.environments.get(selectedEnvironmentId) : undefined,
  );
  const hydration = usePaneLayoutStore((state) =>
    selectedEnvironmentId ? state.hydration.get(selectedEnvironmentId) : undefined,
  );
  // The environment the user just switched to, until its row has been seen.
  // Work that finishes while it is already on screen clears silently instead
  // of toasting, because only an activation reveals a bell the user missed.
  const pendingActivationRef = useRef<string | null>(null);
  const lastVisibleIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedEnvironmentId !== lastVisibleIdRef.current) {
      lastVisibleIdRef.current = selectedEnvironmentId;
      pendingActivationRef.current = selectedEnvironmentId;
    }
    if (!selectedEnvironmentId) return;
    // A selection left in a background window has not been seen. The
    // activation stays pending so the toast shows when the user returns.
    if (!foreground) return;
    const environment = environments.find((candidate) => candidate.id === selectedEnvironmentId);
    if (!environment) return;
    const activated = pendingActivationRef.current === selectedEnvironmentId;
    if (!environment.hasUnreadWork) {
      pendingActivationRef.current = null;
      return;
    }

    const acknowledgement = unreadAcknowledgement(environment, layout, hydration);
    // The tabs are not known yet; decide once the layout has been restored.
    if (acknowledgement.kind === "pending") return;
    pendingActivationRef.current = null;
    if (activated) showEnvironmentUnreadToast(environment);
    if (acknowledgement.kind === "none") return;

    const observedActivityAt = environment.lastActivityAt ?? null;
    const store = scope.store(environmentStore);
    const sessionKeys =
      acknowledgement.kind === "sessions" ? acknowledgement.sessionKeys : undefined;
    const remaining = acknowledgement.kind === "sessions" ? acknowledgement.remaining : [];
    store
      .getState()
      .updateEnvironment(
        selectedEnvironmentId,
        remaining.length > 0
          ? { unreadSessionKeys: remaining }
          : { hasUnreadWork: false, unreadReason: undefined, unreadSessionKeys: undefined },
      );
    // An environment-wide badge sends no session keys, as older clients do.
    const clear = sessionKeys
      ? nodeBackend.setEnvironmentUnread(
          selectedEnvironmentId,
          false,
          observedActivityAt,
          sessionKeys,
        )
      : nodeBackend.setEnvironmentUnread(selectedEnvironmentId, false, observedActivityAt);
    void clear
      .then((persistedEnvironment) => {
        const currentEnvironment = store.getState().getEnvironmentById(selectedEnvironmentId);
        if (!currentEnvironment) return;
        if (persistedIsCurrent(currentEnvironment, persistedEnvironment)) {
          store.getState().updateEnvironment(selectedEnvironmentId, {
            hasUnreadWork: persistedEnvironment.hasUnreadWork === true,
            unreadReason: persistedEnvironment.unreadReason,
            unreadSessionKeys: persistedEnvironment.unreadSessionKeys,
          });
        }
      })
      .catch((error) => {
        // Keep the optimistic clear for the client currently viewing this
        // environment. The authoritative resource snapshot will restore and
        // retry the badge if the backend mutation did not commit.
        log.warn("unread.clear-failed", {
          environmentId: selectedEnvironmentId,
          error: formatLogError(error),
        });
      });
  }, [scope, selectedEnvironmentId, environments, nodeBackend, foreground, layout, hydration]);
}
