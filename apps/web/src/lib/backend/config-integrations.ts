import { coordinatorApi } from "@/lib/node-scope/domains/coordinator";
import { asWebModel, nativeSessions } from "@/lib/node-scope/domains/native-sessions";
import { asKanbanModel, kanban, NO_ARGS } from "@/lib/node-scope/domains/kanban";
import type {
  DatabaseStats,
  DiagnosticsBundleChunk,
  DiagnosticsBundlePlan,
} from "@orkestrator/protocol/backend-diagnostics";
import type {
  ControlMcpCredentialSummary,
  ControlMcpProfile,
} from "@orkestrator/protocol/control-mcp";
import type { PublicCapability } from "@orkestrator/protocol/public-api-inputs";
import {
  invokeGlobalConfigCommand,
  invokeRepositoryConfigCommand,
} from "@/lib/portal/command-node-config";
import { getGatewayBaseUrl, resolveGatewayLoopbackBaseUrl } from "@/lib/gateway-url";
import { shellOpenExternal } from "@/lib/native/shell";
import type {
  Environment,
  AppConfig,
  GlobalConfig,
  GatewayTokenSettings,
  WebClientStatus,
  RepositoryConfig,
  CursorSdkAuthStatus,
  CursorSdkLoginProgress,
} from "@/types";
import type {
  LinearConnectionStatus,
  LinearIssueComment,
  LinearIssueDetail,
  LinearIssueListItem,
} from "@/types/linear";
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueDetail,
  GitHubIssuesSnapshot,
  GitHubIssueStatus,
} from "@/types/github";
import { agentServersApi } from "@/lib/node-scope/domains/agent-servers";
import type { AgentModelCatalogCache } from "@orkestrator/protocol/contract/domains/agent-servers";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import { accountsOn } from "@/lib/node-scope/domains/accounts";
import { pullRequests } from "@/lib/node-scope/domains/pull-requests";
import { systemApiOn } from "@/lib/node-scope/domains/system";
import { type AccountMachine } from "./agent-accounts";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { environmentsClient } from "@orkestrator/protocol/contract/domains/environments";
import {
  commandBackendClient,
  machineInvoker,
  type BackendClient,
  machineBackendClient,
  withArgumentsObject,
} from "./client";
import { domainApi } from "@/lib/node-scope/domains/domain-api";
import { config as configDomain } from "@/lib/node-scope/domains/config";

/**
 * Workspace machine settings with the command node's inherited preferences.
 * `machine` reads another machine's, as Settings does for the one it edits.
 */
/**
 * The Cursor SDK login's web types (`types/index.ts`) are the `accounts`
 * schemas' types made mutable (plan item 7010); the client answers the
 * schemas' readonly form.
 */
function asCursorModel<T>(result: Promise<unknown>): Promise<T> {
  return result as Promise<T>;
}

export async function getConfig(machine?: AccountMachine): Promise<AppConfig> {
  return invokeGlobalConfigCommand("get_config", undefined, machine);
}

/** The host-wide model catalogues: the `agent-servers` domain's type (plan item 7010). */
export type { AgentModelCatalogCache } from "@orkestrator/protocol/contract/domains/agent-servers";

/** Force a provider's host catalogue to refresh without creating an environment. */
type NonOpenCodeAgent = Exclude<
  import("@orkestrator/protocol/agent-platforms").AgentPlatform,
  "opencode"
>;
type HostModelCatalogRefreshResult = {
  agent: import("@orkestrator/protocol/agent-platforms").AgentPlatform;
  modelCount: number;
};

/**
 * Replace the whole stored global. Kept for compatibility; it overwrites
 * whatever another client changed since this copy was loaded, so new callers
 * use `patchGlobalConfig`.
 */
export async function updateGlobalConfig(
  global: GlobalConfig,
  machine?: AccountMachine,
): Promise<AppConfig> {
  return invokeGlobalConfigCommand("update_global_config", { global }, machine);
}

/**
 * Change only the given top-level settings. The backend merges them onto its
 * current global under the config lock, so concurrent edits of other fields
 * from another window or machine survive. `unset` removes keys.
 */
