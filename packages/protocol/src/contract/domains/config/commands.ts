/**
 * `config` commands (plan item 7005): the machine's settings (global and per
 * repository) and credentials, the desktop connection catalogue, the shared
 * client state (coordinator pane layouts, upstream merge checks, notice
 * dismissals) and Orkestrator's own permission rules.
 *
 * Arguments follow `projects/commands.ts`: `asString` keys are
 * `Schema.String`, an `asRequiredBoolean` key is `Schema.Boolean`, and every
 * key the handler checks itself (the settings records, nullable credentials,
 * the bounded client-state inputs) is `optionalKey(Unknown)`, so the error
 * text and the order of checks are unchanged. The formerly strict handlers
 * declare exactly the keys they allowed and now drop unknown ones (§11.4).
 *
 * `access`: `admin` for exactly the settings writes the old grant deny-list
 * refused (plan item 7012 replaced it with this field; global settings, notification sounds,
 * the desktop catalogue and the four credentials); `workspace` for the rest.
 * A workspace client's refused global-settings write that would change
 * nothing is still answered with the current settings (`isGlobalConfigEcho`,
 * counter `workspace-grant.config-echo`): the gateway and the relay decide
 * that from the raw arguments before the registry runs, so the definitions
 * leave it unchanged. `read` equals `isNodeReadCommand`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { configDomain } from "./domain.js";
import {
  AppConfigSchema,
  ApproveAndRememberResultSchema,
  ClientStateCapabilitiesSchema,
  ConfigReadSchema,
  CoordinatorPaneLayoutRecordSchema,
  CoordinatorPaneLayoutSaveResultSchema,
  CoordinatorUpstreamAutoMergeSchema,
  CoordinatorUpstreamMergeCheckSchema,
  DeclinedUpstreamMergeSchema,
  DesktopConnectionsSchema,
  ExternalPermissionRulesSnapshotSchema,
  NoticeDismissalSnapshotSchema,
  PermissionRulesSnapshotSchema,
  RepositoryConfigSchema,
} from "./models.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

// --- Settings ----------------------------------------------------------------

/** The settings (credentials redacted), conditionally on a known revision. */
export const getConfigCommand = defineCommand({
  domain: configDomain,
  name: "get_config",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    knownManifestGeneration: optionalUnknown,
    knownResourceRevision: optionalUnknown,
  }),
  result: ConfigReadSchema,
  critical: [],
});

/**
 * Whole-object replace of the global settings, kept for older clients.
 * `preserveInheritedSettings` is critical: ignored, a machine's save would
 * overwrite the preferences its command node owns.
 */
export const updateGlobalConfigCommand = defineCommand({
  domain: configDomain,
  name: "update_global_config",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    global: optionalUnknown,
    preserveInheritedSettings: Schema.optionalKey(Schema.Boolean),
  }),
  result: AppConfigSchema,
  critical: ["preserveInheritedSettings"],
});

/**
 * Merges the given top-level settings under the config lock. `unset` is
 * critical: ignored, a setting the user removed would stay.
 */
export const patchGlobalConfigCommand = defineCommand({
  domain: configDomain,
  name: "patch_global_config",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ patch: optionalUnknown, unset: optionalUnknown }),
  result: AppConfigSchema,
  critical: ["unset"],
});

export const updateNotificationSoundSettingsCommand = defineCommand({
  domain: configDomain,
  name: "update_notification_sound_settings",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ settings: optionalUnknown }),
  result: AppConfigSchema,
  critical: [],
});

/** The startup reminder to set up the GitHub CLI, off or back on. */
export const setGitHubCliReminderDismissedCommand = defineCommand({
  domain: configDomain,
  name: "set_github_cli_reminder_dismissed",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ dismissed: Schema.Boolean }),
  result: AppConfigSchema,
  critical: [],
});

/** Stores or clears (`null`) the GitHub token. */
export const setGitHubTokenCommand = defineCommand({
  domain: configDomain,
  name: "set_github_token",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ token: optionalUnknown }),
  result: AppConfigSchema,
  critical: [],
});

/** Stores or clears (`null`) the Cursor API key. */
export const setCursorApiKeyCommand = defineCommand({
  domain: configDomain,
  name: "set_cursor_api_key",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ apiKey: optionalUnknown }),
  result: AppConfigSchema,
  critical: [],
});

