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
 *  - `noteRichContentConnection(id, scope?)`: a desktop connection switch,
 *    recorded on that node scope (default: the command scope, whose change
 *    clears everything; any other scope clears only its node);
 *  - `noteRichBackendIdentity(id, scope?)`: the authenticated backend
 *    identity changed under the same node scope, recorded the same way;
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
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
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
   * `nodeId` (a node's id is its backend identity) and those a node-keyed
   * cache holds under `nodeId`. Called once for each id the node is known by
   * (its scope's node id and the identity it reported). A cache without it is
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
  const ids = nodeAliases(nodeId);
  // Scheduler cache keys carry the scope after the kind: ["cache", kind, backend, env, session, …].
  richRenderScheduler.clearMatching((key) => ids.includes(decodeRichKey(key)?.[2] as string));
  useRichContentViewStore.getState().clearPrefixes(ids.flatMap(richBackendPrefixes));
  each((cache) => {
    if (!cache.clearBackend) {
      cache.clearAll(reason);
      return;
    }
    for (const id of ids) cache.clearBackend(id, reason);
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

/**
 * What one node scope last reported about where its content comes from. Held
 * on the scope (plan item 3016), so a second live node never overwrites the
 * first one's notes and a disposed scope's notes go with it.
 */
interface RichContentNotes {
  readonly scope: NodeScope;
  /** `undefined` until the first report. */
  connection: string | null | undefined;
  identity: string | undefined;
}

/** The notes of every open scope, for resolving which ids name one node. */
const openNotes = new Set<RichContentNotes>();

const richContentNotes = defineScopedSlot<RichContentNotes>("rich-content-notes", (scope) => {
  const notes: RichContentNotes = { scope, connection: undefined, identity: undefined };
  openNotes.add(notes);
  scope.onDispose("rich-content-notes", () => openNotes.delete(notes));
  return notes;
});

/**
 * Every id content of the node `nodeId` may be keyed by: a scope's own node
 * id and the authenticated identity it reported differ while the command
 * scope still runs under a provisional id (a hosted page before plan item
 * 2011), and render keys carry the identity while byte caches carry the
 * scope's id.
 */
function nodeAliases(nodeId: string): string[] {
  const ids = new Set([nodeId]);
  for (const notes of openNotes) {
    if (notes.scope.disposed) continue;
    if (notes.identity === nodeId) ids.add(notes.scope.nodeId);
    if (notes.scope.nodeId === nodeId && notes.identity !== undefined) ids.add(notes.identity);
  }
  return Array.from(ids);
}

/**
 * A note on `scope` saw its source change. The command scope is the window's
 * own connection, through which everything the window shows came (relayed
 * leaves included), so it clears everything, as before; another node's
 * scope clears only that node's content.
 */
function clearForNote(reason: ProtectedRichClearReason, scope: NodeScope, nodeId: string): void {
  if (scope.role === "command") clearProtectedRichContent(reason);
  else clearProtectedRichContent(reason, { nodeId });
}

/**
 * Record `scope`'s active desktop connection (default: the app's command
 * scope). A change from a previously known connection replaces the backend
 * that scope talks to, so its protected content is cleared. The first report
 * only records the value, and one scope's report never touches another's.
 */
export function noteRichContentConnection(connectionId: string | null, scope?: NodeScope): void {
  const target = scope ?? appCommandScope();
  const notes = richContentNotes(target);
  const previous = notes.connection;
  notes.connection = connectionId;
  if (previous !== undefined && previous !== connectionId) {
    clearForNote("connection", target, target.nodeId);
  }
}

/**
 * Record the authenticated backend identity `scope` answered with (from the
 * capabilities read; default: the app's command scope). A different identity
 * than the one content was derived from clears it: everything for the
 * command scope, and for another scope the content keyed by the identity it
 * replaced or by the scope's node, so other live nodes keep theirs.
 */
export function noteRichBackendIdentity(backendId: string, scope?: NodeScope): void {
  const target = scope ?? appCommandScope();
  const notes = richContentNotes(target);
  const previous = notes.identity;
  if (previous !== undefined && previous !== backendId) {
    // Resolved while the old identity is still recorded, so its aliases
    // (the scope's own node id) are cleared with it.
    clearForNote("backend-identity", target, previous);
  }
  notes.identity = backendId;
}

/** The identity `scope` last reported (default: the app's command scope). */
export function richBackendIdentityOf(scope?: NodeScope): string | undefined {
  return richContentNotes(scope ?? appCommandScope()).identity;
}

/** Tests: forget every open scope's notes and reset the counters. */
export function resetRichContentResetTracking(): void {
  for (const notes of openNotes) {
    notes.connection = undefined;
    notes.identity = undefined;
  }
  richContentResetCounters.all = 0;
  richContentResetCounters.node = 0;
  richContentResetCounters.environment = 0;
  richContentResetCounters.conversation = 0;
}
