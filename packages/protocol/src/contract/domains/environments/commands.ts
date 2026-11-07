/**
 * `environments` commands (plan item 7003): environments and their container
 * lifecycle, setup, recovery copies, resources, network policy, portable
 * inputs, logs, extensions and tab teardown.
 *
 * Argument schemas declare every key the handler reads. A value the handler
 * checks itself with its own message (the lifecycle parsers, coercions such
 * as `asOptionalString`, `asNonBlankString`) is `optionalKey(Unknown)`, so a
 * lenient handler stays lenient and the error text is unchanged; a value the
 * handler read with `asString(x, "x")` is `Schema.String`, whose failure text
 * is the same ("Expected x to be a string"). The strict handlers
 * (`assertOnlyKeys`) are tolerant now (§11.4): unknown keys are dropped.
 *
 * `critical` lists the idempotency keys and safety options a receiver must
 * not ignore; the reason for each is next to it. `read` equals
 * `isNodeReadCommand(name)`. `access` follows the old workspace deny-list
 * (replaced by this field, plan item 7012): Settings-only commands are `admin`, the
 * node-link-only one `internal`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { mutableArray } from "../../model-schema.js";
import { defineCommand } from "../../command.js";
import { environmentsDomain } from "./domain.js";
import {
  ClientEnvironmentSchema,
  ContainerLifecycleSnapshotSchema,
  EnvironmentDetailSchema,
  EnvironmentSetupStartResultSchema,
  EnvironmentSnapshotRowSchema,
  EnvironmentStatusSchema,
  RelayedPrMonitorHealthSchema,
} from "./models.js";
import {
  AgentExtensionCatalogSchema,
  AllowedDomainsApplyResultSchema,
  ClaudeTerminalStateSchema,
  ContainerOperationCancelResultSchema,
  ContainerResourceDefaultResultSchema,
  CredentialRestoreResultSchema,
  CredentialRevocationResultSchema,
  DiscardCopyResultSchema,
  EnvironmentInputStatusSchema,
  EnvironmentNetworkPolicySchema,
  EnvironmentResourcePolicySchema,
  EnvironmentSetupApprovalSchema,
  EnvironmentSetupSessionSnapshotSchema,
  FinalEnvironmentPrSchema,
  LogStorageStatsSchema,
  OrphanedTabResourcesResultSchema,
  RebuildPreviewSchema,
  RecoveryCopyListSchema,
  TabTeardownReconcileResultSchema,
  TabTeardownResultSchema,
} from "./results.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/**
 * `get_environment_snapshots`: the list, a node summary's rows
 * (`includePrMonitorHealth`), or with a known manifest generation and
 * revision a `ConditionalResourceSnapshot` (`resource-events.ts`).
 */
export const EnvironmentSnapshotsResultSchema = Schema.Union([
  mutableArray(EnvironmentSnapshotRowSchema),
  Schema.Struct({
    status: Schema.Literal("unchanged"),
    generation: Schema.String,
    revision: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("changed"),
    generation: Schema.String,
    revision: Schema.String,
    snapshot: mutableArray(ClientEnvironmentSchema),
  }),
]);

/** The backend's log directory. */
export const getLogDirectoryCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_log_directory",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: Schema.String,
  critical: [],
});

/** Sizes of the debug logs and the essential log. */
export const getLogStorageStatsCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_log_storage_stats",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: LogStorageStatsSchema,
  critical: [],
});

/** Removes the debug logs (Settings); the essential log stays. */
export const cleanupLogsCommand = defineCommand({
  domain: environmentsDomain,
  name: "cleanup_logs",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({}),
  result: LogStorageStatsSchema,
  critical: [],
});

/** A project's environments, reconciled with Docker. */
export const getEnvironmentsCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environments",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
  }),
  result: mutableArray(ClientEnvironmentSchema),
  critical: [],
});

