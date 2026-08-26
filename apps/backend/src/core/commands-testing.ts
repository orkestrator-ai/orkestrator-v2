import type { ChildProcessWithoutNullStreams, DiffStatsService } from "./commands-dependencies.js";
import { spawnCommand, terminateProcessTree } from "./commands-dependencies.js";
import {
  ACP_LOCAL_SERVER_HEALTH_ATTEMPTS,
  BRANCH_REF_EXISTS_SENTINEL,
  CLAUDE_GITHUB_ENV_FINGERPRINT,
  CONTAINER_PINNED_ATTACHMENT_REMOVE,
  CONTAINER_PINNED_ATTACHMENT_WRITE,
  CONTAINER_WORKSPACE_PREPARE_OK_SENTINEL,
  CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL,
  CONTAINER_WORKSPACE_SETUP_CAPABILITY_MARKER,
  LOCAL_SERVER_HEALTH_ATTEMPTS,
  OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT,
  configuredOpenCodeAgentTools,
  deletingLocalServerEnvironments,
  diffStatsService,
  enableGitScanCaches,
  establishCreatedFromCommit,
  ensureContainerAgentToolsHost,
  completeEnvironmentSetup,
  buildContainerGitStatusScript,
  buildOpenCodeGitHubEnvironmentPluginSource,
  buildSyncContainerClaudeCredentialCommand,
  buildSyncContainerGitHubCredentialCommand,
  cancelAllOpenCodeAgentToolsConfigurations,
  cancelOpenCodeAgentToolsConfiguration,
  countLocalFileLines,
  countPrunedDockerResources,
  deleteRetainedTerminalOutputBuffer,
  dockerOwnerMatches,
  environmentLifecycleErrorMessage,
  getClaudeOAuthAccessToken,
  getHostClaudeCredentials,
  invalidateDockerContainerStateCache,
  localClaudeBridgeTokens,
  localCodexBridgeTokens,
  localOpenCodeServerPasswords,
  localServerEnvironmentOperations,
  localServerProcesses,
  mergingEnvironments,
  openCodeAgentToolsConfigurations,
  openCodeAgentToolsState,
  parseContainerGitStatusResponse,
  parseContainerUntrackedStats,
  parseDockerByteSize,
  parseGitFileChanges,
  parseHeadCommit,
  parseOpenCodeEnvironmentSkills,
  readBoundedOpenCodeResponse,
  releaseLocalServerOwnership,
  resetOpenCodeAgentToolsTuning,
  resetTerminalOutputBuffers,
  resolveContainerClaudeCredentials,
  runEnvironmentAgentSkills,
  scheduleOpenCodeAgentToolsConfiguration,
  scrubLifecycleLogDetail,
  shouldAddDockerHostGatewayAlias,
  terminalOutputBuffers,
  terminalOutputRevisions,
  terminalOutputRetentionTimers,
  waitForHttpServerExit,
  waitForLocalServerHealth,
  waitForUnhealthy,
  isMissingTargetRefResponse,
  configureOpenCodeAgentTools,
  createExtensionCommandRunner,
  hasCursorSdkBridge,
  agentToolConnectionFingerprint,
  setOpenCodeAgentToolsMemoWindows,
  setOpenCodeAgentToolsRetryDelays,
  setLocalServerShutdownRequested,
  setLocalServerShutdownPromise,
  setSpawnLocalServerCommandImplementation,
  setTerminateProcessTreeImplementation,
  setTerminalOutputRetentionMs,
} from "./commands-helpers.js";

