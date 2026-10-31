import { parseClaudeTmuxStateKey } from "@orkestrator/protocol/tmux-prompt";
import type {
  PersistedAgentHandoff,
  PersistedBuildPipeline,
  PersistedComposeDraft,
  PersistedFileDraft,
  PersistedMultiReviewWorkflow,
  PersistedPromptQueue,
} from "./models.js";
import { isNonBlankString, isPositiveInteger, isRecord } from "./storage-shared-core.js";

export const MAX_PROMPT_QUEUE_SOURCE_KEY_BYTES = 4 * 1024;
export const MAX_PROMPT_QUEUE_SOURCE_MESSAGE_ID_BYTES = 1024;

export function isPersistedMultiReviewWorkflow(
  value: unknown,
  expectedId?: string,
): value is PersistedMultiReviewWorkflow {
  return (
    isRecord(value) &&
    isPositiveInteger(value.version) &&
    isNonBlankString(value.id) &&
    (expectedId === undefined || value.id === expectedId) &&
    isNonBlankString(value.environmentId) &&
    isRecord(value.snapshot) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isPositiveInteger(value.revision) &&
    (value.controllerLease === undefined ||
      (isRecord(value.controllerLease) &&
        isNonBlankString(value.controllerLease.ownerId) &&
        isNonBlankString(value.controllerLease.token) &&
        typeof value.controllerLease.expiresAt === "string" &&
        Number.isFinite(Date.parse(value.controllerLease.expiresAt))))
  );
}

export function isPersistedPromptQueue(
  value: unknown,
  expectedKey?: string,
): value is PersistedPromptQueue {
  return (
    isRecord(value) &&
    isNonBlankString(value.queueKey) &&
    (expectedKey === undefined || value.queueKey === expectedKey) &&
    isNonBlankString(value.environmentId) &&
    promptQueueKeyMatchesEnvironment(value.queueKey, value.environmentId) &&
    Array.isArray(value.messages) &&
    (value.jobReceipts === undefined ||
      (Array.isArray(value.jobReceipts) &&
        value.jobReceipts.length <= 256 &&
        value.jobReceipts.every(
          (receipt) =>
            isRecord(receipt) &&
            isNonBlankString(receipt.requestId) &&
            receipt.requestId.length <= 256 &&
            (receipt.dispatchRequestId === undefined ||
              (isNonBlankString(receipt.dispatchRequestId) &&
                receipt.dispatchRequestId.length <= 256)) &&
            typeof receipt.fingerprint === "string" &&
            /^[a-f0-9]{64}$/.test(receipt.fingerprint) &&
            (receipt.status === "accepted" || receipt.status === "unknown") &&
            (receipt.queued === undefined || receipt.queued === true),
        ))) &&
    (value.outstandingClaim === undefined ||
      (isRecord(value.outstandingClaim) &&
        isRecord(value.outstandingClaim.message) &&
        isNonBlankString(value.outstandingClaim.token) &&
        typeof value.outstandingClaim.claimedAt === "string" &&
        Number.isFinite(Date.parse(value.outstandingClaim.claimedAt)) &&
        typeof value.outstandingClaim.expiresAt === "string" &&
        Number.isFinite(Date.parse(value.outstandingClaim.expiresAt)))) &&
    (value.inFlight === undefined ||
      (isRecord(value.inFlight) &&
        Object.hasOwn(value.inFlight, "message") &&
        isNonBlankString(value.inFlight.requestId) &&
        (value.inFlight.steer === undefined || value.inFlight.steer === true) &&
        typeof value.inFlight.reservedAt === "string" &&
        Number.isFinite(Date.parse(value.inFlight.reservedAt)) &&
        (value.inFlight.submittingAt === undefined ||
          (typeof value.inFlight.submittingAt === "string" &&
            Number.isFinite(Date.parse(value.inFlight.submittingAt)))) &&
        (value.inFlight.submittedAt === undefined ||
          (typeof value.inFlight.submittedAt === "string" &&
            Number.isFinite(Date.parse(value.inFlight.submittedAt)) &&
            typeof value.inFlight.submittingAt === "string" &&
            Date.parse(value.inFlight.submittedAt) >= Date.parse(value.inFlight.submittingAt))))) &&
    (value.dispatchError === undefined ||
      (isRecord(value.dispatchError) &&
        isNonBlankString(value.dispatchError.requestId) &&
        ((isNonBlankString(value.dispatchError.messageId) &&
          isNonBlankString(value.dispatchError.messageFingerprint) &&
          /^[a-f0-9]{64}$/.test(value.dispatchError.messageFingerprint)) ||
          (value.dispatchError.messageId === undefined &&
            value.dispatchError.messageFingerprint === undefined)) &&
        isNonBlankString(value.dispatchError.message) &&
        typeof value.dispatchError.failedAt === "string" &&
        Number.isFinite(Date.parse(value.dispatchError.failedAt)))) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isPositiveInteger(value.revision)
  );
}

