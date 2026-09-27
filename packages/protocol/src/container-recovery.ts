/**
 * Recovery copies and reviewed cleanup (containers plan step 07).
 *
 * Every row is content-free: resource identities, roles, reasons and sizes,
 * never file names or contents.
 */
import type { ContainerRuntimeIdentity, RetainedStorageSet } from "./container-lifecycle.js";

export type RecoveryCopyReason =
  | RetainedStorageSet["reason"]
  | NonNullable<ContainerRuntimeIdentity["retainedReason"]>;

/**
 * One restorable earlier state of an environment: a retained runtime (whose
 * writable layer is the copy, for a legacy environment), a retained storage
 * set, or both when a volume-backed runtime and its set were kept together.
 */
export interface RecoveryCopy {
  /** The storage set id, or the retained container id for a legacy copy. */
  copyId: string;
  kind: "legacy-runtime" | "storage-set";
  reason: RecoveryCopyReason;
  retainedAt: string | null;
  operationId: string | null;
  containerId: string | null;
  storageSetId: string | null;
  volumes: string[];
  workspaceGeneration: number | null;
  /** Docker's view when last listed; `unknown` when it could not be asked. */
  presence: "present" | "partial" | "missing" | "unknown";
  /** Writable-layer bytes of a legacy runtime, when measured. */
  sizeBytes: number | null;
  /** A failed candidate or a copy with missing resources cannot be restored. */
  restorable: boolean;
}

export interface RecoveryCopyList {
  environmentId: string;
  /** Lifecycle record revision the list was read at; mutations bind to it. */
  revision: number;
  copies: RecoveryCopy[];
  limit: number;
}

export type CleanupResourceKind = "container" | "volume";

export type CleanupClassification =
  | "eligible"
  | "assigned"
  | "retained-recovery"
  | "live-environment-label"
  | "operation-in-flight"
  | "deletion-pending"
  | "running"
  | "foreign-owner"
  | "identity-uncertain"
  | "in-use";

export interface CleanupPreviewRow {
  kind: CleanupResourceKind;
  /** Container id or volume name. */
  id: string;
  name: string;
  environmentId: string | null;
  /** Descriptive role label (`workspace`, `state`, runtime state). */
  role: string | null;
  sizeBytes: number | null;
  classification: CleanupClassification;
}

export interface CleanupPreview {
  /** Bound to this exact eligible set; expires. */
  selectionToken: string;
  expiresAt: string;
  rows: CleanupPreviewRow[];
  /** More resources exist than one preview enumerates. */
  truncated: boolean;
}

export type CleanupOutcomeKind = "removed" | "already-absent" | "skipped" | "conflict" | "failed";

export interface CleanupResourceOutcome {
  kind: CleanupResourceKind;
  id: string;
  outcome: CleanupOutcomeKind;
  /** Why it was skipped or conflicted: the classification found at removal. */
  reason?: CleanupClassification | "not-in-preview" | "state-changed" | "removal-failed";
}

export interface CleanupExecuteResult {
  outcomes: CleanupResourceOutcome[];
  removed: number;
  alreadyAbsent: number;
  skipped: number;
  conflicts: number;
  failed: number;
  reclaimedBytes: number;
}
