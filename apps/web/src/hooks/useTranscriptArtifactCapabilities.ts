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
/** Bumped by a reset so a read issued under the previous credentials is discarded. */
let readGeneration = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of Array.from(listeners)) listener();
}

function load(): void {
  if (snapshot || inflight || Date.now() - failedAt < 10_000) return;
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
    })
    .catch(() => {
      if (generation === readGeneration) failedAt = Date.now();
    })
    .finally(() => {
      if (inflight === request) inflight = null;
      emit();
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
      return () => listeners.delete(listener);
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
