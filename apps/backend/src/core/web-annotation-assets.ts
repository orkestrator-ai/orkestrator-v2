/**
 * Web annotation image ingestion and orphan collection.
 *
 * Every image entering annotation storage is a PNG validated here: the base64
 * payload is bounded before it is decoded, the decoded bytes are bounded
 * before they are parsed, and the chunk structure (signature, IHDR, CRCs,
 * IEND) is verified without decompressing pixel data. Callers keep only the
 * decoded buffer; the base64 string is never retained next to it.
 *
 * Collection removes only assets that no committed record can reach, after a
 * grace period measured from when they were first observed unreachable.
 */
import { createHash } from "node:crypto";
import {
  isWebAnnotationRequestActive,
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_LIMITS,
} from "@orkestrator/protocol/web-annotations";
import type { WebAnnotationManifest } from "./web-annotation-storage.js";

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Largest base64 string that can decode to at most `maxBytes`. */
export function maxBase64Chars(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4;
}

export class WebAnnotationImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAnnotationImageError";
  }
}

export interface ValidatedPng {
  bytes: Buffer;
  width: number;
  height: number;
  digest: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) {
    crc = CRC_TABLE[(crc ^ buffer[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const VALID_BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Validate decoded PNG bytes. Throws `WebAnnotationImageError` with a
 * content-free message; the payload never appears in the error.
 */
export function validatePngBytes(
  bytes: Buffer,
  limits: { maxBytes?: number; maxDimension?: number } = {},
): ValidatedPng {
  const maxBytes = limits.maxBytes ?? WEB_ANNOTATION_LIMITS.imageBytes;
  const maxDimension = limits.maxDimension ?? WEB_ANNOTATION_LIMITS.imageMaxDimension;
  if (bytes.byteLength > maxBytes) {
    throw new WebAnnotationImageError(`${WEB_ANNOTATION_CAPACITY} image exceeds ${maxBytes} bytes`);
  }
  if (bytes.byteLength < PNG_SIGNATURE.byteLength + 25 + 12) {
    throw new WebAnnotationImageError("Image is not a valid PNG");
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new WebAnnotationImageError("Image is not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  let chunks = 0;
  while (offset < bytes.byteLength) {
    if (++chunks > 100_000) throw new WebAnnotationImageError("PNG has too many chunks");
    if (offset + 12 > bytes.byteLength) throw new WebAnnotationImageError("PNG chunk is truncated");
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > 0x7fffffff || dataEnd + 4 > bytes.byteLength) {
      throw new WebAnnotationImageError("PNG chunk is truncated");
    }
    const type = bytes.toString("latin1", typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new WebAnnotationImageError("PNG chunk type is invalid");
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (crc32(bytes, typeStart, dataEnd) !== expectedCrc) {
      throw new WebAnnotationImageError("PNG chunk checksum is invalid");
    }
    if (chunks === 1) {
      if (type !== "IHDR" || length !== 13) {
        throw new WebAnnotationImageError("PNG header is invalid");
      }
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8]!;
      const colorType = bytes[dataStart + 9]!;
      const compression = bytes[dataStart + 10]!;
      const filter = bytes[dataStart + 11]!;
      const interlace = bytes[dataStart + 12]!;
      if (width < 1 || height < 1) throw new WebAnnotationImageError("PNG dimensions are invalid");
      if (width > maxDimension || height > maxDimension) {
        throw new WebAnnotationImageError(
          `${WEB_ANNOTATION_CAPACITY} image dimensions exceed ${maxDimension} pixels`,
        );
      }
      if (
        !VALID_BIT_DEPTHS[colorType]?.includes(bitDepth) ||
        compression !== 0 ||
        filter !== 0 ||
        (interlace !== 0 && interlace !== 1)
      ) {
        throw new WebAnnotationImageError("PNG header is invalid");
      }
      sawIhdr = true;
    } else if (type === "IHDR") {
      throw new WebAnnotationImageError("PNG header is duplicated");
    } else if (type === "IDAT") {
      sawIdat = true;
    } else if (type === "IEND") {
      sawIend = true;
      if (dataEnd + 4 !== bytes.byteLength) {
        throw new WebAnnotationImageError("PNG has trailing data");
      }
    }
    offset = dataEnd + 4;
    if (sawIend) break;
  }
  if (!sawIhdr || !sawIdat || !sawIend) throw new WebAnnotationImageError("PNG is incomplete");
  return { bytes, width, height, digest: sha256Hex(bytes) };
}

/**
 * Decode and validate a base64 PNG. The base64 length is checked before any
 * allocation so an oversized upload cannot force a large decode.
 */
export function decodeBase64Png(
  data: unknown,
  limits: { maxBytes?: number; maxDimension?: number } = {},
): ValidatedPng {
  const maxBytes = limits.maxBytes ?? WEB_ANNOTATION_LIMITS.imageBytes;
  if (typeof data !== "string" || data.length === 0) {
    throw new WebAnnotationImageError("Image data must be base64 text");
  }
  if (data.length > maxBase64Chars(maxBytes)) {
    throw new WebAnnotationImageError(`${WEB_ANNOTATION_CAPACITY} image exceeds ${maxBytes} bytes`);
  }
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new WebAnnotationImageError("Image data is not valid base64");
  }
  return validatePngBytes(Buffer.from(data, "base64"), limits);
}

// ---------------------------------------------------------------------------
// Reachability and collection

/** Every asset id a committed record or in-flight operation can still reach. */
export function reachableAssetIds(
  manifest: WebAnnotationManifest,
  pending: Iterable<string> = [],
): Set<string> {
  const reachable = new Set<string>(pending);
  // A deleted annotation is never readable again, so its own captures and
  // thumbnail stop holding images. Anything a retained request attached or a
  // result references stays reachable through those records below.
  const deleted = (annotationId: string) => manifest.annotations[annotationId]?.state === "deleted";
  for (const capture of Object.values(manifest.captures)) {
    if (!capture.resultOf && deleted(capture.annotationId)) continue;
    for (const id of capture.assetIds) reachable.add(id);
  }
  for (const result of Object.values(manifest.results)) {
    for (const id of result.assetIds) reachable.add(id);
  }
  for (const request of Object.values(manifest.requests)) {
    for (const attachment of request.attachments) reachable.add(attachment.assetId);
  }
  for (const annotation of Object.values(manifest.annotations)) {
    if (annotation.state === "deleted") continue;
    if (annotation.thumbnailAssetId) reachable.add(annotation.thumbnailAssetId);
  }
  for (const draft of Object.values(manifest.drafts)) {
    for (const id of draft.assetIds ?? []) reachable.add(id);
  }
  return reachable;
}

export interface AssetCollectionPlan {
  /** Assets that became unreachable now; their grace period starts. */
  markOrphaned: string[];
  /** Assets that are reachable again; clear their orphan timestamp. */
  unmark: string[];
  /** Unreachable past the grace period: remove from the manifest, then disk. */
  remove: string[];
}

/** Pure selection so tests can exercise the policy without a filesystem. */
export function planAssetCollection(
  manifest: WebAnnotationManifest,
  now: number,
  options: { pending?: Iterable<string>; graceMs?: number; batch?: number } = {},
): AssetCollectionPlan {
  const graceMs = options.graceMs ?? WEB_ANNOTATION_LIMITS.assetGcGraceMs;
  const batch = options.batch ?? 20;
  const reachable = reachableAssetIds(manifest, options.pending);
  const plan: AssetCollectionPlan = { markOrphaned: [], unmark: [], remove: [] };
  for (const asset of Object.values(manifest.assets)) {
    if (reachable.has(asset.id)) {
      if (asset.orphanedAt) plan.unmark.push(asset.id);
      continue;
    }
    if (!asset.orphanedAt) {
      plan.markOrphaned.push(asset.id);
      continue;
    }
    const orphanedAt = Date.parse(asset.orphanedAt);
    if (Number.isFinite(orphanedAt) && now - orphanedAt >= graceMs && plan.remove.length < batch) {
      plan.remove.push(asset.id);
    }
  }
  return plan;
}

export function environmentImageUsage(manifest: WebAnnotationManifest): number {
  let total = 0;
  for (const asset of Object.values(manifest.assets)) total += asset.bytes;
  return total;
}

// ---------------------------------------------------------------------------
// Capacity accounting

/** Annotations that count against the environment limit: tombstones do not. */
export function liveAnnotationCount(manifest: WebAnnotationManifest): number {
  let count = 0;
  for (const annotation of Object.values(manifest.annotations)) {
    if (annotation.state !== "deleted") count += 1;
  }
  return count;
}

/**
 * Requests that count against the environment limit: every unsettled request,
 * plus settled ones that still describe a live annotation. Settled requests
 * whose annotations were all deleted are history only.
 */
export function retainedRequestCount(manifest: WebAnnotationManifest): number {
  let count = 0;
  for (const request of Object.values(manifest.requests)) {
    if (
      isWebAnnotationRequestActive(request.state) ||
      request.selections.some(
        (selection) => manifest.annotations[selection.annotationId]?.state !== "deleted",
      )
    ) {
      count += 1;
    }
  }
  return count;
}
