import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ArtifactPublicationView,
  ArtifactRepresentation,
  ArtifactRepresentationResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import type { ScopeBackend } from "@/lib/backend/scope-backend";
import { encodeRichKey, type RichTranscriptScope } from "./rich-identity";
import { NodeByteCache, richContentNodeId } from "./rich-byte-cache";
import {
  clearRichConversationContent,
  decodeRichKey,
  registerProtectedRichCache,
  type RichConversationScope,
} from "./rich-content-reset";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/**
 * Scoped, bounded reads of published artifacts for the transcript.
 *
 * - Every read names the displayed conversation (environment + session) and
 *   its scope generation. Cache keys include the generation, and a response
 *   whose generation is no longer the newest requested for that conversation
 *   is discarded: a late answer from a discarded session cannot populate the
 *   current one.
 * - Settled results are an LRU bounded by count, keyed by `(node, key)`, whose
 *   estimated bytes are reserved from the window's shared `artifacts` budget
 *   (plan item 3016), so several live nodes share one bound. The node is the
 *   one the scope's `backendId` names (`richContentNodeId`). In-flight reads
 *   are de-duplicated and counted separately. Failures are not cached.
 */

/**
 * The node an artifact is read from: the reading component's
 * `useScopeBackend()`, so a leaf's transcript reads the leaf (plan item 4007).
 */
export type ArtifactReader = Pick<
  ScopeBackend,
  "readTranscriptArtifactRepresentation" | "listTranscriptArtifactPublications"
>;

export type ArtifactReadScope = Pick<
  RichTranscriptScope,
  "backendId" | "environmentId" | "logicalSessionKey" | "generation"
>;

const MAX_ENTRIES = 64;
/** Larger single values (e.g. big captures) are served but not retained. */
const MAX_RETAINED_VALUE_BYTES = 4 * 1024 * 1024;
/** Upper bound for concatenating paged UTF-8 representations. */
export const MAX_TEXT_REPRESENTATION_BYTES = 2 * 1024 * 1024;

interface Settled {
  value: unknown;
}

const settled = new NodeByteCache<Settled>({
  name: "artifact-requests",
  budget: "artifacts",
  maxEntries: MAX_ENTRIES,
  maxEntryBytes: MAX_RETAINED_VALUE_BYTES,
});
/** Read keys are `[kind, backend, environment, session, generation, …]`. */
const readNode = (key: string): string => {
  const backendId = decodeRichKey(key)?.[1];
  return richContentNodeId(typeof backendId === "string" ? backendId : null);
};
const inflight = new Map<string, Promise<unknown>>();
const latestGeneration = new Map<string, string>();

function conversationKey(scope: ArtifactReadScope): string {
  return encodeRichKey([scope.backendId, scope.environmentId, scope.logicalSessionKey]);
}

/** Record the newest generation the UI is showing for a conversation. */
export function noteArtifactScopeGeneration(scope: ArtifactReadScope): void {
  latestGeneration.set(conversationKey(scope), scope.generation);
  if (latestGeneration.size > 256) latestGeneration.delete(latestGeneration.keys().next().value!);
}

export function isCurrentArtifactScopeGeneration(scope: ArtifactReadScope): boolean {
  const latest = latestGeneration.get(conversationKey(scope));
  return latest === undefined || latest === scope.generation;
}

function remember(key: string, value: unknown, bytes: number): void {
  settled.set(readNode(key), key, { value }, bytes);
}

function recall(key: string): Settled | undefined {
  return settled.get(readNode(key), key);
}

/**
 * Bumped whenever cached reads are cleared. A read that was in flight across
 * a clear is discarded, and mounted readers re-request under the new epoch.
 */
let cacheEpoch = 0;
const epochListeners = new Set<() => void>();

function bumpEpoch(): void {
  cacheEpoch++;
  for (const listener of Array.from(epochListeners)) listener();
}

function subscribeEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => {
    epochListeners.delete(listener);
  };
}

