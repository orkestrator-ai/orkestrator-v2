/**
 * On-demand loading of immutable annotation records: image assets (turned
 * into object URLs, revoked on cache eviction) and capture metadata. Lists
 * never wait for these; a thread asks for them when shown.
 */
import {
  WEB_ANNOTATION_COMMANDS,
  type WebAnnotationCapture,
} from "@orkestrator/protocol/web-annotations";
import { getWebAnnotationCache, useWebAnnotationStore } from "@/stores/webAnnotationStore";
import { describeWebAnnotationError, webAnnotationCommand } from "./client";

const inflight = new Map<string, Promise<unknown>>();

function toObjectUrl(base64: string, mediaType: string): string {
  const dataUrl = `data:${mediaType};base64,${base64}`;
  if (typeof URL.createObjectURL !== "function" || typeof atob !== "function") return dataUrl;
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  } catch {
    return dataUrl;
  }
}

function missing(message: string) {
  return /not found|no such|missing|does not exist|deleted|expired/i.test(message);
}

export function loadWebAnnotationAsset(environmentId: string, assetId: string): Promise<unknown> {
  const existing = getWebAnnotationCache(environmentId).assets.get(assetId);
  const store = useWebAnnotationStore.getState();
  if (existing && (existing.status === "ready" || existing.status === "missing")) {
    store.setAsset(environmentId, assetId, { ...existing, usedAt: Date.now() });
    return Promise.resolve();
  }
  const key = `${environmentId}\0asset\0${assetId}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  store.setAsset(environmentId, assetId, {
    url: null,
    status: "loading",
    error: null,
    usedAt: Date.now(),
  });
  const promise = webAnnotationCommand(WEB_ANNOTATION_COMMANDS.assetGet, { environmentId, assetId })
    .then((result) => {
      if (!result || typeof result.data !== "string" || !result.data) {
        throw new Error("Image not found");
      }
      useWebAnnotationStore.getState().setAsset(environmentId, assetId, {
        url: toObjectUrl(result.data, result.asset?.mediaType ?? "image/png"),
        status: "ready",
        error: null,
        usedAt: Date.now(),
        ...(typeof result.asset?.bytes === "number" ? { bytes: result.asset.bytes } : {}),
      });
    })
    .catch((error: unknown) => {
      const message = describeWebAnnotationError(error);
      useWebAnnotationStore.getState().setAsset(environmentId, assetId, {
        url: null,
        status: missing(message) ? "missing" : "error",
        error: message,
        usedAt: Date.now(),
      });
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Retry an asset that failed for a transport reason. */
export function retryWebAnnotationAsset(environmentId: string, assetId: string) {
  useWebAnnotationStore.getState().update(environmentId, (cache) => {
    const assets = new Map(cache.assets);
    assets.delete(assetId);
    return { assets };
  });
  return loadWebAnnotationAsset(environmentId, assetId);
}

export function loadWebAnnotationCapture(
  environmentId: string,
  captureId: string,
): Promise<WebAnnotationCapture | null> {
  const cached = getWebAnnotationCache(environmentId).captures.get(captureId);
  if (cached) return Promise.resolve(cached);
  const key = `${environmentId}\0capture\0${captureId}`;
  const pending = inflight.get(key) as Promise<WebAnnotationCapture | null> | undefined;
  if (pending) return pending;
  const promise = webAnnotationCommand(WEB_ANNOTATION_COMMANDS.capture, {
    environmentId,
    captureId,
  })
    .then((result) => {
      if (!result?.capture) return null;
      useWebAnnotationStore.getState().installCapture(environmentId, result.capture);
      return result.capture;
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function resetWebAnnotationAssetsForTests() {
  inflight.clear();
}
