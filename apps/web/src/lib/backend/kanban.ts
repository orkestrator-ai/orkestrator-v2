import { invoke } from "@/lib/native/backend";
import type { FeaturePlanningKind, FeaturePlanningRecord } from "@orkestrator/protocol/feature-planning";
import type { PrState } from "@/types";
/** PR detection result containing URL, state, and merge conflict status */

// --- File System Utilities ---

/** Read a binary file from the local filesystem as base64 */
export async function readFileBase64(path: string): Promise<string> {
  return invoke<string>("read_file_base64", { filePath: path });
}

/** Read a binary file from the local filesystem (deprecated: use readFileBase64 instead) */
export async function readBinaryFile(path: string): Promise<Uint8Array> {
  // Use our custom Electron command instead of the fs plugin (which has permission issues)
  const base64 = await readFileBase64(path);
  // Convert base64 to Uint8Array
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

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
}

export type KanbanStatus = "backlog" | "in-progress" | "review" | "done";

export interface KanbanTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: KanbanStatus;
  comments: KanbanComment[];
  images: KanbanImage[];
  createdAt: string;
  order: number;
  /** Linked build environment ID */
  environmentId?: string;
  /** Active build pipeline ID */
  buildPipelineId?: string;
  /** PR URL associated with this task */
  prUrl?: string;
  /** PR state (open, merged, closed) */
  prState?: PrState;
  /** Whether a merge/close comment has already been added */
  prMergeCommented?: boolean;
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
 * Hand the user's message to the backend planning supervisor.
 *
 * Everything after this — environment, bridge, session, dispatch, reply, parse,
 * persist — happens backend-side, so closing the view or reloading the page
 * cannot abandon it.
 */
export async function startFeaturePlanning(
  featureId: string,
  kind: FeaturePlanningKind,
  userMessage: string,
  storyId?: string,
): Promise<FeaturePlanningRecord> {
  return invoke<FeaturePlanningRecord>("start_feature_planning", {
    featureId,
    kind,
    userMessage,
    ...(storyId ? { storyId } : {}),
  });
}

export async function getFeaturePlanningSnapshot(
  projectId: string,
): Promise<FeaturePlanningRecord[]> {
  return invoke<FeaturePlanningRecord[]>("get_feature_planning_snapshot", { projectId });
}

export async function retryFeaturePlanning(
  featureId: string,
): Promise<FeaturePlanningRecord> {
  return invoke<FeaturePlanningRecord>("retry_feature_planning", { featureId });
}

export async function cancelFeaturePlanning(featureId: string): Promise<void> {
  return invoke<void>("cancel_feature_planning", { featureId });
}

export async function getKanbanTasks(projectId: string): Promise<KanbanTask[]> {
  return invoke<KanbanTask[]>("get_kanban_tasks", { projectId });
}

export async function addKanbanTask(
  projectId: string,
  title: string,
  description: string
): Promise<KanbanTask> {
  return invoke<KanbanTask>("add_kanban_task", { projectId, title, description });
}

export async function updateKanbanTask(
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
  return invoke<KanbanTask>("update_kanban_task", { taskId, title, description, acceptanceCriteria, status, environmentId, buildPipelineId, prUrl, prState, prMergeCommented });
}

export async function deleteKanbanTask(taskId: string): Promise<void> {
  return invoke<void>("delete_kanban_task", { taskId });
}

export async function addKanbanComment(taskId: string, text: string): Promise<KanbanTask> {
  return invoke<KanbanTask>("add_kanban_comment", { taskId, text });
}

export async function deleteKanbanComment(taskId: string, commentId: string): Promise<KanbanTask> {
  return invoke<KanbanTask>("delete_kanban_comment", { taskId, commentId });
}

export async function addKanbanImage(taskId: string, filename: string, data: string): Promise<KanbanTask> {
  return invoke<KanbanTask>("add_kanban_image", { taskId, filename, data });
}

export async function deleteKanbanImage(taskId: string, imageId: string): Promise<KanbanTask> {
  return invoke<KanbanTask>("delete_kanban_image", { taskId, imageId });
}

/** Load kanban image data on demand. Returns base64-encoded WebP data. */
export async function getKanbanImageData(imageId: string): Promise<string> {
  return invoke<string>("get_kanban_image_data", { imageId });
}

export async function getProjectNotes(projectId: string): Promise<ProjectNotes> {
  return invoke<ProjectNotes>("get_project_notes", { projectId });
}

export async function saveProjectNotes(projectId: string, content: string): Promise<ProjectNotes> {
  return invoke<ProjectNotes>("save_project_notes", { projectId, content });
}

export async function getFeaturePlans(projectId: string): Promise<FeaturePlan[]> {
  return invoke<FeaturePlan[]>("get_feature_plans", { projectId });
}

export async function createFeaturePlan(projectId: string): Promise<FeaturePlan> {
  return invoke<FeaturePlan>("create_feature_plan", { projectId });
}

export async function updateFeaturePlan(
  featureId: string,
  updates: Partial<Pick<
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
  >>,
): Promise<FeaturePlan> {
  return invoke<FeaturePlan>("update_feature_plan", { featureId, updates });
}

export async function claimFeaturePlanBuild(
  featureId: string,
  taskId: string,
): Promise<{ claimed: boolean; feature: FeaturePlan }> {
  return invoke<{ claimed: boolean; feature: FeaturePlan }>(
    "claim_feature_plan_build",
    { featureId, taskId },
  );
}

export async function appendFeaturePlanMessage(
  featureId: string,
  role: FeaturePlanMessage["role"],
  content: string,
  stateApplication?: FeaturePlanMessage["stateApplication"],
  modelId?: string,
): Promise<FeaturePlan> {
  return invoke<FeaturePlan>("append_feature_plan_message", {
    featureId,
    role,
    content,
    stateApplication,
    modelId,
  });
}

export async function appendFeatureStoryMessage(
  featureId: string,
  storyId: string,
  role: FeaturePlanMessage["role"],
  content: string,
  stateApplication?: FeaturePlanMessage["stateApplication"],
  modelId?: string,
): Promise<FeaturePlan> {
  return invoke<FeaturePlan>("append_feature_story_message", {
    featureId,
    storyId,
    role,
    content,
    stateApplication,
    modelId,
  });
}