/** A project's persisted environments, conditionally on a known revision, or as a node summary row. */
export const getEnvironmentSnapshotsCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environment_snapshots",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
    includePrMonitorHealth: optionalUnknown,
    knownManifestGeneration: optionalUnknown,
    knownResourceRevision: optionalUnknown,
  }),
  result: EnvironmentSnapshotsResultSchema,
  critical: [],
});

/** One environment as the snapshot list has it. */
export const getEnvironmentSnapshotCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environment_snapshot",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: Schema.NullOr(ClientEnvironmentSchema),
  critical: [],
});

/** Announced PR monitor health per environment with a PR. */
export const getEnvironmentPrHealthCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environment_pr_health",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
    environmentIds: optionalUnknown,
  }),
  result: Schema.Record(Schema.String, RelayedPrMonitorHealthSchema),
  critical: [],
});

/** One stored environment, or its final PR once deleted (`includeFinalPrState`). */
export const getEnvironmentCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environment",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
    includeFinalPrState: optionalUnknown,
  }),
  result: Schema.Union([EnvironmentDetailSchema, FinalEnvironmentPrSchema, Schema.Null]),
  critical: [],
});

/** The persisted Claude terminal activity of a container's environment. */
export const getClaudeTerminalStateCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_claude_terminal_state",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    containerId: Schema.String,
  }),
  result: Schema.NullOr(ClaudeTerminalStateSchema),
  critical: [],
});

export const reorderEnvironmentsCommand = defineCommand({
  domain: environmentsDomain,
  name: "reorder_environments",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    environmentIds: optionalUnknown,
  }),
  result: mutableArray(ClientEnvironmentSchema),
  critical: [],
});

export const createEnvironmentCommand = defineCommand({
  domain: environmentsDomain,
  name: "create_environment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    name: optionalUnknown,
    networkAccessMode: optionalUnknown,
    initialPrompt: optionalUnknown,
    portMappings: optionalUnknown,
    environmentType: optionalUnknown,
    namingPrompt: optionalUnknown,
    buildPipelineId: optionalUnknown,
    agentSettings: optionalUnknown,
    pendingAgentLaunch: optionalUnknown,
    initialAgentPlatform: optionalUnknown,
    initialAgentModel: optionalUnknown,
    initialReasoningEffort: optionalUnknown,
    initialFastMode: optionalUnknown,
    initialConversationMode: optionalUnknown,
    controlRequestId: optionalUnknown,
    controlRequestFingerprint: optionalUnknown,
    delegationBaseBranch: optionalUnknown,
    delegationBaseCommit: optionalUnknown,
    worktreeBaseDir: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [
    // controlRequestId: the launch's idempotency key; ignoring it creates a second environment on a retry.
    "controlRequestId",
    // controlRequestFingerprint: refuses a reused key with a different intent; ignoring it answers the wrong environment.
    "controlRequestFingerprint",
    // delegationBaseBranch: the immutable source a coordinator delegated; ignoring it branches from the default instead.
    "delegationBaseBranch",
    // delegationBaseCommit: as delegationBaseBranch.
    "delegationBaseCommit",
  ],
});

/** The project home environment, created on first use. */
export const ensureProjectHomeEnvironmentCommand = defineCommand({
  domain: environmentsDomain,
  name: "ensure_project_home_environment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const forkEnvironmentCommand = defineCommand({
  domain: environmentsDomain,
  name: "fork_environment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    environmentType: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const deleteEnvironmentCommand = defineCommand({
  domain: environmentsDomain,
  name: "delete_environment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: Schema.Void,
  critical: [],
});

/** Moves a local environment's worktree into another folder. */
export const moveEnvironmentCommand = defineCommand({
  domain: environmentsDomain,
  name: "move_environment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    destinationDir: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const renameEnvironmentCommand = defineCommand({
  domain: environmentsDomain,
  name: "rename_environment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    name: Schema.String,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const renameEnvironmentFromPromptCommand = defineCommand({
  domain: environmentsDomain,
  name: "rename_environment_from_prompt",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    prompt: Schema.String,
  }),
  result: Schema.Void,
  critical: [],
});

