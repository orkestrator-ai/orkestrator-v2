/**
 * Agent-facing reads: get_artifact and get_artifact_operation.
 *
 * Both are read-only and scoped: a record outside the caller's owner is the
 * same `not_found` as a missing one. Results stay below 16 KiB; source comes
 * back as a bounded UTF-8 slice whose offsets fall on code-point boundaries.
 * An operation read may add one image content block (a receipt capture or a
 * failed preview's diagnostic capture); JSON never carries base64, visual
 * inspection is always reported as `not-assessed`, and delivery as
 * `attached-if-supported` (the adapter or model may drop image blocks).
 */
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import {
  ARTIFACT_TOOL_POLICY,
  PREVIEW_CAPTURE_POLICY,
  utf8ByteLength,
} from "@orkestrator/protocol/rich-content-policy";
import {
  ArtifactFailure,
  artifactError,
  type ArtifactCapture,
  type ArtifactPayload,
} from "@orkestrator/protocol/transcript-artifacts";
import { notFound, ownsRecord, type ResolvedArtifactCaller } from "./owner.js";
import {
  boundError,
  errorResponse,
  okResponse,
  toArtifactError,
  toolDiagnostics,
  type ArtifactResponse,
  type ArtifactServiceContext,
} from "./service-context.js";
import type { StoredOperation } from "./store-records.js";

/** The exact source text a revision represents (structured payloads as canonical JSON). */
export function sourceText(payload: ArtifactPayload): string {
  switch (payload.kind) {
    case "html-static":
    case "html-interactive":
      return payload.html;
    case "mermaid":
      return payload.source;
    case "chart":
      return canonicalJson(payload.spec);
    case "workflow-snapshot":
      return canonicalJson(payload.snapshot);
  }
}

export interface ByteSlice {
  offsetBytes: number;
  text: string;
  /** Bytes in `text`. */
  byteLength: number;
  nextOffsetBytes: number | null;
  totalBytes: number;
  omittedBytes: number;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * Slice UTF-8 bytes on code-point boundaries. A mid-sequence offset is
 * rejected; the end moves back to the last complete code point within the
 * limit (and further if `maxEscapedBytes` would be exceeded once JSON-escaped).
 */
export function sliceUtf8(
  bytes: Uint8Array,
  offsetBytes: number,
  limitBytes: number,
  maxEscapedBytes = Number.POSITIVE_INFINITY,
): ByteSlice {
  const total = bytes.byteLength;
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || offsetBytes > total) {
    throw new ArtifactFailure(
      artifactError("invalid_input", "offsetBytes is outside the source", {
        fieldErrors: [
          { path: "sourceRange.offsetBytes", code: "out_of_range", message: `Expected 0–${total}` },
        ],
      }),
    );
  }
  if (offsetBytes < total && isContinuation(bytes[offsetBytes])) {
    throw new ArtifactFailure(
      artifactError("invalid_input", "offsetBytes is not on a UTF-8 code point boundary", {
        fieldErrors: [
          {
            path: "sourceRange.offsetBytes",
            code: "not_boundary",
            message: "Use a previous nextOffsetBytes value",
          },
        ],
      }),
    );
  }
  let end = Math.min(total, offsetBytes + Math.max(0, limitBytes));
  while (end > offsetBytes && end < total && isContinuation(bytes[end])) end -= 1;
  const decoder = new TextDecoder("utf-8");
  let text = decoder.decode(bytes.subarray(offsetBytes, end));
  while (end > offsetBytes && utf8ByteLength(JSON.stringify(text)) > maxEscapedBytes) {
    end = offsetBytes + Math.floor((end - offsetBytes) * 0.75);
    while (end > offsetBytes && end < total && isContinuation(bytes[end])) end -= 1;
    text = decoder.decode(bytes.subarray(offsetBytes, end));
  }
  return {
    offsetBytes,
    text,
    byteLength: end - offsetBytes,
    nextOffsetBytes: end < total ? end : null,
    totalBytes: total,
    omittedBytes: total - (end - offsetBytes),
  };
}

export class ArtifactReads {
  constructor(private readonly ctx: ArtifactServiceContext) {}

