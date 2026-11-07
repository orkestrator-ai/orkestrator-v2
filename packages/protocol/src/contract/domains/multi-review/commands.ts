/**
 * Every `multi-review` command (plan item 7007; docs/reports/unified-
 * federation.md §11.2, Appendix E): Multi Review workflows and review
 * validation runs, registered by `commands-registry-reviews.ts`.
 *
 * Argument rules are those of `../pipelines/commands.ts`: every key a handler
 * reads is declared; `asNonBlankString`/`asRequiredBoolean` keys are typed;
 * keys a protocol guard checks with its own message (the start requests, step
 * and model selections, tokens, cursors and detail references) are
 * `optionalKey(Unknown)`. The start requests also declare the newer
 * vocabulary's key names (`autoAddressFindings`, `addressFindingsModel`),
 * which the handler rewrites to today's before its guard runs
 * (`canonicalMultiReview`).
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand, type ArgsSchema } from "../../command.js";
import { NullableProjectionSchema, ToolDetailsSchema } from "../native-sessions/schemas.js";
import { CodeRewindPreviewSchema } from "../pipelines/schemas.js";
import { multiReviewDomain } from "./domain.js";
import {
  GetMultiReviewWorkflowResultSchema,
  ListMultiReviewWorkflowsResultSchema,
  MultiReviewReviewerHistoryPageSchema,
  MultiReviewReviewerTranscriptSchema,
  MultiReviewStepTranscriptSchema,
  MultiReviewWorkflowSchema,
  ReviewValidationOutputSchema,
  ReviewValidationRunSchema,
} from "./schemas.js";

const checked = Schema.optionalKey(Schema.Unknown);

const workflowArgs = Schema.Struct({ workflowId: Schema.String });
const reviewerArgs = Schema.Struct({ workflowId: Schema.String, reviewerId: Schema.String });
const stepControlArgs = Schema.Struct({ workflowId: checked, kind: checked });

function workflowCommand<const Name extends string, Args extends ArgsSchema>(
  name: Name,
  args: Args,
) {
  return defineCommand({
    domain: multiReviewDomain,
    name,
    since: 1,
    access: "workspace",
    read: false,
    args,
    result: MultiReviewWorkflowSchema,
    critical: [],
  });
}

// --------------------------------------------------------------- review validation

/**
 * The validation run's lifecycle, which the Multi Review and build pipeline
 * supervisors drive in-process (`invoke`); no client calls them.
 */
function validationControl<const Name extends string>(name: Name) {
  return defineCommand({
    domain: multiReviewDomain,
    name,
    since: 1,
    access: "internal",
    read: false,
    // `run` is the caller's `ReviewValidationRun`, checked by the service.
    args: Schema.Struct({ environmentId: Schema.String, run: checked }),
    result: ReviewValidationRunSchema,
    critical: [],
  });
}

export const startReviewValidationCommand = validationControl("start_review_validation");
export const statusReviewValidationCommand = validationControl("status_review_validation");
export const cancelReviewValidationCommand = validationControl("cancel_review_validation");

export const stopReviewValidationCommandCommand = defineCommand({
  domain: multiReviewDomain,
  name: "stop_review_validation_command",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String, run: checked, resultId: Schema.String }),
  result: ReviewValidationRunSchema,
  critical: [],
});

export const getReviewValidationOutputCommand = defineCommand({
  domain: multiReviewDomain,
  name: "get_review_validation_output",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
    runId: Schema.String,
    resultId: Schema.String,
    known: checked,
  }),
  result: ReviewValidationOutputSchema,
  critical: [],
});

// --------------------------------------------------------------- reads

export const getMultiReviewWorkflowCommand = defineCommand({
  domain: multiReviewDomain,
  name: "get_multi_review_workflow",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ workflowId: Schema.String, knownRevision: checked }),
  result: GetMultiReviewWorkflowResultSchema,
  critical: [],
});

