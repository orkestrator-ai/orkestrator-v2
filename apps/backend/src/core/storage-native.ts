import * as shared from "./storage-shared.js";
import type {
  CoordinatorWorkflowAssociation,
  CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import {
  MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES,
  MAX_PERSISTED_NATIVE_AGENT_PENDING_STEER_BYTES,
  NATIVE_AGENT_SESSION_VERSION,
  createHash,
  PendingNativeAgentDispatchError,
  PendingNativeAgentSteerError,
  isAgentInteractionResolutionJournal,
  isAgentPlatform,
  isNonBlankString,
  isPersistedNativeAgentSession,
  isPersistedPromptQueue,
  isRecord,
  nowIso,
  pruneAgentInteractionResolutionJournal,
  resolveNativeAgentInteractionMetadata,
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
type PersistedNativeAgentPendingSteer = shared.PersistedNativeAgentPendingSteer;
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

import { StorageReviews } from "./storage-reviews.ts";
import {
  isNativeAgentSteerRejectedOutcome,
  nativeAsyncQuestionItemId,
  type NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import type { IncompleteTurnNotice } from "./models.js";
import {
  isNativeAgentDisplayTail,
  type NativeAgentDisplayTail,
} from "./native-agent-display-tails.js";
import {
  NativeAgentDisplayTailStore,
  type NativeAgentDisplayTailDeletion,
} from "./native-agent-display-tail-store.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";

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

export abstract class StorageNative extends StorageReviews {
  private displayTailStoreInstance: NativeAgentDisplayTailStore | null = null;
  async getCoordinatorWorkspaceById(_coordinatorId: string): Promise<CoordinatorWorkspace | null> {
    throw new Error("Coordinator storage is unavailable in this storage layer");
  }

  async listCoordinatorWorkspaces(): Promise<CoordinatorWorkspace[]> {
    throw new Error("Coordinator storage is unavailable in this storage layer");
  }

  /**
   * Delegations the mail layer must consult before it schedules an injection.
   *
   * Declared here rather than only on the composed service because the mail
   * store sits below the coordinator store in the storage chain and still has
   * to answer "is this worker's coordinator waiting on it right now?". Empty is
   * the honest answer for a layer with no coordinator store: no delegation is
   * open, so nothing is held.
   */
  async listOpenCoordinatorDelegations(): Promise<CoordinatorWorkflowAssociation[]> {
    return [];
  }

  /**
   * Every coordinator workflow association, so the mail layer can tell which
   * environments a coordinator created. Empty for the same reason as above.
   */
  async listAllCoordinatorWorkflowAssociations(): Promise<CoordinatorWorkflowAssociation[]> {
    return [];
  }

  private announceNativeAgentRecord(
    session: Pick<PersistedNativeAgentSession, "environmentId" | "agent" | "logicalSessionKey">,
    deleted = false,
  ): void {
    this.announce(
      "native-agent-session",
      session.environmentId,
      undefined,
      { agent: session.agent, logicalSessionKey: session.logicalSessionKey },
      deleted,
    );
  }

  async getAgentInteractionResolutionJournal(): Promise<AgentInteractionResolutionJournal> {
    return this.enqueueAgentInteractionJournalMutation(async () =>
      pruneAgentInteractionResolutionJournal(await this.loadAgentInteractionResolutionJournal()),
    );
  }

  /**
   * Serializes cross-process journal transitions under one file lock. Callers
   * cannot persist request or answer content because the protocol guard accepts
   * only bounded identities, fences, timestamps, states, and outcomes.
   */
  async updateAgentInteractionResolutionJournal(
    update: (journal: AgentInteractionResolutionJournal) => AgentInteractionResolutionJournal,
  ): Promise<AgentInteractionResolutionJournal> {
    return this.enqueueAgentInteractionJournalMutation(async () => {
      const current = pruneAgentInteractionResolutionJournal(
        await this.loadAgentInteractionResolutionJournal(),
      );
      const next = pruneAgentInteractionResolutionJournal(update(current));
      if (!isAgentInteractionResolutionJournal(next)) {
        throw new Error("Agent interaction resolution journal update is invalid");
      }
      await this.saveSensitiveJson(this.agentInteractionJournalFile(), next);
      return next;
    });
  }

  /**
   * Splits the store into records this build understands and records it does
   * not. Both halves matter: an unreadable record must never be reused, reused
   * as a mapping, or quietly discarded — the latter would destroy a session a
   * newer build wrote and the user could still downgrade back into.
   *
   * Failing the *whole file* on one bad record would take down every native
   * tab in every environment, and would block the environment deletion that is
   * the user's only way to clear it. So the refusal is scoped to the key.
   */
  protected async loadNativeAgentSessions(): Promise<LoadedNativeAgentSessions> {
    const stored = await this.loadJson<unknown>(this.nativeAgentSessionsFile(), () => ({}));
    if (!isRecord(stored)) {
      throw new Error("Stored native agent sessions are invalid");
    }
    // Legacy unversioned records were upgraded once at import
    // (storage-record-upgrades.ts), so anything that does not validate now is
    // a record this build cannot read.
    const sessions: Record<string, PersistedNativeAgentSession> = {};
    const opaque: Record<string, unknown> = {};
    for (const [storedKey, session] of Object.entries(stored)) {
      if (isPersistedNativeAgentSession(session, storedKey)) sessions[storedKey] = session;
      else opaque[storedKey] = session;
    }
    return { sessions, opaque };
  }

  /**
   * Writes (or, with `undefined`, deletes) exactly one session's row. Other
   * keys — including unreadable records — are never re-serialized, so a holder
   * of one key's lease cannot overwrite another key's concurrent commit.
   *
   * `requireLiveEnvironment` fences an insert against environment deletion in
   * the same transaction: deletion sets the environment's tombstone before it
   * sweeps its sessions, so a create that commits after the tombstone could
   * otherwise leave a record behind that the sweep had already passed.
   */
  protected async saveNativeAgentSession(
    key: string,
    session: PersistedNativeAgentSession | undefined,
    options: { requireLiveEnvironment?: string } = {},
  ): Promise<void> {
    const environmentId = options.requireLiveEnvironment;
    this.updateStoreRow(this.nativeAgentSessionsFile(), key, () => {
      if (environmentId && !coordinatorIdFromRuntimeId(environmentId)) {
        const environment = this.database.readStoreRow(
          this.storeForFile(this.environmentsFile())!,
          environmentId,
        );
        if (!isRecord(environment)) {
          throw new Error(`Native agent session environment not found: ${environmentId}`);
        }
        if (environment.deletionRequestedAt) {
          throw new Error(`Native agent session environment is being deleted: ${environmentId}`);
        }
      }
      return session === undefined
        ? { result: undefined, delete: true }
        : { result: undefined, value: session };
    });
  }

  protected assertReadableNativeAgentSession(loaded: LoadedNativeAgentSessions, key: string): void {
    if (key in loaded.opaque) {
      throw new Error(
        "Stored native agent session metadata is invalid or uses an unsupported version",
      );
    }
  }

  async getNativeAgentSession(key: string): Promise<PersistedNativeAgentSession | null> {
    if (!isNonBlankString(key)) {
      throw new Error("Native agent session key must not be blank");
    }
    // Lock-free: `getOrCreateNativeAgentSession` holds this key's lease across
    // an external provider create, so a routine tab reattach must not wait on
    // it. Every caller treats the result as advisory and re-checks under the
    // lease before acting.
    const loaded = await this.loadNativeAgentSessions();
    this.assertReadableNativeAgentSession(loaded, key);
    return loaded.sessions[key] ?? null;
  }

  /**
   * Backend-owned native session catalogue used by background reconcilers.
   * Keep this internal to the backend command surface: provider session IDs are
   * sensitive implementation details and never need to reach a renderer.
   */
  async listNativeAgentSessions(): Promise<PersistedNativeAgentSession[]> {
    return Object.values((await this.loadNativeAgentSessions()).sessions);
  }

  /**
   * Creates a provider session while holding the same cross-process lock that
   * publishes its logical mapping. OpenCode cannot accept a caller-supplied
   * session id, so releasing the lock between the read and external create
   * would allow two backend processes to create two real provider sessions.
   */
  async getOrCreateNativeAgentSession(
    input: Pick<
      PersistedNativeAgentSession,
      "key" | "environmentId" | "agent" | "logicalSessionKey"
    > &
      Partial<
        Pick<
          PersistedNativeAgentSession,
          | "origin"
          | "interactionPolicy"
          | "controls"
          | "owner"
          | "executionPolicy"
          | "policy"
          | "initialPromptPresentation"
        >
      >,
    createProviderSession: () => Promise<string>,
  ): Promise<PersistedNativeAgentSession> {
    const interactionMetadata = resolveNativeAgentInteractionMetadata(input);
    if (
      !isNonBlankString(input.key) ||
      !isNonBlankString(input.environmentId) ||
      !isNonBlankString(input.logicalSessionKey) ||
      !isAgentPlatform(input.agent) ||
      !interactionMetadata
    ) {
      throw new Error("Native agent session input is invalid");
    }

    return this.enqueueNativeAgentSessionMutation(input.key, async () => {
      await this.assertEnvironmentAcceptsBackgroundState(
        input.environmentId,
        "Native agent session",
      );
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, input.key);
      const existing = sessions[input.key];
      if (existing) {
        if (
          existing.environmentId !== input.environmentId ||
          existing.agent !== input.agent ||
          existing.logicalSessionKey !== input.logicalSessionKey ||
          (input.origin !== undefined && existing.origin !== input.origin) ||
          (input.interactionPolicy !== undefined &&
            existing.interactionPolicy.mode !== input.interactionPolicy.mode)
        ) {
          throw new Error("Native agent session key collision");
        }
        if (
          existing.initialPromptPresentation &&
          input.initialPromptPresentation &&
          JSON.stringify(existing.initialPromptPresentation) !==
            JSON.stringify(input.initialPromptPresentation)
        ) {
          throw new Error("Native agent initial prompt presentation cannot change");
        }
        if (
          (!existing.owner && input.owner) ||
          (!existing.initialPromptPresentation && input.initialPromptPresentation)
        ) {
          const migratedOwner = {
            ...existing,
            ...(input.owner ? { owner: input.owner } : {}),
            ...(input.executionPolicy ? { executionPolicy: input.executionPolicy } : {}),
            ...(input.policy ? { policy: input.policy } : {}),
            ...(input.initialPromptPresentation
              ? { initialPromptPresentation: input.initialPromptPresentation }
              : {}),
            updatedAt: nowIso(),
          };
          sessions[input.key] = migratedOwner;
          await this.saveNativeAgentSession(input.key, sessions[input.key]);
          return migratedOwner;
        }
        return existing;
      }

      const providerSessionId = await createProviderSession();
      if (!isNonBlankString(providerSessionId)) {
        throw new Error("Provider returned an invalid native session ID");
      }
      await this.assertEnvironmentAcceptsBackgroundState(
        input.environmentId,
        "Native agent session",
      );
      const now = nowIso();
      const saved: PersistedNativeAgentSession = {
        ...input,
        ...interactionMetadata,
        version: NATIVE_AGENT_SESSION_VERSION,
        providerSessionId,
        createdAt: now,
        updatedAt: now,
      };
      sessions[input.key] = saved;
      await this.saveNativeAgentSession(input.key, sessions[input.key], {
        requireLiveEnvironment: input.environmentId,
      });
      this.announceNativeAgentRecord(saved);
      return saved;
    });
  }

  /** Trusted service boundary only: retain the conversation while research settings change. */
  async transitionCoordinatorResearchPolicy(
    expected: PersistedNativeAgentSession,
    policy: NonNullable<PersistedNativeAgentSession["policy"]>,
    owner: NonNullable<PersistedNativeAgentSession["owner"]>,
  ): Promise<void> {
    await this.enqueueNativeAgentSessionMutation(expected.key, async () => {
      await this.assertEnvironmentAcceptsBackgroundState(
        expected.environmentId,
        "Native agent session",
      );
      const loaded = await this.loadNativeAgentSessions();
      this.assertReadableNativeAgentSession(loaded, expected.key);
      const current = loaded.sessions[expected.key];
      const alreadyApplied =
        current &&
        JSON.stringify(current.policy) === JSON.stringify(policy) &&
        JSON.stringify(current.owner) === JSON.stringify(owner) &&
        current.executionPolicy === "coordinator-read-only";
      if (
        !current ||
        current.origin !== "coordinator" ||
        owner.kind !== "coordinator" ||
        (current.owner !== undefined && current.owner.kind !== "coordinator") ||
        current.providerSessionId !== expected.providerSessionId ||
        current.environmentId !== expected.environmentId ||
        current.agent !== expected.agent ||
        current.logicalSessionKey !== expected.logicalSessionKey ||
        (!alreadyApplied &&
          (current.executionPolicy !== expected.executionPolicy ||
            JSON.stringify(current.owner) !== JSON.stringify(expected.owner) ||
            JSON.stringify(current.policy) !== JSON.stringify(expected.policy)))
      ) {
        throw new Error("Native agent session changed during coordinator research transition");
      }
      if (alreadyApplied) return;
      const updated: PersistedNativeAgentSession = {
        ...current,
        policy,
        owner,
        executionPolicy: "coordinator-read-only",
        updatedAt: nowIso(),
      };
      await this.saveNativeAgentSession(expected.key, updated);
      this.announceNativeAgentRecord(updated);
    });
  }

  async adoptNativeAgentSession(
    input: Pick<
      PersistedNativeAgentSession,
      "key" | "environmentId" | "agent" | "logicalSessionKey" | "providerSessionId"
    > &
      Partial<
        Pick<
          PersistedNativeAgentSession,
          | "origin"
          | "interactionPolicy"
          | "controls"
          | "owner"
          | "executionPolicy"
          | "policy"
          | "initialPromptPresentation"
        >
      > & {
        expectedProviderSessionId?: string;
      },
  ): Promise<PersistedNativeAgentSession> {
    const interactionMetadata = resolveNativeAgentInteractionMetadata(input);
    if (
      !isNonBlankString(input.key) ||
      !isNonBlankString(input.environmentId) ||
      !isNonBlankString(input.logicalSessionKey) ||
      !isNonBlankString(input.providerSessionId) ||
      !isAgentPlatform(input.agent) ||
      !interactionMetadata ||
      (input.expectedProviderSessionId !== undefined &&
        !isNonBlankString(input.expectedProviderSessionId))
    ) {
      throw new Error("Native agent session adoption input is invalid");
    }
    return this.enqueueNativeAgentSessionMutation(input.key, async () => {
      await this.assertEnvironmentAcceptsBackgroundState(
        input.environmentId,
        "Native agent session",
      );
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, input.key);
      const existing = sessions[input.key];
      if (existing) {
        if (
          existing.environmentId !== input.environmentId ||
          existing.agent !== input.agent ||
          existing.logicalSessionKey !== input.logicalSessionKey ||
          (input.origin !== undefined && existing.origin !== input.origin) ||
          (input.interactionPolicy !== undefined &&
            existing.interactionPolicy.mode !== input.interactionPolicy.mode)
        ) {
          throw new Error("Native agent session key collision");
        }
        if (existing.providerSessionId === input.providerSessionId) {
          /*
           * Resuming in place still reaches the provider with new controls, so
           * returning early without recording them would leave storage
           * disagreeing with the live session and reconstruct the tab with the
           * old model/mode after a restart. Only the controls can change here:
           * the provider session, identity and dispatch records are unchanged.
           */
          const controls = input.controls
            ? { ...existing.controls, ...input.controls }
            : existing.controls;
          const ownerChanged = !existing.owner && Boolean(input.owner);
          const policyChanged = !existing.executionPolicy && Boolean(input.executionPolicy);
          const normalizedPolicyChanged = !existing.policy && Boolean(input.policy);
          const promptPresentationChanged =
            !existing.initialPromptPresentation && Boolean(input.initialPromptPresentation);
          if (
            existing.initialPromptPresentation &&
            input.initialPromptPresentation &&
            JSON.stringify(existing.initialPromptPresentation) !==
              JSON.stringify(input.initialPromptPresentation)
          ) {
            throw new Error("Native agent initial prompt presentation cannot change");
          }
          if (
            (input.controls && JSON.stringify(controls) !== JSON.stringify(existing.controls)) ||
            ownerChanged ||
            policyChanged ||
            normalizedPolicyChanged ||
            promptPresentationChanged
          ) {
            const updated: PersistedNativeAgentSession = {
              ...existing,
              controls,
              ...(input.owner ? { owner: input.owner } : {}),
              ...(input.executionPolicy ? { executionPolicy: input.executionPolicy } : {}),
              ...(input.policy ? { policy: input.policy } : {}),
              ...(input.initialPromptPresentation
                ? { initialPromptPresentation: input.initialPromptPresentation }
                : {}),
              updatedAt: nowIso(),
            };
            sessions[input.key] = updated;
            await this.saveNativeAgentSession(input.key, sessions[input.key]);
            this.announceNativeAgentRecord(updated);
            return updated;
          }
          return existing;
        }
        if (existing.providerSessionId !== input.expectedProviderSessionId) {
          throw new Error("Native agent session provider collision");
        }
      } else if (input.expectedProviderSessionId !== undefined) {
        throw new Error("Native agent session replacement target was not found");
      }

      const now = nowIso();
      const { expectedProviderSessionId: _expectedProviderSessionId, ...identity } = input;
      const saved: PersistedNativeAgentSession = {
        ...identity,
        ...(existing
          ? {
              origin: existing.origin,
              interactionPolicy: existing.interactionPolicy,
              controls: input.controls
                ? {
                    ...existing.controls,
                    ...input.controls,
                    ...(input.controls.parameterValues
                      ? {
                          parameterValues: {
                            ...existing.controls?.parameterValues,
                            ...input.controls.parameterValues,
                          },
                        }
                      : {}),
                  }
                : existing.controls,
              initialPromptPresentation:
                input.initialPromptPresentation ?? existing.initialPromptPresentation,
            }
          : interactionMetadata),
        version: NATIVE_AGENT_SESSION_VERSION,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      sessions[input.key] = saved;
      await this.saveNativeAgentSession(input.key, sessions[input.key], {
        requireLiveEnvironment: input.environmentId,
      });
      if (existing?.pendingDispatch) {
        await this.scrubPendingNativeAgentDispatchBackups(
          input.key,
          existing.pendingDispatch.requestId,
        );
      }
      this.announceNativeAgentRecord(saved);
      return saved;
    });
  }

  async updateNativeAgentSessionControls(
    key: string,
    expectedProviderSessionId: string,
    update: import("@orkestrator/protocol/native-agent").NativeAgentControlUpdate,
    applyControls?: () => Promise<void>,
  ): Promise<PersistedNativeAgentSession> {
    if (!isNonBlankString(key) || !isNonBlankString(expectedProviderSessionId)) {
      throw new Error("Native agent control update identity is invalid");
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const existing = sessions[key];
      if (!existing || existing.providerSessionId !== expectedProviderSessionId) {
        throw new Error("Native agent control update target is stale");
      }
      // Apply provider controls and persist them under the same session lease
      // that guards prompt delivery; neither side may overtake a send.
      await applyControls?.();
      const modelChanged =
        update.modelId !== undefined && update.modelId !== existing.controls?.modelId;
      // Most parameter values are model-scoped and must be cleared when their
      // model changes. Claude's settings-backed values are session defaults:
      // unsupported models ignore context1m, and switching back must restore
      // the value the session started with rather than losing it permanently.
      const retainedParameterValues = modelChanged
        ? Object.fromEntries(
            Object.entries(existing.controls?.parameterValues ?? {}).filter(
              ([id]) =>
                existing.agent === "claude" &&
                (id === "thinking" || id === "context1m" || id === "chrome"),
            ),
          )
        : Object.fromEntries(
            Object.entries(existing.controls?.parameterValues ?? {}).filter(
              ([id]) =>
                (id !== "permissionMode" || update.mode === undefined) &&
                !(
                  existing.agent === "claude" &&
                  id === "ultracode" &&
                  update.reasoningId !== undefined
                ),
            ),
          );
      const controls = {
        ...existing.controls,
        ...update,
        ...(update.parameterValues
          ? {
              parameterValues: {
                ...retainedParameterValues,
                ...update.parameterValues,
              },
            }
          : Object.keys(retainedParameterValues).length > 0
            ? { parameterValues: retainedParameterValues }
            : { parameterValues: undefined }),
      };
      const updated: PersistedNativeAgentSession = {
        ...existing,
        controls,
        updatedAt: nowIso(),
      };
      if (update.modelId !== undefined) delete updated.inferredComposerSelection;
      sessions[key] = updated;
      await this.saveNativeAgentSession(key, sessions[key]);
      this.announceNativeAgentRecord(updated);
      return updated;
    });
  }

  /**
   * Persist an observed OpenCode model only when the current record still has
   * no user-chosen or previously inferred selection. Reloads under the session
   * mutation lock so a later stale projection cannot overwrite an explicit
   * choice that landed while that projection was in flight.
   */
  async initializeNativeAgentSessionInferredComposerIfAbsent(
    key: string,
    expectedProviderSessionId: string,
    selection: { modelId: string; reasoningId?: string },
  ): Promise<PersistedNativeAgentSession> {
    if (!isNonBlankString(key) || !isNonBlankString(expectedProviderSessionId)) {
      throw new Error("Native agent control update identity is invalid");
    }
    if (!isNonBlankString(selection.modelId)) {
      throw new Error("Native agent inferred composer selection is invalid");
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const existing = sessions[key];
      if (!existing || existing.providerSessionId !== expectedProviderSessionId) {
        throw new Error("Native agent control update target is stale");
      }
      if (
        isNonBlankString(existing.controls?.modelId) ||
        isNonBlankString(existing.inferredComposerSelection?.modelId)
      ) {
        return existing;
      }
      const updated: PersistedNativeAgentSession = {
        ...existing,
        inferredComposerSelection: {
          modelId: selection.modelId,
          ...(isNonBlankString(selection.reasoningId)
            ? { reasoningId: selection.reasoningId }
            : {}),
        },
        updatedAt: nowIso(),
      };
      sessions[key] = updated;
      await this.saveNativeAgentSession(key, sessions[key]);
      this.announceNativeAgentRecord(updated);
      return updated;
    });
  }

  async invalidateNativeAgentSession(key: string, providerSessionId: string): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(providerSessionId)) {
      throw new Error("Native agent session identity must not be blank");
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const existing = sessions[key];
      if (!existing || existing.providerSessionId !== providerSessionId) {
        return false;
      }
      delete sessions[key];
      await this.saveNativeAgentSession(key, sessions[key]);
      await this.scrubSensitiveJsonBackups(
        this.nativeAgentSessionsFile(),
        (storedKey) => storedKey !== key,
      );
      this.announceNativeAgentRecord(existing, true);
      return true;
    }).then(async (removed) => {
      if (removed) await this.deleteNativeAgentDisplayTail(key);
      return removed;
    });
  }

  /**
   * Display tails are rows of their own database store, one per session:
   * reading or writing one session's restart preview touches only that row.
   * Constructed lazily so storage that never shows a native session never
   * runs the one-time cleanup of the old cache files.
   */
  protected nativeAgentDisplayTailStore(): NativeAgentDisplayTailStore {
    this.displayTailStoreInstance ??= new NativeAgentDisplayTailStore({
      database: () => this.database,
      legacyRoot: this.dataDir,
    });
    return this.displayTailStoreInstance;
  }

  async getNativeAgentDisplayTail(key: string): Promise<NativeAgentDisplayTail | null> {
    if (!isNonBlankString(key)) {
      throw new Error("Native agent display tail key must not be blank");
    }
    return this.nativeAgentDisplayTailStore().get(key);
  }

  /**
   * `fence` is a value from `captureNativeAgentDisplayTailFence` taken when the
   * tail was produced; the write is refused if the key or its environment was
   * deleted since. Omitted, the fence is taken now.
   */
  async putNativeAgentDisplayTail(
    key: string,
    tail: NativeAgentDisplayTail,
    options: { fence?: number } = {},
  ): Promise<boolean> {
    if (!isNonBlankString(key) || !isNativeAgentDisplayTail(tail)) return false;
    return this.nativeAgentDisplayTailStore().put(key, tail, options);
  }

  captureNativeAgentDisplayTailFence(): number {
    return this.nativeAgentDisplayTailStore().captureFence();
  }

  onNativeAgentDisplayTailDeleted(
    listener: (event: NativeAgentDisplayTailDeletion) => void,
  ): () => void {
    return this.nativeAgentDisplayTailStore().onDeleted(listener);
  }

  async deleteNativeAgentDisplayTail(key: string): Promise<void> {
    if (!isNonBlankString(key)) return;
    await this.nativeAgentDisplayTailStore().delete(key);
  }

  async deleteNativeAgentDisplayTailsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) return;
    await this.nativeAgentDisplayTailStore().deleteByEnvironment(environmentId);
  }

  async deleteNativeAgentSessionsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) return;
    // The environment's tombstone is already set, and inserts check it in
    // their commit (`saveNativeAgentSession`), so no new key can appear
    // behind this sweep. Each existing key is deleted under its own lease —
    // one at a time, never two held at once — so an in-flight dispatch on a
    // key finishes (and its confirmed turn is removed with it) first.
    //
    // Deliberately does not refuse an unreadable record. This is the path a
    // user takes to clear one, so it must always complete; unreadable records
    // are carried across untouched, since nothing here can prove which
    // environment they belong to.
    const keys = Object.entries((await this.loadNativeAgentSessions()).sessions)
      .filter(([, session]) => session.environmentId === environmentId)
      .map(([key]) => key)
      .sort();
    let removed = false;
    for (const key of keys) {
      removed =
        (await this.enqueueNativeAgentSessionMutation(key, async () => {
          const { sessions } = await this.loadNativeAgentSessions();
          if (sessions[key]?.environmentId !== environmentId) return false;
          await this.saveNativeAgentSession(key, undefined);
          return true;
        })) || removed;
    }
    // Only a real deletion is worth waking every client for.
    if (removed) this.announce("native-agent-session", environmentId);
    // Unconditional: a retry after a partial failure finds the sessions
    // already gone, and must still clear the tails that failure left.
    await this.deleteNativeAgentDisplayTailsByEnvironment(environmentId);
    await this.scrubSensitiveJsonBackups(
      this.nativeAgentSessionsFile(),
      (_key, record) => !isRecord(record) || record.environmentId !== environmentId,
    );
    // The deleted rows' provider session ids and dispatch journals must not
    // survive in free pages or the WAL either.
    this.scrubDeletedDatabaseContent();
  }

  async dispatchNativeAgentPromptOnce(
    key: string,
    requestId: string,
    dispatch: (session: PersistedNativeAgentSession) => Promise<void | {
      dispatched: false;
      mailRefused?: true;
      /** Recorded under the session's persisted notice field; `null` clears it. */
      incompleteTurnNotice?: IncompleteTurnNotice | null;
    }>,
    pendingDispatch?: PersistedNativeAgentPendingDispatch,
  ): Promise<{
    session: PersistedNativeAgentSession;
    dispatched: boolean;
  }> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent dispatch key must not be blank");
    }
    if (pendingDispatch) {
      let serialized: string;
      try {
        serialized = JSON.stringify(pendingDispatch);
      } catch {
        throw new Error("Pending native agent dispatch must be JSON serializable");
      }
      if (
        Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES
      ) {
        throw new Error("Pending native agent dispatch exceeds the 32 MB limit");
      }
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      let session = sessions[key];
      if (!session) throw new Error("Native agent session was not found");
      if (session.pendingSteer) {
        throw new PendingNativeAgentSteerError(session.pendingSteer.requestId);
      }
      if (session.pendingDispatch && session.pendingDispatch.requestId !== requestId) {
        throw new PendingNativeAgentDispatchError(session.pendingDispatch.requestId);
      }
      if (session.dispatchedRequestIds?.includes(requestId)) {
        if (session.pendingDispatch?.requestId === requestId) {
          session = { ...session, pendingDispatch: undefined, updatedAt: nowIso() };
          sessions[key] = session;
          await this.saveNativeAgentSession(key, sessions[key]);
          await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
        }
        return { session, dispatched: false };
      }

      if (pendingDispatch || session.pendingDispatch?.mailRefused) {
        if (pendingDispatch && pendingDispatch.requestId !== requestId) {
          throw new Error("Pending native agent dispatch request ID mismatch");
        }
        session = {
          ...session,
          // Even a composer retry with the same ID invalidates prior refusal
          // evidence before provider I/O. Its outcome may now be ambiguous.
          pendingDispatch: {
            ...(pendingDispatch ?? session.pendingDispatch!),
            mailRefused: undefined,
          },
          updatedAt: nowIso(),
        };
        sessions[key] = session;
        // Persist before touching the provider. A crash or lost acknowledgement
        // can then replay this exact request through the same idempotency key.
        await this.saveNativeAgentSession(key, sessions[key]);
      }

      // Keep the cross-process lock until the provider has acknowledged this
      // stable request id. If the process dies after provider acceptance but
      // before this write, recovery retries the same id rather than inventing a
      // second turn.
      const outcome = await dispatch(session);
      if (outcome?.dispatched === false) {
        if (outcome.mailRefused && session.pendingDispatch?.requestId === requestId) {
          const updated: PersistedNativeAgentSession = {
            ...session,
            pendingDispatch: { ...session.pendingDispatch, mailRefused: true },
            updatedAt: nowIso(),
          };
          sessions[key] = updated;
          // Persist proof of refusal before cleanup. A restart can release this
          // fence without interpreting a missing provider journal as unsent.
          await this.saveNativeAgentSession(key, sessions[key]);
          this.announceNativeAgentRecord(updated);
          return { session: updated, dispatched: false };
        }
        if (outcome.incompleteTurnNotice === undefined) {
          // A preparation refusal happens before provider.send. The durable
          // pending row was opened only to protect the provider side effect,
          // so retaining it here would park a request that was never sent and
          // block every later request id for this session.
          if (session.pendingDispatch?.requestId === requestId) {
            const updated: PersistedNativeAgentSession = {
              ...session,
              pendingDispatch: undefined,
              updatedAt: nowIso(),
            };
            sessions[key] = updated;
            await this.saveNativeAgentSession(key, sessions[key]);
            await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
            this.announceNativeAgentRecord(updated);
            return { session: updated, dispatched: false };
          }
          return { session, dispatched: false };
        }
        const updated: PersistedNativeAgentSession = {
          ...session,
          pendingDispatch: undefined,
          ...(outcome.incompleteTurnNotice === null
            ? { openCodeIncompleteTurnNotice: undefined }
            : {
                openCodeIncompleteTurnNotice: outcome.incompleteTurnNotice,
              }),
          updatedAt: nowIso(),
        };
        sessions[key] = updated;
        await this.saveNativeAgentSession(key, sessions[key]);
        await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
        this.announceNativeAgentRecord(updated);
        return { session: updated, dispatched: false };
      }
      const updated: PersistedNativeAgentSession = {
        ...session,
        // Any successfully accepted prompt supersedes a prior recovery notice.
        openCodeIncompleteTurnNotice: undefined,
        pendingDispatch: undefined,
        retiredDispatch: undefined,
        dispatchedRequestIds: [...(session.dispatchedRequestIds ?? []).slice(-999), requestId],
        updatedAt: nowIso(),
      };
      sessions[key] = updated;
      await this.saveNativeAgentSession(key, sessions[key]);
      await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.announceNativeAgentRecord(updated);
      return { session: updated, dispatched: true };
    });
  }

  /**
   * Record that a parked dispatch is known to have reached the provider.
   *
   * This is the settled end of the ambiguity the pending record exists to
   * describe: the provider has since confirmed it holds this request id, so the
   * record is cleared *and* the id joins `dispatchedRequestIds`. Both halves
   * matter — clearing alone would let a later retry of the same id dispatch the
   * turn a second time, which is the exact outcome the journal exists to
   * prevent.
   *
   * Returns false when this key has no pending record for `requestId`, so a
   * caller racing a real acknowledgement cannot resurrect one.
   */
  async confirmNativeAgentDispatch(key: string, requestId: string): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent dispatch identity must not be blank");
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingDispatch?.requestId !== requestId) {
        return false;
      }
      sessions[key] = {
        ...session,
        pendingDispatch: undefined,
        retiredDispatch: undefined,
        dispatchedRequestIds: session.dispatchedRequestIds?.includes(requestId)
          ? session.dispatchedRequestIds
          : [...(session.dispatchedRequestIds ?? []).slice(-999), requestId],
        updatedAt: nowIso(),
      };
      await this.saveNativeAgentSession(key, sessions[key]);
      await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.announceNativeAgentRecord(sessions[key]!);
      return true;
    });
  }

  async clearPendingNativeAgentDispatch(
    key: string,
    requestId: string,
    onlyMailRefused = false,
  ): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Pending native agent dispatch identity must not be blank");
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (
        !session ||
        session.pendingDispatch?.requestId !== requestId ||
        (onlyMailRefused && !session.pendingDispatch.mailRefused)
      ) {
        return false;
      }
      sessions[key] = {
        ...session,
        pendingDispatch: undefined,
        updatedAt: nowIso(),
      };
      await this.saveNativeAgentSession(key, sessions[key]);
      await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.announceNativeAgentRecord(sessions[key]!);
      return true;
    });
  }

  /**
   * Resolve a parked dispatch the provider reports lost.
   *
   * The provider recorded this id in an earlier process and will refuse it for
   * good, so the record can never be retried into a turn. It is cleared like a
   * retry refused with `requestIdRetired`, and a content-free
   * `retiredDispatch` marker replaces any earlier one so every renderer can
   * release the draft's id without a click. The id never joins
   * `dispatchedRequestIds`: nothing proves its turn ran.
   *
   * Returns false when this key has no pending record for `requestId`.
   */
  async retireNativeAgentDispatch(key: string, requestId: string): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent dispatch identity must not be blank");
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingDispatch?.requestId !== requestId) {
        return false;
      }
      sessions[key] = {
        ...session,
        pendingDispatch: undefined,
        retiredDispatch: { requestId, retiredAt: nowIso() },
        updatedAt: nowIso(),
      };
      await this.saveNativeAgentSession(key, sessions[key]);
      await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.announceNativeAgentRecord(sessions[key]!);
      return true;
    });
  }

  /** Reserve under the session lock before publishing a durable steer record.
   * Lock order is session, then queue. A crash between the two writes leaves
   * an unsent reservation that recoverPromptQueueSteer restores.
   */
  async reservePromptQueueSteer(
    key: string,
    messageId: string,
    expectedRunId: string,
  ): Promise<PersistedNativeAgentPendingSteer | null> {
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      this.assertReadableNativeAgentSession(loaded, key);
      const session = loaded.sessions[key];
      if (!session) throw new Error("Native agent session was not found");
      if (session.pendingDispatch)
        throw new PendingNativeAgentDispatchError(session.pendingDispatch.requestId);
      if (session.pendingSteer)
        throw new PendingNativeAgentSteerError(session.pendingSteer.requestId);
      return this.enqueuePromptQueueMutation(async () => {
        const queues = await this.loadPromptQueues();
        const queueKey = `${session.agent}\0${session.logicalSessionKey}`;
        const queue = queues[queueKey];
        if (!queue || queue.environmentId !== session.environmentId) return null;
        if (queue.inFlight || queue.outstandingClaim)
          throw new Error("A queued prompt is already being delivered; refresh before steering");
        const index = queue.messages.findIndex((item) => isRecord(item) && item.id === messageId);
        const message = queue.messages[index];
        if (!isRecord(message)) return null;
        const requestId = isNonBlankString(message.requestId) ? message.requestId : messageId;
        if (
          message.command !== undefined ||
          message.origin !== undefined ||
          nativeAsyncQuestionItemId(messageId) ||
          nativeAsyncQuestionItemId(requestId) ||
          (Array.isArray(message.attachments) && message.attachments.length > 0)
        ) {
          throw new Error("This queued item cannot be steered");
        }
        if (
          !isNonBlankString(message.text) ||
          Buffer.byteLength(message.text, "utf8") > 64 * 1024 ||
          Buffer.byteLength(requestId, "utf8") > 512
        )
          throw new Error("Queued steering text or identity is invalid");
        if (session.dispatchedRequestIds?.includes(requestId)) {
          throw new Error("This queued request was already delivered; refresh before steering");
        }
        const pending: PersistedNativeAgentPendingSteer = {
          requestId,
          text: message.text.trim(),
          inputDigest: createHash("sha256").update(message.text.trim()).digest("hex"),
          expectedRunId,
          state: "prepared",
          sourceQueue: true,
          createdAt: nowIso(),
        };
        queues[queueKey] = {
          ...queue,
          messages: queue.messages.filter((_, i) => i !== index),
          inFlight: { message, requestId, reservedAt: nowIso(), steer: true },
          updatedAt: nowIso(),
          revision: queue.revision + 1,
        };
        await this.saveSensitiveJson(this.promptQueuesFile(), queues);
        await this.saveNativeAgentSession(key, {
          ...session,
          pendingSteer: pending,
          updatedAt: nowIso(),
        });
        this.announce("prompt-queue", session.environmentId);
        return pending;
      });
    });
  }

  /** Called with the session lock. Persist a terminal intent before touching
   * the source, so restart/retry can finish even an explicit discard exactly once.
   */
  private async finishQueuedSteer(
    session: PersistedNativeAgentSession,
    settlement: "applied" | "restore" | "discard",
  ): Promise<void> {
    const pending = session.pendingSteer;
    if (!pending?.sourceQueue) return;
    await this.saveNativeAgentSession(session.key, {
      ...session,
      pendingSteer: { ...pending, queueSettlement: settlement },
    });
    await this.settlePromptQueueSteerSource(session, pending.requestId, settlement);
  }

  private async settlePromptQueueSteerSource(
    session: PersistedNativeAgentSession,
    requestId: string,
    settlement: "applied" | "restore" | "discard",
  ): Promise<void> {
    await this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const queueKey = `${session.agent}\0${session.logicalSessionKey}`;
      const queue = queues[queueKey];
      if (
        !queue?.inFlight?.steer ||
        queue.inFlight.requestId !== requestId ||
        queue.environmentId !== session.environmentId
      )
        return;
      const { inFlight, ...rest } = queue;
      queues[queueKey] = {
        ...rest,
        messages:
          settlement === "restore"
            ? [
                inFlight.message,
                ...queue.messages.filter(
                  (item) =>
                    !isRecord(item) ||
                    !isRecord(inFlight.message) ||
                    item.id !== inFlight.message.id,
                ),
              ]
            : queue.messages,
        updatedAt: nowIso(),
        revision: queue.revision + 1,
      };
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", session.environmentId);
    });
  }

  private async completePendingSteer(
    session: PersistedNativeAgentSession,
    settlement: "applied" | "restore" | "discard",
  ): Promise<void> {
    const requestId = session.pendingSteer!.requestId;
    await this.finishQueuedSteer(session, settlement);
    const saved = {
      ...session,
      pendingSteer: undefined,
      ...(settlement === "applied"
        ? {
            dispatchedRequestIds: [
              ...(session.dispatchedRequestIds ?? []).filter((id) => id !== requestId).slice(-999),
              requestId,
            ],
          }
        : {}),
      updatedAt: nowIso(),
    };
    await this.saveNativeAgentSession(session.key, saved);
    await this.scrubPendingNativeAgentSteerBackups(session.key, requestId);
    this.announceNativeAgentRecord(saved);
  }

  /** The journal read shares dispatch's lock: an absent answer read before a
   * concurrent send must never clear that send's newer ambiguous receipt.
   */
  async reconcileNativeAgentSteer(
    key: string,
    requestId: string,
    readStatus: () => Promise<"dispatched" | "absent" | "unknown">,
  ): Promise<"dispatched" | "absent" | undefined> {
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      this.assertReadableNativeAgentSession(loaded, key);
      const session = loaded.sessions[key];
      if (!session || session.pendingSteer?.requestId !== requestId) return undefined;
      if (session.pendingSteer.queueSettlement) {
        const settlement = session.pendingSteer.queueSettlement;
        await this.completePendingSteer(session, settlement);
        return settlement === "applied" ? "dispatched" : "absent";
      }
      const status = await readStatus();
      if (status === "unknown") return undefined;
      await this.completePendingSteer(session, status === "dispatched" ? "applied" : "restore");
      return status;
    });
  }

  /** No provider calls: recover an interrupted transfer/settlement under the
   * same lock as dispatch. A live pending receipt always keeps its source reserved.
   */
  async recoverPromptQueueSteer(key: string, requestId: string): Promise<void> {
    await this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      this.assertReadableNativeAgentSession(loaded, key);
      const session = loaded.sessions[key];
      if (!session) return;
      if (session.pendingSteer?.requestId === requestId) {
        const settlement = session.pendingSteer.queueSettlement;
        if (!settlement) return;
        await this.completePendingSteer(session, settlement);
        return;
      }
      await this.settlePromptQueueSteerSource(
        session,
        requestId,
        session.dispatchedRequestIds?.includes(requestId) ? "applied" : "restore",
      );
    });
  }

  /**
   * Persist one backend-owned steering identity across the provider boundary.
   *
   * A provider exception is ambiguous by default: once the request was handed
   * off, this layer cannot prove which side of admission it occurred on. The
   * exact record therefore stays parked as `unknown` and every retry reuses it.
   * Only a returned, verified `rejected` outcome (never a thrown error) proves
   * the provider refused the request before delivery.
   */
  async dispatchNativeAgentSteerOnce(
    key: string,
    pendingSteer: PersistedNativeAgentPendingSteer,
    dispatch: (session: PersistedNativeAgentSession) => Promise<NativeAgentSessionActionOutcome>,
  ): Promise<NativeAgentSessionActionOutcome> {
    if (
      !isNonBlankString(key) ||
      !isNonBlankString(pendingSteer.requestId) ||
      Buffer.byteLength(pendingSteer.requestId, "utf8") > 512 ||
      !isNonBlankString(pendingSteer.text) ||
      Buffer.byteLength(pendingSteer.text, "utf8") > 64 * 1024 ||
      !/^[a-f0-9]{64}$/.test(pendingSteer.inputDigest) ||
      !isNonBlankString(pendingSteer.expectedRunId) ||
      Buffer.byteLength(pendingSteer.expectedRunId, "utf8") > 512
    ) {
      throw new Error("Native agent steer record is invalid");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(pendingSteer);
    } catch {
      throw new Error("Pending native agent steer must be JSON serializable");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_NATIVE_AGENT_PENDING_STEER_BYTES) {
      throw new Error("Pending native agent steer exceeds its persistence limit");
    }

    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      let session = sessions[key];
      if (!session) throw new Error("Native agent session was not found");
      if (session.pendingDispatch) {
        throw new PendingNativeAgentDispatchError(session.pendingDispatch.requestId);
      }
      if (session.dispatchedRequestIds?.includes(pendingSteer.requestId) && !session.pendingSteer) {
        return { outcome: "applied" };
      }
      if (pendingSteer.sourceQueue && session.pendingSteer?.requestId !== pendingSteer.requestId)
        return { outcome: "mismatch" };
      if (session.pendingSteer?.queueSettlement) {
        throw new Error("Queued steering settlement is pending; refresh before retrying");
      }
      if (session.pendingSteer) {
        if (session.pendingSteer.requestId !== pendingSteer.requestId) {
          throw new PendingNativeAgentSteerError(session.pendingSteer.requestId);
        }
        if (
          session.pendingSteer.inputDigest !== pendingSteer.inputDigest ||
          session.pendingSteer.expectedRunId !== pendingSteer.expectedRunId
        ) {
          return { outcome: "unknown", requestId: pendingSteer.requestId };
        }
      } else {
        session = {
          ...session,
          pendingSteer,
          updatedAt: nowIso(),
        };
        sessions[key] = session;
        // The record must be durable before a provider can queue the text.
        await this.saveNativeAgentSession(key, sessions[key]);
      }

      pendingSteer = session.pendingSteer ?? pendingSteer;
      let outcome: NativeAgentSessionActionOutcome;
      try {
        outcome = await dispatch(session);
      } catch {
        outcome = { outcome: "unknown", requestId: pendingSteer.requestId };
      }
      // A refusal is definitive only in its verified shape for this exact
      // request. It then settles like idle/mismatch: the parked record and its
      // backups go, and the id never joins the delivered history.
      if (
        outcome.outcome === "rejected" &&
        !isNativeAgentSteerRejectedOutcome(outcome, pendingSteer.requestId)
      ) {
        outcome = { outcome: "unknown", requestId: pendingSteer.requestId };
      }

      if (outcome.outcome === "unknown") {
        sessions[key] = {
          ...session,
          pendingSteer: { ...pendingSteer, state: "unknown" },
          updatedAt: nowIso(),
        };
        await this.saveNativeAgentSession(key, sessions[key]);
        this.announceNativeAgentRecord(sessions[key]!);
        return { ...outcome, requestId: pendingSteer.requestId };
      }

      await this.completePendingSteer(
        session,
        outcome.outcome === "applied" ? "applied" : "restore",
      );
      return outcome;
    });
  }

  async confirmNativeAgentSteer(key: string, requestId: string): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent steer identity must not be blank");
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingSteer?.requestId !== requestId) {
        return false;
      }
      await this.completePendingSteer(session, "applied");
      return true;
    });
  }

  async clearPendingNativeAgentSteer(
    key: string,
    requestId: string,
    discard = false,
  ): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent steer identity must not be blank");
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingSteer?.requestId !== requestId) {
        return false;
      }
      await this.completePendingSteer(session, discard ? "discard" : "restore");
      return true;
    });
  }

  /**
   * Record or clear (`null`) a session's incomplete-turn notice. It is stored
   * under the session's original `openCodeIncompleteTurnNotice` field so
   * existing session files keep their notice.
   */
  async setIncompleteTurnNotice(
    key: string,
    providerSessionId: string,
    notice: IncompleteTurnNotice | null,
  ): Promise<boolean> {
    if (
      !isNonBlankString(key) ||
      !isNonBlankString(providerSessionId) ||
      (notice !== null &&
        (!notice ||
          !isNonBlankString(notice.assistantMessageId) ||
          !["failed", "exhausted"].includes(notice.kind) ||
          !Number.isFinite(Date.parse(notice.updatedAt))))
    ) {
      throw new Error("Incomplete-turn notice is invalid");
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.providerSessionId !== providerSessionId) {
        return false;
      }
      if (notice === null && session.openCodeIncompleteTurnNotice === undefined) {
        return true;
      }
      const updated: PersistedNativeAgentSession = {
        ...session,
        openCodeIncompleteTurnNotice: notice ?? undefined,
        updatedAt: nowIso(),
      };
      sessions[key] = updated;
      await this.saveNativeAgentSession(key, sessions[key]);
      this.announceNativeAgentRecord(updated);
      return true;
    });
  }

  /**
   * Orders an operation against environment deletion intent across processes.
   * The callback intentionally runs while the environment file lock is held, so
   * deletion either becomes visible first or waits for the accepted operation
   * to finish.
   *
   * Do **not** wrap provider I/O in this. The environments lock is the hottest
   * one in the process — activity, unread, completion and deletion bookkeeping
   * all queue behind it, for every environment — and a provider call can hold it
   * for the full 90s prompt budget or a cold agent start's retry loop. Both the
   * dispatch and session-create paths deliberately fence on a plain
   * `assertEnvironmentLive` / `assertEnvironmentAcceptsBackgroundState` read
   * instead, and re-assert after the provider call where it matters. Use this
   * only for short, storage-local critical sections.
   */
  async runWithLiveEnvironment<T>(
    environmentId: string,
    label: string,
    operation: (environment: Environment) => Promise<T>,
  ): Promise<T> {
    if (!isNonBlankString(environmentId)) {
      throw new Error(`${label} environment ID must not be blank`);
    }
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) {
        throw new Error(`${label} environment not found: ${environmentId}`);
      }
      if (environment.deletionRequestedAt) {
        throw new Error(`${label} environment is being deleted: ${environmentId}`);
      }
      return operation(environment);
    });
  }

  /** Brief, storage-only snapshot ordered against both dispatch journals and queued work. */
  async readNativeAgentPublicationState(
    key: string,
    queueKey: string,
  ): Promise<{
    session: PersistedNativeAgentSession | null;
    queue: PersistedPromptQueue | null;
  }> {
    return this.enqueueNativeAgentSessionMutation(key, () =>
      this.enqueuePromptQueueMutation(async () => {
        const loaded = await this.loadNativeAgentSessions();
        this.assertReadableNativeAgentSession(loaded, key);
        const queues = await this.loadPromptQueues();
        return { session: loaded.sessions[key] ?? null, queue: queues[queueKey] ?? null };
      }),
    );
  }

  protected enqueuePromptQueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(this.promptQueuesFile(), "prompt queue storage", operation);
  }

  protected validatePromptQueueMessages(messages: unknown): asserts messages is unknown[] {
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

  protected validatePromptQueueMessage(
    message: unknown,
  ): asserts message is Record<string, unknown> {
    if (!isRecord(message) || !isNonBlankString(message.id)) {
      throw new Error("Prompt queue message must have a non-blank ID");
    }
    this.validatePromptQueueMessages([message]);
  }

  protected async savePromptQueueMutation(
    queues: Record<string, PersistedPromptQueue>,
    queueKey: string,
    environmentId: string,
    messages: unknown[],
    previous?: PersistedPromptQueue,
  ): Promise<PersistedPromptQueue> {
    this.validatePromptQueueMessages(messages);
    // Queue edits carry a claim an older backend left in place; only expiry
    // recovery (or that backend) clears it, and nothing here creates one.
    const outstandingClaim = previous?.outstandingClaim ?? null;
    const failedMessageStillUnchanged =
      previous?.dispatchError !== undefined &&
      messages.some(
        (candidate) =>
          isRecord(candidate) &&
          candidate.id === previous.dispatchError?.messageId &&
          this.promptQueueMessageFingerprint(candidate) ===
            previous.dispatchError?.messageFingerprint,
      );
    const removedOrigins = this.promptQueueRemovedOrigins(previous, messages, outstandingClaim);
    const saved: PersistedPromptQueue = {
      queueKey,
      environmentId,
      messages,
      ...(previous?.inFlight ? { inFlight: previous.inFlight } : {}),
      ...(failedMessageStillUnchanged ? { dispatchError: previous!.dispatchError } : {}),
      ...(outstandingClaim ? { outstandingClaim } : {}),
      ...(removedOrigins.length > 0 ? { removedOrigins } : {}),
      updatedAt: nowIso(),
      revision: (previous?.revision ?? 0) + 1,
    };
    queues[queueKey] = saved;
    await this.saveSensitiveJson(this.promptQueuesFile(), queues);
    this.announce("prompt-queue", environmentId);
    this.schedulePromptQueueClaimRecovery(queues);
    return saved;
  }

  /**
   * Tombstones for backend-authored items (a typed `origin` with a request id)
   * that leave `messages` in this save without moving into the claim or the
   * in-flight reservation: they were removed or replaced before dispatch.
   * Reservation writes the in-flight record directly and never comes through
   * here, so a dispatched item can never be tombstoned.
   */
  protected promptQueueRemovedOrigins(
    previous: PersistedPromptQueue | undefined,
    messages: readonly unknown[],
    outstandingClaim: PersistedPromptQueue["outstandingClaim"] | null,
  ): Array<{ requestId: string; removedAt: string }> {
    const existing = previous?.removedOrigins ?? [];
    if (!previous) return existing;
    const kept = new Set<unknown>();
    for (const candidate of [...messages, outstandingClaim?.message, previous.inFlight?.message]) {
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

  /**
   * Record how one dispatched request's turn ended, once. The outcome comes
   * from a provider status read made for another reason (the queue drain) or
   * an on-demand observer, and is bounded and content-free.
   */
  async recordNativeAgentTurnOutcome(
    key: string,
    providerSessionId: string,
    outcome: import("./models.js").PersistedNativeAgentTurnOutcome,
  ): Promise<boolean> {
    if (
      !isNonBlankString(key) ||
      !isNonBlankString(providerSessionId) ||
      !isNonBlankString(outcome.requestId) ||
      (outcome.outcome !== "completed" && outcome.outcome !== "failed")
    ) {
      throw new Error("Native agent turn outcome is invalid");
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (
        !session ||
        session.providerSessionId !== providerSessionId ||
        !session.dispatchedRequestIds?.includes(outcome.requestId) ||
        session.turnOutcomes?.some((entry) => entry.requestId === outcome.requestId)
      ) {
        return false;
      }
      sessions[key] = {
        ...session,
        turnOutcomes: [
          ...(session.turnOutcomes ?? []).slice(-49),
          {
            requestId: outcome.requestId,
            outcome: outcome.outcome,
            ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
            observedAt: outcome.observedAt,
          },
        ],
        updatedAt: nowIso(),
      };
      await this.saveNativeAgentSession(key, sessions[key]);
      return true;
    });
  }

  /**
   * Record that a stop reached a dispatched or pending request while it was still
   * active. Pending dispatches may have lost their provider acknowledgement, so
   * their interrupt must survive reconciliation and restart. A recorded
   * outcome may have raced Stop, so it must not suppress the interrupt marker.
   */
  async recordNativeAgentTurnInterrupt(
    key: string,
    providerSessionId: string,
    requestId: string,
  ): Promise<boolean> {
    if (
      !isNonBlankString(key) ||
      !isNonBlankString(providerSessionId) ||
      !isNonBlankString(requestId)
    ) {
      throw new Error("Native agent turn interrupt is invalid");
    }
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (
        !session ||
        session.providerSessionId !== providerSessionId ||
        (!session.dispatchedRequestIds?.includes(requestId) &&
          (session.pendingDispatch?.requestId !== requestId || session.pendingDispatch.mailRefused))
      ) {
        return false;
      }
      // True means the marker is durable, including an idempotent retry.
      if (session.interruptedRequestIds?.includes(requestId)) return true;
      sessions[key] = {
        ...session,
        interruptedRequestIds: [...(session.interruptedRequestIds ?? []).slice(-49), requestId],
        updatedAt: nowIso(),
      };
      await this.saveNativeAgentSession(key, sessions[key]);
      return true;
    });
  }

  protected schedulePromptQueueClaimRecovery(queues: Record<string, PersistedPromptQueue>): void {
    if (this.promptQueueClaimRecoveryTimer) {
      clearTimeout(this.promptQueueClaimRecoveryTimer);
      this.promptQueueClaimRecoveryTimer = null;
    }
    const nextExpiry = Object.values(queues).reduce<number | null>((soonest, queue) => {
      if (!queue.outstandingClaim) return soonest;
      const expiry = Date.parse(queue.outstandingClaim.expiresAt);
      if (!Number.isFinite(expiry)) return soonest;
      return soonest === null || expiry < soonest ? expiry : soonest;
    }, null);
    if (nextExpiry === null) return;
    this.promptQueueClaimRecoveryTimer = setTimeout(
      () => {
        this.promptQueueClaimRecoveryTimer = null;
        void this.recoverExpiredPromptQueueClaims().catch(() => {
          // A future read, mutation, or backend restart retries recovery. Avoid
          // logging queue errors because their values may contain prompt data.
        });
      },
      Math.max(0, nextExpiry - Date.now()),
    );
    this.promptQueueClaimRecoveryTimer.unref?.();
  }

  protected async recoverExpiredPromptQueueClaims(): Promise<void> {
    await this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const now = Date.now();
      const changedEnvironmentIds = new Set<string>();
      let changed = false;
      for (const queue of Object.values(queues)) {
        const claim = queue.outstandingClaim;
        if (!claim || Date.parse(claim.expiresAt) > now) continue;
        compatibilityPathUsage.record("prompt-queue.legacy-claim-recovered");
        const messageId = isRecord(claim.message) ? claim.message.id : undefined;
        queue.messages = [
          claim.message,
          ...queue.messages.filter(
            (candidate) =>
              messageId === undefined || !isRecord(candidate) || candidate.id !== messageId,
          ),
        ];
        delete queue.outstandingClaim;
        queue.updatedAt = nowIso();
        queue.revision += 1;
        changedEnvironmentIds.add(queue.environmentId);
        changed = true;
      }
      if (changed) {
        await this.saveSensitiveJson(this.promptQueuesFile(), queues);
        for (const environmentId of changedEnvironmentIds) {
          this.announce("prompt-queue", environmentId);
        }
      }
      this.schedulePromptQueueClaimRecovery(queues);
    });
  }

  protected async assertEnvironmentAcceptsBackgroundState(
    environmentId: string,
    label: string,
  ): Promise<Environment> {
    const coordinatorId = coordinatorIdFromRuntimeId(environmentId);
    if (coordinatorId) {
      const workspace = await this.getCoordinatorWorkspaceById(coordinatorId);
      if (!workspace) throw new Error(`${label} coordinator not found: ${coordinatorId}`);
      if (workspace.lifecycleState === "paused") {
        throw new Error(`${label} coordinator is paused`);
      }
      const project = await this.getProject(workspace.projectId);
      if (!project?.localPath) throw new Error(`${label} coordinator checkout is unavailable`);
      return {
        id: environmentId,
        projectId: workspace.projectId,
        name: "Coordinator",
        branch: workspace.repositoryStatus?.branch ?? "",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: workspace.createdAt,
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "local",
        worktreePath: project.localPath,
        setupPhase: "ready",
        setupScriptsComplete: true,
      } as Environment;
    }
    const environment = await this.getEnvironment(environmentId);
    if (!environment) {
      throw new Error(`${label} environment not found: ${environmentId}`);
    }
    if (environment.deletionRequestedAt) {
      throw new Error(`${label} environment is being deleted: ${environmentId}`);
    }
    return environment;
  }

  protected async loadPromptQueues(): Promise<Record<string, PersistedPromptQueue>> {
    const stored = await this.loadJson<Record<string, PersistedPromptQueue>>(
      this.promptQueuesFile(),
      () => ({}),
    );
    // A first-generation dispatch error was upgraded once at import
    // (storage-record-upgrades.ts); every stored error identifies its item.
    return Object.fromEntries(
      Object.entries(stored).filter(([storedKey, queue]) =>
        isPersistedPromptQueue(queue, storedKey),
      ),
    );
  }
}
