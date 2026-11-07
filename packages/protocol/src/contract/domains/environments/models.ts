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
import type { DeepMutable, Mutable } from "effect/Types";
import { AgentPlatformSchema, AgentSettingsTierSchema } from "../config/agent-settings.js";
import { mutableArray } from "../../model-schema.js";
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

/** The platform vocabulary and the agent settings tier are the `config` domain's. */
export { AgentPlatformSchema, AgentSettingsTierSchema } from "../config/agent-settings.js";

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
/** `PortMapping`: the model type `models.ts` and the web's types re-export (plan item 7010). */
export type PortMapping = Mutable<typeof PortMappingSchema.Type>;

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
/** `WorktreeMoveRecord`: durable progress of an environment move (`models.ts` re-exports it). */
export type WorktreeMoveRecord = DeepMutable<typeof WorktreeMoveRecordSchema.Type>;
/** A submodule whose git dir lives outside the worktree; a copy re-links each one. */
export type WorktreeMoveSubmodule = NonNullable<WorktreeMoveRecord["submodules"]>[number];

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
/** `StartupAgentSessionSnapshot`: the backend-owned result of the one-shot startup launch. */
export type StartupAgentSessionSnapshot = Mutable<typeof StartupAgentSessionSnapshotSchema.Type>;

/** `InitialPromptImageAttachment`. */
export const InitialPromptAttachmentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.optional(Schema.Literals(["image", "file"])),
  previewUrl: optionalString,
  base64Data: Schema.String,
});
/** A file waiting to be written into the workspace before the first prompt. */
export type InitialPromptImageAttachment = Mutable<typeof InitialPromptAttachmentSchema.Type>;

/**
 * The fields of `ClientEnvironment` (`models.ts`): the stored `Environment`
 * without its backend-private fields, with the lifecycle snapshot in place of
 * the durable record. The field documentation lives here; the backend's
 * stored `Environment` extends `ClientEnvironment` (plan item 7010).
 */
