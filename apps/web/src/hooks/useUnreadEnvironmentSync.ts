import { useEffect, useRef } from "react";
import { showEnvironmentUnreadToast } from "@/components/environments/environmentUnreadToast";
import { useNodeScope } from "@/lib/node-scope/providers";
import { environmentStore, useEnvironmentStore } from "@/stores/environmentStore";
import { useVisibleEnvironmentId } from "./useVisibleEnvironmentId";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { useScopeBackend } from "@/hooks/useScopeBackend";

const log = createLogger("web.environment");

/**
 * Clears an environment's unread badge once this client opens it.
 *
 * Lives at app level rather than in a selection handler so it holds however the
 * user got there — sidebar click, keyboard, or a selection restored on startup.
 * The store is updated optimistically and the backend write is what tells every
 * other client the work has been seen.
 */
export function useUnreadEnvironmentSync(): void {
  const nodeBackend = useScopeBackend();
  const selectedEnvironmentId = useVisibleEnvironmentId();
  // The node whose environments this watches: the one the selector below reads.
  const scope = useNodeScope();
  const environments = useEnvironmentStore((state) => state.environments);
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
    const environment = environments.find((candidate) => candidate.id === selectedEnvironmentId);
    if (!environment) return;
    const activated = pendingActivationRef.current === selectedEnvironmentId;
    pendingActivationRef.current = null;
    if (!environment.hasUnreadWork) return;

    if (activated) showEnvironmentUnreadToast(environment);
    const observedActivityAt = environment.lastActivityAt ?? null;
    const store = scope.store(environmentStore);
    store.getState().updateEnvironment(selectedEnvironmentId, {
      hasUnreadWork: false,
      unreadReason: undefined,
    });
    void nodeBackend
      .setEnvironmentUnread(selectedEnvironmentId, false, observedActivityAt)
      .then((persistedEnvironment) => {
        const currentEnvironment = store.getState().getEnvironmentById(selectedEnvironmentId);
        if (!currentEnvironment) return;

        const currentActivityAt = currentEnvironment.lastActivityAt ?? null;
        const persistedActivityAt = persistedEnvironment.lastActivityAt ?? null;
        const persistedIsCurrent =
          currentActivityAt === persistedActivityAt ||
          (persistedActivityAt !== null &&
            Number.isFinite(Date.parse(persistedActivityAt)) &&
            (currentActivityAt === null ||
              Date.parse(persistedActivityAt) >= Date.parse(currentActivityAt)));
        if (persistedIsCurrent) {
          store.getState().updateEnvironment(selectedEnvironmentId, {
            hasUnreadWork: persistedEnvironment.hasUnreadWork === true,
            unreadReason: persistedEnvironment.unreadReason,
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
  }, [scope, selectedEnvironmentId, environments, nodeBackend]);
}
