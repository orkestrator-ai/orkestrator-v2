/**
 * Result schemas of the controller part of the `coordinator` domain (plan
 * item 7009): Control MCP settings, native agent jobs, a command node's
 * coordinator acting on a node (`*_coordinator_node_*`) and the
 * controller-facing commands that run that work on the node
 * (`*_controller_*`).
 *
 * Model-shaped records are **open structs** ({@link openRecord}): the listed
 * fields are checked and typed, and every other key the backend sends is
 * kept, because a domain client decodes results tolerantly and a closed
 * `Schema.Struct` would strip the fields a record carries beyond those
 * listed. The listed fields are the ones callers route on. Fields are
 * optional unless the handler writes them on every path, and values a newer
 * backend may extend (statuses, phases, outcomes) are `Schema.String`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { openRecord } from "../../model-schema.js";

const optionalString = Schema.optional(Schema.String);
const optionalBoolean = Schema.optional(Schema.Boolean);
const optionalFinite = Schema.optional(Schema.Finite);

/** One named operator credential as Settings → MCP shows it (with its token, for Copy setup). */
export const ControlMcpCredentialSummarySchema = openRecord({
  id: Schema.String,
  label: Schema.String,
  profile: Schema.String,
  capabilities: Schema.Array(Schema.String),
  deniedActions: Schema.Array(Schema.String),
  token: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});

/** The Control MCP listener and every operator credential. */
export const ControlMcpSettingsSchema = openRecord({
  enabled: Schema.Boolean,
  running: Schema.Boolean,
  url: Schema.String,
  /** The `default` credential's token, for clients set up before named credentials. */
  token: Schema.String,
  error: Schema.NullOr(Schema.String),
  /** Absent from a backend that predates named credentials (the web reads it as none). */
  credentials: Schema.optional(Schema.Array(ControlMcpCredentialSummarySchema)),
});

/**
 * A native agent job: the tab and session it landed in and how the provider
 * took the prompt (`accepted`, `unknown`, `rejected`), or `skipped` when an
 * auto-merge launch is no longer authorised. A resend to an open tab spreads
 * that tab's answer.
 */
export const NativeAgentJobLaunchResultSchema = openRecord({
  status: Schema.String,
  jobId: optionalString,
  environmentId: optionalString,
  tabId: optionalString,
  agent: optionalString,
  logicalSessionKey: optionalString,
  error: optionalString,
  /** A `rejected` launch the provider refused temporarily, nothing sent: a new request id may succeed. */
  transient: optionalBoolean,
  completionActionArmed: optionalBoolean,
  warning: optionalString,
});

/** An environment record as a node answers it: its id and the fields callers route on. */
export const ControllerEnvironmentSchema = openRecord({
  id: Schema.String,
  projectId: optionalString,
  name: optionalString,
  branch: optionalString,
  status: optionalString,
  environmentType: optionalString,
  delegationBaseBranch: optionalString,
  delegationBaseCommit: optionalString,
});

/** A workflow snapshot (build pipeline or Multi Review): its id and where it runs. */
export const ControllerWorkflowSnapshotSchema = openRecord({
  id: Schema.String,
  projectId: optionalString,
  environmentId: optionalString,
  phase: optionalString,
  coordinatorLaunchId: optionalString,
  backendRevision: optionalFinite,
  /** Set by the command node when the build's ticket could not record its location. */
  warning: optionalString,
  /** The request had already run: this is its workflow. */
  replayed: optionalBoolean,
});

/** Where a Multi Review's tab was opened, or why it could not be. */
export const MultiReviewActionUiSchema = openRecord({
  status: Schema.String,
  tabId: optionalString,
  paneId: optionalString,
  layoutRevision: optionalFinite,
});

/** The Multi Review button's answer (`MultiReviewActionResult`, `@orkestrator/protocol/multi-review`). */
export const MultiReviewActionResultSchema = openRecord({
  workflow: ControllerWorkflowSnapshotSchema,
  outcome: Schema.String,
  reused: optionalBoolean,
  ui: Schema.optional(MultiReviewActionUiSchema),
  recovery: optionalString,
  replayed: optionalBoolean,
});