export const clientEnvironmentFields = {
  /** Monotonic fence for mail-triggered starts across explicit stop transitions. */
  stopGeneration: optionalNumber,
  id: Schema.String,
  projectId: Schema.String,
  /** Persisted association used to recover a build pipeline after renderer remount. */
  buildPipelineId: optionalString,
  /**
   * Set before durable child state is removed.
   *
   * Queue and pipeline writes reject an environment carrying this marker, so a
   * delayed renderer write cannot recreate state after deletion cleanup has
   * passed. The marker intentionally remains when cleanup fails: a retry may
   * continue deletion, but background work must not resume in the meantime.
   */
  deletionRequestedAt: optionalString,
  /**
   * Persisted before dispatching a merge whose confirmed success must be
   * followed by environment deletion. The backend owns reconciliation so the
   * follow-up survives renderer reloads and inactive environments.
   */
  cleanupAfterMergeRequestedAt: optionalString,
  /** Last backend cleanup failure retained for rehydration and manual retry. */
  cleanupAfterMergeError: optionalString,
  /**
   * Why the last delete of this tombstoned environment failed. The tombstone
   * stays, so a restart still retries; this is what stops it reading as running.
   * Cleared when a delete starts.
   */
  deletionError: optionalString,
  /**
   * The step the running (or last failed) delete reached. Rows show it while a
   * delete is running, so a slow one says what it is waiting for.
   */
  deletionStep: Schema.optional(EnvironmentDeletionStepSchema),
  /** The container lifecycle snapshot (the stored record keeps the durable lifecycle record). */
  containerLifecycle: Schema.optional(ContainerLifecycleSnapshotSchema),
  /**
   * Per-environment resource budget; overrides the global default. Absent
   * inherits; a `null` field is explicitly unrestricted.
   */
  containerResourceLimits: Schema.optional(ContainerResourceLimitsSchema),
  /** Backend-owned long-running operation currently affecting this environment. */
  lifecycleOperation: Schema.optional(EnvironmentLifecycleOperationSchema),
  lifecycleOperationStartedAt: optionalString,
  /**
   * Sanitized failure from the most recent backend-owned lifecycle operation.
   *
   * This is intentionally safe to persist and render — it is always one of the
   * fixed `ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES` values. Detailed subprocess
   * output and command arguments remain backend-only because they may contain
   * repository credentials or private host paths.
   *
   * Cleared as an explicit `null` so the absence of a failure survives JSON
   * serialization and field-by-field snapshot merges in the renderer.
   */
  lifecycleError: optionalNullableString,
  name: Schema.String,
  branch: Schema.String,
  containerId: Schema.NullOr(Schema.String),
  status: EnvironmentStatusSchema,
  prUrl: Schema.NullOr(Schema.String),
  /** Actual PR base observed by the backend, independent of repository defaults. */
  prBaseBranch: optionalNullableString,
  prState: Schema.NullOr(PrStateSchema),
  hasMergeConflicts: Schema.NullOr(Schema.Boolean),
  /**
   * GitHub's merge state from the PR monitor's last reading (see
   * `@orkestrator/protocol/pr-merge-readiness`). Cleared whenever `prUrl`
   * changes, so it never describes a predecessor PR. Absent on records
   * written before it existed.
   */
  prMergeability: Schema.optional(Schema.NullOr(GitHubPullRequestMergeabilitySchema)),
  /**
   * The user asked the backend to merge this environment's open pull request
   * as soon as GitHub reports it ready, and to launch Resolve when it
   * conflicts (`pr-auto-merge.ts`). Absent means off.
   */
  autoMerge: optionalBoolean,
  /**
   * Delete this environment once auto-merge has merged its pull request (the
   * Integrate dialog's "Auto-merge & Cleanup"). Only meaningful while
   * `autoMerge` is on, and cleared with it.
   */
  autoMergeCleanup: optionalBoolean,
  /** PR-specific authorization and freshness fence. */
  autoMergePrUrl: optionalNullableString,
  autoMergeEnabledAt: optionalNullableString,
  /** Last automatic attempt failure, cleared after recovery. */
  autoMergeError: optionalNullableString,
  /** Recoverable Resolve identity, retained across pre-dispatch failures. */
  autoMergeResolveRequestId: optionalString,
  autoMergeResolveCompletedAt: optionalString,
  autoMergeResolveAttempts: optionalNumber,
  createdAt: Schema.String,
  /** Last prompt dispatch or agent completion/waiting transition. */
  lastActivityAt: optionalString,
  /** Last backend-observed native session completion, even if another session is working. */
  agentSessionCompletedAt: optionalString,
  /** Backend-owned aggregate agent activity shared by every frontend. */
  agentActivityState: Schema.optional(AgentActivityStateSchema),
  /** Last-write-wins timestamp for the aggregate activity snapshot. */
  agentActivityUpdatedAt: optionalString,
  createdFromCommit: optionalString,
  /**
   * Where the branch now leaves its target branch, once it has taken in newer
   * target history. Backend-owned (`diff-baseline.ts`); read through
   * `environmentBaselineCommit`. Cleared as an explicit `null`.
   */
  diffBaseline: Schema.optional(Schema.NullOr(EnvironmentDiffBaselineSchema)),
  /**
   * A commit the user chose to measure changes from instead of `diffBaseline`
   * (`diff-base-override.ts`). Cleared as an explicit `null`.
   */
  diffBaseOverride: Schema.optional(Schema.NullOr(EnvironmentDiffBaseOverrideSchema)),
  /** Immutable source selected by a coordinator delegation. */
  delegationBaseBranch: optionalString,
  delegationBaseCommit: optionalString,
  networkAccessMode: NetworkAccessModeSchema,
  allowedDomains: Schema.optional(mutableArray(Schema.String)),
  /**
   * Providers whose credentials the user removed from this environment. They
   * are left out of staged inputs and credential syncs until allowed again.
   */
  revokedInputProviders: Schema.optional(mutableArray(AgentPlatformSchema)),
  order: Schema.Finite,
  portMappings: Schema.optional(mutableArray(PortMappingSchema)),
  entryPort: optionalPort,
  hostEntryPort: optionalPort,
  environmentType: EnvironmentTypeSchema,
  worktreePath: optionalString,
  /**
   * The folder the worktree was created in. Chosen when the environment is
   * created, or recorded from the default when the worktree is made; deletion
   * removes the worktree only from inside it.
   */
  worktreeBaseDir: optionalString,
  /**
   * A move of the worktree to another folder that has started and not yet
   * settled. Startup recovery adopts a completed move or abandons the rest.
   */
  worktreeMove: Schema.optional(WorktreeMoveRecordSchema),
  /**
   * Marks the project home: a local environment whose `worktreePath` is the
   * project's own checkout. Never a disposable workspace — see
   * `project-home-environment.ts` for the paths that must honour it.
   */
  projectHome: optionalBoolean,
  localOpencodePort: optionalPort,
  localClaudePort: optionalPort,
  localCodexPort: optionalPort,
  localCursorPort: optionalPort,
  localGrokPort: optionalPort,
  localPiPort: optionalPort,
  /**
   * This environment's agent overrides — the narrowest of the three tiers.
   *
   * An absent field means "inherit from the repository, then the application",
   * which is what the settings panes write when a control returns to Inherit.
   *
   * Supersedes `defaultAgent`, `claudeMode`, `claudeNativeBackend`,
   * `opencodeMode` and `codexMode`, which the backend folds onto this shape on
   * load (`storage-agent-settings.ts`) and then deletes from the record.
   */
  agentSettings: Schema.optional(AgentSettingsTierSchema),
  setupScriptsComplete: optionalBoolean,
  /** Single backend-owned setup lifecycle projection. */
  setupPhase: Schema.optional(EnvironmentSetupPhaseSchema),
  /** Persisted acknowledgement that lets the user proceed after a setup failure. */
  setupOverride: optionalBoolean,
  /**
   * Setup was held, not run: a local environment's `setupLocal` commands
   * differ from the default branch's and from every hash approved for the
   * project on this machine (`setup-approval.ts`). Recorded with
   * `setupPhase: "failed"`, so every reader that waits on setup stops; the
   * user approves the commands or skips setup.
   */
  setupApprovalRequired: optionalBoolean,
  setupSessionId: optionalString,
  setupStartedAt: optionalString,
  setupCompletedAt: optionalString,
  /**
   * Agent work finished here and no client has opened it since.
   *
   * A fact about the environment, not about one window: whichever client opens
   * it clears the badge everywhere, because the work has now been seen.
   */
  hasUnreadWork: optionalBoolean,
  /** What most recently lit `hasUnreadWork`; cleared with it. */
  unreadReason: Schema.optional(EnvironmentUnreadReasonSchema),
  /** Bounded content-free dedupe keys for agent events that requested attention. */
  agentAttentionKeys: Schema.optional(mutableArray(Schema.String)),
  /** Durable intent to open the configured agent once setup is ready. */
  pendingAgentLaunch: optionalBoolean,
  /** One-shot agent selected for pendingAgentLaunch. */
  initialAgentPlatform: Schema.optional(AgentPlatformSchema),
  /** One-shot model for the agent tab created from pendingAgentLaunch. */
  initialAgentModel: optionalString,
  /** One-shot reasoning effort for the agent tab created from pendingAgentLaunch. */
  initialReasoningEffort: optionalString,
  /**
   * One-shot Fast/Normal choice for the agent tab created from
   * pendingAgentLaunch.
   *
   * Separate from the platform tier's `fastMode` for the same reason the two
   * fields above are: a launcher may pick a speed for this one run without
   * that becoming the environment's durable setting. Absent means the tier
   * decides.
   */
  initialFastMode: optionalBoolean,
  initialPrompt: optionalString,
  /** Backend-owned result of consuming pendingAgentLaunch. */
  startupAgentSession: Schema.optional(StartupAgentSessionSnapshotSchema),
  hasInitialPromptAttachments: optionalBoolean,
} as const;

/** `ClientEnvironment`: what every environment list and mutation answers. */
export const ClientEnvironmentSchema = Schema.Struct(clientEnvironmentFields).annotate({
  identifier: "ClientEnvironment",
});
/**
 * `ClientEnvironment`, mutable as the model types are: the backend's
 * `ClientEnvironment` and the base of the web's `Environment` (plan item 7010).
 */
export type ClientEnvironment = DeepMutable<typeof ClientEnvironmentSchema.Type>;

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
export type EnvironmentDetail = DeepMutable<typeof EnvironmentDetailSchema.Type>;

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