/** Stores or clears (`null`) the Anthropic API key. */
export const setAnthropicApiKeyCommand = defineCommand({
  domain: configDomain,
  name: "set_anthropic_api_key",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ apiKey: optionalUnknown }),
  result: AppConfigSchema,
  critical: [],
});

/** Stores or clears (`null`) the OpenCode Zen API key. */
export const setOpenCodeZenApiKeyCommand = defineCommand({
  domain: configDomain,
  name: "set_opencode_zen_api_key",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ apiKey: optionalUnknown }),
  result: AppConfigSchema,
  critical: [],
});

/** One project's settings, with defaults for a project that has none stored. */
export const getRepositoryConfigCommand = defineCommand({
  domain: configDomain,
  name: "get_repository_config",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String }),
  result: RepositoryConfigSchema,
  critical: [],
});

/** Whole-record replace of one project's settings, kept for older clients. */
export const updateRepositoryConfigCommand = defineCommand({
  domain: configDomain,
  name: "update_repository_config",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: Schema.String, repoConfig: optionalUnknown }),
  result: AppConfigSchema,
  critical: [],
});

/** Changes only the given repository settings. `unset` is critical, as for the global patch. */
export const patchRepositorySettingsCommand = defineCommand({
  domain: configDomain,
  name: "patch_repository_settings",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    updates: optionalUnknown,
    unset: optionalUnknown,
  }),
  result: AppConfigSchema,
  critical: ["unset"],
});

/** The desktop's saved machines. */
export const getDesktopConnectionsCommand = defineCommand({
  domain: configDomain,
  name: "get_desktop_connections",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: DesktopConnectionsSchema,
  critical: [],
});

export const saveDesktopConnectionsCommand = defineCommand({
  domain: configDomain,
  name: "save_desktop_connections",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ desktopConnections: optionalUnknown }),
  result: Schema.Void,
  critical: [],
});

// --- Shared client state ------------------------------------------------------

/**
 * Which shared client state this backend owns. Folded into version 1: the
 * domain client answers it without asking (`CONFIG_CLIENT_STATE_CAPABILITIES`).
 * Kept registered for pre-contract clients.
 */
export const getClientStateCapabilitiesCommand = defineCommand({
  domain: configDomain,
  name: "get_client_state_capabilities",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: ClientStateCapabilitiesSchema,
  critical: [],
});

/** One project's coordinator tab groups, or null. */
export const getCoordinatorPaneLayoutCommand = defineCommand({
  domain: configDomain,
  name: "get_coordinator_pane_layout",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: optionalUnknown }),
  result: Schema.NullOr(CoordinatorPaneLayoutRecordSchema),
  critical: [],
});

/**
 * A compare-and-swap save. `expectedRevision` is critical: ignored, another
 * client's newer layout would be overwritten.
 */
export const saveCoordinatorPaneLayoutCommand = defineCommand({
  domain: configDomain,
  name: "save_coordinator_pane_layout",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: optionalUnknown,
    layout: optionalUnknown,
    expectedRevision: optionalUnknown,
  }),
  result: CoordinatorPaneLayoutSaveResultSchema,
  critical: ["expectedRevision"],
});

/** Whether to fast-forward the checkout before a message to the main coordinator. */
export const checkCoordinatorUpstreamMergeCommand = defineCommand({
  domain: configDomain,
  name: "check_coordinator_upstream_merge",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: optionalUnknown }),
  result: CoordinatorUpstreamMergeCheckSchema,
  critical: [],
});

/** Retired, kept for clients that still send it: a decline changes nothing. */
export const declineCoordinatorUpstreamMergeCommand = defineCommand({
  domain: configDomain,
  name: "decline_coordinator_upstream_merge",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: optionalUnknown,
    upstream: optionalUnknown,
    upstreamCommit: optionalUnknown,
    onlyIfAbsent: optionalUnknown,
  }),
  result: DeclinedUpstreamMergeSchema,
  critical: [],
});

/** Retired "always merge" setting, still answered. */
export const getCoordinatorUpstreamAutoMergeCommand = defineCommand({
  domain: configDomain,
  name: "get_coordinator_upstream_auto_merge",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: optionalUnknown }),
  result: CoordinatorUpstreamAutoMergeSchema,
  critical: [],
});

