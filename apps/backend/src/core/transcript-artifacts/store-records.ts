/**
 * Persisted record shapes for transcript artifacts, with decode-time checks.
 *
 * Every row carries a `schemaVersion`. Decoding first runs the explicit
 * migration chain in `RECORD_MIGRATIONS` (version → upgrade to version + 1)
 * up to `RECORD_SCHEMA_VERSION`; version 1 is the current shape, so today the
 * chain is the identity and a row from an unknown (newer or older) version
 * decodes as `storage_corrupt`. The decoded value is then re-validated: the
 * identity and ownership fields, the kind discriminants, and the cheap parts
 * of each payload (field types, bounded arrays, asset/capture references).
 * Full content validation (chart data, HTML policy) is not repeated on every
 * read; the writer validated it before commit and content hashes are checked
 * where bytes are served. A row that fails is `storage_corrupt`, never absent,
 * which would let a retry create a second record.
 */
import {
  ARTIFACT_KINDS,
  ARTIFACT_OPERATION_STATUSES,
  ArtifactFailure,
  artifactError,
  type ArtifactCapture,
  type ArtifactHeadRecord,
  type ArtifactKind,
  type ArtifactOperation,
  type ArtifactOwner,
  type ArtifactPreviewProfile,
  type ArtifactPublication,
  type ArtifactRevisionRecord,
  type ArtifactVerificationReceipt,
} from "@orkestrator/protocol/transcript-artifacts";

export const RECORD_SCHEMA_VERSION = 1;

export type StoredHead = ArtifactHeadRecord & {
  title: string;
  /** Turn that created the artifact, when known. */
  createdTurnId?: string;
};

export type StoredRevision = ArtifactRevisionRecord;

export interface PreparedDocumentRef {
  documentSha256: string;
  byteLength: number;
  contentSecurityPolicy: string;
  scriptHashes: string[];
  dependencyManifestHash: string;
  runtimeVersion: string;
  policyVersion: string;
  readinessNonce: string;
  resolvedDependencies: Array<{ id: string; version: string; sha256: string; license: string }>;
}

/**
 * A PDF the isolated worker printed for one receipt of a revision under one
 * print profile (see print-profile.ts). The bytes are a content-addressed asset.
 */
export interface PrintedPdfRef {
  receiptId: string;
  /** The receipt's effective-document hash the PDF was printed from. */
  effectiveSourceHash: string;
  printProfileHash: string;
  printProfileVersion: string;
  paper: "a4" | "letter";
  sha256: string;
  byteLength: number;
  pageCount: number;
  browserBuild: string;
  rendererBundleHash: string;
  createdAt: string;
}

/** Derived representations of one immutable revision; the revision row is never rewritten. */
export interface StoredDerived {
  schemaVersion: 1;
  artifactId: string;
  revision: number;
  prepared: PreparedDocumentRef[];
  /** Optional (additive): printed PDFs, at most a few per revision. */
  printed?: PrintedPdfRef[];
}

export type StoredOperation = ArtifactOperation & {
  owner: ArtifactOwner;
  kind: ArtifactKind;
  /** Bumped when execution starts; a completion commits only under its own generation. */
  generation: number;
  lease: { holder: string; expiresAt: string } | null;
  transientRetries: number;
  turnKey: string;
};

export type StoredReceipt = ArtifactVerificationReceipt & {
  owner: ArtifactOwner;
  profile: ArtifactPreviewProfile | null;
  semantics: "not-assessed" | "probes-passed";
};

export type StoredPublication = ArtifactPublication;

export interface StoredIdempotency {
  schemaVersion: 1;
  key: string;
  conversationKey: string;
  operationKind: string;
  digest: string;
  /**
   * `pending`: reserved by an admitted request whose expensive work is still
   * running (`reservation` names the holder and its expiry). A lapsed
   * reservation is treated as absent; it never becomes a result.
   */
  state: "pending" | "completed" | "expired";
  reservation?: { holder: string; expiresAt: string };
  artifactId?: string;
  /** Compact tool response (≤16 KiB); absent on an expired tombstone. */
  response?: Record<string, unknown>;
  isError?: boolean;
  createdAt: string;
}

export interface StoredOutbox {
  schemaVersion: 1;
  eventId: string;
  kind: "publication";
  publicationId: string;
  conversationKey: string;
  sequence: number;
  createdAt: string;
  deliveredAt?: string;
}

export interface StoredConversation {
  schemaVersion: 1;
  conversationKey: string;
  sequence: number;
  /** Explicit conversation deletion fence: nothing may be written for it again. */
  deletedAt?: string;
  /** Unpublished-draft slots reserved by admitted creates (request key, expiry). */
  pendingCreates?: Array<{ key: string; expiresAt: string }>;
}

/** An upload staged for use as an artifact asset (owner-scoped; bytes content-addressed). */
export interface StoredStagedAsset {
  schemaVersion: 1;
  stagedId: string;
  owner: ArtifactOwner;
  name: string;
  mimeType: string;
  sha256: string;
  byteLength: number;
  createdAt: string;
}

