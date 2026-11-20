import { createHash } from "node:crypto";
import type {
  ContentRef,
  ResultReviewResult,
  ResultReviewSpec,
} from "@orkestrator/protocol/rich-interactions";
import { RichInteractionError } from "./errors.js";
import type { RichInteractionTx, StoredDeliverable, StoredRequest } from "./store.js";

/**
 * Session deliverables (feature 13): the user's organization of a
 * conversation's published outputs. The authoritative artifact history stays
 * in the transcript-artifact publication ledger; these rows hold only what the
 * person adds on top (pin, label, group, selected revision) plus the revision
 * a human accepted through a result review. Nothing here copies an artifact
 * body or rewrites an artifact's own title.
 */

export const DELIVERABLE_LIMITS = {
  perConversation: 500,
  labelChars: 120,
  groupChars: 60,
} as const;

export function deliverableIdFor(
  environmentId: string,
  logicalSessionKey: string,
  artifactId: string,
): string {
  return `dl_${createHash("sha256").update(environmentId).update("\0").update(logicalSessionKey).update("\0").update(artifactId).digest("hex").slice(0, 32)}`;
}

export interface DeliverablePatch {
  pinned?: boolean;
  userLabel?: string | null;
  selectedRevision?: number | null;
  group?: string | null;
}

export function applyDeliverablePatch(
  tx: RichInteractionTx,
  input: {
    environmentId: string;
    logicalSessionKey: string;
    artifactId: string;
    expectedRevision: number;
    patch: DeliverablePatch;
    now: string;
  },
): StoredDeliverable | { conflict: StoredDeliverable } {
  const deliverableId = deliverableIdFor(
    input.environmentId,
    input.logicalSessionKey,
    input.artifactId,
  );
  const current = tx.getDeliverable(deliverableId);
  if ((current?.revision ?? 0) !== input.expectedRevision) return { conflict: current! };
  if (
    !current &&
    tx.listDeliverables(input.environmentId, input.logicalSessionKey).length >=
      DELIVERABLE_LIMITS.perConversation
  ) {
    throw new RichInteractionError(
      "capacity",
      `A conversation keeps metadata for at most ${DELIVERABLE_LIMITS.perConversation} deliverables`,
    );
  }
  const base: StoredDeliverable = current ?? {
    deliverableId,
    environmentId: input.environmentId,
    logicalSessionKey: input.logicalSessionKey,
    artifactId: input.artifactId,
    pinned: false,
    revision: 0,
    updatedAt: input.now,
  };
  const next: StoredDeliverable = { ...base, revision: base.revision + 1, updatedAt: input.now };
  const { patch } = input;
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.userLabel !== undefined) {
    if (patch.userLabel === null || !patch.userLabel.trim()) delete next.userLabel;
    else next.userLabel = patch.userLabel.trim().slice(0, DELIVERABLE_LIMITS.labelChars);
  }
  if (patch.group !== undefined) {
    if (patch.group === null || !patch.group.trim()) delete next.group;
    else next.group = patch.group.trim().slice(0, DELIVERABLE_LIMITS.groupChars);
  }
  if (patch.selectedRevision !== undefined) {
    if (patch.selectedRevision === null) delete next.selectedRevision;
    else next.selectedRevision = patch.selectedRevision;
  }
  tx.putDeliverable(next);
  return next;
}

/**
 * A recorded human acceptance of a result review marks the reviewed artifact
 * revisions accepted. Runs inside the submission's transaction, so the
 * acceptance and its receipt commit together. Accepting revision 2 is never
 * overwritten by a later publication of revision 3.
 */
export function recordAcceptedArtifacts(
  tx: RichInteractionTx,
  request: StoredRequest,
  actionId: string,
  result: unknown,
  now: string,
  isPublished: (ref: Extract<ContentRef, { kind: "artifact" }>) => boolean,
): void {
  if (request.kind !== "result-review" || (actionId !== "accept" && actionId !== "accept-selected"))
    return;
  const decision = result as ResultReviewResult;

  const spec = request.spec as ResultReviewSpec;
  for (const comparison of spec.comparisons) {
    if (comparison.after?.kind !== "artifact") continue;
    if (!isPublished(comparison.after))
      throw new RichInteractionError(
        "unavailable",
        "A reviewed artifact revision is unavailable in this conversation.",
      );
    if (decision.decision !== "accept") continue;
    const { artifactId, revision } = comparison.after;
    const deliverableId = deliverableIdFor(
      request.owner.environmentId,
      request.owner.logicalSessionKey,
      artifactId,
    );
    const current = tx.getDeliverable(deliverableId);
    const metadata =
      current ??
      applyDeliverablePatch(tx, {
        environmentId: request.owner.environmentId,
        logicalSessionKey: request.owner.logicalSessionKey,
        artifactId,
        expectedRevision: 0,
        patch: {},
        now,
      });
    if ("conflict" in metadata)
      throw new RichInteractionError("conflict", "The deliverable changed during acceptance.");
    tx.putDeliverable({
      ...metadata,
      acceptedRevision: revision,
      revision: current ? current.revision + 1 : metadata.revision,
      updatedAt: now,
    });
  }
}
