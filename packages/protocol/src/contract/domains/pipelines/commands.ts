/**
 * Every `pipelines` command (plan item 7007; docs/reports/unified-federation.md
 * §11.2, Appendix E): build pipeline launches, controls and reads
 * (`commands-registry-build.ts`) and the workflow result transport's
 * operational surface (`commands-registry-workflow-results.ts`).
 *
 * Argument rules:
 *
 * - Every key a handler reads is declared: a defined command drops undeclared
 *   keys before the handler runs.
 * - A key the handler reads with `asString`/`asNonBlankString` is
 *   `Schema.String` (the schema's text is the helper's, `Expected pipelineId
 *   to be a string`; the handler still trims and refuses a blank one), and
 *   `asRequiredBoolean` keys are `Schema.Boolean`.
 * - A key read leniently, or validated by a protocol guard with its own
 *   message (the start requests, a restart selection, the conditional-read
 *   keys), is `optionalKey(Unknown)`: nothing accepted today is refused and
 *   every message is unchanged.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { mutableArray } from "../../model-schema.js";
import { KanbanTaskSchema } from "../kanban/schemas.js";
import { ClientEnvironmentSchema } from "../environments/models.js";
import { NullableProjectionSchema } from "../native-sessions/schemas.js";
import { pipelinesDomain } from "./domain.js";
import {
  BuildPipelineSchema,
  CodeRewindPreviewSchema,
  CreateFeatureBuildResultSchema,
  GetBuildPipelineResultSchema,
  ImportLegacyBuildPipelinesResultSchema,
  ListBuildPipelinesResultSchema,
  PipelineWorkerTranscriptSchema,
  RemoveQueuedBuildPipelineMessageResultSchema,
  StartFeaturePlanBuildResultSchema,
  SteerBuildPipelineResultSchema,
  SteerQueuedBuildPipelineMessageResultSchema,
  WorkflowResultMetricsResultSchema,
  WorkflowResultToolsSettingsSchema,
} from "./schemas.js";

const checked = Schema.optionalKey(Schema.Unknown);

/**
 * `StartBuildPipelineInput` (build-pipeline.ts), every key the start guard and
 * `BuildPipelineService.start` read. `launch_build_pipeline` takes the same
 * request with `agentType` optional.
 */
const startFields = {
  taskId: checked,
  projectId: checked,
  environmentType: checked,
  delegationBaseBranch: checked,
  delegationBaseCommit: checked,
  agentType: checked,
  steps: checked,
  reviewers: checked,
  reviewPreparation: checked,
  taskTitle: checked,
  taskSnapshot: checked,
  source: checked,
  environmentOptions: checked,
  namingPrompt: checked,
  existingEnvironmentId: checked,
  maxIterations: checked,
  featurePlanId: checked,
  deliveryPolicy: checked,
} as const;

const pipelineArgs = Schema.Struct({ pipelineId: Schema.String });
const reviewerArgs = Schema.Struct({ pipelineId: Schema.String, reviewerId: Schema.String });
const stageArgs = Schema.Struct({ pipelineId: Schema.String, stageId: Schema.String });
const messageArgs = Schema.Struct({ pipelineId: Schema.String, messageId: Schema.String });
const textArgs = Schema.Struct({ pipelineId: Schema.String, text: Schema.String });

// --------------------------------------------------------------- launches

export const startBuildPipelineCommand = defineCommand({
  domain: pipelinesDomain,
  name: "start_build_pipeline",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct(startFields),
  result: BuildPipelineSchema,
  critical: ["existingEnvironmentId", "deliveryPolicy"],
});

export const createFeatureBuildCommand = defineCommand({
  domain: pipelinesDomain,
  name: "create_feature_build",
  since: 1,
  access: "workspace",
  read: false,
  // `CreateFeatureBuildInput` (feature-build.ts), checked by its guard.
  args: Schema.Struct({
    projectId: checked,
    title: checked,
    description: checked,
    acceptanceCriteria: checked,
    environmentType: checked,
    environmentOptions: checked,
    agentType: checked,
    steps: checked,
    reviewers: checked,
    reviewPreparation: checked,
    images: checked,
    deliveryPolicy: checked,
    requestId: checked,
  }),
  result: CreateFeatureBuildResultSchema,
  critical: ["requestId", "deliveryPolicy"],
});

export const launchBuildPipelineCommand = defineCommand({
  domain: pipelinesDomain,
  name: "launch_build_pipeline",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct(startFields),
  result: BuildPipelineSchema,
  critical: ["existingEnvironmentId", "deliveryPolicy"],
});

export const startFeaturePlanBuildCommand = defineCommand({
  domain: pipelinesDomain,
  name: "start_feature_plan_build",
  since: 1,
  access: "workspace",
  read: false,
  // `StartFeaturePlanBuildInput` (feature-build.ts), checked by its guard.
  args: Schema.Struct({ featureId: checked, environmentType: checked, agentType: checked }),
  result: StartFeaturePlanBuildResultSchema,
  critical: [],
});

// --------------------------------------------------------------- controls

