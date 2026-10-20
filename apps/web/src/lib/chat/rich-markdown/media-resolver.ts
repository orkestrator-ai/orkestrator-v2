/**
 * The shared, environment-scoped media resolver used by attachment and
 * provider image parts, viewed-image tool previews, Markdown images and file
 * previews.
 *
 * Resolution order matches what the attachment row always did: a deferred
 * `detailRef` is fetched through the transcript's tool-detail loader; an
 * inline `data:` URL is used as is; a remote `http(s)` URL is handed to the
 * browser (no application credentials are attached); a local path is read
 * through the backend, which owns confinement and authorization —
 * `read_container_file_base64` with a workspace-relative path inside a
 * container, `read_file_base64` for an absolute host path. A `file://` URL is
 * only ever decoded to such a path; it is never navigated to.
 *
 * Concurrent requests for the same reference share one read, and decoded
 * image data URLs go into the bounded image-preview cache.
 */
import { readContainerFileBase64, readFileBase64 } from "@/lib/backend";
import { parseLocalFilePathFromUrl } from "@/lib/chat/file-url";
import {
  clearImagePreviewCache,
  imagePreviewCacheKey,
  readImagePreviewCache,
  writeImagePreviewCache,
} from "@/lib/chat/image-preview-cache";
import { registerProtectedRichCache } from "@/lib/chat/rich-content-reset";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import { declaredMime } from "./media-types";

export interface MediaReference {
  path: string;
  fileUrl?: string;
  detailRef?: string;
  containerId?: string;
}

export type ToolDetailLoader = (detailRef: string) => Promise<NativeAgentToolDetails>;

export interface ToolDetailCache {
  read: (detailRef: string) => NativeAgentToolDetails | undefined;
  write: (details: NativeAgentToolDetails) => void;
}

export function isRemoteMediaUrl(fileUrl?: string): boolean {
  return typeof fileUrl === "string" && /^https?:\/\//i.test(fileUrl);
}

export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

/** Workspace-relative path for a container read, or null when it would escape. */
export function getSafeContainerRelativePath(path: string): string | null {
  if (!path || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    return null;
  }
  if (path.split(/[\\/]+/).some((segment) => segment === "..")) {
    return null;
  }
  if (path.startsWith("~")) {
    return null;
  }
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith("\\")) {
    return null;
  }
  if (path.startsWith("/workspace/")) {
    const relativePath = path.slice("/workspace/".length);
    if (
      !relativePath ||
      relativePath.startsWith("/") ||
      relativePath.startsWith("\\") ||
      /^[a-z]:[\\/]/i.test(relativePath)
    ) {
      return null;
    }
    return relativePath;
  }
  if (path.startsWith("/")) {
    return null;
  }
  return path;
}

/** Cheap pre-check: whether a reference has any route the resolver could take. */
export function canResolveMedia(reference: MediaReference): boolean {
  const { path, fileUrl, containerId, detailRef } = reference;
  if (fileUrl?.startsWith("data:") || isRemoteMediaUrl(fileUrl)) return true;
  const localFilePath = fileUrl?.startsWith("file://") ? parseLocalFilePathFromUrl(fileUrl) : null;
  if (containerId) return getSafeContainerRelativePath(localFilePath ?? path) !== null;
  return Boolean(detailRef) || Boolean(localFilePath ?? (isAbsoluteHostPath(path) ? path : null));
}

/**
 * The environment file a range-capable media stream would read
 * (`transcript_media_open_stream`), or null when the bytes are inline, remote
 * or only behind a deferred detail reference. Mirrors the resolver's own
 * routes: where it would read the detail reference first, so does this (no
 * stream); a container reference needs a safe workspace-relative path, a host
 * reference an absolute path (a bare display name never names a live file).
 */
export function mediaStreamTarget(
  reference: MediaReference,
): { path: string; containerId?: string } | null {
  const { path, fileUrl, containerId, detailRef } = reference;
  if (fileUrl?.startsWith("data:") || isRemoteMediaUrl(fileUrl)) return null;
  if (detailRef && (!fileUrl || !containerId)) return null;
  const localFilePath = fileUrl?.startsWith("file://") ? parseLocalFilePathFromUrl(fileUrl) : null;
  // Some other scheme, or a file URL that does not decode to a local path.
  if (fileUrl && !localFilePath) return null;
  if (containerId) {
    const relativePath = getSafeContainerRelativePath(localFilePath ?? path);
    return relativePath ? { path: relativePath, containerId } : null;
  }
  const filePath = localFilePath ?? (isAbsoluteHostPath(path) ? path : null);
  return filePath ? { path: filePath } : null;
}

