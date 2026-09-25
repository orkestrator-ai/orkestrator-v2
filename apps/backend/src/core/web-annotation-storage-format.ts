/**
 * Persisted formats of web annotation storage, and their conversion to the
 * in-memory manifest the service works on.
 *
 * In memory a manifest holds full request records and the editor draft index.
 * On disk the listing index (`manifest.json`) holds only bounded index data:
 *
 * - request instructions and response excerpts live in per-request
 *   `request-text` records (brief bodies were already in `brief` records,
 *   entry bodies in `entry` records, capture metadata in `capture` records);
 * - the draft index lives in `drafts.json`, so autosaving a draft rewrites
 *   one small file instead of the whole listing index.
 *
 * Version 1 manifests (full requests and drafts inline) still load; the first
 * commit rewrites them as version 2. Newer versions are refused, never
 * overwritten.
 */
import { createHash } from "node:crypto";
import {
  WEB_ANNOTATION_SCHEMA_VERSION,
  type WebAnnotation,
  type WebAnnotationCaptureProducer,
  type WebAnnotationCaptureState,
  type WebAnnotationDestination,
  type WebAnnotationEntryKind,
  type WebAnnotationErrorDetail,
  type WebAnnotationOperationReceipt,
  type WebAnnotationProvenance,
  type WebAnnotationRequest,
  type WebAnnotationRequestOperation,
  type WebAnnotationResponseExcerpt,
  type WebAnnotationResult,
} from "@orkestrator/protocol/web-annotations";

export const WEB_ANNOTATION_MANIFEST_FORMAT = "orkestrator-web-annotations";
export const WEB_ANNOTATION_MANIFEST_VERSION = 2;
export const WEB_ANNOTATION_DRAFTS_FORMAT = "orkestrator-web-annotation-drafts";
export const WEB_ANNOTATION_DRAFTS_VERSION = 1;
/** Draft ids removed by manifest commits, kept to repair a crash before drafts.json. */
export const CONSUMED_DRAFT_IDS = 512;

export type WebAnnotationRecordKind =
  | "capture"
  | "entry"
  | "brief"
  | "result"
  | "draft"
  | "request-text";

export interface ManifestCapture {
  id: string;
  annotationId: string;
  revision: number;
  producer: WebAnnotationCaptureProducer;
  state: WebAnnotationCaptureState;
  assetIds: string[];
  resultOf?: { requestId: string; resultId?: string };
  createdAt: string;
  bytes: number;
}

export interface ManifestEntry {
  id: string;
  annotationId: string;
  sequence: number;
  kind: WebAnnotationEntryKind;
  provenance: WebAnnotationProvenance;
  bytes: number;
  createdAt: string;
  supersedes?: string;
  supersededBy?: string;
}

export interface ManifestResult {
  id: string;
  requestId: string;
  revision: number;
  provenance: WebAnnotationResult["provenance"];
  provisional: boolean;
  assetIds: string[];
  captureIds: string[];
  supersedes: string | null;
  createdAt: string;
  bytes: number;
}

export interface ManifestDraft {
  id: string;
  editorId: string;
  revision: number;
  annotationId: string | null;
  captureId: string | null;
  pendingCaptureId: string | null;
  operation: WebAnnotationRequestOperation | null;
  destination: WebAnnotationDestination | null;
  updatedAt: string;
  bytes: number;
  assetIds?: string[];
}

export interface ManifestAsset {
  id: string;
  digest: string;
  bytes: number;
  width: number;
  height: number;
  createdAt: string;
  orphanedAt: string | null;
}

export interface ManifestReceipt {
  operationId: string;
  kind: string;
  bodyHash: string;
  recordedAt: string;
  receipt?: WebAnnotationOperationReceipt;
  value?: Record<string, string | number | null>;
}

export type ManifestMigrationDraftState = "imported" | "cleaned" | "deferred" | "failed";