export const prepareEnvironmentFirstPromptCommand = defineCommand({
  domain: environmentsDomain,
  name: "prepare_environment_first_prompt",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    prompt: Schema.String,
  }),
  result: Schema.Void,
  critical: [],
});

export const reconcilePendingEnvironmentRenamesCommand = defineCommand({
  domain: environmentsDomain,
  name: "reconcile_pending_environment_renames",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({}),
  result: Schema.Struct({ pending: Schema.Finite }),
  critical: [],
});

export const getEnvironmentStatusCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environment_status",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: EnvironmentStatusSchema,
  critical: [],
});

export const syncEnvironmentStatusCommand = defineCommand({
  domain: environmentsDomain,
  name: "sync_environment_status",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

/** Clears container references Docker definitely no longer has; answers the cleared ids. */
export const syncAllEnvironmentsWithDockerCommand = defineCommand({
  domain: environmentsDomain,
  name: "sync_all_environments_with_docker",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({}),
  result: mutableArray(Schema.String),
  critical: [],
});

export const startEnvironmentCommand = defineCommand({
  domain: environmentsDomain,
  name: "start_environment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    operationId: optionalUnknown,
    expectedRevision: optionalUnknown,
  }),
  result: EnvironmentSetupStartResultSchema,
  critical: [
    // operationId: the durable start's idempotency key; ignoring it runs a retried start twice.
    "operationId",
    // expectedRevision: binds the start to the lifecycle revision the client saw.
    "expectedRevision",
  ],
});

export const startEnvironmentBackgroundCommand = defineCommand({
  domain: environmentsDomain,
  name: "start_environment_background",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    operationId: optionalUnknown,
    expectedRevision: optionalUnknown,
  }),
  result: Schema.Void,
  critical: [
    // operationId: as start_environment.
    "operationId",
    // expectedRevision: as start_environment.
    "expectedRevision",
  ],
});

export const stopEnvironmentCommand = defineCommand({
  domain: environmentsDomain,
  name: "stop_environment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    operationId: optionalUnknown,
    expectedRevision: optionalUnknown,
  }),
  result: Schema.Void,
  critical: [
    // operationId: the durable stop's idempotency key.
    "operationId",
    // expectedRevision: binds the stop to the lifecycle revision the client saw.
    "expectedRevision",
  ],
});

export const getContainerLifecycleSnapshotCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_container_lifecycle_snapshot",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: ContainerLifecycleSnapshotSchema,
  critical: [],
});

/** Adopts or releases the container of an operation that needs the user's decision. */
export const resolveContainerOperationCommand = defineCommand({
  domain: environmentsDomain,
  name: "resolve_container_operation",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    operationId: Schema.String,
    resolution: optionalUnknown,
    containerId: optionalUnknown,
  }),
  result: Schema.UndefinedOr(ClientEnvironmentSchema),
  critical: [],
});

export const getRebuildPreviewCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_rebuild_preview",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: RebuildPreviewSchema,
  critical: [],
});

export const listRecoveryCopiesCommand = defineCommand({
  domain: environmentsDomain,
  name: "list_recovery_copies",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
    measureSize: optionalUnknown,
  }),
  result: RecoveryCopyListSchema,
  critical: [],
});

export const discardRecoveryCopyCommand = defineCommand({
  domain: environmentsDomain,
  name: "discard_recovery_copy",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    copyId: Schema.String,
    expectedRevision: optionalUnknown,
    operationId: optionalUnknown,
  }),
  result: Schema.UndefinedOr(DiscardCopyResultSchema),
  critical: [
    // expectedRevision: binds the deletion to the reviewed list; ignoring it could delete a copy the user did not see.
    "expectedRevision",
    // operationId: the deletion's idempotency key.
    "operationId",
  ],
});

