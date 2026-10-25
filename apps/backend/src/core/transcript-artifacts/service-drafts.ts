/**
 * Draft inspection for the renderer: a conversation's artifacts as their
 * author left them, published or not, so a person can read and copy draft
 * source and failed-preview evidence even when nothing was published.
 *
 * Scoped exactly like publication reads: the record's owner must be this
 * backend, the named environment and the named logical session; anything
 * else, and anything missing, is the same `not_found`. Source is served by
 * exact revision with its content hash re-checked, through the same UTF-8
 * slicing as `get_artifact`; a diagnostic capture is served from the failed
 * operation that recorded it, its bytes re-hashed on read.
 */
import type {
  ArtifactConversationScope,
  ArtifactDraftListResponse,
  ArtifactDraftReadRequest,
  ArtifactDraftSummary,
  ArtifactRepresentationResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  ArtifactFailure,
  artifactError,
  safeArtifactFilename,
  type ArtifactOwner,
} from "@orkestrator/protocol/transcript-artifacts";
import { artifactSourceHash, sha256Hex } from "./hashing.js";
import { notFound } from "./owner.js";
import { boundError, type ArtifactServiceContext } from "./service-context.js";
import { sliceUtf8, sourceText } from "./service-read.js";
import { storageCorrupt, type EnvironmentRecords } from "./store.js";
import type { StoredOperation } from "./store-records.js";

export const MAX_LISTED_DRAFTS = 100;
/** Diagnostics per listed draft; the full set is on the operation. */
const LISTED_DIAGNOSTICS = 10;
const MAX_SOURCE_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_SOURCE_READ_BYTES = 1024 * 1024;

export class ArtifactDraftReads {
  constructor(private readonly ctx: ArtifactServiceContext) {}

  private owns(scope: ArtifactConversationScope, record: { owner: ArtifactOwner }): boolean {
    return (
      record.owner.backendId === this.ctx.backendId() &&
      record.owner.environmentId === scope.environmentId &&
      record.owner.conversationKey === scope.logicalSessionKey
    );
  }

  private records(scope: ArtifactConversationScope): EnvironmentRecords {
    if (typeof scope.environmentId !== "string" || typeof scope.logicalSessionKey !== "string")
      throw notFound();
    return this.ctx.store.records(scope.environmentId);
  }

  /** Newest first, at most 100; an unknown conversation lists nothing. */
  listDrafts(
    scope: ArtifactConversationScope,
    options: { limit?: unknown } = {},
  ): ArtifactDraftListResponse {
    const limit =
      typeof options.limit === "number" && Number.isSafeInteger(options.limit)
        ? Math.max(1, Math.min(MAX_LISTED_DRAFTS, options.limit))
        : MAX_LISTED_DRAFTS;
    let records: EnvironmentRecords;
    try {
      records = this.records(scope);
    } catch {
      return { drafts: [] };
    }
    const heads = records
      .list("head", { owner: scope.logicalSessionKey })
      .filter((head) => this.owns(scope, head))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
    if (heads.length === 0) return { drafts: [] };
    const latest = new Map<string, StoredOperation>();
    for (const operation of records.list("operation", { owner: scope.logicalSessionKey })) {
      if (!this.owns(scope, operation)) continue;
      const key = `${operation.artifactId}/${operation.revision}`;
      const known = latest.get(key);
      if (!known || operation.createdAt > known.createdAt) latest.set(key, operation);
    }
    const drafts: ArtifactDraftSummary[] = [];
    for (const head of heads) {
      let summary = "";
      let title = head.title;
      try {
        const revision = records.get("revision", `${head.artifactId}/${head.currentRevision}`);
        if (revision) {
          title = revision.title;
          summary = revision.summary;
        }
      } catch {
        // A damaged revision still lists by its head; reading it reports storage_corrupt.
      }
      const operation = latest.get(`${head.artifactId}/${head.currentRevision}`);
      drafts.push({
        artifactId: head.artifactId,
        kind: head.kind,
        title,
        summary,
        currentRevision: head.currentRevision,
        publishedRevision: head.publishedRevision,
        updatedAt: head.updatedAt,
        latestOperation: operation
          ? {
              operationId: operation.operationId,
              revision: operation.revision,
              status: operation.status,
              ...(operation.error ? { error: boundError(operation.error) } : {}),
              diagnostics: operation.diagnostics.slice(0, LISTED_DIAGNOSTICS),
              omittedDiagnostics:
                operation.omittedDiagnostics +
                Math.max(0, operation.diagnostics.length - LISTED_DIAGNOSTICS),
              diagnosticCaptureCount: operation.diagnosticCaptures?.length ?? 0,
              semantics: operation.semantics,
            }
          : null,
      });
    }
    return { drafts };
  }

