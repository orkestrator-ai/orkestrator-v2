/**
 * `agent-servers` commands (plan item 7009): container and local agent
 * bridges (start, stop, status, log tail, readiness, the backend's own
 * peeks), host CLI and credential checks, the GitHub CLI sign-in, model
 * catalogues, and agent skills and plugins.
 *
 * Argument schemas declare every key a handler reads and decode tolerantly
 * (§11.4). A key the handler required with `asString` is `Schema.String` (the
 * same "Expected containerId to be a string" text); a key it reads leniently
 * (`=== true`), or checks with its own message (`provider`, `agent`,
 * `ensureAgent`, the catalogue `models`), is `optionalKey(Unknown)`, so
 * nothing accepted before is refused and every message is unchanged. Fields
 * are in the order the handler checks them, because a decode reports the
 * first failure.
 *
 * The per-agent bridge commands are built from one factory each
 * (`start_<agent>_server`, `start_local_<agent>_server_cmd`, ...), because the
 * backend registers and the backend's own callers build those names from the
 * agent (`native-agent-service.ts`, `graph-agent-providers.ts`,
 * `build-pipeline-service-agents.ts`, `await_bridge_ready`).
 *
 * `access` is `workspace` (no command here is workspace-excluded, and a
 * leaf's workspace window reads its CLIs, catalogues and skills), except the
 * two bridge peeks, which only the backend's own native-agent service calls
 * (`internal`). `read` equals `isNodeReadCommand(name)`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { agentServersDomain } from "./domain.js";
import {
  AgentModelCatalogCacheSchema,
  AgentModelSchema,
  AgentPluginCatalogSchema,
  AgentSkillFileSchema,
  AgentSkillScanSchema,
  AwaitBridgeReadySchema,
  ClaudeModelCatalogSnapshotSchema,
  ContainerBridgePeekSchema,
  ContainerGitHubCredentialStatusSchema,
  ContainerServerStartSchema,
  ContainerServerStatusSchema,
  CredentialStatusSchema,
  EnvironmentAgentSkillFileSchema,
  EnvironmentAgentSkillScanSchema,
  GitHubCliLoginProgressSchema,
  GitHubCliStatusSchema,
  HostModelCatalogRefreshSchema,
  LocalBridgePeekSchema,
  LocalServerStartSchema,
  LocalServerStatusSchema,
  NativeAgentModelCatalogSchema,
  OpenCodeModelCatalogSnapshotSchema,
  OpenCodeModelPreferencesSchema,
  type AgentServerKind,
} from "./schemas.js";

export * from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const NoArgs = Schema.Struct({});
const ContainerArgs = Schema.Struct({ containerId: Schema.String });
const LocalArgs = Schema.Struct({ environmentId: Schema.String });

// --- Container bridges ----------------------------------------------------

function containerServerStart<const A extends AgentServerKind>(agent: A) {
  return defineCommand({
    domain: agentServersDomain,
    name: `start_${agent}_server`,
    since: 1,
    access: "workspace",
    read: false,
    args: ContainerArgs,
    result: ContainerServerStartSchema,
    critical: [],
  });
}

function containerServerStop<const A extends AgentServerKind>(agent: A) {
  return defineCommand({
    domain: agentServersDomain,
    name: `stop_${agent}_server`,
    since: 1,
    access: "workspace",
    read: false,
    args: ContainerArgs,
    result: Schema.Void,
    critical: [],
  });
}

function containerServerStatus<const A extends AgentServerKind>(agent: A) {
  return defineCommand({
    domain: agentServersDomain,
    name: `get_${agent}_server_status`,
    since: 1,
    access: "workspace",
    read: true,
    args: ContainerArgs,
    result: ContainerServerStatusSchema,
    critical: [],
  });
}

/** A container bridge's bounded, redacted log tail; `previous` reads the run before. */
function containerServerLog<const A extends AgentServerKind>(agent: A) {
  return defineCommand({
    domain: agentServersDomain,
    name: `get_${agent}_server_log`,
    since: 1,
    access: "workspace",
    read: true,
    args: Schema.Struct({ containerId: Schema.String, previous: optionalUnknown }),
    result: Schema.String,
    // Ignored, the current run's log would be shown as the crashed run's.
    critical: ["previous"],
  });
}

