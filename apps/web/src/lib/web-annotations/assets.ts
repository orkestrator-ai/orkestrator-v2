/**
 * On-demand loading of immutable annotation records: image assets (turned
 * into object URLs, revoked on cache eviction) and capture metadata. Lists
 * never wait for these; a thread asks for them when shown.
 *
 * Per node (plan item 3012): the reads in flight are the scope's, the records
 * land in the scope's `webAnnotationStore` and are read from its node. Every
 * export takes an optional trailing `scope`, the app's command scope when
 * omitted.
 */
import {
  WEB_ANNOTATION_COMMANDS,
  type WebAnnotationCapture,
} from "@orkestrator/protocol/web-annotations";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import { getWebAnnotationCache, webAnnotationStore } from "@/stores/webAnnotationStore";
import { describeWebAnnotationError, webAnnotationCommand } from "./client";

/** One node's record reads in flight, by environment, kind and id. */
const inflightReads = defineScopedSlot(
  "web-annotation-asset-reads",
  () => new Map<string, Promise<unknown>>(),
);

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

export function loadWebAnnotationAsset(
  environmentId: string,
  assetId: string,
  scope: NodeScope = appCommandScope(),
): Promise<unknown> {
  const existing = getWebAnnotationCache(environmentId, scope).assets.get(assetId);
  // Held across the read: the scope may be disposed before it answers.
  const annotations = scope.store(webAnnotationStore);
  const inflight = inflightReads(scope);
  const store = annotations.getState();
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
  const promise = webAnnotationCommand(
    WEB_ANNOTATION_COMMANDS.assetGet,
    { environmentId, assetId },
    undefined,
    scope,
  )
    .then((result) => {
      if (!result || typeof result.data !== "string" || !result.data) {
        throw new Error("Image not found");
      }
      if (scope.disposed) return;
      annotations.getState().setAsset(environmentId, assetId, {
        url: toObjectUrl(result.data, result.asset?.mediaType ?? "image/png"),
        status: "ready",
        error: null,
        usedAt: Date.now(),
        ...(typeof result.asset?.bytes === "number" ? { bytes: result.asset.bytes } : {}),
      });
    })
    .catch((error: unknown) => {
      if (scope.disposed) return;
      const message = describeWebAnnotationError(error);
      annotations.getState().setAsset(environmentId, assetId, {
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
export function retryWebAnnotationAsset(
  environmentId: string,
  assetId: string,
  scope: NodeScope = appCommandScope(),
) {
  scope
    .store(webAnnotationStore)
    .getState()
    .update(environmentId, (cache) => {
      const assets = new Map(cache.assets);
      assets.delete(assetId);
      return { assets };
    });
  return loadWebAnnotationAsset(environmentId, assetId, scope);
}

export function loadWebAnnotationCapture(
  environmentId: string,
  captureId: string,
  scope: NodeScope = appCommandScope(),
): Promise<WebAnnotationCapture | null> {
  const cached = getWebAnnotationCache(environmentId, scope).captures.get(captureId);
  if (cached) return Promise.resolve(cached);
  const annotations = scope.store(webAnnotationStore);
  const inflight = inflightReads(scope);
  const key = `${environmentId}\0capture\0${captureId}`;
  const pending = inflight.get(key) as Promise<WebAnnotationCapture | null> | undefined;
  if (pending) return pending;
  const promise = webAnnotationCommand(
    WEB_ANNOTATION_COMMANDS.capture,
    { environmentId, captureId },
    undefined,
    scope,
  )
    .then((result) => {
      if (!result?.capture) return null;
      if (!scope.disposed) annotations.getState().installCapture(environmentId, result.capture);
      return result.capture;
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function resetWebAnnotationAssetsForTests(scope: NodeScope = appCommandScope()) {
  inflightReads(scope).clear();
}
