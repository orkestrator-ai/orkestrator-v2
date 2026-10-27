/**
 * One place that clears protected rich-transcript content.
 *
 * Rendered rich content (highlight tokens, sanitized diagrams, artifact
 * publications and representations, view state, search projections) is
 * derived from a particular authenticated backend's data. It must not outlive
 * the credentials or the backend it came from, and a deleted conversation or
 * environment must not leave its derived content behind.
 *
 * Caches that hold such content register here (`registerProtectedRichCache`)
 * instead of being imported, so this module has no dependency on transport,
 * hooks or stores that might import it back (logout and connection code in
 * `lib/native` call it directly).
 *
 * Triggers (see docs/architecture/rich-transcripts.md):
 *  - `clearProtectedRichContent("logout" | "credentials" | "connection" |
 *    "gateway-replaced" | "backend-identity")`: everything;
 *  - `noteRichContentConnection(id)`: a desktop connection switch;
 *  - `noteRichBackendIdentity(id)`: the authenticated backend identity
 *    changed under the same window;
 *  - `clearRichEnvironmentContent(id)`: an environment was deleted;
 *  - `clearRichConversationContent(scope)`: a conversation was deleted or
 *    its permission revoked, as established by authoritative artifact reads
 *    (`revokeArtifactConversation` in `artifact-requests.ts`, called by the
 *    publication ledger hook and by scoped artifact reads).
 *
 * Counters are content-free.
 */
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import { richScopePrefixes, type RichTranscriptScope } from "@/lib/chat/rich-identity";
import { clearRichViewEnvironment, useRichContentViewStore } from "@/stores/richContentViewStore";

export type RichConversationScope = Pick<
  RichTranscriptScope,
  "backendId" | "environmentId" | "logicalSessionKey"
>;

export interface ProtectedRichCache {
  /** Drop everything. */
  clearAll: (reason: ProtectedRichClearReason) => void;
  /** Drop entries belonging to one environment. */
  clearEnvironment?: (environmentId: string) => void;
  /** Drop entries belonging to one conversation. */
  clearConversation?: (scope: RichConversationScope) => void;
}

export type ProtectedRichClearReason =
  "logout" | "credentials" | "connection" | "gateway-replaced" | "backend-identity";

const registered = new Map<string, ProtectedRichCache>();

export const richContentResetCounters = {
  all: 0,
  environment: 0,
  conversation: 0,
};

/** Register a cache of protected content; returns an unregister function. */
export function registerProtectedRichCache(name: string, cache: ProtectedRichCache): () => void {
  registered.set(name, cache);
  return () => {
    if (registered.get(name) === cache) registered.delete(name);
  };
}

export function registeredProtectedRichCaches(): string[] {
  return Array.from(registered.keys());
}

function each(run: (cache: ProtectedRichCache) => void): void {
  for (const cache of Array.from(registered.values())) {
    try {
      run(cache);
    } catch {
      // One cache failing to clear must not keep the others populated.
    }
  }
}

/** Parse an encoded `encodeRichKey` tuple; null for anything else. */
export function decodeRichKey(key: string): unknown[] | null {
  if (!key.startsWith("[")) return null;
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Clear every protected rich cache: logout, re-authentication with different
 * credentials, connection replacement or a changed backend identity.
 */
export function clearProtectedRichContent(reason: ProtectedRichClearReason): void {
  richContentResetCounters.all++;
  richRenderScheduler.clear();
  useRichContentViewStore.getState().reset();
  each((cache) => cache.clearAll(reason));
}

/** An environment was deleted: drop its view state and derived content. */
export function clearRichEnvironmentContent(environmentId: string): void {
  richContentResetCounters.environment++;
  clearRichViewEnvironment(environmentId);
  // Scheduler cache keys carry the scope after the kind: ["cache", kind, backend, env, session, …].
  richRenderScheduler.clearMatching((key) => decodeRichKey(key)?.[3] === environmentId);
  each((cache) => cache.clearEnvironment?.(environmentId));
}

/** A conversation was deleted or access to it revoked. */
export function clearRichConversationContent(scope: RichConversationScope): void {
  richContentResetCounters.conversation++;
  useRichContentViewStore.getState().clearPrefixes(richScopePrefixes(scope));
  richRenderScheduler.clearMatching((key) => {
    const parts = decodeRichKey(key);
    return (
      parts !== null &&
      parts[2] === scope.backendId &&
      parts[3] === scope.environmentId &&
      parts[4] === scope.logicalSessionKey
    );
  });
  each((cache) => cache.clearConversation?.(scope));
}

let lastConnection: string | null | undefined;

/**
 * Record the active desktop connection. A change from a previously known
 * connection replaces the backend this window talks to, so protected content
 * is cleared; the first report only records the value.
 */
export function noteRichContentConnection(connectionId: string | null): void {
  if (lastConnection !== undefined && lastConnection !== connectionId) {
    clearProtectedRichContent("connection");
  }
  lastConnection = connectionId;
}

let lastBackendIdentity: string | undefined;

/**
 * Record the authenticated backend identity (from the capabilities read). A
 * different identity than the one content was derived from clears it.
 */
export function noteRichBackendIdentity(backendId: string): void {
  if (lastBackendIdentity !== undefined && lastBackendIdentity !== backendId) {
    clearProtectedRichContent("backend-identity");
  }
  lastBackendIdentity = backendId;
}

/** Tests: forget the recorded connection and backend identity. */
export function resetRichContentResetTracking(): void {
  lastConnection = undefined;
  lastBackendIdentity = undefined;
  richContentResetCounters.all = 0;
  richContentResetCounters.environment = 0;
  richContentResetCounters.conversation = 0;
}
