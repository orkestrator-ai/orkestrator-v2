import type {
  FeaturePlanningKind,
  FeaturePlanningRecord,
} from "@orkestrator/protocol/feature-planning";
import type { PrState } from "@/types";
import type {
  TicketKind,
  TicketSections,
  TicketSectionsPatch,
} from "@orkestrator/protocol/ticket-sections";
import type {
  TicketSyncLeafStatus,
  TicketSyncMeta,
  TicketSyncStatusResult,
} from "@orkestrator/protocol/ticket-sync";
import { files } from "@/lib/node-scope/domains/files";
import { asKanbanModel, kanban } from "@/lib/node-scope/domains/kanban";
import { ticketSyncClient } from "@orkestrator/protocol/contract/domains/ticket-sync";
import { domainApi } from "@/lib/node-scope/domains/domain-api";
import { commandBackendClient, type BackendClient } from "./client";
/** PR detection result containing URL, state, and merge conflict status */

// --- File System Utilities ---

// --- Kanban commands ---

export interface KanbanComment {
  id: string;
  text: string;
  createdAt: string;
}

export interface KanbanImage {
  id: string;
  /** Original filename before WebP conversion */
  filename: string;
  createdAt: string;
  /** The machine holding the bytes, for an image on a ticket synced from another machine. */
  nodeId?: string;
  nodeName?: string;
}

export type KanbanStatus = "backlog" | "in-progress" | "review" | "done";

export interface KanbanTask {
  id: string;
  projectId: string;
  title: string;
  /** Markdown of every section except the criteria; `sections` is authoritative. */
  description: string;
  /** The criteria as a markdown list. */
  acceptanceCriteria: string;
  /** Absent from backends that predate kinds: a feature ticket. */
  kind?: TicketKind;
  /** Absent from backends that predate sections; derive them from the text. */
  sections?: TicketSections;
  /** Label names, in the order they were added; absent when it has none or the backend predates labels. */
  labels?: string[];
  status: KanbanStatus;
  comments: KanbanComment[];
  images: KanbanImage[];
  createdAt: string;
  /**
   * When the ticket's content or state last changed; equal to `createdAt` on a
   * new ticket. Absent from backends that predate it: read it through
   * `ticketUpdatedAt` (`@orkestrator/protocol/ticket-sync`), which falls back
   * to `createdAt`.
   */
  updatedAt?: string;
  order: number;
  /** Linked pipeline environment ID */
  environmentId?: string;
  /** Active build pipeline ID */
  buildPipelineId?: string;
  /** PR URL associated with this task */
  prUrl?: string;
  /** PR state (open, merged, closed) */
  prState?: PrState;
  /** Whether a merge/close comment has already been added */
  prMergeCommented?: boolean;
  /**
   * Sync with other machines: set on a leaf's copy of a command node's
   * ticket (`replica`), and where the ticket's work runs when that is
   * another machine (`work`). Absent from backends that predate sync.
   */
  sync?: TicketSyncMeta;
}

export interface ProjectNotes {
  projectId: string;
  content: string;
  updatedAt: string;
}

export type FeaturePlanStatus = "collecting" | "confirming" | "stories" | "building" | "built";

export interface FeaturePlanMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  /** Backend-confirmed model that produced this assistant response. */
  modelId?: string;
  /** Durable recovery marker for assistant responses that carry plan/story state. */
  stateApplication?: "pending" | "applied" | "superseded";
}

