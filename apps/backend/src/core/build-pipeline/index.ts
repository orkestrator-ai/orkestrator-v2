// The build-pipeline domain's public surface: the module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// The domain is the build pipeline: its service and the collaborators it is
// split into (`service*.ts`), the stage provider and prompt dispatch
// (`provider.ts`, `prompt-dispatch.ts`), stages, prompts and instructions
// (`stages.ts`, `prompts.ts`, `stage-prompts.ts`), launch, scheduling and
// restarts (`launch.ts`, `scheduling.ts`, `restart-targets.ts`, `rewind.ts`,
// `code-rewind.ts`), the review stage (`review-*.ts`, `reviewer-rerun.ts`),
// validation (`validation-*.ts`), key information and reports
// (`key-information*.ts`, `criteria-report.ts`,
// `address-findings-report.ts`), the Kanban ticket lifecycle (`kanban-*.ts`,
// `ticket-hold.ts`), the transcript store (`transcript*.ts`), worker mail and
// worker identity (`worker-mail.ts`, `pipeline-worker-identity.ts`) and the
// workflow summary a coordinator reads (`control-workflow-summary.ts`). The
// build-pipeline store (`storage-build-pipelines.ts`), the build commands
// (`commands-registry-build.ts`), Auto-pipeline (`auto-pipeline*.ts`) and the
// coordinator's status line (`coordinator/build-pipeline-status.ts`) stay
// with their own groups.
//
// Seven modules are named exceptions in `.oxlintrc.json`: imported directly,
// not part of this surface, because routing their importers through this
// file would close a runtime import cycle. Each of them reaches, at runtime,
// a module that imports one of the modules re-exported here; every module
// re-exported here reaches none.
//
// - `service.ts` (the composition root, `core/index.ts`) and
//   `worker-mail.ts` (the composition root) reach the storage layer, the agent
//   tools and the coordinator's status line, which import
//   `transcript-store.ts`, `ticket-hold.ts`, `pipeline-worker-identity.ts`,
//   `stages.ts` and `criteria-report.ts`.
// - `provider.ts` (the agent branch runner, the graph agent providers, the
//   Subork host, feature planning and Multi Review) and
//   `transcript-projection.ts` (the build commands) reach the storage layer
//   too.
// - `launch.ts` (the build, coordinator and controller commands,
//   Auto-pipeline and feature builds) and `key-information-tools.ts` (the
//   agent tools) reach `storage-stores.ts`, which imports
//   `transcript-layout.ts`.
// - `control-workflow-summary.ts` (the coordinator's MCP tools and the public
//   review actions) and the six above reach `review/prompts.ts`,
//   `review/multi-review-prompts.ts` and `native-agent/transcript-progress.ts`, which
//   import `prompts.ts` and `service-helpers.ts`.
export { BuildPipelineActivity } from "./activity.js";
export { readEnvironmentBranchPushState } from "./branch-push.js";
export type { EnvironmentGit } from "./code-rewind.js";
export type { CompletedBuildAttempt } from "./completed-build.js";
export type { PipelineWorkerMailbox } from "./context.js";
export { buildPipelineCriteriaReport, criteriaNoticeLines } from "./criteria-report.js";
export { buildPipelineDetailFingerprint } from "./detail-fingerprint.js";
export { settleTicketsOfDeletedEnvironment } from "./kanban-environment-deleted.js";
export { buildPipelineKanbanUpdate, type BuildPipelineKanbanUpdate } from "./kanban-lifecycle.js";
export type { BuildPipelineKeyInformationHost } from "./key-information.js";
export { registerLongCheckTools } from "./long-check-tools.js";
export type { BuildPipelineLongCheckHost } from "./long-checks.js";
export {
  authenticatePipelineWorkerMailCapability,
  type PipelineWorkerMailTurn,
  pipelineWorkerTabForResultKey,
  workerMailTurnFor,
} from "./pipeline-worker-identity.js";
export {
  addressFindingsPrompt,
  addressFindingsReportPrompt,
  addressFindingsValidationGuidance,
  buildPipelineReviewPackageContext,
  buildTaskPrompt,
  multiReviewAddressFindingsValidationInstruction,
  type ObservedWorktreeSnapshot,
  pullRequestDescriptionPrompt,
  resolveConflictsLocallyPrompt,
  REVIEW_PREPARATION_OUTPUT_CONTRACT,
  type ReviewWorktreeSnapshot,
  reworkTaskPrompt,
  structuredReportRepairPrompt,
  verificationTaskPrompt,
  worktreeSnapshotSection,
  type WorktreeSnapshotWording,
} from "./prompts.js";
export {
  type AgentModelCatalogReader,
  buildAdmissionKey,
  type CommandInvoker,
  connectionDefaultsFor,
  createAgentModelCatalogReader,
  legacyTranscriptFingerprint,
  resolveFastMode,
  transcriptFingerprint,
} from "./service-helpers.js";
export { buildPipelineSessionStage, sessionPhaseForBuildPhase } from "./stages.js";
export {
  type BuildTicketHolds,
  NO_BUILD_TICKET_HOLDS,
  ticketHeldByBuild,
  ticketsHeldByBuilds,
} from "./ticket-hold.js";
export { BUILD_PIPELINE_TRANSCRIPT_STORE_LAYOUTS } from "./transcript-layout.js";
export {
  type BuildPipelineTranscriptMigrationReport,
  type InlineImportBatchEntry,
  type InlineImportBatchOutcome,
  migrateInlineBuildPipelineTranscripts,
} from "./transcript-migration.js";
export {
  BUILD_PIPELINE_TRANSCRIPT_DIRECTORY,
  type BuildPipelineTranscriptFaults,
  type BuildPipelineTranscriptFaultStage,
  type BuildPipelineTranscriptLimits,
  type BuildPipelineTranscriptStats,
  BuildPipelineTranscriptStore,
  type StagedTranscript,
  type TranscriptCommitInput,
  type TranscriptCommitResult,
  transcriptPipelineTag,
  type TranscriptRead,
  type TranscriptReadWindow,
  transcriptSessionKey,
} from "./transcript-store.js";
export { LEGACY_BUILD_PIPELINE_SNAPSHOT_LIMIT_BYTES, readInlineTranscript } from "./transcripts.js";
export { readPipelineWorkerTranscript } from "./worker-transcript.js";