export const startOpencodeServerCommand = containerServerStart("opencode");
export const stopOpencodeServerCommand = containerServerStop("opencode");
export const getOpencodeServerStatusCommand = containerServerStatus("opencode");
export const getOpencodeServerLogCommand = containerServerLog("opencode");
export const startClaudeServerCommand = containerServerStart("claude");
export const stopClaudeServerCommand = containerServerStop("claude");
export const getClaudeServerStatusCommand = containerServerStatus("claude");
export const getClaudeServerLogCommand = containerServerLog("claude");
export const startCodexServerCommand = containerServerStart("codex");
export const stopCodexServerCommand = containerServerStop("codex");
export const getCodexServerStatusCommand = containerServerStatus("codex");
export const getCodexServerLogCommand = containerServerLog("codex");
export const startCursorServerCommand = containerServerStart("cursor");
export const stopCursorServerCommand = containerServerStop("cursor");
export const getCursorServerStatusCommand = containerServerStatus("cursor");
export const getCursorServerLogCommand = containerServerLog("cursor");
export const startGrokServerCommand = containerServerStart("grok");
export const stopGrokServerCommand = containerServerStop("grok");
export const getGrokServerStatusCommand = containerServerStatus("grok");
export const getGrokServerLogCommand = containerServerLog("grok");
export const startPiServerCommand = containerServerStart("pi");
export const stopPiServerCommand = containerServerStop("pi");
export const getPiServerStatusCommand = containerServerStatus("pi");
export const getPiServerLogCommand = containerServerLog("pi");

// --- Local bridges --------------------------------------------------------

function localServerStart<const A extends AgentServerKind>(agent: A) {
  return defineCommand({
    domain: agentServersDomain,
    name: `start_local_${agent}_server_cmd`,
    since: 1,
    access: "workspace",
    read: false,
    args: LocalArgs,
    result: LocalServerStartSchema,
    critical: [],
  });
}

function localServerStop<const A extends AgentServerKind>(agent: A) {
  return defineCommand({
    domain: agentServersDomain,
    name: `stop_local_${agent}_server_cmd`,
    since: 1,
    access: "workspace",
    read: false,
    args: LocalArgs,
    result: Schema.Void,
    critical: [],
  });
}

function localServerStatus<const A extends AgentServerKind>(agent: A) {
  return defineCommand({
    domain: agentServersDomain,
    name: `get_local_${agent}_server_status`,
    since: 1,
    access: "workspace",
    read: true,
    args: LocalArgs,
    result: LocalServerStatusSchema,
    critical: [],
  });
}

export const startLocalOpencodeServerCommand = localServerStart("opencode");
export const stopLocalOpencodeServerCommand = localServerStop("opencode");
export const getLocalOpencodeServerStatusCommand = localServerStatus("opencode");
export const startLocalClaudeServerCommand = localServerStart("claude");
export const stopLocalClaudeServerCommand = localServerStop("claude");
export const getLocalClaudeServerStatusCommand = localServerStatus("claude");
export const startLocalCodexServerCommand = localServerStart("codex");
export const stopLocalCodexServerCommand = localServerStop("codex");
export const getLocalCodexServerStatusCommand = localServerStatus("codex");
export const startLocalCursorServerCommand = localServerStart("cursor");
export const stopLocalCursorServerCommand = localServerStop("cursor");
export const getLocalCursorServerStatusCommand = localServerStatus("cursor");
export const startLocalGrokServerCommand = localServerStart("grok");
export const stopLocalGrokServerCommand = localServerStop("grok");
export const getLocalGrokServerStatusCommand = localServerStatus("grok");
export const startLocalPiServerCommand = localServerStart("pi");
export const stopLocalPiServerCommand = localServerStop("pi");
export const getLocalPiServerStatusCommand = localServerStatus("pi");

