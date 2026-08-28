import * as shared from "./storage-shared.js";
import {
  MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES,
  MAX_PERSISTED_NATIVE_AGENT_PENDING_STEER_BYTES,
  NATIVE_AGENT_SESSION_VERSION,
  PendingNativeAgentDispatchError,
  PendingNativeAgentSteerError,
  isAgentInteractionResolutionJournal,
  isAgentPlatform,
  isNonBlankString,
  isPersistedNativeAgentSession,
  isPersistedPromptQueue,
  isRecord,
  migratePersistedNativeAgentSession,
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
import type { NativeAgentSessionActionOutcome } from "@orkestrator/protocol/native-agent";

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
    const sessions: Record<string, PersistedNativeAgentSession> = {};
    const opaque: Record<string, unknown> = {};
    let migratedAny = false;
    for (const [storedKey, session] of Object.entries(stored)) {
      const migrated = migratePersistedNativeAgentSession(session, storedKey);
      if (!migrated) {
        opaque[storedKey] = session;
        continue;
      }
      if (!isPersistedNativeAgentSession(session, storedKey)) migratedAny = true;
      sessions[storedKey] = migrated;
    }
    return { sessions, opaque, migrated: migratedAny };
  }

  /**
   * Writes the readable records back while preserving every unreadable one
   * byte-for-byte. Persisting `sessions` alone would erase them.
   */
  protected async saveNativeAgentSessions(
    sessions: Record<string, PersistedNativeAgentSession>,
    opaque: Record<string, unknown>,
  ): Promise<void> {
    await this.saveSensitiveJson(this.nativeAgentSessionsFile(), {
      ...opaque,
      ...sessions,
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
    // Read without the cross-process lock. `getOrCreateNativeAgentSession`
    // deliberately holds that lock across an external provider create, so
    // taking it here would make a routine tab reattach wait on — and, past the
    // 20s lock deadline, fail against — an unrelated session being created.
    // Only a load that actually migrated something needs to write.
    const loaded = await this.loadNativeAgentSessions();
    if (!loaded.migrated) {
      this.assertReadableNativeAgentSession(loaded, key);
      return loaded.sessions[key] ?? null;
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const current = await this.loadNativeAgentSessions();
      if (current.migrated) {
        await this.saveNativeAgentSessions(current.sessions, current.opaque);
      }
      this.assertReadableNativeAgentSession(current, key);
      return current.sessions[key] ?? null;
    });
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
      Partial<Pick<PersistedNativeAgentSession, "origin" | "interactionPolicy" | "controls">>,
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

    return this.enqueueNativeAgentSessionMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(
        input.environmentId,
        "Native agent session",
      );
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
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
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
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
      await this.saveNativeAgentSessions(sessions, opaque);
      this.announce("native-agent-session", input.environmentId);
      return saved;
    });
  }

  async adoptNativeAgentSession(
    input: Pick<
      PersistedNativeAgentSession,
      "key" | "environmentId" | "agent" | "logicalSessionKey" | "providerSessionId"
    > &
      Partial<Pick<PersistedNativeAgentSession, "origin" | "interactionPolicy" | "controls">> & {
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
    return this.enqueueNativeAgentSessionMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(
        input.environmentId,
        "Native agent session",
      );
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
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
          if (input.controls && JSON.stringify(controls) !== JSON.stringify(existing.controls)) {
            const updated: PersistedNativeAgentSession = {
              ...existing,
              controls,
              updatedAt: nowIso(),
            };
            sessions[input.key] = updated;
            await this.saveNativeAgentSessions(sessions, opaque);
            this.announce("native-agent-session", input.environmentId);
            return updated;
          }
          if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
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
                ? { ...existing.controls, ...input.controls }
                : existing.controls,
            }
          : interactionMetadata),
        version: NATIVE_AGENT_SESSION_VERSION,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      sessions[input.key] = saved;
      await this.saveNativeAgentSessions(sessions, opaque);
      if (existing?.pendingDispatch) {
        await this.scrubPendingNativeAgentDispatchBackups(
          input.key,
          existing.pendingDispatch.requestId,
        );
      }
      this.announce("native-agent-session", input.environmentId);
      return saved;
    });
  }

  async updateNativeAgentSessionControls(
    key: string,
    expectedProviderSessionId: string,
    update: import("@orkestrator/protocol/native-agent").NativeAgentControlUpdate,
  ): Promise<PersistedNativeAgentSession> {
    if (!isNonBlankString(key) || !isNonBlankString(expectedProviderSessionId)) {
      throw new Error("Native agent control update identity is invalid");
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const existing = sessions[key];
      if (!existing || existing.providerSessionId !== expectedProviderSessionId) {
        throw new Error("Native agent control update target is stale");
      }
      const controls = { ...existing.controls, ...update };
      const updated: PersistedNativeAgentSession = {
        ...existing,
        controls,
        updatedAt: nowIso(),
      };
      sessions[key] = updated;
      await this.saveNativeAgentSessions(sessions, opaque);
      this.announce("native-agent-session", existing.environmentId);
      return updated;
    });
  }

  async invalidateNativeAgentSession(key: string, providerSessionId: string): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(providerSessionId)) {
      throw new Error("Native agent session identity must not be blank");
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const existing = sessions[key];
      if (!existing || existing.providerSessionId !== providerSessionId) {
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return false;
      }
      delete sessions[key];
      await this.saveNativeAgentSessions(sessions, opaque);
      await this.scrubSensitiveJsonBackups(
        this.nativeAgentSessionsFile(),
        (storedKey) => storedKey !== key,
      );
      this.announce("native-agent-session", existing.environmentId);
      return true;
    });
  }

  async deleteNativeAgentSessionsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) return;
    await this.enqueueNativeAgentSessionMutation(async () => {
      // Deliberately does not refuse an unreadable record. This is the path a
      // user takes to clear one, so it must always complete; unreadable records
      // are simply carried across untouched, since nothing here can prove which
      // environment they belong to.
      const { sessions, opaque, migrated } = await this.loadNativeAgentSessions();
      const retained = Object.fromEntries(
        Object.entries(sessions).filter(([, session]) => session.environmentId !== environmentId),
      );
      const removed = Object.keys(retained).length !== Object.keys(sessions).length;
      if (migrated || removed) {
        await this.saveNativeAgentSessions(retained, opaque);
      }
      // Only a real deletion is worth waking every client for.
      if (removed) this.announce("native-agent-session", environmentId);

      // Rotating the primary file leaves the deleted environment's logical keys,
      // provider session ids and dispatch journal readable in its backups. Scrub
      // unconditionally, as every sibling delete-by-environment does: a prior
      // failed delete may have removed the primary record while leaving a backup.
      await this.scrubSensitiveJsonBackups(this.nativeAgentSessionsFile(), (storedKey, session) => {
        const readable = migratePersistedNativeAgentSession(session, storedKey);
        if (readable) return readable.environmentId !== environmentId;
        // An unreadable backup record still names its environment in the
        // clear often enough to attribute. Keep the ones that provably belong
        // elsewhere; drop the rest, because a backup that cannot be proven
        // free of the deleted environment's content is not safe to retain.
        return (
          isRecord(session) &&
          isNonBlankString(session.environmentId) &&
          session.environmentId !== environmentId
        );
      });
    });
  }

  async dispatchNativeAgentPromptOnce(
    key: string,
    requestId: string,
    dispatch: (session: PersistedNativeAgentSession) => Promise<void | {
      dispatched: false;
      openCodeIncompleteTurnNotice?:
        | PersistedNativeAgentSession["openCodeIncompleteTurnNotice"]
        | null;
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
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
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
          await this.saveNativeAgentSessions(sessions, opaque);
          await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
        }
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return { session, dispatched: false };
      }

      if (pendingDispatch) {
        if (pendingDispatch.requestId !== requestId) {
          throw new Error("Pending native agent dispatch request ID mismatch");
        }
        session = {
          ...session,
          pendingDispatch,
          updatedAt: nowIso(),
        };
        sessions[key] = session;
        // Persist before touching the provider. A crash or lost acknowledgement
        // can then replay this exact request through the same idempotency key.
        await this.saveNativeAgentSessions(sessions, opaque);
      }

      // Keep the cross-process lock until the provider has acknowledged this
      // stable request id. If the process dies after provider acceptance but
      // before this write, recovery retries the same id rather than inventing a
      // second turn.
      const outcome = await dispatch(session);
      if (outcome?.dispatched === false) {
        if (outcome.openCodeIncompleteTurnNotice === undefined) {
          if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
          return { session, dispatched: false };
        }
        const updated: PersistedNativeAgentSession = {
          ...session,
          pendingDispatch: undefined,
          ...(outcome.openCodeIncompleteTurnNotice === null
            ? { openCodeIncompleteTurnNotice: undefined }
            : {
                openCodeIncompleteTurnNotice: outcome.openCodeIncompleteTurnNotice,
              }),
          updatedAt: nowIso(),
        };
        sessions[key] = updated;
        await this.saveNativeAgentSessions(sessions, opaque);
        await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
        this.announce("native-agent-session", session.environmentId);
        return { session: updated, dispatched: false };
      }
      const updated: PersistedNativeAgentSession = {
        ...session,
        // Any successfully accepted prompt supersedes a prior recovery notice.
        openCodeIncompleteTurnNotice: undefined,
        pendingDispatch: undefined,
        dispatchedRequestIds: [...(session.dispatchedRequestIds ?? []).slice(-999), requestId],
        updatedAt: nowIso(),
      };
      sessions[key] = updated;
      await this.saveNativeAgentSessions(sessions, opaque);
      await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.announce("native-agent-session", session.environmentId);
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
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingDispatch?.requestId !== requestId) {
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return false;
      }
      sessions[key] = {
        ...session,
        pendingDispatch: undefined,
        dispatchedRequestIds: session.dispatchedRequestIds?.includes(requestId)
          ? session.dispatchedRequestIds
          : [...(session.dispatchedRequestIds ?? []).slice(-999), requestId],
        updatedAt: nowIso(),
      };
      await this.saveNativeAgentSessions(sessions, opaque);
      await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.announce("native-agent-session", session.environmentId);
      return true;
    });
  }

  async clearPendingNativeAgentDispatch(key: string, requestId: string): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Pending native agent dispatch identity must not be blank");
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingDispatch?.requestId !== requestId) {
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return false;
      }
      sessions[key] = {
        ...session,
        pendingDispatch: undefined,
        updatedAt: nowIso(),
      };
      await this.saveNativeAgentSessions(sessions, opaque);
      await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.announce("native-agent-session", session.environmentId);
      return true;
    });
  }

  /**
   * Persist one backend-owned steering identity across the provider boundary.
   *
   * A provider exception is ambiguous by default: once the request was handed
   * off, this layer cannot prove which side of admission it occurred on. The
   * exact record therefore stays parked as `unknown` and every retry reuses it.
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

    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      let session = sessions[key];
      if (!session) throw new Error("Native agent session was not found");
      if (session.pendingDispatch) {
        throw new PendingNativeAgentDispatchError(session.pendingDispatch.requestId);
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
        await this.saveNativeAgentSessions(sessions, opaque);
      }

      let outcome: NativeAgentSessionActionOutcome;
      try {
        outcome = await dispatch(session);
      } catch {
        outcome = { outcome: "unknown", requestId: pendingSteer.requestId };
      }

      if (outcome.outcome === "unknown") {
        sessions[key] = {
          ...session,
          pendingSteer: { ...pendingSteer, state: "unknown" },
          updatedAt: nowIso(),
        };
        await this.saveNativeAgentSessions(sessions, opaque);
        this.announce("native-agent-session", session.environmentId);
        return { ...outcome, requestId: pendingSteer.requestId };
      }

      sessions[key] = {
        ...session,
        pendingSteer: undefined,
        updatedAt: nowIso(),
      };
      await this.saveNativeAgentSessions(sessions, opaque);
      await this.scrubPendingNativeAgentSteerBackups(key, pendingSteer.requestId);
      this.announce("native-agent-session", session.environmentId);
      return outcome;
    });
  }

  async confirmNativeAgentSteer(key: string, requestId: string): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent steer identity must not be blank");
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingSteer?.requestId !== requestId) {
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return false;
      }
      sessions[key] = { ...session, pendingSteer: undefined, updatedAt: nowIso() };
      await this.saveNativeAgentSessions(sessions, opaque);
      await this.scrubPendingNativeAgentSteerBackups(key, requestId);
      this.announce("native-agent-session", session.environmentId);
      return true;
    });
  }

  async clearPendingNativeAgentSteer(key: string, requestId: string): Promise<boolean> {
    return this.confirmNativeAgentSteer(key, requestId);
  }

  async setOpenCodeIncompleteTurnNotice(
    key: string,
    providerSessionId: string,
    notice: PersistedNativeAgentSession["openCodeIncompleteTurnNotice"] | null,
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
      throw new Error("OpenCode incomplete-turn notice is invalid");
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.providerSessionId !== providerSessionId) {
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return false;
      }
      if (notice === null && session.openCodeIncompleteTurnNotice === undefined) {
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return true;
      }
      const updated: PersistedNativeAgentSession = {
        ...session,
        openCodeIncompleteTurnNotice: notice ?? undefined,
        updatedAt: nowIso(),
      };
      sessions[key] = updated;
      await this.saveNativeAgentSessions(sessions, opaque);
      this.announce("native-agent-session", session.environmentId);
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

  protected enqueuePromptQueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.promptQueuesFile(),
        "prompt queue storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.promptQueueMutation.then(run, run);
    this.promptQueueMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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
    outstandingClaim:
      | PersistedPromptQueue["outstandingClaim"]
      | null = previous?.outstandingClaim ?? null,
  ): Promise<PersistedPromptQueue> {
    this.validatePromptQueueMessages(messages);
    const failedMessageStillUnchanged =
      previous?.dispatchError !== undefined &&
      messages.some(
        (candidate) =>
          isRecord(candidate) &&
          candidate.id === previous.dispatchError?.messageId &&
          this.promptQueueMessageFingerprint(candidate) ===
            previous.dispatchError?.messageFingerprint,
      );
    const saved: PersistedPromptQueue = {
      queueKey,
      environmentId,
      messages,
      ...(previous?.inFlight ? { inFlight: previous.inFlight } : {}),
      ...(failedMessageStillUnchanged ? { dispatchError: previous!.dispatchError } : {}),
      ...(outstandingClaim ? { outstandingClaim } : {}),
      updatedAt: nowIso(),
      revision: (previous?.revision ?? 0) + 1,
    };
    queues[queueKey] = saved;
    await this.saveSensitiveJson(this.promptQueuesFile(), queues);
    this.announce("prompt-queue", environmentId);
    this.schedulePromptQueueClaimRecovery(queues);
    return saved;
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
    return Object.fromEntries(
      Object.entries(stored).flatMap(([storedKey, queue]) => {
        if (!isPersistedPromptQueue(queue, storedKey)) return [];
        if (
          !queue.dispatchError ||
          (isNonBlankString(queue.dispatchError.messageId) &&
            isNonBlankString(queue.dispatchError.messageFingerprint))
        ) {
          return [[storedKey, queue]];
        }

        // Records written by the first dispatch-error implementation did not
        // identify the rejected queue item. Upgrade those in memory from the
        // restored message so the first subsequent mutation gets the same
        // edit/removal semantics as a newly written record.
        const failedMessage = queue.messages.find(
          (candidate) => isRecord(candidate) && candidate.id === queue.dispatchError?.requestId,
        );
        if (!isRecord(failedMessage) || !isNonBlankString(failedMessage.id)) {
          const { dispatchError: _dispatchError, ...withoutError } = queue;
          return [[storedKey, withoutError as PersistedPromptQueue]];
        }
        return [
          [
            storedKey,
            {
              ...queue,
              dispatchError: {
                ...queue.dispatchError,
                messageId: failedMessage.id,
                messageFingerprint: this.promptQueueMessageFingerprint(failedMessage),
              },
            },
          ],
        ];
      }),
    ) as Record<string, PersistedPromptQueue>;
  }
}
