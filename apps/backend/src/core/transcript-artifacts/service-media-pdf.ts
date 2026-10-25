/**
 * First-page previews of PDF attachments (`transcript_media_pdf_preview`).
 *
 * The caller supplies a reader bound to one of the backend's existing
 * authorized file readers (commands-pdf.ts); this module never resolves a
 * path or URL itself. Bytes over the PDF ceiling, or without a PDF
 * signature, are refused with metadata before any worker starts. Rendering
 * is a supervised preview-worker job (pinned pdf.js, network denied, the
 * usual admission and deadlines); at most two previews hold bytes at once.
 * Deterministic outcomes are cached by content hash in a small bounded LRU.
 * Logs carry sizes, counts and reason codes only.
 */
import { createHash, randomBytes } from "node:crypto";

import { PDF_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type { TranscriptMediaPdfPreviewResponse } from "@orkestrator/protocol/transcript-artifact-commands";
import { ArtifactFailure } from "@orkestrator/protocol/transcript-artifacts";

import { logArtifactEvent } from "./metrics.js";
import { looksLikePdf } from "./print-profile.js";
import type { ArtifactServiceContext } from "./service-context.js";

/** Concurrent previews holding PDF bytes in memory (queued or running). */
export const MAX_ACTIVE_PDF_PREVIEWS = 2;
const LIMITS = { maxPages: PDF_POLICY.maxPages, maxBytes: PDF_POLICY.maxBytes } as const;

type Response = TranscriptMediaPdfPreviewResponse;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function responseBytes(response: Response): number {
  return (response.thumbnail?.dataBase64.length ?? 0) + 512;
}

export class MediaPdfPreviews {
  private readonly cache = new Map<string, Response>();
  private cacheBytes = 0;
  private readonly inFlight = new Map<string, Promise<Response>>();
  private readonly running = new Map<
    string,
    { environmentId: string; controller: AbortController }
  >();
  private active = 0;

  constructor(private readonly ctx: ArtifactServiceContext) {}

  /** Cancels running previews for one environment (deletion) or all (shutdown). */
  abort(environmentId?: string): void {
    for (const job of this.running.values())
      if (environmentId === undefined || job.environmentId === environmentId)
        job.controller.abort();
  }

  async preview(environmentId: string, read: () => Promise<Uint8Array>): Promise<Response> {
    let bytes: Uint8Array;
    try {
      bytes = await read();
    } catch (error) {
      const message =
        error instanceof ArtifactFailure
          ? error.error.message
          : "The file could not be read through the environment's file access";
      if (error instanceof ArtifactFailure && error.error.code === "package_size_exceeded")
        return {
          status: "refused",
          sha256: null,
          byteLength: null,
          pageCount: null,
          reason: "byte-limit",
          message: message.slice(0, 300),
          limits: LIMITS,
        };
      return {
        status: "unavailable",
        sha256: null,
        byteLength: null,
        pageCount: null,
        reason: "read-failed",
        message: message.slice(0, 300),
        limits: LIMITS,
      };
    }
    const hash = sha256(bytes);
    const base = { sha256: hash, byteLength: bytes.byteLength, limits: LIMITS };
    if (bytes.byteLength > PDF_POLICY.maxBytes)
      return {
        ...base,
        status: "refused",
        pageCount: null,
        reason: "byte-limit",
        message: `The PDF is larger than the ${PDF_POLICY.maxBytes / (1024 * 1024)} MiB preview limit`,
      };
    if (!looksLikePdf(bytes))
      return {
        ...base,
        status: "refused",
        pageCount: null,
        reason: "not-pdf",
        message: "The file's contents are not a PDF document",
      };
    const cached = this.cache.get(hash);
    if (cached) {
      this.cache.delete(hash);
      this.cache.set(hash, cached);
      return cached;
    }
    const pending = this.inFlight.get(hash);
    if (pending) return pending;
    const task = this.render(environmentId, bytes, hash).finally(() => this.inFlight.delete(hash));
    this.inFlight.set(hash, task);
    return task;
  }

  private remember(hash: string, response: Response): Response {
    const size = responseBytes(response);
    if (size > PDF_POLICY.previewCacheBytes) return response;
    this.cache.set(hash, response);
    this.cacheBytes += size;
    while (
      this.cache.size > PDF_POLICY.previewCacheEntries ||
      this.cacheBytes > PDF_POLICY.previewCacheBytes
    ) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cacheBytes -= responseBytes(this.cache.get(oldest.value)!);
      this.cache.delete(oldest.value);
    }
    return response;
  }

  private async render(environmentId: string, pdf: Uint8Array, hash: string): Promise<Response> {
    const base = { sha256: hash, byteLength: pdf.byteLength, limits: LIMITS };
    const runner = this.ctx.runtime.runner;
    if (!runner || !runner.status().available)
      return {
        ...base,
        status: "unavailable",
        pageCount: null,
        reason: "renderer-unavailable",
        message: "PDF previews need the isolated preview worker, which is unavailable on this host",
      };
    if (this.active >= MAX_ACTIVE_PDF_PREVIEWS)
      return {
        ...base,
        status: "unavailable",
        pageCount: null,
        reason: "capacity",
        message: "Other PDF previews are still rendering; try again shortly",
      };
    this.active++;
    const operationId = `op_pdfprev_${randomBytes(10).toString("hex")}`;
    const controller = new AbortController();
    this.running.set(operationId, { environmentId, controller });
    try {
      const result = await runner.run(
        { kind: "pdf-thumbnail", pdf, maxDimension: PDF_POLICY.thumbnailMaxDimension },
        { environmentId, conversationKey: "media-pdf-preview", operationId },
        controller.signal,
      );
      if (!result.ok) {
        logArtifactEvent("pdf-preview-failed", {
          environmentId,
          operation: operationId,
          code: result.error.code,
          resource: result.error.resource,
        });
        if (result.error.code === "package_size_exceeded")
          return this.remember(hash, {
            ...base,
            status: "refused",
            pageCount: null,
            reason: "byte-limit",
            message: result.error.message.slice(0, 300),
          });
        return {
          ...base,
          status: "unavailable",
          pageCount: null,
          reason: result.error.code === "capacity_exceeded" ? "capacity" : "renderer-unavailable",
          message: result.error.message.slice(0, 300),
        };
      }
      if (result.kind !== "pdf-thumbnail")
        return {
          ...base,
          status: "unavailable",
          pageCount: null,
          reason: "renderer-unavailable",
          message: "The renderer returned the wrong result kind",
        };
      const thumbnail = result.thumbnail;
      if (
        result.refusal ||
        !thumbnail ||
        thumbnail.png.byteLength > PDF_POLICY.thumbnailMaxPngBytes ||
        thumbnail.width > PDF_POLICY.thumbnailMaxDimension ||
        thumbnail.height > PDF_POLICY.thumbnailMaxDimension
      ) {
        const reason = result.refusal ?? "invalid-pdf";
        return this.remember(hash, {
          ...base,
          status: "refused",
          pageCount: result.pageCount,
          reason,
          message:
            reason === "page-limit"
              ? `The PDF has ${result.pageCount ?? "too many"} pages; previews are limited to ${PDF_POLICY.maxPages}`
              : reason === "encrypted"
                ? "The PDF is password protected"
                : "The PDF could not be opened",
        });
      }
      logArtifactEvent("pdf-preview", {
        environmentId,
        operation: operationId,
        pages: result.pageCount ?? undefined,
        bytes: pdf.byteLength,
      });
      return this.remember(hash, {
        ...base,
        status: "ready",
        pageCount: result.pageCount,
        thumbnail: {
          dataBase64: Buffer.from(
            thumbnail.png.buffer,
            thumbnail.png.byteOffset,
            thumbnail.png.byteLength,
          ).toString("base64"),
          mimeType: "image/png",
          width: thumbnail.width,
          height: thumbnail.height,
        },
      });
    } catch (error) {
      const failure = error instanceof ArtifactFailure ? error.error : null;
      return {
        ...base,
        status: "unavailable",
        pageCount: null,
        reason: failure?.code === "capacity_exceeded" ? "capacity" : "renderer-unavailable",
        message: (failure?.message ?? "PDF preview failed").slice(0, 300),
      };
    } finally {
      this.active--;
      this.running.delete(operationId);
    }
  }
}
