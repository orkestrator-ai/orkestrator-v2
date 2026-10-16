import { useEffect, useRef } from "react";
import { showEnvironmentUnreadToast } from "@/components/environments/environmentUnreadToast";
import * as backend from "@/lib/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useVisibleEnvironmentId } from "./useVisibleEnvironmentId";

/**
 * Clears an environment's unread badge once this client opens it.
 *
 * Lives at app level rather than in a selection handler so it holds however the
 * user got there — sidebar click, keyboard, or a selection restored on startup.
 * The store is updated optimistically and the backend write is what tells every
 * other client the work has been seen.
 */
export function useUnreadEnvironmentSync(): void {
  const selectedEnvironmentId = useVisibleEnvironmentId();
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
    useEnvironmentStore.getState().updateEnvironment(selectedEnvironmentId, {
      hasUnreadWork: false,
      unreadReason: undefined,
    });
    void backend
      .setEnvironmentUnread(selectedEnvironmentId, false, observedActivityAt)
      .then((persistedEnvironment) => {
        const currentEnvironment = useEnvironmentStore
          .getState()
          .getEnvironmentById(selectedEnvironmentId);
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
          useEnvironmentStore.getState().updateEnvironment(selectedEnvironmentId, {
            hasUnreadWork: persistedEnvironment.hasUnreadWork === true,
            unreadReason: persistedEnvironment.unreadReason,
          });
        }
      })
      .catch((error) => {
        // Keep the optimistic clear for the client currently viewing this
        // environment. The authoritative resource snapshot will restore and
        // retry the badge if the backend mutation did not commit.
        console.warn(
          `[UnreadSync] Failed to clear unread work for ${selectedEnvironmentId}:`,
          error,
        );
      });
  }, [selectedEnvironmentId, environments]);
}
