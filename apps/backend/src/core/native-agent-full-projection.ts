import type {
  BuildPipelineAgent,
  NativeAgentSessionProjection,
  PersistedNativeAgentSession,
  StorageService,
  NativeAgentRuntimeProvider,
  ProviderInteractiveSnapshot,
  NativeAgentProjectionInput,
  NativeAgentProjectionCacheEntry,
} from "./native-agent-service-shared.js";
import {
  nativeAgentSessionStorageKey,
  nativeCapabilities,
  readProviderStatus,
  NATIVE_MISSING_SESSION_GRACE_MS,
  NATIVE_PROJECTION_CACHE_LIMIT,
  NATIVE_PROJECTION_MAX_BYTES,
  NATIVE_PROJECTION_MAX_MESSAGES,
  NATIVE_PROJECTION_MAX_WINDOW_MESSAGES,
  NATIVE_PROJECTION_TAIL_REFRESH_MESSAGES,
  NATIVE_PROJECTION_REVISION_LIMIT,
  NATIVE_DETAIL_RECOVERY_TAIL_MESSAGES,
  NATIVE_DETAIL_RECOVERY_TAIL_TARGET_BYTES,
  nativeComposerControls,
} from "./native-agent-service-shared.js";
import { type CommandCatalogueSnapshot } from "./native-agent-command-catalogue.js";
import {
  nativeAsyncQuestionItemId,
  withoutSuppressedComposerControls,
  type NativeAgentAsyncQuestionResponse,
} from "@orkestrator/protocol/native-agent";
import { sessionIncompleteTurnNotice } from "./models.js";
import type { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import { lastAssistantModelRef } from "./native-agent-composer-selection.js";
import { limitNativeAgentCapabilities } from "./native-agent-capability-limits.js";
import { projectedRetiredDispatch } from "./native-agent-retired-dispatch.js";
import { digestWithMessages } from "./native-agent-projection-encoding.js";
import type { NativeSessionInvalidationCause } from "@orkestrator/protocol/native-agent-observation";
import { withSessionActionSlashCommands } from "@orkestrator/protocol/agent-slash-commands";
import { withNativeTerminalMessages } from "@orkestrator/protocol/native-terminal-rows";
import { nativeTerminalMessages } from "./native-terminal-messages.js";
import {
  mergeContextUsageTurns,
  mergeNativeAgentQueueItems,
  normalizeInteractionKinds,
  sessionModelSubstitutionNotice,
  visibleProjectionNotices,
  withProviderContextWindow,
  firstUserMessageOf,
} from "./native-agent-projection-helpers.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  type NativeAgentTranscriptProjectionHost,
  type NativeAgentProjectionContext,
  goalProjectionField,
} from "./native-agent-projection-context.js";
import { nativeAgentQueueEditingField } from "./native-agent-queue-editing.js";

const log = createLogger("native-agent");

/**
 * The whole-session projection (`NativeAgentSessionProjection`): what
 * `get_native_agent_projection` returns, what every session mutation answers
 * with, what `cachedProjectionSnapshot` serves the public API and interaction
 * tracker, and the `detail-recovery` whole-transcript read that rebuilds an
 * evicted tool detail. Its refreshes are serialized per key so a late provider
 * response cannot roll state back, and its revisions form one sequence per
 * session.
 *
 * The view cache (`NATIVE_PROJECTION_CACHE_LIMIT`), revisions and stop notices
 * are bounded and reconstructible.
 */
export class NativeAgentFullProjection {
  private readonly host: NativeAgentTranscriptProjectionHost;
  private readonly storage: StorageService;
  private readonly catalogs: NativeAgentCatalogCache;

  constructor(private readonly context: NativeAgentProjectionContext) {
    this.host = context.host;
    this.storage = context.storage;
    this.catalogs = context.catalogs;
  }

  /** Test-only view of the projection state; production code must not call it. */
  forTesting() {
    return {
      projectionCache: this.projectionCache,
      projectionRefreshes: this.projectionRefreshes,
      stopNotices: this.stopNotices,
    };
  }

  /** Key counts of the projection state, for `native-projection` diagnostics. */
  cacheGauges(): Record<string, number> {
    return {
      projections: this.projectionCache.size,
      projectionRevisions: this.projectionRevisions.size,
      projectionMissingSince: this.projectionMissingSince.size,
      projectionRefreshes: this.projectionRefreshes.size,
      projectionRefreshDescriptors: this.projectionRefreshDescriptors.size,
      stopNotices: this.stopNotices.size,
    };
  }

  /** Drop every cached projection and refresh; run after shutdown settled the reads. */
  clear(): void {
    this.projectionCache.clear();
    this.projectionRefreshes.clear();
    this.projectionRefreshDescriptors.clear();
  }

  /**
   * Drop a session's cached projections (both representations), its stop
   * notice and its missing-session grace. The identity behind the key changed,
   * so the grace the previous session had spent says nothing about the new
   * one: a tab that resumes into a different provider session starts its
   * reconnect from a full window.
   */
  forgetSession(sessionKey: string): void {
    this.stopNotices.delete(sessionKey);
    this.projectionCache.delete(sessionKey);
    this.projectionCache.delete(`${sessionKey}\0detail-recovery`);
    this.projectionMissingSince.delete(sessionKey);
  }

