import { nativeAgentJobReceiptIsActive } from "./models.js";
import { promptQueueMessageFingerprint } from "./storage-record-upgrades.js";
import * as shared from "./storage-shared.js";
import {
  assertPromptQueueKeyOwner,
  createHash,
  isNonBlankString,
  isNonNegativeInteger,
  isPersistedComposeDraft,
  isPersistedPromptQueue,
  isRecord,
  nowIso,
  randomUUID,
} from "./storage-shared.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";
type AgentInteractionOrigin = shared.AgentInteractionOrigin;
type AgentInteractionPolicy = shared.AgentInteractionPolicy;
type AgentInteractionResolutionJournal = shared.AgentInteractionResolutionJournal;
type StoredDesktopConnections = shared.StoredDesktopConnections;
type FeaturePlanningRecord = shared.FeaturePlanningRecord;
type BuildPipelineAgent = shared.BuildPipelineAgent;
type PaneLayoutMergeInput = shared.PaneLayoutMergeInput;
type PaneLayoutSelectionIntent = shared.PaneLayoutSelectionIntent;
type ConditionalResourceSnapshot<T> = shared.ConditionalResourceSnapshot<T>;
type ResourceChange = shared.ResourceChange;
type ResourceKind = shared.ResourceKind;
type ResourceManifestKind = shared.ResourceManifestKind;
type ResourceRevisionManifest = shared.ResourceRevisionManifest;
type ResourceRevisionMap = shared.ResourceRevisionMap;
type ResourceSnapshotRevision = shared.ResourceSnapshotRevision;
type AgentModel = shared.AgentModel;
type AgentActivityState = shared.AgentActivityState;
type AgentActivitySource = shared.AgentActivitySource;
type AgentModelCatalogCache = shared.AgentModelCatalogCache;
type AppConfig = shared.AppConfig;
type ClaudeModelCatalogSnapshot = shared.ClaudeModelCatalogSnapshot;
type ClaudeModelCatalogEntry = shared.ClaudeModelCatalogEntry;
type CodexModelCatalogEntry = shared.CodexModelCatalogEntry;
type CodexReasoningEffort = shared.CodexReasoningEffort;
type Environment = shared.Environment;
type EnvironmentStatus = shared.EnvironmentStatus;
type EnvironmentType = shared.EnvironmentType;
type OpenCodeModelCatalogEntry = shared.OpenCodeModelCatalogEntry;
type OpenCodeModelCatalogSnapshot = shared.OpenCodeModelCatalogSnapshot;
type PortMapping = shared.PortMapping;
type PrState = shared.PrState;
type Project = shared.Project;
type PersistedPaneLayout = shared.PersistedPaneLayout;
type PersistedMultiReviewWorkflow = shared.PersistedMultiReviewWorkflow;
type PersistedBuildPipeline = shared.PersistedBuildPipeline;
type PersistedNativeAgentSession = shared.PersistedNativeAgentSession;
type PersistedNativeAgentPendingDispatch = shared.PersistedNativeAgentPendingDispatch;
type PersistedComposeDraft = shared.PersistedComposeDraft;
type PersistedFileDraft = shared.PersistedFileDraft;
type PersistedPromptQueue = shared.PersistedPromptQueue;
type PersistedAgentHandoff = shared.PersistedAgentHandoff;
type RepositoryConfig = shared.RepositoryConfig;
type Session = shared.Session;
type SessionType = shared.SessionType;
type JsonRecord = shared.JsonRecord;
type KanbanComment = shared.KanbanComment;
type KanbanImage = shared.KanbanImage;
type KanbanStatus = shared.KanbanStatus;
type MutablePaneLayoutLeaf = shared.MutablePaneLayoutLeaf;
type KanbanTask = shared.KanbanTask;
type ProjectNotes = shared.ProjectNotes;
type FeaturePlanStatus = shared.FeaturePlanStatus;
type FeaturePlanMessage = shared.FeaturePlanMessage;
type FeatureStoryCard = shared.FeatureStoryCard;
type FeaturePlan = shared.FeaturePlan;
type LinearAuth = shared.LinearAuth;
type LinearCompletionComment = shared.LinearCompletionComment;
type GitHubCompletionComment = shared.GitHubCompletionComment;
type LoadedNativeAgentSessions = shared.LoadedNativeAgentSessions;
type PersistedOpenCodeModelCatalogStore = shared.PersistedOpenCodeModelCatalogStore;
type ResourceChangeListener = shared.ResourceChangeListener;

