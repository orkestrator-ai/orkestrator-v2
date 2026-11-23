import {
  MAX_PROMPT_QUEUE_EDIT_LEASES,
  PROMPT_QUEUE_EDIT_LEASE_MS,
  promptQueueEditLeaseExpired,
  promptQueueEditLeases,
  type PromptQueueEditBeginRefusal,
  type PromptQueueEditConflict,
  type PromptQueueEditLease,
} from "@orkestrator/protocol/prompt-queue-edit";
import { buildInitialPromptWithAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";
import type { PersistedPromptQueue } from "../models.js";
import { assertValidPromptAttachments, type PromptAttachment } from "../prompt-attachments.js";
import { promptQueueMessageFingerprint } from "./record-upgrades.js";
import type { StorageRepositories } from "./repositories.js";
import {
  assertPromptQueueKeyOwner,
  isNonBlankString,
  isRecord,
  nowIso,
  randomUUID,
} from "./shared.js";

export type PromptQueueEditBeginResult =
  | {
      status: "editing";
      lease: PromptQueueEditLease;
      message: unknown;
      tookOver?: true;
      queue: PersistedPromptQueue;
    }
  | {
      status: "refused";
      reason: PromptQueueEditBeginRefusal;
      expiresAt?: string;
      queue: PersistedPromptQueue | null;
    };

export type PromptQueueEditRenewResult =
  | { status: "renewed"; expiresAt: string }
  | { status: "conflict"; reason: PromptQueueEditConflict };

export type PromptQueueEditFinishResult =
  | { status: "committed" | "released"; queue: PersistedPromptQueue | null }
  | {
      status: "conflict";
      reason: PromptQueueEditConflict;
      current?: unknown;
      queue: PersistedPromptQueue | null;
    };

/** What a commit replaces: the text and the attachments, together. */
export interface PromptQueueEditCommit {
  text: string;
  /** Absent or empty removes the item's attachments. */
  attachments?: unknown;
}

interface EditTarget {
  queueKey: string;
  environmentId: string;
  messageId: string;
}

function validTarget(target: EditTarget): void {
  if (!isNonBlankString(target.queueKey)) throw new Error("Prompt queue key must not be blank");
  if (!isNonBlankString(target.environmentId)) {
    throw new Error("Prompt queue environment ID must not be blank");
  }
  if (!isNonBlankString(target.messageId)) {
    throw new Error("Prompt queue message ID must not be blank");
  }
  assertPromptQueueKeyOwner(target.queueKey, target.environmentId);
}

/**
 * Backend-authored items, slash commands and job receipts bind their intent
 * to the existing payload.
 */
function editable(queue: PersistedPromptQueue, message: Record<string, unknown>): boolean {
  if (isRecord(message.origin) && isNonBlankString(message.origin.kind)) return false;
  return (
    message.command === undefined &&
    !queue.jobReceipts?.some((receipt) => {
      const requestId = receipt.dispatchRequestId ?? receipt.requestId;
      return requestId === message.requestId || requestId === message.id;
    })
  );
}

/** The commit's attachments, checked: images and files by workspace path. */
function commitAttachments(value: unknown): PromptAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Queued prompt attachments must be an array");
  const attachments = assertValidPromptAttachments(value);
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      (candidate.type !== "image" && candidate.type !== "file") ||
      !isNonBlankString(candidate.path) ||
      (candidate.filename !== undefined && typeof candidate.filename !== "string") ||
      (candidate.dataUrl !== undefined && typeof candidate.dataUrl !== "string")
    ) {
      throw new Error("Queued prompt attachment must name an image or file by path");
    }
  }
  return attachments;
}

/** `queue` holding exactly `leases`, unchanged otherwise. */
function replaceLeases(
  queue: PersistedPromptQueue,
  leases: PromptQueueEditLease[],
): PersistedPromptQueue {
  const { editLeases: _previous, ...rest } = queue;
  return leases.length > 0 ? { ...rest, editLeases: leases } : rest;
}

/** The next revision of `queue` holding exactly `leases`. */
function withLeases(
  queue: PersistedPromptQueue,
  leases: PromptQueueEditLease[],
): PersistedPromptQueue {
  return {
    ...replaceLeases(queue, leases),
    updatedAt: nowIso(),
    revision: queue.revision + 1,
  };
}