export const __testing = {
  BRANCH_REF_EXISTS_SENTINEL,
  CONTAINER_PINNED_ATTACHMENT_WRITE,
  CONTAINER_PINNED_ATTACHMENT_REMOVE,
  countPrunedDockerResources,
  dockerOwnerMatches,
  parseDockerByteSize,
  configureOpenCodeAgentTools,
  scheduleOpenCodeAgentToolsConfiguration,
  cancelOpenCodeAgentToolsConfiguration,
  openCodeAgentToolsConfigurationCount(): number {
    return openCodeAgentToolsConfigurations.size;
  },
  configuredOpenCodeAgentToolsCount(): number {
    return configuredOpenCodeAgentTools.size;
  },
  openCodeAgentToolsState,
  // `resetLocalServerLifecycle` restores the production windows and backoff, so
  // an override cannot outlive the test that set it.
  setOpenCodeAgentToolsRetryDelaysMs(delays: readonly number[]): void {
    setOpenCodeAgentToolsRetryDelays(delays);
  },
  setOpenCodeAgentToolsMemoWindowsMs(connectedTtlMs: number, unavailableCooldownMs: number): void {
    setOpenCodeAgentToolsMemoWindows(connectedTtlMs, unavailableCooldownMs);
  },
  resetOpenCodeAgentToolsTuning,
  readBoundedOpenCodeResponse,
  ensureContainerAgentToolsHost,
  shouldAddDockerHostGatewayAlias,
  agentToolConnectionFingerprint,
  createExtensionCommandRunner,
  hasCursorSdkBridge,
  parseOpenCodeEnvironmentSkills,
  runEnvironmentAgentSkills,
  environmentLifecycleErrorMessage,
  scrubLifecycleLogDetail,
  isEnvironmentDeleting(environmentId: string): boolean {
    return deletingLocalServerEnvironments.has(environmentId);
  },
  markEnvironmentMerging(environmentId: string): void {
    mergingEnvironments.add(environmentId);
  },
  resetDockerContainerStateCache(): void {
    // The cache is private to the environment status helpers; their invalidator
    // keeps the ownership and fetch bookkeeping in that module.
    invalidateDockerContainerStateCache();
  },
  parseGitFileChanges,
  parseContainerUntrackedStats,
  parseContainerGitStatusResponse,
  isMissingTargetRefResponse,
  buildContainerGitStatusScript,
  parseHeadCommit,
  buildSyncContainerGitHubCredentialCommand,
  buildSyncContainerClaudeCredentialCommand,
  getClaudeOAuthAccessToken,
  getHostClaudeCredentials,
  resolveContainerClaudeCredentials,
  buildOpenCodeGitHubEnvironmentPluginSource,
  OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT,
  CLAUDE_GITHUB_ENV_FINGERPRINT,
  countLocalFileLines,
  establishCreatedFromCommit,
  completeEnvironmentSetup,
  enableGitScanCaches,
  trackDiffStats(target: Parameters<DiffStatsService["track"]>[0]): void {
    diffStatsService.track(target);
  },
  trackedDiffStatsIds(): string[] {
    return diffStatsService.trackedIds();
  },
  terminalOutputBufferStats(sessionId: string): {
    chars: number;
    chunks: number;
    sequence: number;
  } {
    const buffer = terminalOutputBuffers.get(sessionId);
    return {
      chars: buffer?.length ?? 0,
      chunks: buffer ? buffer.chunks.length - buffer.headIndex : 0,
      sequence: terminalOutputRevisions.get(sessionId) ?? 0,
    };
  },
  deleteRetainedTerminalOutputBuffer,
  retainedTerminalOutputBufferCount(): number {
    return terminalOutputRetentionTimers.size;
  },
  // `resetTerminalOutputBuffers` restores the production window, so an override
  // cannot outlive the test that set it.
  setTerminalOutputRetentionMs(retentionMs: number): void {
    setTerminalOutputRetentionMs(retentionMs);
  },
  resetTerminalOutputBuffers,
  CONTAINER_WORKSPACE_SETUP_CAPABILITY_MARKER,
  CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL,
  CONTAINER_WORKSPACE_PREPARE_OK_SENTINEL,
  setLocalServerProcess(key: string, child: ChildProcessWithoutNullStreams): void {
    localServerProcesses.set(key, child);
  },
  getLocalServerProcess(key: string): ChildProcessWithoutNullStreams | undefined {
    return localServerProcesses.get(key);
  },
  releaseLocalServerOwnership,
  LOCAL_SERVER_HEALTH_ATTEMPTS,
  ACP_LOCAL_SERVER_HEALTH_ATTEMPTS,
  waitForLocalServerHealth,
  waitForHttpServerExit,
  waitForUnhealthy,
  setTerminateProcessTree(implementation: typeof terminateProcessTree): void {
    setTerminateProcessTreeImplementation(implementation);
  },
  setSpawnLocalServerCommand(implementation: typeof spawnCommand): void {
    setSpawnLocalServerCommandImplementation(implementation);
  },
  getLocalCodexBridgeToken(environmentId: string): string | undefined {
    return localCodexBridgeTokens.get(environmentId);
  },
  deleteLocalCodexBridgeToken(environmentId: string): void {
    localCodexBridgeTokens.delete(environmentId);
  },
  getLocalClaudeBridgeToken(environmentId: string): string | undefined {
    return localClaudeBridgeTokens.get(environmentId);
  },
  deleteLocalClaudeBridgeToken(environmentId: string): void {
    localClaudeBridgeTokens.delete(environmentId);
  },
  getLocalOpenCodeServerPassword(environmentId: string): string | undefined {
    return localOpenCodeServerPasswords.get(environmentId);
  },
  deleteLocalOpenCodeServerPassword(environmentId: string): void {
    localOpenCodeServerPasswords.delete(environmentId);
  },
  resetLocalServerLifecycle(): void {
    if (localServerEnvironmentOperations.size > 0) {
      throw new Error("Cannot reset local server lifecycle while operations are active");
    }
    localServerProcesses.clear();
    localCodexBridgeTokens.clear();
    localClaudeBridgeTokens.clear();
    localOpenCodeServerPasswords.clear();
    cancelAllOpenCodeAgentToolsConfigurations();
    resetOpenCodeAgentToolsTuning();
    deletingLocalServerEnvironments.clear();
    mergingEnvironments.clear();
    setLocalServerShutdownRequested(false);
    setLocalServerShutdownPromise(null);
    setTerminateProcessTreeImplementation(terminateProcessTree);
    setSpawnLocalServerCommandImplementation(spawnCommand);
  },
};