/** One Multi Review row: a platform, a model id (or `default`) and its options. */
const MultiReviewLaunchRowSchema = openRecord({
  agent: Schema.String,
  model: Schema.String,
  reasoningEffort: optionalString,
  fastMode: optionalBoolean,
});

/**
 * What a plain Multi Review click on an environment runs: every row resolved
 * by the environment's node from its saved settings and its own model
 * catalogue. The configure dialog opens on exactly this.
 */
export const MultiReviewLaunchDefaultsSchema = openRecord({
  reviewers: Schema.Array(MultiReviewLaunchRowSchema),
  reviewModel: MultiReviewLaunchRowSchema,
  fixModel: MultiReviewLaunchRowSchema,
  autoFix: Schema.Boolean,
  autoPr: Schema.Boolean,
});

/** A worker surface opened or edited on a node (a terminal, browser tab or tab edit). */
export const WorkerSurfaceResultSchema = openRecord({
  environmentId: optionalString,
  tabId: optionalString,
  tabType: optionalString,
  status: optionalString,
  url: optionalString,
  ui: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

/** A worker action receipt (a pull request or a conflict resolution started on a worker). */
export const WorkerActionResultSchema = openRecord({
  status: optionalString,
  environmentId: optionalString,
  tabId: optionalString,
  replayed: optionalBoolean,
});

/** A fork made on the node owning the source worker, for a command node's coordinator. */
export const ControllerForkResultSchema = openRecord({
  environment: ControllerEnvironmentSchema,
  agent: Schema.NullOr(Schema.String),
});

/** A coordinator's fork of one of its workers, here or on another node. */
export const CoordinatorForkResultSchema = openRecord({
  environmentId: optionalString,
  name: optionalString,
  branch: optionalString,
  environmentType: optionalString,
  baseBranch: optionalString,
  baseCommit: optionalString,
  forkedFromEnvironmentId: optionalString,
  nodeId: optionalString,
  status: optionalString,
  tabId: optionalString,
  agent: Schema.optional(Schema.NullOr(Schema.String)),
  coordinatorDelegationOpened: optionalBoolean,
  startError: optionalString,
  replayed: optionalBoolean,
});

/** A worker's changes since its base: summaries, commits and bounded diffs. */
export const WorkerChangesSchema = openRecord({
  environmentId: optionalString,
  name: optionalString,
  environmentType: optionalString,
  status: optionalString,
  branch: optionalString,
  base: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  commits: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  sinceBase: Schema.optional(Schema.Unknown),
  committed: Schema.optional(Schema.Unknown),
  uncommitted: Schema.optional(Schema.Unknown),
  truncated: optionalBoolean,
  unavailable: optionalString,
  /** Added by the command node when the worker's node predates `diffScope`. */
  diffScopeUnsupported: optionalString,
});

/** A worker environment launched on a node by a command node's coordinator. */
export const CoordinatorNodeLaunchResultSchema = openRecord({
  environment: Schema.Unknown,
  coordinatorDelegationOpened: Schema.Boolean,
  replayed: optionalBoolean,
  startError: optionalString,
});

/** A check that passed (a failed check throws). */
export const AllowedSchema = Schema.Struct({ allowed: Schema.Boolean });
export const AvailableSchema = Schema.Struct({ available: Schema.Boolean });

/** Whether a delegation to a worker on a node was opened. */
export const OpenedSchema = Schema.Struct({ opened: Schema.Boolean });

/** Mail sent to an agent or the coordinator on a node, as the coordinator is told. */
export const CoordinatorNodeMailResultSchema = openRecord({
  nodeId: optionalString,
  node: optionalString,
  messageId: optionalString,
  toEnvironmentId: optionalString,
  toTabId: optionalString,
  placement: optionalString,
  coordinatorDelegationOpened: optionalBoolean,
  deliveryNote: optionalString,
});

/** Who on that node's copy of the project can be mailed. */
export const CoordinatorNodeMailboxSchema = openRecord({
  coordinator: openRecord({
    reachable: Schema.Boolean,
    address: optionalString,
    reason: optionalString,
  }),
  workers: Schema.optional(Schema.Unknown),
});

/** A file transfer's receipt, with the coordinator's named endpoints. */
export const AttachmentTransferResultSchema = openRecord({
  status: Schema.String,
  from: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  to: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  files: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});