  /** Whether a cached projection or a refresh in flight still needs the key's epoch. */
  holdsKey(key: string): boolean {
    return this.projectionCache.has(key) || this.projectionRefreshes.has(key);
  }

  /** The key's epoch was pruned: its missing-session run means nothing any more. */
  releaseKey(key: string): void {
    this.projectionMissingSince.delete(key);
  }

  /** Drop a deleted session's revision counter. */
  forgetRevisions(sessionKey: string): void {
    this.projectionRevisions.delete(sessionKey);
  }

  /**
   * Collect a deleted environment's sessions from cached projections and
   * refreshes in flight, marking those refreshes forgotten so they release
   * what they populate when they settle.
   */
  collectEnvironmentSessions(environmentId: string, sessionKeys: Set<string>): void {
    for (const entry of this.projectionCache.values()) {
      if (entry.input.environmentId !== environmentId) continue;
      sessionKeys.add(
        nativeAgentSessionStorageKey(
          entry.input.environmentId,
          entry.input.agent,
          entry.input.logicalSessionKey,
        ),
      );
    }
    for (const [key, descriptor] of this.projectionRefreshDescriptors) {
      if (descriptor.environmentId !== environmentId) continue;
      descriptor.forgotten = true;
      sessionKeys.add(key.replace(/\0detail-recovery$/, ""));
    }
  }

  /** Bounded, reconstructible view cache; providers remain authoritative. */
  readonly projectionCache = new Map<string, NativeAgentProjectionCacheEntry>();
  /**
   * One revision sequence per logical native-agent session.
   *
   * The legacy full-projection representation and the detail-recovery tail are
   * cached under different keys but describe the same session and carry the
   * same generation, and the renderer compares `revision` as a single ordering.
   * Allocating from separate per-key counters let the recovery counter run ahead,
   * so an authoritative projection returned by a mutation could arrive with a
   * lower revision than the client already held and be discarded as stale.
   */
  private readonly projectionRevisions = new Map<
    string,
    { generation: string; revision: number }
  >();
  /**
   * When each projection key's current run of `missing` provider reads began.
   *
   * Dates the `connecting` overlay so the grace can expire into a reportable
   * failure. Cleared by any read that finds the session, and by every path that
   * drops the key's cache entry, so it stays bounded by `projectionCache`
   * rather than growing with key churn.
   */
  private readonly projectionMissingSince = new Map<string, number>();
  /** Serializes projection reads so late provider responses cannot roll state back. */
  private readonly projectionRefreshes = new Map<
    string,
    Promise<NativeAgentSessionProjection | null>
  >();
  private readonly projectionRefreshDescriptors = new Map<
    string,
    { epoch: number; signature: string; environmentId: string; forgotten?: boolean }
  >();
  /** Session-scoped stop result retained until the next authoritative projection. */
  private readonly stopNotices = new Map<string, string>();
  /**
   * A title the backend just chose, shown in the cached projections without
   * waiting for the next provider read: an idle session may not be read again
   * for a long time.
   */
  showChosenTitle(sessionKey: string, title: string, providerSessionId: string): void {
    for (const key of [sessionKey, `${sessionKey}\0detail-recovery`]) {
      const entry = this.projectionCache.get(key);
      if (
        !entry ||
        entry.projection.sessionId !== providerSessionId ||
        entry.projection.title === title
      )
        continue;
      this.commitProjection(
        key,
        entry.input,
        { ...entry.projection, title },
        entry.generation,
        this.context.projectionEpochs.get(key) ?? 0,
        "projection-title",
      );
    }
  }

  /** Keep a session's stop result until its next authoritative projection. */
  recordStopNotice(sessionKey: string, message: string): void {
    this.stopNotices.set(sessionKey, message);
    while (this.stopNotices.size > 256) {
      const oldest = this.stopNotices.keys().next().value as string | undefined;
      if (oldest) this.stopNotices.delete(oldest);
      else break;
    }
  }

  /** Projection reads and title choices still in flight, for shutdown to settle. */
  pendingRefreshes(): Promise<unknown>[] {
    return [...this.projectionRefreshes.values(), ...this.context.sessionTitles.pending()];
  }

