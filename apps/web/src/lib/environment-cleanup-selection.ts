import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";

/**
 * Leave a tearing-down environment so the project workspace is shown instead
 * of the unavailable-environment error that appears while cleanup runs.
 */
export function activateProjectForEnvironmentCleanup(environmentId: string): boolean {
  const ui = useUIStore.getState();
  if (ui.selectedEnvironmentId !== environmentId) return false;

  const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
  if (environment?.cleanupAfterMergeError) return false;

  const projectId = environment?.projectId ?? ui.selectedProjectId;
  if (!projectId) return false;

  ui.setProjectCollapsed(projectId, false);
  ui.selectProject(projectId);
  return true;
}

/**
 * If the currently selected environment is being deleted — or has already
 * disappeared — activate its project so the main pane does not stay mounted
 * on a workspace that cleanup is tearing down.
 */
export function reconcileSelectedEnvironmentCleanupSelection(): boolean {
  const ui = useUIStore.getState();
  const selectedEnvironmentId = ui.selectedEnvironmentId;
  if (!selectedEnvironmentId) return false;

  const envStore = useEnvironmentStore.getState();
  const environment = envStore.getEnvironmentById(selectedEnvironmentId);

  if (!environment) {
    if (!ui.selectedProjectId) return false;
    ui.selectProject(ui.selectedProjectId);
    return true;
  }

  if (environment.cleanupAfterMergeError) return false;
  if (!envStore.isDeleting(selectedEnvironmentId)) return false;

  return activateProjectForEnvironmentCleanup(selectedEnvironmentId);
}

export function startEnvironmentCleanupSelectionSync(): () => void {
  const unsubscribeEnvironment = useEnvironmentStore.subscribe(() => {
    reconcileSelectedEnvironmentCleanupSelection();
  });
  const unsubscribeUi = useUIStore.subscribe((state, previous) => {
    if (
      state.selectedEnvironmentId === previous.selectedEnvironmentId &&
      state.selectedProjectId === previous.selectedProjectId
    ) {
      return;
    }
    reconcileSelectedEnvironmentCleanupSelection();
  });
  reconcileSelectedEnvironmentCleanupSelection();
  return () => {
    unsubscribeEnvironment();
    unsubscribeUi();
  };
}
