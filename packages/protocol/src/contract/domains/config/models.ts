/**
 * The settings model as the `config` commands answer it (plan item 7005):
 * `AppConfig`, its `global` and `RepositoryConfig` of
 * `apps/backend/src/core/models.ts` field for field, the renderer's view of
 * them (`RendererAppConfig` of `commands-validation.ts`: credentials replaced
 * by `*Configured`/`*Source`), the agent settings tier this domain owns, and
 * the records of the shared client state and permission rules. Plan item 7010
 * makes these the single definition the backend and the renderer infer their
 * types from.
 *
 * Rules: as in `projects/models.ts`. Settings records are {@link openRecord}s
 * because a client writes them back whole (`save_config`,
 * `update_global_config`, `update_repository_config`): a closed struct would
 * drop the keys it does not declare when a client decodes `get_config`, and
 * the next whole-object save would then delete a setting a newer backend
 * added. Every field is still declared and typed. Nested values another
 * module owns (log detail, notification sounds, review lenses, the rollout
 * gates...) are typed objects (`ownedObject`) until their owner has a schema;
 * the backend's own normalisers keep validating them as before.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { DeepMutable } from "effect/Types";
import { mutableArray, openRecord, ownedObject } from "../../model-schema.js";
import type { AgentAccountAutoSwitchSettings } from "../../../agent-account-auto-switch.js";
import type { AgentMessagingSettings } from "../../../agent-mail.js";
import type { StoredDesktopConnections } from "../../../connections.js";
import type { CoordinatorAccountSwitchGrants } from "../../../coordinator-account-switch-grant.js";
import {
  COORDINATOR_UPSTREAM_MERGE_SKIP_REASONS,
  type CoordinatorUpstreamMergeCheck,
} from "../../../coordinator-upstream-merge.js";
import type { CoordinatorPaneLayout } from "../../../coordinator-pane-layout.js";
import {
  COORDINATOR_WEB_RESEARCH_MODES,
  type CoordinatorResearchMcpServer,
} from "../../../coordinator-web-research.js";
import type { WorktreeLocationSettings } from "../../../disk-usage.js";
import type { LogDetail } from "../../../log-policy.js";
import type { McpManagementRolloutSettings } from "../../../mcp-management.js";
import { MULTI_REVIEW_ENGINES } from "../../../multi-review.js";
import { OPENCODE_PROTOCOLS } from "../../../opencode-protocol.js";
import type { NotificationSoundSettings } from "../../../notification-sounds.js";
import {
  PERMISSION_RULE_KINDS,
  PERMISSION_RULE_SCOPES,
  type ExternalPermissionRuleFile,
} from "../../../permission-rules.js";
import {
  AGENT_INTERACTION_APPLY_RESULTS,
  AGENT_INTERACTION_PROVIDERS,
} from "../../../agent-interactions.js";
import type { ProjectGitStatus } from "../../../coordinator.js";
import type { ReviewLensPreset } from "../../../review-lens.js";
import { SESSION_TITLE_GENERATION_POLICIES } from "../../../session-title-generation.js";
import { TERMINAL_LINK_DEFAULT_TARGETS } from "../../../terminal-link-target.js";
import type { WebAnnotationRolloutSettings } from "../../../web-annotations.js";
import type { WorkflowResultToolsSettings } from "../../../workflow-results.js";
import { AgentLaunchModeSchema, AgentSettingsTierSchema } from "./agent-settings.js";
import {
  AgentPlatformSchema,
  ContainerResourceLimitsSchema,
  EnvironmentTypeSchema,
  PortMappingSchema,
} from "../environments/models.js";

const optionalString = Schema.optional(Schema.String);
const optionalBoolean = Schema.optional(Schema.Boolean);
const optionalNumber = Schema.optional(Schema.Finite);
const optionalStrings = Schema.optional(mutableArray(Schema.String));

export {
  AgentLaunchModeSchema,
  AgentSettingsTierSchema,
  ClaudeNativeBackendSchema,
  type AgentLaunchMode,
  type AgentSettingsTier,
  type ClaudeNativeBackend,
} from "./agent-settings.js";

/**
 * The machine settings both the stored and the renderer's global share:
 * everything but the credentials.
 */
