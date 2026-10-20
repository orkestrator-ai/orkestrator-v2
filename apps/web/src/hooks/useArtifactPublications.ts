import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ArtifactPublicationView } from "@orkestrator/protocol/transcript-artifact-commands";
import { listTranscriptArtifactPublications } from "@/lib/backend/transcript-artifacts";
import { encodeRichKey, type RichTranscriptScope } from "@/lib/chat/rich-identity";
import {
  decodeRichKey,
  registerProtectedRichCache,
  type RichConversationScope,
} from "@/lib/chat/rich-content-reset";
import {
  unresolvedPublishCalls,
  withLedgerOmission,
  type ArtifactPublicationLedger,
} from "@/lib/chat/artifact-publication-merge";
import {
  noteArtifactConversationContent,
  noteArtifactLedgerFailure,
  revokeArtifactConversation,
} from "@/lib/chat/artifact-requests";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";

/**
 * The publication ledger for one conversation, read from the backend.
 *
 * Every mount and every transport generation re-reads the ledger, so a
 * publication committed while this tab was unmounted, inactive or
 * disconnected is recovered from the authoritative record rather than from a
 * live event. A publish call in the transcript that the ledger does not yet
 * show triggers a bounded re-read. A `transcript-artifact` resource event
 * naming this conversation (a hint, never the data) triggers a re-read too,
 * so a publication appears while the tab is open without waiting for a
 * transcript change. Responses for a superseded scope or generation are
 * discarded.
 *
 * Bounds: the ledger is read in pages of `PAGE_LIMIT` up to
 * `MAX_LEDGER_PAGES` pages, and the newest `MAX_RETAINED_PUBLICATIONS` are
 * kept. Nothing is dropped silently: publications beyond the retained bound
 * are counted (`omittedOlder`) and a ledger longer than the page bound is
 * marked `incomplete`; the merge shows an explicit notice row for either.
 *
 * Deletion and revocation: publications are immutable and are only removed
 * with their conversation, so a re-read that finds nothing where this hook
 * showed publications means the conversation was deleted (the backend's
 * deletion announces the same `transcript-artifact` hint); a ledger read
 * failing with `not_found` or a permission error means the scope itself is
 * gone. Either clears the conversation's protected rich content
 * (`revokeArtifactConversation` → `clearRichConversationContent`).
 */

/** Newest publications retained per conversation. */
export const MAX_RETAINED_PUBLICATIONS = 2_000;
const PAGE_LIMIT = 200;
/** Hard bound on one ledger read: 50 pages of 200 = 10,000 publications. */
export const MAX_LEDGER_PAGES = 50;
const MAX_CACHED_CONVERSATIONS = 20;
const RETRY_DELAYS_MS = [500, 1_500, 4_000, 10_000];

const cache = new Map<string, ArtifactPublicationLedger>();
const EMPTY_PUBLICATIONS: ArtifactPublicationLedger = [];

/**
 * Bumped by every clear. Cache keys carry the epoch they were read under
 * (`[backend, environment, session, epoch]`), so a clear changes every
 * mounted hook's key (it drops what it shows and re-reads), and a read that
 * was in flight across a clear can never repopulate the cache.
 */
let cacheEpoch = 0;
const epochListeners = new Set<() => void>();

function subscribeEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => {
    epochListeners.delete(listener);
  };
}

const readEpoch = () => cacheEpoch;

function remember(key: string, publications: ArtifactPublicationLedger) {
  if (decodeRichKey(key)?.[3] !== cacheEpoch) return;
  cache.delete(key);
  cache.set(key, publications);
  while (cache.size > MAX_CACHED_CONVERSATIONS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function clearWhere(matches: (parts: unknown[]) => boolean): void {
  for (const key of Array.from(cache.keys())) {
    const parts = decodeRichKey(key);
    if (!parts || matches(parts)) cache.delete(key);
  }
  cacheEpoch++;
  for (const listener of Array.from(epochListeners)) listener();
}

/** Drop cached ledgers (logout, connection replacement, permission revocation). */
export function clearArtifactPublicationCache(): void {
  clearWhere(() => true);
}

export function clearArtifactPublicationsForEnvironment(environmentId: string): void {
  clearWhere((parts) => parts[1] === environmentId);
}

export function clearArtifactPublicationsForConversation(scope: RichConversationScope): void {
  clearWhere(
    (parts) =>
      parts[0] === scope.backendId &&
      parts[1] === scope.environmentId &&
      parts[2] === scope.logicalSessionKey,
  );
}

export function artifactPublicationCacheSize(): number {
  return cache.size;
}

registerProtectedRichCache("artifact-publications", {
  clearAll: clearArtifactPublicationCache,
  clearEnvironment: clearArtifactPublicationsForEnvironment,
  clearConversation: clearArtifactPublicationsForConversation,
});

/**
 * Read one conversation's ledger, oldest first, within the documented
 * bounds. Exported for tests.
 */
export async function readArtifactLedger(
  scope: Pick<RichTranscriptScope, "environmentId" | "logicalSessionKey">,
): Promise<ArtifactPublicationLedger> {
  let publications: ArtifactPublicationView[] = [];
  let omittedOlder = 0;
  let incomplete = false;
  let afterSequence: number | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_LEDGER_PAGES) {
      incomplete = true;
      break;
    }
    const result = await listTranscriptArtifactPublications({
      environmentId: scope.environmentId,
      logicalSessionKey: scope.logicalSessionKey,
      ...(afterSequence !== undefined ? { afterSequence } : {}),
      limit: PAGE_LIMIT,
    });
    publications.push(...result.publications);
    if (publications.length > MAX_RETAINED_PUBLICATIONS) {
      const excess = publications.length - MAX_RETAINED_PUBLICATIONS;
      omittedOlder += excess;
      publications = publications.slice(excess);
    }
    if (result.nextSequence === null || result.publications.length === 0) break;
    afterSequence = result.nextSequence;
  }
  return withLedgerOmission(publications, { omittedOlder, incomplete });
}

