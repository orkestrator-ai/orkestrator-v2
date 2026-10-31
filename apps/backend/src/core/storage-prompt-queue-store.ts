import { restoreLegacyPromptQueueClaims } from "./storage-record-upgrades.js";
import type { PersistedPromptQueue } from "./models.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";
import { isNonBlankString, isPersistedPromptQueue, isRecord, nowIso } from "./storage-shared.js";

/**
 * The prompt-queue store: its lease, load and save, and recovery of the
 * delivery claims an older backend left behind. Most operations on queued
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

  async savePromptQueueMutation(
    queues: Record<string, PersistedPromptQueue>,
    queueKey: string,
    environmentId: string,
    messages: unknown[],
    previous?: PersistedPromptQueue,
  ): Promise<PersistedPromptQueue> {
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
    const saved: PersistedPromptQueue = {
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
    queues[queueKey] = saved;
    await this.context.saveSensitiveJson(this.files.promptQueuesFile(), queues);
    this.context.changes.announce("prompt-queue", environmentId);
    return saved;
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

  async loadPromptQueues(): Promise<Record<string, PersistedPromptQueue>> {
    const stored = await this.context.loadJson<Record<string, PersistedPromptQueue>>(
      this.files.promptQueuesFile(),
      () => ({}),
    );
    // A first-generation dispatch error was upgraded once at import
    // (storage-record-upgrades.ts); every stored error identifies its item.
    // Expired legacy claims return to the head on every load. Live claims
    // retain their exclusion and must survive every queue mutation.
    return Object.fromEntries(
      Object.entries(restoreLegacyPromptQueueClaims(stored) as typeof stored).filter(
        ([storedKey, queue]) => isPersistedPromptQueue(queue, storedKey),
      ),
    );
  }
}
