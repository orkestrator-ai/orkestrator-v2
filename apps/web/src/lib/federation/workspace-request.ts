import type { DeliveryPolicy } from "@orkestrator/protocol/ticket-sections";
import type { EnvironmentInteractionMode } from "@orkestrator/protocol/environment-interaction";

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

/** Work on one node, opened where it runs. */
export type WorkspaceWorkTarget =
  /** A worker environment, at the delegated tab when known. */
  | {
      type: "worker-tab";
      projectId: string;
      environmentId: string;
      tabId?: string;
      interactionId?: string;
    }
  /** A build pipeline's tab; the environment may not exist yet. */
  | { type: "build"; projectId: string; pipelineId: string; environmentId?: string }
  | { type: "review"; projectId: string; environmentId: string; workflowId: string }
  | { type: "graph-run"; projectId: string; environmentId: string; runId: string; title?: string };

/** Form fields that can travel without depending on the source node's defaults. */
export interface CreateEnvironmentHandoff {
  prompt: string;
  name: string;
  interactionMode?: EnvironmentInteractionMode;
  feature?: {
    name: string;
    acceptanceCriteria: string;
    deliveryPolicy: DeliveryPolicy;
  };
}

/** What the window asks another node's workspace to show. */
export interface WorkspaceRequest {
  projectId?: string;
  environmentId?: string;
  boardTab?: WorkspaceBoardTab;
  /**
   * The tab a project with no last tab of its own opens on, where a sidebar
   * entry's grouping calls for one. Unlike `boardTab` it never overrides the
   * tab the project was last left on.
   */
  landingTab?: WorkspaceBoardTab;
  /** Open a file view in the selected environment. */
  filesPanelTab?: "changes" | "all-files";
  /** Work in the selected environment. */
  workTarget?: WorkspaceWorkTarget;
  /** Open the node's Add Project dialog. */
  addProject?: true;
  /** Open the node's New Environment dialog for this project. */
  createEnvironmentProjectId?: string;
  createEnvironmentHandoff?: CreateEnvironmentHandoff;
  /** Open one of the node's dialogs for the selected project or environment. */
  dialog?: WorkspaceDialog;
}
