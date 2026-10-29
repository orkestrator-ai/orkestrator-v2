import { promptThreadConfig } from "./prompt-thread-config.js";
import { codexCoordinatorPolicy, isCoordinatorReadOnlyEnvironment } from "./codex-config.js";
import {
  ThreadRuntimeState,
  MAX_PENDING_EVENTS_PER_TURN,
  MAX_PENDING_TURNS,
  MAX_ORDERED_EVENTS_PER_THREAD,
  MAX_ORDERED_EVENT_BYTES_PER_THREAD,
  estimateOrderedEventBytes,
  messageSnapshotIntervalMs,
  normalizedMessageSnapshotChars,
  DEFAULT_THREAD_IDLE_MS,
  DEFAULT_SESSION_RETENTION_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  mergeRateLimitWindows,
  mergeTurnUsage,
  mergeAccountUsage,
  accountUsageFromLimits,
  parseCodexStructuredOutput,
} from "./app-server-runtime-base.js";
import type { CodexRuntimeContext } from "./app-server-runtime-context.js";

import type {
  EngineEvent,
  EngineGeneration,
  EngineItem,
  EngineTurnConfig,
  EngineTurnStatus,
} from "./engine/types.js";
import {
  ThreadRegistry,
  phaseToExternalStatus,
  type BridgeSession,
  CODEX_RESTARTED_MID_TURN_MESSAGE,
  type ThreadAuthNotice,
  type ThreadContext,
} from "./sessions/thread-registry.js";
import { TurnAccumulator } from "./sessions/turn-accumulator.js";
import {
  isRefusedLoginError,
  nextThreadAuthNotice,
  refusedLoginNotice,
  withRefusedLoginKind,
} from "./sessions/auth-recovery-notice.js";
import { RefusedCellTail, reportsRefusal, type RefusedCell } from "./sessions/refused-cell-tail.js";
import { compareDispatchRecordsNewestFirst, DispatchJournal } from "./sessions/dispatch-journal.js";

import { createTurnRenderState, releaseTurnRenderState } from "./messages/render-turn.js";
import {
  openModelResponseRow,
  patchCommandChangePart,
  publishAssistantRows,
} from "./app-server-runtime-rows.js";
import { UpdateCoalescer } from "./messages/coalescer.js";
import { describeDiffBudget } from "./messages/diff-budget.js";
import { getTranscriptCacheStats, type TranscriptCacheStats } from "./transcript-cache.js";
import {
  createMessageId,
  type MessagePatchEventData,
  type NormalizedMessage,
  type NormalizedPart,
} from "./messages/types.js";

import {
  commandChangeCwd,
  commandChangeRole,
  commandDidNotRun,
  recordCommandChanges,
} from "./sessions/command-changes.js";
import { hasMeasuredChanges } from "@orkestrator/protocol/node/command-change-journal";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type { ConversationMode } from "./prompts/slash-commands.js";
import { hydrateMessagesFromPersistedSession } from "./history/rollout.js";
import { legacyCommandChange, type CodexEvidenceSource } from "./change-evidence.js";

import { isMissingRolloutError } from "./app-server/errors.js";

