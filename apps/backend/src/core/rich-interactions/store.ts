import type {
  RichInteractionDraft,
  RichInteractionReceipt,
  RichInteractionRequest,
} from "@orkestrator/protocol/rich-interactions";
import type { StorageDatabase } from "../storage-database.js";
import {
  RICH_DELIVERABLES_STORE,
  RICH_INTERACTION_DRAFTS_STORE,
  RICH_INTERACTION_RECEIPTS_STORE,
  RICH_INTERACTION_REQUESTS_STORE,
} from "./layout.js";

/**
 * Rows of the rich interaction stores. Every mutation runs inside one
 * synchronous SQLite transaction (`atomic`), so a submission's receipt, its
 * request revision and its dispatch intent commit together or not at all, and
 * two backends sharing a data directory serialize on SQLite's write lock.
 * Announcements are published only after the commit.
 *
 * Reads skip a row that does not parse rather than fail: an unreadable request
 * offers no action, which is the fail-closed direction.
 */

export interface StoredRequest extends RichInteractionRequest {
  /** Digest of the create input, for requestKey replay/conflict. */
  createFingerprint: string;
}

export interface StoredReceipt extends RichInteractionReceipt {
  environmentId: string;
  logicalSessionKey: string;
  /** For follow-ups: the exact prompt text queued, so a retry re-enqueues identical bytes. */
  dispatchText?: string;
  dispatchAttempts: number;
}

export interface StoredDraft extends RichInteractionDraft {
  environmentId: string;
}

export interface StoredDeliverable {
  deliverableId: string;
  environmentId: string;
  logicalSessionKey: string;
  artifactId: string;
  pinned: boolean;
  userLabel?: string;
  /** Revision the user chose to keep selected in the panel. */
  selectedRevision?: number;
  /** Revision a human accepted, recorded from a result review. */
  acceptedRevision?: number;
  group?: string;
  revision: number;
  updatedAt: string;
}

function parse<T>(
  raw: string | undefined,
  check: (value: Record<string, unknown>) => boolean,
): T | null {
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return check(value as Record<string, unknown>) ? (value as T) : null;
  } catch {
    return null;
  }
}

const isRequest = (v: Record<string, unknown>) =>
  v.schemaVersion === 1 &&
  typeof v.interactionId === "string" &&
  typeof v.revision === "number" &&
  typeof v.kind === "string" &&
  !!v.owner;
const isReceipt = (v: Record<string, unknown>) =>
  typeof v.receiptId === "string" &&
  typeof v.interactionId === "string" &&
  typeof v.environmentId === "string";
const isDraft = (v: Record<string, unknown>) =>
  typeof v.interactionId === "string" && typeof v.revision === "number";
const isDeliverable = (v: Record<string, unknown>) =>
  typeof v.deliverableId === "string" && typeof v.artifactId === "string";

/** Typed row access inside one transaction. */
export class RichInteractionTx {
  readonly announced = new Map<string, Set<string>>();

  constructor(private readonly database: StorageDatabase) {}

  private exists(store: string): boolean {
    return this.database.hasStore(store);
  }

  announce(environmentId: string, interactionId: string): void {
    let ids = this.announced.get(environmentId);
    if (!ids) this.announced.set(environmentId, (ids = new Set()));
    ids.add(interactionId);
  }

  getRequest(interactionId: string): StoredRequest | null {
    if (!this.exists(RICH_INTERACTION_REQUESTS_STORE)) return null;
    const request = parse<StoredRequest>(
      this.database.rows(RICH_INTERACTION_REQUESTS_STORE).get(interactionId),
      isRequest,
    );
    return request?.interactionId === interactionId ? request : null;
  }