const readEpoch = () => cacheEpoch;

/**
 * Changes whenever cached reads are cleared. A read made outside
 * `useScopedArtifactRead` compares it across its await, so a clear (logout,
 * deletion, revocation) is never undone by a response that was in flight.
 */
export function artifactRequestEpoch(): number {
  return cacheEpoch;
}

export function clearArtifactRequestCache(): void {
  settled.clear();
  inflight.clear();
  latestGeneration.clear();
  clearSearchBodiesWhere(() => true);
  bumpEpoch();
}

/**
 * Drop cached reads whose encoded key matches. Read keys are
 * `[kind, backend, environment, session, generation, …]`; generation keys are
 * `[backend, environment, session]`.
 */
function clearArtifactRequestsWhere(
  readMatches: (parts: unknown[], nodeId: string | null) => boolean,
  generationMatches: (parts: unknown[]) => boolean,
): void {
  settled.deleteWhere((entry) => {
    const parts = decodeRichKey(entry.key);
    return parts !== null && readMatches(parts, entry.nodeId);
  });
  for (const key of Array.from(inflight.keys())) {
    const parts = decodeRichKey(key);
    if (parts && readMatches(parts, null)) inflight.delete(key);
  }
  for (const key of Array.from(latestGeneration.keys())) {
    const parts = decodeRichKey(key);
    if (parts && generationMatches(parts)) latestGeneration.delete(key);
  }
  bumpEpoch();
}

export function clearArtifactRequestsForEnvironment(environmentId: string): void {
  clearSearchBodiesWhere((scope) => scope.environmentId === environmentId);
  clearArtifactRequestsWhere(
    (parts) => parts[2] === environmentId,
    (parts) => parts[1] === environmentId,
  );
}

export function clearArtifactRequestsForConversation(scope: RichConversationScope): void {
  clearSearchBodiesWhere(
    (held) =>
      (held.backendId ?? "") === (scope.backendId ?? "") &&
      held.environmentId === scope.environmentId &&
      held.logicalSessionKey === scope.logicalSessionKey,
  );
  clearArtifactRequestsWhere(
    (parts) =>
      parts[1] === (scope.backendId ?? "") &&
      parts[2] === scope.environmentId &&
      parts[3] === scope.logicalSessionKey,
    (parts) =>
      parts[0] === scope.backendId &&
      parts[1] === scope.environmentId &&
      parts[2] === scope.logicalSessionKey,
  );
}

/**
 * A node's credential, connection or identity changed: drop what it served,
 * by the scope's `backendId` or by the node a read is accounted to.
 */
export function clearArtifactRequestsForBackend(backendId: string): void {
  clearSearchBodiesWhere((held) => (held.backendId ?? "") === backendId);
  clearArtifactRequestsWhere(
    (parts, nodeId) => parts[1] === backendId || nodeId === backendId,
    (parts) => parts[0] === backendId,
  );
}

registerProtectedRichCache("artifact-requests", {
  clearAll: clearArtifactRequestCache,
  clearBackend: clearArtifactRequestsForBackend,
  clearEnvironment: clearArtifactRequestsForEnvironment,
  clearConversation: clearArtifactRequestsForConversation,
});

/*
 * Conversation deletion and permission revocation.
 *
 * The backend answers `not_found` alike for a missing publication and for one
 * outside the caller's scope, and its ledger and draft lists answer an empty
 * list (not `not_found`) for a deleted or unknown conversation. So a single
 * failed read never proves that the whole conversation is gone. These
 * helpers decide it from authoritative reads instead:
 *
 *  - a ledger read (the conversation-level list) that fails with
 *    `not_found` or a permission-style failure (HTTP 403 or a permission
 *    error code) revokes it; listing never answers `not_found` for a missing
 *    record;
 *  - a publication or representation read failing with `not_found` or a
 *    permission-style failure re-reads the ledger
 *    (`verifyArtifactConversation`): a ledger failure as above, or an empty
 *    ledger for a conversation whose content this window had loaded, means
 *    the conversation was deleted or revoked; a readable, non-empty ledger
 *    means only that publication is unavailable;
 *  - the ledger hook treats a ledger that shrinks from published content to
 *    nothing (publications are immutable and only removed with their
 *    conversation) as a deletion; the backend's `transcript-artifact` hint
 *    for a deleted conversation triggers exactly that re-read.
 *
 * Revoking calls `clearRichConversationContent(scope)` once: the status map
 * records `revoked` until a later non-empty ledger read shows the
 * conversation again (a single publication read does not), so mounted
 * readers re-requesting after the clear cannot loop. Bounded by count;
 * content-free.
 */
