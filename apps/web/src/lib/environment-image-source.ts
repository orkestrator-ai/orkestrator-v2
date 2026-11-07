/**
 * Where the file viewer loads an environment image from.
 *
 * When the backend offers a content origin this renderer can reach, the image
 * is served from a short-lived, range-capable stream capability
 * (`transcript_media_open_stream`): the bytes never cross the command channel
 * as base64. The capability is revoked by `release()`. Anything the stream
 * does not serve (SVG and other non-raster types, an older backend, no
 * reachable origin, any refusal) falls back to the bounded base64 read, which
 * reports the reader's own error exactly as before.
 */
import { backendForScope, type ScopeBackend } from "@/lib/backend/scope-backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import { readTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { mediaStreamingAvailable } from "@/lib/chat/media-presentation";

export interface EnvironmentImageTarget {
  environmentId?: string;
  containerId?: string;
  isLocalEnvironment?: boolean;
  worktreePath?: string;
  /** Worktree- or workspace-relative path. */
  filePath: string;
  /** Declared from the extension; used for the base64 data URL. */
  mimeType: string;
}

export interface EnvironmentImageSource {
  url: string;
  source: "stream" | "inline";
  /** Revokes a stream capability; a no-op for inline bytes. Safe to call twice. */
  release: () => void;
}

const NO_RELEASE = () => undefined;

async function streamingReachable(scope: NodeScope): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const capabilities = await readTranscriptArtifactCapabilities(scope);
    return mediaStreamingAvailable(capabilities?.contentOrigin, window.location);
  } catch {
    return false;
  }
}

async function openStream(
  scope: NodeScope,
  target: EnvironmentImageTarget,
  local: boolean,
): Promise<EnvironmentImageSource | null> {
  if (!target.environmentId || !(await streamingReachable(scope))) return null;
  const node = backendForScope(scope);
  let stream: Awaited<ReturnType<ScopeBackend["openTranscriptMediaStream"]>>;
  try {
    stream = await node.openTranscriptMediaStream({
      environmentId: target.environmentId,
      path: target.filePath,
      ...(!local && target.containerId ? { containerId: target.containerId } : {}),
    });
  } catch {
    return null;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    void node.closeTranscriptMediaStream({ streamId: stream.streamId }).catch(() => undefined);
  };
  if (!stream?.url || !stream.mimeType?.startsWith("image/")) {
    if (stream?.streamId) release();
    return null;
  }
  return { url: stream.url, source: "stream", release };
}

/** Validate fetch and decode before handing a stream to either viewer. */
async function imageLoads(url: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (loaded: boolean) => {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener("abort", abort);
      if (!loaded) image.removeAttribute("src");
      resolve(loaded);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), 10_000);
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    signal?.addEventListener("abort", abort, { once: true });
    image.src = url;
  });
}

/** Resolves the image, preferring a stream capability; rejects as the base64 reader does. */
export async function loadEnvironmentImage(
  target: EnvironmentImageTarget,
  signal?: AbortSignal,
  /** The environment's node (plan item 4007); the app's command scope when omitted. */
  scope: NodeScope = appCommandScope(),
): Promise<EnvironmentImageSource> {
  const local = Boolean(target.isLocalEnvironment && target.worktreePath);
  if (local && !target.environmentId) throw new Error("The image has no owning environment");
  if (!local && !target.containerId) throw new Error("The image has no owning environment");
  const streamed = await openStream(scope, target, local);
  if (streamed) {
    if (await imageLoads(streamed.url, signal)) return streamed;
    streamed.release();
  }
  signal?.throwIfAborted();
  const node = backendForScope(scope);
  const base64 = local
    ? await node.readEnvironmentFileBase64(target.environmentId!, target.filePath)
    : await node.readContainerFileBase64(target.containerId!, target.filePath);
  return { url: `data:${target.mimeType};base64,${base64}`, source: "inline", release: NO_RELEASE };
}