  /**
   * Resolve the transcript window for one refresh.
   *
   * Callers that ask for a bigger window raise it; callers that ask for nothing
   * inherit the window the session already had. Clamped so a renderer cannot
   * ask the provider for an unbounded transcript.
   */
  private resolveMessageLimit(requested: number | undefined, previous: number | undefined): number {
    const candidate = requested ?? previous ?? NATIVE_PROJECTION_MAX_MESSAGES;
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      return NATIVE_PROJECTION_MAX_MESSAGES;
    }
    return Math.min(candidate, NATIVE_PROJECTION_MAX_WINDOW_MESSAGES);
  }

  /**
   * A committed stop withdraws the environment's outstanding agent requests.
   * Parked requests die with their bridge and never survive a restart, but a
   * failed read keeps the last projection, so the dead request stayed
   * `pending` while stopped; the public CLI and the coordinator's
   * `get_tab_state` read that cache. It is withdrawn the way a live snapshot
   * withdraws one: dropped from the list, which only ever holds outstanding
   * requests, in a new announced revision. Every key with a cached projection
   * or a refresh in flight has its epoch bumped, so a read that saw the
   * request before the stop cannot commit it back.
   */
  withdrawEnvironmentInteractions(environmentId: string): void {
    const keys = new Set<string>();
    for (const [key, entry] of this.projectionCache) {
      if (entry.input.environmentId === environmentId) keys.add(key);
    }
    for (const [key, descriptor] of this.projectionRefreshDescriptors) {
      if (descriptor.environmentId === environmentId) keys.add(key);
    }
    for (const key of keys) {
      const epoch = (this.context.projectionEpochs.get(key) ?? 0) + 1;
      this.context.projectionEpochs.set(key, epoch);
      const entry = this.projectionCache.get(key);
      if (!entry) continue;
      const interactions = entry.projection.interactions.filter(
        (interaction) => interaction.state !== "pending" && interaction.state !== "answering",
      );
      this.commitProjection(
        key,
        entry.input,
        { ...entry.projection, interactions },
        entry.generation,
        epoch,
        "projection-withdrawn",
      );
    }
  }

  /**
   * A refresh whose result the caller drops: one that follows a dispatch, a
   * settled dispatch or an answered interaction. Everything that matters then
   * is state beside the transcript (turn phase, pending interactions, usage,
   * the announcement that wakes readers), so it reads a short tail instead of
   * the session's window. Readers still get their own window on their next
   * read: this does not change the limit they inherit.
   */
  refreshProjectionState(input: NativeAgentProjectionInput): Promise<unknown> {
    return this.refreshProjection(input, true, undefined, NATIVE_PROJECTION_TAIL_REFRESH_MESSAGES);
  }

  refreshProjection(
    input: NativeAgentProjectionInput,
    force: boolean,
    resolvedSession?: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
      transient: true;
    },
    tailMessages?: number,
  ): Promise<NativeAgentSessionProjection | null> {
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const key =
      input.representation === "detail-recovery" ? `${sessionKey}\0detail-recovery` : sessionKey;
    const previousRefresh = this.projectionRefreshes.get(key);
    const epoch = this.context.projectionEpochs.get(key) ?? 0;
    const signature = JSON.stringify({
      messageLimit: input.messageLimit ?? null,
      refreshUsage: input.refreshUsage === true,
      representation: input.representation ?? "legacy",
      force,
      tailMessages: tailMessages ?? null,
    });
    const previousDescriptor = this.projectionRefreshDescriptors.get(key);
    if (
      previousRefresh &&
      previousDescriptor?.epoch === epoch &&
      previousDescriptor.signature === signature
    ) {
      return previousRefresh;
    }
    const operation = (async () => {
      if (previousRefresh) await previousRefresh.catch(() => undefined);
      const coveredEpoch = this.context.projectionEpochs.get(key) ?? epoch;
      return this.refreshProjectionOnce(
        input,
        force,
        key,
        coveredEpoch,
        resolvedSession,
        tailMessages,
      );
    })();
    this.projectionRefreshes.set(key, operation);
    this.projectionRefreshDescriptors.set(key, {
      epoch,
      signature,
      environmentId: input.environmentId,
    });
    return operation.finally(() => {
      if (this.projectionRefreshes.get(key) === operation) {
        const forgotten = this.projectionRefreshDescriptors.get(key)?.forgotten;
        this.projectionRefreshes.delete(key);
        this.projectionRefreshDescriptors.delete(key);
        if (forgotten) {
          const sessionKey = key.replace(/\0detail-recovery$/, "");
          // Normalization can have populated row/detail caches before the
          // commit's epoch check rejected the late view.
          this.context.invalidateProjection(sessionKey);
          this.projectionRevisions.delete(sessionKey);
          this.context.releaseForgottenProjectionEpochs(sessionKey);
        }
      }
      this.context.pruneProjectionEpoch(key);
    });
  }

  private async refreshProjectionOnce(
    input: NativeAgentProjectionInput,
    force: boolean,
    key: string,
    epoch: number,
    resolvedSession?: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
      transient: true;
    },
    tailMessages?: number,
  ): Promise<NativeAgentSessionProjection | null> {
    const previous = this.projectionCache.get(key);
    const messageLimit = this.resolveMessageLimit(input.messageLimit, previous?.input.messageLimit);
    const windowed: NativeAgentProjectionInput = { ...input, messageLimit };
    if (!force && previous && previous.input.messageLimit === messageLimit) {
      return previous.projection;
    }
    let generation = previous?.generation ?? `unresolved:${input.agent}`;
    let transient = resolvedSession?.transient ?? false;
    try {
      const held = resolvedSession
        ? undefined
        : await this.context.transcript.heldCoordinatorTranscript(
            input,
            messageLimit,
            NATIVE_PROJECTION_MAX_BYTES,
          );
      if (held?.view === null) return null;
      if (held?.view) {
        // Keep the original cached history: a one-message state read must
        // not narrow a later held transcript read.
        const saved = held.view;
        const state = await this.context.reads.heldCoordinatorSessionState(input, held.message);
        const savedGeneration = String(saved.identity.sourceGeneration);
        return {
          platform: input.agent,
          environmentId: input.environmentId,
          sessionId: saved.identity.providerSessionId,
          title: saved.title,
          messages: saved.messages,
          messageWindow: saved.messageWindow,
          connection: "error",
          turn: state?.turn ?? { phase: "idle", error: held.message },
          interactions: [],
          composerControls: [],
          capabilities: nativeCapabilities(input.agent),
          revision: this.nextProjectionRevision(
            nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
            savedGeneration,
          ),
          generation: savedGeneration,
        };
      }
      const resolved = resolvedSession ?? (await this.host.resolveProjectionSession(input));
      if (!resolved) {
        if ((this.context.projectionEpochs.get(key) ?? 0) === epoch) {
          this.projectionCache.delete(key);
          this.projectionMissingSince.delete(key);
        }
        return null;
      }
      transient = resolved.transient;
      generation = this.host.providerGeneration(input) ?? `in-process:${input.agent}`;
      const advertisedCapabilities = nativeCapabilities(input.agent);
      // User-triggered supplementary metadata. A billing endpoint failure
      // must not make an otherwise healthy transcript unavailable. Merge the
      // value below after the ordinary snapshot resolves.
      const refreshedUsage = input.refreshUsage
        ? await resolved.provider
            .refreshUsage?.(resolved.session.providerSessionId)
            .catch(() => undefined)
        : undefined;
      const recoveryRead = input.representation === "detail-recovery";
      const projectedLimit =
        tailMessages === undefined || recoveryRead
          ? messageLimit
          : Math.min(messageLimit, tailMessages);
      // One row past the window is what tells a tail read that older history
      // exists. A detail-recovery read bounds its tail from the whole transcript
      // (below), so its window reports exactly what lies before that tail.
      const readOptions = recoveryRead ? undefined : { limit: projectedLimit + 1 };
      // These reads describe independent parts of one projection. Keeping
      // them serial made a transcript wait for every approval, queue and slash
      // command round trip in turn, even though none produces message text.
      const readSnapshot = (): Promise<ProviderInteractiveSnapshot> =>
        resolved.provider.interactiveSnapshot
          ? resolved.provider.interactiveSnapshot(resolved.session.providerSessionId, readOptions)
          : (async () => ({
              // A terminal turn error belongs in the projection as `error` plus
              // its detail, not as a thrown read that would report the whole
              // runtime as unreachable.
              ...(await readProviderStatus(resolved.provider, resolved.session.providerSessionId)),
              messages: await resolved.provider.messages(
                resolved.session.providerSessionId,
                readOptions,
              ),
            }))();
      // Capture as soon as the snapshot resolves, before unrelated metadata.
      const snapshotPromise = resolved.transient
        ? readSnapshot()
        : this.context.resumeIdentity.read(resolved.session, readSnapshot);
      const interactionSnapshotPromise = this.context.parts.pendingInteractions(resolved);
      const queuePromise = advertisedCapabilities.queue
        ? this.storage.getPromptQueue(`${input.agent}\0${input.logicalSessionKey}`)
        : Promise.resolve(null);
      const slashCommandsPromise = this.catalogs
        .commandCatalogue(input, resolved.provider, resolved.session.providerSessionId)
        .catch((): CommandCatalogueSnapshot => ({
          commands: [],
          state: { status: "unavailable", revision: 0, enhanced: false },
        }));
      const steerSupportedPromise = advertisedCapabilities.actions?.steer
        ? (resolved.provider
            .steerSupported?.(resolved.session.providerSessionId)
            .catch(() => false) ?? Promise.resolve(false))
        : Promise.resolve(false);
      const mcpPromise =
        resolved.provider.mcpServers?.(resolved.session.providerSessionId).catch(() => []) ??
        Promise.resolve([]);
      const [snapshot, interactionSnapshot, queue, commandCatalogue, steerSupported, mcpServers] =
        await Promise.all([
          snapshotPromise,
          interactionSnapshotPromise,
          queuePromise,
          slashCommandsPromise,
          steerSupportedPromise,
          mcpPromise,
        ]);
      if (advertisedCapabilities.actions?.steer && !steerSupported) {
        log.debug("steer.capability-cleared", {
          agent: input.agent,
          environmentId: input.environmentId,
          status: snapshot.status,
        });
      }
      const steerQualified =
        !advertisedCapabilities.actions?.steer || steerSupported
          ? advertisedCapabilities
          : {
              ...advertisedCapabilities,
              actions: {
                ...advertisedCapabilities.actions,
                steer: false,
              },
            };
      // A live session's own answer wins over the platform table. The table
      // says what a platform *may* raise; a Pi session with its approval gate
      // off raises nothing, and reporting the platform's list there would
      // promise approvals that can never arrive.
      const liveInteractionKinds = normalizeInteractionKinds(snapshot.interactionKinds);
      const sessionCapabilities = limitNativeAgentCapabilities(
        steerQualified,
        snapshot.capabilityLimits,
      );
      const capabilities =
        liveInteractionKinds === undefined
          ? sessionCapabilities
          : { ...sessionCapabilities, interactions: { kinds: liveInteractionKinds } };
      if (snapshot.commandCatalogueRevision !== undefined) {
        this.catalogs.observeCommandRevision(
          input,
          resolved.provider,
          resolved.session.providerSessionId,
          snapshot.commandCatalogueRevision,
        );
      }
      // Runtime actions are merged only after this exact bridge has qualified
      // them: an unproven steering surface never advertises `/steer`, and a
      // provider's own same-named command is kept rather than deleted.
      const slashCommands = withSessionActionSlashCommands(commandCatalogue.commands, capabilities);
      if (snapshot.providerGeneration !== undefined) {
        generation = `${generation}:${String(snapshot.providerGeneration)}`;
      }
      if (snapshot.status === "missing") {
        /*
         * The mapping is real and the bridge is up; it just does not hold this
         * session yet (a restart that has not finished restoring, an idle
         * detach). Stamping `connection: "error"` on the first such read made
         * the renderer flash Connection Failed on a tab that was about to
         * attach, so the first few stay connecting and let the next poll find
         * it.
         *
         * The grace is counted, not open-ended. Nothing on this path re-creates
         * a provider session and the connecting overlay carries no retry
         * control, so a session that really is gone has to end up reported —
         * with its detail — rather than on a spinner the user cannot leave.
         */
        const since = this.projectionMissingSince.get(key) ?? this.host.now();
        this.projectionMissingSince.set(key, since);
        const projection: NativeAgentSessionProjection =
          this.host.now() - since >= NATIVE_MISSING_SESSION_GRACE_MS
            ? this.unreachableProjection(
                previous,
                input,
                generation,
                "The native agent runtime no longer holds this session. " +
                  "Retry to start a new one.",
                resolved.session.providerSessionId,
              )
            : {
                ...(previous?.projection ?? {
                  platform: input.agent,
                  environmentId: input.environmentId,
                  sessionId: resolved.session.providerSessionId,
                  messages: [],
                  interactions: [],
                  composerControls: [],
                  capabilities,
                  revision: 0,
                  generation,
                }),
                connection: "connecting",
                turn: { phase: "recovering" },
                notices: [
                  {
                    kind: "recovery",
                    message: "Reconnecting to the native agent runtime…",
                  },
                ],
                revision: 0,
                generation,
              };
        return this.commitProjection(
          key,
          windowed,
          projection,
          generation,
          epoch,
          transient ? null : "projection-read",
        );
      }
      // The session answered, so this key's run of missing reads is over. Left
      // set, a later transient miss would inherit a spent deadline and report a
      // reconnect that is still in its first moment as a failure.
      this.projectionMissingSince.delete(key);
      const blocked = interactionSnapshot.requests.some((request) => request.blocking !== false);
      const lastAssistant = lastAssistantModelRef(snapshot.messages);
      const composer = await this.context.parts.projectionComposer(
        input,
        resolved.session,
        snapshot.composer,
        snapshot.controls,
        false,
        {
          lastAssistantModelId: lastAssistant.modelId,
          lastAssistantReasoningId: lastAssistant.reasoningId,
          sessionModelId: snapshot.sessionModelId,
          sessionReasoningId: snapshot.sessionReasoningId,
          persistSelection: !transient,
        },
      );
      const selectedModel = composer.models.find((model) => model.id === composer.selectedModelId);
      const previousContextUsage =
        previous?.projection.sessionId === resolved.session.providerSessionId
          ? previous.projection.contextUsage
          : undefined;
      const mergedContextUsage = mergeContextUsageTurns(
        previousContextUsage,
        mergeContextUsageTurns(snapshot.contextUsage, refreshedUsage),
      );
      const contextUsage = withProviderContextWindow(
        mergedContextUsage,
        selectedModel?.contextWindow,
      );
      const sessionKey = nativeAgentSessionStorageKey(
        input.environmentId,
        input.agent,
        input.logicalSessionKey,
      );
      // Usage history is recorded from the merged turns, which carry every
      // turn the provider still republishes rather than only the newest one.
      // The provider session scopes their ids: this key belongs to the tab,
      // which outlives the conversation in it.
      this.context.usageRecorder.observe({
        sessionKey,
        environmentId: input.environmentId,
        platform: input.agent,
        ...(resolved.session.providerSessionId
          ? { providerSessionId: resolved.session.providerSessionId }
          : {}),
        usage: contextUsage,
      });
      const normalized = this.context.parts.projectionMessages(
        sessionKey,
        snapshot.messages,
        recoveryRead ? NATIVE_PROJECTION_MAX_WINDOW_MESSAGES : projectedLimit,
        NATIVE_PROJECTION_MAX_BYTES,
        resolved.session.initialPromptPresentation,
        resolved.session.owner?.kind === "coordinator",
        undefined,
        this.context.parts.artifactOverlay(input),
      );
      const transcript =
        input.representation === "detail-recovery"
          ? this.context.parts.boundedProjectedMessages(
              normalized.messages,
              NATIVE_DETAIL_RECOVERY_TAIL_MESSAGES,
              NATIVE_DETAIL_RECOVERY_TAIL_TARGET_BYTES,
            )
          : normalized;
      const stopNotice = this.stopNotices.get(sessionKey);
      const terminalMessages = nativeTerminalMessages({
        notices: snapshot.notices,
        error: snapshot.error,
        failedTurn: snapshot.failedTurn,
        failureRequestId: resolved.session.dispatchedRequestIds?.at(-1),
        ...(snapshot.failureReason ? { failureReason: snapshot.failureReason } : {}),
        ...(snapshot.rateLimits ? { rateLimits: snapshot.rateLimits } : {}),
        stopNotice,
        turnStartedAt: snapshot.turnStartedAt,
      });
      if (stopNotice) this.stopNotices.delete(sessionKey);
      // A provider that already says why the turn failed (OpenCode's inline
      // error row, Codex and Pi's error status line) gets no second row.
      const messagesWithNotices = withNativeTerminalMessages(
        transcript.messages,
        terminalMessages as unknown[],
      );
      const renderedTranscript = { messages: messagesWithNotices, window: transcript.window };
      const projectionTitle = this.context.sessionTitles.resolve({
        sessionKey,
        session: resolved.session,
        agent: input.agent,
        ...(snapshot.title ? { providerTitle: snapshot.title } : {}),
        ...firstUserMessageOf(normalized.messages, normalized.window),
        transient: resolved.transient,
        ...(resolved.provider.setSessionTitle
          ? {
              setProviderTitle: (id: string, title: string) =>
                resolved.provider.setSessionTitle!(id, title),
            }
          : {}),
      });
      if (input.agent === "codex" && !resolved.transient) {
        const attentionItemIds = renderedTranscript.messages.flatMap((message) => {
          const record = message as { parts?: unknown };
          if (!Array.isArray(record.parts)) return [];
          return record.parts.flatMap((part) => {
            if (!part || typeof part !== "object") return [];
            const candidate = part as {
              type?: unknown;
              asyncQuestion?: { itemId?: unknown };
            };
            return candidate.type === "async-question" &&
              typeof candidate.asyncQuestion?.itemId === "string"
              ? [candidate.asyncQuestion.itemId]
              : [];
          });
        });
        try {
          await this.host.recordAsyncQuestionAttention(
            input.environmentId,
            resolved.session.key,
            attentionItemIds,
            resolved.session.logicalSessionKey,
          );
        } catch (error) {
          // Attention is auxiliary projection metadata. A deleted environment
          // or transient persistence failure must not make its transcript
          // unreadable.
          log.warn("question.attention-record-failed", {
            environmentId: input.environmentId,
            error: formatLogError(error, { message: false }),
          });
        }
      }
      // Reading the projection is the only moment a parked dispatch is
      // reliably revisited, so it is where the provider gets asked whether the
      // prompt landed after all. A record that outlived the backend generation
      // that created it is settled here instead of waiting for the user.
      if (!resolved.transient && resolved.session.pendingDispatch) {
        this.host.scheduleAmbiguousDispatchSettle(
          input,
          key,
          resolved.session.pendingDispatch.requestId,
          resolved.provider,
        );
      }
      if (!resolved.transient && resolved.session.pendingSteer) {
        this.host.scheduleAmbiguousSteerSettle(
          input,
          key,
          resolved.session.pendingSteer.requestId,
          resolved.provider,
        );
      }
      const asyncQuestionResponses = new Map<string, NativeAgentAsyncQuestionResponse>();
      const asyncQuestionResponsePriority: Record<
        NativeAgentAsyncQuestionResponse["state"],
        number
      > = {
        queued: 1,
        failed: 2,
        dispatching: 3,
        sent: 4,
      };
      const recordAsyncQuestionResponse = (
        requestId: unknown,
        state: NativeAgentAsyncQuestionResponse["state"],
      ) => {
        if (typeof requestId !== "string") return;
        const itemId = nativeAsyncQuestionItemId(requestId);
        if (!itemId) return;
        const existing = asyncQuestionResponses.get(itemId);
        if (
          existing &&
          asyncQuestionResponsePriority[existing.state] >= asyncQuestionResponsePriority[state]
        )
          return;
        asyncQuestionResponses.set(itemId, { itemId, requestId, state });
      };
      for (const requestId of resolved.session.dispatchedRequestIds ?? []) {
        recordAsyncQuestionResponse(requestId, "sent");
      }
      for (const message of queue?.messages ?? []) {
        recordAsyncQuestionResponse(
          message && typeof message === "object" ? (message as { id?: unknown }).id : undefined,
          "queued",
        );
      }
      recordAsyncQuestionResponse(queue?.inFlight?.requestId, "dispatching");
      recordAsyncQuestionResponse(queue?.dispatchError?.messageId, "failed");
      const retiredDispatch = projectedRetiredDispatch(
        input.agent,
        resolved.session,
        this.host.now(),
      );
      const notices = visibleProjectionNotices(
        input.agent,
        snapshot.notices,
        sessionIncompleteTurnNotice(resolved.session),
        retiredDispatch,
        sessionModelSubstitutionNotice(resolved.session, this.host.now()),
      );

      const projection: NativeAgentSessionProjection = {
        platform: input.agent,
        environmentId: input.environmentId,
        sessionId: resolved.session.providerSessionId,
        messageWindow: renderedTranscript.window,
        ...(projectionTitle ? { title: projectionTitle } : {}),
        ...(snapshot.shareUrl === undefined ? {} : { shareUrl: snapshot.shareUrl }),
        connection: "connected",
        turn: {
          phase:
            snapshot.phase === "cancelling" ||
            snapshot.phase === "recovering" ||
            snapshot.phase === "error"
              ? snapshot.phase
              : blocked
                ? "blocked"
                : (snapshot.phase ??
                  (snapshot.status === "error"
                    ? "error"
                    : snapshot.status === "running"
                      ? "running"
                      : "idle")),
          ...(snapshot.turnStartedAt === undefined ? {} : { startedAt: snapshot.turnStartedAt }),
          ...(snapshot.error ? { error: snapshot.error } : {}),
          ...(snapshot.turnActivity && snapshot.status === "running"
            ? { activity: snapshot.turnActivity }
            : {}),
          // The run a steer from this view is bound to (to-do 8107 (retired)).
          ...(snapshot.turnRunId &&
          (snapshot.status === "running" || snapshot.status === "blocked" || blocked)
            ? { runId: snapshot.turnRunId }
            : {}),
          ...this.context.parts.quietObservationFlag(resolved.session),
        },
        messages: renderedTranscript.messages,
        interactions: interactionSnapshot.requests,
        // Remove the provider-specific controls the compact input bar does not
        // own. Both projection reads apply the same shared table, so a control
        // hidden on this path cannot reappear on the progressive one.
        composerControls: withoutSuppressedComposerControls(
          input.agent,
          nativeComposerControls(
            composer,
            snapshot.status === "running" || blocked,
            capabilities,
            input.agent,
          ),
        ),
        composer,
        ...(snapshot.readiness ? { readiness: snapshot.readiness } : {}),
        capabilities,
        ...(slashCommands.length > 0 ? { slashCommands } : {}),
        slashCommandCatalogue: commandCatalogue.state,
        ...(queue
          ? {
              queue: {
                items: mergeNativeAgentQueueItems(
                  snapshot.providerQueue?.items ?? [],
                  queue.messages,
                ),
                ...(queue.inFlight ? { inFlightRequestId: queue.inFlight.requestId } : {}),
                ...nativeAgentQueueEditingField(queue),
                ...(queue.dispatchError
                  ? {
                      blocked: {
                        messageId: queue.dispatchError.messageId,
                        error: queue.dispatchError.message,
                      },
                    }
                  : {}),
              },
            }
          : snapshot.providerQueue
            ? { queue: snapshot.providerQueue }
            : {}),
        ...goalProjectionField(resolved.session),
        ...this.context.parts.suborkProjectionField(resolved.session),
        ...(asyncQuestionResponses.size > 0
          ? { asyncQuestionResponses: [...asyncQuestionResponses.values()] }
          : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...((snapshot.policy ?? resolved.session.policy)
          ? { policy: snapshot.policy ?? resolved.session.policy }
          : {}),
        ...(snapshot.rateLimits ? { rateLimits: snapshot.rateLimits } : {}),
        ...(snapshot.runtimeHealthAuthoritative === undefined
          ? {}
          : { runtimeHealthAuthoritative: snapshot.runtimeHealthAuthoritative }),
        ...(snapshot.runtime || mcpServers.length > 0
          ? {
              runtime: {
                ...snapshot.runtime,
                ...(mcpServers.length > 0
                  ? { mcpServers: mcpServers.length, mcp: mcpServers }
                  : {}),
              },
            }
          : {}),
        ...(notices.length > 0 ? { notices } : {}),
        ...(resolved.session.pendingDispatch || resolved.session.pendingSteer
          ? {
              recoverableDispatch: {
                requestId:
                  resolved.session.pendingDispatch?.requestId ??
                  resolved.session.pendingSteer!.requestId,
                createdAt:
                  resolved.session.pendingDispatch?.createdAt ??
                  resolved.session.pendingSteer!.createdAt,
                kind: resolved.session.pendingDispatch ? ("prompt" as const) : ("steer" as const),
                status: this.context.parts.recoverableDispatchStatus(
                  resolved.session.pendingDispatch?.createdAt ??
                    resolved.session.pendingSteer!.createdAt,
                  resolved.session.pendingDispatch ? "prompt" : "steer",
                ),
              },
            }
          : {}),
        ...(retiredDispatch ? { retiredDispatch } : {}),
        ...(snapshot.backgroundTasks ? { backgroundTasks: snapshot.backgroundTasks } : {}),
        ...(snapshot.suggestedPrompt ? { suggestedPrompt: snapshot.suggestedPrompt } : {}),
        ...(snapshot.completionBlockedByBackgroundTasks === undefined
          ? {}
          : {
              completionBlockedByBackgroundTasks: snapshot.completionBlockedByBackgroundTasks,
            }),
        ...(capabilities.fork
          ? {
              turnBoundaries: renderedTranscript.messages.flatMap((candidate) => {
                const message = candidate as Record<string, unknown>;
                return typeof message.id === "string"
                  ? [
                      {
                        turnId: typeof message.turnId === "string" ? message.turnId : message.id,
                        messageId: message.id,
                        resumable: capabilities.resume,
                        forkable: true,
                      },
                    ]
                  : [];
              }),
            }
          : {}),
        revision: 0,
        generation,
        cursor:
          snapshot.providerRevision === undefined ? undefined : String(snapshot.providerRevision),
      };
      return this.commitProjection(
        key,
        windowed,
        projection,
        generation,
        epoch,
        transient ? null : "projection-read",
      );
    } catch (error) {
      return this.commitProjection(
        key,
        windowed,
        this.unreachableProjection(
          previous,
          input,
          generation,
          error instanceof Error ? error.message : "Native agent is unavailable",
        ),
        generation,
        epoch,
        transient ? null : "projection-unreachable",
      );
    }
  }

  /**
   * The projection for a session this backend cannot read right now.
   *
   * `error` is the only connection state the renderer gives a retry control and
   * failure text to, so every terminally unreachable path lands here rather
   * than leaving a tab on an overlay it has no way to leave. Whatever was last
   * cached stays underneath it: the transcript the user was reading is still
   * the best description of the conversation, and a reconnect that succeeds
   * should not have to rebuild it from nothing.
   */
  private unreachableProjection(
    previous: NativeAgentProjectionCacheEntry | undefined,
    input: NativeAgentProjectionInput,
    generation: string,
    error: string,
    sessionId?: string,
  ): NativeAgentSessionProjection {
    return {
      ...(previous?.projection ?? {
        platform: input.agent,
        environmentId: input.environmentId,
        ...(sessionId ? { sessionId } : {}),
        messages: [],
        interactions: [],
        composerControls: [],
        capabilities: nativeCapabilities(input.agent),
        revision: 0,
        generation,
      }),
      connection: "error",
      turn: { phase: "recovering", error },
      notices: [
        {
          kind: "recovery",
          message: "Reconnecting to the native agent runtime…",
        },
      ],
      revision: 0,
      generation,
    };
  }

  /**
   * Allocate the next revision for one logical session, whatever representation
   * asked for it.
   *
   * The renderer treats `revision` as a single ordering within a generation, so
   * the legacy full projection and the detail-recovery tail must draw from the
   * same sequence. A counter that was never recorded — or was evicted — is
   * re-seeded from whatever is still cached for this session, so a restart
   * cannot hand back a revision a client already holds.
   */
  private nextProjectionRevision(sessionKey: string, generation: string): number {
    const record = this.projectionRevisions.get(sessionKey);
    let previous = record?.generation === generation ? record.revision : 0;
    if (record?.generation !== generation) {
      for (const candidate of [sessionKey, `${sessionKey}\0detail-recovery`]) {
        const cached = this.projectionCache.get(candidate);
        if (cached?.generation === generation) {
          previous = Math.max(previous, cached.projection.revision);
        }
      }
    }
    const revision = previous + 1;
    this.projectionRevisions.delete(sessionKey);
    this.projectionRevisions.set(sessionKey, { generation, revision });
    while (this.projectionRevisions.size > NATIVE_PROJECTION_REVISION_LIMIT) {
      const oldest = this.projectionRevisions.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === sessionKey) break;
      this.projectionRevisions.delete(oldest);
    }
    return revision;
  }

  private commitProjection(
    key: string,
    input: NativeAgentProjectionInput,
    candidate: NativeAgentSessionProjection,
    generation: string,
    epoch: number,
    /** Why a changed projection is announced; `null` commits it silently. */
    cause: NativeSessionInvalidationCause | null,
  ): NativeAgentSessionProjection {
    if ((this.context.projectionEpochs.get(key) ?? 0) !== epoch) {
      /*
       * This read lost a race with a mutation that replaced the tab's provider
       * identity, so it must not become the cached authoritative state. It is
       * still a real answer though: `null` is reserved for "this logical tab
       * resolves to no provider session", and returning it here would make an
       * ordinary resume look like a deleted session to any caller that does not
       * fence reads itself. Hand back the newest committed projection, or the
       * uncommitted candidate at revision 0 when nothing is cached yet.
       */
      return (
        this.projectionCache.get(key)?.projection ?? {
          ...candidate,
          revision: 0,
          generation,
          cursor: `${generation}:0`,
        }
      );
    }
    this.context.queuedTurnLog.observe({
      agent: input.agent,
      environmentId: input.environmentId,
      sessionKey: nativeAgentSessionStorageKey(
        input.environmentId,
        input.agent,
        input.logicalSessionKey,
      ),
      phase: candidate.turn.phase,
      queued: candidate.queue?.items.length ?? 0,
    });
    const previous = this.projectionCache.get(key);
    // Compared only for equality, so a digest stands in for the whole JSON:
    // rows come through the per-object memo (projected values are immutable
    // once `projectionMessages` returns them) instead of being serialized
    // again, and the cache entry keeps 43 characters rather than the window.
    const fingerprint = digestWithMessages("legacy-commit", { ...candidate, revision: 0 });
    if (previous && previous.generation === generation && previous.fingerprint === fingerprint) {
      return previous.projection;
    }
    const revision = this.nextProjectionRevision(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
      generation,
    );
    const projection = {
      ...candidate,
      revision,
      generation,
      cursor: `${generation}:${revision}`,
    };
    if (!previous && this.projectionCache.size >= NATIVE_PROJECTION_CACHE_LIMIT) {
      const oldest = this.projectionCache.keys().next().value as string | undefined;
      /*
       * Capacity eviction is not an identity change: bumping the evicted key's
       * epoch would fence an unrelated in-flight read for it and report that
       * session as missing. Drop the entry only, and reclaim its epoch when no
       * read is relying on it.
       */
      if (oldest) {
        this.projectionCache.delete(oldest);
        this.projectionMissingSince.delete(oldest);
        this.context.pruneProjectionEpoch(oldest);
      }
    }
    this.projectionCache.set(key, {
      input: { ...input },
      projection,
      fingerprint,
      generation,
    });
    if (cause) {
      this.storage.announceNativeAgentSessionProjection(input.environmentId, cause, {
        agent: input.agent,
        logicalSessionKey: input.logicalSessionKey,
      });
    }
    return projection;
  }

  /**
   * The last projection this process built for one session, if any. Purely
   * in-memory: never reads a provider or hydrates a transcript, so background
   * observers may consult it freely. It can be stale or absent.
   */
  cachedProjectionSnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): NativeAgentSessionProjection | null {
    const sessionKey = nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey);
    return (
      this.projectionCache.get(`${sessionKey}\0detail-recovery`)?.projection ??
      this.projectionCache.get(sessionKey)?.projection ??
      null
    );
  }
}