  listRequests(environmentId: string): StoredRequest[] {
    if (!this.exists(RICH_INTERACTION_REQUESTS_STORE)) return [];
    const out: StoredRequest[] = [];
    for (const entry of this.database
      .rows(RICH_INTERACTION_REQUESTS_STORE)
      .list({ values: true, owner: environmentId })) {
      const request = parse<StoredRequest>(entry.value ?? undefined, isRequest);
      if (
        request &&
        request.interactionId === entry.key &&
        request.owner.environmentId === environmentId
      )
        out.push(request);
    }
    return out.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.interactionId.localeCompare(b.interactionId),
    );
  }

  putRequest(request: StoredRequest): void {
    this.database
      .rows(RICH_INTERACTION_REQUESTS_STORE)
      .put(request.interactionId, JSON.stringify(request));
    this.announce(request.owner.environmentId, request.interactionId);
  }

  deleteRequest(request: StoredRequest): void {
    this.database.rows(RICH_INTERACTION_REQUESTS_STORE).delete(request.interactionId);
    this.announce(request.owner.environmentId, request.interactionId);
  }

  getReceipt(receiptId: string): StoredReceipt | null {
    if (!this.exists(RICH_INTERACTION_RECEIPTS_STORE)) return null;
    const receipt = parse<StoredReceipt>(
      this.database.rows(RICH_INTERACTION_RECEIPTS_STORE).get(receiptId),
      isReceipt,
    );
    return receipt?.receiptId === receiptId ? receipt : null;
  }

  listReceipts(environmentId: string, interactionId?: string): StoredReceipt[] {
    if (!this.exists(RICH_INTERACTION_RECEIPTS_STORE)) return [];
    const out: StoredReceipt[] = [];
    for (const entry of this.database
      .rows(RICH_INTERACTION_RECEIPTS_STORE)
      .list({ values: true, owner: environmentId })) {
      const receipt = parse<StoredReceipt>(entry.value ?? undefined, isReceipt);
      if (
        receipt &&
        receipt.receiptId === entry.key &&
        (!interactionId || receipt.interactionId === interactionId)
      )
        out.push(receipt);
    }
    return out.sort(
      (a, b) =>
        a.submittedAt.localeCompare(b.submittedAt) || a.receiptId.localeCompare(b.receiptId),
    );
  }

  /** Every receipt in a delivery state that still needs work, across environments. */
  listOutstandingReceipts(states: ReadonlySet<string>, limit: number): StoredReceipt[] {
    if (!this.exists(RICH_INTERACTION_RECEIPTS_STORE)) return [];
    const out: StoredReceipt[] = [];
    for (const entry of this.database
      .rows(RICH_INTERACTION_RECEIPTS_STORE)
      .list({ values: true })) {
      const receipt = parse<StoredReceipt>(entry.value ?? undefined, isReceipt);
      if (receipt && states.has(receipt.delivery)) out.push(receipt);
      if (out.length >= limit) break;
    }
    return out;
  }

  putReceipt(receipt: StoredReceipt): void {
    this.database
      .rows(RICH_INTERACTION_RECEIPTS_STORE)
      .put(receipt.receiptId, JSON.stringify(receipt));
    this.announce(receipt.environmentId, receipt.interactionId);
  }

  getDraft(interactionId: string): StoredDraft | null {
    if (!this.exists(RICH_INTERACTION_DRAFTS_STORE)) return null;
    const draft = parse<StoredDraft>(
      this.database.rows(RICH_INTERACTION_DRAFTS_STORE).get(interactionId),
      isDraft,
    );
    return draft?.interactionId === interactionId ? draft : null;
  }

  putDraft(draft: StoredDraft): void {
    this.database
      .rows(RICH_INTERACTION_DRAFTS_STORE)
      .put(draft.interactionId, JSON.stringify(draft));
    this.announce(draft.environmentId, draft.interactionId);
  }

  deleteDraft(environmentId: string, interactionId: string): void {
    if (!this.exists(RICH_INTERACTION_DRAFTS_STORE)) return;
    if (this.database.rows(RICH_INTERACTION_DRAFTS_STORE).delete(interactionId))
      this.announce(environmentId, interactionId);
  }

  getDeliverable(deliverableId: string): StoredDeliverable | null {
    if (!this.exists(RICH_DELIVERABLES_STORE)) return null;
    return parse<StoredDeliverable>(
      this.database.rows(RICH_DELIVERABLES_STORE).get(deliverableId),
      isDeliverable,
    );
  }

  listDeliverables(environmentId: string, logicalSessionKey: string): StoredDeliverable[] {
    if (!this.exists(RICH_DELIVERABLES_STORE)) return [];
    const out: StoredDeliverable[] = [];
    for (const entry of this.database
      .rows(RICH_DELIVERABLES_STORE)
      .list({ values: true, owner: environmentId })) {
      const item = parse<StoredDeliverable>(entry.value ?? undefined, isDeliverable);
      if (item && item.logicalSessionKey === logicalSessionKey) out.push(item);
    }
    return out;
  }

  putDeliverable(item: StoredDeliverable): void {
    this.database.rows(RICH_DELIVERABLES_STORE).put(item.deliverableId, JSON.stringify(item));
    this.announce(item.environmentId, `deliverable:${item.deliverableId}`);
  }

  deleteEnvironment(environmentId: string): number {
    let removed = 0;
    if (this.exists(RICH_INTERACTION_REQUESTS_STORE))
      removed += this.database
        .rows(RICH_INTERACTION_REQUESTS_STORE)
        .deleteWhere({ owner: environmentId });
    if (this.exists(RICH_INTERACTION_RECEIPTS_STORE))
      removed += this.database
        .rows(RICH_INTERACTION_RECEIPTS_STORE)
        .deleteWhere({ owner: environmentId });
    if (this.exists(RICH_INTERACTION_DRAFTS_STORE))
      removed += this.database
        .rows(RICH_INTERACTION_DRAFTS_STORE)
        .deleteWhere({ owner: environmentId });
    if (this.exists(RICH_DELIVERABLES_STORE))
      removed += this.database.rows(RICH_DELIVERABLES_STORE).deleteWhere({ owner: environmentId });
    if (removed) this.announce(environmentId, "*");
    return removed;
  }
}

export interface RichInteractionStoreOptions {
  database: () => StorageDatabase;
  /** Called after commit with the environment and the interaction ids that changed. */
  announce?: (environmentId: string, interactionIds: string[]) => void;
}

export class RichInteractionStore {
  constructor(private readonly options: RichInteractionStoreOptions) {}

  /** Runs `work` in one transaction; announcements follow the commit. */
  atomic<T>(work: (tx: RichInteractionTx) => T): T {
    const database = this.options.database();
    const tx = new RichInteractionTx(database);
    const result = database.transaction(() => work(tx));
    for (const [environmentId, ids] of tx.announced)
      this.options.announce?.(environmentId, [...ids]);
    return result;
  }

  /** Reads outside a write transaction (each row read sees committed state). */
  read<T>(work: (tx: RichInteractionTx) => T): T {
    return work(new RichInteractionTx(this.options.database()));
  }
}
