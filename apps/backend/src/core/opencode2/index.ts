// The opencode2 domain's public surface: the only module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable. The OpenCode launch, server, sign-in and stored-transcript
// modules that sat beside this folder as `opencode-*.ts` and `opencode2-*.ts`
// moved into it on 2026-11-16 (#2342).
//
// Four modules are named exceptions in `.oxlintrc.json`:
//
// - `container-credentials.js`, because routing its importers through this
//   file would close a runtime import cycle (this file reaches
//   `agent-accounts/containers.ts` through `host-launch.ts`):
//   `agent-accounts/containers.ts` and `portable-input-status.ts` import it
//   directly. It is still re-exported here.
// - `container-server-lifecycle.js`, `host-database-server.js` and
//   `provider-login.js`, which reach the command layer (`commands/servers.ts`,
//   the container lifecycle modules, `local-server-runtime.ts`). Re-exporting
//   any of them here would put most of the backend behind this file and close
//   a cycle for its other importers, so they are not re-exported:
//   the composition root (`core/index.ts`) and `commands/registry-projects.ts` import
//   `openCode2EnvironmentServer`, and `commands/registry-servers.ts` the
//   container server start, stop and status, from
//   `container-server-lifecycle.js`; `host-model-catalog-refresh.ts` imports
//   `host-database-server.js`; `commands/registry-accounts.ts` imports
//   `provider-login.js`.
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
  normalizeOpenCodeDisplayEntries,
  normalizeOpenCodeDisplayEntry,
} from "./display-transcript.js";
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
export {
  judgeOpenCodeListener,
  listOpenCodeListenersScript,
  openCodeListenerRecord,
  parseOpenCodeListeners,
  type OpenCodeListenerJudgement,
  type OpenCodeServerKind,
} from "./listener-identity.js";
export { readOpenCode2ModelCatalogue } from "./models.js";
export { OpenCodeProviderLoginSlot } from "./provider-login-slot.js";
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