export const globalSettingsFields = {
  /** Resource budget enforced on new container runtimes; absent is the daemon's built-in default. */
  containerResourceLimits: Schema.optional(ContainerResourceLimitsSchema),
  /** Agent systems installed and exposed in launch/review surfaces. */
  enabledAgentPlatforms: Schema.optional(mutableArray(AgentPlatformSchema)),
  /** Which runtime runs new Multi Reviews; absent means `bespoke`. */
  multiReviewEngine: Schema.optional(Schema.Literals(MULTI_REVIEW_ENGINES)),
  /** Weakest read-only guarantee a coordinator conversation may run under. */
  coordinatorProviderTiers: Schema.optional(
    Schema.Literals(["enforced", "provider-configured", "advisory"]),
  ),
  /** Internal marker for the one-time coordinator safety-default migration. */
  coordinatorProviderTierDefaultVersion: optionalNumber,
  /** Web research a coordinator may do; absent means the product default. */
  coordinatorWebResearch: Schema.optional(Schema.Literals(COORDINATOR_WEB_RESEARCH_MODES)),
  /** Remote research MCP servers; absent means the default list (Context7). */
  coordinatorResearchMcpServers: Schema.optional(
    mutableArray(ownedObject<CoordinatorResearchMcpServer>()),
  ),
  favoriteModels: Schema.optional(
    mutableArray(Schema.Struct({ platform: AgentPlatformSchema, modelId: Schema.String })),
  ),
  /** Legacy, never enforced; kept for older configurations. */
  containerResources: Schema.Struct({ cpuCores: Schema.Finite, memoryGb: Schema.Finite }),
  envFilePatterns: mutableArray(Schema.String),
  /** The backend's own GitHub credential: the host's `gh auth login`, or else the stored token. */
  useHostGitHubCredentials: optionalBoolean,
  /** What containers receive, independent of the backend's credential. Absent means none. */
  containerGitHubCredential: Schema.optional(Schema.Literals(["none", "host-cli", "pat"])),
  /** The user asked not to be reminded at startup to set up the GitHub CLI. */
  githubCliReminderDismissed: optionalBoolean,
  /** Optional absolute SSH-agent socket path. Absent means auto-detect. */
  sshAgentSocketPath: optionalString,
  /** Auto-merge waits for non-required checks. True or absent waits for all. */
  autoMergeRequireChecks: optionalBoolean,
  /** A message typed while a turn runs steers it instead of queueing. */
  autoSteer: optionalBoolean,
  /** Absolute directory new projects are cloned into on this machine. */
  defaultProjectsDirectory: optionalString,
  /** Deliver the host's Claude Code OAuth credential into containers. */
  useHostClaudeCredentials: optionalBoolean,
  /** Domains allowed when environments are in restricted network mode. */
  allowedDomains: mutableArray(Schema.String),
  preferredEditor: Schema.optional(Schema.Literals(["vscode", "cursor"])),
  /** Application-wide agent defaults — the widest of the three tiers. */
  agentSettings: Schema.optional(AgentSettingsTierSchema),
  /** OpenCode provider catalogues offered in model pickers; empty means unrestricted. */
  openCodeModelProviders: optionalStrings,
  /** Which OpenCode line runs new interactive host sessions; absent means `legacy` (1.x). */
  openCodeProtocol: Schema.optional(Schema.Literals(OPENCODE_PROTOCOLS)),
  /** Maximum concurrently open spawned-agent threads per native Codex session. */
  codexMaxConcurrentThreads: Schema.Finite,
  /** Longest a Claude native background shell command may run, in hours. */
  claudeBackgroundCommandLimitHours: optionalNumber,
  /** Which agent logins may write session titles. Absent is `any-signed-in`. */
  sessionTitleGeneration: Schema.optional(Schema.Literals(SESSION_TITLE_GENERATION_POLICIES)),
  terminalAppearance: Schema.Struct({
    fontFamily: Schema.String,
    fontSize: Schema.Finite,
    backgroundColor: Schema.String,
  }),
  terminalScrollback: Schema.Finite,
  /** Where ⌘-click on a terminal link opens. Absent is `external`. */
  terminalLinkDefaultTarget: Schema.optional(Schema.Literals(TERMINAL_LINK_DEFAULT_TARGETS)),
  terminalHistoryEnabled: optionalBoolean,
  terminalHistoryRetentionMb: optionalNumber,
  terminalHistoryGlobalRetentionMb: optionalNumber,
  terminalHistoryRetentionDays: optionalNumber,
  /** Experimental gate for scheduled jobs. */
  experimentalScheduling: optionalBoolean,
  localWindowGatewayTransport: optionalBoolean,
  /** Experimental gate for graphs in the web UI. */
  experimentalGraphs: optionalBoolean,
  /** "Save logs to disk". */
  debugLogging: optionalBoolean,
  debugLogRetentionDays: optionalNumber,
  /** "Log detail": levels for every process. */
  logDetail: Schema.optional(ownedObject<LogDetail>()),
  /** Backend-owned: when raised "Log detail" reverts (ISO 8601). */
  logDetailExpiresAt: optionalString,
  logDetailKeepRaised: optionalBoolean,
  webClientEnabled: optionalBoolean,
  notificationSounds: Schema.optional(ownedObject<NotificationSoundSettings>()),
  /** Editable preference embedded inside Orkestrator's fixed review contract. */
  reviewInstruction: optionalString,
  /** Reviewer focus presets; absent means the shipped five. */
  reviewLensPresets: Schema.optional(mutableArray(ownedObject<ReviewLensPreset>())),
  agentMessaging: Schema.optional(ownedObject<AgentMessagingSettings>()),
  agentAccountAutoSwitch: Schema.optional(ownedObject<AgentAccountAutoSwitchSettings>()),
  /** Machine-local standing permission for coordinators to switch accounts. */
  coordinatorAccountSwitchGrant: Schema.optional(ownedObject<CoordinatorAccountSwitchGrants>()),
  /** Backend-owned rollout gate for tool-mode workflow results. */
  workflowResultTools: Schema.optional(ownedObject<WorkflowResultToolsSettings>()),
  /** Backend-owned rollout gate for MCP configuration management. */
  mcpManagement: Schema.optional(ownedObject<McpManagementRolloutSettings>()),
  /** Backend rollout switch for web annotations. */
  webAnnotations: Schema.optional(ownedObject<WebAnnotationRolloutSettings>()),
  /** Where new environment and development-profile worktrees are created. */
  worktreeLocations: Schema.optional(ownedObject<WorktreeLocationSettings>()),
};

