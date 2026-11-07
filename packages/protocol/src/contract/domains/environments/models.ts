/**
 * The environment model as the `environments` and `docker` commands answer it
 * (plan item 7003): the renderer-facing projection `ClientEnvironment` of
 * `apps/backend/src/core/models.ts`, field for field, and the shapes nested in
 * it. Plan item 7010 makes these the single definition the backend and the
 * renderer infer their types from.
 *
 * Rules (docs/architecture/version-compatibility.md#defining-commands-and-events):
 * numbers are `Schema.Finite` and the schemas are JSON-shaped. Optional
 * fields are `Schema.optional`, as in event payloads, not `optionalKey`: the
 * records a handler returns carry fields set to `undefined` (the model's
 * `field?: T`), which the wire drops but `optionalKey` refuses when results
 * are validated in development and tests. Arrays are `Schema.mutable` so the
 * inferred types stay assignable to today's mutable model types.
 *
 * A client decodes results tolerantly (unknown keys dropped), so every field a
 * caller reads is declared here; a field missing from the schema is a field
 * the renderer never sees. Every field an older backend may leave out is
 * optional, as in the model. A new literal in one of the vocabularies below
 * (status, platform, unread reason, deletion step, operation kind) is a change
 * an older client cannot decode, so it bumps the domain.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { AGENT_PLATFORMS, type AgentPlatform } from "../../../agent-platforms.js";
import type { AgentSettingsTier } from "../../../agent-settings.js";
import {
  CONTAINER_LIFECYCLE_ERROR_CODES,
  CONTAINER_OPERATION_KINDS,
} from "../../../container-lifecycle.js";
import { ENVIRONMENT_DELETION_STEPS } from "../../../node-summaries.js";
import { STARTUP_AGENT_TAB_ID } from "../../../tab-initial-prompt.js";

const optionalString = Schema.optional(Schema.String);
const optionalNullableString = Schema.optional(Schema.NullOr(Schema.String));
const optionalBoolean = Schema.optional(Schema.Boolean);
const optionalNumber = Schema.optional(Schema.Finite);
/**
 * A port the backend clears by writing `null`. Storage normalises it to
 * absent, but a record that bypassed it (an older backend's, a fixture's)
 * still reads, so `null` is accepted.
 */
const optionalPort = Schema.optional(Schema.NullOr(Schema.Finite));

/** A mutable array of `item`, so the inferred type matches the models' `T[]`. */
export function mutableArray<S extends Schema.Top>(item: S) {
  return Schema.mutable(Schema.Array(item));
}

/**
 * An object owned by another domain's model, decoded as an object and typed
 * as `T`. Used only where the owning domain has no schema yet (the agent
 * settings tier belongs to `config`); that domain's schema replaces it.
 */
export function ownedObject<T extends object>(): Schema.Codec<T> {
  return Schema.ObjectKeyword as unknown as Schema.Codec<T>;
}

export const AgentPlatformSchema = Schema.Literals(
  AGENT_PLATFORMS as unknown as readonly [AgentPlatform, ...AgentPlatform[]],
);

export const EnvironmentStatusSchema = Schema.Literals([
  "running",
  "stopped",
  "error",
  "creating",
  "stopping",
]);
export type EnvironmentStatus = typeof EnvironmentStatusSchema.Type;

export const PrStateSchema = Schema.Literals(["open", "merged", "closed"]);
export type PrState = typeof PrStateSchema.Type;

export const NetworkAccessModeSchema = Schema.Literals(["full", "restricted"]);
export type NetworkAccessMode = typeof NetworkAccessModeSchema.Type;

export const EnvironmentTypeSchema = Schema.Literals(["containerized", "local"]);
export type EnvironmentType = typeof EnvironmentTypeSchema.Type;

export const EnvironmentLifecycleOperationSchema = Schema.Literals([
  "deleting",
  "merging",
  "moving",
]);
export type EnvironmentLifecycleOperation = typeof EnvironmentLifecycleOperationSchema.Type;

export const EnvironmentSetupPhaseSchema = Schema.Literals([
  "pending",
  "running",
  "ready",
  "failed",
]);
export type EnvironmentSetupPhase = typeof EnvironmentSetupPhaseSchema.Type;

export const PortProtocolSchema = Schema.Literals(["tcp", "udp"]);
export type PortProtocol = typeof PortProtocolSchema.Type;