/**
 * Apply an authoritative ledger read. Returns false (and clears the
 * conversation's protected content) when the read shows that the
 * conversation was deleted: publications were shown and none remain.
 */
function acceptLedger(
  scope: RichTranscriptScope,
  shown: ArtifactPublicationLedger,
  loaded: ArtifactPublicationLedger,
): boolean {
  if (loaded.length > 0) {
    noteArtifactConversationContent(scope, "ledger");
    return true;
  }
  if (shown.length > 0 && !loaded.incomplete) {
    revokeArtifactConversation(scope, "deleted");
    return false;
  }
  return true;
}

/**
 * `scope` null means the view does not know its conversation yet (a workflow
 * transcript before its session is recorded): nothing is read and nothing is
 * merged until it does.
 */
export function useArtifactPublications(
  scope: RichTranscriptScope | null,
  messages: readonly NativeMessage[],
): ArtifactPublicationLedger {
  const epoch = useSyncExternalStore(subscribeEpoch, readEpoch, readEpoch);
  const key = scope
    ? encodeRichKey([scope.backendId, scope.environmentId, scope.logicalSessionKey, epoch])
    : "";
  const [state, setState] = useState<{ key: string; publications: ArtifactPublicationLedger }>(
    () => ({
      key,
      publications: cache.get(key) ?? [],
    }),
  );
  const publications = useMemo(
    () =>
      !key
        ? EMPTY_PUBLICATIONS
        : state.key === key
          ? state.publications
          : (cache.get(key) ?? EMPTY_PUBLICATIONS),
    [key, state],
  );
  const unresolved = useMemo(
    () => unresolvedPublishCalls(messages, publications),
    [messages, publications],
  );
  const requestRef = useRef(0);
  // What this hook currently shows, compared against each authoritative read.
  const shownRef = useRef(publications);
  useLayoutEffect(() => {
    shownRef.current = publications;
  });

  // Authoritative read on mount, scope change and transport generation change.
  useEffect(() => {
    if (!scope) return;
    const request = ++requestRef.current;
    let cancelled = false;
    readArtifactLedger(scope)
      .then((loaded) => {
        if (cancelled || request !== requestRef.current) return;
        if (!acceptLedger(scope, shownRef.current, loaded)) return;
        remember(key, loaded);
        setState({ key, publications: loaded });
      })
      .catch((error: unknown) => {
        // The transcript stays readable; artifacts appear on the next read.
        // A scope that is gone or forbidden clears its protected content.
        if (!cancelled) noteArtifactLedgerFailure(scope, error);
      });
    return () => {
      cancelled = true;
    };
  }, [key, scope]);

  // A publish call the ledger does not show yet: re-read with bounded backoff.
  useEffect(() => {
    if (!scope || unresolved === 0) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      if (cancelled || attempt >= RETRY_DELAYS_MS.length) return;
      timer = setTimeout(() => {
        const request = ++requestRef.current;
        readArtifactLedger(scope)
          .then((loaded) => {
            if (cancelled || request !== requestRef.current) return;
            if (!acceptLedger(scope, shownRef.current, loaded)) return;
            remember(key, loaded);
            setState({ key, publications: loaded });
          })
          .catch((error: unknown) => {
            if (!cancelled && request === requestRef.current)
              noteArtifactLedgerFailure(scope, error);
          })
          .finally(schedule);
      }, RETRY_DELAYS_MS[attempt++]);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, scope, unresolved]);

  // Live hint: the backend announces ledger/draft changes per conversation.
  const scopeRef = useRef(scope);
  useLayoutEffect(() => {
    scopeRef.current = scope;
  });
  const logicalSessionKey = scope?.logicalSessionKey;
  useEffect(() => {
    if (logicalSessionKey === undefined) return;
    let disposed = false;
    const reread = () => {
      const current = scopeRef.current;
      if (!current) return;
      const request = ++requestRef.current;
      readArtifactLedger(current)
        .then((loaded) => {
          if (disposed || request !== requestRef.current) return;
          if (!acceptLedger(current, shownRef.current, loaded)) return;
          remember(key, loaded);
          setState({ key, publications: loaded });
        })
        .catch((error: unknown) => {
          if (!disposed && request === requestRef.current) {
            noteArtifactLedgerFailure(current, error);
          }
        });
    };
    // The id is the conversation key; a deletion of this conversation is
    // announced the same way and recognised by the re-read (acceptLedger).
    const offChange = onResourceChanged("transcript-artifact", (change) => {
      if (change.id === logicalSessionKey) reread();
    });
    // A full resync (sequence gap, reset) may have hidden an event.
    const offResync = onResourceResync((request) => {
      if (request.resources === null) reread();
    });
    return () => {
      disposed = true;
      offChange();
      offResync();
    };
  }, [key, logicalSessionKey]);

  return publications;
}
