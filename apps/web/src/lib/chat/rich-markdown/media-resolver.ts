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
 * Inside a transcript message (`pin`), a local file is read through
 * `transcript_media_pin` instead: the backend saves the bytes the first time
 * the message shows them and returns that copy from then on, so overwriting
 * the file does not change what an earlier message shows.
 *
 * Concurrent requests for the same reference on the same node share one
 * read. Decoded bytes that cannot change (inline, remote, pinned) go into the
 * bounded image-preview cache, keyed by node; a live read of a file never
 * does. Every read goes through the command node today (`@/lib/backend`), so
 * the node is the command scope's.
 */
import { backendForScope, type ScopeBackend } from "@/lib/backend/scope-backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import { parseLocalFilePathFromUrl } from "@/lib/chat/file-url";
import {
  clearImagePreviewCache,
  clearImagePreviewCacheForNode,
  imagePreviewCacheKey,
  readImagePreviewCache,
  readImagePreviewSnapshot,
  writeImagePreviewCache,
} from "@/lib/chat/image-preview-cache";
import { registerProtectedRichCache } from "@/lib/chat/rich-content-reset";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import type {
  TranscriptMediaPinResponse,
  TranscriptMediaSnapshot,
} from "@orkestrator/protocol/transcript-media-pins";
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

/**
 * The message a transcript image is shown in. With it, a local file is read
 * through `transcript_media_pin`, which saves the bytes on first use so the
 * message keeps showing that version after the file is overwritten.
 */
export interface MediaPinScope {
  environmentId: string;
  logicalSessionKey: string;
  messageId: string;
}

/** Resolved bytes and, for a local file, where they came from. */
export interface ResolvedMedia {
  url: string;
  /** Provenance of a pinned file's bytes. Absent for inline and remote bytes and direct reads. */
  snapshot?: TranscriptMediaSnapshot;
}

/** A resolution plus whether it may be served again without a read. */
interface Resolution extends ResolvedMedia {
  /**
   * Inline and remote bytes, and saved pins. A live read of a file is never
   * cached, or a later look would show the file as it was then rather than as
   * it is now.
   */
  cacheable: boolean;
}

/**
 * Cache identity. Only bytes that cannot change are ever cached (see
 * `Resolution.cacheable`), so a key never has to say which version it holds: a pinned
 * reference names its message, and a deferred detail is pinned by the backend.
 */
export function mediaCacheKey(reference: MediaReference, pin?: MediaPinScope): string {
  const key = imagePreviewCacheKey(
    reference.containerId,
    reference.path,
    reference.fileUrl,
    reference.detailRef,
  );
  return pin
    ? JSON.stringify(["pinned", pin.environmentId, pin.logicalSessionKey, pin.messageId, key])
    : key;
}

/**
 * Both shapes of one read, so either caller joining it gets the same promise,
 * keyed by `(node, key)`. `current` turns false when a clear supersedes the
 * read: its bytes are then never cached nor returned.
 */
interface InflightRead {
  readonly nodeId: string;
  readonly resolved: Promise<ResolvedMedia>;
  readonly url: Promise<string>;
  current: boolean;
}
const inflight = new Map<string, InflightRead>();
const inflightId = (nodeId: string, key: string) => `${nodeId}\u0000${key}`;

interface ResolveOptions {
  /**
   * The node the media is read from and cached for (the transcript's:
   * `useScopesWithCommandFallback().scope`, plan item 4007). The app's
   * command scope when omitted.
   */
  scope?: NodeScope;
  loadToolDetails?: ToolDetailLoader;
  detailCache?: ToolDetailCache;
  cacheImage?: boolean;
  pin?: MediaPinScope;
}

/**
 * Resolve a reference to a URL an <img>/<video> can load: a `data:` URL for
 * local and deferred bytes, or the remote `http(s)` URL itself.
 */
export function resolveMediaUrl(
  reference: MediaReference,
  options: ResolveOptions = {},
): Promise<string> {
  const key = mediaCacheKey(reference, options.pin);
  const nodeId = (options.scope ?? appCommandScope()).nodeId;
  if (options.cacheImage) {
    const cached = readImagePreviewCache(key, nodeId);
    if (cached) return Promise.resolve(cached);
  }
  return startRead(nodeId, key, reference, options).url;
}

/** {@link resolveMediaUrl} with the provenance of a local file's bytes. */
export function resolveMedia(
  reference: MediaReference,
  options: ResolveOptions = {},
): Promise<ResolvedMedia> {
  const key = mediaCacheKey(reference, options.pin);
  const nodeId = (options.scope ?? appCommandScope()).nodeId;
  if (options.cacheImage) {
    const cached = readImagePreviewCache(key, nodeId);
    if (cached) {
      const snapshot = readImagePreviewSnapshot(key, cached, nodeId);
      return Promise.resolve(snapshot ? { url: cached, snapshot } : { url: cached });
    }
  }
  return startRead(nodeId, key, reference, options).resolved;
}