export function mediaCacheKey(reference: MediaReference): string {
  return imagePreviewCacheKey(
    reference.containerId,
    reference.path,
    reference.fileUrl,
    reference.detailRef,
  );
}

const inflight = new Map<string, Promise<string>>();
let resetGeneration = 0;

/**
 * Resolve a reference to a URL an <img>/<video> can load: a `data:` URL for
 * local and deferred bytes, or the remote `http(s)` URL itself.
 */
export function resolveMediaUrl(
  reference: MediaReference,
  options: {
    loadToolDetails?: ToolDetailLoader;
    detailCache?: ToolDetailCache;
    cacheImage?: boolean;
  } = {},
): Promise<string> {
  const key = mediaCacheKey(reference);
  if (options.cacheImage) {
    const cached = readImagePreviewCache(key);
    if (cached) return Promise.resolve(cached);
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const generation = resetGeneration;
  const request = resolveUncached(reference, {
    ...options,
    asImage: options.cacheImage,
    isCurrent: () => generation === resetGeneration,
  }).then((url) => {
    if (generation !== resetGeneration)
      throw new DOMException("Superseded media read", "AbortError");
    if (options.cacheImage && url.startsWith("data:")) writeImagePreviewCache(key, url);
    return url;
  });
  inflight.set(key, request);
  const cleanup = () => {
    if (inflight.get(key) === request) inflight.delete(key);
  };
  void request.then(cleanup, cleanup);
  return request;
}

async function resolveUncached(
  { path, fileUrl, detailRef, containerId }: MediaReference,
  options: {
    loadToolDetails?: ToolDetailLoader;
    detailCache?: ToolDetailCache;
    asImage?: boolean;
    isCurrent: () => boolean;
  },
): Promise<string> {
  // No path and no inline copy on the part: the bytes live behind the
  // deferred detail reference. Fetch them before choosing a source.
  let resolvedFileUrl = fileUrl;
  if (
    detailRef &&
    options.loadToolDetails &&
    (!resolvedFileUrl ||
      (!containerId && !resolvedFileUrl.startsWith("data:") && !isRemoteMediaUrl(resolvedFileUrl)))
  ) {
    let details = options.detailCache?.read(detailRef);
    if (!details) {
      details = await options.loadToolDetails(detailRef);
      if (!options.isCurrent()) throw new DOMException("Superseded media read", "AbortError");
      options.detailCache?.write(details);
    }
    resolvedFileUrl = details.fileDataUrl;
  }

  if (resolvedFileUrl?.startsWith("data:")) return resolvedFileUrl;
  if (isRemoteMediaUrl(resolvedFileUrl)) return resolvedFileUrl!;

  const localFilePath = resolvedFileUrl?.startsWith("file://")
    ? parseLocalFilePathFromUrl(resolvedFileUrl)
    : null;

  if (containerId) {
    const containerPath = localFilePath ?? path;
    const relativePath = getSafeContainerRelativePath(containerPath);
    if (!relativePath) throw new Error("Unsafe container media path");
    const base64 = await readContainerFileBase64(containerId, relativePath);
    return `data:${mimeFor(containerPath, options.asImage)};base64,${base64}`;
  }

  const filePath = localFilePath ?? (isAbsoluteHostPath(path) ? path : null);
  if (!filePath) throw new Error("No readable local media path available");
  const base64 = await readFileBase64(filePath);
  return `data:${mimeFor(filePath, options.asImage)};base64,${base64}`;
}

/** An image part with an unrecognised extension is still served as an image. */
function mimeFor(path: string, asImage: boolean | undefined): string {
  const mime = declaredMime(path);
  return asImage && !mime.startsWith("image/") ? "image/png" : mime;
}

/** Drop in-flight bookkeeping (tests). */
export function clearMediaResolverInflight(): void {
  resetGeneration++;
  inflight.clear();
}

// Resolved media (data: URLs of environment files) is protected content.
registerProtectedRichCache("media", {
  clearAll: () => {
    resetGeneration++;
    inflight.clear();
    clearImagePreviewCache();
  },
});
