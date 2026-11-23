// The containers domain's public surface: the module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// The domain is the backend's side of environment containers and the Docker
// daemon (docs/architecture/container-lifecycle.md): the durable lifecycle
// operations and their reactor (`lifecycle-service.ts`,
// `lifecycle-events.ts`, `oom-events.ts`), start, readiness, admission and
// the preserving rebuild (`start.ts`, `readiness.ts`, `admission.ts`,
// `replacement.ts`), the image, storage, network, host-port, resource and
// agent-tools reachability layers (`image.ts`, `storage.ts`,
// `state-layout.ts`, `network.ts`, `network-owner.ts`, `host-ports.ts`,
// `resources.ts`, `host-reachability*.ts`), the scripts and files the backend
// runs or copies into a container (`scripts.ts`, `write.ts`,
// `copy-out.ts`, `copy-refusal.ts`, `project-seed-files.ts`,
// `apt-packages.ts`), the container bridges' credentials and launch
// (`bridge-*.ts`, `credential-mode.ts`, `github-credential.ts`), container
// logins (`claude-login-keeper.ts`, `login-file-watcher.ts`,
// `sign-in-guidance.ts`), the container side of terminals, worktree signals
// and remote freshness (`terminal-shell.ts`, `worktree-signal*.ts`,
// `git-fetch.ts`), container logs and usage (`log-*.ts`,
// `usage-sampler.ts`), and the Docker CLI's caches, errors, ownership labels
// and cleanup (`availability-cache.ts`, `container-state-cache.ts`,
// `cli-errors.ts`, `ownership.ts`, `network-changes.ts`, `cleanup-*.ts`).
// The container command handlers (`commands-containers.ts`,
// `commands-container-exec.ts`, `commands-registry-docker.ts`), the egress
// gateway (`egress-gateway.ts`), the environment files and the storage layer
// stay with their own groups.
//
// Seventeen modules are named exceptions in the `apps/backend/src/**`
// pattern of `.oxlintrc.json` and are not re-exported here. Each reaches, at
// runtime, a module that imports this file for one of the modules re-exported
// below, so re-exporting it would close a runtime import cycle; their
// importers import them directly:
//
// - through `egress-gateway.ts`: `lifecycle-service.ts`, `replacement.ts`
//   and `cleanup-inventory.ts` import it, and `network.ts`, `resources.ts`
//   and `cleanup-preview.ts` reach it through those;
// - through the command layer: `bridge-credential.ts` imports
//   `commands-container-exec.ts`, which `apt-packages.ts` reaches through
//   `setup-approval.ts`; `claude-login-keeper.ts` and `github-credential.ts`
//   import `commands-files.ts`; `lifecycle-events.ts` imports
//   `commands-environment.ts`; `project-seed-files.ts` imports
//   `commands-project-files.ts`;
// - through `claude-state-signal.ts`: `credential-mode.ts` and
//   `worktree-signal-install.ts`;
// - through `portable-input-status.ts`: `login-file-watcher.ts` and
//   `sign-in-guidance.ts`;
// - through `git/`: `git-fetch.ts` imports `worktrees/index.ts`, which
//   reaches `git/github-ranges-cache.ts`.
//
// Keeping those importers deep instead does not shrink the set: each one
// kept deep frees at most one module and makes every module it imports an
// exception. The root files that re-export container
// symbols for their own callers (`egress-gateway.ts`, `commands-servers.ts`
// and `commands-helpers.ts`, which lists `scripts.ts`'s exports by name) do
// it through this file.
//
// The `tests/unit/**` pattern has two exceptions, `network.ts` (for
// `firewall-refresh.test.ts`) and `replacement.ts` (for the two
// `migrate-copy*.test.ts` files), whose symbols this file cannot re-export.
// Tests, test support, the `apps/backend/tests` files and the scripts import
// the modules directly, which the patterns allow.
export { withContainerAdmission } from "./admission.js";
export {
  DockerAvailabilityCache,
  type DockerAvailabilityCacheOptions,
} from "./availability-cache.js";
export {
  containerBridgeOperationId,
  containerBridgeOperationIdIn,
  enqueueContainerBridgeOperation,
} from "./bridge-operations.js";
export { DockerCleanupGrants } from "./cleanup-grants.js";
export { isDockerDaemonUnreachable } from "./cli-errors.js";
export { DockerContainerStateCache } from "./container-state-cache.js";
export {
  copyIntoContainer,
  isDockerCopyBusyError,
  isDockerCopyRefusedError,
} from "./copy-refusal.js";
export {
  backendHostPortLabelArguments,
  chooseBackendHostPorts,
  listOwnedBackendHostPorts,
} from "./host-ports.js";
export { probeCreator } from "./host-reachability-creator.js";
export { ContainerHostReachabilityService } from "./host-reachability.js";
export {
  cleanupStaleManifestProbes,
  configuredImageRef,
  detectDockerTopology,
  getImageStatus,
  imageCapabilities,
  imageStateFormats,
  imageWritesVolumeStorage,
  readImageManifest,
  resetImageManifestCache,
  resolveDockerImage,
} from "./image.js";
export {
  boundDiagnosticTail,
  boundedLaunchWithPrivateEnv,
  boundedTailCommand,
  bridgeLogEnvironmentExports,
  DIAGNOSTIC_TAIL_MAX_BYTES,
  DIAGNOSTIC_TAIL_MAX_LINES,
  keepPreviousLogCommand,
  previousContainerLogFile,
} from "./log-bounds.js";
export { ContainerLogService, type ContainerLogServiceOptions } from "./log-service.js";
export { createSharedContainerLogReader } from "./log-snapshots.js";
export { subscribeDockerNetworkChanges } from "./network-changes.js";
export {
  egressGatewayOf,
  forgetNetworkOwner,
  networkOwnerContainer,
  parseNetworkModeOwner,
  rememberNetworkOwner,
} from "./network-owner.js";
export {
  type ContainerLifecycleListener,
  ContainerOomEvents,
  type ContainerOomEventsOptions,
} from "./oom-events.js";
export { dockerContainerRuntimeName, dockerOwnerNamespace } from "./ownership.js";
export {
  assertContainerNotDraining,
  assertEnvironmentNotDraining,
  boundedWaitScript,
  ContainerInitializationError,
  containerStopWasForced,
  drainContainerProcesses,
  type DrainResult,
  ensureCurrentBootReady,
  observeContainerBoot,
  PROBE_WINDOW_MS,
  probeIterations,
  waitForContainerBoot,
  withEnvironmentDraining,
} from "./readiness.js";
export {
  buildContainerSafeBase64Reader,
  CONTAINER_INTERACTIVE_SHELL_COMMAND,
  CONTAINER_ROOT_PATH,
  CONTAINER_ROOT_USER_ARGS,
  CONTAINER_SAFE_BASE64_READER,
  CONTAINER_TERMINAL_CLOSE_SCRIPT,
  CONTAINER_TERMINAL_PID_DIR_PREFIX,
  CONTAINER_TERMINAL_PID_RECORD_COMMAND,
  CONTAINER_TERMINAL_SESSION_ENV,
  CONTAINER_UNTRACKED_STATS_SCANNER,
  CONTAINER_WORKSPACE_PREPARE_COMMAND,
  CONTAINER_WORKSPACE_PREPARE_OK_SENTINEL,
  CONTAINER_WORKSPACE_PREPARE_SUPPORT_COMMAND,
  CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL,
  CONTAINER_WORKSPACE_SETUP_CAPABILITY_MARKER,
  CONTAINER_WORKSPACE_SETUP_COMMAND,
  CONTAINER_WORKSPACE_SETUP_WAIT_MESSAGE,
  containerTerminalUserArgs,
  isContainerRootUser,
  SETUP_DONE_OSC_SEQUENCE,
  SETUP_DONE_PRINTF_CMD,
  SETUP_FAILED_OSC_SEQUENCE,
  SETUP_FAILED_PRINTF_CMD,
  SETUP_FAILURE_REASONS,
  type SetupFailureReason,
  setupFailureReasonOscSequence,
  shellPrintfSentinel,
  withContainerRuntimeCredential,
} from "./scripts.js";
export { startDockerContainer } from "./start.js";
export {
  OPENCODE_DB_DIRECTORY,
  OPENCODE2_DB_PATH,
  OPENCODE2_LEGACY_DB_PATH,
  persistentStateExports,
} from "./state-layout.js";
export {
  ensureStorageVolumes,
  initializeStorageSet,
  inspectVolume,
  planStorageSet,
  removeStorageVolumes,
  selectStorageFormat,
  storageHelperFailureMessage,
  storageMountArguments,
  verifyStorageSet,
} from "./storage.js";
export {
  closeContainerTerminalShell,
  type ContainerTerminalShell,
  newContainerTerminalToken,
} from "./terminal-shell.js";
export { ContainerUsageSampler } from "./usage-sampler.js";
export {
  type ContainerWorktreeSignalContext,
  type ContainerWorktreeSignalInstaller,
  ContainerWorktreeSignals,
} from "./worktree-signal.js";
export { runContainerWrite } from "./write.js";
