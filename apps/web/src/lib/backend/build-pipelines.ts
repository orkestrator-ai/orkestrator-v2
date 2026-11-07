/**
 * Build pipeline commands (plan item 7007, the `pipelines` domain): starts,
 * controls, reads and the records a project lists, through the domain client
 * (`pipelines(client)`), so a node that advertises the domain gets typed,
 * enveloped calls and every other node today's calls by name.
 *
 * Split out of `workflows.ts`, whose `createWorkflowsApi` spreads this API and
 * whose named exports still include these functions.
 */
import { hydrationRequests } from "@/lib/hydration-request-limiter";
import { asWebModel } from "@/lib/node-scope/domains/native-sessions";
import { pipelines } from "@/lib/node-scope/domains/pipelines";
import type {
  CreateFeatureBuildInput,
  CreateFeatureBuildResult,
} from "@orkestrator/protocol/feature-build";
import type { BuildPipelineRestartSelection } from "@orkestrator/protocol/build-pipeline-restart-selection";
import type {
  BuildPipeline as BackendBuildPipeline,
  BuildPipelineCodeRewindPreview,
  PipelineQueuedSteerDelivery,
  StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import type { Environment, PersistedBuildPipeline } from "@/types";
import type { KanbanTask } from "./kanban";
import { isRecord } from "./shared";
import { commandBackendClient, type BackendClient } from "./client";

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
        /** The stored transcript could not be read; keep what is held. */
        unavailable?: true;
        /** Over the response budget; a later read fetches it. */
        deferred?: true;
        /** Some history was not retained by the backend's transcript bound. */
        complete?: false;
      }>;
    }
  | PersistedBuildPipeline<T>
  | null;

/**
 * This file's commands on `client`'s node (plan item 3002). `createWorkflowsApi`
 * includes them, so its scoped callers keep one factory.
 */
