// The review domain's public surface: the module other backend code imports.
// Re-export by name (never `export *`) so the surface stays reviewable.
//
// The domain is Multi Review and the review machinery it shares with the
// build pipeline's review stages: the Multi Review service and its graph
// engine (`service.ts`, `graph-*.ts`), steps, prompts, scheduling, progress,
// refusals, worker mail, transcripts and auto-PR (`steps.ts`,
// `multi-review-prompts.ts`, `scheduling.ts`, `progress.ts`, `auto-pr.ts`, …),
// the Fix (Address Findings) dispatch, the reviewer fan-out
// (`fanout*.ts`, `efficiency.ts`, `provisional-findings.ts`), the review
// package, its sealed diff and evidence permits (`package.ts`,
// `diff-artifact.ts`, `evidence-permits.ts`), consolidation
// (`consolidation-*.ts`), review validation (`validation-*.ts`), the worktree
// probe and fingerprint (`worktree-*.ts`), opening a Multi Review tab
// (`tab-actions.ts`) and the startup cleanup of retired looped reviews
// (`retired-looped-review-cleanup.ts`). The build pipeline's own review
// stages (`build-pipeline-review-*.ts`), the review commands
// (`commands-review.ts`, `commands-registry-reviews.ts`) and the review
// stores (`storage-reviews.ts`) stay with their own prefix groups.
//
// Eight modules are named exceptions in `.oxlintrc.json`: imported directly,
// not part of this surface, because routing their importers through this file
// would close a runtime import cycle.
//
// - `service.ts`, `address-findings-dispatch.ts` and
//   `retired-looped-review-cleanup.ts` (imported only by the composition
//   root, `core/index.ts`), `graph-engine.ts` (imported by the composition
//   root and `graph-agent-host.ts`), `fanout.ts` (imported by
//   `build-pipeline-review-fanout.ts`) and `validation-service.ts` (imported
//   by the review commands, the build pipeline supervisor, graph validation
//   and environment teardown) reach the graph runtime, the workflow result
//   contracts and the coordinator's status wakes. Re-exporting any of them
//   would put importers of the modules re-exported here
//   (`graph-run-pass.ts`, `workflows/result-contracts.ts`,
//   `coordinator/status-wakes.ts`, …) inside this file's own graph.
// - `validation-prompts.ts` and `consolidation-scope.ts` are leaves, but
//   `build-pipeline-prompts.ts` imports both, and `multi-review-prompts.ts`,
//   re-exported here, imports `build-pipeline-prompts.ts`.
export { multiReviewAddressFindingsIdentity } from "./address-findings-identity.js";
export {
  MULTI_REVIEW_AUTO_PR_EXISTS_MESSAGE,
  MULTI_REVIEW_AUTO_PR_TAB_TITLE,
  launchPrAgent,
  launchResolveConflictsAgent,
} from "./auto-pr.js";
export { ConsolidationBudgetError } from "./consolidation-evidence.js";
export {
  REVIEW_CONSOLIDATION_PROVENANCE,
  REVIEW_CONSOLIDATION_WORDING,
  isReviewConsolidationProvenance,
  reviewConsolidationProvenanceFields,
} from "./consolidation-provenance.js";
export {
  MAX_REVIEW_DIFF_ARTIFACT_BYTES,
  reviewChunkCoverageFailure,
  reviewDiffArgs,
  sealReviewDiff,
  verifyReviewDiffArtifact,
} from "./diff-artifact.js";
export {
  disputedCheckDigests,
  disputedCheckRerunRequest,
  disputedCheckSubmissionIssues,
  disputedReviewChecks,
  recordDisputedChecks,
  settleDisputedCheckReruns,
} from "./disputed-checks.js";
export {
  efficiencyPlatform,
  recordEfficiency,
  type EfficiencyEvent,
  type EfficiencyOwner,
  type EfficiencyPhase,
  type EfficiencyPlatform,
  type MultiReviewEfficiencyObserver,
} from "./efficiency.js";
export { clearReviewerAdmission, compactReviewerAdmissionQueue } from "./fanout-admission.js";
export {
  reviewFanoutConcurrency,
  runBoundedTasks,
  type ReviewFanoutConcurrency,
} from "./fanout-scheduler.js";
export { PassTranscriptReader } from "./fanout-transcript.js";
export { createMultiReviewConsolidationPrompt, reviewerPanelTail } from "./multi-review-prompts.js";
export { multiReviewNativeAddressFindingsOptions } from "./native-address-findings.js";
export {
  MAX_PERSISTED_REVIEW_PACKAGE_BYTES,
  normalizeGeneratedReviewPackage,
  parseReviewPackageReference,
  reviewPackageFileContents,
  reviewPackageReference,
} from "./package.js";
export {
  DEFAULT_STALL_ABANDON_MS,
  DEFAULT_STALL_WARNING_MS,
  MultiReviewProgressTracker,
  noProgressElapsedMs,
  stalledMinutes,
  type ProgressObservation,
} from "./progress.js";
export {
  REVIEW_ADDRESS_FINDINGS_RESULT_JSON_SCHEMA,
  REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
  REVIEW_PR_RESULT_JSON_SCHEMA,
  REVIEW_RECONCILIATION_RESULT_JSON_SCHEMA,
  createDiscoveryPrompt,
  parseAddressFindingsResult,
  parsePrResult,
  parseReviewPreparationResult,
  type ReviewAddressFindingsResult,
} from "./prompts.js";
export {
  ProvisionalFindingInbox,
  combineProvisionalFindingSinks,
  dropProvisionalFindings,
  type ProvisionalFindingSink,
  type ReportFindingResult,
} from "./provisional-findings.js";
export { openMultiReviewTab } from "./tab-actions.js";
export {
  WorkspaceFileHashError,
  hashEnvironmentWorkspaceFile,
  verifyValidationArtifacts,
  type WorkspaceFileHashFailure,
} from "./validation-artifacts.js";
export {
  REVIEW_WORKTREE_FINGERPRINT_TIMEOUT_MS,
  REVIEW_WORKTREE_PROBE_TIMEOUT_MS,
  parseReviewWorktreeFingerprint,
  reviewWorktreeProbeArgs,
} from "./worktree-fingerprint.js";
export {
  probeReviewWorktree,
  probeReviewWorktreeOnce,
  type ReviewWorktreeProbeInvoker,
  type ReviewWorktreeProbeOptions,
} from "./worktree-probe.js";