export interface FeatureStoryCard {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  messages: FeaturePlanMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface FeaturePlan {
  id: string;
  projectId: string;
  title: string;
  status: FeaturePlanStatus;
  summary: string;
  messages: FeaturePlanMessage[];
  stories: FeatureStoryCard[];
  createdAt: string;
  updatedAt: string;
  order: number;
  codexEnvironmentId?: string;
  codexSessionId?: string;
  buildTaskId?: string;
  buildPipelineId?: string;
  /**
   * Backend-owned planning exchange currently attached to this plan.
   *
   * Present only while the backend is advancing one, or after it failed and is
   * waiting for the user to retry. The renderer never writes it.
   */
  planning?: FeaturePlanningRecord;
}

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createKanbanApi(client: BackendClient) {
  // The two file reads are in the `files` domain (plan item 7002).
  const filesDomain = () => files(client);
  // Tickets, notes, feature plans and planning: the `kanban` domain (plan item
  // 7008), picked per call so a reconnect to another build picks again.
  const domain = () => kanban(client);

  /** Read a binary file from the local filesystem as base64 */
  async function readFileBase64(path: string): Promise<string> {
    return filesDomain().read_file_base64({ filePath: path });
  }

  /**
   * Where each machine with a copy of this project stands in syncing its
   * tickets with this board. Empty on a backend without leaves, or one that
   * predates ticket sync.
   */
  async function getTicketSyncStatus(projectId: string): Promise<TicketSyncStatusResult> {
    // The board's read in the `ticket-sync` domain (its nodes and conflicts
    // decode as unknown; `TicketSyncStatusResult` is the shape they carry).
    return asKanbanModel<TicketSyncStatusResult>(
      domainApi(client, ticketSyncClient).status({ projectId }),
    );
  }

  /**
   * A leaf board's sync line: the command nodes its copies come from, the
   * tickets Share would send, and the copy that syncs when this one does not.
   */
  async function getTicketSyncLeafStatus(projectId: string): Promise<TicketSyncLeafStatus> {
    return asKanbanModel<TicketSyncLeafStatus>(
      domainApi(client, ticketSyncClient).leafStatus({ projectId }),
    );
  }

  /** Leaf: send tickets made before sync (or all of them) to the command node. */
  async function shareTicketsWithCommandNode(
    projectId: string,
    taskIds?: string[],
  ): Promise<{ shared: number }> {
    return domainApi(client, ticketSyncClient).share({
      projectId,
      ...(taskIds ? { taskIds } : {}),
    });
  }

  /** Command node: remove conflicts from a board's list (`ids`, or all). */
  async function dismissTicketSyncConflicts(
    projectId: string,
    ids?: string[],
  ): Promise<{ dismissed: number; remaining: number }> {
    return domainApi(client, ticketSyncClient).dismissConflicts({
      projectId,
      ...(ids ? { ids } : {}),
    });
  }

  /**
   * Hand the user's message to the backend planning supervisor.
   *
   * Everything after this — environment, bridge, session, dispatch, reply, parse,
   * persist — happens backend-side, so closing the view or reloading the page
   * cannot abandon it.
   */
  async function startFeaturePlanning(
    featureId: string,
    kind: FeaturePlanningKind,
    userMessage: string,
    storyId?: string,
  ): Promise<FeaturePlanningRecord> {
    return asKanbanModel<FeaturePlanningRecord>(
      domain().start_feature_planning({
        featureId,
        kind,
        userMessage,
        ...(storyId ? { storyId } : {}),
      }),
    );
  }

  async function retryFeaturePlanning(featureId: string): Promise<FeaturePlanningRecord> {
    return asKanbanModel<FeaturePlanningRecord>(domain().retry_feature_planning({ featureId }));
  }

  async function cancelFeaturePlanning(featureId: string): Promise<void> {
    await domain().cancel_feature_planning({ featureId });
  }

  async function getKanbanTasks(projectId: string): Promise<KanbanTask[]> {
    return asKanbanModel<KanbanTask[]>(domain().get_kanban_tasks({ projectId }));
  }

  async function addKanbanTask(
    projectId: string,
    title: string,
    description: string,
  ): Promise<KanbanTask> {
    return asKanbanModel<KanbanTask>(domain().add_kanban_task({ projectId, title, description }));
  }

  async function updateKanbanTask(
    taskId: string,
    title?: string,
    description?: string,
    acceptanceCriteria?: string,
    status?: KanbanStatus,
    environmentId?: string,
    buildPipelineId?: string,
    prUrl?: string,
    prState?: PrState,
    prMergeCommented?: boolean,
  ): Promise<KanbanTask> {
    return asKanbanModel<KanbanTask>(
      domain().update_kanban_task({
        taskId,
        title,
        description,
        acceptanceCriteria,
        status,
        environmentId,
        buildPipelineId,
        prUrl,
        prState,
        prMergeCommented,
      }),
    );
  }

  /**
   * Replace a ticket's content from edited markdown (every section, criteria
   * included). Criteria whose text is unchanged keep their Verify results.
   */
  async function updateKanbanTaskContent(
    taskId: string,
    content: {
      title?: string;
      kind?: TicketKind;
      markdown?: string;
      sections?: TicketSectionsPatch;
    },
  ): Promise<KanbanTask> {
    return asKanbanModel<KanbanTask>(domain().update_kanban_task({ taskId, ...content }));
  }

  async function deleteKanbanTask(taskId: string): Promise<void> {
    await domain().delete_kanban_task({ taskId });
  }

  async function addKanbanComment(taskId: string, text: string): Promise<KanbanTask> {
    return asKanbanModel<KanbanTask>(domain().add_kanban_comment({ taskId, text }));
  }

  async function deleteKanbanComment(taskId: string, commentId: string): Promise<KanbanTask> {
    return asKanbanModel<KanbanTask>(domain().delete_kanban_comment({ taskId, commentId }));
  }

  async function addKanbanImage(
    taskId: string,
    filename: string,
    data: string,
  ): Promise<KanbanTask> {
    return asKanbanModel<KanbanTask>(domain().add_kanban_image({ taskId, filename, data }));
  }

  async function deleteKanbanImage(taskId: string, imageId: string): Promise<KanbanTask> {
    return asKanbanModel<KanbanTask>(domain().delete_kanban_image({ taskId, imageId }));
  }

  /** Load kanban image data on demand. Returns base64-encoded WebP data. */
  async function getKanbanImageData(imageId: string): Promise<string> {
    return domain().get_kanban_image_data({ imageId });
  }

  async function getProjectNotes(projectId: string): Promise<ProjectNotes> {
    return asKanbanModel<ProjectNotes>(domain().get_project_notes({ projectId }));
  }

  async function saveProjectNotes(projectId: string, content: string): Promise<ProjectNotes> {
    return asKanbanModel<ProjectNotes>(domain().save_project_notes({ projectId, content }));
  }

  async function getFeaturePlans(projectId: string): Promise<FeaturePlan[]> {
    return asKanbanModel<FeaturePlan[]>(domain().get_feature_plans({ projectId }));
  }

  async function createFeaturePlan(projectId: string): Promise<FeaturePlan> {
    return asKanbanModel<FeaturePlan>(domain().create_feature_plan({ projectId }));
  }

  async function updateFeaturePlan(
    featureId: string,
    updates: Partial<
      Pick<
        FeaturePlan,
        | "title"
        | "status"
        | "summary"
        | "messages"
        | "stories"
        | "codexEnvironmentId"
        | "codexSessionId"
        | "buildTaskId"
        | "buildPipelineId"
      >
    >,
  ): Promise<FeaturePlan> {
    return asKanbanModel<FeaturePlan>(domain().update_feature_plan({ featureId, updates }));
  }

  async function claimFeaturePlanBuild(
    featureId: string,
    taskId: string,
  ): Promise<{ claimed: boolean; feature: FeaturePlan }> {
    return asKanbanModel<{ claimed: boolean; feature: FeaturePlan }>(
      domain().claim_feature_plan_build({
        featureId,
        taskId,
      }),
    );
  }

  async function appendFeaturePlanMessage(
    featureId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ): Promise<FeaturePlan> {
    return asKanbanModel<FeaturePlan>(
      domain().append_feature_plan_message({
        featureId,
        role,
        content,
        stateApplication,
        modelId,
      }),
    );
  }

  async function appendFeatureStoryMessage(
    featureId: string,
    storyId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ): Promise<FeaturePlan> {
    return asKanbanModel<FeaturePlan>(
      domain().append_feature_story_message({
        featureId,
        storyId,
        role,
        content,
        stateApplication,
        modelId,
      }),
    );
  }

  /** Binary read confined to the named local environment's checkout. */
  async function readEnvironmentFileBase64(
    environmentId: string,
    filePath: string,
  ): Promise<string> {
    return filesDomain().read_environment_file_base64({ environmentId, filePath });
  }

  return {
    readFileBase64,
    getTicketSyncStatus,
    getTicketSyncLeafStatus,
    shareTicketsWithCommandNode,
    dismissTicketSyncConflicts,
    startFeaturePlanning,
    retryFeaturePlanning,
    cancelFeaturePlanning,
    getKanbanTasks,
    addKanbanTask,
    updateKanbanTask,
    updateKanbanTaskContent,
    deleteKanbanTask,
    addKanbanComment,
    deleteKanbanComment,
    addKanbanImage,
    deleteKanbanImage,
    getKanbanImageData,
    getProjectNotes,
    saveProjectNotes,
    getFeaturePlans,
    createFeaturePlan,
    updateFeaturePlan,
    claimFeaturePlanBuild,
    appendFeaturePlanMessage,
    appendFeatureStoryMessage,
    readEnvironmentFileBase64,
  };
}

export type KanbanApi = ReturnType<typeof createKanbanApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  readFileBase64,
  getTicketSyncStatus,
  getTicketSyncLeafStatus,
  shareTicketsWithCommandNode,
  dismissTicketSyncConflicts,
  startFeaturePlanning,
  retryFeaturePlanning,
  cancelFeaturePlanning,
  getKanbanTasks,
  addKanbanTask,
  updateKanbanTask,
  updateKanbanTaskContent,
  deleteKanbanTask,
  addKanbanComment,
  deleteKanbanComment,
  addKanbanImage,
  deleteKanbanImage,
  getKanbanImageData,
  getProjectNotes,
  saveProjectNotes,
  getFeaturePlans,
  createFeaturePlan,
  updateFeaturePlan,
  claimFeaturePlanBuild,
  appendFeaturePlanMessage,
  appendFeatureStoryMessage,
  readEnvironmentFileBase64,
} = createKanbanApi(commandBackendClient);