/**
 * Content-free cause of an environment's unread badge.
 *
 * - `agent_finished`: an agent turn ended.
 * - `agent_failed`: an agent turn ended with the provider's terminal error
 *   (a refused login, a provider error, a restart mid-turn), not an answer.
 * - `agent_ready`: no longer recorded; rows written before the readiness bell
 *   was retired may still carry it (the composer was free while background
 *   work continued).
 * - `agent_waiting`: an agent stopped to wait on the user (approval, plan, prompt).
 * - `agent_question`: an agent asked a question that needs an answer.
 * - `terminal_finished`: a terminal-hosted agent finished.
 * - `marked_unread`: a client marked the environment unread.
 * - `setup_approval`: a local environment's setup commands differ from what
 *   this machine trusts and wait for the user to approve them.
 */
export const EnvironmentUnreadReasonSchema = Schema.Literals([
  "agent_finished",
  "agent_failed",
  "agent_ready",
  "agent_waiting",
  "agent_question",
  "terminal_finished",
  "marked_unread",
  "setup_approval",
]);
export type EnvironmentUnreadReason = typeof EnvironmentUnreadReasonSchema.Type;

export const AgentActivityStateSchema = Schema.Literals(["idle", "working", "waiting"]);

export const GitHubPullRequestMergeabilitySchema = Schema.Literals([
  "clean",
  "blocked",
  "dirty",
  "behind",
  "unstable",
  "unknown",
  "unavailable",
]);

export const EnvironmentDeletionStepSchema = Schema.Literals(ENVIRONMENT_DELETION_STEPS);

export const PortMappingSchema = Schema.Struct({
  containerPort: Schema.Finite,
  hostPort: Schema.Finite,
  protocol: PortProtocolSchema,
  hostPortMode: Schema.optional(Schema.Literal("auto")),
});
export type PortMapping = typeof PortMappingSchema.Type;

export const WorktreeMoveRecordSchema = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  staging: optionalString,
  phase: Schema.Literals(["moving", "copied", "committed"]),
  fromCanonical: optionalString,
  fromRoot: optionalString,
  removeSource: optionalBoolean,
  sourceIdentity: Schema.optional(Schema.Struct({ dev: Schema.Finite, ino: Schema.Finite })),
  sourceCleaned: optionalBoolean,
  submodules: Schema.optional(
    mutableArray(Schema.Struct({ path: Schema.String, gitDir: Schema.String })),
  ),
  startedAt: Schema.String,
});

export const EnvironmentDiffBaselineSchema = Schema.Struct({
  createdFromCommit: Schema.String,
  commit: Schema.String,
});

export const EnvironmentDiffBaseOverrideSchema = Schema.Struct({
  ref: Schema.String,
  commit: Schema.String,
  subject: optionalString,
});

/** `@orkestrator/protocol/container-resources` `ContainerResourceLimits`. */
export const ContainerResourceLimitsSchema = Schema.Struct({
  cpus: Schema.NullOr(Schema.Finite),
  memoryMiB: Schema.NullOr(Schema.Finite),
  pids: Schema.NullOr(Schema.Finite),
});

export const ContainerOperationKindSchema = Schema.Literals(
  CONTAINER_OPERATION_KINDS as readonly [
    (typeof CONTAINER_OPERATION_KINDS)[number],
    ...(typeof CONTAINER_OPERATION_KINDS)[number][],
  ],
);

export const ContainerOperationStatusSchema = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "needs-attention",
]);

export const ContainerBootPhaseSchema = Schema.Literals([
  "starting",
  "initializing",
  "ready",
  "failed",
  "draining",
  "stopped",
]);

/** `ContainerOperationOutcome`: `failureCode` is the content-free failure category. */
export const ContainerOperationOutcomeSchema = Schema.Struct({
  operationId: Schema.String,
  kind: ContainerOperationKindSchema,
  status: ContainerOperationStatusSchema,
  completedAt: Schema.String,
  failureCode: Schema.optional(
    Schema.Literals([...CONTAINER_LIFECYCLE_ERROR_CODES, "interrupted", "setup-failed", "unknown"]),
  ),
  durationMs: optionalNumber,
  phases: Schema.optional(mutableArray(Schema.Struct({ phase: Schema.String, ms: Schema.Finite }))),
});

