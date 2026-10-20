/**
 * Published transcript artifacts, placed into projected transcript rows.
 *
 * The publication ledger (transcript-artifacts/ledger.ts) is authoritative:
 * every projection read asks it for the conversation's ledger revision and,
 * when that moved, re-reads the conversation's publications. A publication is
 * appended as a `type: "artifact"` part to the end of the row holding the
 * call that published it:
 *
 *  1. the row holding the tool part whose `toolUseId` is the publication's
 *     recorded `anchor.toolCallId`, else
 *  2. the row holding a successful `publish_artifact` call whose arguments
 *     name the publication's artifact and revision.
 *
 * Placement is decided per read over the rows that read holds, exactly like
 * the renderer's own merge (`apps/web/src/lib/chat/artifact-publication-merge.ts`),
 * which also de-duplicates by publication id. Nothing here inserts a row: a
 * publication with no matching call among the rows read stays a renderer
 * concern, so provider-positioned windows and history indexes never shift.
 *
 * The overlay runs after the per-row projection cache and never writes into
 * it. An overlaid row is a new object; it is memoized only under the identity
 * of the ledger read that produced it, so an older ledger revision can never
 * answer for a newer one.
 */
import {
  ARTIFACT_TOOL_NAMES,
  artifactPartContent,
  orkestratorToolName,
  type ArtifactPublication,
  type TranscriptArtifactPartWire,
} from "@orkestrator/protocol/transcript-artifacts";

/** The ledger reads projection needs; `TranscriptArtifactService` satisfies it. */
export interface ArtifactLedgerReader {
  publicationsForConversation(
    environmentId: string,
    conversationKey: string,
    options?: { afterSequence?: number; limit?: number },
  ): readonly ArtifactPublication[];
  ledgerRevision(environmentId: string, conversationKey: string): number;
  /** Post-commit hints; a conversation's kept read is dropped on each one. */
  onLedgerChange?(
    listener: (change: { environmentId: string; conversationKey: string }) => void,
  ): () => void;
}

/** One ledger page; the ledger's own read ceiling. */
export const ARTIFACT_OVERLAY_PAGE_SIZE = 1_000;
/** Pages read per conversation (10,000 publications), as the renderer does. */
export const ARTIFACT_OVERLAY_MAX_PAGES = 10;
/** Newest publications kept per conversation, as the renderer does. */
export const ARTIFACT_OVERLAY_RETAINED = 2_000;
/** Conversations whose ledger read is kept between projection reads. */
export const ARTIFACT_OVERLAY_CACHED_CONVERSATIONS = 64;
const MAX_PART_DEPTH = 4;
const MEMO_KEYS_PER_ROW = 4;

/** The artifact part a publication projects as (`TranscriptArtifactPartWire`). */
export type ProjectedArtifactPart = TranscriptArtifactPartWire & { sourcePartId: string };

export interface ArtifactOverlay {
  readonly environmentId: string;
  readonly conversationKey: string;
  /** Ledger revision this read reflects. */
  readonly revision: number;
  /** Unique per ledger read; part of every memoized overlay key. */
  readonly readId: string;
  /** Retained publications in conversation-sequence order. */
  readonly publications: readonly ArtifactPublication[];
  readonly byToolCall: ReadonlyMap<string, ArtifactPublication>;
  readonly byTarget: ReadonlyMap<string, ArtifactPublication>;
}

