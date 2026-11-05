import { restoreLegacyPromptQueueClaims } from "./storage-record-upgrades.js";
import type { PersistedPromptQueue } from "./models.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";
import { isNonBlankString, isPersistedPromptQueue, isRecord, nowIso } from "./storage-shared.js";

/** What a queue mutation does with its row: leave it, or replace it with `value`. */
export type PromptQueueUpdate<T> = { result: T; value?: PersistedPromptQueue };

/** The claim recovery and validation {@link PromptQueueStore.loadPromptQueues} applies to a row. */
function decodePromptQueueRow(queueKey: string, stored: unknown): PersistedPromptQueue | undefined {
  const restored = restoreLegacyPromptQueueClaims({ [queueKey]: stored }) as Record<
    string,
    unknown
  >;
  const queue = restored[queueKey];
  return isPersistedPromptQueue(queue, queueKey) ? queue : undefined;
}

/**
 * The prompt-queue store: its lease, row reads and row writes, and recovery of
 * the delivery claims an older backend left behind. Most operations on queued
 * items live in `PromptsRepository`; a queued steer's reservation and
 * settlement in `NativeAgentDeliveries`.
 */
export class PromptQueueStore {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly repos: StorageRepositories,
  ) {}

  enqueuePromptQueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.promptQueuesFile(), "prompt queue storage", operation);
  }

  validatePromptQueueMessages(messages: unknown): asserts messages is unknown[] {
    if (!Array.isArray(messages)) {
      throw new Error("Prompt queue messages must be an array");
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(messages);
    } catch {
      throw new Error("Prompt queue messages must be JSON serializable");
    }
    if (serialized === undefined) {
      throw new Error("Prompt queue messages must be JSON serializable");
    }
    // Queued prompts carry pasted image attachments, so the ceiling has to be
    // generous; it exists to stop a runaway client, not to bound normal use.
    if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Prompt queue exceeds the 32 MB limit");
    }
  }

  validatePromptQueueMessage(message: unknown): asserts message is Record<string, unknown> {
    if (!isRecord(message) || !isNonBlankString(message.id)) {
      throw new Error("Prompt queue message must have a non-blank ID");
    }
    this.validatePromptQueueMessages([message]);
  }

  /**
   * One queue's read-modify-write in one transaction, under the queue lease.
   * `mutate` sees the queue as a load would and never another queue's row; it
   * must not await, and if it throws nothing is written. An unreadable row reads
   * as absent, so the write replaces it, as a whole-value save replaced an
   * unreadable store. A written queue is announced after the commit unless the
   * caller has more to commit first (`announce: false`).
   */
  updatePromptQueue<T>(
    queueKey: string,
    mutate: (previous: PersistedPromptQueue | undefined) => PromptQueueUpdate<T>,
    options: { announce?: boolean } = {},
  ): T {
    let written: PersistedPromptQueue | undefined;
    const result = this.context.updateSensitiveStoreRow(
      this.files.promptQueuesFile(),
      queueKey,
      (stored) => {
        const update = mutate(decodePromptQueueRow(queueKey, stored));
        written = update.value;
        return written ? { result: update.result, value: written } : { result: update.result };
      },
      { unreadableRow: "replace" },
    );
    if (written && options.announce !== false) {
      this.context.changes.announce("prompt-queue", written.environmentId);
    }
    return result;
  }

  /** `previous` with `messages` as its new list; the caller writes the row. */
  nextPromptQueue(
    queueKey: string,
    environmentId: string,
    messages: unknown[],
    previous?: PersistedPromptQueue,
  ): PersistedPromptQueue {
    this.validatePromptQueueMessages(messages);
    // A stale whole-list save must not publish a second copy of a live claim.
    const claimedId = previous?.outstandingClaim?.message.id;
    if (isNonBlankString(claimedId)) {
      messages = messages.filter((candidate) => !isRecord(candidate) || candidate.id !== claimedId);
    }
    const failedMessageStillUnchanged =
      previous?.dispatchError !== undefined &&
      messages.some(
        (candidate) =>
          isRecord(candidate) &&
          candidate.id === previous.dispatchError?.messageId &&
          this.repos.prompts.promptQueueMessageFingerprint(candidate) ===
            previous.dispatchError?.messageFingerprint,
      );
    const removedOrigins = this.promptQueueRemovedOrigins(previous, messages);
    return {
      queueKey,
      environmentId,
      messages,
      ...(previous?.jobReceipts ? { jobReceipts: previous.jobReceipts } : {}),
      ...(previous?.outstandingClaim ? { outstandingClaim: previous.outstandingClaim } : {}),
      ...(previous?.inFlight ? { inFlight: previous.inFlight } : {}),
      ...(failedMessageStillUnchanged ? { dispatchError: previous!.dispatchError } : {}),
      ...(removedOrigins.length > 0 ? { removedOrigins } : {}),
      updatedAt: nowIso(),
      revision: (previous?.revision ?? 0) + 1,
    };
  }

  /**
   * For a mutation that awaits between reading `previous` and writing, so cannot
   * run inside {@link updatePromptQueue}'s transaction. The lease holds `previous`.
   */
  savePromptQueueMutation(
    queueKey: string,
    environmentId: string,
    messages: unknown[],
    previous?: PersistedPromptQueue,
  ): PersistedPromptQueue {
    const saved = this.nextPromptQueue(queueKey, environmentId, messages, previous);
    return this.updatePromptQueue(queueKey, () => ({ result: saved, value: saved }));
  }

  /**
   * Tombstones for backend-authored items (a typed `origin` with a request id)
   * that leave `messages` in this save without moving into the in-flight
   * reservation: they were removed or replaced before dispatch.
   * Reservation writes the in-flight record directly and never comes through
   * here, so a dispatched item can never be tombstoned.
   */
  private promptQueueRemovedOrigins(
    previous: PersistedPromptQueue | undefined,
    messages: readonly unknown[],
  ): Array<{ requestId: string; removedAt: string }> {
    const existing = previous?.removedOrigins ?? [];
    if (!previous) return existing;
    const kept = new Set<unknown>();
    for (const candidate of [
      ...messages,
      previous.outstandingClaim?.message,
      previous.inFlight?.message,
    ]) {
      if (isRecord(candidate)) kept.add(candidate.id);
    }
    const added: Array<{ requestId: string; removedAt: string }> = [];
    for (const candidate of previous.messages) {
      if (!isRecord(candidate) || kept.has(candidate.id) || !isRecord(candidate.origin)) continue;
      const requestId = candidate.origin.requestId;
      if (!isNonBlankString(requestId) || requestId.length > 512) continue;
      if (existing.some((entry) => entry.requestId === requestId)) continue;
      added.push({ requestId, removedAt: nowIso() });
    }
    return added.length === 0 ? existing : [...existing, ...added].slice(-64);
  }

  /** One queue, with the same claim recovery and validation as {@link loadPromptQueues}. */
  loadPromptQueue(queueKey: string): PersistedPromptQueue | null {
    const stored = this.context.loadStoreRow(this.files.promptQueuesFile(), queueKey);
    if (stored === undefined) return null;
    return decodePromptQueueRow(queueKey, stored) ?? null;
  }

  /**
   * Every readable queue, for what walks the store. No mutation needs this: it
   * decodes every queue, attachments included.
   */
  async loadPromptQueues(): Promise<Record<string, PersistedPromptQueue>> {
    const stored = await this.readStoredPromptQueues();
    // A first-generation dispatch error was upgraded once at import
    // (storage-record-upgrades.ts); every stored error identifies its item.
    // Expired legacy claims return to the head on every load. Live claims
    // retain their exclusion and must survive every queue mutation.
    return Object.fromEntries(
      Object.entries(restoreLegacyPromptQueueClaims(stored) as Record<string, unknown>).filter(
        (entry): entry is [string, PersistedPromptQueue] =>
          isPersistedPromptQueue(entry[1], entry[0]),
      ),
    );
  }

  /**
   * Removes an environment's rows, one row write each, so another queue's row
   * is never rewritten and each removal journals its own archive cleanup. A
   * crash part-way leaves the rest for a retry, which the caller's environment
   * record still allows. A row that names no environment goes too, since it
   * cannot be shown to belong to a live one; a row naming another environment
   * stays even when this build cannot read it. Returns the removed queues' keys.
   */
  async deletePromptQueuesOwnedBy(environmentId: string): Promise<string[]> {
    const removedKeys: string[] = [];
    for (const [queueKey, stored] of Object.entries(await this.readStoredPromptQueues())) {
      const owner = isRecord(stored) ? stored.environmentId : undefined;
      if (isNonBlankString(owner) && owner !== environmentId) continue;
      this.context.updateSensitiveStoreRow(
        this.files.promptQueuesFile(),
        queueKey,
        () => ({ result: undefined, delete: true }),
        { unreadableRow: "replace" },
      );
      if (decodePromptQueueRow(queueKey, stored)) removedKeys.push(queueKey);
    }
    return removedKeys;
  }

  /**
   * The stored records, row by row, with an unreadable row's value `undefined`.
   * A row write leaves every other row alone, so nothing would replace a bad row
   * as a whole-value save did. Read whole, it would hide every queue from the
   * drain scans and from environment deletion for good.
   */
  private async readStoredPromptQueues(): Promise<Record<string, unknown>> {
    const filePath = this.files.promptQueuesFile();
    const serialized = this.context.loadStoreSerialized(filePath);
    if (serialized === null) return {};
    if (serialized === undefined || serialized.mode === "document") {
      const whole = await this.context.loadJson<unknown>(filePath, () => ({}));
      return isRecord(whole) ? whole : {};
    }
    return Object.fromEntries(
      [...serialized.rows]
        .sort((a, b) => a.position - b.position)
        .map((row) => {
          try {
            return [row.key, JSON.parse(row.value) as unknown];
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            return [row.key, undefined];
          }
        }),
    );
  }
}
