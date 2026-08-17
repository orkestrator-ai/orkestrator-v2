import { invoke } from "@/lib/native/backend";
import type { AgentInteractionApplyOutcome, AgentInteractionOrigin, AgentInteractionPolicy, AgentInteractionResolution } from "@orkestrator/protocol/agent-interactions";
import type { BuildPipeline as BackendBuildPipeline, StartBuildPipelineInput } from "@orkestrator/protocol/build-pipeline";
import type { LoopedReviewWorkflow as BackendLoopedReviewWorkflow, StartLoopedReviewInput } from "@orkestrator/protocol/review-workflow";
import type { MultiReviewWorkflow as BackendMultiReviewWorkflow, MultiReviewReviewerTranscript, StartMultiReviewInput } from "@orkestrator/protocol/multi-review";
import type { Environment, PersistedLoopedReviewWorkflow, PersistedBuildPipeline, PersistedNativeAgentSession, PersistedComposeDraft, PersistedFileDraft, PersistedPromptQueue, PersistedAgentHandoff } from "@/types";
import { isAwaitBridgeReadyResult, type AgentBridgeKind, type AwaitBridgeReadyResult } from "@orkestrator/protocol/bridge-readiness";
import type { NativeAgentControlUpdate, NativeAgentSessionAction, NativeAgentSessionActionOutcome, NativeAgentDispatchOutcome, NativeAgentForkOutcome, NativeAgentResumeEntry, NativeAgentSessionProjection, NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
/** PR detection result containing URL, state, and merge conflict status */

import {
  isRecord,
  parseTerminalSessionCreateResult,
  type TerminalSessionCreateResult,
} from "./shared";
import type { KanbanTask } from "./kanban";

export async function startLoopedReview(
  input: StartLoopedReviewInput,
): Promise<BackendLoopedReviewWorkflow> {
  return invoke<BackendLoopedReviewWorkflow>("start_looped_review", { ...input });
}

export async function pauseLoopedReview(workflowId: string): Promise<BackendLoopedReviewWorkflow> {
  return invoke<BackendLoopedReviewWorkflow>("pause_looped_review", { workflowId });
}

export async function resumeLoopedReview(workflowId: string): Promise<BackendLoopedReviewWorkflow> {
  return invoke<BackendLoopedReviewWorkflow>("resume_looped_review", { workflowId });
}

export async function retryLoopedReview(workflowId: string): Promise<BackendLoopedReviewWorkflow> {
  return invoke<BackendLoopedReviewWorkflow>("retry_looped_review", { workflowId });
}

export async function cancelLoopedReview(workflowId: string): Promise<BackendLoopedReviewWorkflow> {
  return invoke<BackendLoopedReviewWorkflow>("cancel_looped_review", { workflowId });
}

export async function getLoopedReviewProviderSession(
  workflowId: string,
  sessionId?: string,
): Promise<{ providerSessionId: string } | null> {
  return invoke("get_looped_review_provider_session", {
    workflowId,
    // Only an *absent* session id means "use the active session". A blank one
    // is a caller bug, and silently substituting the active session would open
    // the wrong provider transcript rather than reporting it.
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

export async function getLoopedReviewWorkflow<T = unknown>(
  workflowId: string,
): Promise<PersistedLoopedReviewWorkflow<T> | null> {
  return invoke<PersistedLoopedReviewWorkflow<T> | null>(
    "get_looped_review_workflow",
    { workflowId },
  );
}

export async function listLoopedReviewWorkflows<T = unknown>(
  environmentId: string,
): Promise<Array<PersistedLoopedReviewWorkflow<T>>> {
  return invoke<Array<PersistedLoopedReviewWorkflow<T>>>(
    "list_looped_review_workflows",
    { environmentId },
  );
}

export async function saveLoopedReviewWorkflow<T>(
  workflowId: string,
  environmentId: string,
  version: number,
  snapshot: T,
  expectedRevision?: number,
  controllerFence?: { ownerId: string; token: string },
): Promise<PersistedLoopedReviewWorkflow<T>> {
  return invoke<PersistedLoopedReviewWorkflow<T>>(
    "save_looped_review_workflow",
    {
      workflowId,
      environmentId,
      version,
      snapshot,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(controllerFence
        ? {
            controllerOwnerId: controllerFence.ownerId,
            controllerToken: controllerFence.token,
          }
        : {}),
    },
  );
}

export async function deleteLoopedReviewWorkflow(
  workflowId: string,
): Promise<void> {
  return invoke("delete_looped_review_workflow", { workflowId });
}

// --- Multi Review Workflow Commands ---

export async function startMultiReview(
  input: StartMultiReviewInput,
): Promise<BackendMultiReviewWorkflow> {
  return invoke<BackendMultiReviewWorkflow>("start_multi_review", { ...input });
}

export async function addressMultiReview(workflowId: string): Promise<BackendMultiReviewWorkflow> {
  return invoke<BackendMultiReviewWorkflow>("address_multi_review", { workflowId });
}

export async function retryMultiReview(workflowId: string): Promise<BackendMultiReviewWorkflow> {
  return invoke<BackendMultiReviewWorkflow>("retry_multi_review", { workflowId });
}

export async function cancelMultiReview(workflowId: string): Promise<BackendMultiReviewWorkflow> {
  return invoke<BackendMultiReviewWorkflow>("cancel_multi_review", { workflowId });
}

/**
 * Retire one reviewer and let the review continue without it. The backend
 * aborts that reviewer's session best-effort and consolidates from whatever the
 * remaining reviewers produced.
 */
export async function stopMultiReviewReviewer(
  workflowId: string,
  reviewerId: string,
): Promise<BackendMultiReviewWorkflow> {
  return invoke<BackendMultiReviewWorkflow>(
    "stop_multi_review_reviewer", { workflowId, reviewerId },
  );
}

export async function getMultiReviewWorkflow<T = unknown>(
  workflowId: string,
): Promise<PersistedLoopedReviewWorkflow<T> | null> {
  return invoke<PersistedLoopedReviewWorkflow<T> | null>(
    "get_multi_review_workflow", { workflowId },
  );
}

export async function listMultiReviewWorkflows<T = unknown>(
  environmentId: string,
): Promise<Array<PersistedLoopedReviewWorkflow<T>>> {
  return invoke<Array<PersistedLoopedReviewWorkflow<T>>>(
    "list_multi_review_workflows", { environmentId },
  );
}

export async function getMultiReviewReviewerTranscript(
  workflowId: string,
  reviewerId: string,
): Promise<MultiReviewReviewerTranscript> {
  return invoke<MultiReviewReviewerTranscript>(
    "get_multi_review_reviewer_transcript", { workflowId, reviewerId },
  );
}

export async function deleteMultiReviewWorkflow(workflowId: string): Promise<void> {
  return invoke("delete_multi_review_workflow", { workflowId });
}

// Controller leases are backend-only. The renderer has no caller for
// claim/validate/release, and backend-owned records reject renderer writes, so
// keeping wrappers here would only advertise an API the renderer must not use.

export async function ensureNativeAgentSession(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  phase?: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts";
  /**
   * Overrides the mode the phase would imply.
   *
   * Looped-review phases collapse onto `review`, and preparation has to commit
   * changes — a phase-derived read-only session would fail that round.
   */
  sessionMode?: "plan" | "build";
  fastMode?: boolean;
}): Promise<PersistedNativeAgentSession> {
  return invoke<PersistedNativeAgentSession>(
    "ensure_native_agent_session",
    input,
  );
}

export async function adoptNativeAgentSession(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
  providerSessionId: string;
  expectedProviderSessionId?: string;
  model?: string;
  reasoningEffort?: string;
  sessionMode?: "plan" | "build";
  fastMode?: boolean;
}): Promise<PersistedNativeAgentSession> {
  return invoke<PersistedNativeAgentSession>(
    "adopt_native_agent_session",
    input,
  );
}

export async function getNativeAgentSession(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
}): Promise<PersistedNativeAgentSession | null> {
  return invoke<PersistedNativeAgentSession | null>(
    "get_native_agent_session",
    input,
  );
}

export async function getNativeAgentProjection<TMessage = unknown>(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  /** Omit to keep the window this session already has; never to shrink it. */
  messageLimit?: number;
}): Promise<NativeAgentSessionProjection<TMessage> | null> {
  return invoke("get_native_agent_projection", input);
}