/** `ContainerLifecycleSnapshot`, the safe projection of the durable record. */
export const ContainerLifecycleSnapshotSchema = Schema.Struct({
  revision: Schema.Finite,
  supported: Schema.Boolean,
  runtimeGeneration: Schema.NullOr(Schema.Finite),
  imageId: Schema.NullOr(Schema.String),
  storageFormat: Schema.Literals(["legacy-layer", "volume-v1"]),
  workspaceGeneration: Schema.Finite,
  operation: Schema.NullOr(
    Schema.Struct({
      operationId: Schema.String,
      kind: ContainerOperationKindSchema,
      status: ContainerOperationStatusSchema,
      phase: Schema.String,
      startedAt: Schema.String,
      updatedAt: Schema.String,
      failureCode: Schema.NullOr(Schema.String),
    }),
  ),
  lastOutcome: Schema.NullOr(ContainerOperationOutcomeSchema),
  bootPhase: Schema.NullOr(ContainerBootPhaseSchema),
}).annotate({ identifier: "ContainerLifecycleSnapshot" });

export const StartupAgentSessionSnapshotSchema = Schema.Struct({
  tabId: Schema.Literal(STARTUP_AGENT_TAB_ID),
  agent: AgentPlatformSchema,
  style: Schema.Literals(["terminal", "native"]),
  model: optionalString,
  reasoningEffort: optionalString,
  providerSessionId: optionalString,
  status: Schema.Literals(["starting", "running", "error"]),
  startedAt: optionalString,
  error: optionalString,
});

/** `InitialPromptImageAttachment`. */
export const InitialPromptAttachmentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.optional(Schema.Literals(["image", "file"])),
  previewUrl: optionalString,
  base64Data: Schema.String,
});

/** The agent settings tier; owned by the `config` domain (see {@link ownedObject}). */
export const AgentSettingsTierSchema = ownedObject<AgentSettingsTier>();

/**
 * The fields of `ClientEnvironment` (`models.ts`): the stored `Environment`
 * without its backend-private fields, with the lifecycle snapshot in place of
 * the durable record.
 */
export const clientEnvironmentFields = {
  stopGeneration: optionalNumber,
  id: Schema.String,
  projectId: Schema.String,
  buildPipelineId: optionalString,
  deletionRequestedAt: optionalString,
  cleanupAfterMergeRequestedAt: optionalString,
  cleanupAfterMergeError: optionalString,
  deletionError: optionalString,
  deletionStep: Schema.optional(EnvironmentDeletionStepSchema),
  containerLifecycle: Schema.optional(ContainerLifecycleSnapshotSchema),
  containerResourceLimits: Schema.optional(ContainerResourceLimitsSchema),
  lifecycleOperation: Schema.optional(EnvironmentLifecycleOperationSchema),
  lifecycleOperationStartedAt: optionalString,
  lifecycleError: optionalNullableString,
  name: Schema.String,
  branch: Schema.String,
  containerId: Schema.NullOr(Schema.String),
  status: EnvironmentStatusSchema,
  prUrl: Schema.NullOr(Schema.String),
  prBaseBranch: optionalNullableString,
  prState: Schema.NullOr(PrStateSchema),
  hasMergeConflicts: Schema.NullOr(Schema.Boolean),
  prMergeability: Schema.optional(Schema.NullOr(GitHubPullRequestMergeabilitySchema)),
  autoMerge: optionalBoolean,
  autoMergeCleanup: optionalBoolean,
  autoMergePrUrl: optionalNullableString,
  autoMergeEnabledAt: optionalNullableString,
  autoMergeError: optionalNullableString,
  autoMergeResolveRequestId: optionalString,
  autoMergeResolveCompletedAt: optionalString,
  autoMergeResolveAttempts: optionalNumber,
  createdAt: Schema.String,
  lastActivityAt: optionalString,
  agentSessionCompletedAt: optionalString,
  agentActivityState: Schema.optional(AgentActivityStateSchema),
  agentActivityUpdatedAt: optionalString,
  createdFromCommit: optionalString,
  diffBaseline: Schema.optional(Schema.NullOr(EnvironmentDiffBaselineSchema)),
  diffBaseOverride: Schema.optional(Schema.NullOr(EnvironmentDiffBaseOverrideSchema)),
  delegationBaseBranch: optionalString,
  delegationBaseCommit: optionalString,
  networkAccessMode: NetworkAccessModeSchema,
  allowedDomains: Schema.optional(mutableArray(Schema.String)),
  revokedInputProviders: Schema.optional(mutableArray(AgentPlatformSchema)),
  order: Schema.Finite,
  portMappings: Schema.optional(mutableArray(PortMappingSchema)),
  entryPort: optionalPort,
  hostEntryPort: optionalPort,
  environmentType: EnvironmentTypeSchema,
  worktreePath: optionalString,
  worktreeBaseDir: optionalString,
  worktreeMove: Schema.optional(WorktreeMoveRecordSchema),
  projectHome: optionalBoolean,
  localOpencodePort: optionalPort,
  localClaudePort: optionalPort,
  localCodexPort: optionalPort,
  localCursorPort: optionalPort,
  localGrokPort: optionalPort,
  localPiPort: optionalPort,
  agentSettings: Schema.optional(AgentSettingsTierSchema),
  setupScriptsComplete: optionalBoolean,
  setupPhase: Schema.optional(EnvironmentSetupPhaseSchema),
  setupOverride: optionalBoolean,
  setupApprovalRequired: optionalBoolean,
  setupSessionId: optionalString,
  setupStartedAt: optionalString,
  setupCompletedAt: optionalString,
  hasUnreadWork: optionalBoolean,
  unreadReason: Schema.optional(EnvironmentUnreadReasonSchema),
  agentAttentionKeys: Schema.optional(mutableArray(Schema.String)),
  pendingAgentLaunch: optionalBoolean,
  initialAgentPlatform: Schema.optional(AgentPlatformSchema),
  initialAgentModel: optionalString,
  initialReasoningEffort: optionalString,
  initialFastMode: optionalBoolean,
  initialPrompt: optionalString,
  startupAgentSession: Schema.optional(StartupAgentSessionSnapshotSchema),
  hasInitialPromptAttachments: optionalBoolean,
} as const;