export const CLAUDE_TMUX_QUEUE_PREFIX = "claude-tmux\0";

export function promptQueueKeyMatchesEnvironment(queueKey: string, environmentId: string): boolean {
  if (!queueKey.startsWith(CLAUDE_TMUX_QUEUE_PREFIX)) return true;
  const target = parseClaudeTmuxStateKey(queueKey.slice(CLAUDE_TMUX_QUEUE_PREFIX.length));
  return target?.environmentId === environmentId;
}

export function assertPromptQueueKeyOwner(queueKey: string, environmentId: string): void {
  if (!promptQueueKeyMatchesEnvironment(queueKey, environmentId)) {
    throw new Error("Prompt queue key does not match its environment owner");
  }
}

export function isPersistedComposeDraft(
  value: unknown,
  expectedKey?: string,
): value is PersistedComposeDraft {
  const source = isRecord(value) ? value.sourcePromptQueue : undefined;
  return (
    isRecord(value) &&
    isNonBlankString(value.draftKey) &&
    (expectedKey === undefined || value.draftKey === expectedKey) &&
    (value.ownerType === "environment" || value.ownerType === "project") &&
    isNonBlankString(value.ownerId) &&
    Object.hasOwn(value, "value") &&
    (source === undefined ||
      (isRecord(source) &&
        isNonBlankString(source.queueKey) &&
        Buffer.byteLength(source.queueKey, "utf8") <= MAX_PROMPT_QUEUE_SOURCE_KEY_BYTES &&
        isNonBlankString(source.messageId) &&
        Buffer.byteLength(source.messageId, "utf8") <= MAX_PROMPT_QUEUE_SOURCE_MESSAGE_ID_BYTES)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isPositiveInteger(value.revision)
  );
}

export function isPersistedFileDraft(
  value: unknown,
  expectedKey?: string,
): value is PersistedFileDraft {
  return (
    isRecord(value) &&
    isNonBlankString(value.draftKey) &&
    (expectedKey === undefined || value.draftKey === expectedKey) &&
    isNonBlankString(value.environmentId) &&
    isNonBlankString(value.filePath) &&
    typeof value.content === "string" &&
    typeof value.originalContent === "string" &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isPositiveInteger(value.revision)
  );
}

export function isPersistedAgentHandoff(
  value: unknown,
  expectedId?: string,
): value is PersistedAgentHandoff {
  return (
    isRecord(value) &&
    isPositiveInteger(value.version) &&
    isNonBlankString(value.id) &&
    (expectedId === undefined || value.id === expectedId) &&
    isNonBlankString(value.environmentId) &&
    isRecord(value.snapshot) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

export function isPersistedBuildPipeline(
  value: unknown,
  expectedId?: string,
): value is PersistedBuildPipeline {
  return (
    isRecord(value) &&
    isPositiveInteger(value.version) &&
    isNonBlankString(value.id) &&
    (expectedId === undefined || value.id === expectedId) &&
    isNonBlankString(value.projectId) &&
    // Blank until the pipeline's environment exists; see PersistedBuildPipeline.
    typeof value.environmentId === "string" &&
    isRecord(value.snapshot) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isPositiveInteger(value.revision)
  );
}

export function activeGitHubBuildReservation(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return null;
  if (snapshot.phase === "complete" || snapshot.phase === "failed") return null;
  const source = snapshot.source;
  if (
    !isRecord(source) ||
    source.type !== "github" ||
    !isNonBlankString(source.repositoryOwner) ||
    !isNonBlankString(source.repositoryName) ||
    !isPositiveInteger(source.issueNumber)
  ) {
    return null;
  }
  return `${source.repositoryOwner.toLowerCase()}/${source.repositoryName.toLowerCase()}#${source.issueNumber}`;
}

export function activeBuildAdmissionKey(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return null;
  if (snapshot.phase === "complete" || snapshot.phase === "failed") return null;
  return isNonBlankString(snapshot.admissionKey) ? snapshot.admissionKey : null;
}