export type StorageLayerTypes = [
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionResolutionJournal,
  StoredDesktopConnections,
  FeaturePlanningRecord,
  BuildPipelineAgent,
  PaneLayoutMergeInput,
  PaneLayoutSelectionIntent,
  ConditionalResourceSnapshot<unknown>,
  ResourceChange,
  ResourceKind,
  ResourceManifestKind,
  ResourceRevisionManifest,
  ResourceRevisionMap,
  ResourceSnapshotRevision,
  AgentModel,
  AgentActivityState,
  AgentActivitySource,
  AgentModelCatalogCache,
  AppConfig,
  ClaudeModelCatalogSnapshot,
  ClaudeModelCatalogEntry,
  CodexModelCatalogEntry,
  CodexReasoningEffort,
  Environment,
  EnvironmentStatus,
  EnvironmentType,
  OpenCodeModelCatalogEntry,
  OpenCodeModelCatalogSnapshot,
  PortMapping,
  PrState,
  Project,
  PersistedPaneLayout,
  PersistedMultiReviewWorkflow,
  PersistedBuildPipeline,
  PersistedNativeAgentSession,
  PersistedNativeAgentPendingDispatch,
  PersistedComposeDraft,
  PersistedFileDraft,
  PersistedPromptQueue,
  PersistedAgentHandoff,
  RepositoryConfig,
  Session,
  SessionType,
  JsonRecord,
  KanbanComment,
  KanbanImage,
  KanbanStatus,
  MutablePaneLayoutLeaf,
  KanbanTask,
  ProjectNotes,
  FeaturePlanStatus,
  FeaturePlanMessage,
  FeatureStoryCard,
  FeaturePlan,
  LinearAuth,
  LinearCompletionComment,
  GitHubCompletionComment,
  LoadedNativeAgentSessions,
  PersistedOpenCodeModelCatalogStore,
  ResourceChangeListener,
];

/** New insertion was refused after all existing dispatch receipts were checked. */
export const PROMPT_QUEUE_NEW_PUBLICATION_REFUSED = "Prompt queue new publication refused";

/** Prefix of an idempotent enqueue whose id is already used by a different body. */
export const PROMPT_QUEUE_MESSAGE_CONFLICT = "Prompt queue message conflict:";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 of a key-order-independent JSON form of one queued message. */
export function canonicalPromptQueueMessageFingerprint(message: unknown): string {
  return createHash("sha256").update(canonicalJson(message)).digest("hex");
}

/**
 * Backend-authored items (a typed `origin`, e.g. a web annotation request) are
 * immutable snapshots: they can be reordered or removed, never edited or
 * turned into a draft.
 */
export function isFrozenPromptQueueMessage(message: unknown): boolean {
  return isRecord(message) && isRecord(message.origin) && isNonBlankString(message.origin.kind);
}