export const restoreRecoveryCopyCommand = defineCommand({
  domain: environmentsDomain,
  name: "restore_recovery_copy",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    copyId: Schema.String,
    expectedContainerId: optionalUnknown,
    expectedRevision: optionalUnknown,
    operationId: optionalUnknown,
  }),
  result: Schema.UndefinedOr(EnvironmentSetupStartResultSchema),
  critical: [
    // expectedContainerId: binds the restore to the reviewed runtime; ignoring it could replace a newer one.
    "expectedContainerId",
    // expectedRevision: binds the restore to the reviewed list.
    "expectedRevision",
    // operationId: the restore's idempotency key.
    "operationId",
  ],
});

export const getEnvironmentResourcesCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environment_resources",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: EnvironmentResourcePolicySchema,
  critical: [],
});

export const updateEnvironmentResourcesCommand = defineCommand({
  domain: environmentsDomain,
  name: "update_environment_resources",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    limits: optionalUnknown,
    applyNow: optionalUnknown,
    allowBelowUsage: optionalUnknown,
  }),
  result: EnvironmentResourcePolicySchema,
  critical: [],
});

/** The default budget of new runtimes (Settings). */
export const setContainerResourceLimitsCommand = defineCommand({
  domain: environmentsDomain,
  name: "set_container_resource_limits",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    limits: optionalUnknown,
  }),
  result: ContainerResourceDefaultResultSchema,
  critical: [],
});

export const getEnvironmentNetworkPolicyCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environment_network_policy",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: EnvironmentNetworkPolicySchema,
  critical: [],
});

export const applyEnvironmentAllowedDomainsCommand = defineCommand({
  domain: environmentsDomain,
  name: "apply_environment_allowed_domains",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: AllowedDomainsApplyResultSchema,
  critical: [],
});

export const getEnvironmentInputsCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environment_inputs",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: EnvironmentInputStatusSchema,
  critical: [],
});

export const revokeProviderCredentialsCommand = defineCommand({
  domain: environmentsDomain,
  name: "revoke_provider_credentials",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    provider: optionalUnknown,
  }),
  result: CredentialRevocationResultSchema,
  critical: [],
});

export const restoreProviderCredentialsCommand = defineCommand({
  domain: environmentsDomain,
  name: "restore_provider_credentials",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    provider: optionalUnknown,
  }),
  result: CredentialRestoreResultSchema,
  critical: [],
});

export const cancelContainerOperationCommand = defineCommand({
  domain: environmentsDomain,
  name: "cancel_container_operation",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    operationId: Schema.String,
  }),
  result: ContainerOperationCancelResultSchema,
  critical: [],
});

export const recreateEnvironmentCommand = defineCommand({
  domain: environmentsDomain,
  name: "recreate_environment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: optionalUnknown,
    intent: optionalUnknown,
    expectedContainerId: optionalUnknown,
    allowUnknownCapacity: optionalUnknown,
    keepRecoveryCopy: optionalUnknown,
    operationId: optionalUnknown,
    expectedRevision: optionalUnknown,
  }),
  result: Schema.UndefinedOr(EnvironmentSetupStartResultSchema),
  critical: [
    // expectedContainerId: a discard removes only the runtime the user reviewed.
    "expectedContainerId",
    // keepRecoveryCopy: ignoring it deletes the runtime the user asked to keep as a recovery copy.
    "keepRecoveryCopy",
    // operationId: the replacement's idempotency key.
    "operationId",
    // expectedRevision: binds the replacement to the lifecycle revision the user reviewed.
    "expectedRevision",
  ],
});

export const setEnvironmentPrCommand = defineCommand({
  domain: environmentsDomain,
  name: "set_environment_pr",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    prUrl: Schema.String,
    prState: optionalUnknown,
    hasMergeConflicts: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const clearEnvironmentPrCommand = defineCommand({
  domain: environmentsDomain,
  name: "clear_environment_pr",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: Schema.Void,
  critical: [],
});

export const getEnvironmentPrUrlCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environment_pr_url",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: Schema.NullOr(Schema.String),
  critical: [],
});