function startRead(
  nodeId: string,
  key: string,
  reference: MediaReference,
  options: ResolveOptions,
): InflightRead {
  const id = inflightId(nodeId, key);
  const existing = inflight.get(id);
  if (existing) return existing;
  // Assigned below, before the read can settle.
  let read!: InflightRead;
  const request = resolveUncached(reference, {
    ...options,
    asImage: options.cacheImage,
    isCurrent: () => read.current,
  }).then(({ cacheable, ...resolved }): ResolvedMedia => {
    if (!read.current) throw new DOMException("Superseded media read", "AbortError");
    if (options.cacheImage && cacheable && resolved.url.startsWith("data:")) {
      writeImagePreviewCache(key, resolved.url, resolved.snapshot, nodeId);
    }
    return resolved;
  });
  read = {
    nodeId,
    resolved: request,
    url: request.then((resolved) => resolved.url),
    current: true,
  };
  inflight.set(id, read);
  const cleanup = () => {
    if (inflight.get(id) === read) inflight.delete(id);
  };
  void request.then(cleanup, cleanup);
  // Callers hold one of the two; neither rejection may go unhandled.
  void read.url.catch(() => undefined);
  return read;
}

async function resolveUncached(
  { path, fileUrl, detailRef, containerId }: MediaReference,
  options: Omit<ResolveOptions, "cacheImage"> & {
    asImage?: boolean;
    isCurrent: () => boolean;
  },
): Promise<Resolution> {
  const node = backendForScope(options.scope ?? appCommandScope());
  // No path and no inline copy on the part: the bytes live behind the
  // deferred detail reference. Fetch them before choosing a source.
  let resolvedFileUrl = fileUrl;
  let snapshot: TranscriptMediaSnapshot | undefined;
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
      // A live copy of a file must be read again next time.
      if (details.fileSnapshot?.status !== "live") options.detailCache?.write(details);
    }
    resolvedFileUrl = details.fileDataUrl;
    snapshot = details.fileSnapshot;
  }

  if (resolvedFileUrl?.startsWith("data:")) {
    const cacheable = snapshot?.status !== "live";
    return snapshot
      ? { url: resolvedFileUrl, snapshot, cacheable }
      : { url: resolvedFileUrl, cacheable };
  }
  if (isRemoteMediaUrl(resolvedFileUrl)) return { url: resolvedFileUrl!, cacheable: true };

  const localFilePath = resolvedFileUrl?.startsWith("file://")
    ? parseLocalFilePathFromUrl(resolvedFileUrl)
    : null;

  if (containerId) {
    const containerPath = localFilePath ?? path;
    const relativePath = getSafeContainerRelativePath(containerPath);
    if (!relativePath) throw new Error("Unsafe container media path");
    const mime = mimeFor(containerPath, options.asImage);
    const pinned = await readPinned(node, options.pin, { path: relativePath, containerId }, mime);
    if (pinned) return pinned;
    const base64 = await node.readContainerFileBase64(containerId, relativePath);
    return { url: `data:${mime};base64,${base64}`, cacheable: false };
  }

  const filePath = localFilePath ?? (isAbsoluteHostPath(path) ? path : null);
  if (!filePath) throw new Error("No readable local media path available");
  const mime = mimeFor(filePath, options.asImage);
  const pinned = await readPinned(node, options.pin, { path: filePath }, mime);
  if (pinned) return pinned;
  const base64 = await node.readFileBase64(filePath);
  return { url: `data:${mime};base64,${base64}`, cacheable: false };
}

/**
 * The message's saved copy of a file (saving it now on first use), or null
 * when there is no message to pin to or the pin cannot be read. A failed pin
 * falls back to a direct read, which reports the reader's own error (outside
 * the workspace, denied, too large) exactly as before, and keeps working
 * against a backend that predates pins.
 */
async function readPinned(
  node: Pick<ScopeBackend, "pinTranscriptMedia">,
  pin: MediaPinScope | undefined,
  file: { path: string; containerId?: string },
  mime: string,
): Promise<Resolution | null> {
  if (!pin) return null;
  let response: TranscriptMediaPinResponse;
  try {
    response = await node.pinTranscriptMedia({ ...pin, ...file });
  } catch {
    return null;
  }
  const snapshot: TranscriptMediaSnapshot = {
    status: response.status,
    capturedAt: response.capturedAt,
    ...(response.fileModifiedAt ? { fileModifiedAt: response.fileModifiedAt } : {}),
    ...(response.reason ? { reason: response.reason } : {}),
  };
  return {
    url: `data:${mime};base64,${response.dataBase64}`,
    snapshot,
    cacheable: response.status === "pinned",
  };
}

/** An image part with an unrecognised extension is still served as an image. */
function mimeFor(path: string, asImage: boolean | undefined): string {
  const mime = declaredMime(path);
  return asImage && !mime.startsWith("image/") ? "image/png" : mime;
}

/** Supersede the in-flight reads `matches` selects (all of them by default). */
function supersedeReads(matches: (read: InflightRead) => boolean = () => true): void {
  for (const [id, read] of Array.from(inflight)) {
    if (!matches(read)) continue;
    read.current = false;
    inflight.delete(id);
  }
}

/** Drop in-flight bookkeeping (tests). */
export function clearMediaResolverInflight(): void {
  supersedeReads();
}

// Resolved media (data: URLs of environment files) is protected content.
registerProtectedRichCache("media", {
  clearAll: () => {
    supersedeReads();
    clearImagePreviewCache();
  },
  clearBackend: (nodeId) => {
    supersedeReads((read) => read.nodeId === nodeId);
    clearImagePreviewCacheForNode(nodeId);
  },
});