export async function patchGlobalConfig(
  patch: Partial<GlobalConfig>,
  options: { unset?: readonly (keyof GlobalConfig)[]; machine?: AccountMachine } = {},
): Promise<AppConfig> {
  const unset = options.unset ?? [];
  return invokeGlobalConfigCommand(
    "patch_global_config",
    { patch, ...(unset.length > 0 ? { unset: [...unset] } : {}) },
    options.machine,
  );
}

/** Turn the startup reminder to set up the GitHub CLI off, or back on. */
export async function setGitHubCliReminderDismissed(dismissed: boolean): Promise<AppConfig> {
  return invokeGlobalConfigCommand("set_github_cli_reminder_dismissed", { dismissed });
}

export async function updateNotificationSoundSettings(
  settings: import("@orkestrator/protocol/notification-sounds").NotificationSoundSettings,
  machine?: AccountMachine,
): Promise<AppConfig> {
  return invokeGlobalConfigCommand("update_notification_sound_settings", { settings }, machine);
}

export async function setGitHubToken(
  token: string | null,
  machine?: AccountMachine,
): Promise<AppConfig> {
  return invokeGlobalConfigCommand("set_github_token", { token }, machine);
}

export async function setCursorApiKey(
  apiKey: string | null,
  machine?: AccountMachine,
): Promise<AppConfig> {
  return invokeGlobalConfigCommand("set_cursor_api_key", { apiKey }, machine);
}

export async function setAnthropicApiKey(
  apiKey: string | null,
  machine?: AccountMachine,
): Promise<AppConfig> {
  return invokeGlobalConfigCommand("set_anthropic_api_key", { apiKey }, machine);
}

export async function setOpenCodeZenApiKey(
  apiKey: string | null,
  machine?: AccountMachine,
): Promise<AppConfig> {
  return invokeGlobalConfigCommand("set_opencode_zen_api_key", { apiKey }, machine);
}

export async function getWebClientStatus(): Promise<WebClientStatus> {
  if (window.orkestrator?.webClient) {
    return window.orkestrator.webClient.getStatus();
  }
  if (window.orkestratorGateway?.enabled) {
    return {
      enabled: true,
      running: true,
      url: `${getGatewayBaseUrl()}/`,
      error: null,
    };
  }
  throw new Error("Web client controls are only available in the desktop app");
}

export async function setWebClientEnabled(enabled: boolean): Promise<WebClientStatus> {
  if (!window.orkestrator?.webClient) {
    throw new Error("Web client controls are only available in the desktop app");
  }
  return window.orkestrator.webClient.setEnabled(enabled);
}

export async function resetWebClientServe(): Promise<WebClientStatus> {
  if (!window.orkestrator?.webClient || window.orkestratorGateway?.enabled) {
    throw new Error("Tailscale Serve reset is only available for the local desktop app");
  }
  return window.orkestrator.webClient.resetServe();
}

export async function getGatewayTokenSettings(): Promise<GatewayTokenSettings> {
  if (!window.orkestrator?.webClient) {
    throw new Error("Gateway token settings are unavailable");
  }
  return window.orkestrator.webClient.getTokenSettings();
}

export async function setGatewayToken(token: string): Promise<GatewayTokenSettings> {
  if (!window.orkestrator?.webClient) {
    throw new Error("Gateway token settings are unavailable");
  }
  return window.orkestrator.webClient.setToken(token);
}

export interface ControlMcpSettings {
  enabled: boolean;
  running: boolean;
  url: string;
  /** The `default` credential's token. */
  token: string;
  error: string | null;
  credentials: ControlMcpCredentialSummary[];
}

export interface CreateControlMcpCredentialInput {
  label: string;
  profile: ControlMcpProfile;
  /** Omitted: the profile's preset. Required for `custom`. */
  capabilities?: PublicCapability[];
}

export async function updateRepositoryConfig(
  projectId: string,
  repoConfig: RepositoryConfig,
): Promise<AppConfig> {
  return invokeRepositoryConfigCommand("update_repository_config", { projectId, repoConfig });
}