export class PromptsRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly repos: StorageRepositories,
  ) {}

  async getPromptQueue(queueKey: string): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    return (await this.repos.promptQueues.loadPromptQueues())[queueKey] ?? null;
  }

  async listPromptQueues(environmentId: string): Promise<PersistedPromptQueue[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    return Object.values(await this.repos.promptQueues.loadPromptQueues()).filter(
      (queue) => queue.environmentId === environmentId,
    );
  }

  async listAllPromptQueues(): Promise<PersistedPromptQueue[]> {
    return Object.values(await this.repos.promptQueues.loadPromptQueues());
  }

  /**
   * Run the irreversible tmux mail submission boundary only while the user
   * prompt queue is authoritatively empty. Holding the prompt-queue mutation
   * lock across the short terminal submission means a concurrent enqueue is
   * ordered entirely before (and blocks mail) or entirely after it; it cannot
   * land between a final read and the terminal side effect.
   */
  async withEmptyPromptQueueForMail<T>(
    queueKey: string,
    environmentId: string,
    operation: () => Promise<T>,
  ): Promise<{ empty: false } | { empty: true; value: T }> {
    if (!isNonBlankString(queueKey)) throw new Error("Prompt queue key must not be blank");
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    assertPromptQueueKeyOwner(queueKey, environmentId);
    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
        environmentId,
        "Agent mail",
      );
      const queue = (await this.repos.promptQueues.loadPromptQueues())[queueKey];
      if (
        queue &&
        (queue.outstandingClaim !== undefined ||
          queue.inFlight !== undefined ||
          queue.messages.length > 0)
      ) {
        return { empty: false };
      }
      return { empty: true, value: await operation() };
    });
  }

  /**
   * Replaces a tab's queue wholesale under a compare-and-swap revision.
   *
   * Whole-list writes rather than per-item operations because the contended
   * operation is "take the head and send it": two clients doing that must not
   * both win, and a revision check is the cheapest way to guarantee exactly one
   * does. The queue is a handful of messages, so rewriting it costs nothing.
   */
  async savePromptQueue(
    queueKey: string,
    environmentId: string,
    messages: unknown[],
    expectedRevision?: number,
  ): Promise<PersistedPromptQueue> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    assertPromptQueueKeyOwner(queueKey, environmentId);
    this.repos.promptQueues.validatePromptQueueMessages(messages);
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Prompt queue expected revision must be a non-negative integer");
    }

    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
        environmentId,
        "Prompt queue",
      );
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
        throw new Error("Prompt queue revision conflict");
      }
      return this.repos.promptQueues.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        messages,
        previous,
      );
    });
  }

  /**
   * Appends one prompt atomically.
   *
   * Renderers never replace the queue: they submit intent-level mutations and
   * consume the returned snapshot. This preserves concurrent appends from
   * multiple clients instead of letting the last whole-list write win.
   */
  async enqueuePromptQueueMessage(
    queueKey: string,
    environmentId: string,
    message: unknown,
  ): Promise<PersistedPromptQueue> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    assertPromptQueueKeyOwner(queueKey, environmentId);
    this.repos.promptQueues.validatePromptQueueMessage(message);

    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
        environmentId,
        "Prompt queue",
      );
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (
        (previous?.outstandingClaim && previous.outstandingClaim.message.id === message.id) ||
        (isRecord(previous?.inFlight?.message) && previous.inFlight.message.id === message.id) ||
        previous?.messages.some((candidate) => isRecord(candidate) && candidate.id === message.id)
      ) {
        return previous;
      }
      return this.repos.promptQueues.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        [...(previous?.messages ?? []), message],
        previous,
      );
    });
  }

  /**
   * Appends one backend-authored prompt exactly once per stable message id.
   *
   * Unlike {@link enqueuePromptQueueMessage}, presence is checked against every
   * durable identity the native queue can hold — queued, held by a live legacy claim,
   * reserved in flight, parked with a dispatch error — and against the native
   * session's consumed receipts (`dispatchedRequestIds` and an ambiguous
   * `pendingDispatch`). A lost response can therefore be retried with the same
   * id without ever publishing a second copy of an already-sent prompt.
   *
   * The queue half is read under the prompt-queue mutation lock. The session
   * half needs no lock: the drainer records the session receipt before it
   * acknowledges the queue reservation, so an id that has left the queue is
   * already visible in the session record.
   *
   * `fingerprint` defaults to {@link canonicalPromptQueueMessageFingerprint}
   * of `message`; a present id with a different fingerprint is a conflict.
   * `allowNewMessage` gates only insertion, after checking durable receipts.
   */
  async enqueuePromptQueueMessageIfAbsent(
    queueKey: string,
    environmentId: string,
    message: unknown,
    fingerprint?: string,
    allowNewMessage = true,
  ): Promise<{ status: "queued" | "present" | "consumed"; queue: PersistedPromptQueue | null }> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    assertPromptQueueKeyOwner(queueKey, environmentId);
    this.repos.promptQueues.validatePromptQueueMessage(message);
    const messageId = message.id as string;
    const expected = fingerprint ?? canonicalPromptQueueMessageFingerprint(message);
    if (!isNonBlankString(expected)) {
      throw new Error("Prompt queue message fingerprint must not be blank");
    }

    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
        environmentId,
        "Prompt queue",
      );
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      const held = [
        ...(previous?.messages ?? []),
        previous?.outstandingClaim?.message,
        previous?.inFlight?.message,
      ].find((candidate) => isRecord(candidate) && candidate.id === messageId);
      if (held !== undefined) {
        if (canonicalPromptQueueMessageFingerprint(held) !== expected) {
          throw new Error(`${PROMPT_QUEUE_MESSAGE_CONFLICT} ${messageId}`);
        }
        return { status: "present" as const, queue: previous ?? null };
      }
      if (
        previous?.dispatchError?.messageId === messageId ||
        previous?.dispatchError?.requestId === messageId
      ) {
        // The rejected item is restored to `messages`, so this is reachable
        // only for a corrupt record. Never publish beside a parked twin.
        throw new Error(`${PROMPT_QUEUE_MESSAGE_CONFLICT} ${messageId}`);
      }
      if (previous?.inFlight?.requestId === messageId) {
        throw new Error(`${PROMPT_QUEUE_MESSAGE_CONFLICT} ${messageId}`);
      }

      // A removed backend-authored item is permanently consumed: removal from
      // the chat queue must never make its id publishable again.
      if (previous?.removedOrigins?.some((entry) => entry.requestId === messageId)) {
        return { status: "consumed" as const, queue: previous };
      }
      const session = await this.promptQueueNativeSession(queueKey, environmentId);
      if (
        session?.dispatchedRequestIds?.includes(messageId) ||
        session?.pendingDispatch?.requestId === messageId
      ) {
        return { status: "consumed" as const, queue: previous ?? null };
      }

      // Recovery receipts above remain authoritative even when new publication
      // is no longer allowed (for example, a read-only session left Plan).
      if (!allowNewMessage) throw new Error(PROMPT_QUEUE_NEW_PUBLICATION_REFUSED);

      const queue = await this.repos.promptQueues.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        [...(previous?.messages ?? []), message],
        previous,
      );
      return { status: "queued" as const, queue };
    });
  }

  /** One job launch at a time, including target selection and provider admission. */
  withNativeAgentJobLaunch<T>(environmentId: string, operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(
      this.context.file(
        `native-agent-job-${createHash("sha256").update(environmentId).digest("hex")}`,
      ),
      "native agent job launch",
      operation,
      { acquireTimeoutMs: 180_000 },
    );
  }

  /** Bind before dispatch, or atomically coalesce and publish a waiting prompt. */
  async reserveNativeAgentJobRequest(
    queueKey: string,
    environmentId: string,
    receipt: import("./models.js").NativeAgentJobReceipt,
    message?: Record<string, unknown>,
    coalesce = false,
  ): Promise<import("./models.js").NativeAgentJobReceipt> {
    assertPromptQueueKeyOwner(queueKey, environmentId);
    if (message) this.repos.promptQueues.validatePromptQueueMessage(message);
    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
        environmentId,
        "Job",
      );
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      const existing = previous?.jobReceipts?.find(
        (entry) => entry.requestId === receipt.requestId,
      );
      if (existing) {
        if (existing.fingerprint !== receipt.fingerprint)
          throw new Error("Job request ID conflict");
        return existing;
      }
      const held = [
        ...(previous?.messages ?? []),
        previous?.outstandingClaim?.message,
        previous?.inFlight?.message,
      ];
      const session = await this.promptQueueNativeSession(queueKey, environmentId);
      const matchingHeld =
        message && held.find((entry) => isRecord(entry) && entry.text === message.text);
      const duplicate = coalesce
        ? (previous?.jobReceipts?.find(
            (entry) =>
              entry.fingerprint === receipt.fingerprint &&
              nativeAgentJobReceiptIsActive(entry, session, previous),
          ) ??
          (isRecord(matchingHeld)
            ? {
                requestId: String(matchingHeld.requestId ?? matchingHeld.id),
                status: "accepted" as const,
                queued: true as const,
              }
            : undefined))
        : undefined;
      const savedReceipt = duplicate
        ? {
            ...receipt,
            dispatchRequestId:
              "dispatchRequestId" in duplicate
                ? (duplicate.dispatchRequestId ?? duplicate.requestId)
                : duplicate.requestId,
            status: session?.dispatchedRequestIds?.includes(
              "dispatchRequestId" in duplicate
                ? (duplicate.dispatchRequestId ?? duplicate.requestId)
                : duplicate.requestId,
            )
              ? ("accepted" as const)
              : duplicate.status,
            queued: duplicate.queued,
          }
        : receipt;
      const receipts = previous?.jobReceipts ?? [];
      // Refuse rather than evict a binding and make an old retry publishable again.
      const retained = receipts;
      if (retained.length >= 256) throw new Error("Native job receipt capacity reached");
      await this.repos.promptQueues.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        message && !duplicate
          ? [...(previous?.messages ?? []), message]
          : (previous?.messages ?? []),
        {
          ...(previous ?? {
            queueKey,
            environmentId,
            messages: [],
            revision: 0,
            updatedAt: nowIso(),
          }),
          jobReceipts: [...retained, savedReceipt],
        },
      );
      return savedReceipt;
    });
  }

  async settleNativeAgentJobRequest(
    queueKey: string,
    requestId: string,
    status: "accepted" | "unknown" | "rejected",
  ): Promise<void> {
    await this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous?.jobReceipts) return;
      const jobReceipts = previous.jobReceipts.flatMap((entry) =>
        (entry.dispatchRequestId ?? entry.requestId) !== requestId
          ? [entry]
          : status === "rejected"
            ? []
            : [{ ...entry, status }],
      );
      await this.repos.promptQueues.savePromptQueueMutation(
        queues,
        queueKey,
        previous.environmentId,
        previous.messages,
        { ...previous, jobReceipts },
      );
    });
  }

  /** The native session a `${agent}\0${logicalSessionKey}` queue drains into. */
  private async promptQueueNativeSession(
    queueKey: string,
    environmentId: string,
  ): Promise<PersistedNativeAgentSession | null> {
    const separator = queueKey.indexOf("\0");
    if (separator <= 0) return null;
    const agent = queueKey.slice(0, separator);
    const logicalSessionKey = queueKey.slice(separator + 1);
    if (!isNonBlankString(logicalSessionKey)) return null;
    // Same derivation as `nativeAgentSessionStorageKey`; storage sits below the
    // native agent service and cannot import it without a cycle.
    const key = createHash("sha256")
      .update(environmentId)
      .update("\0")
      .update(agent)
      .update("\0")
      .update(logicalSessionKey)
      .digest("hex");
    const session = await this.repos.nativeAgentSessions.getNativeAgentSession(key);
    if (!session || session.environmentId !== environmentId) return null;
    return session;
  }

  async removePromptQueueMessage(
    queueKey: string,
    environmentId: string,
    messageId: string,
  ): Promise<{ removed: unknown | null; queue: PersistedPromptQueue | null }> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    if (!isNonBlankString(messageId)) {
      throw new Error("Prompt queue message ID must not be blank");
    }

    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
        environmentId,
        "Prompt queue",
      );
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous) return { removed: null, queue: null };
      if (previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      const index = previous.messages.findIndex(
        (candidate) => isRecord(candidate) && candidate.id === messageId,
      );
      if (index < 0) return { removed: null, queue: previous };
      const messages = [...previous.messages];
      const [removed] = messages.splice(index, 1);
      const queue = await this.repos.promptQueues.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        messages,
        previous,
      );
      return { removed: removed ?? null, queue };
    });
  }

  async movePromptQueueMessage(
    queueKey: string,
    environmentId: string,
    messageId: string,
    direction: "up" | "down",
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    if (!isNonBlankString(messageId)) {
      throw new Error("Prompt queue message ID must not be blank");
    }
    if (direction !== "up" && direction !== "down") {
      throw new Error("Prompt queue move direction must be up or down");
    }

    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
        environmentId,
        "Prompt queue",
      );
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous) return null;
      if (previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      const index = previous.messages.findIndex(
        (candidate) => isRecord(candidate) && candidate.id === messageId,
      );
      const target = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= previous.messages.length) {
        return previous;
      }
      const messages = [...previous.messages];
      [messages[index], messages[target]] = [messages[target], messages[index]];
      return this.repos.promptQueues.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        messages,
        previous,
      );
    });
  }

  async reservePromptQueueHeadForDispatch(
    queueKey: string,
  ): Promise<PersistedPromptQueue["inFlight"] | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous) return null;
      if (previous.outstandingClaim || previous.dispatchError) return null;
      if (previous.inFlight) return previous.inFlight;
      const message = previous.messages[0];
      if (!isRecord(message) || !isNonBlankString(message.id)) return null;
      const inFlight = {
        message,
        requestId: isNonBlankString(message.requestId) ? message.requestId : message.id,
        reservedAt: nowIso(),
      };
      const saved: PersistedPromptQueue = {
        ...previous,
        messages: previous.messages.slice(1),
        inFlight,
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.context.saveSensitiveJson(this.files.promptQueuesFile(), queues);
      this.context.changes.announce("prompt-queue", previous.environmentId);
      return inFlight;
    });
  }

  async acknowledgePromptQueueDispatch(
    queueKey: string,
    requestId: string,
  ): Promise<PersistedPromptQueue | null> {
    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous?.inFlight || previous.inFlight.requestId !== requestId) {
        return previous ?? null;
      }
      const { inFlight: _inFlight, ...withoutInFlight } = previous;
      const saved: PersistedPromptQueue = {
        ...withoutInFlight,
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.context.saveSensitiveJson(this.files.promptQueuesFile(), queues);
      this.context.changes.announce("prompt-queue", previous.environmentId);
      return saved;
    });
  }

  /**
   * Durably fences an in-flight prompt before crossing the irreversible tmux
   * submit boundary. If the backend dies after this write, recovery must treat
   * the outcome as ambiguous rather than submitting the prompt again.
   */
  async markPromptQueueDispatchSubmitting(
    queueKey: string,
    requestId: string,
  ): Promise<PersistedPromptQueue | null> {
    return this.markPromptQueueDispatchBoundary(queueKey, requestId, "submittingAt");
  }

  /** Records that tmux accepted a fenced prompt so acknowledgement can retry safely. */
  async markPromptQueueDispatchSubmitted(
    queueKey: string,
    requestId: string,
  ): Promise<PersistedPromptQueue | null> {
    return this.markPromptQueueDispatchBoundary(queueKey, requestId, "submittedAt");
  }

  private markPromptQueueDispatchBoundary(
    queueKey: string,
    requestId: string,
    field: "submittingAt" | "submittedAt",
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey) || !isNonBlankString(requestId)) {
      throw new Error("Prompt queue dispatch identity must not be blank");
    }
    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous?.inFlight || previous.inFlight.requestId !== requestId) {
        return previous ?? null;
      }
      if (field === "submittedAt" && previous.inFlight.submittingAt === undefined) {
        throw new Error("Prompt queue dispatch was not fenced before submission");
      }
      if (previous.inFlight[field] !== undefined) return previous;
      const saved: PersistedPromptQueue = {
        ...previous,
        inFlight: {
          ...previous.inFlight,
          [field]: nowIso(),
        },
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.context.saveSensitiveJson(this.files.promptQueuesFile(), queues);
      this.context.changes.announce("prompt-queue", previous.environmentId);
      return saved;
    });
  }

  async failPromptQueueDispatch(
    queueKey: string,
    requestId: string,
    message = "Queued prompt was rejected. Edit it or retry explicitly.",
    options?: { requestIdRetired?: boolean },
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey) || !isNonBlankString(requestId) || !isNonBlankString(message)) {
      throw new Error("Prompt queue failure identity must not be blank");
    }
    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous?.inFlight || previous.inFlight.requestId !== requestId) {
        return previous ?? null;
      }
      const { inFlight, ...withoutInFlight } = previous;
      if (!isRecord(inFlight.message) || !isNonBlankString(inFlight.message.id)) {
        return previous;
      }
      // Only an explicit retirement permits a fresh dispatch identity. Keep the
      // stable row id, and leave the error latched until the user retries.
      const failedMessage = options?.requestIdRetired
        ? { ...inFlight.message, requestId: randomUUID() }
        : inFlight.message;
      const saved: PersistedPromptQueue = {
        ...withoutInFlight,
        messages: [failedMessage, ...previous.messages],
        dispatchError: {
          requestId,
          messageId: inFlight.message.id,
          messageFingerprint: this.promptQueueMessageFingerprint(failedMessage),
          message,
          failedAt: nowIso(),
        },
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.context.saveSensitiveJson(this.files.promptQueuesFile(), queues);
      this.context.changes.announce("prompt-queue", previous.environmentId);
      return saved;
    });
  }

  async retryPromptQueueDispatch(queueKey: string): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous?.dispatchError) return previous ?? null;
      const { dispatchError: _dispatchError, ...withoutError } = previous;
      const saved: PersistedPromptQueue = {
        ...withoutError,
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.context.saveSensitiveJson(this.files.promptQueuesFile(), queues);
      this.context.changes.announce("prompt-queue", previous.environmentId);
      return saved;
    });
  }

  promptQueueMessageFingerprint(message: unknown): string {
    return promptQueueMessageFingerprint(message);
  }

  async deletePromptQueuesByEnvironment(environmentId: string): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      const queues = await this.repos.promptQueues.loadPromptQueues();
      const removedKeys = Object.values(queues)
        .filter((queue) => queue.environmentId === environmentId)
        .map((queue) => queue.queueKey);
      if (removedKeys.length > 0) {
        for (const key of removedKeys) delete queues[key];
        await this.context.saveSensitiveJson(this.files.promptQueuesFile(), queues);
        this.context.changes.announce("prompt-queue", environmentId);
      }

      // Queued prompts carry user-authored text and pasted attachments, and
      // rotating the primary file leaves them readable in its backups. Always
      // scrub, even when the current primary has no matching record: a prior
      // failed delete may have removed the primary while leaving a backup.
      await this.context.scrubSensitiveJsonBackups(
        this.files.promptQueuesFile(),
        (storedKey, queue) =>
          isPersistedPromptQueue(queue, storedKey) && queue.environmentId !== environmentId,
      );
      return removedKeys;
    });
  }

  enqueueComposeDraftMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(
      this.files.composeDraftsFile(),
      "compose draft storage",
      operation,
    );
  }

  validComposeDrafts(stored: unknown): Record<string, PersistedComposeDraft> {
    if (!isRecord(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(([storedKey, draft]) =>
        isPersistedComposeDraft(draft, storedKey),
      ),
    ) as Record<string, PersistedComposeDraft>;
  }

  async loadComposeDrafts(): Promise<Record<string, PersistedComposeDraft>> {
    const stored = await this.context.loadJson<unknown>(this.files.composeDraftsFile(), () => ({}));
    return this.validComposeDrafts(stored);
  }
}