import {
  isNativeAgentExecutionPolicy,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";

/** A workflow turn's artifact-only grant (`agentMcp.artifacts.token`), when well-formed. */
function artifactConnectionToken(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const token = (value as Record<string, unknown>).token;
  return typeof token === "string" && token.length > 0 && token.length <= 1_024 ? token : undefined;
}

export { CODEX_RESTARTED_MID_TURN_MESSAGE } from "./sessions/thread-registry.js";
export { patchCommandChangePart } from "./app-server-runtime-rows.js";

export class CodexRuntimeLifecycle {
  constructor(private readonly ctx: CodexRuntimeContext) {}

  /**
   * Starts the child and loads the dispatch journal.
   *
   * The journal must be read before any prompt is accepted, or a request that was
   * in flight when the bridge died could be dispatched a second time.
   */
  async start(): Promise<void> {
    if (this.ctx.started) return;
    if (this.ctx.startPromise) return this.ctx.startPromise;
    const startPromise = this.startOnce();
    this.ctx.startPromise = startPromise;
    try {
      await startPromise;
      this.ctx.started = true;
    } finally {
      if (this.ctx.startPromise === startPromise) this.ctx.startPromise = null;
    }
  }

  async startOnce(): Promise<void> {
    await this.ctx.journal.load();
    const persistedSessions = await this.ctx.store.load();
    for (const persisted of persistedSessions) {
      this.ctx.registry.restoreSession({
        id: persisted.bridgeSessionId,
        threadId: persisted.threadId,
        config: isCoordinatorReadOnlyEnvironment(process.env)
          ? {
              ...persisted.config,
              cwd: this.ctx.options.cwd,
              approvalPolicy: "never",
              sandbox: "read-only",
              networkAccessEnabled: false,
              permissionProfile: requiredCoordinatorPermissionProfile(),
              policy: codexCoordinatorPolicy(),
            }
          : persisted.config,
        title: persisted.title,
        titleSource: persisted.titleSource,
        lastAcceptedRequestId: persisted.lastAcceptedRequestId,
        structuredOutputRequestId: persisted.structuredOutputRequestId,
        structuredOutput: persisted.structuredOutput,
        structuredOutputTurns: persisted.structuredOutputTurns,
        restartFailure: persisted.restartFailure,
        confirmedModelsByTurn: persisted.confirmedModelsByTurn,
        asyncQuestionItemIds: persisted.asyncQuestionItemIds ?? [],
        lastAccessed: Date.parse(persisted.lastAccessed),
      });
      this.ctx.lastPersistedAccess.set(
        persisted.bridgeSessionId,
        Date.parse(persisted.lastAccessed),
      );
    }
    // Claim the affected threads *before* the first await below, so a request
    // racing startup sees `recovering` rather than a misleading `idle`.
    for (const record of this.ctx.journal.unresolved()) {
      if (record.threadId) this.ctx.threadsAwaitingDispatchRecovery.add(record.threadId);
    }

    try {
      await this.ctx.options.engine.start();
      await this.ctx.generationRecovery;
      const recovery = this.recoverUnresolvedDispatches().finally(() => {
        this.ctx.threadsAwaitingDispatchRecovery.clear();
      });
      this.ctx.dispatchRecovery = recovery.catch(() => undefined);
      await recovery;
    } catch (error) {
      this.ctx.threadsAwaitingDispatchRecovery.clear();
      throw error;
    }

    const interval = this.ctx.options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (interval > 0) {
      this.ctx.sweepTimer = setInterval(() => void this.sweepIdle(), interval);
      this.ctx.sweepTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.ctx.stopping = true;
    for (const state of this.ctx.threadState.values()) state.refusedCellTail?.tail.close();
    this.ctx.resolveDispatchAdmissionStop();
    if (this.ctx.sweepTimer) clearInterval(this.ctx.sweepTimer);
    this.ctx.sweepTimer = null;
    for (const timer of this.ctx.recoveryBackstops.values()) clearTimeout(timer);
    this.ctx.recoveryBackstops.clear();
    this.ctx.commandCatalogue.dispose();
    // Nothing will report terminal after this, so release the drain rather than
    // holding shutdown for its full deadline.
    this.ctx.callbacks.notifyThreadActivity();
    // Stop the transport first so no new terminal notifications can arrive,
    // then settle work already handed off from its read loop before releasing
    // the render state that work still needs.
    await this.ctx.options.engine.stop();
    await this.drainPendingWork();
    await Promise.allSettled(this.ctx.pendingSessionWrites);
    for (const threadId of Array.from(this.ctx.threadState.keys()))
      this.releaseThreadRuntimeState(threadId);
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
    await Promise.allSettled([
      this.ctx.generationRecovery,
      this.ctx.dispatchRecovery,
      this.ctx.accountReload,
    ]);
    while (true) {
      // A finalization can schedule a coalesced render after an earlier flush,
      // so flush at the start of every pass rather than only once before
      // waiting. Otherwise shutdown (and the test harness) can observe all
      // tracked promises settled while one last snapshot is still timer-bound.
      for (const state of this.ctx.threadState.values()) {
        await state.coalescer.flushNow();
      }
      const pending = [
        ...this.ctx.pendingFinalizations,
        ...this.ctx.pendingCommandChanges,
        ...this.ctx.pendingSessionWrites,
        ...[...this.ctx.threadState.values()]
          .filter((state) => state.orderedEventDraining)
          .map((state) => state.orderedEventTail),
        ...[...this.ctx.threadState.values()].flatMap((state) => {
          const reading = state.refusedCellTail?.tail.busy();
          return reading ? [reading] : [];
        }),
      ];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  getRegistry(): ThreadRegistry {
    return this.ctx.registry;
  }

  getJournal(): DispatchJournal {
    return this.ctx.journal;
  }

  /**
   * Reconstructs live work from the durable dispatch journal before any route can
   * report a restored session idle.
   */
  async recoverUnresolvedDispatches(): Promise<void> {
    const byThread = new Map<string, ReturnType<DispatchJournal["unresolved"]>[number]>();
    for (const record of this.ctx.journal.unresolved()) {
      if (!record.threadId) {
        // The old bridge process and its child are gone. With no thread address
        // there is nothing that can still be executing, but the id must remain
        // spent because a prepared write may already have caused side effects.
        await this.ctx.journal.markTerminal(record.requestId, "failed");
        continue;
      }
      const current = byThread.get(record.threadId);
      if (!current || compareDispatchRecordsNewestFirst(record, current) < 0) {
        if (current) {
          await this.ctx.journal.markTerminal(current.requestId, "failed", {
            threadId: current.threadId ?? undefined,
            turnId: current.turnId,
          });
        }
        byThread.set(record.threadId, record);
      } else {
        await this.ctx.journal.markTerminal(record.requestId, "failed", {
          threadId: record.threadId,
          turnId: record.turnId,
        });
      }
    }

    for (const record of byThread.values()) {
      const threadId = record.threadId;
      if (!threadId) continue;
      const session =
        this.ctx.registry.getSession(record.bridgeSessionId) ??
        this.ctx.registry.listSessions().find((candidate) => candidate.threadId === threadId);
      if (!session) {
        this.ctx.threadsAwaitingDispatchRecovery.delete(threadId);
        // No bridge session is bound to this thread any more, so nothing will
        // ever rehydrate the record and it would stay unresolved — and therefore
        // exempt from retention and the cap — forever. Settling it `failed` keeps
        // the id spent (`already-done`), which is the direction that can never
        // duplicate an execution.
        await this.ctx.journal.markTerminal(record.requestId, "failed", {
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
      await this.ctx.registry
        .withDispatchLock(session, async () => {
          let context: ThreadContext | undefined;
          try {
            context = await this.ctx.callbacks.ensureAttached(session.id);
          } catch (error) {
            // Keep the record unresolved and the session non-idle. A later request or
            // process restart can retry without risking a duplicate execution.
            const existing =
              this.ctx.registry.getThread(threadId) ??
              this.ctx.registry.attach(session.id, threadId, {
                engineHandle: threadId,
                engineGeneration: this.ctx.options.engine.info().generation,
              });
            existing.materialized = true;
            existing.unsubscribed = true;
            this.ctx.registry.setPhase(existing, "recovering");
            this.emitStatus(existing);
            // Arm the escalation path. Without it this thread stays `recovering`
            // — reported as `running` — with nothing scheduled to resolve it, and
            // every later prompt 409s until an unrelated generation change.
            this.ctx.callbacks.scheduleRecoveryBackstop(existing);
            console.warn(
              `[codex-bridge] Could not restore dispatch ${record.requestId}:`,
              error instanceof Error ? error.message : error,
            );
            return;
          }

          if (!context) {
            await this.ctx.journal.markTerminal(record.requestId, "failed", {
              threadId,
              turnId: record.turnId,
            });
            return;
          }

          // The recovered turn renders from an empty accumulator, and a render
          // replaces its row's parts. Only an empty assistant row may host it:
          // a replayed row holds the interrupted turn's work up to the crash,
          // which the model still has in context, and rendering over it would
          // erase that work from the transcript.
          const lastMessage = context.messages.at(-1);
          const assistantMessage =
            lastMessage?.role === "assistant" &&
            !lastMessage.content &&
            (lastMessage.parts?.length ?? 0) === 0
              ? lastMessage
              : {
                  id: createMessageId(),
                  role: "assistant" as const,
                  content: "",
                  parts: [],
                  createdAt: new Date(this.ctx.now()).toISOString(),
                };
          if (lastMessage !== assistantMessage) {
            context.messages.push(assistantMessage);
            this.ctx.callbacks.bumpMessageRevision(context);
            // Announce the row before anything streams into it. Its updates are
            // sparse patches keyed by message id, and a patch for a message the
            // client has never seen can only be answered by refetching the whole
            // transcript.
            for (const sessionId of context.bridgeSessionIds) {
              this.ctx.options.emit({
                type: "message.updated",
                sessionId,
                data: { message: assistantMessage },
              });
            }
          }

          this.ctx.registry.setPhase(context, "recovering");
          this.emitStatus(context);
          await this.ctx.callbacks.settleAmbiguousDispatch(
            context,
            record.requestId,
            assistantMessage.id,
            {
              forgetIfAbsent: record.state === "prepared",
            },
          );
          this.emitStatus(context);
        })
        .finally(() => {
          // The thread now has a real phase, so the startup override must stop
          // applying whether the settle succeeded or threw.
          this.ctx.threadsAwaitingDispatchRecovery.delete(threadId);
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
    const idleMs = this.ctx.options.threadIdleMs ?? DEFAULT_THREAD_IDLE_MS;
    let detached = 0;

    if (idleMs > 0) {
      for (const context of this.ctx.registry.detachableThreads(idleMs)) {
        await this.detachThread(context);
        detached += 1;
      }
    }

    const retentionMs = this.ctx.options.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS;
    let forgotten = 0;
    for (const session of this.ctx.registry.expiredSessions(retentionMs)) {
      this.ctx.registry.releaseSession(session.id);
      this.ctx.lastPersistedAccess.delete(session.id);
      await this.ctx.store.remove(session.id).catch(() => undefined);
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
  async detachThread(context: ThreadContext, requireUnsubscribe = false): Promise<void> {
    if (requireUnsubscribe) {
      context.promptThreadConfig = undefined;
      await this.ctx.options.engine.unsubscribeThread(context.engineHandle, true);
    }
    const sessionIds = [...context.bridgeSessionIds];
    this.releaseThreadRuntimeState(context.threadId);

    this.ctx.registry.detachThread(context.threadId);
    if (!context.materialized) {
      this.ctx.registry.clearThreadBinding(context.threadId);
      await Promise.all(
        sessionIds.map(async (sessionId) => {
          this.ctx.lastPersistedAccess.delete(sessionId);
          await this.ctx.store.remove(sessionId).catch(() => undefined);
        }),
      );
    }

    this.ctx.detachedThreads += 1;
    if (!requireUnsubscribe) {
      await this.ctx.options.engine.unsubscribeThread(context.engineHandle).catch(() => undefined);
    }
  }

  /**
   * Frees everything this process holds for a thread.
   *
   * Must be called on *every* path that drops a thread, not just the idle sweep.
   * The render state carries the rendered diffs and sub-agent caches, and the
   * coalescer owns a live timer, so forgetting a thread without this leaks both
   * for a conversation that can never come back.
   */
  releaseThreadRuntimeState(threadId: string): void {
    const timer = this.ctx.recoveryBackstops.get(threadId);
    if (timer) {
      clearTimeout(timer);
      this.ctx.recoveryBackstops.delete(threadId);
    }
    this.ctx.callbacks.clearCompactionBackstop(threadId);
    // Every thread the bridge has ever touched used to leave a permanent entry
    // here, which the rate-limit fan-out then walked on every tick.
    this.ctx.usageByThread.delete(threadId);
    const state = this.ctx.threadState.get(threadId);
    if (!state) return;
    state.coalescer.stop();
    state.orderedEvents.length = 0;
    state.orderedEventBytes = 0;
    state.orderedReconcilePending = false;
    releaseTurnRenderState(state.render);
    state.historicalAssistantSegments.clear();
    state.releasedAssistantRows.clear();
    state.pendingEvents.clear();
    state.refusedCellTail?.tail.close();
    state.refusedCellTail = undefined;
    this.ctx.threadState.delete(threadId);
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
  async ensureAttached(sessionId: string): Promise<ThreadContext | undefined> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session || this.ctx.closingSessionIds.has(sessionId)) return undefined;

    const existing = this.ctx.registry.getThreadForSession(sessionId);
    const generation = this.ctx.options.engine.info().generation;
    if (existing && !existing.unsubscribed && existing.engineGeneration === generation) {
      // `getThreadForSession` resolves by thread id alone, with no membership
      // check. A session restored from disk onto a thread another session had
      // already attached would otherwise never join `bridgeSessionIds` — and
      // every emit path iterates that set, so the tab would receive no status,
      // no messages and no approval cards, not even for its own prompts.
      const modelsBeforeAttach = this.snapshotBoundModelOverrides(existing.threadId);
      const attached = this.ctx.registry.attach(sessionId, existing.threadId, {
        engineHandle: existing.engineHandle,
        engineGeneration: existing.engineGeneration,
        cwd: existing.cwd,
        name: existing.name,
      });
      this.publishPersistedModelOverrides(attached);
      await this.synchronizeAttachedModelOverrides(attached, modelsBeforeAttach);
      const pendingHydrate = this.ctx.transcriptHydrateInFlight.get(attached.threadId);
      if (pendingHydrate) await pendingHydrate;
      return this.ctx.registry.getSession(sessionId) === session &&
        !this.ctx.closingSessionIds.has(sessionId)
        ? attached
        : undefined;
    }
    // No thread id yet: lazy creation on first prompt, nothing to re-attach.
    if (!session.threadId) return undefined;

    const threadId = session.threadId;
    try {
      const modelsBeforeAttach = this.snapshotBoundModelOverrides(threadId);
      const config = session.config;
      const appliedConfig =
        existing && existing.engineGeneration !== generation
          ? promptThreadConfig(config)
          : existing?.promptThreadConfig;
      const thread = await this.ctx.options.engine.resumeThread(threadId, { config });
      if (
        this.ctx.registry.getSession(sessionId) !== session ||
        this.ctx.closingSessionIds.has(sessionId)
      ) {
        await this.ctx.options.engine.unsubscribeThread(thread.handle).catch(() => undefined);
        return undefined;
      }
      // Always through `attach`: it is idempotent for an existing context, and it
      // is the only thing that registers this session in `bridgeSessionIds`.
      const context = this.ctx.registry.attach(sessionId, threadId, {
        engineHandle: thread.handle,
        engineGeneration: generation,
        cwd: thread.cwd,
        name: thread.name,
        modelId: thread.model,
      });
      // A same-generation resume can rejoin a loaded thread and ignore config.
      // Preserve its known settings, or leave them unknown after a failed reload.
      context.promptThreadConfig = appliedConfig;
      context.cwd = thread.cwd ?? context.cwd;
      context.name = thread.name ?? context.name;
      // It had a rollout to resume from, so it is materialized by definition.
      context.materialized = true;
      await this.hydrateAttachedTranscript(context, session, thread);
      await this.synchronizeAttachedModelOverrides(context, modelsBeforeAttach);
      this.ctx.reattachedThreads += 1;
      return this.ctx.registry.getSession(sessionId) === session &&
        !this.ctx.closingSessionIds.has(sessionId)
        ? context
        : undefined;
    } catch (error) {
      // Only a proven missing rollout invalidates the durable binding. A
      // timeout, restart, or temporary RPC failure is ambiguous and must leave
      // the original thread id available for the next retry.
      if (isMissingRolloutError(error)) {
        const staleSessionIds = this.ctx.registry
          .listSessions()
          .filter((entry) => entry.threadId === threadId)
          .map((entry) => entry.id);
        if (existing) {
          // Same teardown as a normal detach: the render state and coalescer must
          // go with the thread, and this one is never coming back.
          this.releaseThreadRuntimeState(threadId);
          this.ctx.registry.detachThread(threadId);
          await this.ctx.options.engine
            .unsubscribeThread(existing.engineHandle)
            .catch(() => undefined);
        }
        this.ctx.registry.clearThreadBinding(threadId);
        await Promise.all(
          staleSessionIds.map(async (id) => {
            this.ctx.lastPersistedAccess.delete(id);
            await this.ctx.store.remove(id).catch(() => undefined);
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

  /**
   * Reads the rollout into an already-attached context, or confirms a live
   * thread already has its body.
   *
   * Shared so a concurrent `ensureAttached` can wait for the first hydrate
   * instead of treating the empty post-attach context as the exact transcript.
   */
  async hydrateAttachedTranscript(
    context: ThreadContext,
    session: BridgeSession,
    thread: { cwd?: string; name?: string | null },
  ): Promise<void> {
    if (context.transcriptHydrated) return;
    const existing = this.ctx.transcriptHydrateInFlight.get(context.threadId);
    if (existing) {
      await existing;
      return;
    }
    const pending = this.readAttachedTranscriptBody(context, session, thread).finally(() => {
      this.ctx.transcriptHydrateInFlight.delete(context.threadId);
    });
    this.ctx.transcriptHydrateInFlight.set(context.threadId, pending);
    await pending;
  }

  private async readAttachedTranscriptBody(
    context: ThreadContext,
    session: BridgeSession,
    thread: { cwd?: string; name?: string | null },
  ): Promise<void> {
    if (context.messages.length === 0) {
      const hydrated = await hydrateMessagesFromPersistedSession(context.threadId, {
        structuredOutputTurns: this.ctx.structuredOutputTurnsForThread(context.threadId),
      });
      // A rollout that could not be read at all is not an empty conversation:
      // leave the transcript unhydrated so readers keep reporting a cached,
      // incomplete preview (and the next attach retries) instead of an
      // authoritative empty history that would overwrite a display tail.
      if (hydrated.readFailed) return;
      context.messages = hydrated.messages;
      // Rows noted against the retained tail name nothing in the new history.
      for (const sessionId of context.bridgeSessionIds) {
        this.ctx.registry.getSession(sessionId)?.revisedRows?.clear();
      }
      this.ctx.registry.indexHydratedAsyncQuestions(context);
      this.applyPersistedModelOverrides(context);
      if (hydrated.messages.length > 0) this.ctx.callbacks.bumpMessageRevision(context);
      if (!session.title) {
        session.title = thread.name ?? hydrated.title;
        session.titleSource = thread.name ? "codex" : hydrated.titleSource;
      }
    } else {
      this.publishPersistedModelOverrides(context);
    }
    context.transcriptHydrated = true;
  }

  /** Observability for the storage budget, surfaced through /global/health. */
  getStorageStats(): {
    threads: number;
    sessions: number;
    detachedThreads: number;
    reattachedThreads: number;
    transcriptCache: TranscriptCacheStats;
    diffBudget: { cacheEntries: number };
  } {
    let cacheEntries = 0;
    for (const state of this.ctx.threadState.values()) {
      cacheEntries += describeDiffBudget(state.render.fileChange).cacheEntries;
    }
    return {
      threads: this.ctx.registry.listThreads().length,
      sessions: this.ctx.registry.listSessions().length,
      detachedThreads: this.ctx.detachedThreads,
      reattachedThreads: this.ctx.reattachedThreads,
      transcriptCache: getTranscriptCacheStats(),
      diffBudget: { cacheEntries },
    };
  }

  // ------------------------------------------------------------------ events

  stateFor(threadId: string): ThreadRuntimeState {
    let state = this.ctx.threadState.get(threadId);
    if (!state) {
      state = {
        render: createTurnRenderState(),
        historicalAssistantSegments: new Map(),
        releasedAssistantRows: new Map(),
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
            this.ctx.options.coalesceIntervalMs ??
            (() =>
              messageSnapshotIntervalMs(
                this.ctx.threadState.get(threadId)?.lastPublishedSnapshotChars ?? 0,
              )),
          publish: () => this.ctx.callbacks.publishAssistantMessage(threadId),
          onError: (error) =>
            console.error("[codex-bridge] Failed to publish message update:", error),
        }),
      };
      this.ctx.threadState.set(threadId, state);
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
  beginAssistantTurnRender(
    state: ThreadRuntimeState,
    assistantMessage: { id: string; modelId?: string },
  ): void {
    state.historicalAssistantSegments.clear();
    state.releasedAssistantRows.clear();
    state.render = createTurnRenderState();
    state.renderedRow = undefined;
    state.assistantMessageId = assistantMessage.id;
    state.publishedMessageId = assistantMessage.id;
    state.publishedParts = [];
    state.publishedModelId = assistantMessage.modelId;
  }

  onEngineEvent(event: EngineEvent): void {
    if (event.kind === "engine.state") {
      // A restart invalidates every loaded thread. Mark them recovering — never
      // idle, which would let the build pipeline advance on a lost turn.
      if (event.state === "restarting" || event.state === "failed") {
        for (const context of this.ctx.registry.markAllRecovering()) {
          this.ctx.threadState.get(context.threadId)?.refusedCellTail?.tail.close();
          this.emitStatus(context);
        }
      }
      return;
    }
    if (event.kind === "skills.changed") {
      // Constant-time mark; the catalogue coalesces the re-read off this path.
      this.ctx.projectSkillsRevision += 1;
      this.ctx.commandCatalogue.markSkillsChanged();
      return;
    }
    if (event.kind === "engine.generation") {
      // Skill bindings came from the dead child; never execute one of its paths
      // until the replacement has listed it again.
      this.ctx.commandCatalogue.withdrawGeneration(event.generation);
      // `recovering` must be transient. Left unresolved, the overlapping-turn
      // guard rejects every later prompt with a 409 and the session is bricked.
      const recovery = this.ctx.generationRecovery.then(() =>
        this.ctx.callbacks.recoverAfterGenerationChange(event.generation),
      );
      this.ctx.generationRecovery = recovery.catch((error) => {
        console.error("[codex-bridge] Generation recovery failed:", error);
      });
      return;
    }
    if (event.kind === "unknown.protocol") return;
    if (event.kind === "account.signedIn") {
      // Each thread's notice was about the login just replaced.
      for (const context of this.ctx.registry.listThreads()) {
        this.setThreadAuthNotice(context, undefined);
      }
      return;
    }
    if (event.kind === "account.loginKind") {
      // The refusal's own account read answers after the failed turn has
      // already raised the notice; name the login it was about.
      for (const context of this.ctx.registry.listThreads()) {
        this.setThreadAuthNotice(context, withRefusedLoginKind(context.authNotice, event.login));
      }
      return;
    }
    if (event.kind === "account.reload.requested") {
      void this.ctx.callbacks.reloadStoredAccountLogin().catch((error: unknown) => {
        console.warn(
          "[codex-bridge] Reloading the stored account login failed:",
          error instanceof Error ? error.message : error,
        );
      });
      return;
    }
    if (event.kind === "account.rateLimits.updated") {
      /**
       * `account/rateLimits/updated` is a **sparse rolling update**, not a
       * replacement: the generated protocol says clients must merge available
       * values into the last full snapshot, and that absent nullable metadata
       * "does not clear a previously observed value". Assigning wholesale meant
       * an update carrying only `secondary` erased the primary window, and one
       * omitting `credits` erased the balance.
       */
      this.ctx.accountRateLimits = mergeRateLimitWindows(
        this.ctx.accountRateLimits,
        event.rateLimits,
      );
      if (event.credits) {
        this.ctx.accountCredits = { ...this.ctx.accountCredits, ...event.credits };
      }
      for (const [threadId, usage] of this.ctx.usageByThread) {
        const sessionIds = this.ctx.sessionIdsForThread(threadId);
        // A thread nobody can address any more still has an entry here only until
        // its next release. Skip it rather than re-rendering a snapshot with no
        // reader on every rate-limit tick.
        if (sessionIds.length === 0) continue;
        const merged = {
          ...usage,
          rateLimits: this.ctx.accountRateLimits,
          ...(this.ctx.accountCredits ? { credits: this.ctx.accountCredits } : {}),
          account: mergeAccountUsage(
            usage.account,
            accountUsageFromLimits(this.ctx.accountRateLimits, this.ctx.accountCredits),
          ),
          updatedAt: new Date(this.ctx.now()).toISOString(),
        };
        this.ctx.usageByThread.set(threadId, merged);
        for (const sessionId of sessionIds) {
          this.ctx.options.emit({
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
    const context = this.ctx.registry.getThread(threadId);
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
      this.ctx.callbacks.finishCompaction(context);
      return;
    }
    // Thread-scoped too, and asynchronous: it reads the surviving turns, which
    // the read loop must never wait for.
    if (event.kind === "thread.reverted") {
      void this.ctx.callbacks.reconcileExternalRevert(context);
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

  bufferEvent(threadId: string, turnId: string, event: EngineEvent): void {
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
  drainPendingEvents(context: ThreadContext, turnId: string): void {
    const state = this.stateFor(context.threadId);
    const queue = state.pendingEvents.get(turnId);
    state.pendingEvents.clear();
    if (!queue) return;
    for (const event of queue) this.applyEvent(context, event);
  }

  applyEvent(context: ThreadContext, event: EngineEvent, ordered = false): void {
    const threadId = context.threadId;
    const entry = this.ctx.threadState.get(threadId)?.refusedCellTail;
    if (!ordered && entry && "turnId" in event && event.turnId === entry.turnId) {
      this.queueRefusedCellEvent(context, entry, event);
      return;
    }

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
      case "thread.authRecovery":
        this.setThreadAuthNotice(
          context,
          nextThreadAuthNotice(context.authNotice, event, () => crypto.randomUUID()),
        );
        return;
      case "turn.configuration.updated": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        for (const session of this.ctx.registry.boundSessionsForThread(threadId)) {
          // A user edit made after dispatch wins over an in-turn provider update.
          if (session.configurationRevision !== turn.configurationRevision) continue;
          session.config = { ...session.config, reasoningEffort: event.reasoningEffort };
          void this.ctx.callbacks.persistSession(session);
          this.ctx.options.emit({
            type: "session.updated",
            sessionId: session.id,
            data: { modelReasoningEffort: event.reasoningEffort },
          });
        }
        return;
      }
      case "thread.usage.updated": {
        const previous = this.ctx.usageByThread.get(threadId);
        const usage = {
          ...event.usage,
          turns: mergeTurnUsage(previous?.turns, event.usage.turns),
          ...(this.ctx.accountRateLimits.length > 0
            ? { rateLimits: this.ctx.accountRateLimits }
            : {}),
          ...(this.ctx.accountCredits ? { credits: this.ctx.accountCredits } : {}),
          account: mergeAccountUsage(
            previous?.account,
            accountUsageFromLimits(this.ctx.accountRateLimits, this.ctx.accountCredits),
          ),
        };
        this.ctx.usageByThread.set(threadId, usage);
        for (const sessionId of context.bridgeSessionIds) {
          this.ctx.options.emit({
            type: "session.updated",
            sessionId,
            data: { contextUsage: usage },
          });
        }
        return;
      }
      case "turn.started": {
        const turn = context.activeTurn;
        if (turn && turn.turnId === event.turnId) {
          turn.markRunning(event.turnId);
          this.startRefusedCellTail(context, turn);
          this.ctx.options.changeEvidence?.turn(this.evidenceSource(context, turn), "running");
        }
        return;
      }
      case "model.tool.called": {
        const turn = context.activeTurn;
        if (turn?.accepts(event)) turn.noteModelToolCall();
        return;
      }
      case "model.response.completed": {
        const turn = context.activeTurn;
        if (turn?.accepts(event)) turn.noteModelResponseCompleted();
        return;
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        this.openModelResponseRow(context, turn, event);
        const held = turn.items.get(event.item.id);
        // A late start or preview for a call that already settled says nothing new.
        const settled = held?.completed === true && !held.rawFallback;
        if (event.kind === "item.completed") {
          turn.onItemCompleted(event.item, event.completedAtMs);
          this.trackCommandChangeWindow(context, "completed", event.item);
        } else if (event.kind === "item.started") {
          turn.onItemStarted(event.item, event.startedAtMs);
          this.trackCommandChangeWindow(context, "started", event.item);
        } else turn.onItemUpdated(event.item);
        if (event.kind === "item.completed" || !settled) {
          this.ctx.options.changeEvidence?.item(
            this.evidenceSource(context, turn),
            event.kind === "item.completed"
              ? "completed"
              : event.kind === "item.started"
                ? "started"
                : "updated",
            event.item,
          );
        }
        // `item/completed` is authoritative; show it without waiting a tick.
        if (event.kind === "item.completed") void this.stateFor(threadId).coalescer.flushNow();
        else this.stateFor(threadId).coalescer.schedule(this.ctx.now());
        return;
      }
      case "item.dynamic.started": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        // This is a recovery candidate, not the authoritative app-server item.
        // Keep it off the live transcript unless its output fails, a structured
        // fileChange replaces it, or turn completion renders it as a fallback.
        turn.onDynamicToolStarted(event.item, event.startedAtMs);
        if (event.item.type === "dynamic_tool_call") {
          this.ctx.options.changeEvidence?.rawApplyPatch(
            this.evidenceSource(context, turn),
            event.item.id,
            event.item.arguments,
          );
        }
        return;
      }
      case "item.text.delta": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        this.openModelResponseRow(context, turn, event);
        turn.onTextDelta(event.itemId, event.delta);
        this.stateFor(threadId).coalescer.schedule(this.ctx.now());
        return;
      }
      case "item.reasoning.delta": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        this.openModelResponseRow(context, turn, event);
        turn.onReasoningDelta(event.itemId, event.delta, event.channel, event.index);
        this.stateFor(threadId).coalescer.schedule(this.ctx.now());
        return;
      }
      case "serverRequest.resolved": {
        // Withdraw only; never answer. app-server has the answer already, and
        // sending a second response would be answering a question it stopped
        // asking. Routed through the router because it owns the parked cards.
        this.ctx.options.engine.withdrawResolvedServerRequest(event.requestId);
        return;
      }
      case "item.progress": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        turn.onItemProgress(event.itemId, event.message);
        this.stateFor(threadId).coalescer.schedule(this.ctx.now());
        return;
      }
      case "item.command.outputDelta": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        turn.onCommandOutputDelta(event.itemId, event.delta);
        this.stateFor(threadId).coalescer.schedule(this.ctx.now());
        return;
      }
      case "item.dynamic.output": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        const failed = turn.onDynamicToolOutput(event.itemId, event.output);
        const raw = turn.items.get(event.itemId);
        if (raw?.rawFallback && raw.completed && raw.item?.type === "dynamic_tool_call") {
          this.ctx.options.changeEvidence?.rawApplyPatch(
            this.evidenceSource(context, turn),
            raw.item.id,
            raw.item.arguments,
            raw.item.status === "failed" ? "failed" : "succeeded",
          );
        }
        if (failed) void this.stateFor(threadId).coalescer.flushNow();
        return;
      }
      case "turn.diff": {
        const turn = context.activeTurn;
        if (turn && turn.accepts(event)) {
          turn.onTurnDiff(event.diff);
          // Each update is the whole cumulative diff and replaces the last.
          this.ctx.options.changeEvidence?.turnDiff(this.evidenceSource(context, turn), event.diff);
        }
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
              this.ctx.options.emit({
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
        // A turn that finished proves the login works again; one the API
        // refused for its login asks for a sign-in, which app-server's own
        // recovery never does for a key it holds as signed in.
        if (event.status === "completed") this.setThreadAuthNotice(context, undefined);
        else if (event.status === "failed" && isRefusedLoginError(event.error)) {
          this.setThreadAuthNotice(
            context,
            refusedLoginNotice(
              context.authNotice,
              this.ctx.options.engine.getAccountLoginKind(),
              () => crypto.randomUUID(),
            ),
          );
        }
        this.discardOutlivingCommandWindows(turn);
        if (turn.stoppedByShutdown && event.status === "interrupted")
          this.completeRecoveredTurn(turn, event.status);
        else {
          turn.complete(event.status, event.error);
          // A refused model fails the turn before anything streams; without
          // this it read as idle with an empty reply.
          if (event.status === "failed" && event.error) turn.recordProviderFailure(event.error);
        }
        this.ctx.options.changeEvidence?.turn(this.evidenceSource(context, turn), event.status);
        const finalize = () =>
          this.runFinalization(context, turn).catch((error) => {
            console.error(
              `[codex-bridge] Failed to finalize turn ${turn.turnId}:`,
              error instanceof Error ? error.message : error,
            );
          });
        // The last cells are read before the turn's rows are rendered for good.
        const tail = this.takeRefusedCellTail(threadId, turn);
        if (!tail) {
          void finalize();
          return;
        }
        const work = tail.finish().then(finalize, finalize);
        this.ctx.pendingFinalizations.add(work);
        void work.then(() => this.ctx.pendingFinalizations.delete(work));
        return;
      }
      default:
        return;
    }
  }

  /**
   * Follows the turn's rollout records for code-mode cells app-server reports
   * no item for, and shows them as rows (`RefusedCellTail`). Needs the rollout
   * path app-server reported for the thread; without one nothing changes.
   */
  startRefusedCellTail(context: ThreadContext, turn: TurnAccumulator): void {
    const state = this.stateFor(context.threadId);
    if (state.refusedCellTail?.turnId === turn.turnId) return;
    state.refusedCellTail?.tail.close();
    state.refusedCellTail = undefined;
    // The boundary belongs to the prompt that captured it; a turn started some
    // other way (an inline review) falls back to the bounded turn-ID scan.
    const offset = state.refusedCellOffset;
    state.refusedCellOffset = undefined;
    const path = this.ctx.options.engine.rolloutPath(context.threadId);
    if (!path) return;
    const watch = this.ctx.options.watchRolloutFile;
    const tail = new RefusedCellTail({
      path,
      turnId: turn.turnId,
      offset,
      ...(watch ? { watch } : {}),
      itemStartedBetween: (fromMs, toMs) => turn.clientToolItemStartedBetween(fromMs, toMs),
      onCell: (cell) => {
        if (
          this.ctx.stopping ||
          this.ctx.threadState.get(context.threadId) !== state ||
          context.activeTurn !== turn ||
          context.phase === "recovering" ||
          context.phase === "cancelling" ||
          context.engineGeneration !== turn.engineGeneration
        )
          return;
        // Bound cells waiting behind notification delivery as well as the disk parser.
        if (entry.cells.length < 256) entry.cells.push(cell);
        else {
          tail.close();
          for (const sessionId of context.bridgeSessionIds)
            this.ctx.options.emit({
              type: "session.reconcile-required",
              sessionId,
              data: { reason: "rollout-cell-queue-overflow" },
            });
        }
      },
    });
    const entry: NonNullable<ThreadRuntimeState["refusedCellTail"]> = {
      turnId: turn.turnId,
      tail,
      cells: [],
      events: [],
      bytes: 0,
      draining: false,
    };
    state.refusedCellTail = entry;
    void tail.poll().catch(() => undefined);
  }

  /** Disk barriers serialize only this thread; stdout continues consuming notifications. */
  queueRefusedCellEvent(
    context: ThreadContext,
    entry: NonNullable<ThreadRuntimeState["refusedCellTail"]>,
    event: EngineEvent,
  ): void {
    const bytes = estimateOrderedEventBytes(event);
    if (
      entry.events.length >= MAX_PENDING_EVENTS_PER_TURN ||
      entry.bytes + bytes > MAX_ORDERED_EVENT_BYTES_PER_THREAD
    ) {
      // Preserve every authoritative event under backpressure. Stop disk recovery,
      // apply the bounded backlog synchronously, and explicitly invalidate readers.
      entry.tail.close();
      this.ctx.threadState.get(context.threadId)!.refusedCellTail = undefined;
      for (const queued of entry.events.splice(0)) this.applyEvent(context, queued, true);
      this.applyEvent(context, event, true);
      for (const sessionId of context.bridgeSessionIds)
        this.ctx.options.emit({
          type: "session.reconcile-required",
          sessionId,
          data: { reason: "rollout-event-queue-overflow" },
        });
      return;
    }
    entry.events.push(event);
    entry.bytes += bytes;
    if (entry.draining) return;
    entry.draining = true;
    const state = this.ctx.threadState.get(context.threadId)!;
    const turn = context.activeTurn!;
    const work = (async () => {
      try {
        while (entry.events.length > 0) {
          const next = entry.events[0]!;
          const newResponse =
            ((next.kind === "item.started" || next.kind === "item.completed") &&
              (next.item.type === "reasoning" || next.item.type === "agent_message") &&
              !turn.items.has(next.item.id)) ||
            ((next.kind === "item.text.delta" || next.kind === "item.reasoning.delta") &&
              !turn.items.has(next.itemId));
          if (next.kind === "turn.completed") await entry.tail.finish();
          else if (newResponse) await entry.tail.poll().catch(() => undefined);
          if (
            this.ctx.stopping ||
            this.ctx.threadState.get(context.threadId) !== state ||
            state.refusedCellTail !== entry ||
            context.activeTurn !== turn ||
            context.phase === "recovering" ||
            context.engineGeneration !== turn.engineGeneration
          )
            return;
          if (newResponse || next.kind === "turn.completed") {
            const before =
              next.kind === "item.started"
                ? (next.startedAtMs ?? this.ctx.now())
                : next.kind === "item.completed"
                  ? (next.completedAtMs ?? this.ctx.now())
                  : this.ctx.now();
            const ready = entry.cells.filter(
              (cell) => next.kind === "turn.completed" || (cell.completedAtMs ?? 0) <= before,
            );
            entry.cells = entry.cells.filter((cell) => !ready.includes(cell));
            for (const cell of ready) this.applyRefusedCell(context, turn, cell);
          }
          entry.events.shift();
          entry.bytes -= estimateOrderedEventBytes(next);
          this.applyEvent(context, next, true);
        }
      } finally {
        entry.draining = false;
      }
    })();
    this.ctx.pendingFinalizations.add(work);
    void work.catch(() => undefined).finally(() => this.ctx.pendingFinalizations.delete(work));
  }

  /** Detaches the turn's tail so its last read can run before finalization. */
  takeRefusedCellTail(threadId: string, turn: TurnAccumulator): RefusedCellTail | undefined {
    const state = this.ctx.threadState.get(threadId);
    const entry = state?.refusedCellTail;
    if (!state || !entry) return undefined;
    state.refusedCellTail = undefined;
    if (entry.turnId === turn.turnId) return entry.tail;
    entry.tail.close();
    return undefined;
  }

  /**
   * Shows a recovered cell as the item app-server never sent: a completed
   * dynamic tool call, rendered like the `exec` row a reload builds from the
   * same rollout record. Failed when the model was told of a refusal.
   */
  applyRefusedCell(context: ThreadContext, turn: TurnAccumulator, cell: RefusedCell): void {
    if (
      this.ctx.stopping ||
      context.activeTurn !== turn ||
      !this.ctx.threadState.has(context.threadId) ||
      context.phase === "recovering" ||
      context.phase === "cancelling" ||
      context.engineGeneration !== turn.engineGeneration
    )
      return;
    if (
      !reportsRefusal(cell.output) &&
      cell.startedAtMs !== undefined &&
      cell.completedAtMs !== undefined &&
      turn.clientToolItemStartedBetween(cell.startedAtMs, cell.completedAtMs)
    )
      return;
    const duration =
      cell.startedAtMs !== undefined && cell.completedAtMs !== undefined
        ? Math.max(0, Math.round(cell.completedAtMs - cell.startedAtMs))
        : undefined;
    this.applyEvent(
      context,
      {
        kind: "item.completed",
        threadId: context.threadId,
        turnId: turn.turnId,
        item: {
          id: cell.callId,
          type: "dynamic_tool_call",
          tool: "exec",
          arguments: cell.source,
          content_items: cell.output ? [{ type: "inputText", text: cell.output }] : [],
          status: cell.failed ? "failed" : "completed",
          ...(duration === undefined ? {} : { duration_ms: duration }),
        },
        ...(cell.completedAtMs === undefined ? {} : { completedAtMs: cell.completedAtMs }),
        engineGeneration: turn.engineGeneration,
      },
      true,
    );
  }

  /** Gives the next model response a row of its own (see `openModelResponseRow`). */
  openModelResponseRow(context: ThreadContext, turn: TurnAccumulator, event: EngineEvent): void {
    const state = this.stateFor(context.threadId);
    if (openModelResponseRow(context, state, turn, event, this.ctx.now())) {
      this.ctx.callbacks.bumpMessageRevision(context);
    }
  }

  /**
   * Take the "before" snapshot for a turn's commands.
   *
   * app-server reports a command only once it is running, so its window opens
   * on the repository's latest snapshot rather than one of its own; priming
   * here, before the turn is dispatched, keeps edits made between turns (by
   * the user, or another tool) from being charged to the turn's first command.
   * Dispatch waits for this baseline so a fast first command cannot race it.
   */
  async primeCommandChanges(context: ThreadContext): Promise<void> {
    const probe = this.ctx.options.commandChangeProbe;
    if (!probe) return;
    await probe.prime(context.cwd ?? this.ctx.options.cwd).catch(() => undefined);
  }

  /**
   * Open or close a measurement window as a command (or an edit it must know
   * about) starts and completes.
   *
   * Runs on the notification path, so it only *starts* the probe's work: the
   * "after" snapshot and everything that follows run detached and are tracked
   * in `pendingCommandChanges`, never awaited here.
   */
  trackCommandChangeWindow(
    context: ThreadContext,
    phase: "started" | "completed",
    item: EngineItem,
  ): void {
    const probe = this.ctx.options.commandChangeProbe;
    if (!probe) return;
    const role = commandChangeRole(item);
    if (!role) return;

    if (phase === "started") {
      // A duplicate `item/started` after the call settled would open a window
      // nothing is left to close.
      if (context.activeTurn?.items.get(item.id)?.completed) return;
      const cwd = commandChangeCwd(item, context.cwd ?? this.ctx.options.cwd);
      const opening =
        role === "measure"
          ? probe.begin(cwd, item.id, { baseline: true })
          : probe.note(cwd, item.id);
      void opening.catch(() => undefined);
      return;
    }

    if (role === "measure" && commandDidNotRun(item)) {
      // Nothing ran, so there is no window to report.
      probe.discard(item.id);
      return;
    }
    const threadId = context.threadId;
    const source = context.activeTurn
      ? this.evidenceSource(context, context.activeTurn)
      : undefined;
    this.trackCommandChangeWork(
      probe.endObservation(item.id).then((observation) => {
        if (role !== "measure" || !observation) return;
        // Reported as observed; the backend decides what the window measures.
        if (source) this.ctx.options.changeEvidence?.observation(source, item.id, observation);
        const change = legacyCommandChange(observation);
        if (change) this.applyCommandChanges(threadId, item.id, change);
      }),
    );
  }

  /** Who a thread's evidence belongs to: every session bound to it, this turn. */
  evidenceSource(context: ThreadContext, turn: TurnAccumulator): CodexEvidenceSource {
    return { sessionIds: [...context.bridgeSessionIds], turnId: turn.turnId };
  }

  /**
   * A command still running when its turn completes is a background process —
   * a server or watcher unified exec left behind. Its window would span
   * everything after it, so it is dropped rather than measured.
   */
  discardOutlivingCommandWindows(turn: TurnAccumulator): void {
    const probe = this.ctx.options.commandChangeProbe;
    if (!probe) return;
    for (const accumulator of turn.items.values()) {
      if (!accumulator.completed && accumulator.item?.type === "command_execution") {
        probe.discard(accumulator.id);
      }
    }
  }

  trackCommandChangeWork(work: Promise<void>): void {
    const tracked = work.catch((error) => {
      console.error(
        "[codex-bridge] Failed to record a command's line changes:",
        error instanceof Error ? error.message : error,
      );
    });
    this.ctx.pendingCommandChanges.add(tracked);
    void tracked.finally(() => this.ctx.pendingCommandChanges.delete(tracked));
  }

  /**
   * Put a command's measured change on its row and journal it.
   *
   * While the command's turn is still streaming, the measurement goes onto the
   * item's accumulator and the next coalesced render carries it (the render
   * cache is keyed on it). Once the turn has settled nothing renders it again,
   * so the stored row is patched in place and published directly.
   *
   * A turn that has completed but not finished finalizing is between the two:
   * its final render may or may not still be to come. Patching the row then
   * would race that render for the message's next revision, and a client that
   * sees them out of order has to refetch the transcript. So the change goes
   * onto the accumulator for a render still to come, and the stored row is
   * only patched once finalization is over — a no-op if that render took it.
   */
  applyCommandChanges(threadId: string, itemId: string, change: MeasuredWorkspaceChange): void {
    if (!hasMeasuredChanges(change)) return;
    this.trackCommandChangeWork(
      recordCommandChanges(this.ctx.options.codexHome, threadId, itemId, change),
    );
    // A detached thread has no live transcript; its next hydrate reads the
    // journal written above.
    const context = this.ctx.registry.getThread(threadId);
    if (!context) return;
    const turn = context.activeTurn;
    const accumulated = turn?.onCommandChanges(itemId, change) ?? false;
    if (accumulated && !turn!.isTerminal()) {
      // The next publish renders the row holding the command, tracking it
      // again if it was past the bound (`app-server-runtime-rows.ts`).
      this.stateFor(threadId).coalescer.schedule(this.ctx.now());
      return;
    }
    if (accumulated) {
      this.trackCommandChangeWork(
        Promise.allSettled(this.ctx.pendingFinalizations).then(() => {
          const current = this.ctx.registry.getThread(threadId);
          if (current) this.patchSettledCommandChanges(current, itemId, change);
        }),
      );
      return;
    }
    this.patchSettledCommandChanges(context, itemId, change);
  }

  patchSettledCommandChanges(
    context: ThreadContext,
    itemId: string,
    change: MeasuredWorkspaceChange,
  ): void {
    // A call's rows live in one message, and a late measurement is almost
    // always for one of the newest.
    let message: NormalizedMessage | undefined;
    const changedParts: { index: number; part: NormalizedPart }[] = [];
    for (let index = context.messages.length - 1; index >= 0 && !message; index -= 1) {
      const candidate = context.messages[index]!;
      if (candidate.role !== "assistant") continue;
      for (const [partIndex, part] of candidate.parts.entries()) {
        const updated = patchCommandChangePart(part, itemId, change);
        if (updated !== part) changedParts.push({ index: partIndex, part: updated });
      }
      if (changedParts.length > 0) message = candidate;
    }
    if (!message) return;

    const parts = message.parts.slice();
    for (const { index, part } of changedParts) parts[index] = part;
    message.parts = parts;
    // A message whose revision the client never received (one hydrated from
    // the rollout) cannot take a sparse patch; it is replaced whole instead.
    const patchable = Number.isInteger(message.revision);
    message.revision = (message.revision ?? 0) + 1;
    const state = this.ctx.threadState.get(context.threadId);
    if (state?.publishedMessageId === message.id) state.publishedParts = message.parts.slice();
    const historical = state?.historicalAssistantSegments.get(message.id);
    if (historical) historical.publishedParts = message.parts.slice();
    // Noted now, with the bump: the send below waits for the coalesced flush
    // and can be dropped by an ordered-event overflow.
    this.ctx.callbacks.bumpMessageRevision(context, [message]);

    const target = message;
    const patch = {
      messageId: target.id,
      partCount: target.parts.length,
      changedParts,
      content: target.content,
      createdAt: target.createdAt,
      turnId: target.turnId,
      revision: target.revision!,
    } satisfies MessagePatchEventData;
    this.enqueueAfterMessageFlush(
      context.threadId,
      () => {
        for (const sessionId of context.bridgeSessionIds) {
          this.ctx.options.emit(
            patchable
              ? { type: "message.patched", sessionId, data: patch }
              : { type: "message.updated", sessionId, data: { message: target } },
          );
        }
      },
      {
        bytes: patchable
          ? estimateOrderedEventBytes(changedParts)
          : normalizedMessageSnapshotChars(target) * 2,
      },
    );
  }

  /** Replace the thread's `auth` notice and tell every session bound to it. */
  setThreadAuthNotice(context: ThreadContext, notice: ThreadAuthNotice | undefined): void {
    if (context.authNotice === notice) return;
    context.authNotice = notice;
    for (const session of this.ctx.registry.boundSessionsForThread(context.threadId)) {
      this.ctx.options.emit({
        type: "session.updated",
        sessionId: session.id,
        data: { authNotice: notice ?? null },
      });
    }
  }

  /**
   * Publish only app-server-observed model values. Thread settings confirm the
   * effective model for an accepted turn; a turn-scoped reroute wins over it.
   */
  applyConfirmedModel(context: ThreadContext, model: string, turnId?: string): void {
    if (!turnId) context.modelId = model;
    if (turnId) {
      context.confirmedModelsByTurn.set(turnId, model);
      for (const session of this.ctx.registry.boundSessionsForThread(context.threadId)) {
        session.confirmedModelsByTurn = {
          ...session.confirmedModelsByTurn,
          [turnId]: model,
        };
        void this.ctx.callbacks.persistSession(session);
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
    const state = this.ctx.threadState.get(context.threadId);
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
        historical.announced = true;
      }
    }
    this.ctx.callbacks.bumpMessageRevision(context, changed);
    for (const message of changed) {
      for (const sessionId of context.bridgeSessionIds) {
        this.ctx.options.emit({
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
  applyPersistedModelOverrides(context: ThreadContext): NormalizedMessage[] {
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
  publishPersistedModelOverrides(context: ThreadContext): void {
    const changed = this.applyPersistedModelOverrides(context);
    if (changed.length === 0) return;
    this.ctx.callbacks.bumpMessageRevision(context, changed);
    for (const message of changed) {
      for (const sessionId of context.bridgeSessionIds) {
        this.ctx.options.emit({
          type: "message.updated",
          sessionId,
          data: { message },
        });
      }
    }
  }

  snapshotBoundModelOverrides(threadId: string): Map<string, string> {
    return new Map(
      this.ctx.registry
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
  async synchronizeAttachedModelOverrides(
    context: ThreadContext,
    before: Map<string, string>,
  ): Promise<void> {
    const canonical = Object.fromEntries(context.confirmedModelsByTurn);
    const changed: BridgeSession[] = [];
    for (const session of this.ctx.registry.sessionsForThread(context.threadId)) {
      session.confirmedModelsByTurn =
        context.confirmedModelsByTurn.size > 0 ? { ...canonical } : undefined;
      if (
        JSON.stringify(session.confirmedModelsByTurn ?? {}) !== (before.get(session.id) ?? "{}")
      ) {
        changed.push(session);
      }
    }
    await Promise.all(changed.map((session) => this.ctx.callbacks.persistSession(session)));
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
  async recoverAfterGenerationChange(generation: EngineGeneration): Promise<void> {
    for (const context of this.ctx.registry.listThreads()) {
      const session = this.ctx.registry
        .sessionsForThread(context.threadId)
        .find((entry) => entry !== undefined);
      if (!session) {
        // No session can ever address this thread again, so free its state as
        // well as its registry entry. The engine handle belongs to the dead
        // generation, so there is nothing left to unsubscribe.
        this.releaseThreadRuntimeState(context.threadId);
        this.ctx.registry.removeThread(context.threadId);
        continue;
      }

      // The child that was compacting is gone, so its `thread/compacted` will
      // never arrive. Release the hold here or the thread stays busy forever.
      if (context.compacting) {
        context.compacting = false;
        this.ctx.callbacks.clearCompactionBackstop(context.threadId);
      }

      const phaseBeforeRebind = context.phase;
      const errorBeforeRebind = context.error;
      const turn = context.activeTurn;

      try {
        // An unmaterialized thread has no rollout and cannot be resumed on the new
        // child. Clearing it makes the request path create a real replacement
        // instead of dispatching through a stale pre-restart handle.
        if (!context.materialized) {
          const sessionIds = [...context.bridgeSessionIds];
          this.releaseThreadRuntimeState(context.threadId);
          this.ctx.registry.detachThread(context.threadId);
          this.ctx.registry.clearThreadBinding(context.threadId);
          await Promise.all(
            sessionIds.map(async (sessionId) => {
              this.ctx.lastPersistedAccess.delete(sessionId);
              await this.ctx.store.remove(sessionId).catch(() => undefined);
            }),
          );
          continue;
        }

        // app-server subscriptions are connection-local. Even an idle context
        // needs thread/resume after a controlled restart before its next turn.
        const config = session.config;
        const thread = await this.ctx.options.engine.resumeThread(context.threadId, { config });
        context.promptThreadConfig = promptThreadConfig(config);
        context.engineHandle = thread.handle;
        context.cwd = thread.cwd ?? context.cwd;
        context.name = thread.name ?? context.name;
        context.modelId = thread.model ?? context.modelId;
        context.unsubscribed = false;
        context.engineGeneration = generation;

        if (!turn) {
          this.ctx.registry.setPhase(
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
          const reviewOutcome = await this.ctx.options.engine.reconcileTurnById(
            context.threadId,
            turn.turnId,
          );
          if (reviewOutcome.result === "terminal") {
            this.completeRecoveredTurn(turn, reviewOutcome.status);
            await this.runFinalization(context, turn);
            continue;
          }
          if (reviewOutcome.result === "running") {
            this.ctx.registry.setPhase(context, "running");
            this.emitStatus(context);
            continue;
          }
          context.activeTurn = null;
          this.ctx.registry.setPhase(
            context,
            "failed",
            reviewOutcome.result === "absent"
              ? "Codex restarted before the native review was persisted."
              : "Codex could not reconcile the native review after restarting.",
          );
          this.emitStatus(context);
          continue;
        }

        const outcome = await this.ctx.options.engine.reconcileRequest(
          context.threadId,
          turn.requestId,
        );

        if (outcome.result === "terminal") {
          this.completeRecoveredTurn(turn, outcome.status ?? "completed");
          await this.runFinalization(context, turn);
          continue;
        }
        if (outcome.result === "attach") {
          if (outcome.turnId) turn.turnId = outcome.turnId;
          this.ctx.registry.setPhase(context, "running");
          this.emitStatus(context);
          continue;
        }

        // Absent: the dispatch provably did not execute. Release the request id so
        // the client may retry it, and surface a failure rather than a silent stall.
        await this.ctx.journal.forget(turn.requestId);
        context.activeTurn = null;
        this.ctx.registry.setPhase(
          context,
          "failed",
          "Codex restarted before this turn started. Send the message again.",
        );
        this.emitStatus(context);
        for (const sessionId of context.bridgeSessionIds) {
          this.ctx.options.emit({
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
        // The old handle belongs to a dead generation. Keep the failed context for
        // honest status reporting, but force ensureAttached to resume it before a
        // later prompt may dispatch.
        context.unsubscribed = true;
        if (turn) {
          turn.complete("failed", { message, retryable: true });
          await this.runFinalization(context, turn);
        } else {
          this.ctx.registry.setPhase(context, "failed", message);
          this.emitStatus(context);
          for (const sessionId of context.bridgeSessionIds) {
            this.ctx.options.emit({ type: "session.error", sessionId, data: { error: message } });
          }
        }
      }
    }
  }

  /**
   * Settles a turn the replacement child reports as already terminal.
   *
   * app-server persists a turn its dead predecessor never finished as
   * `interrupted`. Unless the user asked for that, it was the restart that
   * stopped the work, and finalizing it as an ordinary interruption settles the
   * session to idle with no error: the transcript simply ends mid-task and reads
   * as done. Surface it as a failure so the user knows to continue.
   */
  completeRecoveredTurn(turn: TurnAccumulator, status: EngineTurnStatus): void {
    if (status === "interrupted" && !turn.cancelRequested) {
      turn.complete("failed", {
        message: CODEX_RESTARTED_MID_TURN_MESSAGE,
        code: "app-server-restarted",
      });
      return;
    }
    turn.complete(status);
  }

  async finalizeTurn(context: ThreadContext, turn: TurnAccumulator): Promise<void> {
    const state = this.stateFor(context.threadId);
    const structuredResult = turn.expectsStructuredOutput
      ? parseCodexStructuredOutput(turn)
      : undefined;
    const structuredSessions = structuredResult
      ? [...context.bridgeSessionIds]
          .map((sessionId) => this.ctx.registry.getSession(sessionId))
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
    const structuredLedgerSessions = turn.expectsStructuredOutput
      ? this.ctx.registry.recordStructuredOutputTurn(
          context.threadId,
          turn.turnId,
          structuredResult?.ok === true && turn.phase === "completed",
        )
      : [];
    const restartNoticeSessions = this.ctx.registry
      .boundSessionsForThread(context.threadId)
      .filter((session) => {
        if (turn.error?.code !== "app-server-restarted") return false;
        session.restartFailure = { turnId: turn.turnId };
        return true;
      });

    // Journal the terminal state *before* rendering. The durable "this request
    // finished" record must not wait on diff computation: a duplicate arriving in
    // that window would otherwise be told the turn is still processing.
    if (turn.requestId) {
      await this.ctx.journal.markTerminal(
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
      await Promise.all(
        [
          ...new Set([
            ...structuredSessions,
            ...structuredLedgerSessions,
            ...restartNoticeSessions,
          ]),
        ].map((session) => this.ctx.callbacks.persistSession(session)),
      );
      for (const session of structuredSessions) {
        this.ctx.options.emit({
          type: "session.structured-output",
          sessionId: session.id,
          data: { structuredOutput: structuredResult },
        });
      }
    }
    if (!structuredResult) {
      await Promise.all(
        restartNoticeSessions.map((session) => this.ctx.callbacks.persistSession(session)),
      );
    }

    context.activeTurn = null;
    this.ctx.registry.setPhase(
      context,
      turn.phase === "failed" ? "failed" : "idle",
      turn.error?.message,
    );
    state.assistantMessageId = undefined;
    // A terminal turn is the event a pre-restart drain is waiting for.
    this.ctx.callbacks.notifyThreadActivity();

    for (const sessionId of context.bridgeSessionIds) {
      const session = this.ctx.registry.getSession(sessionId);
      if (session) this.ctx.registry.touch(sessionId);
      if (turn.phase === "failed") {
        this.ctx.options.emit({
          type: "session.error",
          sessionId,
          data: { error: turn.error?.message ?? "Codex execution failed" },
        });
        continue;
      }
      this.ctx.options.emit({
        type: "session.idle",
        sessionId,
        data: { title: session?.title, phase: context.phase },
      });
    }
  }

  runFinalization(context: ThreadContext, turn: TurnAccumulator): Promise<void> {
    // A turn settled by recovery rather than `turn/completed` stops its tail here.
    this.takeRefusedCellTail(context.threadId, turn)?.close();
    const work = this.ctx.callbacks.finalizeTurn(context, turn);
    this.ctx.pendingFinalizations.add(work);
    work.then(
      () => this.ctx.pendingFinalizations.delete(work),
      () => this.ctx.pendingFinalizations.delete(work),
    );
    return work;
  }

  /**
   * Queue an event behind the latest coalesced transcript frame. The returned
   * chain is deliberately not awaited by notification handlers: app-server's
   * stdout loop must remain independent from rendering and SSE delivery.
   */
  enqueueAfterMessageFlush(
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
    const state = this.ctx.threadState.get(threadId);
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

  orderedEventMaxCount(): number {
    return Math.max(1, this.ctx.options.orderedEventMaxCount ?? MAX_ORDERED_EVENTS_PER_THREAD);
  }

  orderedEventMaxBytes(): number {
    return Math.max(1, this.ctx.options.orderedEventMaxBytes ?? MAX_ORDERED_EVENT_BYTES_PER_THREAD);
  }

  replaceOrderedEventsWithReconcile(threadId: string, state: ThreadRuntimeState): void {
    state.orderedEvents.length = 0;
    state.orderedEventBytes = 0;
    state.orderedReconcilePending = true;
    this.startOrderedEventDrain(threadId, state);
  }

  startOrderedEventDrain(threadId: string, state: ThreadRuntimeState): void {
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
            for (const sessionId of this.ctx.sessionIdsForThread(threadId)) {
              this.ctx.options.emit({
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
          this.ctx.threadState.get(threadId) === state
        ) {
          this.startOrderedEventDrain(threadId, state);
        }
      }
    })();
  }

  /** Re-renders the active turn's assistant rows and publishes sparse updates. */
  async publishAssistantMessage(threadId: string): Promise<void> {
    const context = this.ctx.registry.getThread(threadId);
    const state = this.ctx.threadState.get(threadId);
    if (!context || !state) return;
    const turn = context.activeTurn;
    if (!turn) return;
    await publishAssistantRows(context, state, turn, {
      cwd: context.cwd ?? this.ctx.options.cwd,
      emit: (event) => this.ctx.options.emit(event),
      bumpMessageRevision: (target, revised) =>
        this.ctx.callbacks.bumpMessageRevision(target, revised),
      onRendered: (message) => {
        if (!this.ctx.registry.recordAsyncQuestionMessages(context, message)) return;
        for (const sessionId of context.bridgeSessionIds) {
          const session = this.ctx.registry.getSession(sessionId);
          if (session) void this.ctx.callbacks.persistSession(session);
        }
      },
    });
  }

  emitStatus(context: ThreadContext): void {
    // Every phase transition passes through here, so it is also where a drain
    // waiting on this thread finds out that it may be finished.
    this.ctx.callbacks.notifyThreadActivity();
    const status = phaseToExternalStatus(context.phase);
    const phase = context.phase;
    const publish = () => {
      for (const sessionId of context.bridgeSessionIds) {
        this.ctx.options.emit({
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
    if (context.activeTurn && this.ctx.threadState.has(context.threadId)) {
      this.enqueueAfterMessageFlush(context.threadId, publish, {
        bytes: 128,
        coalesceKey: "status",
      });
    } else {
      publish();
    }
  }

  // ---------------------------------------------------------------- sessions

  toEngineConfig(body: Record<string, unknown>): EngineTurnConfig {
    const mode: ConversationMode = body.mode === "plan" ? "plan" : "build";
    const coordinatorReadOnly = isCoordinatorReadOnlyEnvironment(process.env);
    const requestedPolicy = isNativeAgentExecutionPolicy(body.policy) ? body.policy : undefined;
    const policy: NativeAgentExecutionPolicy | undefined = coordinatorReadOnly
      ? codexCoordinatorPolicy()
      : requestedPolicy;
    const model =
      typeof body.model === "string" && body.model.trim().length > 0
        ? body.model.trim()
        : undefined;
    const reasoningEffort =
      typeof body.modelReasoningEffort === "string" ? body.modelReasoningEffort : undefined;
    const rawAgentMcp = body.agentMcp;
    let agentMcp: EngineTurnConfig["agentMcp"];
    if (rawAgentMcp && typeof rawAgentMcp === "object" && !Array.isArray(rawAgentMcp)) {
      const candidate = rawAgentMcp as Record<string, unknown>;
      if (
        typeof candidate.url === "string" &&
        typeof candidate.token === "string" &&
        candidate.token.length > 0 &&
        candidate.token.length <= 1_024
      ) {
        try {
          const url = new URL(candidate.url);
          if (
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname) &&
            url.pathname === "/mcp" &&
            !url.username &&
            !url.password
          ) {
            const artifacts = artifactConnectionToken(candidate.artifacts);
            agentMcp = {
              url: url.toString(),
              token: candidate.token,
              ...(candidate.design === true ? { design: true } : {}),
              ...(artifacts ? { artifacts: { token: artifacts } } : {}),
            };
          }
        } catch {
          // Ignore malformed injected configuration; process-level MCP remains available.
        }
      }
    }
    return {
      mode,
      model,
      reasoningEffort,
      // Explicit null clears a previously set tier rather than inheriting it.
      serviceTier: body.fastMode === true ? "fast" : null,
      cwd: this.ctx.options.cwd,
      approvalPolicy:
        policy?.approvals === "ask"
          ? "on-request"
          : policy?.approvals === "deny"
            ? "never"
            : "never",
      // A coordinator policy is process authority supplied by the trusted
      // backend launcher. It is deliberately independent of conversation mode
      // and re-applied for create, resume, config updates, forks and every turn.
      sandbox:
        coordinatorReadOnly || mode === "plan" || policy?.approvals === "deny"
          ? "read-only"
          : policy?.sandbox === "provider"
            ? "workspace-write"
            : "danger-full-access",
      networkAccessEnabled: policy ? policy.networkAccess === "full" : true,
      ...(policy ? { policy } : {}),
      ...(agentMcp ? { agentMcp } : {}),
      ...(coordinatorReadOnly ? { permissionProfile: requiredCoordinatorPermissionProfile() } : {}),
    };
  }
}

function requiredCoordinatorPermissionProfile(): string {
  const profile = process.env.CODEX_BRIDGE_PERMISSION_PROFILE?.trim();
  if (!profile || !/^[A-Za-z0-9_-]+$/.test(profile)) {
    throw new Error("Coordinator Codex permission profile is unavailable");
  }
  return profile;
}
