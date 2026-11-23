// The environments domain's public surface: the module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// The domain is the backend's environment lifecycle code outside the command
// handlers: in-flight environment work owned by `BackendRuntime`
// (`operations.ts`), the replacement and move fence (`replacement-fence.ts`),
// lifecycle task admission and drain (`lifecycle-tasks.ts`), deletion and
// its durable cleanup (`delete.ts`, `deletion-steps.ts`, `cleanup.ts`,
// `cleanup-ledger.ts`, `cleanup-reconciler.ts`; see
// docs/architecture/environment-deletion.md), moving an environment's
// checkout (`move.ts`, `move-sessions.ts`), local environment isolation
// (`isolation.ts`, `port-probe.ts`; see
// docs/architecture/environment-isolation.md), per-environment data
// directories (`state-paths.ts`), process usage (`process-usage.ts`), the
// in-environment agent-skills scanner (`agent-skills.ts`), generated names
// (`name.ts`) and start failure remedies (`start-remedy.ts`). The environment
// command handlers (`commands-environment*.ts`,
// `commands-registry-environments.ts`), `project-home-environment.ts` and the
// storage layer's `storage/environment-*.ts` stay with their own groups.
//
// Five modules are named exceptions in the `apps/backend/src/**` pattern of
// `.oxlintrc.json` and are not re-exported here. Each reaches, at runtime, a
// module that imports this file for one of the modules re-exported below, so
// re-exporting it would close a runtime import cycle; their importers import
// them directly:
//
// - through the command layer: `cleanup.ts`, `cleanup-reconciler.ts`,
//   `delete.ts` and `move.ts` import `commands-environment.ts`, which takes
//   `isolation.ts` and `start-remedy.ts` from this file;
// - through `tmux/`: `process-usage.ts` imports `local-server-reaper.ts`,
//   which reaches `tmux/session-manager.ts` through `tmux/index.ts`, and that
//   takes `isolation.ts` from this file.
//
// Keeping `commands-environment.ts`, `tmux/session-manager.ts` or
// `commands-agent-support.ts` deep instead does not shrink the set: the five
// still reach other importers of this file, and every module the deep file
// imports becomes an exception too.
// `commands-helpers.ts`, which re-exports `operations.ts` for `commands.ts`,
// lists its exports by name through this file.
//
// The `tests/unit/**` pattern has no exceptions: `disk-report.test.ts` and
// `GitHubCloneIntegration.test.tsx` import this file, which is why the
// cleanup ledger's `MAX_ENVIRONMENT_CLEANUP_ATTEMPTS` and
// `EnvironmentCleanupEntry` are re-exported. Tests, test support, the
// `apps/backend/tests` files, the e2e specs and the scripts import the modules
// directly, which the patterns allow.
export { ENVIRONMENT_AGENT_SKILLS_SCRIPT } from "./agent-skills.js";
export {
  closeEnvironmentCleanupStorage,
  environmentCleanupLedger,
  MAX_ENVIRONMENT_CLEANUP_ATTEMPTS,
  type EnvironmentCleanupEntry,
} from "./cleanup-ledger.js";
export {
  chooseEnvironmentPortBase,
  environmentIsolationShellPrefix,
  environmentIsolationVariables,
  formatEnvironmentIsolationNotice,
  isEnvironmentPortBase,
  localEnvironmentIsolationEnv,
  withEnvironmentIsolation,
} from "./isolation.js";
export {
  ENVIRONMENT_LIFECYCLE_DRAIN_TIMEOUT_MS,
  EnvironmentLifecycleTaskTracker,
  reconcileInterruptedEnvironmentLifecycleTasks,
} from "./lifecycle-tasks.js";
export {
  COMPACT_TIMESTAMP_ENVIRONMENT_NAME,
  isGeneratedEnvironmentName,
  LEGACY_TIMESTAMP_ENVIRONMENT_NAME,
} from "./name.js";
export {
  EnvironmentOperations,
  type ClientEnvironmentSetupStartResult,
  type EnvironmentSetupSession,
  type EnvironmentSetupStartResult,
} from "./operations.js";
export { environmentPortBlockAvailable } from "./port-probe.js";
export { EnvironmentMutationFence } from "./replacement-fence.js";
export { startFailureRemedy } from "./start-remedy.js";
export { environmentStateDirectory } from "./state-paths.js";