export async function getNativeAgentToolDetails(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  detailRef: string;
}): Promise<NativeAgentToolDetails> {
  return invoke("get_native_agent_tool_details", input);
}

export async function refreshNativeAgentModels<TMessage = unknown>(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
}): Promise<NativeAgentSessionProjection<TMessage> | null> {
  return invoke("refresh_native_agent_models", input);
}

export async function stopNativeAgentSession<TMessage = unknown>(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
}): Promise<NativeAgentSessionProjection<TMessage> | null> {
  return invoke("stop_native_agent_session", input);
}

export async function stopNativeAgentBackgroundTask<TMessage = unknown>(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  taskId: string;
}): Promise<NativeAgentSessionProjection<TMessage> | null> {
  return invoke("stop_native_agent_background_task", input);
}

export async function dismissNativeAgentSuggestedPrompt<TMessage = unknown>(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
}): Promise<NativeAgentSessionProjection<TMessage> | null> {
  return invoke("dismiss_native_agent_suggested_prompt", input);
}

export async function listNativeAgentResumableSessions(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
}): Promise<NativeAgentResumeEntry[]> {
  return invoke("list_native_agent_resumable_sessions", input);
}

export async function resumeNativeAgentSession<TMessage = unknown>(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  providerSessionId: string;
  controls?: NativeAgentControlUpdate;
}): Promise<NativeAgentSessionProjection<TMessage> | null> {
  return invoke("resume_native_agent_session", input);
}

