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

    useEnvironmentStore.getState().updateEnvironment(selectedEnvironmentId, {
      hasUnreadWork: false,
    });
    void backend.setEnvironmentUnread(selectedEnvironmentId, false).catch((error) => {
      console.warn(
        `[UnreadSync] Failed to clear unread work for ${selectedEnvironmentId}:`,
        error,
      );
    });
  }, [selectedEnvironmentId, environments]);
}