function pipelineControl<const Name extends string>(name: Name) {
  return defineCommand({
    domain: pipelinesDomain,
    name,
    since: 1,
    access: "workspace",
    read: false,
    args: pipelineArgs,
    result: BuildPipelineSchema,
    critical: [],
  });
}

function reviewerControl<const Name extends string>(name: Name) {
  return defineCommand({
    domain: pipelinesDomain,
    name,
    since: 1,
    access: "workspace",
    read: false,
    args: reviewerArgs,
    result: BuildPipelineSchema,
    critical: [],
  });
}

export const pauseBuildPipelineCommand = pipelineControl("pause_build_pipeline");
export const resumeBuildPipelineCommand = pipelineControl("resume_build_pipeline");
export const cancelBuildPipelineCommand = pipelineControl("cancel_build_pipeline");

export const sendBuildPipelineMessageCommand = defineCommand({
  domain: pipelinesDomain,
  name: "send_build_pipeline_message",
  since: 1,
  access: "workspace",
  read: false,
  args: textArgs,
  result: BuildPipelineSchema,
  critical: [],
});

export const steerBuildPipelineCommand = defineCommand({
  domain: pipelinesDomain,
  name: "steer_build_pipeline",
  since: 1,
  access: "workspace",
  read: false,
  args: textArgs,
  result: SteerBuildPipelineResultSchema,
  critical: [],
});

export const steerQueuedBuildPipelineMessageCommand = defineCommand({
  domain: pipelinesDomain,
  name: "steer_queued_build_pipeline_message",
  since: 1,
  access: "workspace",
  read: false,
  args: messageArgs,
  result: SteerQueuedBuildPipelineMessageResultSchema,
  critical: [],
});

export const removeQueuedBuildPipelineMessageCommand = defineCommand({
  domain: pipelinesDomain,
  name: "remove_queued_build_pipeline_message",
  since: 1,
  access: "workspace",
  read: false,
  args: messageArgs,
  result: RemoveQueuedBuildPipelineMessageResultSchema,
  critical: [],
});

export const retryBuildPipelineReviewCommand = pipelineControl("retry_build_pipeline_review");
export const retryBuildPipelineStageCommand = pipelineControl("retry_build_pipeline_stage");
export const retryBuildPipelineReviewerCommand = reviewerControl("retry_build_pipeline_reviewer");
export const restartBuildPipelineReviewerCommand = reviewerControl(
  "restart_build_pipeline_reviewer",
);
export const stopBuildPipelineReviewerCommand = reviewerControl("stop_build_pipeline_reviewer");

export const restartBuildPipelineStepCommand = defineCommand({
  domain: pipelinesDomain,
  name: "restart_build_pipeline_step",
  since: 1,
  access: "workspace",
  read: false,
  // `selection` is "Restart in…" (`isBuildPipelineRestartSelection`).
  args: Schema.Struct({ pipelineId: Schema.String, stageId: Schema.String, selection: checked }),
  result: BuildPipelineSchema,
  critical: ["selection"],
});

export const previewBuildPipelineCodeRewindCommand = defineCommand({
  domain: pipelinesDomain,
  name: "preview_build_pipeline_code_rewind",
  since: 1,
  access: "workspace",
  read: true,
  args: stageArgs,
  result: CodeRewindPreviewSchema,
  critical: [],
});

export const rewindBuildPipelineCodeCommand = defineCommand({
  domain: pipelinesDomain,
  name: "rewind_build_pipeline_code",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    pipelineId: Schema.String,
    stageId: Schema.String,
    expectedHead: Schema.String,
  }),
  result: BuildPipelineSchema,
  critical: [],
});

export const skipBuildPipelineStepCommand = defineCommand({
  domain: pipelinesDomain,
  name: "skip_build_pipeline_step",
  since: 1,
  access: "workspace",
  read: false,
  args: stageArgs,
  result: BuildPipelineSchema,
  critical: [],
});

export const restartBuildPipelineCurrentStepCommand = pipelineControl(
  "restart_build_pipeline_current_step",
);
export const retryBuildPipelineInteractionFailureCommand = pipelineControl(
  "retry_build_pipeline_interaction_failure",
);
export const retryBuildPipelineCompletionCommentCommand = pipelineControl(
  "retry_build_pipeline_completion_comment",
);

export const importLegacyBuildPipelinesCommand = defineCommand({
  domain: pipelinesDomain,
  name: "import_legacy_build_pipelines",
  since: 1,
  access: "workspace",
  read: false,
  // `Expected snapshots to be an array`, as the handler said; it bounds the count itself.
  args: Schema.Struct({ projectId: Schema.String, snapshots: mutableArray(Schema.Unknown) }),
  result: ImportLegacyBuildPipelinesResultSchema,
  critical: [],
});

// --------------------------------------------------------------- reads and records

export const getBuildPipelineCommand = defineCommand({
  domain: pipelinesDomain,
  name: "get_build_pipeline",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    pipelineId: Schema.String,
    knownRevision: checked,
    knownSessions: checked,
    prioritySessionKey: checked,
  }),
  result: GetBuildPipelineResultSchema,
  critical: [],
});