export async function forkNativeAgentSession(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  messageId?: string;
}): Promise<NativeAgentForkOutcome> {
  return invoke("fork_native_agent_session", input);
}

export async function updateNativeAgentControls<TMessage = unknown>(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  update: NativeAgentControlUpdate;
}): Promise<NativeAgentSessionProjection<TMessage> | null> {
  return invoke("update_native_agent_controls", input);
}

export async function performNativeAgentSessionAction(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  action: NativeAgentSessionAction;
}): Promise<NativeAgentSessionActionOutcome> {
  return invoke("perform_native_agent_session_action", input);
}

export async function resolveNativeAgentInteraction(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  interactionId: string;
  resolution: AgentInteractionResolution;
}): Promise<AgentInteractionApplyOutcome> {
  return invoke("resolve_native_agent_interaction", input);
}

export async function dispatchNativeAgentPrompt(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  phase?: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts";
  prompt: string;
  requestId: string;
  images?: Array<{ filename: string; data: string }>;
  schema?: Record<string, unknown>;
  mode?: "plan" | "build";
  fastMode?: boolean;
}): Promise<PersistedNativeAgentSession> {
  return invoke<PersistedNativeAgentSession>(
    "dispatch_native_agent_prompt",
    input,
  );
}

export async function dispatchNativeAgentIntent(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  phase?: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts";
  prompt: string;
  requestId: string;
  images?: Array<{ filename: string; data: string }>;
  attachments?: Array<{
    type: "image" | "file";
    path: string;
    dataUrl?: string;
    filename?: string;
  }>;
  schema?: Record<string, unknown>;
  mode?: "plan" | "build";
  fastMode?: boolean;
  subAgent?: string;
  executionAgent?: string;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
}): Promise<NativeAgentDispatchOutcome> {
  return invoke<NativeAgentDispatchOutcome>(
    "dispatch_native_agent_intent",
    input,
  );
}