/** `ClientEnvironment`: what every environment list and mutation answers. */
export const ClientEnvironmentSchema = Schema.Struct(clientEnvironmentFields).annotate({
  identifier: "ClientEnvironment",
});
export type ClientEnvironment = typeof ClientEnvironmentSchema.Type;

/**
 * One environment as `get_environment` reads it: the stored record, of which
 * clients read the client fields plus the launch details the list projection
 * strips (the attachments and the conversation mode). The durable lifecycle
 * record is backend-private and not described; clients read the snapshot
 * through `get_container_lifecycle_snapshot`.
 */
export const EnvironmentDetailSchema = Schema.Struct({
  ...clientEnvironmentFields,
  containerLifecycle: Schema.optional(Schema.ObjectKeyword),
  initialConversationMode: Schema.optional(Schema.Literals(["plan", "build"])),
  initialPromptAttachments: Schema.optional(mutableArray(InitialPromptAttachmentSchema)),
}).annotate({ identifier: "EnvironmentDetail" });
export type EnvironmentDetail = typeof EnvironmentDetailSchema.Type;

/** `@orkestrator/protocol/pr-monitor` `PrCheckSummary`. */
export const PrCheckSummarySchema = Schema.Struct({
  passed: Schema.Finite,
  total: Schema.Finite,
  pending: Schema.Finite,
  requiredFailed: optionalNumber,
});

/** What a node summary relays about an environment's PR monitor (`RelayedPrMonitorHealth`). */
export const RelayedPrMonitorHealthSchema = Schema.Struct({
  prMonitorConfirmed: Schema.optional(Schema.Literal(true)),
  prViewerCanMerge: optionalBoolean,
  prCheckSummary: Schema.optional(PrCheckSummarySchema),
});

/**
 * One row of `get_environment_snapshots`: the client environment, plus, for
 * a node summary read (`includePrMonitorHealth`), the machine's Docker
 * availability, the relayed PR monitor health, the build pipeline markers and
 * the agent-mail badge.
 */
export const EnvironmentSnapshotRowSchema = Schema.Struct({
  ...clientEnvironmentFields,
  ...RelayedPrMonitorHealthSchema.fields,
  dockerAvailable: optionalBoolean,
  buildPipeline: Schema.optional(Schema.Literal(true)),
  buildActive: Schema.optional(Schema.Literal(true)),
  agentMailUnread: optionalNumber,
  agentMailFailed: Schema.optional(Schema.Literal(true)),
}).annotate({ identifier: "EnvironmentSnapshotRow" });
export type EnvironmentSnapshotRow = typeof EnvironmentSnapshotRowSchema.Type;

/**
 * A setup start's answer (`ClientEnvironmentSetupStartResult`): whether setup
 * started in a backend terminal, its session, and the environment after it.
 */
export const EnvironmentSetupStartResultSchema = Schema.Struct({
  setupStarted: Schema.Boolean,
  setupSessionId: optionalString,
  environment: ClientEnvironmentSchema,
});
export type EnvironmentSetupStartResult = typeof EnvironmentSetupStartResultSchema.Type;
