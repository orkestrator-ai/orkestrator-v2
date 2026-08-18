import * as shared from "./storage-shared.js";
import {
  MAX_PROMPT_QUEUE_SOURCE_KEY_BYTES,
  MAX_PROMPT_QUEUE_SOURCE_MESSAGE_ID_BYTES,
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
type AgentModelConfigKey = shared.AgentModelConfigKey;
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
type PersistedLoopedReviewWorkflow = shared.PersistedLoopedReviewWorkflow;
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

import { StorageNative } from "./storage-native.ts";

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
  AgentModelConfigKey,
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
  PersistedLoopedReviewWorkflow,
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

export abstract class StoragePrompts extends StorageNative {
  async getPromptQueue(queueKey: string): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    return (await this.loadPromptQueues())[queueKey] ?? null;
  }

  async listPromptQueues(environmentId: string): Promise<PersistedPromptQueue[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    return Object.values(await this.loadPromptQueues()).filter(
      (queue) => queue.environmentId === environmentId,
    );
  }

  async listAllPromptQueues(): Promise<PersistedPromptQueue[]> {
    return Object.values(await this.loadPromptQueues());
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
    this.validatePromptQueueMessages(messages);
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Prompt queue expected revision must be a non-negative integer");
    }

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
        throw new Error("Prompt queue revision conflict");
      }
      return this.savePromptQueueMutation(queues, queueKey, environmentId, messages, previous);
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
    this.validatePromptQueueMessage(message);

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (
        (isRecord(previous?.outstandingClaim?.message) &&
          previous.outstandingClaim.message.id === message.id) ||
        previous?.messages.some((candidate) => isRecord(candidate) && candidate.id === message.id)
      ) {
        return previous;
      }
      return this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        [...(previous?.messages ?? []), message],
        previous,
      );
    });
  }

  /**
   * Inserts a previously claimed prompt back at the head when a renderer
   * discovers that its agent sender is no longer ready.
   */
  async requeuePromptQueueMessage(
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
    this.validatePromptQueueMessage(message);

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (
        previous?.outstandingClaim &&
        isRecord(previous.outstandingClaim.message) &&
        previous.outstandingClaim.message.id === message.id
      ) {
        return this.savePromptQueueMutation(
          queues,
          queueKey,
          environmentId,
          [
            message,
            ...previous.messages.filter(
              (candidate) => !isRecord(candidate) || candidate.id !== message.id,
            ),
          ],
          previous,
          null,
        );
      }
      if (
        previous?.messages.some((candidate) => isRecord(candidate) && candidate.id === message.id)
      ) {
        return previous;
      }
      return this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        [message, ...(previous?.messages ?? [])],
        previous,
      );
    });
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

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
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
      const queue = await this.savePromptQueueMutation(
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

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
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
      return this.savePromptQueueMutation(queues, queueKey, environmentId, messages, previous);
    });
  }

  async claimPromptQueueHead(
    queueKey: string,
    environmentId: string,
    expectedMessageId: string,
  ): Promise<{
    claimed: unknown | null;
    claimToken: string | null;
    queue: PersistedPromptQueue | null;
  }> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    assertPromptQueueKeyOwner(queueKey, environmentId);
    if (!isNonBlankString(expectedMessageId)) {
      throw new Error("Expected prompt message ID must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (previous?.dispatchError) {
        return { claimed: null, claimToken: null, queue: previous };
      }

      let current = previous;
      if (current?.outstandingClaim) {
        const expiresAt = Date.parse(current.outstandingClaim.expiresAt);
        if (expiresAt > Date.now()) {
          return { claimed: null, claimToken: null, queue: current };
        }
        const recoveredMessage = current.outstandingClaim.message;
        const recoveredId = isRecord(recoveredMessage) ? recoveredMessage.id : undefined;
        const recoveredMessages = [
          recoveredMessage,
          ...current.messages.filter(
            (candidate) =>
              recoveredId === undefined || !isRecord(candidate) || candidate.id !== recoveredId,
          ),
        ];
        current = await this.savePromptQueueMutation(
          queues,
          queueKey,
          environmentId,
          recoveredMessages,
          current,
          null,
        );
      }

      const messages = current?.messages ?? [];
      const head = messages[0];
      if (!isRecord(head) || head.id !== expectedMessageId) {
        return { claimed: null, claimToken: null, queue: current ?? null };
      }

      const claimedAt = new Date();
      const claimToken = randomUUID();
      const saved = await this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        messages.slice(1),
        current,
        {
          token: claimToken,
          message: head,
          claimedAt: claimedAt.toISOString(),
          expiresAt: new Date(claimedAt.getTime() + this.promptQueueClaimLeaseMs).toISOString(),
        },
      );
      return { claimed: head, claimToken, queue: saved };
    });
  }

  async reservePromptQueueHeadForDispatch(
    queueKey: string,
  ): Promise<PersistedPromptQueue["inFlight"] | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous) return null;
      if (previous.dispatchError) return null;
      if (previous.inFlight) return previous.inFlight;
      if (previous.outstandingClaim) return null;
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
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", previous.environmentId);
      return inFlight;
    });
  }

  async acknowledgePromptQueueDispatch(
    queueKey: string,
    requestId: string,
  ): Promise<PersistedPromptQueue | null> {
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
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
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", previous.environmentId);
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

  protected markPromptQueueDispatchBoundary(
    queueKey: string,
    requestId: string,
    field: "submittingAt" | "submittedAt",
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey) || !isNonBlankString(requestId)) {
      throw new Error("Prompt queue dispatch identity must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
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
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", previous.environmentId);
      return saved;
    });
  }

  async failPromptQueueDispatch(
    queueKey: string,
    requestId: string,
    message = "Queued prompt was rejected. Edit it or retry explicitly.",
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey) || !isNonBlankString(requestId) || !isNonBlankString(message)) {
      throw new Error("Prompt queue failure identity must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous?.inFlight || previous.inFlight.requestId !== requestId) {
        return previous ?? null;
      }
      const { inFlight, ...withoutInFlight } = previous;
      if (!isRecord(inFlight.message) || !isNonBlankString(inFlight.message.id)) {
        return previous;
      }
      const saved: PersistedPromptQueue = {
        ...withoutInFlight,
        messages: [inFlight.message, ...previous.messages],
        dispatchError: {
          requestId,
          messageId: inFlight.message.id,
          messageFingerprint: this.promptQueueMessageFingerprint(inFlight.message),
          message,
          failedAt: nowIso(),
        },
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", previous.environmentId);
      return saved;
    });
  }

  async retryPromptQueueDispatch(queueKey: string): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous?.dispatchError) return previous ?? null;
      const { dispatchError: _dispatchError, ...withoutError } = previous;
      const saved: PersistedPromptQueue = {
        ...withoutError,
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", previous.environmentId);
      return saved;
    });
  }

  protected promptQueueMessageFingerprint(message: unknown): string {
    return createHash("sha256").update(JSON.stringify(message)).digest("hex");
  }

  async acknowledgePromptQueueClaim(
    queueKey: string,
    environmentId: string,
    claimToken: string,
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    if (!isNonBlankString(claimToken)) {
      throw new Error("Prompt queue claim token must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous) return null;
      if (previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (!previous.outstandingClaim) return previous;
      if (previous.outstandingClaim.token !== claimToken) {
        throw new Error("Prompt queue claim token does not match");
      }
      return this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        previous.messages,
        previous,
        null,
      );
    });
  }

  async rejectPromptQueueClaim(
    queueKey: string,
    environmentId: string,
    claimToken: string,
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    if (!isNonBlankString(claimToken)) {
      throw new Error("Prompt queue claim token must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous) return null;
      if (previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (!previous.outstandingClaim) return previous;
      if (previous.outstandingClaim.token !== claimToken) {
        throw new Error("Prompt queue claim token does not match");
      }
      const message = previous.outstandingClaim.message;
      const messageId = isRecord(message) ? message.id : undefined;
      return this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        [
          message,
          ...previous.messages.filter(
            (candidate) =>
              messageId === undefined || !isRecord(candidate) || candidate.id !== messageId,
          ),
        ],
        previous,
        null,
      );
    });
  }

  /**
   * Moves one queued message into an authoritative compose draft without a
   * loss window. The draft is committed before the queue removal while both
   * stores are locked. Bounded provenance on the draft makes a retry finish
   * the removal after a process death or queue-write failure, while unrelated
   * existing drafts remain protected.
   */
  async transferPromptQueueMessageToComposeDraft(
    queueKey: string,
    environmentId: string,
    messageId: string,
    draftKey: string,
    ownerType: "environment" | "project",
    ownerId: string,
    expectedDraftRevision?: number,
  ): Promise<{
    removed: unknown | null;
    queue: PersistedPromptQueue | null;
    draft: PersistedComposeDraft | null;
  }> {
    if (!isNonBlankString(queueKey)) throw new Error("Prompt queue key must not be blank");
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    if (!isNonBlankString(messageId)) {
      throw new Error("Prompt queue message ID must not be blank");
    }
    if (Buffer.byteLength(queueKey, "utf8") > MAX_PROMPT_QUEUE_SOURCE_KEY_BYTES) {
      throw new Error("Prompt queue transfer key is too large");
    }
    if (Buffer.byteLength(messageId, "utf8") > MAX_PROMPT_QUEUE_SOURCE_MESSAGE_ID_BYTES) {
      throw new Error("Prompt queue transfer message ID is too large");
    }
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    if (ownerType !== "environment" && ownerType !== "project") {
      throw new Error("Compose draft owner type is invalid");
    }
    if (!isNonBlankString(ownerId)) throw new Error("Compose draft owner ID must not be blank");
    if (expectedDraftRevision !== undefined && !isNonNegativeInteger(expectedDraftRevision)) {
      throw new Error("Compose draft expected revision must be a non-negative integer");
    }
    return this.enqueuePromptQueueMutation(async () =>
      this.enqueueComposeDraftMutation(async () => {
        const environment = await this.assertEnvironmentAcceptsBackgroundState(
          environmentId,
          "Prompt queue",
        );
        if (
          (ownerType === "environment" && ownerId !== environmentId) ||
          (ownerType === "project" && ownerId !== environment.projectId)
        ) {
          throw new Error("Compose draft owner does not own the prompt queue");
        }
        const queues = await this.loadPromptQueues();
        const previousQueue = queues[queueKey];
        if (!previousQueue) {
          return { removed: null, queue: null, draft: null };
        }
        if (previousQueue.environmentId !== environmentId) {
          throw new Error("Prompt queue belongs to another environment");
        }
        const messageIndex = previousQueue.messages.findIndex(
          (candidate) => isRecord(candidate) && candidate.id === messageId,
        );
        if (messageIndex < 0) {
          return { removed: null, queue: previousQueue, draft: null };
        }
        const authoritativeMessage = previousQueue.messages[messageIndex];
        if (
          !isRecord(authoritativeMessage) ||
          typeof authoritativeMessage.text !== "string" ||
          !Array.isArray(authoritativeMessage.attachments)
        ) {
          throw new Error("Queued prompt must have text and attachments before transfer");
        }
        const value = {
          text: authoritativeMessage.text,
          mentions: [],
          attachments: authoritativeMessage.attachments,
        };

        const drafts = await this.loadComposeDrafts();
        const previousDraft = drafts[draftKey];
        let draft: PersistedComposeDraft;
        if (previousDraft) {
          if (previousDraft.ownerType !== ownerType || previousDraft.ownerId !== ownerId) {
            throw new Error("Compose draft belongs to another owner");
          }
          if (
            previousDraft.sourcePromptQueue?.queueKey !== queueKey ||
            previousDraft.sourcePromptQueue.messageId !== messageId
          ) {
            throw new Error("Compose draft already exists");
          }
          draft = previousDraft;
        } else {
          if (expectedDraftRevision !== undefined && expectedDraftRevision !== 0) {
            throw new Error("Compose draft revision conflict");
          }
          draft = {
            draftKey,
            ownerType,
            ownerId,
            value,
            sourcePromptQueue: { queueKey, messageId },
            updatedAt: nowIso(),
            revision: 1,
          };
          drafts[draftKey] = draft;
          await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
          this.announce("compose-draft", ownerId);
        }

        const messages = [...previousQueue.messages];
        const [removed] = messages.splice(messageIndex, 1);
        const queue = await this.savePromptQueueMutation(
          queues,
          queueKey,
          environmentId,
          messages,
          previousQueue,
        );
        return { removed: removed ?? null, queue, draft };
      }),
    );
  }

  async deletePromptQueuesByEnvironment(environmentId: string): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const removedKeys = Object.values(queues)
        .filter((queue) => queue.environmentId === environmentId)
        .map((queue) => queue.queueKey);
      if (removedKeys.length > 0) {
        for (const key of removedKeys) delete queues[key];
        await this.saveSensitiveJson(this.promptQueuesFile(), queues);
        this.announce("prompt-queue", environmentId);
      }
      this.schedulePromptQueueClaimRecovery(queues);

      // Queued prompts carry user-authored text and pasted attachments, and
      // rotating the primary file leaves them readable in its backups. Always
      // scrub, even when the current primary has no matching record: a prior
      // failed delete may have removed the primary while leaving a backup.
      await this.scrubSensitiveJsonBackups(
        this.promptQueuesFile(),
        (storedKey, queue) =>
          isPersistedPromptQueue(queue, storedKey) && queue.environmentId !== environmentId,
      );
      return removedKeys;
    });
  }

  protected enqueueComposeDraftMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.composeDraftsFile(),
        "compose draft storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.composeDraftMutation.then(run, run);
    this.composeDraftMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected validComposeDrafts(stored: unknown): Record<string, PersistedComposeDraft> {
    if (!isRecord(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(([storedKey, draft]) =>
        isPersistedComposeDraft(draft, storedKey),
      ),
    ) as Record<string, PersistedComposeDraft>;
  }

  protected async loadComposeDrafts(): Promise<Record<string, PersistedComposeDraft>> {
    const stored = await this.loadJson<unknown>(this.composeDraftsFile(), () => ({}));
    return this.validComposeDrafts(stored);
  }
}