export async function retryNativeAgentDispatch(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  requestId: string;
}): Promise<NativeAgentDispatchOutcome> {
  return invoke<NativeAgentDispatchOutcome>(
    "retry_native_agent_dispatch",
    input,
  );
}

export async function discardNativeAgentDispatch(input: {
  environmentId: string;
  agent: "claude" | "codex" | "opencode" | "cursor" | "grok";
  logicalSessionKey: string;
  requestId: string;
}): Promise<{ discarded: boolean }> {
  return invoke<{ discarded: boolean }>(
    "discard_native_agent_dispatch",
    input,
  );
}

// --- Build Pipeline Persistence ---

export async function startBuildPipeline(
  input: StartBuildPipelineInput,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("start_build_pipeline", { ...input });
}

export async function pauseBuildPipeline(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("pause_build_pipeline", { pipelineId });
}

export async function resumeBuildPipeline(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("resume_build_pipeline", { pipelineId });
}

export async function cancelBuildPipeline(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("cancel_build_pipeline", { pipelineId });
}

export async function sendBuildPipelineMessage(
  pipelineId: string,
  text: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("send_build_pipeline_message", {
    pipelineId,
    text,
  });
}

export async function retryBuildPipelineReview(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("retry_build_pipeline_review", {
    pipelineId,
  });
}

export async function retryBuildPipelineStage(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("retry_build_pipeline_stage", {
    pipelineId,
  });
}

export async function retryBuildPipelineInteractionFailure(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>("retry_build_pipeline_interaction_failure", {
    pipelineId,
  });
}

export async function retryBuildPipelineCompletionComment(
  pipelineId: string,
): Promise<BackendBuildPipeline> {
  return invoke<BackendBuildPipeline>(
    "retry_build_pipeline_completion_comment",
    { pipelineId },
  );
}

export async function importLegacyBuildPipelines(
  projectId: string,
  snapshots: unknown[],
): Promise<{ importedIds: string[]; skipped: number }> {
  return invoke("import_legacy_build_pipelines", { projectId, snapshots });
}

export async function getBuildPipeline<T = unknown>(
  pipelineId: string,
): Promise<PersistedBuildPipeline<T> | null> {
  return invoke<PersistedBuildPipeline<T> | null>("get_build_pipeline", { pipelineId });
}

export type ConditionalBuildPipeline<T> =
  | { unchanged: true; revision: number }
  | {
      unchanged: false;
      record: PersistedBuildPipeline<T>;
      messagePatches: Array<{
        sessionKey: string;
        baseRevision?: number;
        baseCount?: number;
        startIndex: number;
        revision: number;
        messages: unknown[];
      }>;
    }
  | PersistedBuildPipeline<T>
  | null;

export async function getBuildPipelineConditional<T = unknown>(
  pipelineId: string,
  knownRevision?: number,
  knownSessions?: Record<string, { revision: number; count: number }>,
): Promise<ConditionalBuildPipeline<T>> {
  const response = await invoke<unknown>("get_build_pipeline", {
    pipelineId,
    knownRevision,
    knownSessions,
  });
  if (response === null) return null;
  if (!isRecord(response)) {
    throw new Error("Invalid get_build_pipeline response");
  }
  if (!("unchanged" in response)) {
    if (typeof response.id !== "string") {
      throw new Error("Invalid get_build_pipeline response");
    }
    return response as unknown as PersistedBuildPipeline<T>;
  }
  if (
    response.unchanged === true
    && Number.isSafeInteger(response.revision)
    && (response.revision as number) >= 0
  ) {
    return response as { unchanged: true; revision: number };
  }
  if (
    response.unchanged !== false
    || !isRecord(response.record)
    || typeof response.record.id !== "string"
    || !Array.isArray(response.messagePatches)
    || !response.messagePatches.every((value) => {
      if (!isRecord(value)) return false;
      return typeof value.sessionKey === "string"
        && Number.isSafeInteger(value.startIndex)
        && (value.startIndex as number) >= 0
        && Number.isSafeInteger(value.revision)
        && (value.revision as number) >= 0
        && (value.baseRevision === undefined
          || (Number.isSafeInteger(value.baseRevision)
            && (value.baseRevision as number) >= 0))
        && (value.baseCount === undefined
          || (Number.isSafeInteger(value.baseCount)
            && (value.baseCount as number) >= 0))
        && Array.isArray(value.messages);
    })
  ) {
    throw new Error("Invalid get_build_pipeline response");
  }
  return response as unknown as ConditionalBuildPipeline<T>;
}