/**
 * Change only the repository settings the user edited. `fallback` is the
 * whole record the form would have saved; it is sent with the older replace
 * command only to a backend that predates the patch.
 */
export async function patchRepositorySettings(
  projectId: string,
  updates: Partial<RepositoryConfig>,
  unset: readonly (keyof RepositoryConfig)[],
  fallback: RepositoryConfig,
): Promise<AppConfig> {
  try {
    return await invokeRepositoryConfigCommand("patch_repository_settings", {
      projectId,
      updates,
      ...(unset.length > 0 ? { unset: [...unset] } : {}),
    });
  } catch (error) {
    if (incompatibility(error, "patch_repository_settings")?.code !== "unknown-command")
      throw error;
    return updateRepositoryConfig(projectId, fallback);
  }
}

export interface LogStorageStats {
  /** The always-on essential log. A backend older than it leaves these out. */
  essentialBytes?: number;
  essentialFileCount?: number;
  totalBytes: number;
  fileCount: number;
}

// --- Linear Commands ---

import type { GitHubCompletionCommentResult } from "@orkestrator/protocol/contract/domains/pull-requests";
export type { GitHubCompletionCommentResult };

// --- GitHub Commands ---

/** What a held setup would run, and what the default branch runs instead. */
export interface EnvironmentSetupApproval {
  environmentId: string;
  projectId: string;
  /** Pass back unchanged to approve exactly these commands. */
  hash: string;
  commands: string[];
  defaultBranch: string;
  /** `null` when the default branch could not be read. */
  defaultBranchCommands: string[] | null;
  approvalRequired: boolean;
}

/** Merge method options for PR merging */
export type MergeMethod = "squash" | "merge" | "rebase";