/** Proceeds past a failed setup. */
export const overrideEnvironmentSetupCommand = defineCommand({
  domain: environmentsDomain,
  name: "override_environment_setup",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const getEnvironmentSetupApprovalCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environment_setup_approval",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: EnvironmentSetupApprovalSchema,
  critical: [],
});

/** Runs exactly the setup commands the user was shown (`hash`). */
export const approveEnvironmentSetupCommand = defineCommand({
  domain: environmentsDomain,
  name: "approve_environment_setup",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    hash: Schema.String,
    remember: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

/** Node link only: the command node's "approve on every machine". */
export const approveProjectSetupCommandsCommand = defineCommand({
  domain: environmentsDomain,
  name: "approve_project_setup_commands",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    hash: Schema.String,
  }),
  result: Schema.Struct({ approved: Schema.Boolean }),
  critical: [],
});

export const runEnvironmentSetupCommand = defineCommand({
  domain: environmentsDomain,
  name: "run_environment_setup",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const ensureEnvironmentSetupCommand = defineCommand({
  domain: environmentsDomain,
  name: "ensure_environment_setup",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
  }),
  result: EnvironmentSetupStartResultSchema,
  critical: [],
});

export const awaitEnvironmentSetupSessionCommand = defineCommand({
  domain: environmentsDomain,
  name: "await_environment_setup_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    timeoutMs: optionalUnknown,
  }),
  result: Schema.NullOr(EnvironmentSetupSessionSnapshotSchema),
  critical: [],
});

export const updatePortMappingsCommand = defineCommand({
  domain: environmentsDomain,
  name: "update_port_mappings",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    portMappings: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const updateEnvironmentAgentSettingsCommand = defineCommand({
  domain: environmentsDomain,
  name: "update_environment_agent_settings",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    agentSettings: optionalUnknown,
    pendingAgentLaunch: optionalUnknown,
    initialAgentPlatform: optionalUnknown,
    initialAgentModel: optionalUnknown,
    initialReasoningEffort: optionalUnknown,
    initialFastMode: optionalUnknown,
    initialConversationMode: optionalUnknown,
    initialPrompt: optionalUnknown,
    initialPromptAttachments: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const setEnvironmentPendingAgentLaunchCommand = defineCommand({
  domain: environmentsDomain,
  name: "set_environment_pending_agent_launch",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    pending: Schema.Boolean,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const acknowledgeStartupAgentSessionCommand = defineCommand({
  domain: environmentsDomain,
  name: "acknowledge_startup_agent_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    providerSessionId: optionalUnknown,
    startedAt: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const setEnvironmentInitialPromptCommand = defineCommand({
  domain: environmentsDomain,
  name: "set_environment_initial_prompt",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    initialPrompt: Schema.String,
    initialPromptAttachments: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

export const getEnvironmentExtensionsCommand = defineCommand({
  domain: environmentsDomain,
  name: "get_environment_extensions",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
    refresh: optionalUnknown,
  }),
  result: mutableArray(AgentExtensionCatalogSchema),
  critical: [],
});

export const updateEnvironmentAllowedDomainsCommand = defineCommand({
  domain: environmentsDomain,
  name: "update_environment_allowed_domains",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    domains: optionalUnknown,
  }),
  result: ClientEnvironmentSchema,
  critical: [],
});

/** Answers the saved allowlist, comma-separated. */
export const addEnvironmentDomainsCommand = defineCommand({
  domain: environmentsDomain,
  name: "add_environment_domains",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    domains: optionalUnknown,
  }),
  result: Schema.String,
  critical: [],
});

/** Answers the saved allowlist, comma-separated. */
export const removeEnvironmentDomainsCommand = defineCommand({
  domain: environmentsDomain,
  name: "remove_environment_domains",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    domains: optionalUnknown,
  }),
  result: Schema.String,
  critical: [],
});

/** Durably closes a tab's external resources. */
export const teardownTabCommand = defineCommand({
  domain: environmentsDomain,
  name: "teardown_tab",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: optionalUnknown,
    tabId: optionalUnknown,
    kind: optionalUnknown,
    sessionId: optionalUnknown,
    persistentSessionId: optionalUnknown,
  }),
  result: TabTeardownResultSchema,
  critical: [],
});