function findMessage(
  queue: PersistedPromptQueue,
  messageId: string,
): { index: number; message: Record<string, unknown> } | null {
  const index = queue.messages.findIndex(
    (candidate) => isRecord(candidate) && candidate.id === messageId,
  );
  const message = queue.messages[index];
  return index >= 0 && isRecord(message) ? { index, message } : null;
}

/**
 * In-place edits of queued prompts (`@orkestrator/protocol/prompt-queue-edit`).
 * Every write runs under the prompt-queue lease, in the same row transaction
 * as the dispatch and steer reservations, so a reservation either sees the
 * lease and leaves the item alone or reserved it before the edit could begin.
 */
export class PromptQueueEditsRepository {
  constructor(private readonly repos: StorageRepositories) {}

  async beginPromptQueueMessageEdit(
    target: EditTarget,
    options: { takeOver?: boolean; now?: number } = {},
  ): Promise<PromptQueueEditBeginResult> {
    validTarget(target);
    const { queueKey, environmentId, messageId } = target;
    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
        environmentId,
        "Prompt queue",
      );
      return this.repos.promptQueues.updatePromptQueue<PromptQueueEditBeginResult>(
        queueKey,
        (previous) => {
          if (!previous) return { result: { status: "refused", reason: "missing", queue: null } };
          if (previous.environmentId !== environmentId) {
            throw new Error("Prompt queue belongs to another environment");
          }
          const found = findMessage(previous, messageId);
          if (!found) {
            return { result: { status: "refused", reason: "missing", queue: previous } };
          }
          if (!editable(previous, found.message)) {
            return { result: { status: "refused", reason: "frozen", queue: previous } };
          }
          const now = options.now ?? Date.now();
          const leases = promptQueueEditLeases(previous);
          const held = leases.find((lease) => lease.messageId === messageId);
          if (held && !promptQueueEditLeaseExpired(held, now) && options.takeOver !== true) {
            return {
              result: {
                status: "refused",
                reason: "held-elsewhere",
                expiresAt: held.expiresAt,
                queue: previous,
              },
            };
          }
          const others = leases.filter((lease) => lease.messageId !== messageId);
          if (others.length >= MAX_PROMPT_QUEUE_EDIT_LEASES) {
            throw new Error("Too many queued prompts are being edited at once");
          }
          const lease: PromptQueueEditLease = {
            messageId,
            leaseId: randomUUID(),
            acquiredAt: new Date(now).toISOString(),
            expiresAt: new Date(now + PROMPT_QUEUE_EDIT_LEASE_MS).toISOString(),
            baseFingerprint: promptQueueMessageFingerprint(found.message),
          };
          const queue = withLeases(previous, [...others, lease]);
          return {
            result: {
              status: "editing",
              lease,
              message: found.message,
              ...(held ? { tookOver: true as const } : {}),
              queue,
            },
            value: queue,
          };
        },
      );
    });
  }

  async renewPromptQueueMessageEdit(
    target: EditTarget & { leaseId: string },
    options: { now?: number } = {},
  ): Promise<PromptQueueEditRenewResult> {
    validTarget(target);
    if (!isNonBlankString(target.leaseId)) throw new Error("Edit lease ID must not be blank");
    const { queueKey, environmentId, messageId, leaseId } = target;
    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      return this.repos.promptQueues.updatePromptQueue<PromptQueueEditRenewResult>(
        queueKey,
        (previous) => {
          if (!previous) return { result: { status: "conflict", reason: "missing" } };
          if (previous.environmentId !== environmentId) {
            throw new Error("Prompt queue belongs to another environment");
          }
          if (!findMessage(previous, messageId)) {
            return { result: { status: "conflict", reason: "missing" } };
          }
          const leases = promptQueueEditLeases(previous);
          const held = leases.find((lease) => lease.messageId === messageId);
          // An expired lease nobody has taken over is still this client's.
          if (!held || held.leaseId !== leaseId) {
            return { result: { status: "conflict", reason: "lease-lost" } };
          }
          const expiresAt = new Date(
            (options.now ?? Date.now()) + PROMPT_QUEUE_EDIT_LEASE_MS,
          ).toISOString();
          const queue = withLeases(
            previous,
            leases.map((lease) => (lease === held ? { ...held, expiresAt } : lease)),
          );
          return { result: { status: "renewed", expiresAt }, value: queue };
        },
      );
    });
  }

  async finishPromptQueueMessageEdit(
    target: EditTarget & { leaseId: string },
    finish:
      { outcome: "cancel" | "release-expired" } | ({ outcome: "commit" } & PromptQueueEditCommit),
    options: { now?: number } = {},
  ): Promise<PromptQueueEditFinishResult> {
    validTarget(target);
    if (!isNonBlankString(target.leaseId)) throw new Error("Edit lease ID must not be blank");
    let replacement: { text: string; attachments: PromptAttachment[] } | undefined;
    if (finish.outcome === "commit") {
      if (typeof finish.text !== "string") throw new Error("Queued prompt text must be a string");
      const attachments = commitAttachments(finish.attachments);
      if (!finish.text.trim() && attachments.length === 0) {
        throw new Error("A queued prompt needs text or an attachment");
      }
      const text = finish.text.trim()
        ? finish.text
        : buildInitialPromptWithAttachmentReferences(
            "",
            attachments.map(({ filename, path }) => ({
              name: filename ?? path.split(/[\\/]/).at(-1) ?? "attachment",
              path,
            })),
          );
      replacement = { text, attachments };
    } else if (finish.outcome !== "cancel" && finish.outcome !== "release-expired") {
      throw new Error("Invalid queued prompt edit outcome");
    }
    const { queueKey, environmentId, messageId, leaseId } = target;
    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      if (replacement) {
        await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
          environmentId,
          "Prompt queue",
        );
      }
      return this.repos.promptQueues.updatePromptQueue<PromptQueueEditFinishResult>(
        queueKey,
        (previous) => {
          if (!previous) return { result: { status: "conflict", reason: "missing", queue: null } };
          if (previous.environmentId !== environmentId) {
            throw new Error("Prompt queue belongs to another environment");
          }
          const found = findMessage(previous, messageId);
          if (!found) {
            return { result: { status: "conflict", reason: "missing", queue: previous } };
          }
          const leases = promptQueueEditLeases(previous);
          const held = leases.find((lease) => lease.messageId === messageId);
          if (
            !held ||
            held.leaseId !== leaseId ||
            (finish.outcome === "release-expired" &&
              !promptQueueEditLeaseExpired(held, options.now ?? Date.now()))
          ) {
            return {
              result: {
                status: "conflict",
                reason: "lease-lost",
                current: found.message,
                queue: previous,
              },
            };
          }
          const others = leases.filter((lease) => lease !== held);
          if (!replacement) {
            const queue = withLeases(previous, others);
            return { result: { status: "released", queue }, value: queue };
          }
          if (
            !editable(previous, found.message) ||
            promptQueueMessageFingerprint(found.message) !== held.baseFingerprint
          ) {
            // The payload or its editability changed under this lease.
            // Keep the lease until the editor resolves the conflict.
            return {
              result: {
                status: "conflict",
                reason: "changed",
                current: found.message,
                queue: previous,
              },
            };
          }
          const { attachments: _attachments, ...rest } = found.message;
          const edited = {
            ...rest,
            text: replacement.text,
            ...(replacement.attachments.length > 0 ? { attachments: replacement.attachments } : {}),
          };
          const messages = [...previous.messages];
          messages[found.index] = edited;
          // `nextPromptQueue` validates the size, keeps a dispatch error only
          // while its item is unchanged and keeps the other leases.
          const queue = this.repos.promptQueues.nextPromptQueue(
            queueKey,
            environmentId,
            messages,
            replaceLeases(previous, others),
          );
          return { result: { status: "committed", queue }, value: queue };
        },
      );
    });
  }
}

export type PromptQueueEditsStorage = Pick<
  PromptQueueEditsRepository,
  "beginPromptQueueMessageEdit" | "renewPromptQueueMessageEdit" | "finishPromptQueueMessageEdit"
>;
