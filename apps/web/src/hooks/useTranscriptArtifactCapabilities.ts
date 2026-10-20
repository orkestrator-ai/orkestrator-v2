import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { TranscriptArtifactCapabilities } from "@orkestrator/protocol/transcript-artifact-commands";
import { getTranscriptArtifactCapabilities } from "@/lib/backend/transcript-artifacts";
import type { RichTranscriptScope } from "@/lib/chat/rich-identity";
import { noteRichBackendIdentity, registerProtectedRichCache } from "@/lib/chat/rich-content-reset";

/**
 * The authenticated backend's artifact capabilities, read once per renderer
 * connection. `backendId` here is the only source of backend identity for
 * rich content: it comes from the authenticated connection, never from an
 * artifact or a model.
 */
let snapshot: TranscriptArtifactCapabilities | null = null;
let inflight: Promise<void> | null = null;
let failedAt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
const RETRY_DELAYS = [10_000, 20_000, 40_000, 60_000];
function cancelRetry() {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}
function scheduleRetry() {
  if (snapshot || !failedAt || retryTimer !== null || listeners.size === 0) return;
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      load();
    },
    Math.max(
      0,
      failedAt +
        RETRY_DELAYS[Math.min(Math.max(failures - 1, 0), RETRY_DELAYS.length - 1)]! -
        Date.now(),
    ),
  );
}
/** Bumped by a reset so a read issued under the previous credentials is discarded. */
let readGeneration = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of Array.from(listeners)) listener();
}

function load(): void {
  if (snapshot || inflight) return;
  if (
    failedAt &&
    Date.now() - failedAt <
      RETRY_DELAYS[Math.min(Math.max(failures - 1, 0), RETRY_DELAYS.length - 1)]!
  ) {
    scheduleRetry();
    return;
  }
  const generation = readGeneration;
  // Promise.resolve: a backend shim that answers synchronously must not break rendering.
  const request: Promise<void> = Promise.resolve()
    .then(() => getTranscriptArtifactCapabilities())
    .then((value) => {
      if (generation !== readGeneration) return;
      const next = value && typeof value.backendId === "string" ? value : null;
      // A different authenticated backend than the one content was derived
      // from: clear protected rich content before exposing the new identity.
      if (next) noteRichBackendIdentity(next.backendId);
      snapshot = next;
      if (next) {
        failures = 0;
        failedAt = 0;
        cancelRetry();
      } else {
        failedAt = Date.now();
        failures++;
      }
    })
    .catch(() => {
      if (generation === readGeneration) {
        failedAt = Date.now();
        failures++;
      }
    })
    .finally(() => {
      if (inflight === request) inflight = null;
      if (generation === readGeneration) {
        emit();
        scheduleRetry();
      }
    });
  inflight = request;
}

/**
 * Rollout switch for the rich Markdown pipeline. Defaults on until the
 * backend says otherwise; when off, text renders through the plain Markdown
 * path and find indexes it the same way. Stored content is unaffected.
 */
export function richMarkdownEnabled(): boolean {
  return snapshot?.rolloutFlags?.richMarkdown !== false;
}

/** Forget the cached identity (connection replaced, logout). */
export function resetTranscriptArtifactCapabilities(): void {
  readGeneration++;
  cancelRetry();
  failures = 0;
  snapshot = null;
  inflight = null;
  failedAt = 0;
  emit();
}

/**
 * Re-read capabilities without forgetting the identity (after a backend-side
 * change such as preparing the isolated preview worker).
 */
export function refreshTranscriptArtifactCapabilities(): Promise<void> {
  const generation = readGeneration;
  return Promise.resolve()
    .then(() => getTranscriptArtifactCapabilities())
    .then((value) => {
      if (generation !== readGeneration || !value || typeof value.backendId !== "string") return;
      noteRichBackendIdentity(value.backendId);
      snapshot = value;
      emit();
    })
    .catch(() => undefined);
}

// Logout, re-authentication and connection replacement forget the identity;
// mounted transcripts read it again under the new credentials.
registerProtectedRichCache("transcript-artifact-capabilities", {
  clearAll: (reason) => {
    // The new identity itself triggered this clear; keep it.
    if (reason === "backend-identity") return;
    resetTranscriptArtifactCapabilities();
    if (listeners.size > 0) load();
  },
});

export function useTranscriptArtifactCapabilities(): TranscriptArtifactCapabilities | null {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      scheduleRetry();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) cancelRetry();
      };
    },
    () => snapshot,
    () => snapshot,
  );
  useEffect(() => {
    load();
  }, []);
  return value;
}

export function useRichTranscriptScopeValue(
  environmentId: string,
  logicalSessionKey: string,
  generation: string,
): RichTranscriptScope {
  const capabilities = useTranscriptArtifactCapabilities();
  const backendId = capabilities?.backendId ?? null;
  return useMemo(
    () => ({ backendId, environmentId, logicalSessionKey, generation }),
    [backendId, environmentId, generation, logicalSessionKey],
  );
}