/** The stored global settings (`AppConfig["global"]`), credentials included. Never sent to a renderer. */
export const StoredGlobalConfigSchema = openRecord({
  ...globalSettingsFields,
  anthropicApiKey: optionalString,
  /** Cursor API key forwarded to containerized Cursor Agent processes. */
  cursorApiKey: optionalString,
  /** OpenCode Zen (Go) plan key, used to read plan usage in Settings. */
  openCodeZenApiKey: optionalString,
  githubToken: optionalString,
});
export type StoredGlobalConfig = DeepMutable<typeof StoredGlobalConfigSchema.Type>;

/** `ApiKeySource` (`commands-validation.ts`): where the key a new container receives comes from. */
export const ApiKeySourceSchema = Schema.Literals(["config", "host-env", "none"]);
/** `CursorApiKeySource`: `host-snapshot` is a test profile's authorized copy of the host credential. */
export const CursorApiKeySourceSchema = Schema.Literals([
  "config",
  "host-env",
  "host-snapshot",
  "none",
]);

/**
 * `RendererGlobalConfig` (`commands-validation.ts`): the global settings as
 * every command answers them. The credentials are write-only; only whether
 * each is configured, and where a container's key comes from, is sent.
 */
export const GlobalConfigSchema = openRecord({
  ...globalSettingsFields,
  githubTokenConfigured: Schema.Boolean,
  anthropicApiKeyConfigured: Schema.Boolean,
  anthropicApiKeySource: ApiKeySourceSchema,
  cursorApiKeyConfigured: Schema.Boolean,
  cursorApiKeySource: CursorApiKeySourceSchema,
  openCodeZenApiKeyConfigured: Schema.Boolean,
  openCodeZenApiKeySource: ApiKeySourceSchema,
});
export type GlobalConfig = DeepMutable<typeof GlobalConfigSchema.Type>;

