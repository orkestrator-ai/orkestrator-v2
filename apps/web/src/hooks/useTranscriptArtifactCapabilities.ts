import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { TranscriptArtifactCapabilities } from "@orkestrator/protocol/transcript-artifact-commands";
import { isProvisionalBackendId, type BackendId } from "@orkestrator/protocol/federation";
import { backendApiForScope } from "@/lib/backend/client";
import {
  createTranscriptArtifactsApi,
  getTranscriptArtifactCapabilities,
} from "@/lib/backend/transcript-artifacts";
import type { RichTranscriptScope } from "@/lib/chat/rich-identity";
import {
  noteRichBackendIdentity,
  registerProtectedRichCache,
  type ProtectedRichClearReason,
} from "@/lib/chat/rich-content-reset";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { defineScopedSlot } from "@/lib/node-scope-slots";

const RETRY_DELAYS = [10_000, 20_000, 40_000, 60_000];

/** `scope`'s node's answer (the command-bound read on the command scope, which suites mock). */
function readCapabilities(scope: NodeScope): Promise<TranscriptArtifactCapabilities> {
  return backendApiForScope(scope, createTranscriptArtifactsApi, {
    getTranscriptArtifactCapabilities,
  }).getTranscriptArtifactCapabilities();
}

const retryDelay = (failures: number) =>
  RETRY_DELAYS[Math.min(Math.max(failures - 1, 0), RETRY_DELAYS.length - 1)]!;

/**
 * One node's artifact capabilities, read once per connection and held on
 * that node's scope (plan item 3016), so two live nodes each keep their own
 * answer and identity. `backendId` here is the only source of backend
 * identity for rich content: it comes from the authenticated connection,
 * never from an artifact or a model.
 */
class TranscriptCapabilities {
  snapshot: TranscriptArtifactCapabilities | null = null;
  readonly listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;
  private failedAt = 0;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by a reset so a read issued under the previous credentials is discarded. */
  private readGeneration = 0;
  private disposed = false;

  constructor(readonly scope: NodeScope) {}

  /** The scope ended: stop the retry and answer nothing more. */
  dispose(): void {
    this.disposed = true;
    this.readGeneration++;
    this.cancelRetry();
    this.listeners.clear();
  }

  emit(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }

  cancelRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  scheduleRetry(): void {
    if (
      this.disposed ||
      this.snapshot ||
      !this.failedAt ||
      this.retryTimer !== null ||
      this.listeners.size === 0
    ) {
      return;
    }
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.load();
      },
      Math.max(0, this.failedAt + retryDelay(this.failures) - Date.now()),
    );
  }

  load(): void {
    if (this.disposed || this.snapshot || this.inflight) return;
    if (this.failedAt && Date.now() - this.failedAt < retryDelay(this.failures)) {
      this.scheduleRetry();
      return;
    }
    const generation = this.readGeneration;
    // Promise.resolve: a backend shim that answers synchronously must not break rendering.
    const request: Promise<void> = Promise.resolve()
      .then(() => readCapabilities(this.scope))
      .then((value) => {
        if (generation !== this.readGeneration) return;
        const next = value && typeof value.backendId === "string" ? value : null;
        // A different authenticated backend than the one content was derived
        // from: clear protected rich content before exposing the new identity.
        if (next) noteRichBackendIdentity(next.backendId, this.scope);
        this.snapshot = next;
        if (next) {
          this.failures = 0;
          this.failedAt = 0;
          this.cancelRetry();
        } else {
          this.failedAt = Date.now();
          this.failures++;
        }
      })
      .catch(() => {
        if (generation === this.readGeneration) {
          this.failedAt = Date.now();
          this.failures++;
        }
      })
      .finally(() => {
        if (this.inflight === request) this.inflight = null;
        if (generation === this.readGeneration) {
          this.emit();
          this.scheduleRetry();
        }
      });
    this.inflight = request;
  }

  async read(): Promise<TranscriptArtifactCapabilities | null> {
    if (!this.snapshot) {
      this.load();
      await this.inflight;
    }
    return this.snapshot;
  }

  reset(): void {
    this.readGeneration++;
    this.cancelRetry();
    this.failures = 0;
    this.snapshot = null;
    this.inflight = null;
    this.failedAt = 0;
    this.emit();
  }

  refresh(): Promise<void> {
    const generation = this.readGeneration;
    return Promise.resolve()
      .then(() => readCapabilities(this.scope))
      .then((value) => {
        if (generation !== this.readGeneration || !value || typeof value.backendId !== "string") {
          return;
        }
        noteRichBackendIdentity(value.backendId, this.scope);
        this.snapshot = value;
        this.emit();
      })
      .catch(() => undefined);
  }

  /** A protected-content clear: forget the identity and read it again for mounted readers. */
  forget(reason: ProtectedRichClearReason): void {
    // The new identity itself triggered this clear; keep it.
    if (reason === "backend-identity" || this.disposed) return;
    this.reset();
    if (this.listeners.size > 0) this.load();
  }

  /**
   * Whether a clear of `nodeId` covers this answer: it came from that node,
   * the scope is that node, or the scope has no proven id and no answer yet
   * (it may be that node's).
   */
  servedBy(nodeId: string): boolean {
    if (this.snapshot) return this.snapshot.backendId === nodeId || this.scope.nodeId === nodeId;
    return this.scope.nodeId === nodeId || isProvisionalBackendId(this.scope.nodeId as BackendId);
  }
}

