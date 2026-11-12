// The opencode2 domain's public surface: the only module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable. The `opencode2-*.ts` launch and server files beside this folder
// are outside it and import it through this file like any other caller.
//
// One leaf module is a named exception in `.oxlintrc.json`, because routing
// its importers through this file would close a runtime import cycle (this
// file reaches `agent-accounts-containers.ts` through `host-launch.ts`):
// `agent-accounts-containers.ts` and `portable-input-status.ts` import
// `container-credentials.js` directly. It is still re-exported here.
export { OpenCode2Client, OpenCode2RequestError } from "./client.js";
export {
  SCRUB_OPENCODE2_CONTAINER_CREDENTIALS,
  SYNC_OPENCODE2_CONTAINER_CREDENTIALS,
  openCode2ContainerCredentialPayload,
} from "./container-credentials.js";
export {
  OPENCODE2_CONTAINER_DIRECTORY,
  OPENCODE2_CONTAINER_LOG,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE,
  OPENCODE2_CONTAINER_PROCESS_PATTERN,
  OPENCODE2_GITHUB_ENV_PLUGIN_ID,
  STOP_OPENCODE2_CONTAINER_SERVER_SCRIPT,
  buildOpenCode2ContainerStartScript,
  buildOpenCode2GitHubEnvironmentPluginSource,
  manifestRunsOpenCode2,
  publishesOpenCode2Port,
} from "./container-server.js";
export { containerOpenCodeTerminalCommand } from "./container-terminal-launch.js";
export { openCode2CoordinatorSignature, writeOpenCode2CoordinatorConfig } from "./coordinator.js";
export { reconcileLegacyOpenCodeLoginsBestEffort } from "./credential-upgrade.js";
export {
  exportOpenCode2Logins,
  exportOpenCode2Refreshes,
  keepActiveOpenCode2Credential,
  openCode2RefreshLineageFile,
  removeOpenCode2Credentials,
  runningOpenCode2HostClient,
} from "./credentials.js";
export {
  OpenCodeEnvironmentProvider,
  type OpenCode2ServerConnection,
  type OpenCodeEnvironmentDependencies,
} from "./environment-provider.js";
export {
  prepareOpenCodeHostLaunch,
  recordOpenCodeHostServer,
  type PreparedOpenCodeHostLaunch,
} from "./host-launch.js";
export {
  OpenCode2HostServerState,
  openCode2ServerKey,
  type OpenCode2HostServerRecord,
} from "./host-server-state.js";
export { readOpenCode2ModelCatalogue } from "./models.js";
export {
  OPENCODE2_CREDENTIAL_PLUGIN_ID,
  OPENCODE2_DISABLE_FILEWATCHER,
  OPENCODE2_FLAGS,
  buildOpenCode2CredentialPluginSource,
  openCode2HostLaunch,
  waitForOpenCode2Ready,
  writeOpenCode2HostConfig,
} from "./server.js";
export { resolveOpenCode2TerminalCommand } from "./terminal-launch.js";
export { openCode2WorkerMailbox, type OpenCode2WorkerMailbox } from "./turn-connections.js";
export {
  OPENCODE2_USER_CONFIG_MIRROR_FILE,
  buildOpenCode2UserConfigMergeCommand,
  mergeOpenCodeUserConfig,
} from "./user-config.js";
