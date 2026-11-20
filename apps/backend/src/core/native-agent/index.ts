// The native-agent domain's public surface: the module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// The domain is Native Mode's session layer: `NativeAgentService`
// (`service.ts`, `service-shared.ts`) and the collaborators it is split into
// (docs/architecture/native-agent-service.md#collaborators): the provider and
// its registry (`provider.ts`, `provider-registry.ts`), prompt dispatch and
// the prompt queue (`prompt-dispatch.ts`, `prompt-queue-*.ts`, `queue-*.ts`),
// session operations and controls, observation and activity, turn recovery,
// mail injection, goals (`goal-*.ts`), suborks (`suborks.ts`,
// `subork-host.ts`), handoffs, catalogues, session titles, and the transcript
// projection with its read models (`transcript-projection.ts`, `projection-*.ts`,
// `progressive-*.ts`, `display-tail*.ts`, `full-projection.ts`, …) and the
// terminal rows it adds (`terminal-messages.ts`). The
// session stores (`storage-native*.ts`), the native commands
// (`commands-registry-native*.ts`) and the session invalidation metrics
// (`native-session-invalidation-metrics.ts`, which the storage layer and the
// recurring diagnostics also read) stay with their own groups.
//
// Nine modules are named exceptions in the `apps/backend/src/**` pattern of
// `.oxlintrc.json`: imported directly, not part of this surface.
//
// - Eight of them would close a runtime import cycle. Each reaches, at
//   runtime, a module that imports one of the modules re-exported here; every
//   module re-exported here reaches none. `service.ts` (the composition root,
//   the native, coordinator, project and teardown commands and the Fix
//   dispatch), `service-shared.ts` (the commands, the public API's session
//   actions, the credentials host, bug reports, the coordinator's goal
//   actions, PR auto-merge and web annotations), `suborks.ts` and
//   `goal-verifier.ts` (the composition root) and `provider.ts` (the build
//   pipeline's stage provider) reach the storage layer (`storage-native.ts`,
//   `storage-stores.ts`), the HTTP bridge provider, OpenCode 2's coordinator
//   and transcript snapshot, the graph run launch and the workflow transcript
//   artifacts, which import `session-controls.ts`, `display-tail*.ts`,
//   `retired-parameters.ts`, `inline-files.ts`, `execution-policy.ts` and
//   `service-projection-artifacts.ts`. `job-tab-reuse.ts`,
//   `job-pipeline-resolve.ts` (the controller commands) and `goal-check.ts`
//   (the composition root) reach them too, and also the public API's session
//   goal actions, which import `goal-service.ts`.
// - `service-test-collaborators.ts` is test-only: `public-api/test-provider.ts`,
//   a test harness whose name the tests-off override does not match, reads a
//   service's collaborators through it.
//
// Under `tests/unit/**` the one exception is `service-projection-test-support.ts`,
// the projection test support `tests/unit/native-agent-deferred-normalization.test.ts`
// drives a service with; no production importer outside the folder uses it.
export {
  type ActivityGroupProvider,
  type ActivityGroupRead,
  readActivityGroup,
} from "./activity-reads.js";
export {
  decodeHistoryCursor,
  DIRECT_HISTORY_CURSOR_MAX_LENGTH,
  encodeDirectHistoryCursor,
} from "./direct-history.js";
export { NATIVE_AGENT_DISPLAY_TAIL_STORE_LAYOUTS } from "./display-tail-layout.js";
export {
  type NativeAgentDisplayTailDeletion,
  NativeAgentDisplayTailStore,
} from "./display-tail-store.js";
export { isNativeAgentDisplayTail, type NativeAgentDisplayTail } from "./display-tails.js";
export {
  resolveEnvironmentExecutionPolicy,
  resolveNativeAgentExecutionPolicy,
} from "./execution-policy.js";
export { GoalCommandError, goalIdForRequest } from "./goal-service.js";
export { inlineFileContentLabel, inlineFileUrlDisposition } from "./inline-files.js";
export { openCodeWorkflowDependencies } from "./opencode-server.js";
export {
  isSpliceableResult,
  markSpliceableResult,
  spliceEncodedJsonBytes,
} from "./projection-encoding.js";
export { withoutRetiredParameterValues } from "./retired-parameters.js";
export {
  type ArtifactLedgerReader,
  ArtifactOverlayIndex,
  overlayArtifactParts,
} from "./service-projection-artifacts.js";
export { nativeAgentSessionWithControls } from "./session-controls.js";
export { nativeAgentSessionStorageKey } from "./session-key.js";