export const listMultiReviewWorkflowsCommand = defineCommand({
  domain: multiReviewDomain,
  name: "list_multi_review_workflows",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
    knownManifestGeneration: checked,
    knownResourceRevision: checked,
  }),
  result: ListMultiReviewWorkflowsResultSchema,
  critical: [],
});

export const getMultiReviewReviewerTranscriptCommand = defineCommand({
  domain: multiReviewDomain,
  name: "get_multi_review_reviewer_transcript",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    workflowId: Schema.String,
    reviewerId: Schema.String,
    knownSourceToken: checked,
  }),
  result: MultiReviewReviewerTranscriptSchema,
  critical: [],
});

export const getMultiReviewReviewerProjectionCommand = defineCommand({
  domain: multiReviewDomain,
  name: "get_multi_review_reviewer_projection",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    workflowId: Schema.String,
    reviewerId: Schema.String,
    refreshUsage: Schema.optionalKey(Schema.Boolean),
  }),
  result: NullableProjectionSchema,
  critical: [],
});

export const getMultiReviewStepTranscriptCommand = defineCommand({
  domain: multiReviewDomain,
  name: "get_multi_review_step_transcript",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ workflowId: Schema.String, step: checked, knownSourceToken: checked }),
  result: MultiReviewStepTranscriptSchema,
  critical: [],
});

export const getMultiReviewStepToolDetailsCommand = defineCommand({
  domain: multiReviewDomain,
  name: "get_multi_review_step_tool_details",
  since: 1,
  access: "workspace",
  read: true,
  // One guard checks all three: `Invalid multi review step tool detail request`.
  args: Schema.Struct({ workflowId: checked, step: checked, detailRef: checked }),
  result: ToolDetailsSchema,
  critical: [],
});

export const getMultiReviewReviewerToolDetailsCommand = defineCommand({
  domain: multiReviewDomain,
  name: "get_multi_review_reviewer_tool_details",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ workflowId: Schema.String, reviewerId: Schema.String, detailRef: checked }),
  result: ToolDetailsSchema,
  critical: [],
});

export const getMultiReviewReviewerHistoryPageCommand = defineCommand({
  domain: multiReviewDomain,
  name: "get_multi_review_reviewer_history_page",
  since: 1,
  access: "workspace",
  read: true,
  // `isMultiReviewReviewerHistoryPageRequest` checks the whole request.
  args: Schema.Struct({
    workflowId: checked,
    reviewerId: checked,
    before: checked,
    limit: checked,
    targetBytes: checked,
  }),
  result: MultiReviewReviewerHistoryPageSchema,
  critical: [],
});

// --------------------------------------------------------------- lifecycle

export const startMultiReviewCommand = workflowCommand(
  "start_multi_review",
  // `StartMultiReviewInput`, checked by `isStartMultiReviewInput`.
  Schema.Struct({
    environmentId: checked,
    projectId: checked,
    targetBranch: checked,
    reviewInstruction: checked,
    autoFix: checked,
    autoAddressFindings: checked,
    autoPr: checked,
    reviewers: checked,
    reviewModel: checked,
    fixModel: checked,
    addressFindingsModel: checked,
  }),
);

export const addressMultiReviewCommand = workflowCommand("address_multi_review", workflowArgs);

export const startMultiReviewCustomFixCommand = workflowCommand(
  "start_multi_review_custom_fix",
  // `StartMultiReviewCustomAddressFindingsInput`, checked by its guard.
  Schema.Struct({
    workflowId: checked,
    fixModel: checked,
    addressFindingsModel: checked,
    instruction: checked,
  }),
);

export const retryMultiReviewCommand = workflowCommand("retry_multi_review", workflowArgs);

export const recoverMultiReviewFixSessionCommand = workflowCommand(
  "recover_multi_review_fix_session",
  Schema.Struct({
    environmentId: Schema.String,
    tabId: Schema.String,
    expectedProviderSessionId: Schema.String,
    replacementProviderSessionId: Schema.String,
  }),
);

