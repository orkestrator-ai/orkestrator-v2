/**
 * `kanban` commands (plan item 7008): a project's Kanban tickets with their
 * comments, images and acceptance-criterion checks, project notes, feature
 * plans and the backend-owned planning exchange, and the machine's Linear
 * connection.
 *
 * Argument schemas declare every key the handler reads and decode tolerantly
 * (§11.4). A key the handler required with `asString`/`asNonBlankString` is
 * `Schema.String` (same "Expected taskId to be a string" text; the blank check
 * stays in the handler); a key it reads leniently (`typeof … === "string"`) or
 * checks with its own message (`requestId`, `sections`, `checks`, `updates`,
 * `role`, `kind`, the conditional-read pair) stays `optionalKey(Unknown)`, so
 * nothing an older client sends is refused and every message is unchanged.
 *
 * Kanban ticket ids are the same on every node (a leaf's copy of a command
 * node's ticket keeps its id), so these results are node-scoped: a client
 * keeps them under the node it asked.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { kanbanDomain } from "./domain.js";
import {
  FeaturePlanBuildClaimSchema,
  FeaturePlanListSchema,
  FeaturePlanningRecordSchema,
  FeaturePlanSchema,
  KanbanLabelCreateResultSchema,
  KanbanMergeClosureResultSchema,
  KanbanTaskListSchema,
  KanbanTaskSchema,
  LinearCompletionCommentResultSchema,
  LinearConnectionStatusSchema,
  LinearIssueCommentSchema,
  LinearIssueDetailSchema,
  LinearIssueListItemSchema,
  ProjectNotesSchema,
  snapshotRead,
  TicketLabelSummaryListSchema,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/** The conditional-read pair (`conditionalManifestSnapshot`), checked by the handler together. */
const conditionalReadFields = {
  knownManifestGeneration: optionalUnknown,
  knownResourceRevision: optionalUnknown,
};

/** Ticket content (`asTicketContentInput`): checked with their own messages. */
const ticketContentFields = {
  kind: optionalUnknown,
  markdown: optionalUnknown,
  sections: optionalUnknown,
};

// --- Tickets ------------------------------------------------------------------

/** A project's tickets on this node, or the conditional answer. */
export const getKanbanTasksCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_kanban_tasks",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String, ...conditionalReadFields }),
  result: snapshotRead(KanbanTaskListSchema),
  critical: [],
});

/**
 * Creates a ticket. `description` may be left out when `markdown` or
 * `sections` carry the content. `requestId` makes a retry return the first
 * ticket.
 */
export const addKanbanTaskCommand = defineCommand({
  domain: kanbanDomain,
  name: "add_kanban_task",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    requestId: optionalUnknown,
    ...ticketContentFields,
    acceptanceCriteria: optionalUnknown,
    status: optionalUnknown,
    projectId: Schema.String,
    title: Schema.String,
    description: optionalUnknown,
    labels: optionalUnknown,
  }),
  result: KanbanTaskSchema,
  critical: ["requestId", "markdown", "sections", "labels"],
});

/** Updates a ticket's fields and content; a field left out is unchanged. */
export const updateKanbanTaskCommand = defineCommand({
  domain: kanbanDomain,
  name: "update_kanban_task",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    taskId: Schema.String,
    ...ticketContentFields,
    title: optionalUnknown,
    description: optionalUnknown,
    acceptanceCriteria: optionalUnknown,
    status: optionalUnknown,
    environmentId: optionalUnknown,
    buildPipelineId: optionalUnknown,
    prUrl: optionalUnknown,
    prState: optionalUnknown,
    prMergeCommented: optionalUnknown,
    labels: optionalUnknown,
    preserveDoneStatus: optionalUnknown,
  }),
  result: KanbanTaskSchema,
  critical: ["markdown", "sections", "labels", "preserveDoneStatus"],
});

/** Writes Verify results onto the ticket's criteria; `null` when the ticket is gone. */
export const recordKanbanCriteriaChecksCommand = defineCommand({
  domain: kanbanDomain,
  name: "record_kanban_criteria_checks",
  since: 1,
  access: "workspace",
  read: false,
  // `checks` items stay strict in the handler: a value, not argument keys.
  args: Schema.Struct({ taskId: Schema.String, checks: optionalUnknown }),
  result: Schema.NullOr(KanbanTaskSchema),
  critical: [],
});

/**
 * Moves a ticket whose pull request merged to done, once per pull request
 * (`kanban-merge-closure.ts`). The build pipeline's terminal lifecycle calls
 * it in process.
 */
