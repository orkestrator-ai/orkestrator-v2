/**
 * Shared context and helpers for the transcript-artifact service
 * collaborators (authoring, preview, publication, reads). Each collaborator
 * is a small class taking this context; none extends another.
 */
import { randomBytes } from "node:crypto";
import {
  ARTIFACT_TOOL_POLICY,
  DIAGNOSTIC_POLICY,
  utf8ByteLength,
} from "@orkestrator/protocol/rich-content-policy";
import {
  ArtifactFailure,
  artifactError,
  type ArtifactDiagnostic,
  type ArtifactError,
  type ArtifactOwner,
} from "@orkestrator/protocol/transcript-artifacts";
import type { ArtifactContentServer, InteractivePreparer, PreviewRunner } from "./contracts.js";
import type { ArtifactGrantService } from "./grants.js";
import { idempotencyKey, requestDigest } from "./hashing.js";
import type { ArtifactMetrics } from "./metrics.js";
import type { ArtifactIdentityOverrides } from "./service-identity.js";
import type { EnvironmentRecords, TranscriptArtifactStore } from "./store.js";
import type { StoredIdempotency } from "./store-records.js";
import type { WorkflowSnapshotCollector } from "./workflow-collector.js";

export const ARTIFACT_RESPONSE_SCHEMA_VERSION = 1;

/** A tool/command response: compact versioned JSON plus an optional image block. */
export interface ArtifactResponse {
  value: Record<string, unknown>;
  isError: boolean;
  image?: { data: string; mimeType: "image/png" };
}

export interface ArtifactRolloutFlags {
  richMarkdown: boolean;
  artifactPublication: boolean;
  liveInteractive: boolean;
}

/** Resolves an already authorized attachment/upload reference to bytes. */
export type ArtifactAssetResolver = (
  owner: ArtifactOwner,
  assetRef: string,
) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

export interface ArtifactRuntimeParts {
  runner?: PreviewRunner;
  preparer?: InteractivePreparer;
  contentServer?: ArtifactContentServer;
}

export interface ArtifactServiceContext {
  store: TranscriptArtifactStore;
  grants: ArtifactGrantService;
  collector: WorkflowSnapshotCollector;
  metrics: ArtifactMetrics;
  runtime: ArtifactRuntimeParts;
  /** Random per-process lease holder for operations admitted here. */
  holder: string;
  leaseMs: number;
  now(): number;
  iso(): string;
  backendId(): string;
  rollout(): ArtifactRolloutFlags;
  overrides: ArtifactIdentityOverrides;
  assetResolver?: ArtifactAssetResolver;
  /** Ledger hint after a committed publication. */
  notifyPublication(
    environmentId: string,
    conversationKey: string,
    publicationId: string,
    sequence: number,
  ): void;
  /**
   * Content-free change hint for a conversation's drafts, operations or
   * ledger, sent only after the change committed. Never throws.
   */
  announceConversation(environmentId: string, conversationKey: string): void;
}

/**
 * The explicit conversation-deletion fence, checked inside every write
 * transaction that adds records for a conversation: a deleted conversation is
 * `not_found`, exactly like a deleted environment, so late work cannot
 * recreate it.
 */
export function assertConversationLive(records: EnvironmentRecords, conversationKey: string): void {
  if (records.get("conversation", conversationKey)?.deletedAt) {
    throw new ArtifactFailure(artifactError("not_found", "Artifact not found"));
  }
}

export function newId(prefix: "art" | "pub" | "op" | "rcpt"): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

export function assetIdFor(sha256: string): string {
  return `asset_${sha256}`;
}

export function toArtifactError(error: unknown): ArtifactError {
  if (error instanceof ArtifactFailure) return error.error;
  return artifactError("storage_unavailable", "The artifact store is temporarily unavailable");
}

export function okResponse(fields: Record<string, unknown>): ArtifactResponse {
  return {
    value: { schemaVersion: ARTIFACT_RESPONSE_SCHEMA_VERSION, ok: true, ...fields },
    isError: false,
  };
}

export function errorResponse(error: ArtifactError): ArtifactResponse {
  return {
    value: { schemaVersion: ARTIFACT_RESPONSE_SCHEMA_VERSION, ok: false, error: boundError(error) },
    isError: true,
  };
}

