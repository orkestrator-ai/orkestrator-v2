import { useEffect, useRef } from "react";
import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type { TranscriptArtifactRef } from "@orkestrator/protocol/transcript-artifacts";
import { readTranscriptArtifactRef } from "@orkestrator/protocol/transcript-artifacts-validation";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { useTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import {
  artifactRequestEpoch,
  cachedArtifactSearchBody,
  isCurrentArtifactScopeGeneration,
  noteArtifactScopeGeneration,
  readWholeRepresentation,
  rememberArtifactSearchBody,
  type ArtifactReadScope,
  type ArtifactReader,
} from "@/lib/chat/artifact-requests";
import {
  encodeRichKey,
  richScopeKey,
  useRichTranscriptScope,
  type RichKeyPart,
  type RichTranscriptScope,
} from "@/lib/chat/rich-identity";
import { artifactBodySearchText } from "@/lib/chat/rich-search-text";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { staticHtmlPresentationSupported } from "./rich/static-html-frame-source";

/*
 * Find inside static documents the reader has not reached (to-do 5780 task 2).
 *
 * A static document's card reports its text once its frame has rendered it,
 * and nothing is read or framed for a card the reader has not reached. While a
 * Find bar is open with a query, this reads the text the preview worker stored
 * at verification (`search-text`) for each such document in the loaded
 * transcript and puts it in Find's body cache, exactly where the card's frame
 * would have put it. Find follows that cache, so the count and the card's
 * hidden mirror agree as soon as a body arrives; the frame's own report, when
 * the card is shown, is the same text (a test pins the two walks together).
 *
 * Bounded: one read per document per Find session, at most
 * `maxDocumentsPerSession` documents and `concurrency` reads at a time, each
 * bounded by the text limit. A publication verified before the worker stored
 * text, an older backend and any failed read leave the document as before:
 * its text counts once its card has shown it.
 *
 * Only a document whose card would show it is indexed. A card switched to
 * Saved preview or Source renders no body search root, so its text would be a
 * match Find cannot highlight; such a card is skipped, at offer and again
 * before a read lands (`showsDocument`).
 */
export const STATIC_DOCUMENT_INDEX_POLICY = {
  maxDocumentsPerSession: 64,
  concurrency: 2,
  /** UTF-8 of the longest text a frame reports: three bytes per UTF-16 unit at most. */
  maxBytes: 3 * STATIC_PRESENTATION_POLICY.maxSearchTextCharacters,
} as const;

export type StaticDocumentIndexOutcome = "stored" | "skipped" | "unavailable";

type DocumentRef = Pick<TranscriptArtifactRef, "publicationId" | "artifactId" | "revision">;

/** Whether the cards for a document would show its body (none left the document view). */
export type ShowsDocument = (ref: DocumentRef) => boolean;

const ALWAYS_SHOWS: ShowsDocument = () => true;

/**
 * Whether every remembered card for `ref` in this conversation still shows the
 * document. A card's view choice is kept per occurrence
 * (`richArtifactOccurrenceKey`: `["artifact", ...scope, message, publication,
 * artifact, revision]`); a card with no remembered choice shows the document,
 * its default. Any occurrence on Saved preview or Source withdraws the body
 * when it mounts, so one is enough to keep the document out of the index.
 */
export function cardsShowDocument(
  transcriptScope: RichTranscriptScope | null,
  ref: DocumentRef,
): boolean {
  const prefix = richScopeKey(transcriptScope);
  for (const [key, state] of useRichContentViewStore.getState().entries) {
    if (state.view === undefined || state.view === "document") continue;
    let parts: unknown;
    try {
      parts = JSON.parse(key);
    } catch {
      continue;
    }
    if (!Array.isArray(parts) || parts.length !== 8 || parts[0] !== "artifact") continue;
    const occurrence = parts as RichKeyPart[];
    if (
      occurrence[1] === prefix[0] &&
      occurrence[2] === prefix[1] &&
      occurrence[3] === prefix[2] &&
      occurrence[5] === ref.publicationId &&
      occurrence[6] === ref.artifactId &&
      occurrence[7] === ref.revision
    )
      return false;
  }
  return true;
}

/**
 * Read one publication's stored document text into Find's body cache. Never
 * rejects. A body already in the cache (its frame reported it) is kept; a read
 * that crosses a clear of protected content or a newer session generation is
 * discarded rather than repopulating the cache.
 */
export async function loadStaticDocumentSearchBody(
  reader: Pick<ArtifactReader, "readTranscriptArtifactRepresentation">,
  scope: ArtifactReadScope,
  ref: DocumentRef,
  showsDocument: ShowsDocument = ALWAYS_SHOWS,
): Promise<StaticDocumentIndexOutcome> {
  if (cachedArtifactSearchBody(ref) !== null || !showsDocument(ref)) return "skipped";
  const epoch = artifactRequestEpoch();
  let response: Awaited<ReturnType<typeof readWholeRepresentation>>;
  try {
    response = await readWholeRepresentation(
      reader,
      scope,
      ref.publicationId,
      "search-text",
      undefined,
      { maxBytes: STATIC_DOCUMENT_INDEX_POLICY.maxBytes },
    );
  } catch {
    return "unavailable";
  }
  if (artifactRequestEpoch() !== epoch || !isCurrentArtifactScopeGeneration(scope))
    return "skipped";
  if (
    response.representation !== "search-text" ||
    !response.mimeType.startsWith("text/plain") ||
    response.artifactId !== ref.artifactId ||
    response.revision !== ref.revision ||
    response.encoding !== "utf8" ||
    response.nextOffsetBytes !== null ||
    response.data.length > STATIC_PRESENTATION_POLICY.maxSearchTextCharacters
  )
    return "unavailable";
  // The card's frame reported while this was in flight: its text stands. A
  // card switched off its document view meanwhile shows no body to match.
  if (cachedArtifactSearchBody(ref) !== null || !showsDocument(ref)) return "skipped";
  const text = artifactBodySearchText("static-document", response.data);
  if (text === null) return "unavailable";
  rememberArtifactSearchBody(ref, text, {
    backendId: scope.backendId,
    environmentId: scope.environmentId,
    logicalSessionKey: scope.logicalSessionKey,
  });
  return "stored";
}

/**
 * One Find session's reads for one conversation generation. `stop` drops what
 * is queued; reads already sent finish and land in the cache, which is what
 * the card would have shown anyway.
 */
export class StaticDocumentIndexSession {
  private readonly offered = new Set<string>();
  private readonly queue: TranscriptArtifactRef[] = [];
  private running = 0;
  private stopped = false;

  constructor(
    readonly key: string,
    private readonly reader: Pick<ArtifactReader, "readTranscriptArtifactRepresentation">,
    private readonly scope: ArtifactReadScope,
    private readonly load: typeof loadStaticDocumentSearchBody = loadStaticDocumentSearchBody,
    private readonly showsDocument: ShowsDocument = ALWAYS_SHOWS,
  ) {
    // Fence reads for an older generation of this conversation, and accept
    // this one's even when no artifact card is mounted to record it.
    noteArtifactScopeGeneration(scope);
  }

  offer(refs: Iterable<TranscriptArtifactRef>): void {
    if (this.stopped) return;
    for (const ref of refs) {
      if (this.offered.size >= STATIC_DOCUMENT_INDEX_POLICY.maxDocumentsPerSession) break;
      if (this.offered.has(ref.publicationId) || cachedArtifactSearchBody(ref) !== null) continue;
      // Not marked offered: switching the card back shows the document, and
      // its frame reports the text then.
      if (!this.showsDocument(ref)) continue;
      this.offered.add(ref.publicationId);
      this.queue.push(ref);
    }
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  /** Reads in flight and queued; for tests and diagnostics. */
  pending(): { running: number; queued: number; offered: number } {
    return { running: this.running, queued: this.queue.length, offered: this.offered.size };
  }

  private pump(): void {
    while (
      !this.stopped &&
      this.running < STATIC_DOCUMENT_INDEX_POLICY.concurrency &&
      this.queue.length > 0
    ) {
      const ref = this.queue.shift()!;
      this.running += 1;
      void this.load(this.reader, this.scope, ref, this.showsDocument).then(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }
}

/** The supported `html-static` references in `items` this connection may read. */
export function staticDocumentRefs<T>(
  items: readonly T[],
  artifactsOf: (item: T) => readonly unknown[],
  backendId: string,
): TranscriptArtifactRef[] {
  const refs: TranscriptArtifactRef[] = [];
  for (const item of items) {
    for (const raw of artifactsOf(item)) {
      const read = readTranscriptArtifactRef(raw);
      if (read.status !== "supported" || read.ref.kind !== "html-static") continue;
      // Identity comes from the authenticated connection, never from the reference.
      if (read.ref.provenance.backendId !== backendId) continue;
      refs.push(read.ref);
    }
  }
  return refs;
}

/**
 * While `active` (a Find bar open with a query), index the static documents in
 * `items` whose text no card has reported. A transcript without
 * `artifactsOf`, without an authenticated scope, or whose client cannot show
 * documents (the hosted client, the rollout switch off) indexes nothing: its
 * cards would never show the text either.
 */
export function useStaticDocumentSearchIndex<T>(
  items: readonly T[],
  artifactsOf: ((item: T) => readonly unknown[]) | undefined,
  active: boolean,
): void {
  const transcriptScope = useRichTranscriptScope();
  const capabilities = useTranscriptArtifactCapabilities();
  const reader = useScopeBackend();
  const session = useRef<StaticDocumentIndexSession | null>(null);
  const backendId = capabilities?.backendId ?? null;
  const presents =
    capabilities !== null &&
    capabilities.rolloutFlags?.staticPresentation !== false &&
    staticHtmlPresentationSupported();

  useEffect(() => {
    if (!active || !artifactsOf || !transcriptScope || !backendId || !presents) {
      session.current?.stop();
      session.current = null;
      return;
    }
    const scope: ArtifactReadScope = {
      backendId,
      environmentId: transcriptScope.environmentId,
      logicalSessionKey: transcriptScope.logicalSessionKey,
      generation: transcriptScope.generation,
    };
    const key = encodeRichKey([
      backendId,
      scope.environmentId,
      scope.logicalSessionKey,
      scope.generation,
    ]);
    if (session.current?.key !== key) {
      session.current?.stop();
      session.current = new StaticDocumentIndexSession(
        key,
        reader,
        scope,
        loadStaticDocumentSearchBody,
        (ref) => cardsShowDocument(transcriptScope, ref),
      );
    }
    session.current.offer(staticDocumentRefs(items, artifactsOf, backendId));
  }, [active, artifactsOf, backendId, items, presents, reader, transcriptScope]);

  // Unmount is not cancel for the reads already sent; it does drop the queue.
  useEffect(
    () => () => {
      session.current?.stop();
      session.current = null;
    },
    [],
  );
}