/** `RepositoryConfig` (models.ts): one project's settings. */
export const RepositoryConfigSchema = openRecord({
  defaultBranch: Schema.String,
  prBaseBranch: Schema.String,
  lastEnvironmentType: Schema.optional(EnvironmentTypeSchema),
  /** @deprecated Legacy last-create state retained for older clients. */
  lastEnvironmentAgentSelection: Schema.optional(
    Schema.Struct({ platform: AgentPlatformSchema, mode: AgentLaunchModeSchema }),
  ),
  defaultPortMappings: Schema.optional(mutableArray(PortMappingSchema)),
  filesToCopy: optionalStrings,
  entryPort: optionalNumber,
  /** This repository's agent overrides — the middle tier. */
  agentSettings: Schema.optional(AgentSettingsTierSchema),
  /** The user lets this project's coordinator send work to environments it did not create. */
  coordinatorOtherEnvironments: optionalBoolean,
});
export type RepositoryConfig = DeepMutable<typeof RepositoryConfigSchema.Type>;

/** The fields of `AppConfig` beside `global`. */
const appConfigFields = {
  /** Versioned persisted-config migration discriminator. */
  schemaVersion: optionalNumber,
  version: Schema.String,
  desktopConnections: Schema.optional(ownedObject<StoredDesktopConnections>()),
  repositories: Schema.Record(Schema.String, RepositoryConfigSchema),
};

/** `AppConfig` (models.ts) as stored, credentials included. */
export const StoredAppConfigSchema = openRecord({
  ...appConfigFields,
  global: StoredGlobalConfigSchema,
});
export type StoredAppConfig = DeepMutable<typeof StoredAppConfigSchema.Type>;

/** `RendererAppConfig`: the settings as `get_config` and every settings write answer them. */
export const AppConfigSchema = openRecord({
  ...appConfigFields,
  global: GlobalConfigSchema,
});
export type AppConfig = DeepMutable<typeof AppConfigSchema.Type>;

/** `get_config`: the settings, or with a known manifest generation and revision a `ConditionalResourceSnapshot`. */
export const ConfigReadSchema = Schema.Union([
  AppConfigSchema,
  Schema.Struct({
    status: Schema.Literal("unchanged"),
    generation: Schema.String,
    revision: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("changed"),
    generation: Schema.String,
    revision: Schema.String,
    snapshot: AppConfigSchema,
  }),
]);

/** `StoredDesktopConnections` (`connections.ts`): the desktop's saved machines. */
export const DesktopConnectionsSchema = openRecord({
  activeConnectionId: Schema.String,
  connections: mutableArray(ownedObject<StoredDesktopConnections["connections"][number]>()),
});

// --- Shared client state (`client-state.ts` and its neighbours) ---------------

/** `ClientStateCapabilities`: which shared client state this backend owns. */
export const ClientStateCapabilitiesSchema = Schema.Struct({
  coordinatorPaneLayouts: Schema.Boolean,
  coordinatorUpstreamMerge: Schema.Boolean,
  coordinatorUpstreamAutoMerge: Schema.Boolean,
  noticeDismissals: Schema.Boolean,
  environmentAttention: Schema.Boolean,
});
export type ClientStateCapabilities = typeof ClientStateCapabilitiesSchema.Type;

/** `CoordinatorPaneLayoutRecord`: one project's stored coordinator tab groups. */
export const CoordinatorPaneLayoutRecordSchema = Schema.Struct({
  projectId: Schema.String,
  /** The renderer's tab tree; `sanitizeCoordinatorPaneLayout` validates it. */
  layout: ownedObject<CoordinatorPaneLayout>(),
  revision: Schema.Finite,
  updatedAt: Schema.String,
});

/** `CoordinatorPaneLayoutSaveResult`: a compare-and-swap on `revision`. */
export const CoordinatorPaneLayoutSaveResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("saved"), record: CoordinatorPaneLayoutRecordSchema }),
  Schema.Struct({
    status: Schema.Literal("conflict"),
    current: Schema.NullOr(CoordinatorPaneLayoutRecordSchema),
  }),
]);