/** Every open scope's capabilities, so the protected-content clears reach them all. */
const openCapabilities = new Set<TranscriptCapabilities>();

const scopeCapabilities = defineScopedSlot("transcript-artifact-capabilities", (scope) => {
  const capabilities = new TranscriptCapabilities(scope);
  openCapabilities.add(capabilities);
  scope.onDispose("transcript-artifact-capabilities", () => {
    openCapabilities.delete(capabilities);
    capabilities.dispose();
  });
  return capabilities;
});

/**
 * The capability snapshot for code outside React (default: the command
 * node's): the cached one, or the result of loading it once (null when the
 * backend has none or the read failed).
 */
export function readTranscriptArtifactCapabilities(
  scope?: NodeScope,
): Promise<TranscriptArtifactCapabilities | null> {
  return scopeCapabilities(scope).read();
}

/**
 * Rollout switch for the rich Markdown pipeline. Defaults on until the
 * backend says otherwise; when off, text renders through the plain Markdown
 * path and find indexes it the same way. Stored content is unaffected.
 */
export function richMarkdownEnabled(scope?: NodeScope): boolean {
  return scopeCapabilities(scope).snapshot?.rolloutFlags?.richMarkdown !== false;
}

/** Forget the cached identity (connection replaced, logout); default the command node's. */
export function resetTranscriptArtifactCapabilities(scope?: NodeScope): void {
  scopeCapabilities(scope).reset();
}

/**
 * Re-read capabilities without forgetting the identity (after a backend-side
 * change such as preparing the isolated preview worker).
 */
export function refreshTranscriptArtifactCapabilities(scope?: NodeScope): Promise<void> {
  return scopeCapabilities(scope).refresh();
}

// Logout, re-authentication and connection replacement forget the identity;
// mounted transcripts read it again under the new credentials. A clear of one
// node forgets only the answers that node served.
registerProtectedRichCache("transcript-artifact-capabilities", {
  clearAll: (reason) => {
    for (const capabilities of Array.from(openCapabilities)) capabilities.forget(reason);
  },
  clearBackend: (nodeId, reason) => {
    for (const capabilities of Array.from(openCapabilities)) {
      if (capabilities.servedBy(nodeId)) capabilities.forget(reason);
    }
  },
});

/** The capabilities of the nearest node scope (the command scope outside a provider). */
export function useTranscriptArtifactCapabilities(): TranscriptArtifactCapabilities | null {
  const { scope } = useScopesWithCommandFallback();
  const capabilities = scopeCapabilities(scope);
  const subscribe = useCallback(
    (listener: () => void) => {
      capabilities.listeners.add(listener);
      capabilities.scheduleRetry();
      return () => {
        capabilities.listeners.delete(listener);
        if (capabilities.listeners.size === 0) capabilities.cancelRetry();
      };
    },
    [capabilities],
  );
  const read = useCallback(() => capabilities.snapshot, [capabilities]);
  const value = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    capabilities.load();
  }, [capabilities]);
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
