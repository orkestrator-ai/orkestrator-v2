import * as shared from "./storage-shared.js";
import path from "node:path";
import { nativeAgentSessionWithControls } from "./native-agent-session-controls.js";
import {
  nativeAgentSessionBackendTitle,
  nativeAgentSessionResumeIdentity,
  type NativeAgentSessionBackendTitle,
} from "./models.js";
import type { NativeAgentControlUpdate } from "@orkestrator/protocol/native-agent";
import {
  goalHistoryWith,
  sessionGoal,
  type NativeAgentGoal,
} from "@orkestrator/protocol/native-agent-goal";
import {
  NATIVE_AGENT_SESSION_VERSION,
  createHash,
  isAgentInteractionResolutionJournal,
  isAgentPlatform,
  isNonBlankString,
  isPersistedNativeAgentSession,
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

import { bugReportIdFromRuntimeId } from "@orkestrator/protocol/bug-report";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import { bugReportRuntimeEnvironment } from "./bug-report-runtime.js";
import type { IncompleteTurnNotice } from "./models.js";
import {
  isNativeAgentDisplayTail,
  type NativeAgentDisplayTail,
} from "./native-agent-display-tails.js";
import {
  NativeAgentDisplayTailStore,
  type NativeAgentDisplayTailDeletion,
} from "./native-agent-display-tail-store.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";

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

export class NativeAgentSessionsRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly repos: StorageRepositories,
  ) {}

  /**
   * Gives every session whose environment exists an owner. Runs at each start
   * because callers may still create sessions without one. Each key is written
   * under its own lease, so this never waits on (or blocks) the whole store.
   */
  async migrateNativeAgentSessionOwners(): Promise<void> {
    const loaded = await this.loadNativeAgentSessions();
    const environmentById = new Map(
      (await this.repos.projects.loadEnvironments()).map((environment) => [
        environment.id,
        environment,
      ]),
    );
    for (const [key, session] of Object.entries(loaded.sessions)) {
      if (session.owner || !environmentById.has(session.environmentId)) continue;
      await this.enqueueNativeAgentSessionMutation(key, async () => {
        const current = (await this.loadNativeAgentSessions()).sessions[key];
        const environment = current && environmentById.get(current.environmentId);
        if (!current || current.owner || !environment) return;
        await this.saveNativeAgentSession(key, {
          ...current,
          owner: {
            kind: "environment",
            projectId: environment.projectId,
            environmentId: environment.id,
          },
        });
      });
    }
  }

  /**
   * Serializes one native agent session's read-modify-write in this process
   * and across backend processes sharing the same data directory.
   *
   * The acquire timeout is sized for the critical section rather than for a
   * store write, like `ProjectsRepository.withProjectCreationLock`. This lease is
   * deliberately held across provider I/O: a prompt dispatch keeps it until the
   * provider has acknowledged the request id, and `getOrCreateNativeAgentSession`
   * keeps it across the external session create so two processes cannot mint
   * two provider sessions for one logical key. Those bound at ~90s (the bridge
   * prompt/attach budget) and ~122s (four 30s ACP create attempts plus backoff)
   * respectively, so the 20s default would fail a second process that is
   * waiting on a perfectly healthy holder — and the caller most exposed to that
   * is environment deletion, whose session cleanup is best-effort and would
   * therefore leave the deleted environment's record, provider session id and
   * pending prompt behind.
   *
   * This only extends patience with a *live* holder. A holder that dies stops
   * heartbeating, so the unchanged 15s stale threshold still reclaims the lease.
   */
  static readonly NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS = 180_000;

  /**
   * One lease per session key: a slow provider create or send for one session
   * no longer stalls every other session in every environment. Keys are
   * arbitrary strings, so the lease is named by their hash. Writes under it
   * touch only that key's row (`updateStoreRow`), so holders of different
   * keys cannot overwrite each other.
   *
   * Ordering: the service's per-key work fence, then this lease, then leaf
   * leases (prompt queue, display tails). Never take a native session lease
   * while holding another one, a prompt-queue lease or the environment lease.
   */
  enqueueNativeAgentSessionMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const digest = createHash("sha256").update(key).digest("hex");
    return this.context.serialize(
      this.context.file(path.join("native-agent-session-leases", digest)),
      "native agent session storage",
      operation,
      { acquireTimeoutMs: NativeAgentSessionsRepository.NATIVE_AGENT_SESSION_LOCK_TIMEOUT_MS },
    );
  }

  private enqueueAgentInteractionJournalMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(
      this.files.agentInteractionJournalFile(),
      "agent interaction journal storage",
      operation,
    );
  }

  async scrubPendingNativeAgentDispatchBackups(key: string, requestId: string): Promise<void> {
    await this.context.transformSensitiveJsonBackups(
      this.files.nativeAgentSessionsFile(),
      (records) => {
        const record = records[key];
        if (
          isRecord(record) &&
          isRecord(record.pendingDispatch) &&
          record.pendingDispatch.requestId === requestId
        ) {
          const next = { ...record };
          delete next.pendingDispatch;
          return { ...records, [key]: next };
        }
        return records;
      },
    );
  }

  private displayTailStoreInstance: NativeAgentDisplayTailStore | null = null;

  announceNativeAgentRecord(
    session: Pick<PersistedNativeAgentSession, "environmentId" | "agent" | "logicalSessionKey">,
    deleted = false,
  ): void {
    this.context.changes.announce(
      "native-agent-session",
      session.environmentId,
      undefined,
      { agent: session.agent, logicalSessionKey: session.logicalSessionKey },
      deleted,
    );
  }

  async getAgentInteractionResolutionJournal(): Promise<AgentInteractionResolutionJournal> {
    return this.enqueueAgentInteractionJournalMutation(async () =>
      pruneAgentInteractionResolutionJournal(
        await this.repos.reviews.loadAgentInteractionResolutionJournal(),
      ),
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
        await this.repos.reviews.loadAgentInteractionResolutionJournal(),
      );
      const next = pruneAgentInteractionResolutionJournal(update(current));
      if (!isAgentInteractionResolutionJournal(next)) {
        throw new Error("Agent interaction resolution journal update is invalid");
      }
      await this.context.saveSensitiveJson(this.files.agentInteractionJournalFile(), next);
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
  async loadNativeAgentSessions(): Promise<LoadedNativeAgentSessions> {
    const stored = await this.context.loadJson<unknown>(
      this.files.nativeAgentSessionsFile(),
      () => ({}),
    );
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
  async saveNativeAgentSession(
    key: string,
    session: PersistedNativeAgentSession | undefined,
    options: { requireLiveEnvironment?: string } = {},
  ): Promise<void> {
    const environmentId = options.requireLiveEnvironment;
    this.context.updateStoreRow(this.files.nativeAgentSessionsFile(), key, () => {
      if (
        environmentId &&
        !coordinatorIdFromRuntimeId(environmentId) &&
        !bugReportIdFromRuntimeId(environmentId)
      ) {
        const environment = this.context.database.readStoreRow(
          this.context.storeForFile(this.files.environmentsFile())!,
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

  assertReadableNativeAgentSession(loaded: LoadedNativeAgentSessions, key: string): void {
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

  /** Teardown must see identity captures already queued behind a provider mutation. */
  async getNativeAgentSessionAfterMutations(
    key: string,
  ): Promise<PersistedNativeAgentSession | null> {
    return this.enqueueNativeAgentSessionMutation(key, () => this.getNativeAgentSession(key));
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

  /**
   * Change a session's goal under the session lease, so it cannot race a
   * dispatch or another change. `update` returns the next goal, `null` to remove
   * it, or `undefined` to change nothing; a stale caller decides that from the
   * goal it is handed. A replaced or removed goal moves to the bounded history.
   */
  async updateNativeAgentGoal(
    key: string,
    update: (
      goal: NativeAgentGoal | undefined,
      session: PersistedNativeAgentSession,
    ) => NativeAgentGoal | null | undefined,
  ): Promise<PersistedNativeAgentSession | undefined> {
    if (!isNonBlankString(key)) throw new Error("Native agent goal update key is invalid");
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session) return undefined;
      const current = sessionGoal(session);
      const next = update(current, session);
      if (next === undefined) return session;
      const replaced = current && (next === null || next.goalId !== current.goalId);
      const { goal: _goal, ...rest } = session;
      const updated: PersistedNativeAgentSession = {
        ...rest,
        ...(next ? { goal: next } : {}),
        ...(replaced ? { goalHistory: goalHistoryWith(session.goalHistory, current) } : {}),
        updatedAt: nowIso(),
      };
      sessions[key] = updated;
      await this.saveNativeAgentSession(key, updated);
      this.announceNativeAgentRecord(updated);
      return updated;
    });
  }

  async updateNativeAgentSessionControls(
    key: string,
    expectedProviderSessionId: string,
    update: NativeAgentControlUpdate,
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
      const updated = nativeAgentSessionWithControls(existing, update);
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

  /**
   * Remember the identity a later resume of this session names, as the
   * provider reported it while the session was open. Tab teardown falls back
   * to it when the session can no longer be read (Codex resumes a thread, which
   * only the open bridge session can name). Writes only when the value
   * changes, scoped to the provider session it was read from; a mapping that
   * has moved on is left alone. Backend-only, so nothing is announced.
   */
  async recordNativeAgentSessionResumeIdentity(
    key: string,
    providerSessionId: string,
    resumableSessionId: string,
  ): Promise<boolean> {
    if (
      !isNonBlankString(key) ||
      !isNonBlankString(providerSessionId) ||
      !isNonBlankString(resumableSessionId)
    ) {
      throw new Error("Native agent resume identity is invalid");
    }
    resumableSessionId = resumableSessionId.trim();
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      this.assertReadableNativeAgentSession(loaded, key);
      const existing = loaded.sessions[key];
      if (!existing || existing.providerSessionId !== providerSessionId) return false;
      if (nativeAgentSessionResumeIdentity(existing) === resumableSessionId) return false;
      const updated: PersistedNativeAgentSession = {
        ...existing,
        resumeIdentity: { providerSessionId, resumableSessionId },
        updatedAt: nowIso(),
      };
      await this.saveNativeAgentSession(key, updated);
      return true;
    });
  }

  /**
   * Record the title the backend chose for a session, or mark it accepted by
   * the provider. Scoped to the provider session it was chosen for; a mapping
   * that has moved on is left alone. A generated title replaces a fallback,
   * never the reverse, so a slow fallback write cannot undo a generation.
   * Announced, because every reader of the record shows it.
   */
  async recordNativeAgentSessionBackendTitle(
    key: string,
    title: NativeAgentSessionBackendTitle,
  ): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(title.providerSessionId)) {
      throw new Error("Native agent backend title identity is invalid");
    }
    if (!isNonBlankString(title.title)) throw new Error("Native agent backend title is blank");
    return this.enqueueNativeAgentSessionMutation(key, async () => {
      const loaded = await this.loadNativeAgentSessions();
      this.assertReadableNativeAgentSession(loaded, key);
      const existing = loaded.sessions[key];
      if (!existing || existing.providerSessionId !== title.providerSessionId) return false;
      const current = nativeAgentSessionBackendTitle(existing);
      if (current?.source === "generated" && title.source === "fallback") return false;
      if (
        current &&
        current.title === title.title &&
        current.source === title.source &&
        (current.pushed === true) === (title.pushed === true)
      ) {
        return false;
      }
      const updated: PersistedNativeAgentSession = {
        ...existing,
        backendTitle: {
          providerSessionId: title.providerSessionId,
          title: title.title,
          source: title.source,
          ...(title.pushed ? { pushed: true } : {}),
        },
        updatedAt: nowIso(),
      };
      loaded.sessions[key] = updated;
      await this.saveNativeAgentSession(key, updated);
      this.announceNativeAgentRecord(updated);
      return true;
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
      await this.context.scrubSensitiveJsonBackups(
        this.files.nativeAgentSessionsFile(),
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
  private nativeAgentDisplayTailStore(): NativeAgentDisplayTailStore {
    this.displayTailStoreInstance ??= new NativeAgentDisplayTailStore({
      database: () => this.context.database,
      legacyRoot: this.context.dataDir,
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
    if (removed) this.context.changes.announce("native-agent-session", environmentId);
    // Unconditional: a retry after a partial failure finds the sessions
    // already gone, and must still clear the tails that failure left.
    await this.deleteNativeAgentDisplayTailsByEnvironment(environmentId);
    await this.context.scrubSensitiveJsonBackups(
      this.files.nativeAgentSessionsFile(),
      (_key, record) => !isRecord(record) || record.environmentId !== environmentId,
    );
    // The deleted rows' provider session ids and dispatch journals must not
    // survive in free pages or the WAL either.
    this.context.scrubDeletedDatabaseContent();
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
    return this.repos.projects.enqueueEnvironmentMutation(async () => {
      const environments = await this.repos.projects.loadEnvironments();
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
      this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
        const loaded = await this.loadNativeAgentSessions();
        this.assertReadableNativeAgentSession(loaded, key);
        const queues = await this.repos.promptQueues.loadPromptQueues();
        return { session: loaded.sessions[key] ?? null, queue: queues[queueKey] ?? null };
      }),
    );
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

  async assertEnvironmentAcceptsBackgroundState(
    environmentId: string,
    label: string,
  ): Promise<Environment> {
    const bugReportId = bugReportIdFromRuntimeId(environmentId);
    if (bugReportId) {
      const report = await this.repos.bugReports.getBugReport(bugReportId);
      if (!report) throw new Error(`${label} bug report not found: ${bugReportId}`);
      return bugReportRuntimeEnvironment(environmentId, report);
    }
    const coordinatorId = coordinatorIdFromRuntimeId(environmentId);
    if (coordinatorId) {
      const workspace = await this.repos.coordinators.getCoordinatorWorkspaceById(coordinatorId);
      if (!workspace) throw new Error(`${label} coordinator not found: ${coordinatorId}`);
      if (workspace.lifecycleState === "paused") {
        throw new Error(`${label} coordinator is paused`);
      }
      const project = await this.repos.projects.getProject(workspace.projectId);
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
    const environment = await this.repos.projects.getEnvironment(environmentId);
    if (!environment) {
      throw new Error(`${label} environment not found: ${environmentId}`);
    }
    if (environment.deletionRequestedAt) {
      throw new Error(`${label} environment is being deleted: ${environmentId}`);
    }
    return environment;
  }
}
