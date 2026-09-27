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

export type CleanupResourceKind = "container" | "volume" | "network";

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
  /** An earlier release's container with no owner label: reattach or remove it by hand. */
  | "legacy-unadopted"
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

// ---------------------------------------------------------------------------
// Portable inputs (step 08)
// ---------------------------------------------------------------------------

export type InputSkipReason =
  | "symlink"
  | "not-regular"
  | "too-large"
  | "too-many-entries"
  | "aggregate-budget"
  | "unreadable"
  | "changed-while-reading";

/** Counts only: skipped names are user file names and never leave the backend. */
export interface ProviderInputSummary {
  provider: string;
  files: number;
  bytes: number;
  skipped: Partial<Record<InputSkipReason, number>>;
}

export interface EnvironmentInputStatus {
  environmentId: string;
  /**
   * `staged`: only the allowlisted inputs of the listed providers were
   * exposed. `host-mounts`: an older runtime still binds whole host agent
   * homes read-only; rebuilding narrows them. `none`: no container.
   */
  mode: "staged" | "host-mounts" | "none" | "unknown";
  revision: string | null;
  stagedAt: string | null;
  providers: ProviderInputSummary[];
  /** Enabled now but not staged into this runtime: rebuild to include. */
  missingProviders: string[];
  /** Staged into this runtime but no longer enabled: revoke or rebuild. */
  disabledProviders: string[];
  /** Revoked for this environment: never staged or synced until allowed again. */
  revokedProviders: string[];
}

export interface CredentialRevocationResult {
  provider: string;
  removed: boolean;
  /** An immutable mount still exposes the provider's inputs; rebuild to finish. */
  pendingRebuild: boolean;
  /** The provider's bridge was stopped; it restarts without the credential. */
  processesStopped: boolean;
}

// ---------------------------------------------------------------------------
// Network policy (step 09)
// ---------------------------------------------------------------------------

/**
 * Configured versus applied network policy. `effective` is what the
 * container's firewall reported after its last application; it is absent
 * when the container is stopped or predates the report.
 */
export interface EnvironmentNetworkPolicy {
  environmentId: string;
  configured: {
    mode: "full" | "restricted";
    domains: number;
    /** Digest of the allowlist the backend would hand this container. */
    domainsRevision: string;
  };
  /** 1: shared bridge with the gateway /24 open; 2: own network, narrow host access. */
  policyVersion: 1 | 2 | null;
  /**
   * Whether the saved allowlist is the one the container enforces:
   * `applied`; `pending` (saved, not yet applied — it can be applied in
   * place); `rebuild-required` (the container's image cannot change its
   * allowlist in place, or the network mode changed); `null` when unknown.
   */
  domains: "applied" | "pending" | "rebuild-required" | null;
  effective: {
    mode: "full" | "restricted";
    state: "applied" | "failed" | null;
    appliedAt: string | null;
    resolvedDomains: number | null;
    unresolvedDomains: number | null;
    allowedEntries: number | null;
    hostServicePorts: string | null;
    ipv6: "blocked" | "disabled" | null;
    /** Where GitHub's ranges came from: backend seed, live fetch or cache. */
    githubRanges: "seed" | "live" | "seed-stale" | "cached" | null;
    /** Digest of the domain list the container enforces (refreshing images). */
    domainsRevision: string | null;
    refreshedAt: string | null;
    nextRefreshAt: string | null;
    /** Domains that did not resolve and still use addresses from an earlier resolution. */
    carriedDomains: number | null;
    /** When the earliest carried address stops being trusted. */
    carriedUntil: string | null;
    refreshFailures: number | null;
    /** Entries removed from the allowlist by the last change, with their connections. */
    revokedEntries: number | null;
    revocation: "conntrack" | "unavailable" | null;
  } | null;
}