export const getBuildPipelineSessionProjectionCommand = defineCommand({
  domain: pipelinesDomain,
  name: "get_build_pipeline_session_projection",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    pipelineId: Schema.String,
    sessionKey: Schema.String,
    refreshUsage: Schema.optionalKey(Schema.Boolean),
  }),
  result: NullableProjectionSchema,
  critical: [],
});

export const getBuildPipelineWorkerTranscriptCommand = defineCommand({
  domain: pipelinesDomain,
  name: "get_build_pipeline_worker_transcript",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Schema.String, tabId: Schema.String, limit: checked }),
  // `null` only for a Multi Review reviewer address the supervisor no longer knows.
  result: Schema.NullOr(PipelineWorkerTranscriptSchema),
  critical: [],
});

export const listBuildPipelinesCommand = defineCommand({
  domain: pipelinesDomain,
  name: "list_build_pipelines",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
    knownRevisions: checked,
    knownManifestGeneration: checked,
    knownResourceRevision: checked,
  }),
  result: ListBuildPipelinesResultSchema,
  critical: [],
});

/** Refused on every call: pipeline state is backend-owned. Kept for older renderers' error text. */
export const saveBuildPipelineCommand = defineCommand({
  domain: pipelinesDomain,
  name: "save_build_pipeline",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({}),
  result: Schema.Void,
  critical: [],
});

export const deleteBuildPipelineCommand = defineCommand({
  domain: pipelinesDomain,
  name: "delete_build_pipeline",
  since: 1,
  access: "workspace",
  read: false,
  args: pipelineArgs,
  result: Schema.Void,
  critical: [],
});

export const clearTaskBuildStatusCommand = defineCommand({
  domain: pipelinesDomain,
  name: "clear_task_build_status",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ taskId: Schema.String }),
  result: Schema.Struct({
    task: KanbanTaskSchema,
    removedPipelineIds: mutableArray(Schema.String),
  }),
  critical: [],
});

export const setEnvironmentUnreadCommand = defineCommand({
  domain: pipelinesDomain,
  name: "set_environment_unread",
  since: 1,
  access: "workspace",
  read: false,
  // `unread` is read leniently (anything but `true` clears the badge);
  // `expectedLastActivityAt` may be `null`.
  args: Schema.Struct({
    environmentId: Schema.String,
    unread: checked,
    expectedLastActivityAt: checked,
  }),
  result: ClientEnvironmentSchema,
  critical: ["expectedLastActivityAt"],
});

// --------------------------------------------------------------- workflow results

export const getWorkflowResultMetricsCommand = defineCommand({
  domain: pipelinesDomain,
  name: "get_workflow_result_metrics",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: WorkflowResultMetricsResultSchema,
  critical: [],
});

export const getWorkflowResultToolsRolloutCommand = defineCommand({
  domain: pipelinesDomain,
  name: "get_workflow_result_tools_rollout",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: WorkflowResultToolsSettingsSchema,
  critical: [],
});

export const setWorkflowResultToolsRolloutCommand = defineCommand({
  domain: pipelinesDomain,
  name: "set_workflow_result_tools_rollout",
  since: 1,
  access: "admin",
  read: false,
  // Each is checked with its own message (`enabled must be a boolean`, ...).
  args: Schema.Struct({ enabled: checked, providers: checked, kinds: checked }),
  result: WorkflowResultToolsSettingsSchema,
  critical: [],
});

export const PIPELINES_COMMANDS = [
  startBuildPipelineCommand,
  createFeatureBuildCommand,
  launchBuildPipelineCommand,
  startFeaturePlanBuildCommand,
  pauseBuildPipelineCommand,
  resumeBuildPipelineCommand,
  cancelBuildPipelineCommand,
  sendBuildPipelineMessageCommand,
  steerBuildPipelineCommand,
  steerQueuedBuildPipelineMessageCommand,
  removeQueuedBuildPipelineMessageCommand,
  retryBuildPipelineReviewCommand,
  retryBuildPipelineStageCommand,
  retryBuildPipelineReviewerCommand,
  restartBuildPipelineReviewerCommand,
  stopBuildPipelineReviewerCommand,
  restartBuildPipelineStepCommand,
  previewBuildPipelineCodeRewindCommand,
  rewindBuildPipelineCodeCommand,
  skipBuildPipelineStepCommand,
  restartBuildPipelineCurrentStepCommand,
  retryBuildPipelineInteractionFailureCommand,
  retryBuildPipelineCompletionCommentCommand,
  importLegacyBuildPipelinesCommand,
  getBuildPipelineCommand,
  getBuildPipelineSessionProjectionCommand,
  getBuildPipelineWorkerTranscriptCommand,
  listBuildPipelinesCommand,
  saveBuildPipelineCommand,
  deleteBuildPipelineCommand,
  clearTaskBuildStatusCommand,
  setEnvironmentUnreadCommand,
  getWorkflowResultMetricsCommand,
  getWorkflowResultToolsRolloutCommand,
  setWorkflowResultToolsRolloutCommand,
] as const;