export function createBuildPipelinesApi(client: BackendClient) {
  const domain = () => pipelines(client);

  async function startBuildPipeline(input: StartBuildPipelineInput): Promise<BackendBuildPipeline> {
    return domain().start_build_pipeline({ ...input });
  }

  /**
   * Creates the ticket and starts its build in one backend-owned request.
   *
   * The renderer deliberately does not create the ticket itself and then start a
   * pipeline: those are two writes, and a tab that goes away between them leaves
   * a ticket nobody is building. `requestId` makes a retry return the same ticket
   * and the same pipeline rather than a second of each.
   */
  async function createFeatureBuild(
    input: CreateFeatureBuildInput,
  ): Promise<CreateFeatureBuildResult> {
    return domain().create_feature_build({ ...input });
  }

  async function pauseBuildPipeline(pipelineId: string): Promise<BackendBuildPipeline> {
    return domain().pause_build_pipeline({ pipelineId });
  }

  async function resumeBuildPipeline(pipelineId: string): Promise<BackendBuildPipeline> {
    return domain().resume_build_pipeline({ pipelineId });
  }

  async function cancelBuildPipeline(pipelineId: string): Promise<BackendBuildPipeline> {
    return domain().cancel_build_pipeline({ pipelineId });
  }

  async function sendBuildPipelineMessage(
    pipelineId: string,
    text: string,
  ): Promise<BackendBuildPipeline> {
    return domain().send_build_pipeline_message({ pipelineId, text });
  }

  /**
   * Injects an instruction into the turn the pipeline agent is running now.
   * `delivery` is `queued` when there was no live turn to steer, in which case the
   * instruction waits for the agent like an ordinary message.
   */
  async function steerBuildPipeline(
    pipelineId: string,
    text: string,
  ): Promise<{ pipeline: BackendBuildPipeline; delivery: "steered" | "queued" }> {
    return domain().steer_build_pipeline({ pipelineId, text });
  }

  /**
   * Moves one queued message into the turn the pipeline agent is running now.
   * `notice` is the agent's reason when it refused, or the warning when delivery
   * could not be confirmed.
   */
  async function steerQueuedBuildPipelineMessage(
    pipelineId: string,
    messageId: string,
  ): Promise<{
    pipeline: BackendBuildPipeline;
    delivery: PipelineQueuedSteerDelivery;
    notice?: string;
  }> {
    return domain().steer_queued_build_pipeline_message({ pipelineId, messageId });
  }

  /** `removed` is false when the message had already left the queue as the next turn. */
  async function removeQueuedBuildPipelineMessage(
    pipelineId: string,
    messageId: string,
  ): Promise<{ pipeline: BackendBuildPipeline; removed: boolean }> {
    return domain().remove_queued_build_pipeline_message({ pipelineId, messageId });
  }

  async function restartBuildPipelineCurrentStep(
    pipelineId: string,
  ): Promise<BackendBuildPipeline> {
    return domain().restart_build_pipeline_current_step({ pipelineId });
  }

  async function retryBuildPipelineStage(pipelineId: string): Promise<BackendBuildPipeline> {
    return domain().retry_build_pipeline_stage({ pipelineId });
  }

  /** Runs one failed reviewer of the current review pass again. */
  async function retryBuildPipelineReviewer(
    pipelineId: string,
    reviewerId: string,
  ): Promise<BackendBuildPipeline> {
    return domain().retry_build_pipeline_reviewer({ pipelineId, reviewerId });
  }

  /**
   * Runs one reviewer again whatever state it is in, keeping the rest of the panel.
   * `reviewerId` names a live reviewer, or the session of one whose pass has ended.
   */
  async function restartBuildPipelineReviewer(
    pipelineId: string,
    reviewerId: string,
  ): Promise<BackendBuildPipeline> {
    return domain().restart_build_pipeline_reviewer({ pipelineId, reviewerId });
  }

  /** Stops one reviewer of the running review, keeping the rest of the panel. */
  async function stopBuildPipelineReviewer(
    pipelineId: string,
    reviewerId: string,
  ): Promise<BackendBuildPipeline> {
    return domain().stop_build_pipeline_reviewer({ pipelineId, reviewerId });
  }

  /**
   * Restarts a pipeline step. A `selection` ("Restart in…") runs the step, and
   * every later run of it, on that agent and model instead.
   */
  async function restartBuildPipelineStep(
    pipelineId: string,
    stageId: string,
    selection?: BuildPipelineRestartSelection,
  ): Promise<BackendBuildPipeline> {
    return domain().restart_build_pipeline_step({
      pipelineId,
      stageId,
      ...(selection ? { selection } : {}),
    });
  }

  /** What "Rewind code to here" would drop, read before the user confirms it. */
  async function previewBuildPipelineCodeRewind(
    pipelineId: string,
    stageId: string,
  ): Promise<BuildPipelineCodeRewindPreview> {
    return domain().preview_build_pipeline_code_rewind({ pipelineId, stageId });
  }

  /**
   * Resets the worktree to the commit a step started from and restarts that
   * step. `expectedHead` is the HEAD the confirmed preview showed.
   */
  async function rewindBuildPipelineCode(
    pipelineId: string,
    stageId: string,
    expectedHead: string,
  ): Promise<BackendBuildPipeline> {
    return domain().rewind_build_pipeline_code({ pipelineId, stageId, expectedHead });
  }

  /** Skips the pipeline's current stage and moves on to the next one. */
  async function skipBuildPipelineStep(
    pipelineId: string,
    stageId: string,
  ): Promise<BackendBuildPipeline> {
    return domain().skip_build_pipeline_step({ pipelineId, stageId });
  }

  async function retryBuildPipelineInteractionFailure(
    pipelineId: string,
  ): Promise<BackendBuildPipeline> {
    return domain().retry_build_pipeline_interaction_failure({ pipelineId });
  }

  async function retryBuildPipelineCompletionComment(
    pipelineId: string,
  ): Promise<BackendBuildPipeline> {
    return domain().retry_build_pipeline_completion_comment({ pipelineId });
  }

  async function importLegacyBuildPipelines(
    projectId: string,
    snapshots: unknown[],
  ): Promise<{ importedIds: string[]; skipped: number }> {
    return domain().import_legacy_build_pipelines({ projectId, snapshots });
  }

  async function getBuildPipeline<T = unknown>(
    pipelineId: string,
  ): Promise<PersistedBuildPipeline<T> | null> {
    // Without `knownRevision` or `knownSessions` the answer is the record or `null`.
    return asWebModel<PersistedBuildPipeline<T> | null>(
      domain().get_build_pipeline({ pipelineId }),
    );
  }

  /**
   * Resolve one backend-owned build stage through the same native projection used
   * by an ordinary agent tab. The backend validates both identifiers against the
   * persisted pipeline before adopting the provider session for inspection.
   */
  async function getBuildPipelineSessionProjection<TMessage = unknown>(input: {
    pipelineId: string;
    sessionKey: string;
    refreshUsage?: boolean;
  }): Promise<NativeAgentSessionProjection<TMessage> | null> {
    return asWebModel<NativeAgentSessionProjection<TMessage> | null>(
      domain().get_build_pipeline_session_projection(input),
    );
  }

  /**
   * Control state plus transcript windows for the sessions whose bodies the
   * caller does not hold at their committed revision. `knownSessions` names the
   * bodies held (revision and count); omitted sessions come back whole, and
   * `prioritySessionKey` is served first when the response budget runs out.
   */
  async function getBuildPipelineConditional<T = unknown>(
    pipelineId: string,
    knownRevision?: number,
    knownSessions: Record<string, { revision: number; count: number }> = {},
    prioritySessionKey?: string,
  ): Promise<ConditionalBuildPipeline<T>> {
    const response: unknown = await domain().get_build_pipeline({
      pipelineId,
      knownRevision,
      knownSessions,
      ...(prioritySessionKey ? { prioritySessionKey } : {}),
    });
    // A version-1 answer is already decoded; a pre-contract node's answer is
    // checked here as before.
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
      response.unchanged === true &&
      Number.isSafeInteger(response.revision) &&
      (response.revision as number) >= 0
    ) {
      return response as { unchanged: true; revision: number };
    }
    if (
      response.unchanged !== false ||
      !isRecord(response.record) ||
      typeof response.record.id !== "string" ||
      !Array.isArray(response.messagePatches) ||
      !response.messagePatches.every((value) => {
        if (!isRecord(value)) return false;
        return (
          typeof value.sessionKey === "string" &&
          Number.isSafeInteger(value.startIndex) &&
          (value.startIndex as number) >= 0 &&
          Number.isSafeInteger(value.revision) &&
          (value.revision as number) >= 0 &&
          (value.baseRevision === undefined ||
            (Number.isSafeInteger(value.baseRevision) && (value.baseRevision as number) >= 0)) &&
          (value.baseCount === undefined ||
            (Number.isSafeInteger(value.baseCount) && (value.baseCount as number) >= 0)) &&
          (value.unavailable === undefined || value.unavailable === true) &&
          (value.deferred === undefined || value.deferred === true) &&
          (value.complete === undefined || value.complete === false) &&
          Array.isArray(value.messages)
        );
      })
    ) {
      throw new Error("Invalid get_build_pipeline response");
    }
    return response as unknown as ConditionalBuildPipeline<T>;
  }

  /**
   * Control state only: `unchanged` when the record is still at `knownRevision`,
   * otherwise the record without any transcript body.
   */
  async function getBuildPipelineControl<T = unknown>(
    pipelineId: string,
    knownRevision?: number,
  ): Promise<{ unchanged: true; revision: number } | PersistedBuildPipeline<T> | null> {
    const response: unknown = await domain().get_build_pipeline({
      pipelineId,
      ...(knownRevision === undefined ? {} : { knownRevision }),
    });
    if (response === null) return null;
    if (
      isRecord(response) &&
      response.unchanged === true &&
      Number.isSafeInteger(response.revision) &&
      (response.revision as number) >= 0
    ) {
      return response as { unchanged: true; revision: number };
    }
    if (!isRecord(response) || "unchanged" in response || typeof response.id !== "string") {
      throw new Error("Invalid get_build_pipeline response");
    }
    return response as unknown as PersistedBuildPipeline<T>;
  }

  async function listBuildPipelines<T = unknown>(
    projectId: string,
  ): Promise<Array<PersistedBuildPipeline<T>>> {
    // Without `knownRevisions` or a manifest generation the answer is the record list.
    return hydrationRequests.run(() =>
      asWebModel<Array<PersistedBuildPipeline<T>>>(domain().list_build_pipelines({ projectId })),
    );
  }

  async function listBuildPipelinesConditional<T = unknown>(
    projectId: string,
    knownRevisions: Record<string, number>,
  ): Promise<{ ids: string[]; records: Array<PersistedBuildPipeline<T>> }> {
    const response: unknown = await hydrationRequests.run(() =>
      domain().list_build_pipelines({ projectId, knownRevisions }),
    );
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
      !isRecord(response) ||
      !Array.isArray(response.ids) ||
      !response.ids.every((id) => typeof id === "string") ||
      !Array.isArray(response.records) ||
      !response.records.every((entry) => isRecord(entry) && typeof entry.id === "string")
    ) {
      throw new Error("Invalid list_build_pipelines response");
    }
    return response as unknown as {
      ids: string[];
      records: Array<PersistedBuildPipeline<T>>;
    };
  }

  async function deleteBuildPipeline(pipelineId: string): Promise<void> {
    return domain().delete_build_pipeline({ pipelineId });
  }

  async function clearTaskBuildStatus(taskId: string): Promise<{
    task: KanbanTask;
    removedPipelineIds: string[];
  }> {
    return asWebModel<{ task: KanbanTask; removedPipelineIds: string[] }>(
      domain().clear_task_build_status({ taskId }),
    );
  }

  /**
   * Marks or clears the environment's unread badge.
   *
   * A dedicated command rather than a general update so two clients racing on the
   * badge cannot clobber each other's unrelated environment fields.
   */
  async function setEnvironmentUnread(
    environmentId: string,
    unread: boolean,
    expectedLastActivityAt?: string | null,
  ): Promise<Environment> {
    return asWebModel<Environment>(
      domain().set_environment_unread({
        environmentId,
        unread,
        ...(expectedLastActivityAt === undefined ? {} : { expectedLastActivityAt }),
      }),
    );
  }

  return {
    startBuildPipeline,
    createFeatureBuild,
    pauseBuildPipeline,
    resumeBuildPipeline,
    cancelBuildPipeline,
    sendBuildPipelineMessage,
    steerBuildPipeline,
    steerQueuedBuildPipelineMessage,
    removeQueuedBuildPipelineMessage,
    restartBuildPipelineCurrentStep,
    retryBuildPipelineStage,
    retryBuildPipelineReviewer,
    restartBuildPipelineReviewer,
    stopBuildPipelineReviewer,
    restartBuildPipelineStep,
    previewBuildPipelineCodeRewind,
    rewindBuildPipelineCode,
    skipBuildPipelineStep,
    retryBuildPipelineInteractionFailure,
    retryBuildPipelineCompletionComment,
    importLegacyBuildPipelines,
    getBuildPipeline,
    getBuildPipelineSessionProjection,
    getBuildPipelineConditional,
    getBuildPipelineControl,
    listBuildPipelines,
    listBuildPipelinesConditional,
    deleteBuildPipeline,
    clearTaskBuildStatus,
    setEnvironmentUnread,
  };
}

export type BuildPipelinesApi = ReturnType<typeof createBuildPipelinesApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  startBuildPipeline,
  createFeatureBuild,
  pauseBuildPipeline,
  resumeBuildPipeline,
  cancelBuildPipeline,
  sendBuildPipelineMessage,
  steerBuildPipeline,
  steerQueuedBuildPipelineMessage,
  removeQueuedBuildPipelineMessage,
  restartBuildPipelineCurrentStep,
  retryBuildPipelineStage,
  retryBuildPipelineReviewer,
  restartBuildPipelineReviewer,
  stopBuildPipelineReviewer,
  restartBuildPipelineStep,
  previewBuildPipelineCodeRewind,
  rewindBuildPipelineCode,
  skipBuildPipelineStep,
  retryBuildPipelineInteractionFailure,
  retryBuildPipelineCompletionComment,
  importLegacyBuildPipelines,
  getBuildPipeline,
  getBuildPipelineSessionProjection,
  getBuildPipelineConditional,
  getBuildPipelineControl,
  listBuildPipelines,
  listBuildPipelinesConditional,
  deleteBuildPipeline,
  clearTaskBuildStatus,
  setEnvironmentUnread,
} = createBuildPipelinesApi(commandBackendClient);
