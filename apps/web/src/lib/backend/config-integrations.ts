import { invoke } from "@/lib/native/backend";
import { getGatewayBaseUrl } from "@/lib/gateway-url";
import type {
  Environment,
  AppConfig,
  GlobalConfig,
  GatewayTokenSettings,
  WebClientStatus,
  RepositoryConfig,
  PrState,
  EnsureEnvironmentSetupResult,
  ClaudeModelCatalogSnapshot,
  CursorSdkAuthStatus,
  CursorSdkLoginProgress,
} from "@/types";
import type {
  LinearCompletionCommentResult,
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
import type { CodexModel } from "@/lib/codex-client";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
/** PR detection result containing URL, state, and merge conflict status */

import type { PrDetectionResult } from "./projects-environments";

export async function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

export interface AgentModelCatalogCache {
  schemaVersion: 1;
  claude?: {
    updatedAt: string;
    models: ClaudeModelCatalogSnapshot["models"];
  };
  codex?: {
    updatedAt: string;
    models: CodexModel[];
  };
  cursor?: {
    updatedAt: string;
    models: AgentModel[];
  };
  grok?: {
    updatedAt: string;
    models: AgentModel[];
  };
  pi?: {
    updatedAt: string;
    models: AgentModel[];
  };
}

/** Load the host-wide last-known-good catalogues, seeding Pi on first use. */
export async function getAgentModelCatalogCache(): Promise<AgentModelCatalogCache> {
  return invoke<AgentModelCatalogCache>("get_agent_model_catalog_cache");
}

/** Discover Pi models without requiring an environment or persistent bridge. */
export async function ensureHostPiModelCatalog(): Promise<
  import("@orkestrator/protocol/native-agent").AgentModel[]
> {
  return invoke("ensure_host_pi_model_catalog");
}

/** Backend-normalized model catalogue consumed by the provider-neutral composer. */
export async function getNativeAgentModelCatalog(
  environmentId: string,
  ensureAgent?: "cursor" | "grok" | "pi",
): Promise<import("@orkestrator/protocol/native-agent").AgentModel[]> {
  if (!ensureAgent) {
    return invoke("get_native_agent_model_catalog", { environmentId });
  }
  const result = await invoke<
    | import("@orkestrator/protocol/native-agent").AgentModel[]
    | {
        models: import("@orkestrator/protocol/native-agent").AgentModel[];
        status: "ready" | "empty" | "failed";
      }
  >("get_native_agent_model_catalog", {
    environmentId,
    ensureAgent,
  });
  // Older backends return an ensured catalogue directly.
  if (Array.isArray(result)) return result;
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

/** Persist an authoritative catalogue for the next application launch. */
export async function cacheAgentModelCatalog(
  agent: "claude" | "codex",
  models: ClaudeModelCatalogSnapshot["models"] | CodexModel[],
): Promise<AgentModelCatalogCache> {
  return invoke<AgentModelCatalogCache>("cache_agent_model_catalog", {
    agent,
    models,
  });
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke("save_config", { config });
}

export async function getGlobalConfig(): Promise<GlobalConfig> {
  return invoke<GlobalConfig>("get_global_config");
}

export async function updateGlobalConfig(global: GlobalConfig): Promise<AppConfig> {
  return invoke<AppConfig>("update_global_config", { global });
}

export async function setGitHubToken(token: string | null): Promise<AppConfig> {
  return invoke<AppConfig>("set_github_token", { token });
}

export async function setCursorApiKey(apiKey: string | null): Promise<AppConfig> {
  return invoke<AppConfig>("set_cursor_api_key", { apiKey });
}

export async function setAnthropicApiKey(apiKey: string | null): Promise<AppConfig> {
  return invoke<AppConfig>("set_anthropic_api_key", { apiKey });
}

/**
 * Experimental Cursor SDK sign-in.
 *
 * Start returns the URL to open; the flow itself runs in the backend, which
 * spawns the bridge, parses its output and stores the credential. Callers open
 * the URL and poll `cursorSdkLoginStatus` until it leaves `pending`.
 */
export async function cursorSdkLoginStart(): Promise<{ loginUrl: string }> {
  return invoke<{ loginUrl: string }>("cursor_sdk_login_start", {});
}

export async function cursorSdkLoginStatus(): Promise<CursorSdkLoginProgress> {
  return invoke<CursorSdkLoginProgress>("cursor_sdk_login_status", {});
}

export async function cursorSdkLoginCancel(): Promise<void> {
  await invoke<{ cancelled: boolean }>("cursor_sdk_login_cancel", {});
}

export async function cursorSdkLogout(): Promise<CursorSdkAuthStatus> {
  return invoke<CursorSdkAuthStatus>("cursor_sdk_logout", {});
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
  token: string;
  error: string | null;
}

export async function getControlMcpSettings(): Promise<ControlMcpSettings> {
  return invoke<ControlMcpSettings>("get_control_mcp_settings");
}

export async function rotateControlMcpToken(): Promise<ControlMcpSettings> {
  return invoke<ControlMcpSettings>("rotate_control_mcp_token");
}

export async function getRepositoryConfig(projectId: string): Promise<RepositoryConfig> {
  return invoke<RepositoryConfig>("get_repository_config", { projectId });
}

export async function updateRepositoryConfig(
  projectId: string,
  repoConfig: RepositoryConfig,
): Promise<AppConfig> {
  return invoke<AppConfig>("update_repository_config", { projectId, repoConfig });
}

export async function getLogDirectory(): Promise<string> {
  return invoke<string>("get_log_directory");
}

export interface LogStorageStats {
  totalBytes: number;
  fileCount: number;
}

export async function getLogStorageStats(): Promise<LogStorageStats> {
  return invoke<LogStorageStats>("get_log_storage_stats");
}

export async function cleanupLogs(): Promise<LogStorageStats> {
  return invoke<LogStorageStats>("cleanup_logs");
}

// --- Linear Commands ---

export async function getLinearConnection(): Promise<LinearConnectionStatus> {
  return invoke<LinearConnectionStatus>("get_linear_connection");
}

export async function connectLinear(apiKey: string): Promise<LinearConnectionStatus> {
  return invoke<LinearConnectionStatus>("connect_linear", { apiKey });
}

export async function disconnectLinear(): Promise<LinearConnectionStatus> {
  return invoke<LinearConnectionStatus>("disconnect_linear");
}

export async function getLinearIssues(): Promise<LinearIssueListItem[]> {
  return invoke<LinearIssueListItem[]>("get_linear_issues");
}

export async function getLinearIssue(issueId: string): Promise<LinearIssueDetail> {
  return invoke<LinearIssueDetail>("get_linear_issue", { issueId });
}

export async function postLinearIssueComment(
  issueId: string,
  body: string,
): Promise<LinearIssueComment> {
  return invoke<LinearIssueComment>("post_linear_issue_comment", { issueId, body });
}

export async function postLinearCompletionComment(
  pipelineId: string,
  issueId: string,
  body: string,
): Promise<LinearCompletionCommentResult> {
  return invoke<LinearCompletionCommentResult>("post_linear_completion_comment", {
    pipelineId,
    issueId,
    body,
  });
}

export async function getGitHubIssues(projectId: string): Promise<GitHubIssuesSnapshot> {
  return invoke<GitHubIssuesSnapshot>("get_github_issues", { projectId });
}

export async function getGitHubIssue(
  projectId: string,
  issueNumber: number,
): Promise<GitHubIssueDetail> {
  return invoke<GitHubIssueDetail>("get_github_issue", { projectId, issueNumber });
}

export async function updateGitHubIssue(
  projectId: string,
  issueNumber: number,
  updates: { title: string; body: string },
): Promise<GitHubIssue> {
  return invoke<GitHubIssue>("update_github_issue", { projectId, issueNumber, ...updates });
}

export async function updateGitHubIssueStatus(
  projectId: string,
  issueNumber: number,
  status: GitHubIssueStatus,
): Promise<GitHubIssue> {
  return invoke<GitHubIssue>("update_github_issue_status", { projectId, issueNumber, status });
}

export async function closeGitHubIssue(
  projectId: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  return invoke<GitHubIssue>("close_github_issue", { projectId, issueNumber });
}

export async function addGitHubIssueComment(
  projectId: string,
  issueNumber: number,
  body: string,
): Promise<GitHubIssueComment> {
  return invoke<GitHubIssueComment>("add_github_issue_comment", { projectId, issueNumber, body });
}

export async function updateGitHubIssueComment(
  projectId: string,
  issueNumber: number,
  commentId: number,
  body: string,
): Promise<GitHubIssueComment> {
  return invoke<GitHubIssueComment>("update_github_issue_comment", {
    projectId,
    issueNumber,
    commentId,
    body,
  });
}

export interface GitHubCompletionCommentResult {
  status: "posted" | "already-posted";
  commentId: string;
  postedAt?: string;
}

export async function postGitHubCompletionComment(
  pipelineId: string,
  projectId: string,
  repositoryOwner: string,
  repositoryName: string,
  issueNumber: number,
  body: string,
): Promise<GitHubCompletionCommentResult> {
  return invoke<GitHubCompletionCommentResult>("post_github_completion_comment", {
    pipelineId,
    projectId,
    repositoryOwner,
    repositoryName,
    issueNumber,
    body,
  });
}

// --- GitHub Commands ---

export async function openInBrowser(url: string): Promise<void> {
  // Browser clients open links locally. Electron marks gateway metadata as a
  // desktop connection so a remote-backend session still uses the native
  // system-browser command instead of a renderer-created window.
  if (window.orkestratorGateway?.enabled && !window.orkestratorGateway.desktop) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  return invoke("open_in_browser", { url });
}

export async function revealInFileManager(path: string): Promise<void> {
  return invoke("reveal_in_file_manager", { path });
}

export async function getEnvironmentPrUrl(environmentId: string): Promise<string | null> {
  return invoke<string | null>("get_environment_pr_url", { environmentId });
}

export interface VerifiedEnvironmentPr {
  url: string;
  headRefName: string;
  baseRefName: string;
  state: "OPEN";
}

export async function verifyEnvironmentPr(
  environmentId: string,
  prUrl: string,
  targetBranch: string,
): Promise<VerifiedEnvironmentPr> {
  return invoke<VerifiedEnvironmentPr>("verify_environment_pr", {
    environmentId,
    prUrl,
    targetBranch,
  });
}

export async function clearEnvironmentPr(environmentId: string): Promise<void> {
  return invoke("clear_environment_pr", { environmentId });
}

export async function setEnvironmentPr(
  environmentId: string,
  prUrl: string,
  prState: PrState,
  hasMergeConflicts: boolean | null,
): Promise<Environment> {
  return invoke<Environment>("set_environment_pr", {
    environmentId,
    prUrl,
    prState,
    hasMergeConflicts,
  });
}

export async function overrideEnvironmentSetup(environmentId: string): Promise<Environment> {
  return invoke<Environment>("override_environment_setup", { environmentId });
}

export async function runEnvironmentSetup(environmentId: string): Promise<Environment> {
  return invoke<Environment>("run_environment_setup", { environmentId });
}

export async function ensureEnvironmentSetup(
  environmentId: string,
): Promise<EnsureEnvironmentSetupResult> {
  return invoke<EnsureEnvironmentSetupResult>("ensure_environment_setup", { environmentId });
}

/** Detect PR URL and state for the environment's branch (uses --head to check correct branch) */
export async function detectPr(
  containerId: string,
  branch: string,
): Promise<PrDetectionResult | null> {
  return invoke<PrDetectionResult | null>("detect_pr", { containerId, branch });
}

/** Detect PR URL and state for local (worktree-based) environments (uses --head to check correct branch) */
export async function detectPrLocal(
  environmentId: string,
  branch: string,
): Promise<PrDetectionResult | null> {
  return invoke<PrDetectionResult | null>("detect_pr_local", { environmentId, branch });
}

/** Merge method options for PR merging */
export type MergeMethod = "squash" | "merge" | "rebase";

export interface MergePrResult {
  outcome: "merged" | "pending" | "unknown";
}

export interface MergeEnvironmentPrResult extends MergePrResult {
  cleanupOutcome: "not-requested" | "pending" | "completed" | "failed";
  cleanupError?: string;
}

/**
 * Backend-owned merge workflow. The environment id is authoritative for both
 * local and container execution, and an optional cleanup follow-up is persisted
 * before GitHub is invoked.
 */
export async function mergeEnvironmentPr(
  environmentId: string,
  method?: MergeMethod,
  deleteBranch?: boolean,
  cleanupAfterMerge?: boolean,
): Promise<MergeEnvironmentPrResult> {
  return invoke<MergeEnvironmentPrResult>("merge_environment_pr", {
    environmentId,
    method,
    deleteBranch,
    cleanupAfterMerge,
  });
}

/** Submit and verify the current branch's PR merge from its container */
export async function mergePr(
  containerId: string,
  method?: MergeMethod,
  deleteBranch?: boolean,
): Promise<MergePrResult> {
  return invoke<MergePrResult>("merge_pr", { containerId, method, deleteBranch });
}

/** Merge the local environment's PR through the GitHub API */
export async function mergePrLocal(
  environmentId: string,
  method?: MergeMethod,
  deleteBranch?: boolean,
): Promise<MergePrResult> {
  return invoke<MergePrResult>("merge_pr_local", { environmentId, method, deleteBranch });
}

// --- Docker Commands ---
