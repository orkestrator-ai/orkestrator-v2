import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";

function isBackendDeletionTombstone(environment: {
  lifecycleOperation?: string;
  deletionRequestedAt?: string;
}): boolean {
  return environment.lifecycleOperation === "deleting" || Boolean(environment.deletionRequestedAt);
}

/**
 * Leave a tearing-down environment so the project workspace is shown instead
 * of the unavailable-environment error that appears while cleanup runs.
 */
export function activateProjectForEnvironmentCleanup(environmentId: string): boolean {
  const ui = useUIStore.getState();
  if (ui.selectedEnvironmentId !== environmentId) return false;

  const envStore = useEnvironmentStore.getState();
  const environment = envStore.getEnvironmentById(environmentId);
  // A fresh renderer-local deletion overrides a stale merge-cleanup error so
  // sidebar and bulk-delete can leave the workspace immediately. A backend
  // tombstone that still carries the error stays selected so retry remains
  // reachable.
  if (
    environment?.cleanupAfterMergeError &&
    !envStore.deletingEnvironments.has(environmentId)
  ) {
    return false;
  }

  const projectId = environment?.projectId ?? ui.selectedProjectId;
  if (!projectId) return false;

  ui.setProjectCollapsed(projectId, false);
  ui.selectProject(projectId);
  return true;
}

/**
 * If the currently selected environment is being deleted by this renderer,
 * activate its project so the main pane does not stay mounted on a workspace
 * that cleanup is tearing down.
 *
 * Missing records are not treated as cleanup: callers select an id first and
 * hydrate the store afterward. A leftover backend tombstone is only a leave
 * reason for the initial remount pass; the store subscriber leaves only when
 * deletion actually starts, so an explicit re-selection after a failed delete
 * survives.
 */
export function reconcileSelectedEnvironmentCleanupSelection(): boolean {
  const ui = useUIStore.getState();
  const selectedEnvironmentId = ui.selectedEnvironmentId;
  if (!selectedEnvironmentId) return false;

  const envStore = useEnvironmentStore.getState();
  const environment = envStore.getEnvironmentById(selectedEnvironmentId);
  if (!environment) return false;

  const locallyDeleting = envStore.deletingEnvironments.has(selectedEnvironmentId);
  if (environment.cleanupAfterMergeError && !locallyDeleting) return false;
  if (!locallyDeleting && !envStore.isDeleting(selectedEnvironmentId)) return false;

  return activateProjectForEnvironmentCleanup(selectedEnvironmentId);
}

export function startEnvironmentCleanupSelectionSync(): () => void {
  const unsubscribeEnvironment = useEnvironmentStore.subscribe((state, previous) => {
    const selectedEnvironmentId = useUIStore.getState().selectedEnvironmentId;
    if (!selectedEnvironmentId) return;

    // Read the snapshots directly. Store helpers like getEnvironmentById() call
    // get() and would see only the current state, hiding the transition.
    const environment = state.environments.find(
      (candidate) => candidate.id === selectedEnvironmentId,
    );
    const previousEnvironment = previous.environments.find(
      (candidate) => candidate.id === selectedEnvironmentId,
    );
    const locallyDeleting = state.deletingEnvironments.has(selectedEnvironmentId);
    const wasLocallyDeleting = previous.deletingEnvironments.has(selectedEnvironmentId);

    if (locallyDeleting && !wasLocallyDeleting) {
      activateProjectForEnvironmentCleanup(selectedEnvironmentId);
      return;
    }

    if (previousEnvironment && !environment) {
      activateProjectForEnvironmentCleanup(selectedEnvironmentId);
      return;
    }

    // Backend cleanup started while this environment was already selected.
    // Selecting an environment that already carries a leftover tombstone is
    // not a transition and must not be reverted.
    if (
      environment &&
      !environment.cleanupAfterMergeError &&
      isBackendDeletionTombstone(environment) &&
      (!previousEnvironment || !isBackendDeletionTombstone(previousEnvironment))
    ) {
      activateProjectForEnvironmentCleanup(selectedEnvironmentId);
    }
  });

  reconcileSelectedEnvironmentCleanupSelection();
  return () => {
    unsubscribeEnvironment();
  };
}