/** The merge results are the `pull-requests` domain's (plan item 7006). */
import type {
  MergeEnvironmentPrResult,
  MergePrResult,
} from "@orkestrator/protocol/contract/domains/pull-requests";
export type { MergeEnvironmentPrResult, MergePrResult };

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createConfigIntegrationsApi(client: BackendClient) {
  // GitHub issues and the environment PR commands (`pull-requests`, plan item 7006).
  const prDomain = () => pullRequests(client);
  // The machine's own settings commands here (`config` domain, plan item 7005);
  // the layered reads and saves go through `command-node-config.ts`.
  const settings = configDomain(client);
  // The Control MCP settings and credentials (`coordinator` domain, plan item 7009).
  const coordinator = () => coordinatorApi(client);
  // The `environments` domain's commands here (plan item 7003).
  const environments = () => domainApi(client, environmentsClient);
  // The machine-aware functions sent through `machineInvoke`, which always
  // passes an arguments object; their calls keep that shape.
  const ownMachineEnvironments = () => domainApi(withArgumentsObject(client), environmentsClient);
  const environmentsOn = (machine: AccountMachine) =>
    machine === undefined
      ? ownMachineEnvironments()
      : domainApi(machineBackendClient(client, machine), environmentsClient);
  const native = () => nativeSessions(client);
  const machineInvoke = machineInvoker(client);
  // Plan usage and the Cursor SDK login are in the `accounts` domain (plan item 7008).
  const accountsOn_ = accountsOn(client);

  // The `agent-servers` domain's catalogue commands (plan item 7009), on this
  // client's node or, through `machineInvoke`, on another one.
  const agentServers = () => agentServersApi(client);
  const agentServersOn = (machine: AccountMachine) =>
    machine === undefined
      ? agentServers()
      : agentServersApi({
          invokeRaw: <T>(command: string, args?: Readonly<Record<string, unknown>>) =>
            machineInvoke<T>(machine, command, args as Record<string, unknown> | undefined),
        });

  /**
   * Load the host-wide last-known-good catalogues, seeding Pi on first use. With
   * `seed: true`, the backend also downloads every enabled platform's missing
   * catalogue before answering, so only a caller that can wait in the background
   * asks for it. `seed: false` reads the cache exactly as stored, with no Pi
   * probe, for startup's read before its first render. An older backend treats
   * `false` as omitted. `machine` selects the node whose catalogue is read.
   */
  async function getAgentModelCatalogCache(
    machine?: AccountMachine,
    options: { seed?: boolean } = {},
  ): Promise<AgentModelCatalogCache> {
    const args = options.seed === undefined ? undefined : { seed: options.seed };
    // Without `seed`, today's call sends no arguments object to this node.
    return asWebModel<AgentModelCatalogCache>(
      agentServersOn(machine).get_agent_model_catalog_cache(
        (machine === undefined ? args : (args ?? {})) as { seed?: boolean },
      ),
    );
  }

  /** Discover Pi models without requiring an environment or persistent bridge. */
  async function ensureHostPiModelCatalog(): Promise<
    import("@orkestrator/protocol/native-agent").AgentModel[]
  > {
    return asWebModel<import("@orkestrator/protocol/native-agent").AgentModel[]>(
      agentServers().ensure_host_pi_model_catalog(undefined as never),
    );
  }

  function refreshHostAgentModelCatalog(
    agent: "opencode",
    projectId: string,
    machine?: AccountMachine,
  ): Promise<HostModelCatalogRefreshResult>;

  function refreshHostAgentModelCatalog(
    agent: NonOpenCodeAgent,
    projectId?: never,
    machine?: AccountMachine,
  ): Promise<HostModelCatalogRefreshResult>;

  async function refreshHostAgentModelCatalog(
    agent: import("@orkestrator/protocol/agent-platforms").AgentPlatform,
    projectId?: string,
    machine?: AccountMachine,
  ): Promise<HostModelCatalogRefreshResult> {
    return asWebModel<HostModelCatalogRefreshResult>(
      agentServersOn(machine).refresh_host_agent_model_catalog({
        agent,
        ...(projectId ? { projectId } : {}),
      }),
    );
  }

  /** Backend-normalized model catalogue consumed by the provider-neutral composer. */
  async function getNativeAgentModelCatalog(
    environmentId: string,
    ensureAgent?: AgentPlatform,
  ): Promise<import("@orkestrator/protocol/native-agent").AgentModel[]> {
    if (!ensureAgent) {
      return asWebModel<import("@orkestrator/protocol/native-agent").AgentModel[]>(
        agentServers().get_native_agent_model_catalog({ environmentId }),
      );
    }
    const result = await asWebModel<{
      models: import("@orkestrator/protocol/native-agent").AgentModel[];
      status: "ready" | "empty" | "failed";
    }>(agentServers().get_native_agent_model_catalog({ environmentId, ensureAgent }));
    if (!result || !Array.isArray(result.models)) {
      throw new Error("The native model catalogue response was malformed");
    }
    if (result.status === "failed") {
      throw new Error(
        `The ${ensureAgent ?? "native agent"} model catalogue is temporarily unavailable`,
      );
    }
    return result.models;
  }

  /**
   * The client's node's own global settings, without inherited preferences.
   * The effective view is `getConfig()` (or `runConfigCommand` for explicit
   * scopes).
   */

  /** Read one platform's plan/quota windows from the backend. */
  async function getPlanUsage(
    platform: AgentPlatform,
    options: { force?: boolean; cacheOnly?: boolean } = {},
    machine?: AccountMachine,
  ): Promise<PlanUsageSnapshot> {
    return accountsOn_(machine).get_plan_usage({
      platform,
      ...(options.force ? { force: true } : {}),
      ...(options.cacheOnly ? { cacheOnly: true } : {}),
    });
  }

  /**
   * Experimental Cursor SDK sign-in.
   *
   * Start returns the URL to open; the flow itself runs in the backend, which
   * spawns the bridge, parses its output and stores the credential. Callers open
   * the URL in this client's browser (`openInBrowser`) and poll
   * `cursorSdkLoginStatus` until it leaves `pending`; the backend's login child
   * opens no browser of its own. `machine` names another node to sign in,
   * through the command node.
   */
  async function cursorSdkLoginStart(machine?: AccountMachine): Promise<{ loginUrl: string }> {
    return accountsOn_(machine).cursor_sdk_login_start({ openBrowser: false });
  }

  async function cursorSdkLoginStatus(machine?: AccountMachine): Promise<CursorSdkLoginProgress> {
    return asCursorModel<CursorSdkLoginProgress>(accountsOn_(machine).cursor_sdk_login_status({}));
  }

  async function cursorSdkLoginCancel(machine?: AccountMachine): Promise<void> {
    await accountsOn_(machine).cursor_sdk_login_cancel({});
  }

  async function cursorSdkLogout(machine?: AccountMachine): Promise<CursorSdkAuthStatus> {
    return asCursorModel<CursorSdkAuthStatus>(accountsOn_(machine).cursor_sdk_logout({}));
  }

  async function getControlMcpSettings(): Promise<ControlMcpSettings> {
    return coordinator().get_control_mcp_settings(
      undefined as never,
    ) as Promise<ControlMcpSettings>;
  }

  async function createControlMcpCredential(
    input: CreateControlMcpCredentialInput,
  ): Promise<ControlMcpSettings> {
    return coordinator().create_control_mcp_credential({ ...input }) as Promise<ControlMcpSettings>;
  }

  async function rotateControlMcpCredential(credentialId: string): Promise<ControlMcpSettings> {
    return coordinator().rotate_control_mcp_credential({
      credentialId,
    }) as Promise<ControlMcpSettings>;
  }

  async function revokeControlMcpCredential(credentialId: string): Promise<ControlMcpSettings> {
    return coordinator().revoke_control_mcp_credential({
      credentialId,
    }) as Promise<ControlMcpSettings>;
  }

  async function getRepositoryConfig(projectId: string): Promise<RepositoryConfig> {
    return (await settings().get_repository_config({ projectId })) as RepositoryConfig;
  }

  async function getLogDirectory(machine?: AccountMachine): Promise<string> {
    return environmentsOn(machine).getLogDirectory({});
  }

  async function getLogStorageStats(machine?: AccountMachine): Promise<LogStorageStats> {
    return environmentsOn(machine).getLogStorageStats({});
  }

  async function cleanupLogs(machine?: AccountMachine): Promise<LogStorageStats> {
    return environmentsOn(machine).cleanupLogs({});
  }

  async function getDatabaseStats(machine?: AccountMachine): Promise<DatabaseStats> {
    return systemApiOn(client, machine).get_database_stats({});
  }

  /**
   * Builds the bundle on the backend and answers with the manifest of exactly that
   * bundle. `containerLogs` names the container environments whose server logs the
   * user chose to add; none by default.
   */
  async function planDiagnosticsBundle(
    machine?: AccountMachine,
    options: { containerLogs?: readonly string[] } = {},
  ): Promise<DiagnosticsBundlePlan> {
    const containerLogs = options.containerLogs ?? [];
    const api = systemApiOn(client, machine);
    // Its own command, so a backend without it says so instead of leaving them out.
    return containerLogs.length > 0
      ? api.plan_diagnostics_bundle_with_container_logs({ containerLogs: [...containerLogs] })
      : api.plan_diagnostics_bundle({});
  }

  async function readDiagnosticsBundle(
    planId: string,
    offset: number,
    machine?: AccountMachine,
  ): Promise<DiagnosticsBundleChunk> {
    return systemApiOn(client, machine).read_diagnostics_bundle({
      planId,
      offset,
    });
  }

  async function getLinearConnection(): Promise<LinearConnectionStatus> {
    return asKanbanModel<LinearConnectionStatus>(kanban(client).get_linear_connection(NO_ARGS));
  }

  async function connectLinear(apiKey: string): Promise<LinearConnectionStatus> {
    return asKanbanModel<LinearConnectionStatus>(kanban(client).connect_linear({ apiKey }));
  }

  async function disconnectLinear(): Promise<LinearConnectionStatus> {
    return asKanbanModel<LinearConnectionStatus>(kanban(client).disconnect_linear(NO_ARGS));
  }

  async function getLinearIssues(): Promise<LinearIssueListItem[]> {
    return asKanbanModel<LinearIssueListItem[]>(kanban(client).get_linear_issues(NO_ARGS));
  }

  async function getLinearIssue(issueId: string): Promise<LinearIssueDetail> {
    return asKanbanModel<LinearIssueDetail>(kanban(client).get_linear_issue({ issueId }));
  }

  async function postLinearIssueComment(
    issueId: string,
    body: string,
  ): Promise<LinearIssueComment> {
    return asKanbanModel<LinearIssueComment>(
      kanban(client).post_linear_issue_comment({ issueId, body }),
    );
  }

  async function getGitHubIssues(projectId: string): Promise<GitHubIssuesSnapshot> {
    return prDomain().get_github_issues({ projectId });
  }

  async function getGitHubIssue(
    projectId: string,
    issueNumber: number,
  ): Promise<GitHubIssueDetail> {
    return prDomain().get_github_issue({ projectId, issueNumber });
  }

  async function updateGitHubIssue(
    projectId: string,
    issueNumber: number,
    updates: { title: string; body: string },
  ): Promise<GitHubIssue> {
    return prDomain().update_github_issue({ projectId, issueNumber, ...updates });
  }

  async function updateGitHubIssueStatus(
    projectId: string,
    issueNumber: number,
    status: GitHubIssueStatus,
  ): Promise<GitHubIssue> {
    return prDomain().update_github_issue_status({ projectId, issueNumber, status });
  }

  async function closeGitHubIssue(projectId: string, issueNumber: number): Promise<GitHubIssue> {
    return prDomain().close_github_issue({ projectId, issueNumber });
  }

  async function addGitHubIssueComment(
    projectId: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubIssueComment> {
    return prDomain().add_github_issue_comment({ projectId, issueNumber, body });
  }

  async function updateGitHubIssueComment(
    projectId: string,
    issueNumber: number,
    commentId: number,
    body: string,
  ): Promise<GitHubIssueComment> {
    return prDomain().update_github_issue_comment({
      projectId,
      issueNumber,
      commentId,
      body,
    });
  }

  async function openInBrowser(url: string): Promise<void> {
    // The Electron main process always runs on the client, even when this
    // renderer's backend commands are routed to a remote Orkestrator server.
    const openExternal = shellOpenExternal();
    if (openExternal) return openExternal(resolveGatewayLoopbackBaseUrl(url));
    // Browser clients open links in their own browser rather than asking the
    // backend host to launch one.
    if (window.orkestratorGateway?.enabled && !window.orkestratorGateway.desktop) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    return native().open_in_browser({ url });
  }

  async function revealInFileManager(path: string): Promise<void> {
    return native().reveal_in_file_manager({ path });
  }

  async function getEnvironmentPrUrl(environmentId: string): Promise<string | null> {
    return environments().getEnvironmentPrUrl({ environmentId });
  }

  async function clearEnvironmentPr(environmentId: string): Promise<void> {
    return environments().clearEnvironmentPr({ environmentId });
  }

  async function overrideEnvironmentSetup(environmentId: string): Promise<Environment> {
    return environments().overrideEnvironmentSetup({ environmentId });
  }

  async function runEnvironmentSetup(environmentId: string): Promise<Environment> {
    return environments().runEnvironmentSetup({ environmentId });
  }

  async function getEnvironmentSetupApproval(
    environmentId: string,
  ): Promise<EnvironmentSetupApproval> {
    return environments().getEnvironmentSetupApproval({ environmentId });
  }

  /**
   * Run a held setup's commands. `remember` also approves them for the project
   * on this machine, so later environments with the same commands run them.
   */
  async function approveEnvironmentSetup(
    environmentId: string,
    hash: string,
    remember: boolean,
  ): Promise<Environment> {
    return environments().approveEnvironmentSetup({ environmentId, hash, remember });
  }

  /**
   * Backend-owned merge workflow. The environment id is authoritative for both
   * local and container execution, and an optional cleanup follow-up is persisted
   * before GitHub is invoked.
   */
  async function mergeEnvironmentPr(
    environmentId: string,
    method?: MergeMethod,
    deleteBranch?: boolean,
    cleanupAfterMerge?: boolean,
  ): Promise<MergeEnvironmentPrResult> {
    return prDomain().merge_environment_pr({
      environmentId,
      method,
      deleteBranch,
      cleanupAfterMerge,
    });
  }

  /**
   * Turns the backend's auto-merge on or off: while on, it merges the open PR
   * once GitHub reports it ready and launches Resolve when it conflicts.
   * `cleanupAfterMerge` also deletes the environment once the merge is
   * confirmed; leaving it out turns any earlier cleanup request off.
   */
  async function setEnvironmentAutoMerge(
    environmentId: string,
    enabled: boolean,
    cleanupAfterMerge?: boolean,
  ): Promise<Environment> {
    return prDomain().set_environment_auto_merge({
      environmentId,
      enabled,
      ...(cleanupAfterMerge === undefined ? {} : { cleanupAfterMerge }),
    });
  }

  /** Submit and verify the current branch's PR merge from its container */
  async function mergePr(
    containerId: string,
    method?: MergeMethod,
    deleteBranch?: boolean,
  ): Promise<MergePrResult> {
    return prDomain().merge_pr({ containerId, method, deleteBranch });
  }

  return {
    getAgentModelCatalogCache,
    ensureHostPiModelCatalog,
    refreshHostAgentModelCatalog,
    getNativeAgentModelCatalog,
    getPlanUsage,
    cursorSdkLoginStart,
    cursorSdkLoginStatus,
    cursorSdkLoginCancel,
    cursorSdkLogout,
    getControlMcpSettings,
    createControlMcpCredential,
    rotateControlMcpCredential,
    revokeControlMcpCredential,
    getRepositoryConfig,
    getLogDirectory,
    getLogStorageStats,
    cleanupLogs,
    getDatabaseStats,
    planDiagnosticsBundle,
    readDiagnosticsBundle,
    getLinearConnection,
    connectLinear,
    disconnectLinear,
    getLinearIssues,
    getLinearIssue,
    postLinearIssueComment,
    getGitHubIssues,
    getGitHubIssue,
    updateGitHubIssue,
    updateGitHubIssueStatus,
    closeGitHubIssue,
    addGitHubIssueComment,
    updateGitHubIssueComment,
    openInBrowser,
    revealInFileManager,
    getEnvironmentPrUrl,
    clearEnvironmentPr,
    overrideEnvironmentSetup,
    runEnvironmentSetup,
    getEnvironmentSetupApproval,
    approveEnvironmentSetup,
    mergeEnvironmentPr,
    setEnvironmentAutoMerge,
    mergePr,
  };
}

export type ConfigIntegrationsApi = ReturnType<typeof createConfigIntegrationsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getAgentModelCatalogCache,
  ensureHostPiModelCatalog,
  refreshHostAgentModelCatalog,
  getNativeAgentModelCatalog,
  getPlanUsage,
  cursorSdkLoginStart,
  cursorSdkLoginStatus,
  cursorSdkLoginCancel,
  cursorSdkLogout,
  getControlMcpSettings,
  createControlMcpCredential,
  rotateControlMcpCredential,
  revokeControlMcpCredential,
  getRepositoryConfig,
  getLogDirectory,
  getLogStorageStats,
  cleanupLogs,
  getDatabaseStats,
  planDiagnosticsBundle,
  readDiagnosticsBundle,
  getLinearConnection,
  connectLinear,
  disconnectLinear,
  getLinearIssues,
  getLinearIssue,
  postLinearIssueComment,
  getGitHubIssues,
  getGitHubIssue,
  updateGitHubIssue,
  updateGitHubIssueStatus,
  closeGitHubIssue,
  addGitHubIssueComment,
  updateGitHubIssueComment,
  openInBrowser,
  revealInFileManager,
  getEnvironmentPrUrl,
  clearEnvironmentPr,
  overrideEnvironmentSetup,
  runEnvironmentSetup,
  getEnvironmentSetupApproval,
  approveEnvironmentSetup,
  mergeEnvironmentPr,
  setEnvironmentAutoMerge,
  mergePr,
} = createConfigIntegrationsApi(commandBackendClient);
// --- Docker Commands ---
