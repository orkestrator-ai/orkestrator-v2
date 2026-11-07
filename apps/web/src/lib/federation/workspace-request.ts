/**
 * What the window asks another node's workspace to show when it opens it
 * (`openMachineWorkspace`): a selection, board navigation, work to open, or
 * one of the node's dialogs. The window keeps the latest request per node
 * (`remoteWorkspaceStore.requests`) and the node's `NodeWorkspaceHost`
 * applies it on the node's scope once that scope has what it needs.
 */

/** Explicit board navigation overrides a node's default project landing tab. */
export type WorkspaceBoardTab =
  "home" | "coordinator" | "kanban" | "github" | "linear" | "features";

/**
 * A dialog of the node, opened over what the request selects: the project's
 * for the project dialogs, the environment's for its settings.
 * `environment-rebuild` is the environment's settings on its Container
 * section, where Rebuild (keep work) is.
 */
export const WORKSPACE_DIALOGS = [
  "repository-settings",
  "delete-project",
  "environment-settings",
  "environment-rebuild",
] as const;

export type WorkspaceDialog = (typeof WORKSPACE_DIALOGS)[number];

/** Whether the dialog is one of an environment's rather than a project's. */
export function isEnvironmentDialog(dialog: WorkspaceDialog): boolean {
  return dialog === "environment-settings" || dialog === "environment-rebuild";
}

/** Work on one node, opened where it runs. */
export type WorkspaceWorkTarget =
  /** A worker environment, at the delegated tab when known. */
  | { type: "worker-tab"; projectId: string; environmentId: string; tabId?: string }
  /** A build pipeline's tab; the environment may not exist yet. */
  | { type: "build"; projectId: string; pipelineId: string; environmentId?: string }
  | { type: "review"; projectId: string; environmentId: string; workflowId: string }
  | { type: "graph-run"; projectId: string; environmentId: string; runId: string; title?: string };

/** What the window asks another node's workspace to show. */
export interface WorkspaceRequest {
  projectId?: string;
  environmentId?: string;
  boardTab?: WorkspaceBoardTab;
  /** Work in the selected environment. */
  workTarget?: WorkspaceWorkTarget;
  /** Open the node's Add Project dialog. */
  addProject?: true;
  /** Open the node's New Environment dialog for this project. */
  createEnvironmentProjectId?: string;
  /** Open one of the node's dialogs for the selected project or environment. */
  dialog?: WorkspaceDialog;
}