  async readDraft(request: ArtifactDraftReadRequest): Promise<ArtifactRepresentationResponse> {
    const records = this.records(request);
    if (typeof request.artifactId !== "string") throw notFound();
    const head = records.get("head", request.artifactId);
    if (!head || !this.owns(request, head)) throw notFound();
    const revisionNumber = request.revision ?? head.currentRevision;
    if (
      !Number.isSafeInteger(revisionNumber) ||
      revisionNumber < 1 ||
      revisionNumber > head.currentRevision
    ) {
      throw notFound("Artifact revision");
    }
    if (request.representation === "diagnostic-capture") {
      return this.diagnosticCapture(records, request, revisionNumber);
    }
    if (request.representation !== "source") {
      throw new ArtifactFailure(artifactError("invalid_input", "Unknown draft representation"));
    }
    const revision = records.get("revision", `${head.artifactId}/${revisionNumber}`);
    if (!revision || !this.owns(request, revision)) throw notFound("Artifact revision");
    const payload = revision.payload;
    if (artifactSourceHash(payload.kind, payload) !== revision.sourceHash) throw storageCorrupt();
    const html = payload.kind === "html-static" || payload.kind === "html-interactive";
    const bytes = new TextEncoder().encode(sourceText(payload));
    const limit = Math.min(
      MAX_SOURCE_READ_BYTES,
      Math.max(1, request.sourceRange?.limitBytes ?? DEFAULT_SOURCE_READ_BYTES),
    );
    const slice = sliceUtf8(bytes, request.sourceRange?.offsetBytes ?? 0, limit);
    return {
      artifactId: revision.artifactId,
      revision: revision.revision,
      representation: "source",
      mimeType: html
        ? "text/html; charset=utf-8"
        : payload.kind === "mermaid"
          ? "text/plain; charset=utf-8"
          : "application/json",
      filename: safeArtifactFilename(
        revision.title,
        html ? "html" : payload.kind === "mermaid" ? "mmd" : "json",
      ),
      encoding: "utf8",
      data: slice.text,
      sha256: sha256Hex(bytes),
      byteLength: slice.byteLength,
      totalBytes: slice.totalBytes,
      nextOffsetBytes: slice.nextOffsetBytes,
      executableOutsideOrkestrator: html,
    };
  }

  private async diagnosticCapture(
    records: EnvironmentRecords,
    request: ArtifactDraftReadRequest,
    revisionNumber: number,
  ): Promise<ArtifactRepresentationResponse> {
    if (typeof request.operationId !== "string") throw notFound("Operation");
    const operation = records.get("operation", request.operationId);
    if (
      !operation ||
      !this.owns(request, operation) ||
      operation.artifactId !== request.artifactId ||
      (request.revision !== undefined && operation.revision !== revisionNumber)
    ) {
      throw notFound("Operation");
    }
    const index = request.captureIndex ?? 0;
    const capture =
      Number.isSafeInteger(index) && index >= 0 ? operation.diagnosticCaptures?.[index] : undefined;
    if (!capture) {
      throw new ArtifactFailure(
        artifactError("invalid_input", "This operation has no diagnostic capture at that index"),
      );
    }
    const revision = records.get("revision", `${operation.artifactId}/${operation.revision}`);
    const bytes = await this.ctx.store.readAsset(
      operation.owner.environmentId,
      capture.sha256,
      capture.byteLength,
    );
    return {
      artifactId: operation.artifactId,
      revision: operation.revision,
      representation: "capture",
      mimeType: "image/png",
      filename: safeArtifactFilename(`${revision?.title ?? "artifact"} diagnostic`, "png"),
      encoding: "base64",
      data: bytes.toString("base64"),
      sha256: capture.sha256,
      byteLength: bytes.byteLength,
      totalBytes: bytes.byteLength,
      nextOffsetBytes: null,
      executableOutsideOrkestrator: false,
    };
  }
}