export async function listBuildPipelines<T = unknown>(
  projectId: string,
): Promise<Array<PersistedBuildPipeline<T>>> {
  return invoke<Array<PersistedBuildPipeline<T>>>("list_build_pipelines", { projectId });
}

export async function listBuildPipelinesConditional<T = unknown>(
  projectId: string,
  knownRevisions: Record<string, number>,
): Promise<{ ids: string[]; records: Array<PersistedBuildPipeline<T>> }> {
  const response = await invoke<unknown>("list_build_pipelines", {
    projectId,
    knownRevisions,
  });
  // Older backends ignore knownRevisions and return the complete record array.
  if (Array.isArray(response)) {
    if (!response.every((entry) => isRecord(entry) && typeof entry.id === "string")) {
      throw new Error("Invalid list_build_pipelines response");
    }
    return {
      ids: response.map((entry) => entry.id as string),
      records: response as Array<PersistedBuildPipeline<T>>,
    };
  }
  if (
    !isRecord(response)
    || !Array.isArray(response.ids)
    || !response.ids.every((id) => typeof id === "string")
    || !Array.isArray(response.records)
    || !response.records.every((entry) =>
      isRecord(entry) && typeof entry.id === "string"
    )
  ) {
    throw new Error("Invalid list_build_pipelines response");
  }
  return response as unknown as {
    ids: string[];
    records: Array<PersistedBuildPipeline<T>>;
  };
}

export async function deleteBuildPipeline(pipelineId: string): Promise<void> {
  return invoke("delete_build_pipeline", { pipelineId });
}

export async function clearTaskBuildStatus(taskId: string): Promise<{
  task: KanbanTask;
  removedPipelineIds: string[];
}> {
  return invoke("clear_task_build_status", { taskId });
}

/**
 * Marks or clears the environment's unread badge.
 *
 * A dedicated command rather than a general update so two clients racing on the
 * badge cannot clobber each other's unrelated environment fields.
 */
export async function setEnvironmentUnread(
  environmentId: string,
  unread: boolean,
  expectedLastActivityAt?: string | null,
): Promise<Environment> {
  return invoke<Environment>("set_environment_unread", {
    environmentId,
    unread,
    ...(expectedLastActivityAt === undefined ? {} : { expectedLastActivityAt }),
  });
}

// --- Prompt Queues ---

export async function getPromptQueue<T = unknown>(
  queueKey: string,
): Promise<PersistedPromptQueue<T> | null> {
  return invoke<PersistedPromptQueue<T> | null>("get_prompt_queue", { queueKey });
}

export async function listPromptQueues<T = unknown>(
  environmentId: string,
): Promise<Array<PersistedPromptQueue<T>>> {
  return invoke<Array<PersistedPromptQueue<T>>>("list_prompt_queues", { environmentId });
}

export async function enqueuePromptQueueMessage<T>(
  queueKey: string,
  environmentId: string,
  message: T,
): Promise<PersistedPromptQueue<T>> {
  return invoke<PersistedPromptQueue<T>>("enqueue_prompt_queue_message", {
    queueKey,
    environmentId,
    message,
  });
}

