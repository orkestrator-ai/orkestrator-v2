/**
 * ChangeTrackingPolicyRegistry: the one source of change-tracking budgets,
 * cadences and retention defaults.
 *
 * Every capture and measurement records the policy version it ran under. A
 * policy change applies to future work only; historical counts are never
 * reinterpreted. Limits of different stages keep distinct names on purpose —
 * the environment scan's 10 MiB untracked-text eligibility is not the same
 * resource as the 16 MiB retained-history limit per file — and a downgrade
 * reason names the stage that limited it.
 *
 * These are starting values for profiling, not latency or durability
 * guarantees (docs/architecture/change-tracking.md#policies).
 */

export interface ChangeTrackingPolicy {
  version: string;
  // Admission (the shared git-docker-scan pool supplies the global cap of 4).
  remoteCaptureSlots: number;
  // Boundary capture.
  foregroundBoundaryDeadlineMs: number;
  finalizationDeadlineMs: number;
  /**
   * A turn whose end capture ran out of `finalizationDeadlineMs` is captured
   * again in the background, without holding the turn: up to this many
   * attempts, this long after the turn ended and between attempts, each with
   * its own longer deadline. A new turn on the worktree cancels the retry.
   */
  endRecoveryAttempts: number;
  endRecoveryDelayMs: number;
  endRecoveryDeadlineMs: number;
  stableReadAttempts: number;
  captureMaxCandidates: number;
  captureMaxFileBytes: number;
  captureMaxBytes: number;
  captureReaders: number;
  /** Hold dispatch until a valid baseline exists (user-selected strict mode). */
  strictCheckpoints: boolean;
  // Provisional capture spacing while dirty.
  provisionalSpacingLocalMs: number;
  provisionalSpacingRemoteMs: number;
  // Live bodies and refresh.
  liveBodyCoalesceMs: number;
  manualRefreshDeadlineMs: number;
  /** How long after its last read a scan still recomputes a Git scope. */
  gitScopeDemandTtlMs: number;
  // Responses.
  diffInitialBodyBytes: number;
  diffBatchBytes: number;
  filePageRows: number;
  filePageBytes: number;
  /** File rows stored per measurement built from a whole-tree comparison or scan. */
  measurementFileRowCap: number;
  // Caches.
  hunkCacheBytes: number;
  hunkCacheEntries: number;
  summaryMemoryBytes: number;
  // Ingress.
  canonicalFrameMetadataMaxBytes: number;
  backendIngressMemoryFrames: number;
  backendIngressMemoryBytes: number;
  activeCaptureWindowsPerWorktree: number;
  fragmentDiffInputMaxBytes: number;
  fragmentDiffCpuBudgetMs: number;
  fragmentDiffWorkingMemoryBytes: number;
  evidencePullEntries: number;
  // Retention.
  snapshotSoftBudgetBytes: number;
  snapshotHardBudgetBytes: number;
  archivedBodyRetentionDays: number;
  orphanGraceMs: number;
  idleOwnerGraceMs: number;
  // Restore.
  restoreEnabled: boolean;
  restoreTokenTtlMs: number;
  /**
   * The restore preview's destination preflight reads every planned path in
   * turn, so its deadline is this floor or the per-path budget times the plan,
   * whichever is larger, never past the ceiling.
   */
  restorePreflightDeadlineMs: number;
  restorePreflightPerPathMs: number;
  restorePreflightMaxDeadlineMs: number;
}

export const CHANGE_TRACKING_POLICY_V1: Readonly<ChangeTrackingPolicy> = Object.freeze({
  version: "change-tracking-policy-v1",
  remoteCaptureSlots: 2,
  foregroundBoundaryDeadlineMs: 10_000,
  finalizationDeadlineMs: 30_000,
  endRecoveryAttempts: 3,
  endRecoveryDelayMs: 5_000,
  endRecoveryDeadlineMs: 5 * 60_000,
  stableReadAttempts: 2,
  captureMaxCandidates: 100_000,
  captureMaxFileBytes: 16 * 1024 * 1024,
  captureMaxBytes: 256 * 1024 * 1024,
  captureReaders: 8,
  strictCheckpoints: false,
  provisionalSpacingLocalMs: 1_000,
  provisionalSpacingRemoteMs: 5_000,
  liveBodyCoalesceMs: 250,
  manualRefreshDeadlineMs: 15_000,
  gitScopeDemandTtlMs: 120_000,
  diffInitialBodyBytes: 256 * 1024,
  diffBatchBytes: 1024 * 1024,
  filePageRows: 200,
  filePageBytes: 256 * 1024,
  measurementFileRowCap: 2_000,
  hunkCacheBytes: 64 * 1024 * 1024,
  hunkCacheEntries: 128,
  summaryMemoryBytes: 16 * 1024 * 1024,
  canonicalFrameMetadataMaxBytes: 256 * 1024,
  backendIngressMemoryFrames: 2_048,
  backendIngressMemoryBytes: 16 * 1024 * 1024,
  activeCaptureWindowsPerWorktree: 256,
  fragmentDiffInputMaxBytes: 8 * 1024 * 1024,
  fragmentDiffCpuBudgetMs: 500,
  fragmentDiffWorkingMemoryBytes: 32 * 1024 * 1024,
  evidencePullEntries: 256,
  snapshotSoftBudgetBytes: 1024 * 1024 * 1024,
  snapshotHardBudgetBytes: 4 * 1024 * 1024 * 1024,
  archivedBodyRetentionDays: 30,
  orphanGraceMs: 60 * 60_000,
  idleOwnerGraceMs: 30_000,
  restoreEnabled: true,
  restoreTokenTtlMs: 5 * 60_000,
  restorePreflightDeadlineMs: 10_000,
  restorePreflightPerPathMs: 5,
  restorePreflightMaxDeadlineMs: 5 * 60_000,
});

export class ChangeTrackingPolicyRegistry {
  private current: Readonly<ChangeTrackingPolicy>;

  constructor(overrides: Partial<ChangeTrackingPolicy> = {}) {
    this.current = Object.freeze({ ...CHANGE_TRACKING_POLICY_V1, ...overrides });
  }

  get policy(): Readonly<ChangeTrackingPolicy> {
    return this.current;
  }

  /** Future work uses the update; recorded measurements keep their version. */
  update(overrides: Partial<ChangeTrackingPolicy>, version: string): void {
    this.current = Object.freeze({ ...this.current, ...overrides, version });
  }
}