export const closeKanbanTaskForMergedPrCommand = defineCommand({
  domain: kanbanDomain,
  name: "close_kanban_task_for_merged_pr",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ taskId: Schema.String, prUrl: Schema.String }),
  result: KanbanMergeClosureResultSchema,
  critical: [],
});

/** The labels a project offers: its catalogue plus every name a ticket carries. */
export const getKanbanLabelsCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_kanban_labels",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String }),
  result: TicketLabelSummaryListSchema,
  critical: [],
});

/**
 * Adds a label to a project's catalogue; an existing name (any case) is kept
 * and takes the colour or description given. The values are checked by the
 * handler (`parseKanbanLabelInput`) with its own messages.
 */
export const createKanbanLabelCommand = defineCommand({
  domain: kanbanDomain,
  name: "create_kanban_label",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    name: optionalUnknown,
    color: optionalUnknown,
    description: optionalUnknown,
  }),
  result: KanbanLabelCreateResultSchema,
  critical: [],
});

/**
 * Adds one label to a ticket, or removes it with `present: false`.
 * `projectId` refuses a ticket of another project with the same id.
 */
export const setKanbanTaskLabelCommand = defineCommand({
  domain: kanbanDomain,
  name: "set_kanban_task_label",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    taskId: Schema.String,
    name: Schema.String,
    present: optionalUnknown,
    projectId: optionalUnknown,
  }),
  result: KanbanTaskSchema,
  critical: ["projectId"],
});

export const deleteKanbanTaskCommand = defineCommand({
  domain: kanbanDomain,
  name: "delete_kanban_task",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ taskId: Schema.String }),
  result: Schema.Void,
  critical: [],
});

/**
 * Adds a comment. `projectId` refuses a ticket of another project with the
 * same id; `requestId` makes a retry add nothing new.
 */
export const addKanbanCommentCommand = defineCommand({
  domain: kanbanDomain,
  name: "add_kanban_comment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    requestId: optionalUnknown,
    taskId: Schema.String,
    text: Schema.String,
    projectId: optionalUnknown,
  }),
  result: KanbanTaskSchema,
  critical: ["requestId", "projectId"],
});

export const deleteKanbanCommentCommand = defineCommand({
  domain: kanbanDomain,
  name: "delete_kanban_comment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ taskId: Schema.String, commentId: Schema.String }),
  result: KanbanTaskSchema,
  critical: [],
});

/** Stores an image (base64 `data`, converted to WebP) on a ticket. */
export const addKanbanImageCommand = defineCommand({
  domain: kanbanDomain,
  name: "add_kanban_image",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ taskId: Schema.String, filename: Schema.String, data: Schema.String }),
  result: KanbanTaskSchema,
  critical: [],
});

export const deleteKanbanImageCommand = defineCommand({
  domain: kanbanDomain,
  name: "delete_kanban_image",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ taskId: Schema.String, imageId: Schema.String }),
  result: KanbanTaskSchema,
  critical: [],
});

/** A ticket image's bytes, base64-encoded WebP. */
export const getKanbanImageDataCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_kanban_image_data",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ imageId: Schema.String }),
  result: Schema.String,
  critical: [],
});

// --- Project notes --------------------------------------------------------------

export const getProjectNotesCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_project_notes",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String, ...conditionalReadFields }),
  result: snapshotRead(ProjectNotesSchema),
  critical: [],
});

export const saveProjectNotesCommand = defineCommand({
  domain: kanbanDomain,
  name: "save_project_notes",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: Schema.String, content: Schema.String }),
  result: ProjectNotesSchema,
  critical: [],
});

// --- Feature plans --------------------------------------------------------------

export const getFeaturePlansCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_feature_plans",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String, ...conditionalReadFields }),
  result: snapshotRead(FeaturePlanListSchema),
  critical: [],
});

export const createFeaturePlanCommand = defineCommand({
  domain: kanbanDomain,
  name: "create_feature_plan",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: Schema.String }),
  result: FeaturePlanSchema,
  critical: [],
});

/** `updates` stays strict in the handler (`asFeaturePlanUpdates`): a value, not argument keys. */
export const updateFeaturePlanCommand = defineCommand({
  domain: kanbanDomain,
  name: "update_feature_plan",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ featureId: Schema.String, updates: optionalUnknown }),
  result: FeaturePlanSchema,
  critical: [],
});

/** Reserves the plan's build for `taskId` (renderers before `start_feature_plan_build`). */
export const claimFeaturePlanBuildCommand = defineCommand({
  domain: kanbanDomain,
  name: "claim_feature_plan_build",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ featureId: Schema.String, taskId: Schema.String }),
  result: FeaturePlanBuildClaimSchema,
  critical: [],
});