/** Content-free record of one legacy screenshot reference. */
export interface ManifestMigrationScreenshot {
  legacyId: string;
  /** SHA-256 of the legacy path; the path itself stays in the private backup. */
  referenceDigest: string;
  assetId: string | null;
  outcome: "imported" | "missing" | "existing";
}

/** Who owned the source draft when it was inventoried. */
export interface ManifestMigrationOwnership {
  logicalSessionKey: string | null;
  /** `unknown` when native sessions could not be read. */
  pendingDispatch: boolean | "unknown";
  /** The pending native dispatch's request id, when it names one. */
  pendingRequestId?: string;
}

export interface ManifestMigration {
  /** Keyed by legacy annotation id; identity is (environmentId, legacyId). */
  imports: Record<
    string,
    { annotationId: string; variants: string[]; captureVariants: string[]; importedAt: string }
  >;
  drafts: Record<
    string,
    {
      state: ManifestMigrationDraftState;
      sourceRevision: number;
      legacyIds: string[];
      reason?: string;
      backup?: string;
      updatedAt: string;
      screenshots?: ManifestMigrationScreenshot[];
      ownership?: ManifestMigrationOwnership;
    }
  >;
  completedAt: string | null;
}

/** The in-memory manifest the service mutates inside a transaction. */
export interface WebAnnotationManifest {
  format: typeof WEB_ANNOTATION_MANIFEST_FORMAT;
  version: typeof WEB_ANNOTATION_MANIFEST_VERSION;
  environmentId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  annotations: Record<string, WebAnnotation>;
  captures: Record<string, ManifestCapture>;
  /** Per annotation, ordered by sequence. */
  entries: Record<string, ManifestEntry[]>;
  requests: Record<string, WebAnnotationRequest>;
  results: Record<string, ManifestResult>;
  /** Keyed by editor id. Persisted separately in `drafts.json`. */
  drafts: Record<string, ManifestDraft>;
  assets: Record<string, ManifestAsset>;
  receipts: ManifestReceipt[];
  migration: ManifestMigration;
  /** Environment revision at which each annotation last changed. */
  changedAt: Record<string, number>;
  /** Bytes of committed records referenced by the listing index (not drafts). */
  usage: { recordBytes: number };
  /** Maintained by storage: drafts removed by a manifest commit. */
  consumedDrafts?: string[];
}

export interface RequestTextRef {
  revision: number;
  bytes: number;
}

export type PersistedRequest = Omit<WebAnnotationRequest, "instruction" | "response"> & {
  /** Null only for a request whose text record was never written (v1 import). */
  text: RequestTextRef | null;
};

export interface PersistedManifest extends Omit<
  WebAnnotationManifest,
  "requests" | "drafts" | "version" | "consumedDrafts"
> {
  version: typeof WEB_ANNOTATION_MANIFEST_VERSION;
  requests: Record<string, PersistedRequest>;
  consumedDrafts: string[];
}

export interface PersistedDrafts {
  format: typeof WEB_ANNOTATION_DRAFTS_FORMAT;
  version: typeof WEB_ANNOTATION_DRAFTS_VERSION;
  environmentId: string;
  sequence: number;
  drafts: Record<string, ManifestDraft>;
  /** Bytes of the committed draft text records. */
  recordBytes: number;
}

export interface RequestTextValue {
  instruction: string;
  response: WebAnnotationResponseExcerpt | null;
}

export type StorageErrorCode =
  | "manifest-invalid-json"
  | "manifest-invalid"
  | "manifest-too-large"
  | "manifest-foreign"
  | "manifest-unreadable"
  | "manifest-missing"
  | "unsupported-version"
  | "drafts-invalid"
  | "record-invalid"
  | "record-too-large"
  | "record-unreadable";

export class WebAnnotationStorageError extends Error {
  readonly code: StorageErrorCode | undefined;
  readonly detail: WebAnnotationErrorDetail | undefined;
  constructor(message: string, code?: StorageErrorCode, detail?: WebAnnotationErrorDetail) {
    super(message);
    this.name = "WebAnnotationStorageError";
    this.code = code;
    this.detail = detail;
  }
}