/**
 * A no-op kept from the Tauri era (stale local servers are reaped at startup
 * now). Retired: no caller in the support window; counted
 * (`retired-command.cleanup-stale-local-servers`) until it is removed.
 */
export const cleanupStaleLocalServersCommand = defineCommand({
  domain: agentServersDomain,
  name: "cleanup_stale_local_servers_cmd",
  since: 1,
  access: "workspace",
  read: false,
  args: NoArgs,
  result: Schema.Void,
  critical: [],
});

/** Joins the backend-owned startup wait for one environment and agent. */
export const awaitBridgeReadyCommand = defineCommand({
  domain: agentServersDomain,
  name: "await_bridge_ready",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    agent: optionalUnknown,
    timeoutMs: Schema.Finite,
  }),
  result: AwaitBridgeReadySchema,
  critical: [],
});

/** A running local bridge's endpoint, without starting one (the activity sweep). */
export const peekLocalAgentBridgeCommand = defineCommand({
  domain: agentServersDomain,
  name: "peek_local_agent_bridge",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ environmentId: Schema.String, agent: optionalUnknown }),
  result: LocalBridgePeekSchema,
  critical: [],
});

/** A healthy container bridge's endpoint, without starting one. */
export const peekContainerAgentBridgeCommand = defineCommand({
  domain: agentServersDomain,
  name: "peek_container_agent_bridge",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ containerId: Schema.String, agent: optionalUnknown }),
  result: ContainerBridgePeekSchema,
  critical: [],
});

// --- Model catalogues -----------------------------------------------------

export const getOpencodeModelPreferencesCommand = defineCommand({
  domain: agentServersDomain,
  name: "get_opencode_model_preferences",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: OpenCodeModelPreferencesSchema,
  critical: [],
});

export const getOpencodeModelCatalogCacheCommand = defineCommand({
  domain: agentServersDomain,
  name: "get_opencode_model_catalog_cache",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String }),
  result: Schema.NullOr(OpenCodeModelCatalogSnapshotSchema),
  critical: [],
});

export const cacheOpencodeModelCatalogCommand = defineCommand({
  domain: agentServersDomain,
  name: "cache_opencode_model_catalog",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: Schema.String, models: optionalUnknown }),
  result: OpenCodeModelCatalogSnapshotSchema,
  critical: [],
});

export const getClaudeModelCatalogCommand = defineCommand({
  domain: agentServersDomain,
  name: "get_claude_model_catalog",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Schema.String, forceRefresh: optionalUnknown }),
  result: ClaudeModelCatalogSnapshotSchema,
  critical: [],
});

export const ensureHostPiModelCatalogCommand = defineCommand({
  domain: agentServersDomain,
  name: "ensure_host_pi_model_catalog",
  since: 1,
  access: "workspace",
  read: false,
  args: NoArgs,
  result: Schema.Array(AgentModelSchema),
  critical: [],
});

export const refreshHostAgentModelCatalogCommand = defineCommand({
  domain: agentServersDomain,
  name: "refresh_host_agent_model_catalog",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ agent: Schema.String, projectId: optionalUnknown }),
  result: HostModelCatalogRefreshSchema,
  critical: [],
});

export const getAgentModelCatalogCacheCommand = defineCommand({
  domain: agentServersDomain,
  name: "get_agent_model_catalog_cache",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ seed: optionalUnknown }),
  result: AgentModelCatalogCacheSchema,
  critical: [],
});

export const getNativeAgentModelCatalogCommand = defineCommand({
  domain: agentServersDomain,
  name: "get_native_agent_model_catalog",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Schema.String, ensureAgent: optionalUnknown }),
  result: NativeAgentModelCatalogSchema,
  critical: [],
});

