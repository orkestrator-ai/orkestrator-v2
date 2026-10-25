/**
 * Pure helpers for transcript media placeholders and failure states.
 *
 * - Layout is reserved from trustworthy dimensions: the intrinsic size in an
 *   image header that has already been read (PNG/GIF/JPEG), never a model-
 *   supplied title. Without one, callers use a bounded aspect-ratio box.
 * - Load failures are classified into the states the transcript shows
 *   distinctly (denied, unavailable, too large) from the backend's error
 *   shape: structured `{code,message}` command errors (`artifactErrorInfo`)
 *   and the plain messages the confined file readers throw.
 * - Inline audio/video playback is bounded by `INLINE_MEDIA_PLAYBACK_MAX_BYTES`
 *   when bytes travel as base64; streamed playback (`mediaStreamingAvailable`)
 *   reads ranges from the content origin and is bounded by the backend's
 *   `TRANSCRIPT_MEDIA_STREAM_MAX_*_BYTES` instead.
 */
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";
import {
  TRANSCRIPT_MEDIA_STREAM_MAX_CONTAINER_BYTES,
  TRANSCRIPT_MEDIA_STREAM_MAX_HOST_BYTES,
} from "@orkestrator/protocol/transcript-artifact-commands";
import { artifactErrorInfo } from "@/lib/chat/artifact-requests";
import {
  base64ByteLength,
  base64Prefix,
  bytesMatchPreviewKind,
  dataUrlBase64,
  dataUrlMime,
  imageDimensionsFromBytes,
  previewKindForMime,
} from "@/lib/chat/rich-markdown/media-types";

/**
 * Largest audio/video asset turned into an inline player (decoded bytes).
 *
 * It is the existing per-attachment limit: the backend accepts prompt
 * attachments up to 8 MiB (`MAX_ATTACHMENT_BYTES` in
 * `apps/backend/src/core/prompt-attachments.ts`) and the composer, clipboard
 * paste and file-drop paths refuse larger files with the same 8 MiB bound.
 * Anything larger is offered as a download instead of being decoded into a
 * blob for playback.
 */
export const INLINE_MEDIA_PLAYBACK_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Largest audio/video asset played through a range-capable stream: the
 * backend's own ceilings (2 GiB for host files read in place, 512 MiB for
 * container files copied once into staging). Bytes never pass through the
 * renderer as base64, so the 8 MiB inline bound does not apply.
 */
export const STREAMED_MEDIA_MAX_BYTES = {
  host: TRANSCRIPT_MEDIA_STREAM_MAX_HOST_BYTES,
  container: TRANSCRIPT_MEDIA_STREAM_MAX_CONTAINER_BYTES,
} as const;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Whether this renderer can reach the backend's artifact content origin for
 * streamed media. A hosted (non-loopback) content origin is reachable from
 * anywhere; a loopback one only from a page that is itself on loopback or the
 * packaged desktop renderer (`file:`). A remote browser without a hosted
 * content origin keeps the bounded base64 path. Desktop windows attached to
 * a remote backend can still fail to reach it; the player falls back when
 * the stream errors before its metadata loads.
 */