/** Errors stay within the tool diagnostic budget: ≤ 20 field errors, ≤ 8 KiB. */
export function boundError(error: ArtifactError): ArtifactError {
  const fieldErrors = error.fieldErrors
    ?.slice(0, DIAGNOSTIC_POLICY.maxToolFieldErrors)
    .map((entry) => ({
      path: entry.path.slice(0, 200),
      code: entry.code.slice(0, 64),
      message: entry.message.slice(0, 300),
    }));
  const bounded: ArtifactError = {
    ...error,
    message: error.message.slice(0, 500),
    ...(fieldErrors ? { fieldErrors } : {}),
  };
  while (
    bounded.fieldErrors &&
    bounded.fieldErrors.length > 0 &&
    utf8ByteLength(JSON.stringify(bounded)) > DIAGNOSTIC_POLICY.maxToolDiagnosticBytes
  ) {
    bounded.fieldErrors = bounded.fieldErrors.slice(0, -1);
  }
  return bounded;
}

/** Persisted diagnostics: ≤ 50 entries, ≤ 2 KiB each, ≤ 32 KiB total. */
export function boundPersistedDiagnostics(
  diagnostics: readonly ArtifactDiagnostic[],
  omitted = 0,
): { diagnostics: ArtifactDiagnostic[]; omitted: number } {
  const kept: ArtifactDiagnostic[] = [];
  let bytes = 0;
  let dropped = omitted;
  for (const entry of diagnostics) {
    const bounded: ArtifactDiagnostic = {
      severity: entry.severity,
      code: String(entry.code).slice(0, 64),
      message: String(entry.message).slice(0, 1_500),
      ...(entry.location ? { location: String(entry.location).slice(0, 200) } : {}),
    };
    const size = utf8ByteLength(JSON.stringify(bounded));
    if (
      kept.length >= DIAGNOSTIC_POLICY.maxPersistedEntries ||
      size > DIAGNOSTIC_POLICY.maxEntryBytes ||
      bytes + size > DIAGNOSTIC_POLICY.maxPersistedBytes
    ) {
      dropped += 1;
      continue;
    }
    kept.push(bounded);
    bytes += size;
  }
  return { diagnostics: kept, omitted: dropped };
}

/** Tool-safe subset: errors first, ≤ 20 entries and ≤ 8 KiB. */
export function toolDiagnostics(
  diagnostics: readonly ArtifactDiagnostic[],
  omitted: number,
): { diagnostics: ArtifactDiagnostic[]; omitted: number } {
  const ordered = [...diagnostics].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );
  const kept: ArtifactDiagnostic[] = [];
  let bytes = 0;
  for (const entry of ordered) {
    const size = utf8ByteLength(JSON.stringify(entry));
    if (
      kept.length >= DIAGNOSTIC_POLICY.maxToolFieldErrors ||
      bytes + size > DIAGNOSTIC_POLICY.maxToolDiagnosticBytes
    )
      break;
    kept.push(entry);
    bytes += size;
  }
  return { diagnostics: kept, omitted: omitted + (diagnostics.length - kept.length) };
}

function severityRank(severity: ArtifactDiagnostic["severity"]): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Idempotency

const REQUEST_KEY = /^[^\u0000-\u001f\u007f]{1,128}$/;
/** Explicit UTF-8 bound on a request key (128 UTF-16 units encode to at most 384 bytes). */
export const MAX_REQUEST_KEY_BYTES = ARTIFACT_TOOL_POLICY.maxRequestKeyCharacters * 3;

export interface RequestIdentity {
  key: string;
  digest: string;
  operationKind: string;
  conversationKey: string;
}

export function requestIdentity(
  owner: ArtifactOwner,
  operationKind: string,
  requestKey: unknown,
  semanticArgs: unknown,
): RequestIdentity {
  if (
    typeof requestKey !== "string" ||
    !REQUEST_KEY.test(requestKey) ||
    utf8ByteLength(requestKey) > MAX_REQUEST_KEY_BYTES
  ) {
    throw new ArtifactFailure(
      artifactError("invalid_input", "requestKey must be 1–128 printable characters", {
        fieldErrors: [
          { path: "requestKey", code: "invalid", message: "Expected 1–128 printable characters" },
        ],
      }),
    );
  }
  return {
    key: idempotencyKey(owner.conversationKey, operationKind, requestKey),
    digest: requestDigest(operationKind, semanticArgs),
    operationKind,
    conversationKey: owner.conversationKey,
  };
}

/**
 * Looks up a prior outcome for this request key. Same digest → the stored
 * row; different digest → `idempotency_conflict`; an expired tombstone →
 * `expired`. Never treats an old key as a new operation.
 */
export function priorRequest(
  records: EnvironmentRecords,
  request: RequestIdentity,
): StoredIdempotency | null {
  const existing = records.get("idempotency", request.key);
  if (!existing) return null;
  if (existing.digest !== request.digest || existing.operationKind !== request.operationKind) {
    throw new ArtifactFailure(
      artifactError(
        "idempotency_conflict",
        "This requestKey was already used with different arguments",
        {
          suggestion:
            "Use a new requestKey for a different request; reuse a key only to retry the same call.",
        },
      ),
    );
  }
  if (existing.state === "expired") {
    throw new ArtifactFailure(
      artifactError("expired", "The result of this request has expired with its unpublished draft"),
    );
  }
  // A reservation is not a result: the request is still being prepared.
  if (existing.state === "pending") return null;
  return existing;
}