export interface StoredAsset {
  schemaVersion: 1;
  sha256: string;
  byteLength: number;
  mimeType: string;
  createdAt: string;
  /** Set by the collector's mark phase; cleared when a reference reappears. */
  unreferencedSince: string | null;
}

export interface StoredRepair {
  schemaVersion: 1;
  artifactId: string;
  conversationKey: string;
  turnKey: string;
  updates: number;
  updatedAt: string;
}

export interface StoredQuota {
  schemaVersion: 1;
  assetBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isString = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositive = (value: unknown): value is number => isCount(value) && value > 0;
const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isOptionalString = (value: unknown) => value === undefined || isString(value);

/** A stored output/asset reference: content address, MIME type and size. */
function isOutputRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.assetId) &&
    isSha256(value.sha256) &&
    isString(value.mimeType) &&
    isCount(value.byteLength)
  );
}

function isCaptureList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 3 &&
    value.every(
      (capture) => isOutputRef(capture) && isPositive(capture.width) && isPositive(capture.height),
    )
  );
}

function isAssetList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (asset) =>
        isRecord(asset) &&
        isString(asset.name) &&
        isString(asset.assetId) &&
        isSha256(asset.sha256) &&
        isString(asset.mimeType) &&
        isCount(asset.byteLength),
    )
  );
}

/** Cheap per-kind payload checks: discriminant and top-level field types only. */
function isPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "html-static":
      return isString(value.html);
    case "html-interactive":
      return (
        isString(value.html) &&
        (value.dependencyIds === undefined ||
          (Array.isArray(value.dependencyIds) && value.dependencyIds.every(isString))) &&
        (value.probes === undefined || (Array.isArray(value.probes) && value.probes.length <= 20))
      );
    case "mermaid":
      return isString(value.source);
    case "chart":
      return isRecord(value.spec);
    case "workflow-snapshot":
      return (
        isRecord(value.snapshot) &&
        isString(value.snapshot.workflowId) &&
        isString(value.snapshot.runId) &&
        isString(value.snapshot.sourceRevision)
      );
    default:
      return false;
  }
}

function isEvidence(value: unknown, kind: unknown): boolean {
  if (!isRecord(value) || value.kind !== kind) return false;
  switch (value.kind) {
    case "html-static":
      return isCaptureList(value.captures);
    case "html-interactive":
      return isCaptureList(value.captures) && Array.isArray(value.probeResults);
    case "mermaid":
    case "chart":
      return (
        isOutputRef(value.rendererOutput) &&
        (value.captures === undefined || isCaptureList(value.captures))
      );
    case "workflow-snapshot":
      return (
        isRecord(value.sourceSnapshot) &&
        isString(value.sourceSnapshot.runId) &&
        isString(value.sourceSnapshot.snapshotHash)
      );
    default:
      return false;
  }
}

function isOwner(value: unknown): value is ArtifactOwner {
  return (
    isRecord(value) &&
    isString(value.backendId) &&
    isString(value.environmentId) &&
    isString(value.projectId) &&
    isString(value.conversationKey)
  );
}

export function corrupt(what: string): ArtifactFailure {
  return new ArtifactFailure(
    artifactError("storage_corrupt", `Stored ${what} record is unreadable`, {
      suggestion: "The record is retained for recovery; create a new artifact to continue.",
    }),
  );
}

/**
 * Explicit schema-version migrations: `RECORD_MIGRATIONS[n]` upgrades a row
 * of version `n` to version `n + 1` (pure; the stored row is not rewritten by
 * a read). Version 1 is current, so its entry is the identity and the chain
 * ends there. A version with no entry (newer than this backend, or retired)
 * is unreadable rather than guessed at.
 */
export const RECORD_MIGRATIONS: Readonly<
  Record<number, (kind: string, row: Record<string, unknown>) => Record<string, unknown>>
> = Object.freeze({
  1: (_kind: string, row: Record<string, unknown>) => row,
});

/** Runs the migration chain from the row's version up to RECORD_SCHEMA_VERSION. */
export function migrateRecord(
  kind: string,
  row: Record<string, unknown>,
): Record<string, unknown> | null {
  let current = row;
  for (let guard = 0; guard < 16; guard += 1) {
    const version = current.schemaVersion;
    if (typeof version !== "number" || !Number.isSafeInteger(version)) return null;
    const migrate = RECORD_MIGRATIONS[version];
    if (!migrate) return null;
    if (version === RECORD_SCHEMA_VERSION) return migrate(kind, current);
    if (version > RECORD_SCHEMA_VERSION) return null;
    const next = migrate(kind, current);
    if (!isRecord(next) || next.schemaVersion !== version + 1) return null;
    current = next;
  }
  return null;
}