export async function requeuePromptQueueMessage<T>(
  queueKey: string,
  environmentId: string,
  message: T,
): Promise<PersistedPromptQueue<T>> {
  return invoke<PersistedPromptQueue<T>>("requeue_prompt_queue_message", {
    queueKey,
    environmentId,
    message,
  });
}

export async function removePromptQueueMessage<T>(
  queueKey: string,
  environmentId: string,
  messageId: string,
): Promise<{
  removed: T | null;
  queue: PersistedPromptQueue<T> | null;
}> {
  return invoke("remove_prompt_queue_message", {
    queueKey,
    environmentId,
    messageId,
  });
}

export async function movePromptQueueMessage<T>(
  queueKey: string,
  environmentId: string,
  messageId: string,
  direction: "up" | "down",
): Promise<PersistedPromptQueue<T> | null> {
  return invoke<PersistedPromptQueue<T> | null>("move_prompt_queue_message", {
    queueKey,
    environmentId,
    messageId,
    direction,
  });
}

export async function claimPromptQueueHead<T>(
  queueKey: string,
  environmentId: string,
  expectedMessageId: string,
): Promise<{
  claimed: T | null;
  claimToken: string | null;
  queue: PersistedPromptQueue<T> | null;
}> {
  return invoke("claim_prompt_queue_head", {
    queueKey,
    environmentId,
    expectedMessageId,
  });
}

export async function acknowledgePromptQueueClaim<T>(
  queueKey: string,
  environmentId: string,
  claimToken: string,
): Promise<PersistedPromptQueue<T> | null> {
  return invoke<PersistedPromptQueue<T> | null>("acknowledge_prompt_queue_claim", {
    queueKey,
    environmentId,
    claimToken,
  });
}

export async function rejectPromptQueueClaim<T>(
  queueKey: string,
  environmentId: string,
  claimToken: string,
): Promise<PersistedPromptQueue<T> | null> {
  return invoke<PersistedPromptQueue<T> | null>("reject_prompt_queue_claim", {
    queueKey,
    environmentId,
    claimToken,
  });
}

export async function transferPromptQueueMessageToComposeDraft<T>(
  queueKey: string,
  environmentId: string,
  messageId: string,
  draftKey: string,
  ownerType: "environment" | "project",
  ownerId: string,
  expectedDraftRevision?: number,
): Promise<{
  removed: T | null;
  queue: PersistedPromptQueue<T> | null;
  draft: PersistedComposeDraft | null;
}> {
  return invoke("transfer_prompt_queue_message_to_compose_draft", {
    queueKey,
    environmentId,
    messageId,
    draftKey,
    ownerType,
    ownerId,
    ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
  });
}

export async function retryPromptQueueDispatch<T = unknown>(
  queueKey: string,
): Promise<PersistedPromptQueue<T> | null> {
  return invoke<PersistedPromptQueue<T> | null>(
    "retry_prompt_queue_dispatch",
    { queueKey },
  );
}

// --- Unsent drafts ---

export async function getComposeDraft<T = unknown>(
  draftKey: string,
): Promise<PersistedComposeDraft<T> | null> {
  return invoke<PersistedComposeDraft<T> | null>("get_compose_draft", { draftKey });
}

export async function listComposeDrafts<T = unknown>(
  ownerType: "environment" | "project",
  ownerId: string,
): Promise<Array<PersistedComposeDraft<T>>> {
  return invoke<Array<PersistedComposeDraft<T>>>("list_compose_drafts", {
    ownerType,
    ownerId,
  });
}