const MAX_TRACKED_CONVERSATIONS = 256;
const conversationStatus = new Map<string, "seen" | "revoked">();
const verifying = new Map<string, Promise<ArtifactConversationVerification>>();

export type ArtifactConversationVerification = "available" | "revoked" | "unknown";

export const artifactConversationRevocationCounters = {
  deleted: 0,
  permission: 0,
  verifications: 0,
};

function conversationStatusKey(scope: RichConversationScope): string {
  return encodeRichKey([scope.backendId ?? "", scope.environmentId, scope.logicalSessionKey]);
}

function setConversationStatus(scope: RichConversationScope, status: "seen" | "revoked"): void {
  const key = conversationStatusKey(scope);
  conversationStatus.delete(key);
  conversationStatus.set(key, status);
  while (conversationStatus.size > MAX_TRACKED_CONVERSATIONS) {
    const oldest = conversationStatus.keys().next().value;
    if (oldest === undefined) break;
    conversationStatus.delete(oldest);
  }
}

/**
 * This window loaded protected artifact content for the conversation. Only
 * the conversation-level ledger (`source: "ledger"`) lifts a revocation; a
 * single read that still succeeds after one does not.
 */
export function noteArtifactConversationContent(
  scope: RichConversationScope,
  source: "ledger" | "read",
): void {
  if (source === "read" && artifactConversationStatus(scope) !== null) return;
  setConversationStatus(scope, "seen");
}

export function artifactConversationStatus(
  scope: RichConversationScope,
): "seen" | "revoked" | null {
  return conversationStatus.get(conversationStatusKey(scope)) ?? null;
}

const PERMISSION_ERROR_CODES = new Set([
  "unauthorized",
  "forbidden",
  "permission_denied",
  "access_denied",
]);

/** A failure that says the caller may no longer read this conversation. */
export function isArtifactPermissionError(error: unknown): boolean {
  if (error && typeof error === "object" && (error as { status?: unknown }).status === 403) {
    return true;
  }
  const code = artifactErrorInfo(error).code;
  return code !== undefined && PERMISSION_ERROR_CODES.has(code);
}

/**
 * Clear one conversation's protected rich content because it was deleted or
 * access to it was revoked. Returns false when it was already revoked (and
 * not shown again since), so repeated failures clear once.
 */
export function revokeArtifactConversation(
  scope: RichConversationScope,
  reason: "deleted" | "permission",
): boolean {
  if (artifactConversationStatus(scope) === "revoked") return false;
  setConversationStatus(scope, "revoked");
  artifactConversationRevocationCounters[reason]++;
  clearRichConversationContent({
    backendId: scope.backendId,
    environmentId: scope.environmentId,
    logicalSessionKey: scope.logicalSessionKey,
  });
  return true;
}

/**
 * A ledger read (list) failed. `not_found` from a list, or a permission
 * failure, means the conversation scope itself is gone; anything else
 * (transport, storage) proves nothing.
 */
export function noteArtifactLedgerFailure(scope: RichConversationScope, error: unknown): boolean {
  if (isArtifactPermissionError(error)) return revokeArtifactConversation(scope, "permission");
  if (artifactErrorInfo(error).code === "not_found") {
    return revokeArtifactConversation(scope, "deleted");
  }
  return false;
}

