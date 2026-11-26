// The commands domain's public surface: the command modules' symbols that
// code outside `commands/` uses, each re-exported by name from the module
// that defines it. It does not re-export the registry: `createCommandRegistry`
// (`registry.ts`) reaches every domain, and most domains import this file.
//
// Nineteen modules are named exceptions in the `apps/backend/src/**` lint
// pattern, and their values are not re-exported here: re-exporting any of
// them would close a runtime import cycle, because each reaches, at runtime,
// a file that imports this one. Their importers take those values from the
// module itself; their types are still re-exported below, because a type
// re-export adds no runtime edge.
//   - `registry.ts` (the composition root `core/index.ts`) and the registry
//     files whose helpers other domains call: `registry-coordinator.ts`,
//     `registry-coordinator-nodes.ts`, `registry-docker.ts`,
//     `registry-mcp.ts`, `registry-projects.ts`,
//     `registry-self-improvement.ts` and `registry-user-commands.ts`;
//   - the handler modules that reach the container, environment, server and
//     review layers: `agent-support.ts`, `containers.ts`,
//     `environment.ts`, `environment-fork.ts`, `files.ts`,
//     `local-server-lifecycle.ts`, `pr-monitor.ts`, `pr-monitor-batch.ts`,
//     `projects.ts`, `review.ts` and `servers.ts`.
// The set was found from the runtime import graph (value imports only, as
// for `import/no-cycle`): a module is left out when a value re-export of it
// reaches a file that imports this one, repeated until nothing changes.
//
// The `tests/unit/**` pattern has two exceptions, `registry.ts` (for the
// test that builds a registry) and `testing.ts` (`__testing`), which this file
// must not re-export. `helpers.ts`, the re-export list the handler modules
// share, is internal: outside callers import each symbol from this file, or
// from the domain that defines it.
export { dockerExec, getHostPort, isContainerRunning } from "./container-exec.js";
export type { CommandContext, CommandHandler, CommandInvocation } from "./context.js";
export {
  cleanupErrorMessage,
  conciseError,
  ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
  imageWithoutStagedInputsMessage,
  isGitSshUnreachableMessage,
  SETUP_TERMINAL_STILL_RUNNING_MESSAGE,
} from "./error-text.js";
export type { ContainerGitStatusDeps } from "./files.js";
export { isPathInsideRoot, normalizeConfiguredProjectFiles } from "./project-files.js";
export { ASYNC_HANDLER } from "./registry-async-decode.js";
export {
  contractCommandHandler,
  contractResultValidationDefault,
  registrarFrom,
  wrapRegistrar,
} from "./registry-contracts.js";
export type { CoordinatorNodeTarget } from "./registry-coordinator-nodes.js";
export { registerPreviewCommands } from "./registry-previews.js";
export {
  scheduleListFilter,
  schedulerStatus,
  scheduleTimingArgs,
  SCHEDULING_DISABLED_MESSAGE,
  schedulingEnabled,
  withProjectEnvironments,
  withScheduleActor,
} from "./registry-scheduled-jobs.js";
export type {
  CommandRegistrar,
  DefinedCommandHandler,
  DefinedCommandOptions,
  RegistryDependencies,
} from "./registry-types.js";
export type {
  EnvironmentCommandRunner,
  GhPrListEntry,
  MergeEnvironmentPrResult,
  PrDetectionResult,
  ReviewPackageVerification,
} from "./review.js";
export {
  bearerBridgeHeaders,
  checkHttpHealth,
  claudeBridgeAuthHeaders,
  dockerExecDetached,
  isHealthyHttpResponse,
  isHttpServerReachable,
  waitForHttpServerExit,
} from "./server-health.js";
export type { BridgeName } from "./servers.js";
export {
  assertEnvironmentDeletionNotRequested,
  compactTerminalOutputBuffer,
  createTerminalOutputBuffer,
  isHighSurrogate,
  isLowSurrogate,
  isSetupTerminalSessionId,
  MAX_TERMINAL_OUTPUT_BUFFER_CHUNKS,
  MAX_TERMINAL_OUTPUT_DELTA_BYTES,
  MAX_TERMINAL_OUTPUT_DELTAS,
  resolveLocalShellPath,
  setupTerminalSessionId,
  stripWorkflowSnapshotSecrets,
  terminalEnv,
  terminalOutputPayload,
  toClientEnvironment,
  trimOrphanedLowSurrogate,
} from "./terminal.js";
export {
  asCachedCodexModels,
  asNonBlankString,
  cursorApiKeyFingerprint,
  FILE_LINE_COUNT_CHUNK_BYTES,
  resolveCursorApiKey,
  resolveOpenCodeZenApiKey,
  stripRendererCredentials,
  UNTRACKED_SCAN_CONCURRENCY,
  UNTRACKED_SCAN_MAX_FILES,
} from "./validation.js";