export function emptyManifest(environmentId: string, now: string): WebAnnotationManifest {
  return {
    format: WEB_ANNOTATION_MANIFEST_FORMAT,
    version: WEB_ANNOTATION_MANIFEST_VERSION,
    environmentId,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    annotations: {},
    captures: {},
    entries: {},
    requests: {},
    results: {},
    drafts: {},
    assets: {},
    receipts: [],
    migration: { imports: {}, drafts: {}, completedAt: null },
    changedAt: {},
    usage: { recordBytes: 0 },
    consumedDrafts: [],
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(what: string): WebAnnotationStorageError {
  return new WebAnnotationStorageError(`manifest ${what} is invalid`, "manifest-invalid");
}

export function unsupportedVersion(
  format: NonNullable<WebAnnotationErrorDetail["format"]>,
): WebAnnotationStorageError {
  return new WebAnnotationStorageError(
    `${format} was written by a newer version of Orkestrator; upgrade to read it`,
    "unsupported-version",
    { code: "unsupported-version", format },
  );
}

export interface ParsedManifest {
  /** In-memory manifest; v2 requests still need their text hydrated. */
  manifest: WebAnnotationManifest;
  /** Text references of v2 requests (empty for v1). */
  textRefs: Map<string, RequestTextRef | null>;
  sourceVersion: 1 | 2;
}

/**
 * Structural check only; individual records are validated when read. Unknown
 * newer versions throw `unsupported-version` so callers refuse the store
 * instead of falling back to an older copy and overwriting newer data.
 */
export function parseManifest(value: unknown, environmentId: string): ParsedManifest {
  if (!isRecord(value) || value.format !== WEB_ANNOTATION_MANIFEST_FORMAT) {
    throw new WebAnnotationStorageError("manifest format is invalid", "manifest-invalid");
  }
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version)) {
    throw invalid("version");
  }
  if (value.version > WEB_ANNOTATION_MANIFEST_VERSION) throw unsupportedVersion("manifest");
  if (value.version !== 1 && value.version !== 2) throw invalid("version");
  if (value.environmentId !== environmentId) {
    throw new WebAnnotationStorageError(
      "manifest belongs to another environment",
      "manifest-foreign",
    );
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw invalid("revision");
  }
  const keys = ["annotations", "captures", "entries", "requests", "results", "assets", "changedAt"];
  if (value.version === 1) keys.push("drafts");
  for (const key of keys) {
    if (!isRecord(value[key])) throw invalid(key);
  }
  if (!Array.isArray(value.receipts)) throw invalid("receipts");
  const migration = value.migration;
  if (!isRecord(migration) || !isRecord(migration.imports) || !isRecord(migration.drafts)) {
    throw invalid("migration state");
  }
  if (!isRecord(value.usage) || typeof value.usage.recordBytes !== "number") {
    throw invalid("usage");
  }
  for (const annotation of Object.values(value.annotations as Record<string, unknown>)) {
    if (!isRecord(annotation) || annotation.environmentId !== environmentId) {
      throw invalid("annotation");
    }
    if (
      typeof annotation.schemaVersion === "number" &&
      annotation.schemaVersion > WEB_ANNOTATION_SCHEMA_VERSION
    ) {
      throw unsupportedVersion("annotation");
    }
    if (annotation.schemaVersion !== WEB_ANNOTATION_SCHEMA_VERSION) throw invalid("annotation");
  }
  const textRefs = new Map<string, RequestTextRef | null>();
  const requests: Record<string, WebAnnotationRequest> = {};
  for (const [id, request] of Object.entries(value.requests as Record<string, unknown>)) {
    if (!isRecord(request) || request.environmentId !== environmentId || request.id !== id) {
      throw invalid("request");
    }
    if (value.version === 1) {
      requests[id] = request as unknown as WebAnnotationRequest;
      continue;
    }
    const text = request.text;
    if (
      text !== null &&
      (!isRecord(text) || !Number.isSafeInteger(text.revision) || (text.revision as number) < 1)
    ) {
      throw invalid("request text reference");
    }
    textRefs.set(
      id,
      text === null ? null : { revision: text.revision as number, bytes: Number(text.bytes) || 0 },
    );
    const { text: _text, ...rest } = request;
    // Hydrated from the text record after parsing; empty until then.
    requests[id] = {
      ...(rest as unknown as WebAnnotationRequest),
      instruction: "",
      response: null,
    };
  }
  const consumed = Array.isArray(value.consumedDrafts)
    ? (value.consumedDrafts as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  const manifest = {
    ...(value as unknown as WebAnnotationManifest),
    version: WEB_ANNOTATION_MANIFEST_VERSION,
    requests,
    drafts: value.version === 1 ? (value.drafts as Record<string, ManifestDraft>) : {},
    consumedDrafts: consumed.slice(-CONSUMED_DRAFT_IDS),
  } as WebAnnotationManifest;
  return { manifest, textRefs, sourceVersion: value.version };
}

export function parseDrafts(value: unknown, environmentId: string): PersistedDrafts {
  if (!isRecord(value) || value.format !== WEB_ANNOTATION_DRAFTS_FORMAT) {
    throw new WebAnnotationStorageError("drafts format is invalid", "drafts-invalid");
  }
  if (typeof value.version !== "number") {
    throw new WebAnnotationStorageError("drafts version is invalid", "drafts-invalid");
  }
  if (value.version > WEB_ANNOTATION_DRAFTS_VERSION) throw unsupportedVersion("drafts");
  if (
    value.environmentId !== environmentId ||
    !Number.isSafeInteger(value.sequence) ||
    !isRecord(value.drafts) ||
    typeof value.recordBytes !== "number"
  ) {
    throw new WebAnnotationStorageError("drafts index is invalid", "drafts-invalid");
  }
  for (const [editorId, draft] of Object.entries(value.drafts)) {
    if (
      !isRecord(draft) ||
      draft.editorId !== editorId ||
      typeof draft.id !== "string" ||
      !Number.isSafeInteger(draft.revision)
    ) {
      throw new WebAnnotationStorageError("drafts entry is invalid", "drafts-invalid");
    }
  }
  return value as unknown as PersistedDrafts;
}

/** Listing-index form of an in-memory manifest (no prompts, no drafts). */
export function persistManifest(
  manifest: WebAnnotationManifest,
  textRefs: ReadonlyMap<string, RequestTextRef | null>,
): PersistedManifest {
  const requests: Record<string, PersistedRequest> = {};
  for (const [id, request] of Object.entries(manifest.requests)) {
    const { instruction: _instruction, response: _response, ...rest } = request;
    requests[id] = { ...rest, text: textRefs.get(id) ?? null };
  }
  const { drafts: _drafts, consumedDrafts, ...rest } = manifest;
  return { ...rest, requests, consumedDrafts: consumedDrafts ?? [] };
}

/** Opaque, filesystem-safe directory name for a record id. */
export function recordDirectoryName(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 40);
}

/** Record id of a request's instruction/response text. */
export function requestTextRecordId(requestId: string): string {
  return `request-text:${requestId}`;
}

export function sameRequestText(
  a: RequestTextValue,
  b: { instruction: string; response: WebAnnotationResponseExcerpt | null },
): boolean {
  if (a.instruction !== b.instruction) return false;
  const left = a.response;
  const right = b.response;
  if (left === null || right === null) return left === right;
  return (
    left.text === right.text &&
    left.capturedAt === right.capturedAt &&
    left.messageId === right.messageId &&
    left.truncated === right.truncated &&
    left.provenance === right.provenance
  );
}