export const stopMultiReviewReviewerCommand = workflowCommand(
  "stop_multi_review_reviewer",
  reviewerArgs,
);

export const stopMultiReviewValidationCommand = workflowCommand(
  "stop_multi_review_validation",
  workflowArgs,
);

export const restartMultiReviewReviewerCommand = defineCommand({
  domain: multiReviewDomain,
  name: "restart_multi_review_reviewer",
  since: 1,
  access: "workspace",
  read: false,
  // `model` is "Restart in…" (`isMultiReviewModelSelection`).
  args: Schema.Struct({ workflowId: Schema.String, reviewerId: Schema.String, model: checked }),
  result: MultiReviewWorkflowSchema,
  critical: ["model"],
});

export const skipMultiReviewStepCommand = workflowCommand(
  "skip_multi_review_step",
  Schema.Struct({ workflowId: Schema.String, step: checked }),
);

export const previewMultiReviewCodeRewindCommand = defineCommand({
  domain: multiReviewDomain,
  name: "preview_multi_review_code_rewind",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ workflowId: Schema.String, step: checked }),
  result: CodeRewindPreviewSchema,
  critical: [],
});

export const rewindMultiReviewCodeCommand = workflowCommand(
  "rewind_multi_review_code",
  Schema.Struct({ workflowId: Schema.String, step: checked, expectedHead: Schema.String }),
);

export const restartMultiReviewStepCommand = defineCommand({
  domain: multiReviewDomain,
  name: "restart_multi_review_step",
  since: 1,
  access: "workspace",
  read: false,
  // `isRestartMultiReviewStepInput` checks the whole request; `model` is "Restart in…".
  args: Schema.Struct({ workflowId: checked, kind: checked, model: checked }),
  result: MultiReviewWorkflowSchema,
  critical: ["model"],
});

export const pauseMultiReviewStepCommand = workflowCommand(
  "pause_multi_review_step",
  stepControlArgs,
);

export const resumeMultiReviewStepCommand = workflowCommand(
  "resume_multi_review_step",
  stepControlArgs,
);

export const unstickMultiReviewReviewerCommand = workflowCommand(
  "unstick_multi_review_reviewer",
  reviewerArgs,
);

export const cancelMultiReviewCommand = workflowCommand("cancel_multi_review", workflowArgs);

export const deleteMultiReviewWorkflowCommand = defineCommand({
  domain: multiReviewDomain,
  name: "delete_multi_review_workflow",
  since: 1,
  access: "workspace",
  read: false,
  args: workflowArgs,
  result: Schema.Void,
  critical: [],
});

export const MULTI_REVIEW_COMMANDS = [
  startReviewValidationCommand,
  statusReviewValidationCommand,
  cancelReviewValidationCommand,
  stopReviewValidationCommandCommand,
  getReviewValidationOutputCommand,
  getMultiReviewWorkflowCommand,
  listMultiReviewWorkflowsCommand,
  getMultiReviewReviewerTranscriptCommand,
  getMultiReviewReviewerProjectionCommand,
  getMultiReviewStepTranscriptCommand,
  getMultiReviewStepToolDetailsCommand,
  getMultiReviewReviewerToolDetailsCommand,
  getMultiReviewReviewerHistoryPageCommand,
  startMultiReviewCommand,
  addressMultiReviewCommand,
  startMultiReviewCustomFixCommand,
  retryMultiReviewCommand,
  recoverMultiReviewFixSessionCommand,
  stopMultiReviewReviewerCommand,
  stopMultiReviewValidationCommand,
  restartMultiReviewReviewerCommand,
  skipMultiReviewStepCommand,
  previewMultiReviewCodeRewindCommand,
  rewindMultiReviewCodeCommand,
  restartMultiReviewStepCommand,
  pauseMultiReviewStepCommand,
  resumeMultiReviewStepCommand,
  unstickMultiReviewReviewerCommand,
  cancelMultiReviewCommand,
  deleteMultiReviewWorkflowCommand,
] as const;