export async function saveComposeDraft<T>(
  draftKey: string,
  ownerType: "environment" | "project",
  ownerId: string,
  value: T,
  expectedRevision?: number,
): Promise<PersistedComposeDraft<T>> {
  return invoke<PersistedComposeDraft<T>>("save_compose_draft", {
    draftKey,
    ownerType,
    ownerId,
    value,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}

export async function deleteComposeDraft(
  draftKey: string,
  expectedRevision?: number,
): Promise<void> {
  return invoke("delete_compose_draft", {
    draftKey,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}

export async function getFileDraft(
  draftKey: string,
): Promise<PersistedFileDraft | null> {
  return invoke<PersistedFileDraft | null>("get_file_draft", { draftKey });
}

export async function saveFileDraft(
  draftKey: string,
  environmentId: string,
  filePath: string,
  content: string,
  originalContent: string,
  expectedRevision?: number,
): Promise<PersistedFileDraft> {
  return invoke<PersistedFileDraft>("save_file_draft", {
    draftKey,
    environmentId,
    filePath,
    content,
    originalContent,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}

export async function deleteFileDraft(
  draftKey: string,
  expectedRevision?: number,
): Promise<void> {
  return invoke("delete_file_draft", {
    draftKey,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}

// --- Agent Handoffs ---

export async function getAgentHandoff<T = unknown>(
  handoffId: string,
): Promise<PersistedAgentHandoff<T> | null> {
  return invoke<PersistedAgentHandoff<T> | null>("get_agent_handoff", { handoffId });
}

export async function saveAgentHandoff<T extends Record<string, unknown>>(
  handoffId: string,
  environmentId: string,
  version: number,
  snapshot: T,
): Promise<PersistedAgentHandoff<T>> {
  return invoke<PersistedAgentHandoff<T>>("save_agent_handoff", {
    handoffId,
    environmentId,
    version,
    snapshot,
  });
}

export async function deleteAgentHandoff(
  handoffId: string,
  environmentId: string,
): Promise<boolean> {
  return invoke<boolean>("delete_agent_handoff", { handoffId, environmentId });
}

/**
 * Deletes every stored handoff for an environment that the restored pane layout
 * no longer references. Self-healing counterpart to the best-effort delete that
 * runs when a tab closes.
 */
export async function pruneAgentHandoffs(
  environmentId: string,
  referencedHandoffIds: string[],
): Promise<string[]> {
  return invoke<string[]>("prune_agent_handoffs", {
    environmentId,
    referencedHandoffIds,
  });
}

// --- Local Server Commands (for local/worktree environments) ---

/** Join the backend-owned startup wait for one environment/provider pair. */
export async function awaitBridgeReady(
  environmentId: string,
  agent: AgentBridgeKind,
  timeoutMs = 60_000,
): Promise<AwaitBridgeReadyResult> {
  const result = await invoke<unknown>("await_bridge_ready", {
    environmentId,
    agent,
    timeoutMs,
  });
  if (!isAwaitBridgeReadyResult(result)) {
    throw new Error("Backend returned an invalid bridge readiness result");
  }
  return result;
}

// --- Local Terminal Commands (for local/worktree environments) ---

/** Create a local terminal session for a local environment */
export async function createLocalTerminalSession(
  environmentId: string,
  cols: number,
  rows: number,
  trackEnvironmentActivity = false,
  terminalKey?: string,
): Promise<TerminalSessionCreateResult> {
  const result = await invoke<unknown>("create_local_terminal_session", {
    environmentId,
    cols,
    rows,
    trackEnvironmentActivity,
    terminalKey,
  });
  return parseTerminalSessionCreateResult(result);
}

/** Start a local terminal session and begin forwarding output */
export async function startLocalTerminalSession(sessionId: string): Promise<void> {
  return invoke("start_local_terminal_session", { sessionId });
}

/** Write data to a local terminal session */
export async function writeLocalTerminal(sessionId: string, data: string): Promise<void> {
  return invoke("local_terminal_write", { sessionId, data });
}

/** Resize a local terminal session */
export async function resizeLocalTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("local_terminal_resize", { sessionId, cols, rows });
}

/** Close a local terminal session */
export async function closeLocalTerminalSession(sessionId: string): Promise<void> {
  return invoke("close_local_terminal_session", { sessionId });
}
