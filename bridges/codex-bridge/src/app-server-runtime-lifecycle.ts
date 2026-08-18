import {
  RuntimeSseEvent,
  AppServerRuntimeOptions,
  OrderedRuntimeEvent,
  SteerOrdering,
  HistoricalAssistantSegmentState,
  MAX_HISTORICAL_ASSISTANT_SEGMENTS,
  ThreadRuntimeState,
  MAX_PENDING_EVENTS_PER_TURN,
  MAX_PENDING_TURNS,
  MAX_ORDERED_EVENTS_PER_THREAD,
  MAX_ORDERED_EVENT_BYTES_PER_THREAD,
  LARGE_MESSAGE_CHARS,
  VERY_LARGE_MESSAGE_CHARS,
  ORDERED_EVENT_ESTIMATE_MAX_DEPTH,
  ORDERED_EVENT_ESTIMATE_NODE_BYTES,
  DEFAULT_INITIAL_PROMPT_RETRY_DELAY_MS,
  estimateOrderedEventBytes,
  messageSnapshotIntervalMs,
  isSamePublishedPart,
  normalizedMessageSnapshotChars,
  DEFAULT_THREAD_IDLE_MS,
  DEFAULT_SESSION_RETENTION_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_SESSION_ACTIVITY_PERSIST_INTERVAL_MS,
  DEFAULT_ENVIRONMENT_DRAIN_TIMEOUT_MS,
  DEFAULT_AMBIGUOUS_RECOVERY_TIMEOUT_MS,
  MAX_RECOVERED_CONTEXT_CHARS,
  IDLE_WAIT_POLL_MS,
  AMBIGUOUS_DISPATCH_FAILURE_MESSAGE,
  AmbiguousDispatchResolution,
  mergeRateLimitWindows,
  isJsonObject,
  DEFAULT_COMPACTION_TIMEOUT_MS,
  MAX_STEER_REQUESTS,
  codexStructuredOutputFailure,
  parseCodexStructuredOutput,
  buildRecoveredContextPrompt,
  PromptAcceptedResult,
  AppServerRuntimeBase,
} from "./app-server-runtime-base.js";
import { createHash } from "node:crypto";
import type { AppServerEngine } from "./engine/app-server-engine.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolution,
} from "./app-server/approvals.js";
import {
  isInteractionAnswerMap,
  type InteractionAnswer,
  type InteractionRequest,
  type InteractionResolution,
} from "./app-server/interactions.js";
import type {
  EngineEvent,
  EngineGeneration,
  EngineRateLimitWindow,
  EngineRateLimitWindowUpdate,
  EngineThread,
  EngineTurnConfig,
  EngineUsageSnapshot,
  EngineUserInput,
} from "./engine/types.js";
import {
  OverlappingTurnError,
  ThreadRegistry,
  phaseToExternalStatus,
  type BridgeSession,
  type PromptAttachmentInput,
  type SessionPhase,
  type SessionTitleSource,
  type ThreadContext,
} from "./sessions/thread-registry.js";
import {
  TurnAccumulator,
  unconfirmedTurnId,
  type AssistantSegment,
} from "./sessions/turn-accumulator.js";
import {
  compareDispatchRecordsNewestFirst,
  DispatchJournal,
  DispatchJournalAdmissionError,
} from "./sessions/dispatch-journal.js";
import { BridgeSessionStore } from "./sessions/persistence.js";
import {
  beginTurnRenderState,
  createTurnRenderState,
  releaseTurnRenderState,
  renderTurn,
  SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS,
  type TurnRenderState,
} from "./messages/render-turn.js";
import { UpdateCoalescer } from "./messages/coalescer.js";
import { describeDiffBudget } from "./messages/diff-budget.js";
import { getTranscriptCacheStats } from "./transcript-cache.js";
import {
  createMessageId,
  createSessionId,
  type MessagePatchEventData,
  type NormalizedMessage,
  type NormalizedPart,
} from "./messages/types.js";
import { appendAttachmentTags } from "./messages/attachment-tags.js";
import {
  buildPromptInput,
  expandPromptTemplate,
  getAvailableSlashCommandDefinitions,
  isCodexCliNativeSlashCommand,
  parseCodexSteerCommand,
  parseSlashCommandPrompt,
  wrapPromptForConversationMode,
  type ConversationMode,
  type PromptSlashCommand,
} from "./prompts/slash-commands.js";
import {
  getWorkingDirectory,
  hydrateMessagesFromPersistedSession,
  invalidateTranscriptCatalogCache,
  listPersistedSessionsWithTitlesForCwd,
  type PersistedSessionMeta,
} from "./history/rollout.js";
import {
  buildFallbackSessionTitle,
  persistSessionTitle,
  readPersistedSessionTitleEntries,
  type PersistedSessionTitleSource,
} from "./session-titles.js";
import { AppServerRpcError, isMissingRolloutError } from "./app-server/errors.js";
import type { BridgeModel } from "./models-cache.js";
import {
  structuredOutputFailure,
  tryParseStructuredOutputText,
  type JsonSchema,
  type StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import { fallbackReasoningId } from "@orkestrator/protocol/native-agent";

export abstract class AppServerRuntimeLifecycle extends AppServerRuntimeBase {
  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    const startPromise = this.startOnce();
    this.startPromise = startPromise;
    try {
      await startPromise;
      this.started = true;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  protected async startOnce(): Promise<void> {
    await this.journal.load();
    const persistedSessions = await this.store.load();
    for (const persisted of persistedSessions) {
      this.registry.restoreSession({
        id: persisted.bridgeSessionId,
        threadId: persisted.threadId,
        config: persisted.config,
        title: persisted.title,
        titleSource: persisted.titleSource,
        titleGenerationAttempted: Boolean(persisted.title),
        lastAcceptedRequestId: persisted.lastAcceptedRequestId,
        structuredOutputRequestId: persisted.structuredOutputRequestId,
        structuredOutput: persisted.structuredOutput,
        confirmedModelsByTurn: persisted.confirmedModelsByTurn,
        lastAccessed: Date.parse(persisted.lastAccessed),
      });
      this.lastPersistedAccess.set(persisted.bridgeSessionId, Date.parse(persisted.lastAccessed));
    }
    // Claim the affected threads *before* the first await below, so a request
    // racing startup sees `recovering` rather than a misleading `idle`.
    for (const record of this.journal.unresolved()) {
      if (record.threadId) this.threadsAwaitingDispatchRecovery.add(record.threadId);
    }

    try {
      await this.options.engine.start();
      await this.generationRecovery;
      const recovery = this.recoverUnresolvedDispatches().finally(() => {
        this.threadsAwaitingDispatchRecovery.clear();
      });
      this.dispatchRecovery = recovery.catch(() => undefined);
      await recovery;
    } catch (error) {
      this.threadsAwaitingDispatchRecovery.clear();
      throw error;
    }

    const interval = this.options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (interval > 0) {
      this.sweepTimer = setInterval(() => void this.sweepIdle(), interval);
      this.sweepTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const timer of this.recoveryBackstops.values()) clearTimeout(timer);
    this.recoveryBackstops.clear();
    // Nothing will report terminal after this, so release the drain rather than
    // holding shutdown for its full deadline.
    this.notifyThreadActivity();
    // Stop the transport first so no new terminal notifications can arrive,
    // then settle work already handed off from its read loop before releasing
    // the render state that work still needs.
    await this.options.engine.stop();
    await this.drainPendingWork();
    await Promise.allSettled([...this.pendingSessionWrites]);
    for (const threadId of [...this.threadState.keys()]) this.releaseThreadRuntimeState(threadId);
  }

  /**
   * Waits for every terminal-event finalization currently queued, including work
   * enqueued by another finalization before it settles.
   *
   * The app-server stdout loop must never await this. It is for graceful
   * shutdown and test/embedding synchronization only.
   */
  async drainPendingWork(): Promise<void> {
    // Generation/dispatch recovery is also launched from transport callbacks.
    // Settle it before flushing render coalescers because recovery may create or
    // finalize turns and schedule a final snapshot.
    await Promise.allSettled([this.generationRecovery, this.dispatchRecovery]);
    while (true) {
      // A finalization can schedule a coalesced render after an earlier flush,
      // so flush at the start of every pass rather than only once before
      // waiting. Otherwise shutdown (and the test harness) can observe all
      // tracked promises settled while one last snapshot is still timer-bound.
      for (const state of this.threadState.values()) {
        await state.coalescer.flushNow();
      }
      const pending = [
        ...this.pendingFinalizations,
        ...this.pendingSessionWrites,
        ...[...this.threadState.values()]
          .filter((state) => state.orderedEventDraining)
          .map((state) => state.orderedEventTail),
      ];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  getRegistry(): ThreadRegistry {
    return this.registry;
  }

  getJournal(): DispatchJournal {
    return this.journal;
  }

  /**
   * Reconstructs live work from the durable dispatch journal before any route can
   * report a restored session idle.
   */
  protected async recoverUnresolvedDispatches(): Promise<void> {
    const byThread = new Map<string, ReturnType<DispatchJournal["unresolved"]>[number]>();
    for (const record of this.journal.unresolved()) {
      if (!record.threadId) {
        // The old bridge process and its child are gone. With no thread address
        // there is nothing that can still be executing, but the id must remain
        // spent because a prepared write may already have caused side effects.
        await this.journal.markTerminal(record.requestId, "failed");
        continue;
      }
      const current = byThread.get(record.threadId);
      if (!current || compareDispatchRecordsNewestFirst(record, current) < 0) {
        if (current) {
          await this.journal.markTerminal(current.requestId, "failed", {
            threadId: current.threadId ?? undefined,
            turnId: current.turnId,
          });
        }
        byThread.set(record.threadId, record);
      } else {
        await this.journal.markTerminal(record.requestId, "failed", {
          threadId: record.threadId,
          turnId: record.turnId,
        });
      }
    }

    for (const record of byThread.values()) {
      const threadId = record.threadId;
      if (!threadId) continue;
      const session =
        this.registry.getSession(record.bridgeSessionId) ??
        this.registry.listSessions().find((candidate) => candidate.threadId === threadId);
      if (!session) {
        this.threadsAwaitingDispatchRecovery.delete(threadId);
        // No bridge session is bound to this thread any more, so nothing will
        // ever rehydrate the record and it would stay unresolved — and therefore
        // exempt from retention and the cap — forever. Settling it `failed` keeps
        // the id spent (`already-done`), which is the direction that can never
        // duplicate an execution.
        await this.journal.markTerminal(record.requestId, "failed", {
          threadId,
          turnId: record.turnId,
        });
        continue;
      }

      /**
       * Held for the whole settle.
       *
       * Routes are already serving, so a prompt for this thread can arrive
       * mid-recovery. Without the lock it would dispatch a live turn that this
       * loop then overwrites with the unconfirmed placeholder for the *old*
       * record, orphaning it.
       */
      await this.registry
        .withDispatchLock(session, async () => {
          let context: ThreadContext | undefined;
          try {
            context = await this.ensureAttached(session.id);
          } catch (error) {
            // Keep the record unresolved and the session non-idle. A later request or
            // process restart can retry without risking a duplicate execution.
            const existing =
              this.registry.getThread(threadId) ??
              this.registry.attach(session.id, threadId, {
                engineHandle: threadId,
                engineGeneration: this.options.engine.info().generation,
              });
            existing.materialized = true;
            existing.unsubscribed = true;
            this.registry.setPhase(existing, "recovering");
            this.emitStatus(existing);
            // Arm the escalation path. Without it this thread stays `recovering`
            // — reported as `running` — with nothing scheduled to resolve it, and
            // every later prompt 409s until an unrelated generation change.
            this.scheduleRecoveryBackstop(existing);
            console.warn(
              `[codex-bridge] Could not restore dispatch ${record.requestId}:`,
              error instanceof Error ? error.message : error,
            );
            return;
          }

          if (!context) {
            await this.journal.markTerminal(record.requestId, "failed", {
              threadId,
              turnId: record.turnId,
            });
            return;
          }

          const lastMessage = context.messages.at(-1);
          const assistantMessage =
            lastMessage?.role === "assistant"
              ? lastMessage
              : {
                  id: createMessageId(),
                  role: "assistant" as const,
                  content: "",
                  parts: [],
                  createdAt: new Date(this.now()).toISOString(),
                };
          if (lastMessage !== assistantMessage) {
            context.messages.push(assistantMessage);
            this.bumpMessageRevision(context);
            // Announce the row before anything streams into it. Its updates are
            // sparse patches keyed by message id, and a patch for a message the
            // client has never seen can only be answered by refetching the whole
            // transcript.
            for (const sessionId of context.bridgeSessionIds) {
              this.options.emit({
                type: "message.updated",
                sessionId,
                data: { message: assistantMessage },
              });
            }
          }

          this.registry.setPhase(context, "recovering");
          this.emitStatus(context);
          await this.settleAmbiguousDispatch(context, record.requestId, assistantMessage.id, {
            forgetIfAbsent: record.state === "prepared",
          });
          this.emitStatus(context);
        })
        .finally(() => {
          // The thread now has a real phase, so the startup override must stop
          // applying whether the settle succeeded or threw.
          this.threadsAwaitingDispatchRecovery.delete(threadId);
        });
    }
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * Frees idle threads and forgets long-dead session ids.
   *
   * The Codex rollout on disk is the authoritative transcript, so everything held
   * here is a cache. That makes detaching safe *and* necessary: without it a
   * long-lived bridge accumulates every transcript, render state and app-server
   * subscription it has ever touched.
   */
  async sweepIdle(): Promise<{ detached: number; forgotten: number }> {
    const idleMs = this.options.threadIdleMs ?? DEFAULT_THREAD_IDLE_MS;
    let detached = 0;

    if (idleMs > 0) {
      for (const context of this.registry.detachableThreads(idleMs)) {
        await this.detachThread(context);
        detached += 1;
      }
    }

    const retentionMs = this.options.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS;
    let forgotten = 0;
    for (const session of this.registry.expiredSessions(retentionMs)) {
      this.registry.releaseSession(session.id);
      this.lastPersistedAccess.delete(session.id);
      await this.store.remove(session.id).catch(() => undefined);
      forgotten += 1;
    }

    return { detached, forgotten };
  }

  /**
   * Releases a thread's memory and its app-server subscription.
   *
   * Note the materialization check. A thread that has persisted at least one user
   * message can be resumed from its rollout, so detaching is reversible. One that
   * was started but never prompted has **no rollout** — `thread/resume` fails with
   * "no rollout found" — so its id is cleared instead, and the next prompt starts a
   * fresh thread. Verified against codex 0.147.0.
   */
  protected async detachThread(context: ThreadContext): Promise<void> {
    const sessionIds = [...context.bridgeSessionIds];
    this.releaseThreadRuntimeState(context.threadId);

    this.registry.detachThread(context.threadId);
    if (!context.materialized) {
      this.registry.clearThreadBinding(context.threadId);
      await Promise.all(
        sessionIds.map(async (sessionId) => {
          this.lastPersistedAccess.delete(sessionId);
          await this.store.remove(sessionId).catch(() => undefined);
        }),
      );
    }

    this.detachedThreads += 1;
    await this.options.engine.unsubscribeThread(context.engineHandle).catch(() => undefined);
  }

  /**
   * Frees everything this process holds for a thread.
   *
   * Must be called on *every* path that drops a thread, not just the idle sweep.
   * The render state carries the diff baselines — the largest per-thread
   * allocation — and the coalescer owns a live timer, so forgetting a thread
   * without this leaks both for a conversation that can never come back.
   */
  protected releaseThreadRuntimeState(threadId: string): void {
    const timer = this.recoveryBackstops.get(threadId);
    if (timer) {
      clearTimeout(timer);
      this.recoveryBackstops.delete(threadId);
    }
    this.clearCompactionBackstop(threadId);
    // Every thread the bridge has ever touched used to leave a permanent entry
    // here, which the rate-limit fan-out then walked on every tick.
    this.usageByThread.delete(threadId);
    const state = this.threadState.get(threadId);
    if (!state) return;
    state.coalescer.stop();
    state.orderedEvents.length = 0;
    state.orderedEventBytes = 0;
    state.orderedReconcilePending = false;
    releaseTurnRenderState(state.render);
    state.historicalAssistantSegments.clear();
    state.pendingEvents.clear();
    this.threadState.delete(threadId);
  }

  /**
   * Re-attaches a detached session before serving a request.
   *
   * Transparent by design: a detached session is indistinguishable from an
   * attached one except for the latency of one `thread/resume` plus a rollout
   * read. Every route that touches session state calls this first, which is what
   * makes "reopen a tab tomorrow" work without the caller knowing anything about
   * detaching.
   */
  protected async ensureAttached(sessionId: string): Promise<ThreadContext | undefined> {
    const session = this.registry.getSession(sessionId);
    if (!session) return undefined;

    const existing = this.registry.getThreadForSession(sessionId);
    const generation = this.options.engine.info().generation;
    if (existing && !existing.unsubscribed && existing.engineGeneration === generation) {
      // `getThreadForSession` resolves by thread id alone, with no membership
      // check. A session restored from disk onto a thread another session had
      // already attached would otherwise never join `bridgeSessionIds` — and
      // every emit path iterates that set, so the tab would receive no status,
      // no messages and no approval cards, not even for its own prompts.
      const modelsBeforeAttach = this.snapshotBoundModelOverrides(existing.threadId);
      const attached = this.registry.attach(sessionId, existing.threadId, {
        engineHandle: existing.engineHandle,
        engineGeneration: existing.engineGeneration,
        cwd: existing.cwd,
        name: existing.name,
      });
      this.publishPersistedModelOverrides(attached);
      await this.synchronizeAttachedModelOverrides(attached, modelsBeforeAttach);
      return attached;
    }
    // No thread id yet: lazy creation on first prompt, nothing to re-attach.
    if (!session.threadId) return undefined;

    const threadId = session.threadId;
    try {
      const modelsBeforeAttach = this.snapshotBoundModelOverrides(threadId);
      const thread = await this.options.engine.resumeThread(threadId, { config: session.config });
      // Always through `attach`: it is idempotent for an existing context, and it
      // is the only thing that registers this session in `bridgeSessionIds`.
      const context = this.registry.attach(sessionId, threadId, {
        engineHandle: thread.handle,
        engineGeneration: generation,
        cwd: thread.cwd,
        name: thread.name,
        modelId: thread.model,
      });
      context.cwd = thread.cwd ?? context.cwd;
      context.name = thread.name ?? context.name;
      // It had a rollout to resume from, so it is materialized by definition.
      context.materialized = true;
      if (context.messages.length === 0) {
        const hydrated = await hydrateMessagesFromPersistedSession(threadId);
        context.messages = hydrated.messages;
        this.applyPersistedModelOverrides(context);
        if (hydrated.messages.length > 0) this.bumpMessageRevision(context);
        if (!session.title) {
          session.title = thread.name ?? hydrated.title;
          session.titleSource = thread.name ? "codex" : hydrated.titleSource;
        }
      } else {
        this.publishPersistedModelOverrides(context);
      }
      await this.synchronizeAttachedModelOverrides(context, modelsBeforeAttach);
      this.reattachedThreads += 1;
      return context;
    } catch (error) {
      // Only a proven missing rollout invalidates the durable binding. A
      // timeout, restart, or temporary RPC failure is ambiguous and must leave
      // the original thread id available for the next retry.
      if (isMissingRolloutError(error)) {
        const staleSessionIds = this.registry
          .listSessions()
          .filter((entry) => entry.threadId === threadId)
          .map((entry) => entry.id);
        if (existing) {
          // Same teardown as a normal detach: the render state and coalescer must
          // go with the thread, and this one is never coming back.
          this.releaseThreadRuntimeState(threadId);
          this.registry.detachThread(threadId);
          await this.options.engine.unsubscribeThread(existing.engineHandle).catch(() => undefined);
        }
        this.registry.clearThreadBinding(threadId);
        await Promise.all(
          staleSessionIds.map(async (id) => {
            this.lastPersistedAccess.delete(id);
            await this.store.remove(id).catch(() => undefined);
          }),
        );
      }
      console.warn(
        `[codex-bridge] Could not re-attach thread ${threadId}${
          isMissingRolloutError(error) ? " (no rollout on disk)" : ""
        }:`,
        error instanceof Error ? error.message : error,
      );
      if (!isMissingRolloutError(error)) throw error;
      return undefined;
    }
  }

  /** Observability for the storage budget, surfaced through /global/health. */
  getStorageStats(): {
    threads: number;
    sessions: number;
    detachedThreads: number;
    reattachedThreads: number;
    transcriptCache: { entries: number; bytes: number };
    diffBudget: { baselineEntries: number; baselineBytes: number; cacheEntries: number };
  } {
    let baselineEntries = 0;
    let baselineBytes = 0;
    let cacheEntries = 0;
    for (const state of this.threadState.values()) {
      const stats = describeDiffBudget(state.render.fileChange);
      baselineEntries += stats.baselineEntries;
      baselineBytes += stats.baselineBytes;
      cacheEntries += stats.cacheEntries;
    }
    return {
      threads: this.registry.listThreads().length,
      sessions: this.registry.listSessions().length,
      detachedThreads: this.detachedThreads,
      reattachedThreads: this.reattachedThreads,
      transcriptCache: getTranscriptCacheStats(),
      diffBudget: { baselineEntries, baselineBytes, cacheEntries },
    };
  }

  // ------------------------------------------------------------------ events

  protected stateFor(threadId: string): ThreadRuntimeState {
    let state = this.threadState.get(threadId);
    if (!state) {
      state = {
        render: createTurnRenderState(),
        historicalAssistantSegments: new Map(),
        pendingEvents: new Map(),
        publishedParts: [],
        orderedEventTail: Promise.resolve(),
        orderedEvents: [],
        orderedEventBytes: 0,
        orderedEventActiveBytes: 0,
        orderedEventDraining: false,
        orderedReconcilePending: false,
        lastPublishedSnapshotChars: 0,
        coalescer: new UpdateCoalescer({
          intervalMs:
            this.options.coalesceIntervalMs ??
            (() =>
              messageSnapshotIntervalMs(
                this.threadState.get(threadId)?.lastPublishedSnapshotChars ?? 0,
              )),
          publish: () => this.publishAssistantMessage(threadId),
          onError: (error) =>
            console.error("[codex-bridge] Failed to publish message update:", error),
        }),
      };
      this.threadState.set(threadId, state);
    }
    return state;
  }

  /**
   * Rebinds a thread's render state to a new streaming assistant message.
   *
   * Every field here moves together. Resetting `render`/`assistantMessageId`
   * without the three `published*` fields leaves the next publish diffing a new
   * message against the previous one's parts, so this is the only supported way
   * to swap the streaming row.
   */
  protected beginAssistantTurnRender(
    state: ThreadRuntimeState,
    assistantMessage: { id: string; modelId?: string },
  ): void {
    state.historicalAssistantSegments.clear();
    state.render = beginTurnRenderState(state.render);
    state.assistantMessageId = assistantMessage.id;
    state.publishedMessageId = assistantMessage.id;
    state.publishedParts = [];
    state.publishedModelId = assistantMessage.modelId;
  }

  protected onEngineEvent(event: EngineEvent): void {
    if (event.kind === "engine.state") {
      // A restart invalidates every loaded thread. Mark them recovering — never
      // idle, which would let the build pipeline advance on a lost turn.
      if (event.state === "restarting" || event.state === "failed") {
        for (const context of this.registry.markAllRecovering()) {
          this.emitStatus(context);
        }
      }
      return;
    }
    if (event.kind === "engine.generation") {
      // `recovering` must be transient. Left unresolved, the overlapping-turn
      // guard rejects every later prompt with a 409 and the session is bricked.
      const recovery = this.generationRecovery.then(() =>
        this.recoverAfterGenerationChange(event.generation),
      );
      this.generationRecovery = recovery.catch((error) => {
        console.error("[codex-bridge] Generation recovery failed:", error);
      });
      return;
    }
    if (event.kind === "unknown.protocol") return;
    if (event.kind === "account.rateLimits.updated") {
      /**
       * `account/rateLimits/updated` is a **sparse rolling update**, not a
       * replacement: the generated protocol says clients must merge available
       * values into the last full snapshot, and that absent nullable metadata
       * "does not clear a previously observed value". Assigning wholesale meant
       * an update carrying only `secondary` erased the primary window, and one
       * omitting `credits` erased the balance.
       */
      this.accountRateLimits = mergeRateLimitWindows(this.accountRateLimits, event.rateLimits);
      if (event.credits) {
        this.accountCredits = { ...this.accountCredits, ...event.credits };
      }
      for (const [threadId, usage] of this.usageByThread) {
        const sessionIds = this.sessionIdsForThread(threadId);
        // A thread nobody can address any more still has an entry here only until
        // its next release. Skip it rather than re-rendering a snapshot with no
        // reader on every rate-limit tick.
        if (sessionIds.length === 0) continue;
        const merged = {
          ...usage,
          rateLimits: this.accountRateLimits,
          ...(this.accountCredits ? { credits: this.accountCredits } : {}),
          updatedAt: new Date(this.now()).toISOString(),
        };
        this.usageByThread.set(threadId, merged);
        for (const sessionId of sessionIds) {
          this.options.emit({
            type: "session.updated",
            sessionId,
            data: { contextUsage: merged },
          });
        }
      }
      return;
    }

    const threadId = "threadId" in event ? event.threadId : null;
    if (!threadId) return;
    const context = this.registry.getThread(threadId);
    if (!context) return;

    // Stale generation: the process that produced this has been replaced.
    if (
      event.engineGeneration !== undefined &&
      context.engineGeneration !== 0 &&
      event.engineGeneration < context.engineGeneration
    ) {
      return;
    }

    // Usage is a thread snapshot, not a transcript mutation. It can legitimately
    // arrive just after `turn/completed`, when there is no active accumulator to
    // accept its turn id, so apply it directly instead of parking it forever.
    if (event.kind === "thread.usage.updated") {
      this.applyEvent(context, event);
      return;
    }

    // Compaction is thread-scoped, not turn-scoped: its turn is never the active
    // one, so routing it through the parking logic below would drop it and leave
    // the thread busy forever.
    if (event.kind === "thread.compacted") {
      this.finishCompaction(context);
      return;
    }

    /**
     * Park turn-scoped events whose turn is not registered yet.
     *
     * `turn/start`'s response and its notifications travel independently, so a
     * fast turn can be fully reported before we have recorded its id. Without
     * this the entire turn would vanish from the transcript.
     */
    if ("turnId" in event && event.turnId && context.activeTurn?.turnId !== event.turnId) {
      const turn = context.activeTurn;
      // Only buffer for a turn we have not seen; a mismatch against a *newer*
      // registered turn is a genuinely stale event and must stay dropped.
      //
      // An *unconfirmed* placeholder is not such a turn. It holds the overlap
      // guard for a dispatch whose id app-server has not reported yet, so the
      // events arriving here belong to the very turn it is standing in for and
      // must be parked for `drainPendingEvents` — dropping them loses the
      // transcript and, if `turn.completed` is among them, wedges the thread in
      // `running` forever.
      const isStale =
        turn !== null &&
        turn.turnId !== event.turnId &&
        turn.requestId !== undefined &&
        !turn.isUnconfirmed();
      if (!isStale) {
        this.bufferEvent(threadId, event.turnId, event);
        return;
      }
      return;
    }

    this.applyEvent(context, event);
  }

  protected bufferEvent(threadId: string, turnId: string, event: EngineEvent): void {
    const state = this.stateFor(threadId);
    let queue = state.pendingEvents.get(turnId);
    if (!queue) {
      if (state.pendingEvents.size >= MAX_PENDING_TURNS) {
        // Shed the oldest parked turn rather than growing without bound.
        const oldest = state.pendingEvents.keys().next().value;
        if (oldest) state.pendingEvents.delete(oldest);
      }
      queue = [];
      state.pendingEvents.set(turnId, queue);
    }
    if (queue.length < MAX_PENDING_EVENTS_PER_TURN) queue.push(event);
  }

  /** Replays events parked before the turn was registered, in arrival order. */
  protected drainPendingEvents(context: ThreadContext, turnId: string): void {
    const state = this.stateFor(context.threadId);
    const queue = state.pendingEvents.get(turnId);
    state.pendingEvents.clear();
    if (!queue) return;
    for (const event of queue) this.applyEvent(context, event);
  }

  protected applyEvent(context: ThreadContext, event: EngineEvent): void {
    const threadId = context.threadId;

    switch (event.kind) {
      case "thread.name.updated":
        context.name = event.name ?? null;
        return;
      case "thread.model.updated":
        this.applyConfirmedModel(context, event.model);
        return;
      case "turn.model.updated":
        this.applyConfirmedModel(context, event.model, event.turnId);
        return;
      case "thread.usage.updated": {
        const usage = {
          ...event.usage,
          ...(this.accountRateLimits.length > 0 ? { rateLimits: this.accountRateLimits } : {}),
          ...(this.accountCredits ? { credits: this.accountCredits } : {}),
        };
        this.usageByThread.set(threadId, usage);
        for (const sessionId of context.bridgeSessionIds) {
          this.options.emit({
            type: "session.updated",
            sessionId,
            data: { contextUsage: usage },
          });
        }
        return;
      }
      case "turn.started": {
        const turn = context.activeTurn;
        if (turn && turn.turnId === event.turnId) turn.markRunning(event.turnId);
        return;
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        if (event.kind === "item.completed") turn.onItemCompleted(event.item);
        else if (event.kind === "item.started") {
          turn.onItemStarted(event.item, event.startedAtMs);
        } else turn.onItemUpdated(event.item);
        // `item/completed` is authoritative; show it without waiting a tick.
        if (event.kind === "item.completed") void this.stateFor(threadId).coalescer.flushNow();
        else this.stateFor(threadId).coalescer.schedule(this.now());
        return;
      }
      case "item.dynamic.started": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        // This is a recovery candidate, not the authoritative app-server item.
        // Keep it off the live transcript unless its output fails, a structured
        // fileChange replaces it, or turn completion renders it as a fallback.
        turn.onDynamicToolStarted(event.item, event.startedAtMs);
        return;
      }
      case "item.text.delta": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        turn.onTextDelta(event.itemId, event.delta);
        this.stateFor(threadId).coalescer.schedule(this.now());
        return;
      }
      case "item.reasoning.delta": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        turn.onReasoningDelta(event.itemId, event.delta, event.channel, event.index);
        this.stateFor(threadId).coalescer.schedule(this.now());
        return;
      }
      case "item.command.outputDelta": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        turn.onCommandOutputDelta(event.itemId, event.delta);
        this.stateFor(threadId).coalescer.schedule(this.now());
        return;
      }
      case "item.dynamic.output": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        if (turn.onDynamicToolOutput(event.itemId, event.output)) {
          void this.stateFor(threadId).coalescer.flushNow();
        }
        return;
      }
      case "turn.diff": {
        const turn = context.activeTurn;
        if (turn && turn.accepts(event)) turn.onTurnDiff(event.diff);
        return;
      }
      case "error": {
        const turn = context.activeTurn;
        // Recorded but not terminal: app-server can report a retryable error and
        // still complete the turn.
        if (turn) turn.onError(event.error);
        this.enqueueAfterMessageFlush(
          threadId,
          () => {
            for (const sessionId of context.bridgeSessionIds) {
              this.options.emit({
                type: "session.warning",
                sessionId,
                data: {
                  error: event.error.message,
                  code: event.error.code,
                  willRetry: event.willRetry,
                },
              });
            }
          },
          { bytes: estimateOrderedEventBytes(event.error) },
        );
        return;
      }
      case "turn.completed": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        turn.complete(event.status, event.error);
        void this.runFinalization(context, turn).catch((error) => {
          console.error(
            `[codex-bridge] Failed to finalize turn ${turn.turnId}:`,
            error instanceof Error ? error.message : error,
          );
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Publish only app-server-observed model values. Thread settings confirm the
   * effective model for an accepted turn; a turn-scoped reroute wins over it.
   */
  protected applyConfirmedModel(context: ThreadContext, model: string, turnId?: string): void {
    if (!turnId) context.modelId = model;
    if (turnId) {
      context.confirmedModelsByTurn.set(turnId, model);
      for (const session of this.registry.boundSessionsForThread(context.threadId)) {
        session.confirmedModelsByTurn = {
          ...(session.confirmedModelsByTurn ?? {}),
          [turnId]: model,
        };
        void this.persistSession(session);
      }
    }
    let targets: NormalizedMessage[] = [];

    if (turnId) {
      targets = context.messages.filter(
        (message) => message.role === "assistant" && message.turnId === turnId,
      );
      if (targets.length === 0 && context.activeTurn?.turnId === turnId) {
        const active = context.messages.find(
          (message) => message.id === context.activeTurn?.assistantMessageId,
        );
        if (active) targets = [active];
      }
    } else if (context.activeTurn) {
      const active = context.messages.find(
        (message) => message.id === context.activeTurn?.assistantMessageId,
      );
      if (active) targets = [active];
    } else if (context.dispatchInFlight) {
      for (let index = context.messages.length - 1; index >= 0; index -= 1) {
        const message = context.messages[index];
        if (message?.role === "assistant") {
          targets = [message];
          break;
        }
      }
    }

    const target = targets[0];
    const targetTurnId =
      target?.turnId ??
      (target?.id === context.activeTurn?.assistantMessageId
        ? context.activeTurn?.turnId
        : undefined);
    if (!turnId && targetTurnId && context.confirmedModelsByTurn.has(targetTurnId)) {
      return;
    }
    const changed = targets.filter((message) => message.modelId !== model);
    if (changed.length === 0) return;
    const state = this.threadState.get(context.threadId);
    for (const message of changed) {
      message.modelId = model;
      message.revision = (message.revision ?? 0) + 1;
      if (state?.publishedMessageId === message.id) {
        state.publishedModelId = model;
        state.publishedParts = message.parts.slice();
      }
      const historical = state?.historicalAssistantSegments.get(message.id);
      if (historical) {
        historical.publishedModelId = model;
        historical.publishedParts = message.parts.slice();
      }
    }
    this.bumpMessageRevision(context);
    for (const message of changed) {
      for (const sessionId of context.bridgeSessionIds) {
        this.options.emit({
          type: "message.updated",
          sessionId,
          data: { message },
        });
      }
    }
  }

  /**
   * Codex rollouts record the turn-start model but not `model/rerouted`.
   * Reapply the bridge's sparse durable overlay after transcript hydration so
   * REST reads and a newly mounted tab agree with the live SSE view.
   */
  protected applyPersistedModelOverrides(context: ThreadContext): NormalizedMessage[] {
    const changed: NormalizedMessage[] = [];
    for (const message of context.messages) {
      if (message.role !== "assistant" || !message.turnId) continue;
      const model = context.confirmedModelsByTurn.get(message.turnId);
      if (!model || message.modelId === model) continue;
      message.modelId = model;
      changed.push(message);
    }
    return changed;
  }

  /**
   * A restored session can contribute a non-conflicting durable overlay after
   * another tab already hydrated the canonical transcript. Reconcile that
   * overlay immediately and publish the same revision/SSE updates as a live
   * reroute so every mounted view catches up.
   */
  protected publishPersistedModelOverrides(context: ThreadContext): void {
    const changed = this.applyPersistedModelOverrides(context);
    if (changed.length === 0) return;
    this.bumpMessageRevision(context);
    for (const message of changed) {
      for (const sessionId of context.bridgeSessionIds) {
        this.options.emit({
          type: "message.updated",
          sessionId,
          data: { message },
        });
      }
    }
  }

  protected snapshotBoundModelOverrides(threadId: string): Map<string, string> {
    return new Map(
      this.registry
        .boundSessionsForThread(threadId)
        .map((session) => [session.id, JSON.stringify(session.confirmedModelsByTurn ?? {})]),
    );
  }

  /**
   * Keep every currently attached record aligned with the canonical overlay.
   * Inactive restored sessions are intentionally left alone here: only a live
   * reroute has authority to update all bound records, while attach-time merging
   * must not let one tab's stale snapshot overwrite another inactive snapshot.
   */
  protected async synchronizeAttachedModelOverrides(
    context: ThreadContext,
    before: Map<string, string>,
  ): Promise<void> {
    const canonical = Object.fromEntries(context.confirmedModelsByTurn);
    const changed: BridgeSession[] = [];
    for (const session of this.registry.sessionsForThread(context.threadId)) {
      session.confirmedModelsByTurn =
        context.confirmedModelsByTurn.size > 0 ? { ...canonical } : undefined;
      if (
        JSON.stringify(session.confirmedModelsByTurn ?? {}) !== (before.get(session.id) ?? "{}")
      ) {
        changed.push(session);
      }
    }
    await Promise.all(changed.map((session) => this.persistSession(session)));
  }

  /**
   * Rebinds every loaded thread after a restart and brings active work back to a
   * definite state.
   *
   * For each affected thread: re-subscribe on the new child (app-server
   * subscriptions are per-connection, so without this no further notifications
   * arrive), then decide the in-flight turn's fate from *persisted* state rather
   * than guessing:
   *
   *   terminal → finalize with the real status
   *   attach   → still executing; stay running and re-bind to the new generation
   *   absent   → provably never ran, so fail it and release the request id
   */
  protected async recoverAfterGenerationChange(generation: EngineGeneration): Promise<void> {
    for (const context of this.registry.listThreads()) {
      const session = this.registry
        .sessionsForThread(context.threadId)
        .find((entry) => entry !== undefined);
      if (!session) {
        // No session can ever address this thread again, so free its state as
        // well as its registry entry. The engine handle belongs to the dead
        // generation, so there is nothing left to unsubscribe.
        this.releaseThreadRuntimeState(context.threadId);
        this.registry.removeThread(context.threadId);
        continue;
      }

      // The child that was compacting is gone, so its `thread/compacted` will
      // never arrive. Release the hold here or the thread stays busy forever.
      if (context.compacting) {
        context.compacting = false;
        this.clearCompactionBackstop(context.threadId);
      }

      const phaseBeforeRebind = context.phase;
      const errorBeforeRebind = context.error;

      try {
        // An unmaterialized thread has no rollout and cannot be resumed on the new
        // child. Clearing it makes the request path create a real replacement
        // instead of dispatching through a stale pre-restart handle.
        if (!context.materialized) {
          const sessionIds = [...context.bridgeSessionIds];
          this.releaseThreadRuntimeState(context.threadId);
          this.registry.detachThread(context.threadId);
          this.registry.clearThreadBinding(context.threadId);
          await Promise.all(
            sessionIds.map(async (sessionId) => {
              this.lastPersistedAccess.delete(sessionId);
              await this.store.remove(sessionId).catch(() => undefined);
            }),
          );
          continue;
        }

        // app-server subscriptions are connection-local. Even an idle context
        // needs thread/resume after a controlled restart before its next turn.
        const thread = await this.options.engine.resumeThread(context.threadId, {
          config: session.config,
        });
        context.engineHandle = thread.handle;
        context.cwd = thread.cwd ?? context.cwd;
        context.name = thread.name ?? context.name;
        context.modelId = thread.model ?? context.modelId;
        context.unsubscribed = false;
        context.engineGeneration = generation;

        const turn = context.activeTurn;
        if (!turn) {
          this.registry.setPhase(
            context,
            phaseBeforeRebind === "failed" ? "failed" : "idle",
            phaseBeforeRebind === "failed" ? errorBeforeRebind : undefined,
          );
          this.emitStatus(context);
          continue;
        }
        // Accept events from the replacement child for this turn.
        turn.engineGeneration = generation;

        if (!turn.requestId) {
          // Native review turns do not carry a client user-message id. Reconcile
          // them by the app-server turn id returned by review/start instead of
          // inventing an id that can never appear in the persisted rollout.
          const reviewOutcome = await this.options.engine.reconcileTurnById(
            context.threadId,
            turn.turnId,
          );
          if (reviewOutcome.result === "terminal") {
            turn.complete(reviewOutcome.status);
            await this.runFinalization(context, turn);
            continue;
          }
          if (reviewOutcome.result === "running") {
            this.registry.setPhase(context, "running");
            this.emitStatus(context);
            continue;
          }
          context.activeTurn = null;
          this.registry.setPhase(
            context,
            "failed",
            reviewOutcome.result === "absent"
              ? "Codex restarted before the native review was persisted."
              : "Codex could not reconcile the native review after restarting.",
          );
          this.emitStatus(context);
          continue;
        }

        const outcome = await this.options.engine.reconcileRequest(
          context.threadId,
          turn.requestId,
        );

        if (outcome.result === "terminal") {
          turn.complete(outcome.status ?? "completed");
          await this.runFinalization(context, turn);
          continue;
        }
        if (outcome.result === "attach") {
          if (outcome.turnId) turn.turnId = outcome.turnId;
          this.registry.setPhase(context, "running");
          this.emitStatus(context);
          continue;
        }

        // Absent: the dispatch provably did not execute. Release the request id so
        // the client may retry it, and surface a failure rather than a silent stall.
        await this.journal.forget(turn.requestId);
        context.activeTurn = null;
        this.registry.setPhase(
          context,
          "failed",
          "Codex restarted before this turn started. Send the message again.",
        );
        this.emitStatus(context);
        for (const sessionId of context.bridgeSessionIds) {
          this.options.emit({
            type: "session.error",
            sessionId,
            data: { error: "Codex restarted before this turn started. Send the message again." },
          });
        }
      } catch (error) {
        // Could not re-establish the thread at all. Report it rather than leaving
        // the session wedged in `recovering`.
        const message =
          error instanceof Error ? error.message : "Failed to recover the Codex thread";
        context.activeTurn = null;
        // The old handle belongs to a dead generation. Keep the failed context for
        // honest status reporting, but force ensureAttached to resume it before a
        // later prompt may dispatch.
        context.unsubscribed = true;
        this.registry.setPhase(context, "failed", message);
        this.emitStatus(context);
        for (const sessionId of context.bridgeSessionIds) {
          this.options.emit({ type: "session.error", sessionId, data: { error: message } });
        }
      }
    }
  }

  protected async finalizeTurn(context: ThreadContext, turn: TurnAccumulator): Promise<void> {
    const state = this.stateFor(context.threadId);
    const structuredResult = turn.expectsStructuredOutput
      ? parseCodexStructuredOutput(turn)
      : undefined;
    const structuredSessions = structuredResult
      ? [...context.bridgeSessionIds]
          .map((sessionId) => this.registry.getSession(sessionId))
          .filter(
            (session): session is BridgeSession =>
              session?.structuredOutputRequestId === turn.requestId,
          )
      : [];
    if (structuredResult && !structuredResult.ok && turn.phase === "completed") {
      turn.complete("failed", {
        message: structuredResult.error.message,
        code: structuredResult.error.code,
        retryable: structuredResult.error.retryable,
      });
    }

    // Journal the terminal state *before* rendering. The durable "this request
    // finished" record must not wait on diff computation: a duplicate arriving in
    // that window would otherwise be told the turn is still processing.
    if (turn.requestId) {
      await this.journal.markTerminal(
        turn.requestId,
        turn.phase === "interrupted"
          ? "interrupted"
          : turn.phase === "failed"
            ? "failed"
            : "completed",
        { threadId: context.threadId, turnId: turn.turnId },
      );
    }

    await state.orderedEventTail;
    await state.coalescer.flushNow();

    if (structuredResult) {
      for (const session of structuredSessions) {
        session.structuredOutput = structuredResult;
      }
      await Promise.all(structuredSessions.map((session) => this.persistSession(session)));
      for (const session of structuredSessions) {
        this.options.emit({
          type: "session.structured-output",
          sessionId: session.id,
          data: { structuredOutput: structuredResult },
        });
      }
    }

    context.activeTurn = null;
    this.registry.setPhase(
      context,
      turn.phase === "failed" ? "failed" : "idle",
      turn.error?.message,
    );
    state.assistantMessageId = undefined;
    // A terminal turn is the event a pre-restart drain is waiting for.
    this.notifyThreadActivity();

    for (const sessionId of context.bridgeSessionIds) {
      const session = this.registry.getSession(sessionId);
      if (session) this.registry.touch(sessionId);
      if (turn.phase === "failed") {
        this.options.emit({
          type: "session.error",
          sessionId,
          data: { error: turn.error?.message ?? "Codex execution failed" },
        });
        continue;
      }
      this.options.emit({
        type: "session.idle",
        sessionId,
        data: { title: session?.title, phase: context.phase },
      });
    }
  }

  protected runFinalization(context: ThreadContext, turn: TurnAccumulator): Promise<void> {
    const work = this.finalizeTurn(context, turn);
    this.pendingFinalizations.add(work);
    work.then(
      () => this.pendingFinalizations.delete(work),
      () => this.pendingFinalizations.delete(work),
    );
    return work;
  }

  /**
   * Queue an event behind the latest coalesced transcript frame. The returned
   * chain is deliberately not awaited by notification handlers: app-server's
   * stdout loop must remain independent from rendering and SSE delivery.
   */
  protected enqueueAfterMessageFlush(
    threadId: string,
    publish: () => void,
    options: { bytes?: number; coalesceKey?: "status" } = {},
  ): void {
    // Deliberately a lookup, not `stateFor`. An approval or interaction can
    // resolve *during* `detachThread`, after the runtime state was released and
    // after `engine.unsubscribeThread` was already asked for. Creating state
    // here would re-insert a render state and coalescer for a thread nothing
    // will ever release again. There is no transcript left to order behind, so
    // publish inline — exactly what `emitStatus` already does.
    const state = this.threadState.get(threadId);
    if (!state) {
      publish();
      return;
    }
    const bytes = Math.max(1, Math.ceil(options.bytes ?? 256));
    if (state.orderedReconcilePending) return;

    if (options.coalesceKey) {
      const existing = state.orderedEvents.find(
        (event) => event.coalesceKey === options.coalesceKey,
      );
      if (existing) {
        const replacementQueueBytes = state.orderedEventBytes - existing.bytes + bytes;
        if (state.orderedEventActiveBytes + replacementQueueBytes <= this.orderedEventMaxBytes()) {
          state.orderedEventBytes = replacementQueueBytes;
          existing.publish = publish;
          existing.bytes = bytes;
          return;
        }
      }
    }

    if (
      bytes > this.orderedEventMaxBytes() ||
      state.orderedEvents.length + (state.orderedEventDraining ? 2 : 1) >
        this.orderedEventMaxCount() ||
      state.orderedEventActiveBytes + state.orderedEventBytes + bytes > this.orderedEventMaxBytes()
    ) {
      this.replaceOrderedEventsWithReconcile(threadId, state);
      return;
    }

    state.orderedEvents.push({ publish, bytes, coalesceKey: options.coalesceKey });
    state.orderedEventBytes += bytes;
    this.startOrderedEventDrain(threadId, state);
  }

  protected orderedEventMaxCount(): number {
    return Math.max(1, this.options.orderedEventMaxCount ?? MAX_ORDERED_EVENTS_PER_THREAD);
  }

  protected orderedEventMaxBytes(): number {
    return Math.max(1, this.options.orderedEventMaxBytes ?? MAX_ORDERED_EVENT_BYTES_PER_THREAD);
  }

  protected replaceOrderedEventsWithReconcile(threadId: string, state: ThreadRuntimeState): void {
    state.orderedEvents.length = 0;
    state.orderedEventBytes = 0;
    state.orderedReconcilePending = true;
    this.startOrderedEventDrain(threadId, state);
  }

  protected startOrderedEventDrain(threadId: string, state: ThreadRuntimeState): void {
    if (state.orderedEventDraining) return;
    state.orderedEventDraining = true;
    state.orderedEventTail = (async () => {
      try {
        while (state.orderedReconcilePending || state.orderedEvents.length > 0) {
          if (state.orderedReconcilePending) {
            try {
              await state.coalescer.flushNow();
            } catch (error) {
              console.error(
                "[codex-bridge] Failed to flush before ordered-event reconciliation:",
                error,
              );
            }
            state.orderedReconcilePending = false;
            for (const sessionId of this.sessionIdsForThread(threadId)) {
              this.options.emit({
                type: "session.reconcile-required",
                sessionId,
                data: { reason: "ordered-event-queue-overflow" },
              });
            }
            continue;
          }
          const event = state.orderedEvents.shift()!;
          state.orderedEventBytes -= event.bytes;
          state.orderedEventActiveBytes = event.bytes;
          try {
            await state.coalescer.flushNow();
            event.publish();
          } catch (error) {
            console.error("[codex-bridge] Failed to publish ordered event:", error);
            // Approval/interaction/status state remains authoritative. Make
            // the loss explicit so clients rehydrate it instead of silently
            // trusting a stream with a hole.
            state.orderedEvents.length = 0;
            state.orderedEventBytes = 0;
            state.orderedReconcilePending = true;
          } finally {
            state.orderedEventActiveBytes = 0;
          }
        }
      } catch (error) {
        console.error("[codex-bridge] Failed to reconcile ordered events:", error);
      } finally {
        state.orderedEventDraining = false;
        if (
          (state.orderedReconcilePending || state.orderedEvents.length > 0) &&
          this.threadState.get(threadId) === state
        ) {
          this.startOrderedEventDrain(threadId, state);
        }
      }
    })();
  }

  /**
   * True when re-rendering a frozen assistant row could produce a different
   * result than the render already published for it.
   *
   * Two things can move a frozen row: one of its items mutated, or its
   * sub-agent transcript probe is due. `renderTurn` resolves everything else
   * from `completedItemParts` and the retained sub-agent map, so the output
   * would be identical.
   *
   * Note this asks "has anything changed *since the last render*", not "can
   * anything change from here". An item that completed a moment ago still owes
   * one render even though it can never move again.
   */
  protected segmentNeedsRender(
    turn: TurnAccumulator,
    segment: AssistantSegment,
    historical: HistoricalAssistantSegmentState,
  ): boolean {
    if (turn.isTerminal()) return true;
    const probedAt = historical.render.subagentProbedAt;
    if (probedAt === 0 || Date.now() - probedAt >= SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS) {
      return true;
    }
    return (
      turn.assistantSegmentVersion(segment.assistantMessageId) !== historical.renderedItemVersion
    );
  }

  /** Re-renders the streaming assistant message and publishes a sparse update. */
  protected async publishAssistantMessage(threadId: string): Promise<void> {
    const context = this.registry.getThread(threadId);
    const state = this.threadState.get(threadId);
    if (!context || !state) return;
    const turn = context.activeTurn;
    if (!turn) return;

    let snapshotChars = 0;
    for (const segment of turn.assistantSegmentsInOrder()) {
      const message = context.messages.find((entry) => entry.id === segment.assistantMessageId);
      if (!message) continue;
      const isCurrent = segment.assistantMessageId === turn.assistantMessageId;
      const historical = isCurrent
        ? undefined
        : state.historicalAssistantSegments.get(segment.assistantMessageId);
      if (!isCurrent && !historical) continue;
      const renderState = isCurrent ? state.render : historical!.render;
      const publishedParts = isCurrent ? state.publishedParts : historical!.publishedParts;
      const publishedModelId = isCurrent ? state.publishedModelId : historical!.publishedModelId;

      // A frozen row that has not moved since its last render would produce
      // byte-identical parts: every item resolves from `completedItemParts` and
      // the sub-agent map is reused verbatim. Skipping it keeps a steered turn's
      // publish tick proportional to the rows that are actually live rather than
      // re-rendering every row of the turn ~10x/second.
      if (!isCurrent && !this.segmentNeedsRender(turn, segment, historical!)) {
        snapshotChars += normalizedMessageSnapshotChars(message);
        continue;
      }

      const itemVersion = turn.assistantSegmentVersion(segment.assistantMessageId);
      const rendered = await renderTurn(turn, {
        threadId: context.threadId,
        cwd: context.cwd ?? this.options.cwd,
        state: renderState,
        segment,
        subagentProbeIntervalMs: SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS,
      });
      message.parts = rendered.parts;
      message.content = rendered.content;
      snapshotChars += normalizedMessageSnapshotChars(message);
      // Sampled before the render, so an item that mutated while it was awaited
      // still shows as pending work rather than being recorded as rendered.
      if (historical) historical.renderedItemVersion = itemVersion;

      // The identity half of this guard is what makes the first publish of any
      // assistant message a whole snapshot. Without it a path that swaps the
      // streaming message without resetting `publishedParts` emits a patch for a
      // message the client has never seen, which it can only answer by
      // refetching the entire transcript.
      if (
        (isCurrent && state.publishedMessageId !== message.id) ||
        publishedModelId !== message.modelId
      ) {
        if (isCurrent) {
          state.publishedMessageId = message.id;
          state.publishedParts = message.parts.slice();
          state.publishedModelId = message.modelId;
        } else {
          historical!.publishedParts = message.parts.slice();
          historical!.publishedModelId = message.modelId;
        }
        message.revision = (message.revision ?? 0) + 1;
        this.bumpMessageRevision(context);
        for (const sessionId of context.bridgeSessionIds) {
          this.options.emit({ type: "message.updated", sessionId, data: { message } });
        }
        continue;
      }

      const changedParts: { index: number; part: NormalizedPart }[] = [];
      for (let index = 0; index < message.parts.length; index += 1) {
        const part = message.parts[index];
        if (part && !isSamePublishedPart(publishedParts[index], part)) {
          changedParts.push({ index, part });
        }
      }
      if (changedParts.length === 0 && message.parts.length === publishedParts.length) {
        continue;
      }

      if (isCurrent) state.publishedParts = message.parts.slice();
      else historical!.publishedParts = message.parts.slice();
      message.revision = (message.revision ?? 0) + 1;
      this.bumpMessageRevision(context);
      const patch = {
        messageId: message.id,
        partCount: message.parts.length,
        changedParts,
        content: message.content,
        createdAt: message.createdAt,
        turnId: message.turnId,
        revision: message.revision,
      } satisfies MessagePatchEventData;
      for (const sessionId of context.bridgeSessionIds) {
        this.options.emit({ type: "message.patched", sessionId, data: patch });
      }
    }
    state.lastPublishedSnapshotChars = snapshotChars;
  }

  protected emitStatus(context: ThreadContext): void {
    // Every phase transition passes through here, so it is also where a drain
    // waiting on this thread finds out that it may be finished.
    this.notifyThreadActivity();
    const status = phaseToExternalStatus(context.phase);
    const phase = context.phase;
    const publish = () => {
      for (const sessionId of context.bridgeSessionIds) {
        this.options.emit({
          type: "session.updated",
          sessionId,
          data: {
            status,
            phase,
            ...(context.turnStartedAt ? { turnStartedAt: context.turnStartedAt } : {}),
          },
        });
      }
    };
    if (context.activeTurn && this.threadState.has(context.threadId)) {
      this.enqueueAfterMessageFlush(context.threadId, publish, {
        bytes: 128,
        coalesceKey: "status",
      });
    } else {
      publish();
    }
  }

  // ---------------------------------------------------------------- sessions

  protected toEngineConfig(body: Record<string, unknown>): EngineTurnConfig {
    const mode: ConversationMode = body.mode === "plan" ? "plan" : "build";
    const model =
      typeof body.model === "string" && body.model.trim().length > 0
        ? body.model.trim()
        : undefined;
    const reasoningEffort =
      typeof body.modelReasoningEffort === "string" ? body.modelReasoningEffort : undefined;
    return {
      mode,
      model,
      reasoningEffort,
      // Explicit null clears a previously set tier rather than inheriting it.
      serviceTier: body.fastMode === true ? "fast" : null,
      cwd: this.options.cwd,
      approvalPolicy: "never",
      sandbox: mode === "plan" ? "read-only" : "danger-full-access",
      networkAccessEnabled: true,
    };
  }
}
