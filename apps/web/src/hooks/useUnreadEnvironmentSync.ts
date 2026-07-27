import { useEffect } from "react";
import * as backend from "@/lib/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";

/**
 * Clears an environment's unread badge once this client opens it.
 *
 * Lives at app level rather than in a selection handler so it holds however the
 * user got there — sidebar click, keyboard, or a selection restored on startup.
 * The store is updated optimistically and the backend write is what tells every
 * other client the work has been seen.
 */
export function useUnreadEnvironmentSync(): void {
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const environments = useEnvironmentStore((state) => state.environments);

  useEffect(() => {
    if (!selectedEnvironmentId) return;
    const environment = environments.find(
      (candidate) => candidate.id === selectedEnvironmentId,
    );
    if (!environment?.hasUnreadWork) return;

    const observedActivityAt = environment.lastActivityAt ?? null;
    useEnvironmentStore.getState().updateEnvironment(selectedEnvironmentId, {
      hasUnreadWork: false,
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
          (
            persistedActivityAt !== null &&
            Number.isFinite(Date.parse(persistedActivityAt)) &&
            (
              currentActivityAt === null ||
              Date.parse(persistedActivityAt) >= Date.parse(currentActivityAt)
            )
          );
        if (persistedIsCurrent) {
          useEnvironmentStore.getState().updateEnvironment(selectedEnvironmentId, {
            hasUnreadWork: persistedEnvironment.hasUnreadWork === true,
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