/**
 * A read of one publication answered `not_found`: re-read the ledger to tell
 * a missing publication from a deleted conversation. De-duplicated per
 * conversation while in flight.
 */
export function verifyArtifactConversation(
  scope: RichConversationScope,
  reader: Pick<ArtifactReader, "listTranscriptArtifactPublications">,
): Promise<ArtifactConversationVerification> {
  const key = conversationStatusKey(scope);
  const existing = verifying.get(key);
  if (existing) return existing;
  artifactConversationRevocationCounters.verifications++;
  const promise = Promise.resolve()
    .then(() =>
      reader.listTranscriptArtifactPublications({
        environmentId: scope.environmentId,
        logicalSessionKey: scope.logicalSessionKey,
        limit: 1,
      }),
    )
    .then(
      (ledger): ArtifactConversationVerification => {
        // A malformed answer proves nothing either way.
        if (!Array.isArray(ledger?.publications)) return "unknown";
        if (ledger.publications.length > 0) {
          noteArtifactConversationContent(scope, "ledger");
          return "available";
        }
        // Nothing published: deleted, if this window had loaded its content.
        if (artifactConversationStatus(scope) === "seen") {
          revokeArtifactConversation(scope, "deleted");
          return "revoked";
        }
        return artifactConversationStatus(scope) === "revoked" ? "revoked" : "unknown";
      },
      (error: unknown): ArtifactConversationVerification =>
        noteArtifactLedgerFailure(scope, error) || artifactConversationStatus(scope) === "revoked"
          ? "revoked"
          : "unknown",
    )
    .catch((): ArtifactConversationVerification => "unknown")
    .finally(() => {
      if (verifying.get(key) === promise) verifying.delete(key);
    });
  verifying.set(key, promise);
  return promise;
}

/** Tests: forget conversation statuses and counters. */
export function resetArtifactConversationRevocations(): void {
  conversationStatus.clear();
  verifying.clear();
  artifactConversationRevocationCounters.deleted = 0;
  artifactConversationRevocationCounters.permission = 0;
  artifactConversationRevocationCounters.verifications = 0;
}

/**
 * A scoped read failed with `not_found` or a permission failure: decide
 * through the conversation-level ledger whether the whole scope is gone.
 */
function noteScopedReadFailure(
  scope: ArtifactReadScope,
  error: unknown,
  reader: Pick<ArtifactReader, "listTranscriptArtifactPublications">,
): void {
  if (isArtifactPermissionError(error) || artifactErrorInfo(error).code === "not_found") {
    void verifyArtifactConversation(scope, reader);
  }
}

export function artifactRequestCacheStats(): { entries: number; bytes: number; inflight: number } {
  return { entries: settled.size, bytes: settled.bytes, inflight: inflight.size };
}

export class StaleArtifactScopeError extends Error {
  constructor() {
    super("The conversation changed before this artifact response arrived");
    this.name = "StaleArtifactScopeError";
  }
}