export const reconcileTabTeardownsCommand = defineCommand({
  domain: environmentsDomain,
  name: "reconcile_tab_teardowns",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({}),
  result: TabTeardownReconcileResultSchema,
  critical: [],
});

export const reconcileOrphanedTabResourcesCommand = defineCommand({
  domain: environmentsDomain,
  name: "reconcile_orphaned_tab_resources",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({}),
  result: OrphanedTabResourcesResultSchema,
  critical: [],
});

/** Every `environments` command, in registration order. */
export const ENVIRONMENTS_COMMANDS = [
  getLogDirectoryCommand,
  getLogStorageStatsCommand,
  cleanupLogsCommand,
  getEnvironmentsCommand,
  getEnvironmentSnapshotsCommand,
  getEnvironmentSnapshotCommand,
  getEnvironmentPrHealthCommand,
  getEnvironmentCommand,
  getClaudeTerminalStateCommand,
  reorderEnvironmentsCommand,
  createEnvironmentCommand,
  ensureProjectHomeEnvironmentCommand,
  forkEnvironmentCommand,
  deleteEnvironmentCommand,
  moveEnvironmentCommand,
  renameEnvironmentCommand,
  renameEnvironmentFromPromptCommand,
  prepareEnvironmentFirstPromptCommand,
  reconcilePendingEnvironmentRenamesCommand,
  getEnvironmentStatusCommand,
  syncEnvironmentStatusCommand,
  syncAllEnvironmentsWithDockerCommand,
  startEnvironmentCommand,
  startEnvironmentBackgroundCommand,
  stopEnvironmentCommand,
  getContainerLifecycleSnapshotCommand,
  resolveContainerOperationCommand,
  getRebuildPreviewCommand,
  listRecoveryCopiesCommand,
  discardRecoveryCopyCommand,
  restoreRecoveryCopyCommand,
  getEnvironmentResourcesCommand,
  updateEnvironmentResourcesCommand,
  setContainerResourceLimitsCommand,
  getEnvironmentNetworkPolicyCommand,
  applyEnvironmentAllowedDomainsCommand,
  getEnvironmentInputsCommand,
  revokeProviderCredentialsCommand,
  restoreProviderCredentialsCommand,
  cancelContainerOperationCommand,
  recreateEnvironmentCommand,
  setEnvironmentPrCommand,
  clearEnvironmentPrCommand,
  getEnvironmentPrUrlCommand,
  overrideEnvironmentSetupCommand,
  getEnvironmentSetupApprovalCommand,
  approveEnvironmentSetupCommand,
  approveProjectSetupCommandsCommand,
  runEnvironmentSetupCommand,
  ensureEnvironmentSetupCommand,
  awaitEnvironmentSetupSessionCommand,
  updatePortMappingsCommand,
  updateEnvironmentAgentSettingsCommand,
  setEnvironmentPendingAgentLaunchCommand,
  acknowledgeStartupAgentSessionCommand,
  setEnvironmentInitialPromptCommand,
  getEnvironmentExtensionsCommand,
  updateEnvironmentAllowedDomainsCommand,
  addEnvironmentDomainsCommand,
  removeEnvironmentDomainsCommand,
  teardownTabCommand,
  reconcileTabTeardownsCommand,
  reconcileOrphanedTabResourcesCommand,
] as const;
