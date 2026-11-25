// The storage domain's public surface: the module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// The domain is the backend's storage layer (docs/architecture/storage.md):
// the SQLite database and its stores, layouts, migrations and backups
// (`database*.ts`, `stores.ts`, `backups.ts`, `checkpointer.ts`, the
// `*-upgrade.ts` and `record-upgrades.ts` migrations), the shared context
// and change journal (`context.ts`, `changes.ts`, `files.ts`), the
// `StorageService` facade (`service.ts`) and the repository registry
// (`repositories.ts`), one repository per store group (`projects.ts`,
// `kanban*.ts`, `native*.ts`, `agent-mail*.ts`, `prompt*.ts`, …), the
// record types and helpers they share (`shared*.ts`) and the writer guard's
// analysis (`writer-guards-test-support.ts`).
//
// Three modules are named exceptions in the `apps/backend/src/**` pattern of
// `.oxlintrc.json`. Each reaches, at runtime, a module that imports this
// file, so a value re-export of it here would close a runtime import cycle;
// code that needs one of their values imports it directly:
//
// - `service.ts` (`StorageService`, constructed by `index.ts` and
//   `control-mcp/server.ts`) reaches every repository through `context.ts`
//   and `repositories.ts`, and with them the domains whose stores they own;
// - `stores.ts` (`openBackendDatabase` and `LEGACY_JSON_DIRECTORY`, for the
//   engines with stores of their own) imports each domain's store layout and
//   migration, among them `change-tracking/ledger-schema.ts`,
//   `build-pipeline/index.ts` and `native-agent/index.ts`, whose modules
//   import this file;
// - `coordinators.ts` (`coordinatorAttachmentsRoot`, for
//   `readable-host-roots.ts`) imports `coordinator/index.ts`, which reaches
//   the review, build-pipeline and native-agent modules that import this
//   file.
//
// Their types are re-exported below with `export type`, which adds no
// runtime edge, so type-only importers (`StorageService` above all) still
// import this file. Every other module's symbols are re-exported here, and
// no other module needs an exception.
//
// The `tests/unit/**` pattern has three exceptions: `service.ts` and
// `stores.ts` (for the tests that construct a `StorageService` or open the
// database) and `test-support.ts` (for `tmux-mail-benchmark.test.ts`), which
// this file must not re-export. `defaultConfig` is re-exported for
// `SettingsPage.test.tsx`. Tests, test support, the `apps/backend/tests`
// files, the e2e specs and the scripts import the modules directly, which
// the patterns allow.
export { storageActivityMetrics } from "./activity-metrics.js";
export { AGENT_MAIL_MAX_VERIFY_ATTEMPTS, isRideAlongMessage } from "./agent-mail-injects.js";
export type { AgentMailSender } from "./agent-mail-store.js";
export { readTopTables, snapshotBeforeMigration, summarizeStorageSnapshots } from "./backups.js";
export type { BugReportRecord, BugReportsStorage } from "./bug-reports.js";
export type { CapabilitiesStorage } from "./capabilities.js";
export { backgroundCheckpointsByDefault, pauseBackgroundCheckpoints } from "./checkpointer.js";
export type { UsageLimitNoticeGroup, UsageLimitNoticeLedger } from "./coordinator-notices.js";
export type { CoordinatorsStorage } from "./coordinators.js";
export { StoreCorruptError } from "./database-errors.js";
export {
  CHANGE_LEDGER_DATABASE_FILE,
  StorageDatabase,
  type StorageDatabaseOptions,
  type StorageMigration,
  type StoreLayout,
  type StoreRows,
} from "./database.js";
export { deletionFence, deletionMarker, markDeletion } from "./deletion-fences.js";
export { deepFreeze } from "./frozen-snapshot.js";
export {
  GRAPH_DESCRIBE_JOB_VERSION,
  type GraphDescribeStorage,
  GraphDescribeStorageError,
  type PersistedGraphDescribeJob,
} from "./graph-describe.js";
export type { GraphEffectRecord, GraphEffectsStorage } from "./graph-effects.js";
export { type GraphArtifactUsage, type GraphRunsStorage, graphStorageHash } from "./graph-runs.js";
export type { GraphTemplatesStorage, PersistedGraphSharingKeys } from "./graph-templates.js";
export { parseKanbanLabelInput } from "./kanban-labels.js";
export { NoStoredProjectsError } from "./kanban-removed-projects.js";
export type { TicketSyncStorage } from "./kanban-sync-repository.js";
export type { KanbanStorage, KanbanTaskContentInput } from "./kanban.js";
export { leaseWaitMetrics } from "./lease-metrics.js";
export {
  isSyncableLinearLinkKey,
  type LinearBoardLink,
  linearBoardLinkKey,
  type LinearCommentOutcome,
  type LinearMergedLabelInput,
  type LinearMergedLabelOutcome,
  type LinearRevocation,
  type LinearPendingComment,
  type LinearWriteClaimRef,
  ownsLinearWrite,
  MAX_LINEAR_PENDING_COMMENTS,
  type LinearStorage,
  MAX_LINEAR_COMMENT_BODY,
} from "./linear.js";
export type { NodesStorage, NodeStoreMutation } from "./nodes.js";
export {
  DEFAULT_PREVIEW_SETTINGS,
  type LoadedPreviewServiceStore,
  type PreviewMutationRecord,
  type PreviewServicesStorage,
  type PreviewServiceStore,
  type PreviewSettings,
} from "./preview-services.js";
export { ControlRequestConflictError, ProjectHasEnvironmentsError } from "./projects.js";
export {
  isFrozenPromptQueueMessage,
  isPromptQueueMessageConflict,
  PROMPT_QUEUE_NEW_PUBLICATION_REFUSED,
} from "./prompts.js";
export type { StorageService } from "./service.js";
export { defaultConfig, defaultRepositoryConfig } from "./shared-config.js";
export {
  createEnvironment,
  createProject,
  defaultEnvironmentName,
  type Environment,
  type FeaturePlan,
  type FeaturePlanMessage,
  isPortMapping,
  isRecord,
  type JsonRecord,
  type KanbanStatus,
  type KanbanTask,
  nowIso,
  type PersistedBuildPipeline,
  resizeKanbanImage,
  sanitizeBranchName,
  sanitizeEnvironmentName,
} from "./shared-core.js";
export {
  FeaturePlanningFenceError,
  parseUpdateObject,
  PendingNativeAgentDispatchError,
  PendingNativeAgentSteerError,
  type ResourceChangeListener,
} from "./shared-extra.js";
export { AGENT_MODEL_CATALOG_MAX_AGE_MS } from "./shared-model-catalogs.js";
export { deliveredAgentHandoffIds, sessionSignInResend } from "./shared-native-sessions.js";
export {
  AGENT_HANDOFF_PRUNE_GRACE_MS,
  assertPaneLayoutRootWithinBounds,
  type MutablePaneLayoutLeaf,
  paneLayoutAgentHandoffIds,
  paneLayoutLeaves,
  pendingPaneLayoutAgentHandoffId,
} from "./shared-pane-layout.js";
export { slowStorageOperations } from "./slow-operations.js";
export {
  type PersistedSuborkBatch,
  type PersistedSuborkBranch,
  type PersistedSuborkRefusal,
  SUBORK_BATCH_VERSION,
  type SuborksStorage,
  SuborkStorageError,
} from "./suborks.js";
export type { WatchedPullRequest, WatchedPullRequestReading } from "./watched-pull-requests.js";