/** Retired "always merge" setting, still accepted; it changes nothing. */
export const setCoordinatorUpstreamAutoMergeCommand = defineCommand({
  domain: configDomain,
  name: "set_coordinator_upstream_auto_merge",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: optionalUnknown, enabled: optionalUnknown }),
  result: CoordinatorUpstreamAutoMergeSchema,
  critical: [],
});

export const listNoticeDismissalsCommand = defineCommand({
  domain: configDomain,
  name: "list_notice_dismissals",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: NoticeDismissalSnapshotSchema,
  critical: [],
});

export const dismissNoticesCommand = defineCommand({
  domain: configDomain,
  name: "dismiss_notices",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ sessions: optionalUnknown }),
  result: NoticeDismissalSnapshotSchema,
  critical: [],
});

/** Forgets the dismissals of notices a session no longer shows. */
export const reconcileNoticeDismissalsCommand = defineCommand({
  domain: configDomain,
  name: "reconcile_notice_dismissals",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ sessionIdentity: optionalUnknown, activeOccurrenceIds: optionalUnknown }),
  result: NoticeDismissalSnapshotSchema,
  critical: [],
});

// --- Permission rules ---------------------------------------------------------

export const listPermissionRulesCommand = defineCommand({
  domain: configDomain,
  name: "list_permission_rules",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: optionalUnknown,
    environmentId: optionalUnknown,
    agent: optionalUnknown,
    logicalSessionKey: optionalUnknown,
  }),
  result: PermissionRulesSnapshotSchema,
  critical: [],
});

export const deletePermissionRuleCommand = defineCommand({
  domain: configDomain,
  name: "delete_permission_rule",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.Struct({ deleted: Schema.Boolean }),
  critical: [],
});

export const deleteProjectPermissionRulesCommand = defineCommand({
  domain: configDomain,
  name: "delete_project_permission_rules",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: Schema.String }),
  result: Schema.Struct({ deleted: Schema.Finite }),
  critical: [],
});

/**
 * "Approve and remember": answers a pending request and saves the rule the
 * person chose. `expiresInMs` is critical: ignored, the rule would never
 * expire.
 */
export const approveNativeAgentInteractionAndRememberCommand = defineCommand({
  domain: configDomain,
  name: "approve_native_agent_interaction_and_remember",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: optionalUnknown,
    agent: optionalUnknown,
    logicalSessionKey: optionalUnknown,
    interactionId: optionalUnknown,
    pattern: optionalUnknown,
    scope: optionalUnknown,
    anyProvider: optionalUnknown,
    expiresInMs: optionalUnknown,
  }),
  result: ApproveAndRememberResultSchema,
  critical: ["expiresInMs"],
});

/** Rules the providers keep in their own files, read-only. */
export const listExternalPermissionRulesCommand = defineCommand({
  domain: configDomain,
  name: "list_external_permission_rules",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: optionalUnknown }),
  result: ExternalPermissionRulesSnapshotSchema,
  critical: [],
});

/** Every `config` command definition. */
export const CONFIG_COMMANDS = [
  getConfigCommand,
  updateGlobalConfigCommand,
  patchGlobalConfigCommand,
  updateNotificationSoundSettingsCommand,
  setGitHubCliReminderDismissedCommand,
  setGitHubTokenCommand,
  setCursorApiKeyCommand,
  setAnthropicApiKeyCommand,
  setOpenCodeZenApiKeyCommand,
  getRepositoryConfigCommand,
  updateRepositoryConfigCommand,
  patchRepositorySettingsCommand,
  getDesktopConnectionsCommand,
  saveDesktopConnectionsCommand,
  getClientStateCapabilitiesCommand,
  getCoordinatorPaneLayoutCommand,
  saveCoordinatorPaneLayoutCommand,
  checkCoordinatorUpstreamMergeCommand,
  declineCoordinatorUpstreamMergeCommand,
  getCoordinatorUpstreamAutoMergeCommand,
  setCoordinatorUpstreamAutoMergeCommand,
  listNoticeDismissalsCommand,
  dismissNoticesCommand,
  reconcileNoticeDismissalsCommand,
  listPermissionRulesCommand,
  deletePermissionRuleCommand,
  deleteProjectPermissionRulesCommand,
  approveNativeAgentInteractionAndRememberCommand,
  listExternalPermissionRulesCommand,
] as const;