export function mediaStreamingAvailable(
  contentOrigin: string | null | undefined,
  page: Pick<Location, "protocol" | "hostname">,
): boolean {
  if (!contentOrigin) return false;
  let origin: URL;
  try {
    origin = new URL(contentOrigin);
  } catch {
    return false;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
  if (!isLoopbackHost(origin.hostname)) return true;
  return page.protocol === "file:" || isLoopbackHost(page.hostname);
}

/**
 * What a failed `transcript_media_open_stream` means for the player:
 * `fallback` uses the bounded base64 path (no content origin, an older
 * backend, a transient staging limit); otherwise the shown failure state.
 */
export function mediaStreamFailure(error: unknown): "fallback" | "unsupported" | MediaLoadFailure {
  const { code, message } = artifactErrorInfo(error);
  if (
    code === "renderer_unavailable" ||
    code === "capacity_exceeded" ||
    code === "storage_unavailable"
  ) {
    return "fallback";
  }
  if (!code && /^Unknown backend command:/i.test(message)) return "fallback";
  if (code === "unsupported_kind") return "unsupported";
  if (code === "not_found") return "unavailable";
  return mediaLoadFailure(error);
}

/** Bounded placeholder used when no trustworthy dimensions are known. */
export const MEDIA_PLACEHOLDER_ASPECT_RATIO = "4 / 3";

/** How far into a JPEG to look for its frame header (EXIF can precede it). */
const HEADER_PROBE_BYTES = 256 * 1024;

export interface MediaDimensions {
  width: number;
  height: number;
}

/** Intrinsic image dimensions from a base64 data URL's header, or null. */
export function imageDimensionsFromDataUrl(url: string | null | undefined): MediaDimensions | null {
  if (!url?.startsWith("data:")) return null;
  const base64 = dataUrlBase64(url);
  if (!base64) return null;
  try {
    const dimensions = imageDimensionsFromBytes(
      base64Prefix(base64, Math.min(base64ByteLength(base64), HEADER_PROBE_BYTES)),
    );
    if (
      !dimensions ||
      !Number.isSafeInteger(dimensions.width) ||
      !Number.isSafeInteger(dimensions.height) ||
      dimensions.width <= 0 ||
      dimensions.height <= 0
    ) {
      return null;
    }
    return dimensions;
  } catch {
    return null;
  }
}

/** Whether decoding an image of this size would exceed the viewer's pixel ceiling. */
export function exceedsImageDecodeCeiling(dimensions: MediaDimensions | null): boolean {
  return (
    dimensions !== null &&
    dimensions.width * dimensions.height > FRONTEND_RENDER_POLICY.imageDecodeMaxPixels
  );
}

/** The image decode ceiling, in whole megapixels, for user-facing text. */
export const IMAGE_DECODE_MAX_MEGAPIXELS = Math.floor(
  FRONTEND_RENDER_POLICY.imageDecodeMaxPixels / 1_000_000,
);

export type LoadedImageCheck =
  | { ok: true; dimensions: MediaDimensions | null }
  | { ok: false; reason: "type" | "pixels"; dimensions: MediaDimensions | null };

/**
 * Check loaded image bytes before handing them to `<img>`: the declared type
 * must be an image, the leading bytes must agree with it, and the header's
 * dimensions must stay under the decode ceiling. A remote URL has no bytes to
 * inspect here and passes with unknown dimensions.
 */
export function checkLoadedImage(url: string): LoadedImageCheck {
  if (!url.startsWith("data:")) return { ok: true, dimensions: null };
  const base64 = dataUrlBase64(url);
  const mime = dataUrlMime(url);
  if (!base64 || !mime) return { ok: false, reason: "type", dimensions: null };
  const kind = previewKindForMime(mime);
  if (kind !== "image" && kind !== "svg") return { ok: false, reason: "type", dimensions: null };
  try {
    if (!bytesMatchPreviewKind(kind, base64Prefix(base64, 8192))) {
      return { ok: false, reason: "type", dimensions: null };
    }
  } catch {
    return { ok: false, reason: "type", dimensions: null };
  }
  const dimensions = kind === "image" ? imageDimensionsFromDataUrl(url) : null;
  if (exceedsImageDecodeCeiling(dimensions)) return { ok: false, reason: "pixels", dimensions };
  return { ok: true, dimensions };
}

/** Decoded byte size of a base64 data URL, or null when it is not one. */
export function dataUrlByteLength(url: string | null | undefined): number | null {
  if (!url?.startsWith("data:")) return null;
  const base64 = dataUrlBase64(url);
  return base64 === null ? null : base64ByteLength(base64);
}

export type MediaLoadFailure = "outside-workspace" | "denied" | "unavailable" | "too-large";

const DENIED_CODES = new Set([
  "policy_denied",
  "permission_denied",
  "access_denied",
  "forbidden",
  "unauthorized",
  "eacces",
  "eperm",
]);
const TOO_LARGE_CODES = new Set(["capacity_exceeded", "package_size_exceeded", "too_large"]);

/** Path-confinement refusals from the host and container readers and the media stream. */
const OUTSIDE_WORKSPACE_MESSAGE =
  /outside Orkestrator workspace storage|outside the (?:environment's|container) workspace|unsafe container media path/i;
const DENIED_MESSAGE =
  /permission denied|access denied|not permitted|forbidden|unauthori[sz]ed|\bEACCES\b|\bEPERM\b/i;
const TOO_LARGE_MESSAGE = /\bexceeds \d+ bytes\b|too large/i;

/**
 * Classify a media read failure. A path outside the environment's workspace
 * is `outside-workspace` (checked first: the stream reports it as
 * `policy_denied`); other authorization refusals are `denied`; size ceilings
 * are `too-large`; everything else (missing, moved, expired, offline,
 * malformed) is `unavailable`.
 */
export function mediaLoadFailure(error: unknown): MediaLoadFailure {
  const { code, message } = artifactErrorInfo(error);
  if (OUTSIDE_WORKSPACE_MESSAGE.test(message)) return "outside-workspace";
  const normalizedCode = code?.toLowerCase();
  if (normalizedCode && DENIED_CODES.has(normalizedCode)) return "denied";
  if (normalizedCode && TOO_LARGE_CODES.has(normalizedCode)) return "too-large";
  if (DENIED_MESSAGE.test(message)) return "denied";
  if (TOO_LARGE_MESSAGE.test(message)) return "too-large";
  return "unavailable";
}