function parse(json: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw corrupt(what);
  }
  if (!isRecord(value)) throw corrupt(what);
  const migrated = migrateRecord(what, value);
  if (!migrated || migrated.schemaVersion !== RECORD_SCHEMA_VERSION) throw corrupt(what);
  return migrated;
}

type Check = (value: Record<string, unknown>) => boolean;

const CHECKS = {
  head: (v) =>
    isString(v.artifactId) &&
    isOwner(v.owner) &&
    (ARTIFACT_KINDS as readonly unknown[]).includes(v.kind) &&
    isPositive(v.currentRevision) &&
    (v.publishedRevision === null || isPositive(v.publishedRevision)) &&
    isCount(v.storageGeneration) &&
    isString(v.updatedAt),
  revision: (v) =>
    isString(v.artifactId) &&
    isPositive(v.revision) &&
    isOwner(v.owner) &&
    isString(v.title) &&
    isString(v.summary) &&
    isPayload(v.payload) &&
    isString(v.sourceHash) &&
    isString(v.assetManifestHash) &&
    isAssetList(v.assets) &&
    isRecord(v.createdBy),
  derived: (v) =>
    isString(v.artifactId) &&
    isPositive(v.revision) &&
    Array.isArray(v.prepared) &&
    (v.printed === undefined || Array.isArray(v.printed)),
  operation: (v) =>
    isString(v.operationId) &&
    isString(v.artifactId) &&
    isPositive(v.revision) &&
    (ARTIFACT_OPERATION_STATUSES as readonly unknown[]).includes(v.status) &&
    (ARTIFACT_KINDS as readonly unknown[]).includes(v.kind) &&
    isOwner(v.owner) &&
    isCount(v.generation) &&
    Array.isArray(v.diagnostics) &&
    isOptionalString(v.receiptId) &&
    (v.diagnosticCaptures === undefined || isCaptureList(v.diagnosticCaptures)),
  receipt: (v) =>
    isString(v.receiptId) &&
    isString(v.operationId) &&
    isString(v.artifactId) &&
    isPositive(v.revision) &&
    (ARTIFACT_KINDS as readonly unknown[]).includes(v.kind) &&
    isString(v.inputHash) &&
    isRecord(v.identity) &&
    isString(v.identity.effectiveSourceHash) &&
    isString(v.identity.rendererBundleHash) &&
    Array.isArray(v.gates) &&
    isEvidence(v.evidence, v.kind) &&
    isOwner(v.owner),
  publication: (v) =>
    isString(v.publicationId) &&
    isString(v.artifactId) &&
    isPositive(v.revision) &&
    isString(v.receiptId) &&
    isOwner(v.owner) &&
    isPositive(v.conversationSequence) &&
    isRecord(v.ref) &&
    v.ref.publicationId === v.publicationId &&
    v.ref.artifactId === v.artifactId &&
    v.ref.revision === v.revision &&
    (v.anchor === undefined || isRecord(v.anchor)),
  idempotency: (v) =>
    isString(v.key) &&
    isString(v.digest) &&
    isString(v.operationKind) &&
    (v.state === "completed" ||
      v.state === "expired" ||
      (v.state === "pending" &&
        isRecord(v.reservation) &&
        isString(v.reservation.holder) &&
        isString(v.reservation.expiresAt))),
  outbox: (v) => isString(v.eventId) && isString(v.publicationId) && isPositive(v.sequence),
  conversation: (v) =>
    isString(v.conversationKey) && isCount(v.sequence) && isOptionalString(v.deletedAt),
  asset: (v) => isSha256(v.sha256) && isCount(v.byteLength) && isString(v.mimeType),
  staged: (v) =>
    isString(v.stagedId) &&
    isOwner(v.owner) &&
    isString(v.name) &&
    isString(v.mimeType) &&
    isSha256(v.sha256) &&
    isCount(v.byteLength) &&
    isString(v.createdAt),
  repair: (v) => isString(v.artifactId) && isCount(v.updates),
  quota: (v) => isCount(v.assetBytes),
} satisfies Record<string, Check>;

export type RecordKind = keyof typeof CHECKS;

export interface RecordTypes {
  head: StoredHead;
  revision: StoredRevision;
  derived: StoredDerived;
  operation: StoredOperation;
  receipt: StoredReceipt;
  publication: StoredPublication;
  idempotency: StoredIdempotency;
  outbox: StoredOutbox;
  conversation: StoredConversation;
  asset: StoredAsset;
  repair: StoredRepair;
  quota: StoredQuota;
  staged: StoredStagedAsset;
}

export function decodeRecord<K extends RecordKind>(kind: K, json: string): RecordTypes[K] {
  const value = parse(json, kind);
  if (!(CHECKS[kind] as Check)(value)) throw corrupt(kind);
  return value as unknown as RecordTypes[K];
}

export function encodeRecord(value: { schemaVersion: 1 }): string {
  return JSON.stringify(value);
}

export type { ArtifactCapture };