const planMessageFields = {
  role: optionalUnknown,
  content: Schema.String,
  stateApplication: optionalUnknown,
  modelId: optionalUnknown,
};

export const appendFeaturePlanMessageCommand = defineCommand({
  domain: kanbanDomain,
  name: "append_feature_plan_message",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ featureId: Schema.String, ...planMessageFields }),
  result: FeaturePlanSchema,
  critical: [],
});

export const appendFeatureStoryMessageCommand = defineCommand({
  domain: kanbanDomain,
  name: "append_feature_story_message",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ featureId: Schema.String, storyId: Schema.String, ...planMessageFields }),
  result: FeaturePlanSchema,
  critical: [],
});

// --- Backend-owned planning -------------------------------------------------------

/** Hands the user's message to the planning supervisor; returns the attached record. */
export const startFeaturePlanningCommand = defineCommand({
  domain: kanbanDomain,
  name: "start_feature_planning",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    operationId: optionalUnknown,
    featureId: Schema.String,
    kind: optionalUnknown,
    storyId: optionalUnknown,
    userMessage: Schema.String,
  }),
  result: FeaturePlanningRecordSchema,
  critical: ["operationId"],
});

export const retryFeaturePlanningCommand = defineCommand({
  domain: kanbanDomain,
  name: "retry_feature_planning",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ featureId: Schema.String }),
  result: FeaturePlanningRecordSchema,
  critical: [],
});

export const cancelFeaturePlanningCommand = defineCommand({
  domain: kanbanDomain,
  name: "cancel_feature_planning",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ featureId: Schema.String }),
  result: Schema.Void,
  critical: [],
});

// --- Linear ---------------------------------------------------------------------

/** The stored Linear key's state, verified against Linear. Never returns the key. */
export const getLinearConnectionCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_linear_connection",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: LinearConnectionStatusSchema,
  critical: [],
});

export const connectLinearCommand = defineCommand({
  domain: kanbanDomain,
  name: "connect_linear",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ apiKey: Schema.String }),
  result: LinearConnectionStatusSchema,
  critical: [],
});

export const disconnectLinearCommand = defineCommand({
  domain: kanbanDomain,
  name: "disconnect_linear",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({}),
  result: LinearConnectionStatusSchema,
  critical: [],
});

export const getLinearIssuesCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_linear_issues",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: Schema.mutable(Schema.Array(LinearIssueListItemSchema)),
  critical: [],
});

export const getLinearIssueCommand = defineCommand({
  domain: kanbanDomain,
  name: "get_linear_issue",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ issueId: Schema.String }),
  result: LinearIssueDetailSchema,
  critical: [],
});

export const postLinearIssueCommentCommand = defineCommand({
  domain: kanbanDomain,
  name: "post_linear_issue_comment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ issueId: Schema.String, body: Schema.String }),
  result: LinearIssueCommentSchema,
  critical: [],
});

/** Posts a pipeline's completion comment once per pipeline (`pipelineId` is the guard). */
export const postLinearCompletionCommentCommand = defineCommand({
  domain: kanbanDomain,
  name: "post_linear_completion_comment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ pipelineId: Schema.String, issueId: Schema.String, body: Schema.String }),
  result: LinearCompletionCommentResultSchema,
  critical: [],
});

/** Every `kanban` command. */
export const KANBAN_COMMANDS = [
  getKanbanTasksCommand,
  addKanbanTaskCommand,
  updateKanbanTaskCommand,
  recordKanbanCriteriaChecksCommand,
  closeKanbanTaskForMergedPrCommand,
  getKanbanLabelsCommand,
  createKanbanLabelCommand,
  setKanbanTaskLabelCommand,
  deleteKanbanTaskCommand,
  addKanbanCommentCommand,
  deleteKanbanCommentCommand,
  addKanbanImageCommand,
  deleteKanbanImageCommand,
  getKanbanImageDataCommand,
  getProjectNotesCommand,
  saveProjectNotesCommand,
  getFeaturePlansCommand,
  createFeaturePlanCommand,
  updateFeaturePlanCommand,
  claimFeaturePlanBuildCommand,
  appendFeaturePlanMessageCommand,
  appendFeatureStoryMessageCommand,
  startFeaturePlanningCommand,
  retryFeaturePlanningCommand,
  cancelFeaturePlanningCommand,
  getLinearConnectionCommand,
  connectLinearCommand,
  disconnectLinearCommand,
  getLinearIssuesCommand,
  getLinearIssueCommand,
  postLinearIssueCommentCommand,
  postLinearCompletionCommentCommand,
] as const;