function load<T>(
  key: string,
  scope: ArtifactReadScope,
  run: () => Promise<T>,
  sizeOf: (value: T) => number,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  // A synchronous throw from the transport becomes an ordinary rejection.
  const promise: Promise<T> = Promise.resolve()
    .then(run)
    .then((value) => {
      // Cleared while in flight (logout, deletion): never repopulate.
      if (inflight.get(key) !== promise) throw new StaleArtifactScopeError();
      if (!isCurrentArtifactScopeGeneration(scope)) throw new StaleArtifactScopeError();
      remember(key, value, sizeOf(value));
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

export type ArtifactRequestState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string; code?: string };

/**
 * Backend command failures cross the gateway as an Error whose message is
 * the JSON `ArtifactError` (`{"code":"not_found","message":…}`); in-process
 * callers may also carry `code`/`error` directly.
 */
export function artifactErrorInfo(error: unknown): { message: string; code?: string } {
  if (error instanceof Error && error.message.startsWith("{")) {
    try {
      const parsed = JSON.parse(error.message) as { code?: unknown; message?: unknown };
      if (typeof parsed.code === "string") {
        return {
          code: parsed.code,
          message: (typeof parsed.message === "string"
            ? parsed.message
            : "The request failed"
          ).slice(0, 300),
        };
      }
    } catch {
      // Not a structured error; fall through to the generic reading.
    }
  }
  return errorInfo(error);
}

function errorInfo(error: unknown): { message: string; code?: string } {
  if (error && typeof error === "object") {
    const record = error as {
      message?: unknown;
      code?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    const code =
      typeof record.code === "string"
        ? record.code
        : typeof record.error?.code === "string"
          ? record.error.code
          : undefined;
    const message =
      typeof record.message === "string"
        ? record.message
        : typeof record.error?.message === "string"
          ? record.error.message
          : "The request failed";
    return { message: message.slice(0, 300), code };
  }
  return { message: "The request failed" };
}

export function useScopedArtifactRead<T>(
  key: string | null,
  scope: ArtifactReadScope | null,
  run: () => Promise<T>,
  sizeOf: (value: T) => number,
): ArtifactRequestState<T> & { retry: () => void } {
  // Only asynchronous results are stored; idle, cached and loading states are
  // derived during render so a key change never needs a synchronous update.
  const [result, setResult] = useState<{
    key: string;
    attempt: number;
    epoch: number;
    value: ArtifactRequestState<T>;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const epoch = useSyncExternalStore(subscribeEpoch, readEpoch, readEpoch);
  const reader = useScopeBackend();
  const runRef = useRef(run);
  const sizeRef = useRef(sizeOf);
  const scopeRef = useRef(scope);
  const readerRef = useRef(reader);
  useLayoutEffect(() => {
    runRef.current = run;
    sizeRef.current = sizeOf;
    scopeRef.current = scope;
    readerRef.current = reader;
  });

  useEffect(() => {
    const scope = scopeRef.current;
    if (!key || !scope) return;
    noteArtifactScopeGeneration(scope);
    if (recall(key)) return;
    let cancelled = false;
    load(
      key,
      scope,
      () => runRef.current(),
      (value) => sizeRef.current(value),
    )
      .then((value) => {
        noteArtifactConversationContent(scope, "read");
        if (!cancelled) setResult({ key, attempt, epoch, value: { status: "ready", value } });
      })
      .catch((error: unknown) => {
        if (error instanceof StaleArtifactScopeError) return;
        // Even for an unmounted reader: deletion and revocation clear the
        // conversation's protected content wherever it is cached.
        noteScopedReadFailure(scope, error, readerRef.current);
        if (cancelled) return;
        setResult({
          key,
          attempt,
          epoch,
          value: { status: "error", ...artifactErrorInfo(error) },
        });
      });
    return () => {
      cancelled = true;
    };
    // `scope` is encoded in `key`; the ref holds the matching object. A
    // cache clear (`epoch`) re-requests content that is still displayed.
  }, [key, attempt, epoch]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  let value: ArtifactRequestState<T>;
  if (!key) {
    value = { status: "idle" };
  } else if (result && result.key === key && result.attempt === attempt && result.epoch === epoch) {
    value = result.value;
  } else {
    const hit = recall(key);
    value = hit ? { status: "ready", value: hit.value as T } : { status: "loading" };
  }
  return { ...value, retry };
}

export function artifactScopeKeyParts(scope: ArtifactReadScope): string[] {
  return [scope.backendId ?? "", scope.environmentId, scope.logicalSessionKey, scope.generation];
}

export function useArtifactPublication(
  scope: ArtifactReadScope | null,
  publicationId: string | null,
): ArtifactRequestState<ArtifactPublicationView> & { retry: () => void } {
  const nodeBackend = useScopeBackend();
  const key =
    scope && publicationId
      ? encodeRichKey(["publication", ...artifactScopeKeyParts(scope), publicationId])
      : null;
  return useScopedArtifactRead(
    key,
    scope,
    () =>
      nodeBackend.getTranscriptArtifactPublication({
        environmentId: scope!.environmentId,
        logicalSessionKey: scope!.logicalSessionKey,
        publicationId: publicationId!,
      }),
    () => 2_048,
  );
}

/**
 * Read a whole representation. UTF-8 representations that the backend pages
 * are concatenated up to `maxBytes` (default MAX_TEXT_REPRESENTATION_BYTES);
 * base64 bodies are read in one response. A representation over the limit
 * comes back partial, with `nextOffsetBytes` still set, so a caller that needs
 * the whole document must check it. Every page must name the same artifact,
 * revision, representation and whole-document hash as the first.
 */
export async function readWholeRepresentation(
  reader: Pick<ArtifactReader, "readTranscriptArtifactRepresentation">,
  scope: ArtifactReadScope,
  publicationId: string,
  representation: ArtifactRepresentation,
  captureIndex?: number,
  options: { maxBytes?: number } = {},
): Promise<ArtifactRepresentationResponse> {
  const maxBytes = options.maxBytes ?? MAX_TEXT_REPRESENTATION_BYTES;
  const base = {
    environmentId: scope.environmentId,
    logicalSessionKey: scope.logicalSessionKey,
    publicationId,
    representation,
    ...(captureIndex !== undefined ? { captureIndex } : {}),
  };
  const first = await reader.readTranscriptArtifactRepresentation(
    options.maxBytes !== undefined
      ? { ...base, sourceRange: { offsetBytes: 0, limitBytes: maxBytes } }
      : base,
  );
  if (first.encoding !== "utf8" || first.nextOffsetBytes === null) return first;
  // Nothing more to fetch for a document the caller could not use anyway.
  if (first.totalBytes > maxBytes) return first;
  let data = first.data;
  let next: number | null = first.nextOffsetBytes;
  let total = first.byteLength;
  while (next !== null && total < maxBytes) {
    const offset: number = next;
    const page: ArtifactRepresentationResponse = await reader.readTranscriptArtifactRepresentation({
      ...base,
      sourceRange: {
        offsetBytes: offset,
        limitBytes: Math.min(256 * 1024, maxBytes - total),
      },
    });
    if (
      page.sha256 !== first.sha256 ||
      page.revision !== first.revision ||
      page.artifactId !== first.artifactId ||
      page.representation !== first.representation ||
      page.encoding !== first.encoding
    ) {
      throw new Error("The representation changed while it was being read");
    }
    if (page.nextOffsetBytes !== null && page.nextOffsetBytes <= offset) {
      throw new Error("The representation read did not advance");
    }
    data += page.data;
    total += page.byteLength;
    next = page.nextOffsetBytes;
  }
  return { ...first, data, byteLength: total, nextOffsetBytes: next };
}

export function useArtifactRepresentation(
  scope: ArtifactReadScope | null,
  publicationId: string | null,
  representation: ArtifactRepresentation,
  options: { enabled?: boolean; captureIndex?: number } = {},
): ArtifactRequestState<ArtifactRepresentationResponse> & { retry: () => void } {
  const nodeBackend = useScopeBackend();
  const enabled = options.enabled ?? true;
  const key =
    enabled && scope && publicationId
      ? encodeRichKey([
          "representation",
          ...artifactScopeKeyParts(scope),
          publicationId,
          representation,
          options.captureIndex ?? null,
        ])
      : null;
  return useScopedArtifactRead(
    key,
    scope,
    () =>
      readWholeRepresentation(
        nodeBackend,
        scope!,
        publicationId!,
        representation,
        options.captureIndex,
      ),
    (value) => value.data.length,
  );
}

/*
 * Searchable body text of published artifact cards, keyed by publication id.
 * A card writes it when it has loaded and is showing that body (chart or
 * workflow labels, Mermaid source while the source view is shown, a static
 * document's text once its frame reports it) and clears it when it stops
 * showing it. An open Find bar also writes a static document's stored text
 * for a card the reader has not reached (`useStaticDocumentSearchIndex`). Find's message projection reads it synchronously
 * (`artifactPartSearchSegments` in `rich-search-text.ts`), so an unloaded body
 * contributes nothing and a loaded one matches the card's body search root
 * exactly. Each entry names its conversation, so clearing that conversation's
 * protected content takes its text too. Bounded by count and total characters;
 * each value is already bounded by `MAX_ARTIFACT_BODY_SEARCH_CHARACTERS`
 * (labels, document text) or the representation size (source).
 */
const MAX_SEARCH_BODIES = 256;
const MAX_SEARCH_BODY_CHARACTERS = 8 * 1024 * 1024;
const searchBodies = new Map<
  string,
  { artifactId: string; revision: number; text: string; scope: RichConversationScope }
>();
let searchBodyCharacters = 0;
let searchBodyRevision = 0;
const searchBodyListeners = new Set<() => void>();

function notifySearchBodies(): void {
  searchBodyRevision += 1;
  for (const listener of Array.from(searchBodyListeners)) listener();
}

/** Changes whenever a body arrives or leaves; nothing else moves it. */
export function artifactSearchBodyRevision(): number {
  return searchBodyRevision;
}

export function subscribeArtifactSearchBodies(listener: () => void): () => void {
  searchBodyListeners.add(listener);
  return () => {
    searchBodyListeners.delete(listener);
  };
}

function dropSearchBody(publicationId: string): boolean {
  const entry = searchBodies.get(publicationId);
  if (!entry) return false;
  searchBodies.delete(publicationId);
  searchBodyCharacters -= entry.text.length;
  return true;
}

function clearSearchBodiesWhere(matches: (scope: RichConversationScope) => boolean): void {
  let changed = false;
  for (const [publicationId, entry] of Array.from(searchBodies.entries())) {
    if (matches(entry.scope)) changed = dropSearchBody(publicationId) || changed;
  }
  if (changed) notifySearchBodies();
}

export function rememberArtifactSearchBody(
  artifact: { publicationId: string; artifactId: string; revision: number },
  text: string | null,
  scope: RichConversationScope,
): void {
  const previous = searchBodies.get(artifact.publicationId);
  const dropped = dropSearchBody(artifact.publicationId);
  if (text === null || text.length === 0) {
    if (dropped) notifySearchBodies();
    return;
  }
  // A card that mounts again republishes what it published before. Its place in
  // the eviction order moves, but an open Find bar has nothing to recompute.
  let changed =
    previous?.text !== text ||
    previous.artifactId !== artifact.artifactId ||
    previous.revision !== artifact.revision;
  searchBodies.set(artifact.publicationId, {
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    text,
    scope,
  });
  searchBodyCharacters += text.length;
  while (
    searchBodies.size > MAX_SEARCH_BODIES ||
    searchBodyCharacters > MAX_SEARCH_BODY_CHARACTERS
  ) {
    const oldest = searchBodies.keys().next().value;
    if (oldest === undefined) break;
    dropSearchBody(oldest);
    changed = true;
  }
  if (changed) notifySearchBodies();
}

/** The loaded body text for an artifact part's reference, or null. */
export function cachedArtifactSearchBody(artifact: unknown): string | null {
  if (!artifact || typeof artifact !== "object") return null;
  const ref = artifact as { publicationId?: unknown; artifactId?: unknown; revision?: unknown };
  if (typeof ref.publicationId !== "string") return null;
  const entry = searchBodies.get(ref.publicationId);
  if (!entry || entry.artifactId !== ref.artifactId || entry.revision !== ref.revision) return null;
  return entry.text;
}

/** `cachedArtifactSearchBody`, for a card whose search root follows the cache. */
export function useCachedArtifactSearchBody(artifact: unknown): string | null {
  return useSyncExternalStore(subscribeArtifactSearchBodies, () =>
    cachedArtifactSearchBody(artifact),
  );
}