  getArtifact(
    caller: ResolvedArtifactCaller,
    args: { artifactId: unknown; revision?: unknown; sourceRange?: unknown },
  ): ArtifactResponse {
    try {
      if (typeof args.artifactId !== "string") throw notFound();
      const records = this.ctx.store.records(caller.owner.environmentId);
      const head = records.get("head", args.artifactId);
      if (!head || !ownsRecord(caller.owner, head)) throw notFound();
      const revisionNumber = args.revision === undefined ? head.currentRevision : args.revision;
      if (
        typeof revisionNumber !== "number" ||
        !Number.isSafeInteger(revisionNumber) ||
        revisionNumber < 1
      ) {
        throw new ArtifactFailure(
          artifactError("invalid_input", "revision must be a positive integer", {
            fieldErrors: [
              { path: "revision", code: "type", message: "Expected a positive integer" },
            ],
          }),
        );
      }
      const revision = records.get("revision", `${head.artifactId}/${revisionNumber}`);
      if (!revision) throw notFound("Artifact revision");
      const sourceBytes = new TextEncoder().encode(sourceText(revision.payload));
      const publications = records
        .list("publication", { owner: caller.owner.conversationKey })
        .filter((publication) => publication.artifactId === head.artifactId)
        .sort((a, b) => a.conversationSequence - b.conversationSequence)
        .slice(-20)
        .map((publication) => ({
          publicationId: publication.publicationId,
          revision: publication.revision,
          conversationSequence: publication.conversationSequence,
        }));
      let source: Record<string, unknown> | undefined;
      if (args.sourceRange !== undefined) {
        const range = args.sourceRange as { offsetBytes?: unknown; limitBytes?: unknown } | null;
        const offset = range?.offsetBytes ?? 0;
        const limit = range?.limitBytes ?? ARTIFACT_TOOL_POLICY.maxSourceSliceBytes;
        if (
          typeof offset !== "number" ||
          typeof limit !== "number" ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > ARTIFACT_TOOL_POLICY.maxSourceSliceBytes
        ) {
          throw new ArtifactFailure(
            artifactError(
              "invalid_input",
              `sourceRange.limitBytes must be 1–${ARTIFACT_TOOL_POLICY.maxSourceSliceBytes}`,
              {
                fieldErrors: [
                  { path: "sourceRange", code: "out_of_range", message: "Invalid source range" },
                ],
              },
            ),
          );
        }
        const slice = sliceUtf8(
          sourceBytes,
          offset,
          limit,
          ARTIFACT_TOOL_POLICY.maxSourceSliceBytes + 2_048,
        );
        source = {
          encoding: "utf-8",
          offsetBytes: slice.offsetBytes,
          text: slice.text,
          nextOffsetBytes: slice.nextOffsetBytes,
          totalBytes: slice.totalBytes,
          omittedBytes: slice.omittedBytes,
        };
      }
      return okResponse({
        artifact: {
          artifactId: head.artifactId,
          kind: head.kind,
          currentRevision: head.currentRevision,
          publishedRevision: head.publishedRevision,
          createdAt: head.createdAt,
          updatedAt: head.updatedAt,
        },
        revision: {
          revision: revision.revision,
          title: revision.title,
          summary: revision.summary,
          sourceHash: revision.sourceHash,
          assetManifestHash: revision.assetManifestHash,
          sourceBytes: sourceBytes.byteLength,
          assets: revision.assets.slice(0, 32).map((asset) => ({
            name: asset.name,
            assetId: asset.assetId,
            mimeType: asset.mimeType,
            byteLength: asset.byteLength,
          })),
          createdAt: revision.createdAt,
          ...(revision.payload.kind === "workflow-snapshot"
            ? {
                workflow: {
                  workflowId: revision.payload.snapshot.workflowId,
                  runId: revision.payload.snapshot.runId,
                  sourceRevision: revision.payload.snapshot.sourceRevision,
                  capturedAt: revision.payload.snapshot.capturedAt,
                },
              }
            : {}),
        },
        publications,
        ...(source ? { source } : {}),
      });
    } catch (error) {
      return errorResponse(toArtifactError(error));
    }
  }