export function artifactPartFromPublication(
  publication: ArtifactPublication,
): ProjectedArtifactPart {
  return {
    type: "artifact",
    content: artifactPartContent(publication.ref),
    artifact: publication.ref,
    publishedAt: publication.publishedAt,
    conversationSequence: publication.conversationSequence,
    sourcePartId: `artifact:${publication.ref.publicationId}`,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function publicationKey(artifactId: string, revision: number): string {
  return `${artifactId}\u0000${revision}`;
}

/** Visit a row's parts and the parts nested in groups and tasks, bounded. */
function visitParts(
  parts: unknown,
  visit: (part: Record<string, unknown>) => void,
  depth = 0,
): void {
  if (depth > MAX_PART_DEPTH || !Array.isArray(parts)) return;
  for (const raw of parts) {
    const part = record(raw);
    if (!part) continue;
    visit(part);
    visitParts(part.parts, visit, depth + 1);
    visitParts(part.childTools, visit, depth + 1);
    if (record(part.task)) visitParts([part.task], visit, depth + 1);
  }
}

/** `artifactId`/`revision` key of a successful publish call, or null. */
function publishCallTarget(part: Record<string, unknown>): string | null {
  if (part.type !== "tool-invocation" || part.toolState !== "success") return null;
  const tool = orkestratorToolName(
    typeof part.toolName === "string" ? part.toolName : undefined,
    ARTIFACT_TOOL_NAMES,
    {
      ...(typeof part.toolTitle === "string" ? { toolTitle: part.toolTitle } : {}),
      ...(typeof part.mcpServerName === "string" ? { mcpServerName: part.mcpServerName } : {}),
    },
  );
  if (tool !== "publish_artifact") return null;
  const args = record(part.toolArgs);
  const artifactId = args?.artifactId;
  const revision = args?.expectedRevision;
  if (typeof artifactId !== "string" || typeof revision !== "number") return null;
  return publicationKey(artifactId, revision);
}

function presentPublicationIds(parts: unknown, into: Set<string>): void {
  visitParts(parts, (part) => {
    if (part.type !== "artifact") return;
    const id = record(part.artifact)?.publicationId;
    if (typeof id === "string" && id.length > 0) into.add(id);
  });
}

const memo = new WeakMap<object, Map<string, object>>();

function overlaidRow<T>(row: T, overlay: ArtifactOverlay, added: ArtifactPublication[]): T {
  const base = row as unknown as Record<string, unknown>;
  const key = `${overlay.readId}\u0000${added.map((entry) => entry.publicationId).join(",")}`;
  let rows = memo.get(base);
  const hit = rows?.get(key);
  if (hit) return hit as T;
  const parts = Array.isArray(base.parts) ? base.parts : [];
  const next = {
    ...base,
    parts: [...parts, ...added.map(artifactPartFromPublication)],
  };
  if (!rows) {
    rows = new Map();
    memo.set(base, rows);
  }
  if (rows.size >= MEMO_KEYS_PER_ROW) rows.clear();
  rows.set(key, next);
  return next as unknown as T;
}

/**
 * The rows of one read with each publication placed beside its call. Returns
 * the input array itself when nothing was added, and never mutates a row.
 * Idempotent: a publication already present as a part is not added again.
 */
export function overlayArtifactParts<T>(
  rows: readonly T[],
  overlay: ArtifactOverlay | null | undefined,
): T[] {
  if (!overlay || overlay.publications.length === 0 || rows.length === 0) return rows as T[];
  const placed = new Set<string>();
  for (const row of rows) presentPublicationIds(record(row)?.parts, placed);
  const additions = new Map<number, ArtifactPublication[]>();
  const add = (index: number, publication: ArtifactPublication) => {
    placed.add(publication.ref.publicationId);
    const list = additions.get(index) ?? [];
    list.push(publication);
    additions.set(index, list);
  };
  // Pass 1: the call the backend recorded as publishing wins.
  if (overlay.byToolCall.size > 0) {
    rows.forEach((row, index) => {
      visitParts(record(row)?.parts, (part) => {
        const id = part.toolUseId;
        if (typeof id !== "string") return;
        const publication = overlay.byToolCall.get(id);
        if (publication && !placed.has(publication.ref.publicationId)) add(index, publication);
      });
    });
  }
  // Pass 2: a successful publish call whose arguments name the revision.
  rows.forEach((row, index) => {
    visitParts(record(row)?.parts, (part) => {
      const target = publishCallTarget(part);
      if (!target) return;
      const publication = overlay.byTarget.get(target);
      if (publication && !placed.has(publication.ref.publicationId)) add(index, publication);
    });
  });
  if (additions.size === 0) return rows as T[];
  return rows.map((row, index) => {
    const added = additions.get(index);
    if (!added) return row;
    added.sort((a, b) => a.conversationSequence - b.conversationSequence);
    return overlaidRow(row, overlay, added);
  });
}

/** Publication ids carried as artifact parts anywhere in these rows. */
export function artifactPublicationIds(rows: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) presentPublicationIds(record(row)?.parts, ids);
  return ids;
}

/**
 * Per-conversation ledger reads, re-read only when the conversation's ledger
 * revision moves. Bounded by conversation count; each conversation keeps at
 * most `ARTIFACT_OVERLAY_RETAINED` publications. A failed read never fails a
 * transcript: it yields the last good read, or no overlay.
 */
export class ArtifactOverlayIndex {
  private readonly entries = new Map<string, ArtifactOverlay>();
  private reads = 0;
  private subscribed: ArtifactLedgerReader | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly reader: () => ArtifactLedgerReader | null | undefined) {}

  /**
   * The ledger revision alone cannot tell a conversation whose publications
   * were deleted and whose sequence restarted from the read kept for it, so
   * every post-commit hint also drops that conversation's read.
   */
  private subscribe(ledger: ArtifactLedgerReader): void {
    if (this.subscribed === ledger || typeof ledger.onLedgerChange !== "function") return;
    this.unsubscribe?.();
    this.subscribed = ledger;
    this.unsubscribe = ledger.onLedgerChange((change) => {
      this.entries.delete(`${change.environmentId}\u0000${change.conversationKey}`);
    });
  }

  overlay(environmentId: string, conversationKey: string): ArtifactOverlay | null {
    let ledger: ArtifactLedgerReader | null | undefined;
    try {
      ledger = this.reader();
    } catch {
      return null;
    }
    if (!ledger) return null;
    try {
      this.subscribe(ledger);
    } catch {
      // Hints only accelerate; the revision check below still applies.
    }
    const key = `${environmentId}\u0000${conversationKey}`;
    const cached = this.entries.get(key);
    let revision: number;
    try {
      revision = ledger.ledgerRevision(environmentId, conversationKey);
    } catch {
      return cached ?? null;
    }
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      this.entries.delete(key);
      return null;
    }
    if (cached && cached.revision === revision) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    let publications: ArtifactPublication[];
    try {
      publications = this.readLedger(ledger, environmentId, conversationKey);
    } catch {
      return cached ?? null;
    }
    const byToolCall = new Map<string, ArtifactPublication>();
    const byTarget = new Map<string, ArtifactPublication>();
    for (const publication of publications) {
      byTarget.set(
        publicationKey(publication.ref.artifactId, publication.ref.revision),
        publication,
      );
      const toolCallId = publication.anchor?.toolCallId;
      if (typeof toolCallId === "string" && toolCallId.length > 0) {
        byToolCall.set(toolCallId, publication);
      }
    }
    this.reads += 1;
    const overlay: ArtifactOverlay = {
      environmentId,
      conversationKey,
      revision,
      readId: `ledger-${this.reads}`,
      publications,
      byToolCall,
      byTarget,
    };
    this.entries.delete(key);
    this.entries.set(key, overlay);
    while (this.entries.size > ARTIFACT_OVERLAY_CACHED_CONVERSATIONS) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return overlay;
  }

  clear(): void {
    this.entries.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.subscribed = undefined;
  }

  private readLedger(
    ledger: ArtifactLedgerReader,
    environmentId: string,
    conversationKey: string,
  ): ArtifactPublication[] {
    const all: ArtifactPublication[] = [];
    let after = 0;
    for (let page = 0; page < ARTIFACT_OVERLAY_MAX_PAGES; page += 1) {
      const entries = ledger.publicationsForConversation(environmentId, conversationKey, {
        afterSequence: after,
        limit: ARTIFACT_OVERLAY_PAGE_SIZE,
      });
      const start = after;
      for (const publication of entries) {
        const sequence = publication.conversationSequence;
        if (!Number.isSafeInteger(sequence) || sequence <= after) continue;
        after = sequence;
        // The ledger already scopes by owner; never trust that alone.
        if (
          publication.owner?.environmentId !== environmentId ||
          publication.owner.conversationKey !== conversationKey ||
          publication.ref?.publicationId !== publication.publicationId
        ) {
          continue;
        }
        all.push(publication);
      }
      if (all.length > ARTIFACT_OVERLAY_RETAINED) {
        all.splice(0, all.length - ARTIFACT_OVERLAY_RETAINED);
      }
      if (entries.length < ARTIFACT_OVERLAY_PAGE_SIZE || after === start) break;
    }
    return all;
  }
}