/** How long an admitted create/update may hold its request-key reservation. */
export const REQUEST_RESERVATION_MS = 2 * 60_000;

function inProgress(): ArtifactFailure {
  return new ArtifactFailure(
    artifactError("capacity_exceeded", "A request with this requestKey is still in progress", {
      resource: "request-in-progress",
      retryClass: "transient",
      suggestion: "Retry with the same requestKey shortly; it returns the original result.",
    }),
  );
}

/**
 * Spec mutation step 1, inside the caller's short write transaction: reserve
 * the request key before any expensive work. Returns the completed row to
 * replay, or null once the key is reserved for `holder`. A live reservation
 * held by another process answers a transient `capacity_exceeded`
 * (`request-in-progress`); a lapsed one is taken over. The same key with
 * different arguments is `idempotency_conflict`, as for completed rows.
 */
export function reserveRequest(
  records: EnvironmentRecords,
  request: RequestIdentity,
  holder: string,
  nowMs: number,
): StoredIdempotency | null {
  const existing = records.get("idempotency", request.key);
  if (existing) {
    const prior = priorRequest(records, request);
    if (prior) return prior;
    const reservation = existing.reservation;
    if (reservation && reservation.holder !== holder && Date.parse(reservation.expiresAt) > nowMs) {
      throw inProgress();
    }
  } else if (
    records.count("idempotency", { owner: request.conversationKey }) >=
    MAX_IDEMPOTENCY_RECORDS_PER_CONVERSATION
  ) {
    throw tooManyRequests();
  }
  const row: StoredIdempotency = {
    schemaVersion: 1,
    key: request.key,
    conversationKey: request.conversationKey,
    operationKind: request.operationKind,
    digest: request.digest,
    state: "pending",
    reservation: { holder, expiresAt: new Date(nowMs + REQUEST_RESERVATION_MS).toISOString() },
    createdAt: new Date(nowMs).toISOString(),
  };
  records.put("idempotency", request.key, row, request.conversationKey);
  return null;
}

/** Drops this holder's reservation (after a failure that is not recorded). */
export function releaseRequest(
  records: EnvironmentRecords,
  request: RequestIdentity,
  holder: string,
): void {
  const existing = records.get("idempotency", request.key);
  if (existing?.state === "pending" && existing.reservation?.holder === holder) {
    records.delete("idempotency", request.key);
  }
}

function tooManyRequests(): ArtifactFailure {
  return new ArtifactFailure(
    artifactError("capacity_exceeded", "This conversation has too many artifact requests", {
      resource: "request-records",
      retryClass: "never",
    }),
  );
}

/** Per-conversation bound on idempotency rows; admission is refused beyond it. */
export const MAX_IDEMPOTENCY_RECORDS_PER_CONVERSATION = 10_000;

export function recordRequest(
  records: EnvironmentRecords,
  request: RequestIdentity,
  response: ArtifactResponse,
  now: string,
  artifactId?: string,
): void {
  // Failed requests are writes too: never restore a record after deletion.
  assertConversationLive(records, request.conversationKey);
  // A reserved key already holds its row; only a new key adds one.
  if (
    !records.get("idempotency", request.key) &&
    records.count("idempotency", { owner: request.conversationKey }) >=
      MAX_IDEMPOTENCY_RECORDS_PER_CONVERSATION
  ) {
    throw tooManyRequests();
  }
  const row: StoredIdempotency = {
    schemaVersion: 1,
    key: request.key,
    conversationKey: request.conversationKey,
    operationKind: request.operationKind,
    digest: request.digest,
    state: "completed",
    ...(artifactId ? { artifactId } : {}),
    response: response.value,
    isError: response.isError,
    createdAt: now,
  };
  records.put("idempotency", request.key, row, request.conversationKey);
}

export function replayed(row: StoredIdempotency): ArtifactResponse {
  return { value: { ...row.response, replayed: true }, isError: row.isError === true };
}

/** Errors worth recording under the request key so a retry sees the same answer. */
export function isRecordableError(error: ArtifactError): boolean {
  if (error.retryClass === "transient") return false;
  return ![
    "idempotency_conflict",
    "expired",
    "storage_unavailable",
    "storage_corrupt",
    "renderer_unavailable",
    "capacity_exceeded",
  ].includes(error.code);
}