  async getOperation(
    caller: ResolvedArtifactCaller,
    args: { operationId: unknown; includePreviewImage?: unknown; captureIndex?: unknown },
  ): Promise<ArtifactResponse> {
    try {
      if (typeof args.operationId !== "string") throw notFound("Operation");
      const environmentId = caller.owner.environmentId;
      const records = this.ctx.store.records(environmentId);
      const operation = records.get("operation", args.operationId);
      if (!operation || !ownsRecord(caller.owner, operation)) throw notFound("Operation");
      const receipt = operation.receiptId ? records.get("receipt", operation.receiptId) : null;
      let captures: ArtifactCapture[] = [];
      let captureSource: "receipt" | "diagnostic" | "none" = "none";
      let rendererOutput: Record<string, unknown> | undefined;
      if (receipt) {
        const evidence = receipt.evidence;
        if (evidence.kind === "html-static" || evidence.kind === "html-interactive")
          captures = evidence.captures;
        if (evidence.kind === "mermaid" || evidence.kind === "chart") {
          captures = evidence.captures ?? [];
          rendererOutput = {
            assetId: evidence.rendererOutput.assetId,
            sha256: evidence.rendererOutput.sha256,
            mimeType: evidence.rendererOutput.mimeType,
            byteLength: evidence.rendererOutput.byteLength,
          };
        }
        if (captures.length > 0) captureSource = "receipt";
      } else if (operation.diagnosticCaptures?.length) {
        captures = operation.diagnosticCaptures;
        captureSource = "diagnostic";
      }
      const diagnostics = toolDiagnostics(operation.diagnostics, operation.omittedDiagnostics);
      const value: Record<string, unknown> = {
        operation: operationView(operation),
        diagnostics: diagnostics.diagnostics,
        omittedDiagnostics: diagnostics.omitted,
        ...(operation.probeResults
          ? {
              probeResults: operation.probeResults.slice(0, 20).map((result) => ({
                ...result,
                ...(typeof result.observed === "string"
                  ? { observed: result.observed.slice(0, 200) }
                  : {}),
              })),
            }
          : {}),
        evidence: {
          source: captureSource,
          captures: captures.map((capture, index) => ({
            index,
            assetId: capture.assetId,
            sha256: capture.sha256,
            width: capture.width,
            height: capture.height,
            byteLength: capture.byteLength,
          })),
          ...(rendererOutput ? { rendererOutput } : {}),
          ...(receipt
            ? {
                receipt: {
                  receiptId: receipt.receiptId,
                  inputHash: receipt.inputHash,
                  gates: receipt.gates.map((gate) => gate.gate),
                },
              }
            : {}),
        },
        // Nothing here is a visual assessment; even an attached image only
        // means the bytes were offered to the client.
        visualInspection: "not-assessed",
      };
      const notAttached = (reason?: string) =>
        okResponse({
          ...value,
          imageDelivery: "not-attached",
          image: { attached: false, ...(reason ? { reason } : {}) },
        });
      if (args.includePreviewImage !== true) return notAttached();
      const index = args.captureIndex ?? 0;
      if (
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= captures.length
      ) {
        if (captures.length === 0) return notAttached("no-capture");
        throw new ArtifactFailure(
          artifactError("invalid_input", `captureIndex must be 0–${captures.length - 1}`, {
            fieldErrors: [
              { path: "captureIndex", code: "out_of_range", message: "No capture at that index" },
            ],
          }),
        );
      }
      const capture = captures[index]!;
      if (capture.byteLength > PREVIEW_CAPTURE_POLICY.maxPngBytes) return notAttached("too-large");
      let bytes: Buffer;
      try {
        bytes = await this.ctx.store.readAsset(environmentId, capture.sha256, capture.byteLength);
      } catch {
        this.ctx.metrics.increment("storage_corrupt");
        return notAttached("storage_corrupt");
      }
      return {
        ...okResponse({
          ...value,
          // Attached as a separate image block; adapters or models that
          // cannot take images drop it, so this never claims it was seen.
          imageDelivery: "attached-if-supported",
          image: { attached: true, captureIndex: index, sha256: capture.sha256 },
        }),
        image: { data: bytes.toString("base64"), mimeType: "image/png" },
      };
    } catch (error) {
      return errorResponse(toArtifactError(error));
    }
  }
}

export function operationView(operation: StoredOperation): Record<string, unknown> {
  return {
    operationId: operation.operationId,
    artifactId: operation.artifactId,
    revision: operation.revision,
    kind: operation.kind,
    status: operation.status,
    profile: operation.profile,
    ...(operation.receiptId ? { receiptId: operation.receiptId } : {}),
    ...(operation.error ? { error: boundError(operation.error) } : {}),
    ...(operation.cancellationRequestedAt
      ? { cancellationRequestedAt: operation.cancellationRequestedAt }
      : {}),
    semantics: operation.semantics,
    createdAt: operation.createdAt,
    ...(operation.startedAt ? { startedAt: operation.startedAt } : {}),
    ...(operation.completedAt ? { completedAt: operation.completedAt } : {}),
  };
}
