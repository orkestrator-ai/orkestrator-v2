/**
 * The publication ledger: synchronous, authoritative reads for transcript
 * projection, plus post-commit change hints.
 *
 * Projection integration (native-agent-transcript-projection.ts) reads
 * `publicationsForConversation` and `ledgerRevision` when it builds or
 * reconciles a conversation; `onLedgerChange` only accelerates delivery. A
 * listener that misses a hint loses nothing: the ledger revision moves with
 * every publication, so a gap is detectable and the reads recover it.
 */
import type { ArtifactPublication } from "@orkestrator/protocol/transcript-artifacts";
import { logArtifactEvent } from "./metrics.js";
import type { TranscriptArtifactStore } from "./store.js";
import type { StoredPublication } from "./store-records.js";

export const LEDGER_READ_LIMIT = 1_000;

export interface ArtifactLedgerChange {
  environmentId: string;
  conversationKey: string;
  publicationId: string;
  /** Conversation sequence of the publication, which is also the new ledger revision. */
  ledgerRevision: number;
}

export type ArtifactLedgerListener = (change: ArtifactLedgerChange) => void;

export class ArtifactLedger {
  private readonly listeners = new Set<ArtifactLedgerListener>();

  constructor(
    private readonly store: TranscriptArtifactStore,
    private readonly backendId: () => string,
  ) {}

  /**
   * Publications of one conversation in conversation-sequence order, at most
   * `limit` (default 1,000) starting after `afterSequence`. Records from
   * another backend never appear. Unreadable rows are skipped (and logged).
   */
  publicationsForConversation(
    environmentId: string,
    conversationKey: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): StoredPublication[] {
    const limit = Math.max(1, Math.min(LEDGER_READ_LIMIT, options.limit ?? LEDGER_READ_LIMIT));
    const after = options.afterSequence ?? 0;
    let records;
    try {
      if (this.store.isDeleted(environmentId)) return [];
      records = this.store.records(environmentId);
    } catch {
      return [];
    }
    const result: StoredPublication[] = [];
    let entries: StoredPublication[];
    try {
      entries = records.list("publication", { owner: conversationKey });
    } catch {
      logArtifactEvent("ledger-read-failed", { environmentId });
      return [];
    }
    for (const publication of entries) {
      if (
        publication.owner.backendId !== this.backendId() ||
        publication.owner.environmentId !== environmentId ||
        publication.owner.conversationKey !== conversationKey ||
        publication.conversationSequence <= after
      ) {
        continue;
      }
      result.push(publication);
    }
    return result.sort((a, b) => a.conversationSequence - b.conversationSequence).slice(0, limit);
  }

  /** Monotonic per conversation: the latest publication sequence (0 when none). */
  ledgerRevision(environmentId: string, conversationKey: string): number {
    try {
      if (this.store.isDeleted(environmentId)) return 0;
      return this.store.records(environmentId).get("conversation", conversationKey)?.sequence ?? 0;
    } catch {
      return 0;
    }
  }

  onLedgerChange(listener: ArtifactLedgerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called after commit only. Listener failures never affect the publication. */
  notify(change: ArtifactLedgerChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        logArtifactEvent("ledger-listener-failed", { publicationId: change.publicationId });
      }
    }
    try {
      this.store.transact(change.environmentId, (records) => {
        const event = records.get("outbox", change.publicationId);
        if (event && !event.deliveredAt) {
          records.put("outbox", change.publicationId, {
            ...event,
            deliveredAt: new Date().toISOString(),
          });
        }
      });
    } catch {
      // The outbox is a hint; the ledger stays authoritative.
    }
  }
}

export type { ArtifactPublication };