export const cacheAgentModelCatalogCommand = defineCommand({
  domain: agentServersDomain,
  name: "cache_agent_model_catalog",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ agent: Schema.String, models: optionalUnknown }),
  result: AgentModelCatalogCacheSchema,
  critical: [],
});

// --- Skills and plugins ---------------------------------------------------

export const listAgentSkillsCommand = defineCommand({
  domain: agentServersDomain,
  name: "list_agent_skills",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ provider: optionalUnknown }),
  result: AgentSkillScanSchema,
  critical: [],
});

export const listAgentPluginsCommand = defineCommand({
  domain: agentServersDomain,
  name: "list_agent_plugins",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ provider: optionalUnknown }),
  result: AgentPluginCatalogSchema,
  critical: [],
});

export const readAgentSkillCommand = defineCommand({
  domain: agentServersDomain,
  name: "read_agent_skill",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ provider: optionalUnknown, filePath: Schema.String }),
  result: AgentSkillFileSchema,
  critical: [],
});

export const listEnvironmentAgentSkillsCommand = defineCommand({
  domain: agentServersDomain,
  name: "list_environment_agent_skills",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Schema.String, provider: optionalUnknown }),
  result: EnvironmentAgentSkillScanSchema,
  critical: [],
});

export const readEnvironmentAgentSkillCommand = defineCommand({
  domain: agentServersDomain,
  name: "read_environment_agent_skill",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
    provider: optionalUnknown,
    filePath: Schema.String,
  }),
  result: EnvironmentAgentSkillFileSchema,
  critical: [],
});

// --- Host CLIs and credentials --------------------------------------------

function hostCheck<const Name extends string>(name: Name, read: boolean) {
  return defineCommand({
    domain: agentServersDomain,
    name,
    since: 1,
    access: "workspace",
    read,
    args: NoArgs,
    result: Schema.Boolean,
    critical: [],
  });
}

export const hasClaudeCredentialsCommand = hostCheck("has_claude_credentials", false);
export const checkClaudeCliCommand = hostCheck("check_claude_cli", true);
export const checkClaudeConfigCommand = hostCheck("check_claude_config", true);
/**
 * The per-provider CLI checks the renderer stopped calling before the support
 * floor (v2.21.0 calls only `check_claude_cli`, `check_github_cli` and
 * `check_any_ai_cli`). Retired: counted (`retired-command.provider-cli-check`)
 * until they are removed.
 */
export const checkOpencodeCliCommand = hostCheck("check_opencode_cli", true);
export const checkCodexCliCommand = hostCheck("check_codex_cli", true);
export const checkCursorCliCommand = hostCheck("check_cursor_cli", true);
export const checkGrokCliCommand = hostCheck("check_grok_cli", true);
export const checkPiCliCommand = hostCheck("check_pi_cli", true);
export const checkGithubCliCommand = hostCheck("check_github_cli", true);
export const checkAnyAiCliCommand = hostCheck("check_any_ai_cli", true);

export const getCredentialStatusCommand = defineCommand({
  domain: agentServersDomain,
  name: "get_credential_status",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: CredentialStatusSchema,
  critical: [],
});

/** The first available AI CLI (`claude`, `opencode`, `codex`, `cursor`, `grok`, `pi`), or `null`. */
export const getAvailableAiCliCommand = defineCommand({
  domain: agentServersDomain,
  name: "get_available_ai_cli",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: Schema.NullOr(Schema.String),
  critical: [],
});

export const getContainerGithubCredentialStatusCommand = defineCommand({
  domain: agentServersDomain,
  name: "get_container_github_credential_status",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: ContainerGitHubCredentialStatusSchema,
  critical: [],
});

export const getGithubCliStatusCommand = defineCommand({
  domain: agentServersDomain,
  name: "get_github_cli_status",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: GitHubCliStatusSchema,
  critical: [],
});

