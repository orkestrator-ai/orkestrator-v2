import {
  environmentDeletionFailure,
  environmentHasDeletionTombstone,
} from "@orkestrator/protocol/node-summaries";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { Environment } from "@/types";
import { environmentStore } from "@/stores/environmentStore";
import { uiStore } from "@/stores/uiStore";

/**
 * Leave a tearing-down environment so the project workspace is shown instead
 * of the unavailable-environment error that appears while cleanup runs.
 */
export function activateProjectForEnvironmentCleanup(
  environmentId: string,
  scope: NodeScope,
  previousEnvironment?: Environment,
): boolean {
  const ui = scope.store(uiStore).getState();
  if (ui.selectedEnvironmentId !== environmentId) return false;

  const envStore = scope.store(environmentStore).getState();
  const environment = envStore.getEnvironmentById(environmentId) ?? previousEnvironment;
  // A fresh renderer-local deletion overrides a stale merge-cleanup error so
  // sidebar and bulk-delete can leave the workspace immediately. A backend
  // tombstone that still carries the error stays selected so retry remains
  // reachable.
  if (
    environment &&
    environmentDeletionFailure(environment) &&
    !envStore.deletingEnvironments.has(environmentId)
  ) {
    return false;
  }

  const projectId = environment?.projectId ?? ui.selectedProjectId;
  if (!projectId) return false;

  ui.setProjectCollapsed(projectId, false);
  ui.selectProject(environment?.projectHome ? null : projectId);
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
export function reconcileSelectedEnvironmentCleanupSelection(scope: NodeScope): boolean {
  const ui = scope.store(uiStore).getState();
  const selectedEnvironmentId = ui.selectedEnvironmentId;
  if (!selectedEnvironmentId) return false;

  const envStore = scope.store(environmentStore).getState();
  const environment = envStore.getEnvironmentById(selectedEnvironmentId);
  if (!environment) return false;

  const locallyDeleting = envStore.deletingEnvironments.has(selectedEnvironmentId);
  if (environmentDeletionFailure(environment) && !locallyDeleting) return false;
  if (!locallyDeleting && !envStore.isDeleting(selectedEnvironmentId)) return false;

  return activateProjectForEnvironmentCleanup(selectedEnvironmentId, scope);
}

/** Watches `scope`'s environments for the selected one being torn down. */
export function startEnvironmentCleanupSelectionSync(scope: NodeScope): () => void {
  const unsubscribeEnvironment = scope.store(environmentStore).subscribe((state, previous) => {
    const selectedEnvironmentId = scope.store(uiStore).getState().selectedEnvironmentId;
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
      activateProjectForEnvironmentCleanup(selectedEnvironmentId, scope);
      return;
    }

    if (previousEnvironment && !environment) {
      activateProjectForEnvironmentCleanup(selectedEnvironmentId, scope, previousEnvironment);
      return;
    }

    // Backend cleanup started while this environment was already selected.
    // Selecting an environment that already carries a leftover tombstone is
    // not a transition and must not be reverted.
    if (
      environment &&
      !environmentDeletionFailure(environment) &&
      environmentHasDeletionTombstone(environment) &&
      (!previousEnvironment || !environmentHasDeletionTombstone(previousEnvironment))
    ) {
      activateProjectForEnvironmentCleanup(selectedEnvironmentId, scope);
    }
  });

  reconcileSelectedEnvironmentCleanupSelection(scope);
  return () => {
    unsubscribeEnvironment();
  };
}
