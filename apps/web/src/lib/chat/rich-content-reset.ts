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
 *  - `clearProtectedRichContent(reason, { nodeId })`: only what was derived
 *    from that node (a node transport's credential changed, its connection or
 *    identity moved), so several live nodes do not clear each other's content
 *    (docs/reports/unified-federation.md §7.4);
 *  - `noteRichContentConnection(id, { nodeId? })`: a desktop connection
 *    switch, tracked per node;
 *  - `noteRichBackendIdentity(id, { nodeId? })`: the authenticated backend
 *    identity changed under the same window or node, tracked per node;
 *  - `clearRichEnvironmentContent(id)`: an environment was deleted;
 *  - `clearRichConversationContent(scope)`: a conversation was deleted or
 *    its permission revoked, as established by authoritative artifact reads
 *    (`revokeArtifactConversation` in `artifact-requests.ts`, called by the
 *    publication ledger hook and by scoped artifact reads).
 *
 * Counters are content-free.
 */
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import {
  richBackendPrefixes,
  richScopePrefixes,
  type RichTranscriptScope,
} from "@/lib/chat/rich-identity";
import { clearRichViewEnvironment, useRichContentViewStore } from "@/stores/richContentViewStore";

export type RichConversationScope = Pick<
  RichTranscriptScope,
  "backendId" | "environmentId" | "logicalSessionKey"
>;

export interface ProtectedRichCache {
  /** Drop everything. */
  clearAll: (reason: ProtectedRichClearReason) => void;
  /**
   * Drop entries derived from one node: those whose scope's `backendId` is
   * `nodeId` (a node's id is its backend identity). A cache without it is
   * cleared entirely by a node clear, which over-clears but never leaks.
   */
  clearBackend?: (nodeId: string, reason: ProtectedRichClearReason) => void;
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
  node: 0,
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

/** Which protected content a clear covers. */
export interface ProtectedRichClearScope {
  /**
   * Only content derived from this node (its backend identity, the scope's
   * `backendId`). Without one, everything.
   */
  nodeId?: string;
}

/**
 * Clear protected rich content. Without a `nodeId`, every cache: logout,
 * re-authentication of the window's own connection, connection replacement or
 * a changed backend identity. With one, only what was derived from that node,
 * so other live nodes keep theirs.
 */
export function clearProtectedRichContent(
  reason: ProtectedRichClearReason,
  scope: ProtectedRichClearScope = {},
): void {
  const nodeId = scope.nodeId;
  if (nodeId === undefined) {
    richContentResetCounters.all++;
    richRenderScheduler.clear();
    useRichContentViewStore.getState().reset();
    each((cache) => cache.clearAll(reason));
    return;
  }
  richContentResetCounters.node++;
  // Scheduler cache keys carry the scope after the kind: ["cache", kind, backend, env, session, …].
  richRenderScheduler.clearMatching((key) => decodeRichKey(key)?.[2] === nodeId);
  useRichContentViewStore.getState().clearPrefixes(richBackendPrefixes(nodeId));
  each((cache) => {
    if (cache.clearBackend) cache.clearBackend(nodeId, reason);
    else cache.clearAll(reason);
  });
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

/** The tracking slot of a caller that names no node: the window's own connection. */
const WINDOW_SLOT = "\u0000window";

/** Per node (or the window slot): the last connection reported. */
const lastConnections = new Map<string, string | null>();

/** Which node a note is about. Without one, the window's own connection. */
export interface RichContentNoteScope {
  nodeId?: string;
}

/**
 * Record the active desktop connection, per node. A change from a previously
 * known connection replaces the backend this window (or that node's scope)
 * talks to, so its protected content is cleared: everything for the window
 * slot, only that node's for a named one. The first report only records the
 * value, and one node's report never touches another's.
 */
export function noteRichContentConnection(
  connectionId: string | null,
  scope: RichContentNoteScope = {},
): void {
  const slot = scope.nodeId ?? WINDOW_SLOT;
  const previous = lastConnections.get(slot);
  lastConnections.set(slot, connectionId);
  if (previous !== undefined && previous !== connectionId) {
    clearProtectedRichContent(
      "connection",
      scope.nodeId === undefined ? {} : { nodeId: scope.nodeId },
    );
  }
}

/** Per node (or the window slot): the last authenticated backend identity. */
const lastBackendIdentities = new Map<string, string>();

/**
 * Record the authenticated backend identity (from the capabilities read), per
 * node. A different identity than the one content was derived from clears it:
 * everything for the window slot, and for a named node only the content keyed
 * by the identity it replaced, so other live nodes keep theirs.
 */
export function noteRichBackendIdentity(backendId: string, scope: RichContentNoteScope = {}): void {
  const slot = scope.nodeId ?? WINDOW_SLOT;
  const previous = lastBackendIdentities.get(slot);
  lastBackendIdentities.set(slot, backendId);
  if (previous !== undefined && previous !== backendId) {
    clearProtectedRichContent(
      "backend-identity",
      scope.nodeId === undefined ? {} : { nodeId: previous },
    );
  }
}

/** Tests: forget the recorded connections and backend identities. */
export function resetRichContentResetTracking(): void {
  lastConnections.clear();
  lastBackendIdentities.clear();
  richContentResetCounters.all = 0;
  richContentResetCounters.node = 0;
  richContentResetCounters.environment = 0;
  richContentResetCounters.conversation = 0;
}
