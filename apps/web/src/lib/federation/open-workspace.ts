import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { portalStore } from "@/lib/portal/portal-store";
import type {
  WorkspaceBoardTab,
  WorkspaceDialog,
  WorkspaceWorkTarget,
} from "@/lib/federation/workspace-request";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { uiStore } from "@/stores/uiStore";

export interface MachineWorkspaceSpec {
  /** The node, by identity. */
  connectionId: string;
  /** Empty: the node's project launcher (to add a project there). */
  projectId: string;
  environmentId?: string;
  boardTab?: WorkspaceBoardTab;
  workTarget?: WorkspaceWorkTarget;
  /** Open the New Environment dialog for `projectId` instead of selecting it. */
  createEnvironment?: boolean;
  /**
   * Open one of the node's own dialogs over the selection: the project's, or
   * with `environmentId`, the environment's settings (or its rebuild).
   */
  dialog?: WorkspaceDialog;
  /** For messages while it opens. */
  title: string;
}

const CREATE_ENVIRONMENT_REQUEST_EVENT = "orkestrator:create-environment";

/** Asks this window's sidebar to open the New Environment dialog for a project. */
function requestCreateEnvironment(projectId: string): void {
  window.dispatchEvent(
    new CustomEvent<string>(CREATE_ENVIRONMENT_REQUEST_EVENT, { detail: projectId }),
  );
}

export function onCreateEnvironmentRequest(listener: (projectId: string) => void): () => void {
  const handle = (event: Event) => {
    const projectId = (event as CustomEvent<unknown>).detail;
    if (typeof projectId === "string" && projectId) listener(projectId);
  };
  window.addEventListener(CREATE_ENVIRONMENT_REQUEST_EVENT, handle);
  return () => window.removeEventListener(CREATE_ENVIRONMENT_REQUEST_EVENT, handle);
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
  if (!selfId || spec.connectionId === selfId) {
    useRemoteWorkspaceStore.getState().showLocal();
    const ui = getWindowScope().commandScope().store(uiStore).getState();
    if (!spec.projectId) return;
    if (spec.createEnvironment) requestCreateEnvironment(spec.projectId);
    else if (spec.environmentId) {
      ui.selectProjectAndEnvironment(spec.projectId, spec.environmentId);
      // A project home opens on its Home tab, as its own sidebar opens it.
      if (spec.boardTab) ui.setProjectBoardTab(spec.boardTab);
    } else {
      ui.selectProject(spec.projectId);
      if (spec.boardTab) ui.setProjectBoardTab(spec.boardTab);
    }
    if (spec.dialog) openDialog(spec.dialog, spec.projectId, spec.environmentId);
    return;
  }
  useRemoteWorkspaceStore.getState().open(
    spec.connectionId,
    !spec.projectId
      ? { addProject: true }
      : spec.createEnvironment
        ? { projectId: spec.projectId, createEnvironmentProjectId: spec.projectId }
        : {
            projectId: spec.projectId,
            ...(spec.environmentId ? { environmentId: spec.environmentId } : {}),
            ...(spec.boardTab ? { boardTab: spec.boardTab } : {}),
            ...(spec.workTarget ? { workTarget: spec.workTarget } : {}),
            ...(spec.dialog ? { dialog: spec.dialog } : {}),
          },
  );
}

/**
 * Opens a repository from its heading: its coordinator, on the command node's
 * copy of the project, else (none here) a leaf's, whose workspace then opens
 * its own coordinator directly. A window whose own node is in leaf mode lands on
 * its home, since its coordinator is gated.
 */
export function openRepository(spec: {
  /** The repository's identity, which also names its group. */
  repository: string;
  /** The node-qualified key of the member project it opens. */
  projectKey: string;
  connectionId: string;
  projectId: string;
  coordinatorGated: boolean;
  title: string;
}): void {
  openMachineWorkspace({
    connectionId: spec.connectionId,
    projectId: spec.projectId,
    ...(spec.coordinatorGated ? {} : { boardTab: "coordinator" as const }),
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