export const startGithubCliLoginCommand = defineCommand({
  domain: agentServersDomain,
  name: "start_github_cli_login",
  since: 1,
  access: "workspace",
  read: false,
  args: NoArgs,
  result: GitHubCliLoginProgressSchema,
  critical: [],
});

export const getGithubCliLoginCommand = defineCommand({
  domain: agentServersDomain,
  name: "get_github_cli_login",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: GitHubCliLoginProgressSchema,
  critical: [],
});

export const cancelGithubCliLoginCommand = defineCommand({
  domain: agentServersDomain,
  name: "cancel_github_cli_login",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ operationId: Schema.optionalKey(Schema.String) }),
  result: GitHubCliLoginProgressSchema,
  // The sign-in it names; ignored, a newer sign-in would be cancelled instead.
  critical: ["operationId"],
});

/** Every defined `agent-servers` command. */
export const AGENT_SERVERS_COMMANDS = [
  startOpencodeServerCommand,
  stopOpencodeServerCommand,
  getOpencodeServerStatusCommand,
  getOpencodeServerLogCommand,
  startClaudeServerCommand,
  stopClaudeServerCommand,
  getClaudeServerStatusCommand,
  getClaudeServerLogCommand,
  startCodexServerCommand,
  stopCodexServerCommand,
  getCodexServerStatusCommand,
  getCodexServerLogCommand,
  startCursorServerCommand,
  stopCursorServerCommand,
  getCursorServerStatusCommand,
  getCursorServerLogCommand,
  startGrokServerCommand,
  stopGrokServerCommand,
  getGrokServerStatusCommand,
  getGrokServerLogCommand,
  startPiServerCommand,
  stopPiServerCommand,
  getPiServerStatusCommand,
  getPiServerLogCommand,
  startLocalOpencodeServerCommand,
  stopLocalOpencodeServerCommand,
  getLocalOpencodeServerStatusCommand,
  startLocalClaudeServerCommand,
  stopLocalClaudeServerCommand,
  getLocalClaudeServerStatusCommand,
  startLocalCodexServerCommand,
  stopLocalCodexServerCommand,
  getLocalCodexServerStatusCommand,
  startLocalCursorServerCommand,
  stopLocalCursorServerCommand,
  getLocalCursorServerStatusCommand,
  startLocalGrokServerCommand,
  stopLocalGrokServerCommand,
  getLocalGrokServerStatusCommand,
  startLocalPiServerCommand,
  stopLocalPiServerCommand,
  getLocalPiServerStatusCommand,
  cleanupStaleLocalServersCommand,
  awaitBridgeReadyCommand,
  peekLocalAgentBridgeCommand,
  peekContainerAgentBridgeCommand,
  getOpencodeModelPreferencesCommand,
  getOpencodeModelCatalogCacheCommand,
  cacheOpencodeModelCatalogCommand,
  getClaudeModelCatalogCommand,
  ensureHostPiModelCatalogCommand,
  refreshHostAgentModelCatalogCommand,
  getAgentModelCatalogCacheCommand,
  getNativeAgentModelCatalogCommand,
  cacheAgentModelCatalogCommand,
  listAgentSkillsCommand,
  listAgentPluginsCommand,
  readAgentSkillCommand,
  listEnvironmentAgentSkillsCommand,
  readEnvironmentAgentSkillCommand,
  hasClaudeCredentialsCommand,
  checkClaudeCliCommand,
  checkClaudeConfigCommand,
  checkOpencodeCliCommand,
  checkCodexCliCommand,
  checkCursorCliCommand,
  checkGrokCliCommand,
  checkPiCliCommand,
  checkGithubCliCommand,
  checkAnyAiCliCommand,
  getCredentialStatusCommand,
  getAvailableAiCliCommand,
  getContainerGithubCredentialStatusCommand,
  getGithubCliStatusCommand,
  startGithubCliLoginCommand,
  getGithubCliLoginCommand,
  cancelGithubCliLoginCommand,
] as const;