/** `CoordinatorUpstreamMergeCheck`: whether to fast-forward before a coordinator message. */
export const CoordinatorUpstreamMergeCheckSchema = Schema.Union([
  Schema.Struct({
    offer: Schema.Literal(true),
    status: ownedObject<ProjectGitStatus>(),
    automatic: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({
    offer: Schema.Literal(false),
    reason: Schema.Literals(COORDINATOR_UPSTREAM_MERGE_SKIP_REASONS),
    status: Schema.NullOr(ownedObject<ProjectGitStatus>()),
  }),
]) as unknown as Schema.Codec<CoordinatorUpstreamMergeCheck>;

/** `DeclinedUpstreamMerge`: retired, still answered for older clients. */
export const DeclinedUpstreamMergeSchema = Schema.Struct({
  upstream: Schema.String,
  upstreamCommit: Schema.String,
});

/** `CoordinatorUpstreamAutoMerge`: the retired "always merge" setting. */
export const CoordinatorUpstreamAutoMergeSchema = Schema.Struct({ enabled: Schema.Boolean });

/** `NoticeDismissalSnapshot`: the stored dismissals and their revision. */
export const NoticeDismissalSnapshotSchema = Schema.Struct({
  revision: Schema.Finite,
  sessions: mutableArray(
    Schema.Struct({
      sessionIdentity: Schema.String,
      occurrenceIds: mutableArray(Schema.String),
    }),
  ),
});

// --- Permission rules (`permission-rules.ts`) ---------------------------------

const PermissionRuleKindSchema = Schema.Literals(PERMISSION_RULE_KINDS);
const PermissionRuleScopeSchema = Schema.Literals(PERMISSION_RULE_SCOPES);
const AgentInteractionProviderSchema = Schema.Literals(AGENT_INTERACTION_PROVIDERS);

/** `NativeAgentPermissionRule`: one of Orkestrator's own permission rules. */
export const PermissionRuleSchema = Schema.Struct({
  id: Schema.String,
  /** The provider the rule answers for; `any` answers every provider. */
  provider: Schema.Union([AgentInteractionProviderSchema, Schema.Literal("any")]),
  scope: PermissionRuleScopeSchema,
  projectId: Schema.String,
  /** Present exactly when `scope` is `environment`. */
  environmentId: optionalString,
  kind: PermissionRuleKindSchema,
  pattern: Schema.String,
  createdAt: Schema.Finite,
  createdFrom: Schema.Struct({
    environmentId: Schema.String,
    agent: AgentInteractionProviderSchema,
    logicalSessionKey: optionalString,
    interactionId: Schema.String,
  }),
  lastUsedAt: optionalNumber,
  useCount: Schema.Finite,
  expiresAt: optionalNumber,
});

/** `PermissionRuleApplication`: what one rule application recorded. */
export const PermissionRuleApplicationSchema = Schema.Struct({
  ruleId: Schema.String,
  kind: PermissionRuleKindSchema,
  pattern: Schema.String,
  scope: PermissionRuleScopeSchema,
  environmentId: Schema.String,
  agent: AgentInteractionProviderSchema,
  logicalSessionKey: Schema.String,
  interactionId: Schema.String,
  appliedAt: Schema.Finite,
});

/** `PermissionRulesSnapshot`. */
export const PermissionRulesSnapshotSchema = Schema.Struct({
  rules: mutableArray(PermissionRuleSchema),
  /** Most recent applications, newest last. Bounded. */
  applications: mutableArray(PermissionRuleApplicationSchema),
});

/** `ExternalPermissionRulesSnapshot`: rules the providers keep in their own files. */
export const ExternalPermissionRulesSnapshotSchema = Schema.Struct({
  files: mutableArray(ownedObject<ExternalPermissionRuleFile>()),
});

/**
 * "Approve and remember": the interaction's outcome (`AgentInteractionApplyOutcome`)
 * and the rule saved for it. Only `result` is required, as in 7001's
 * `InteractionApplyOutcomeSchema`: the native-agent service is faked with
 * partial outcomes in tests, where results are validated.
 */
export const ApproveAndRememberResultSchema = Schema.Struct({
  outcome: Schema.Struct({
    result: Schema.Literals(AGENT_INTERACTION_APPLY_RESULTS),
    interactionId: optionalString,
    sessionId: optionalString,
    revision: optionalNumber,
  }),
  rule: Schema.optional(PermissionRuleSchema),
  ruleSaveWarning: optionalString,
});
