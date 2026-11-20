import { projectLandingBoardTab } from "./window-grouping";
import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { portalStore } from "@/lib/portal/portal-store";
import type {
  CreateEnvironmentHandoff,
  CreateEnvironmentRecovery,
  WorkspaceBoardTab,
  WorkspaceDialog,
  WorkspaceWorkTarget,
  WorkspaceRequest,
} from "@/lib/federation/workspace-request";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { filesPanelStore } from "@/stores/filesPanelStore";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { uiStore } from "@/stores/uiStore";

export interface MachineWorkspaceSpec {
  /** The node, by identity. */
  connectionId: string;
  /** Empty: the node's project launcher (to add a project there). */
  projectId: string;
  environmentId?: string;
  /** Board navigation: always shown, whatever tab the project was last left on. */
  boardTab?: WorkspaceBoardTab;
  /** The tab for a project with no last tab of its own (`WorkspaceRequest.landingTab`). */
  landingTab?: WorkspaceBoardTab;
  workTarget?: WorkspaceWorkTarget;
  filesPanelTab?: WorkspaceRequest["filesPanelTab"];
  /** Open the New Environment dialog for `projectId` instead of selecting it. */
  createEnvironment?: boolean;
  createEnvironmentHandoff?: CreateEnvironmentHandoff;
  createEnvironmentRecovery?: CreateEnvironmentRecovery;
  /**
   * Open one of the node's own dialogs over the selection: the project's, or
   * with `environmentId`, the environment's settings (or its rebuild).
   */
  dialog?: WorkspaceDialog;
  /** For messages while it opens. */
  title: string;
}

/**
 * Every portal entry point opens a node's environment the same way. The
 * window always stays on its command node: one of its own environments is an
 * ordinary selection, and another node's is shown in the central region, in
 * the window's own tree, without reloading anything around it.
 *
 * Creating an environment on another node goes through that node's own New
 * Environment dialog, so its defaults (the command node's inherited settings
 * laid over the node's own) and start apply as they would there.
 */
export function openMachineWorkspace(spec: MachineWorkspaceSpec): void {
  const selfId = portalStore.getState().selfId;
  if (!spec.connectionId || !selfId || spec.connectionId === selfId) {
    useRemoteWorkspaceStore.getState().showLocal();
    const scope = getWindowScope().commandScope();
    const ui = scope.store(uiStore).getState();
    if (!spec.projectId) return;
    if (spec.createEnvironment) {
      useAppDialogStore.getState().open({
        kind: "create-environment",
        nodeId: scope.nodeId,
        projectId: spec.projectId,
        ...(spec.createEnvironmentHandoff ? { handoff: spec.createEnvironmentHandoff } : {}),
        ...(spec.createEnvironmentRecovery ? { recovery: spec.createEnvironmentRecovery } : {}),
      });
    } else if (spec.environmentId) {
      ui.selectProjectAndEnvironment(spec.projectId, spec.environmentId, {
        landingTab: spec.landingTab,
      });
      // A project home opens on its Home tab, as its own sidebar opens it.
      if (spec.boardTab) ui.setProjectBoardTab(spec.boardTab);
    } else {
      ui.selectProject(spec.projectId, { landingTab: spec.landingTab });
      if (spec.boardTab) ui.setProjectBoardTab(spec.boardTab);
    }
    if (spec.environmentId && spec.filesPanelTab) {
      scope.store(filesPanelStore).getState().setActiveTab(spec.filesPanelTab);
      useFilesPanelChromeStore.getState().openPanel();
    }
    if (spec.dialog) openDialog(spec.dialog, spec.projectId, spec.environmentId);
    return;
  }
  useRemoteWorkspaceStore.getState().open(
    spec.connectionId,
    !spec.projectId
      ? { addProject: true }
      : spec.createEnvironment
        ? {
            projectId: spec.projectId,
            createEnvironmentProjectId: spec.projectId,
            ...(spec.createEnvironmentHandoff
              ? { createEnvironmentHandoff: spec.createEnvironmentHandoff }
              : {}),
            ...(spec.createEnvironmentRecovery
              ? { createEnvironmentRecovery: spec.createEnvironmentRecovery }
              : {}),
          }
        : {
            projectId: spec.projectId,
            ...(spec.environmentId ? { environmentId: spec.environmentId } : {}),
            ...(spec.boardTab ? { boardTab: spec.boardTab } : {}),
            ...(spec.landingTab ? { landingTab: spec.landingTab } : {}),
            ...(spec.filesPanelTab ? { filesPanelTab: spec.filesPanelTab } : {}),
            ...(spec.workTarget ? { workTarget: spec.workTarget } : {}),
            ...(spec.dialog ? { dialog: spec.dialog } : {}),
          },
  );
}

/**
 * Opens a repository from its heading: the command node's copy of the
 * project, else (none here) a leaf's, on the tab that project was last left
 * on. A project with none opens on its coordinator, which a leaf's workspace
 * opens directly; a window whose own node is in leaf mode lands on its home,
 * since its coordinator is gated. With `coordinator` (the Open Coordinator
 * menu item) it always opens the coordinator.
 */
export function openRepository(spec: {
  /** The repository's identity, which also names its group. */
  repository: string;
  /** The node-qualified key of the member project it opens. */
  projectKey: string;
  connectionId: string;
  projectId: string;
  coordinatorGated: boolean;
  onCommandNode: boolean;
  commandHasCopy: boolean;
  /** Always open the coordinator rather than the project's last tab. */
  coordinator?: boolean;
  title: string;
}): void {
  openMachineWorkspace({
    connectionId: spec.connectionId,
    projectId: spec.projectId,
    ...(spec.coordinatorGated
      ? {}
      : spec.coordinator
        ? { boardTab: "coordinator" as const }
        : {
            landingTab: projectLandingBoardTab(
              "repository",
              spec.onCommandNode,
              spec.commandHasCopy,
            ),
          }),
    title: spec.title,
  });
  useMachineViewStore
    .getState()
    .noteRepositoryOpened({ name: spec.repository, projectKey: spec.projectKey });
}

/**
 * Opens one of a node's dialogs, as its sidebar menus do: this window's own
 * node's (its command scope's) unless `nodeId` names another node with a
 * scope here (one shown in the window's tree, plan item 4001).
 */
export function openDialog(
  dialog: WorkspaceDialog,
  projectId: string,
  environmentId?: string,
  nodeId: BackendId = getWindowScope().commandScope().nodeId,
): void {
  const dialogs = useAppDialogStore.getState();
  if (dialog === "environment-settings" || dialog === "environment-rebuild") {
    if (environmentId)
      dialogs.open({
        kind: "environment-settings",
        nodeId,
        environmentId,
        ...(dialog === "environment-rebuild" ? { section: "container" as const } : {}),
      });
    return;
  }
  dialogs.open({ kind: dialog, nodeId, projectId });
}
