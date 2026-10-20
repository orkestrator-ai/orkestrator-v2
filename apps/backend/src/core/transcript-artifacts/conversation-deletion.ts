/**
 * Explicit conversation deletion for transcript artifacts.
 *
 * One write transaction sets the conversation's deletion fence (a `deletedAt`
 * tombstone on its `conversations` row, checked by every write that adds
 * records for a conversation) and removes the conversation's heads,
 * revisions, derived representations, operations, receipts, publications
 * and their uniqueness keys, idempotency rows, repair counters, staged
 * uploads and outbox events. A late preview completion for the conversation
 * fails the fence and is discarded; it cannot recreate anything.
 *
 * Binary bytes are content-addressed and may be shared with another
 * conversation in the environment, so nothing is unlinked here: bytes no
 * longer referenced are marked and the collector removes them after its
 * usual grace period, re-checking references under the store lock.
 *
 * Never triggered by closing a tab, scrolling, or an environment going
 * inactive. No product path calls this yet: the product has no explicit
 * native-conversation deletion (closing a tab retains the conversation).
 */
import type { ArtifactServiceContext } from "./service-context.js";
import { referencedAssets } from "./gc.js";

export interface ConversationDeletion {
  /** Artifacts whose live capabilities must be revoked. */
  artifactIds: string[];
  /** Operations that may still be running in this process. */
  operationIds: string[];
  /** Records removed (all kinds). */
  removed: number;
}

export function deleteConversationRecords(
  ctx: ArtifactServiceContext,
  environmentId: string,
  conversationKey: string,
): ConversationDeletion {
  return ctx.store.transact(environmentId, (records) => {
    const now = ctx.iso();
    const conversation = records.get("conversation", conversationKey);
    records.put("conversation", conversationKey, {
      schemaVersion: 1,
      conversationKey,
      sequence: conversation?.sequence ?? 0,
      deletedAt: conversation?.deletedAt ?? now,
    });
    let removed = 0;
    const artifactIds: string[] = [];
    for (const head of records.list("head", { owner: conversationKey })) {
      if (head.owner.conversationKey !== conversationKey) continue;
      artifactIds.push(head.artifactId);
      records.delete("head", head.artifactId);
      removed += 1;
    }
    const owned = new Set(artifactIds);
    const prefixed = (key: string) => owned.has(key.slice(0, key.indexOf("/")));
    for (const kind of ["revision", "derived", "repair"] as const) {
      for (const key of records.keys(kind)) {
        if (!prefixed(key)) continue;
        records.delete(kind, key);
        removed += 1;
      }
    }
    for (const receipt of records.list("receipt")) {
      if (!owned.has(receipt.artifactId) && receipt.owner.conversationKey !== conversationKey)
        continue;
      records.delete("receipt", receipt.receiptId);
      removed += 1;
    }
    const operationIds: string[] = [];
    for (const operation of records.list("operation", { owner: conversationKey })) {
      operationIds.push(operation.operationId);
      records.delete("operation", operation.operationId);
      removed += 1;
    }
    for (const publication of records.list("publication", { owner: conversationKey })) {
      records.deletePublicationKey(publication.artifactId, publication.revision);
      records.delete("publication", publication.publicationId);
      removed += 1;
    }
    for (const key of records.keys("idempotency", { owner: conversationKey })) {
      records.delete("idempotency", key);
      removed += 1;
    }
    for (const key of records.keys("staged", { owner: conversationKey })) {
      records.delete("staged", key);
      removed += 1;
    }
    for (const event of records.list("outbox")) {
      if (event.conversationKey !== conversationKey) continue;
      records.delete("outbox", event.eventId);
      removed += 1;
    }
    // Bytes now unreferenced start the collector's grace period.
    const referenced = referencedAssets(records);
    for (const row of records.list("asset")) {
      if (referenced.has(row.sha256) || row.unreferencedSince !== null) continue;
      records.put("asset", row.sha256, { ...row, unreferencedSince: now });
    }
    return { artifactIds, operationIds, removed };
  });
}
