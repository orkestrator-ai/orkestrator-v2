/**
 * The app-server engine's implementation of the bridge's session surface.
 *
 * `index.ts` owns HTTP routing, SSE fan-out and the composition root; every
 * session route delegates here.
 *
 * What this owns:
 *   - the canonical thread registry (two tabs on one thread share a transcript)
 *   - at-most-once prompt dispatch and ambiguous-dispatch reconciliation
 *   - the interrupt lifecycle (`cancelling` until a terminal turn arrives)
 *   - coalesced UI snapshots
 *   - history and models, with the rollout parser and model cache as fallbacks
 */
import type { AppServerEngine } from "./engine/app-server-engine.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolution,
} from "./app-server/approvals.js";
import type {
  EngineEvent,
  EngineGeneration,
  EngineThread,
  EngineTurnConfig,
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
import { TurnAccumulator } from "./sessions/turn-accumulator.js";
import { DispatchJournal } from "./sessions/dispatch-journal.js";
import { BridgeSessionStore } from "./sessions/persistence.js";
import {
  beginTurnRenderState,
  createTurnRenderState,
  releaseTurnRenderState,
  renderTurn,
  type TurnRenderState,
} from "./messages/render-turn.js";
import { UpdateCoalescer } from "./messages/coalescer.js";
import { describeDiffBudget } from "./messages/diff-budget.js";
import { getTranscriptCacheStats } from "./transcript-cache.js";
import {
  createMessageId,
  createSessionId,
  type NormalizedMessage,
  type NormalizedPart,
} from "./messages/types.js";
import {
  buildPromptInput,
  expandPromptTemplate,
  getAvailableSlashCommandDefinitions,
  isCodexCliNativeSlashCommand,
  parseSlashCommandPrompt,
  wrapPromptForConversationMode,
  type ConversationMode,
  type PromptSlashCommand,
} from "./prompts/slash-commands.js";
import {
  getWorkingDirectory,
  hydrateMessagesFromPersistedSession,
  listPersistedSessionsForCwd,
  type PersistedSessionMeta,
} from "./history/rollout.js";
import {
  buildFallbackSessionTitle,
  persistSessionTitle,
  readPersistedSessionTitleEntries,
  type PersistedSessionTitleSource,
} from "./session-titles.js";
import { isMissingRolloutError } from "./app-server/errors.js";
import type { BridgeModel } from "./models-cache.js";

export interface RuntimeSseEvent {
  type:
    | "session.updated"
    | "session.idle"
    | "session.error"
    | "session.title-updated"
    | "message.updated"
    /** Codex is blocked on a human decision. */
    | "session.approval-requested"
    /** The approval is no longer actionable — answered, expired or withdrawn. */
    | "session.approval-resolved";
  sessionId?: string;
  data?: Record<string, unknown>;
}

export interface AppServerRuntimeOptions {
  engine: AppServerEngine;
  codexHome: string;
  cwd: string;
  emit: (event: RuntimeSseEvent) => void;
  /** Reuses the bridge's persisted model cache and fallback catalog. */
  loadCachedModels: () => Promise<{ models: BridgeModel[]; source: "cache" | "fallback" }>;
  persistModels?: (models: BridgeModel[]) => Promise<void>;
  generateTitle?: (prompt: string) => Promise<string>;
  coalesceIntervalMs?: number;
  now?: () => number;
  /** Detach a thread after this long untouched. 0 disables detaching. */
  threadIdleMs?: number;
  /** Forget a detached bridge session id after this long. */
  sessionRetentionMs?: number;
  /** How often the idle sweep runs. 0 disables the timer (tests drive it). */
  sweepIntervalMs?: number;
}

interface ThreadRuntimeState {
  render: TurnRenderState;
  coalescer: UpdateCoalescer;
  /** Assistant message currently being streamed into. */
  assistantMessageId?: string;
  /**
   * Events that arrived before the turn they belong to was registered.
   *
   * app-server may emit `turn/started`, deltas and even `turn/completed` before
   * the `turn/start` *response* is read — the notification and the response race
   * on separate paths. Dropping them would silently lose a whole fast turn, so
   * they are parked by turn id and replayed once the accumulator exists.
   */
  pendingEvents: Map<string, EngineEvent[]>;
}

/** Bounds the pre-registration buffer so a misbehaving peer cannot grow it. */
const MAX_PENDING_EVENTS_PER_TURN = 2_000;
const MAX_PENDING_TURNS = 8;

/**
 * How long a thread may sit untouched before it is detached.
 *
 * Detaching frees the bridge's transcript *and* app-server's own thread state,
 * and is invisible to the user: the next request re-attaches from the rollout.
 */
export const DEFAULT_THREAD_IDLE_MS = 30 * 60 * 1000;

/**
 * How long a detached bridge session id stays resolvable.
 *
 * Only a small mapping is retained (id → threadId, config, title), so this is
 * cheap. Past it the id is forgotten and the UI resumes by thread id instead.
 */
export const DEFAULT_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface PromptAcceptedResult {
  status: "processing" | "already-processed";
  requestId?: string;
  threadId?: string | null;
  turnId?: string;
  duplicate?: boolean;
}

export class AppServerRuntime {
  private readonly options: AppServerRuntimeOptions;
  private readonly registry: ThreadRegistry;
  private readonly journal: DispatchJournal;
  private readonly store: BridgeSessionStore;
  private readonly threadState = new Map<string, ThreadRuntimeState>();
  private readonly now: () => number;
  private modelCache: BridgeModel[] | null = null;
  private started = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private detachedThreads = 0;
  private reattachedThreads = 0;
  /**
   * Approvals the UI has been told about and can still answer.
   *
   * The router is the authority on lifetime; this holds the session mapping the
   * router has no way to compute, and is what `/session/:id/approvals` reads so a
   * remounting tab rehydrates rather than depending on having seen the SSE frame.
   */
  private readonly pendingApprovals = new Map<
    string,
    { request: ApprovalRequest; sessionIds: string[] }
  >();

  constructor(options: AppServerRuntimeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.registry = new ThreadRegistry({ now: this.now });
    this.journal = new DispatchJournal({ codexHome: options.codexHome, cwd: options.cwd });
    this.store = new BridgeSessionStore({ codexHome: options.codexHome, cwd: options.cwd });
    options.engine.subscribe((event) => this.onEngineEvent(event));

    options.engine.setApprovalHandlers({
      present: (request) => this.presentApproval(request),
      resolved: (request, decision, resolution) =>
        this.onApprovalResolved(request, decision, resolution),
    });
  }

  /**
   * Claims an approval on behalf of the UI and announces it.
   *
   * Returns false when the request cannot be routed to a session — with no
   * addressable session there is no card to click, so the router's auto-decline is
   * the honest outcome rather than parking a request nobody can see.
   *
   * Must stay synchronous: this runs on the path from the RPC read loop.
   */
  private presentApproval(request: ApprovalRequest): boolean {
    const sessionIds = this.sessionIdsForApproval(request);
    if (sessionIds.length === 0) return false;

    this.pendingApprovals.set(request.approvalId, { request, sessionIds });
    for (const sessionId of sessionIds) {
      this.options.emit({
        type: "session.approval-requested",
        sessionId,
        data: { approval: request },
      });
    }
    return true;
  }

  private onApprovalResolved(
    request: ApprovalRequest,
    decision: ApprovalDecision,
    resolution: ApprovalResolution,
  ): void {
    const entry = this.pendingApprovals.get(request.approvalId);
    this.pendingApprovals.delete(request.approvalId);
    // Fall back to recomputing: a thread can gain a session between request and
    // answer, and the card must clear on whichever session is showing it.
    const sessionIds = entry?.sessionIds ?? this.sessionIdsForApproval(request);
    for (const sessionId of sessionIds) {
      this.options.emit({
        type: "session.approval-resolved",
        sessionId,
        data: { approvalId: request.approvalId, decision, resolution },
      });
    }
  }

  private sessionIdsForApproval(request: ApprovalRequest): string[] {
    if (!request.threadId) return [];
    return this.registry.sessionsForThread(request.threadId).map((session) => session.id);
  }

  /** Pending approvals for one session, so a remounting UI can rehydrate. */
  listApprovals(sessionId: string): ApprovalRequest[] {
    return [...this.pendingApprovals.values()]
      .filter((entry) => entry.sessionIds.includes(sessionId))
      .map((entry) => entry.request);
  }

  /**
   * Applies a user's answer.
   *
   * `unknown` covers already-answered, expired and withdrawn-by-restart alike —
   * all normal races over a five-minute window, and all meaning "the card is
   * stale" rather than "something went wrong".
   */
  respondToApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): "applied" | "unknown" | "wrong-session" {
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) return "unknown";
    // Scoped to the owning session so one tab cannot answer another's prompt.
    if (!entry.sessionIds.includes(sessionId)) return "wrong-session";

    if (this.options.engine.resolveApproval(approvalId, decision)) return "applied";

    // The router no longer has it but we do. There is no known path to this — the
    // router notifies before it forgets — so drop our copy rather than leave a card
    // that can never be answered.
    this.pendingApprovals.delete(approvalId);
    return "unknown";
  }

  /**
   * Starts the child and loads the dispatch journal.
   *
   * The journal must be read before any prompt is accepted, or a request that was
   * in flight when the bridge died could be dispatched a second time.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.journal.load();
    await this.options.engine.start();

    const interval = this.options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (interval > 0) {
      this.sweepTimer = setInterval(() => void this.sweepIdle(), interval);
      this.sweepTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const state of this.threadState.values()) state.coalescer.stop();
    this.threadState.clear();
    await this.options.engine.stop();
  }

  getRegistry(): ThreadRegistry {
    return this.registry;
  }

  getJournal(): DispatchJournal {
    return this.journal;
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
   * fresh thread. Verified against codex 0.145.0.
   */
  private async detachThread(context: ThreadContext): Promise<void> {
    const state = this.threadState.get(context.threadId);
    if (state) {
      state.coalescer.stop();
      releaseTurnRenderState(state.render);
      state.pendingEvents.clear();
      this.threadState.delete(context.threadId);
    }

    this.registry.detachThread(context.threadId);
    if (!context.materialized) this.registry.clearThreadBinding(context.threadId);

    this.detachedThreads += 1;
    await this.options.engine.unsubscribeThread(context.engineHandle).catch(() => undefined);
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
  private async ensureAttached(sessionId: string): Promise<ThreadContext | undefined> {
    const session = this.registry.getSession(sessionId);
    if (!session) return undefined;

    const existing = this.registry.getThreadForSession(sessionId);
    if (existing) return existing;
    // No thread id yet: lazy creation on first prompt, nothing to re-attach.
    if (!session.threadId) return undefined;

    const threadId = session.threadId;
    try {
      const thread = await this.options.engine.resumeThread(threadId, { config: session.config });
      const context = this.registry.attach(sessionId, threadId, {
        engineHandle: thread.handle,
        engineGeneration: this.options.engine.info().generation,
        cwd: thread.cwd,
        name: thread.name,
      });
      // It had a rollout to resume from, so it is materialized by definition.
      context.materialized = true;
      const hydrated = await hydrateMessagesFromPersistedSession(threadId);
      context.messages = hydrated.messages;
      if (!session.title) {
        session.title = thread.name ?? hydrated.title;
        session.titleSource = thread.name ? "codex" : hydrated.titleSource;
      }
      this.reattachedThreads += 1;
      return context;
    } catch (error) {
      /**
       * Any failure here means this thread id cannot serve requests, whether the
       * rollout was deleted or the thread was never materialized. Clearing the
       * binding lets the next prompt start a fresh thread instead of failing
       * forever against a dead id.
       */
      this.registry.clearThreadBinding(threadId);
      console.warn(
        `[codex-bridge] Could not re-attach thread ${threadId}${
          isMissingRolloutError(error) ? " (no rollout on disk)" : ""
        }:`,
        error instanceof Error ? error.message : error,
      );
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

  private stateFor(threadId: string): ThreadRuntimeState {
    let state = this.threadState.get(threadId);
    if (!state) {
      state = {
        render: createTurnRenderState(),
        pendingEvents: new Map(),
        coalescer: new UpdateCoalescer({
          intervalMs: this.options.coalesceIntervalMs,
          publish: () => this.publishAssistantMessage(threadId),
          onError: (error) =>
            console.error("[codex-bridge] Failed to publish message update:", error),
        }),
      };
      this.threadState.set(threadId, state);
    }
    return state;
  }

  private onEngineEvent(event: EngineEvent): void {
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
      void this.recoverAfterGenerationChange(event.generation);
      return;
    }
    if (event.kind === "unknown.protocol") return;

    const threadId = "threadId" in event ? event.threadId : null;
    if (!threadId) return;
    const context = this.registry.getThread(threadId);
    if (!context) return;

    // Stale generation: the process that produced this has been replaced.
    if (
      event.engineGeneration !== undefined
      && context.engineGeneration !== 0
      && event.engineGeneration < context.engineGeneration
    ) {
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
      const isStale = turn !== null && turn.turnId !== event.turnId && turn.requestId !== undefined;
      if (!isStale) {
        this.bufferEvent(threadId, event.turnId, event);
        return;
      }
      return;
    }

    this.applyEvent(context, event);
  }

  private bufferEvent(threadId: string, turnId: string, event: EngineEvent): void {
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
  private drainPendingEvents(context: ThreadContext, turnId: string): void {
    const state = this.stateFor(context.threadId);
    const queue = state.pendingEvents.get(turnId);
    state.pendingEvents.clear();
    if (!queue) return;
    for (const event of queue) this.applyEvent(context, event);
  }

  private applyEvent(context: ThreadContext, event: EngineEvent): void {
    const threadId = context.threadId;

    switch (event.kind) {
      case "thread.name.updated":
        context.name = event.name ?? null;
        return;
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
        else if (event.kind === "item.started") turn.onItemStarted(event.item);
        else turn.onItemUpdated(event.item);
        // `item/completed` is authoritative; show it without waiting a tick.
        if (event.kind === "item.completed") void this.stateFor(threadId).coalescer.flushNow();
        else this.stateFor(threadId).coalescer.schedule(this.now());
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
        this.options.emit({
          type: "session.error",
          sessionId: this.primarySessionId(context),
          data: { error: event.error.message, code: event.error.code },
        });
        return;
      }
      case "turn.completed": {
        const turn = context.activeTurn;
        if (!turn || !turn.accepts(event)) return;
        turn.complete(event.status, event.error);
        void this.finalizeTurn(context, turn);
        return;
      }
      default:
        return;
    }
  }

  private primarySessionId(context: ThreadContext): string | undefined {
    return [...context.bridgeSessionIds][0];
  }

  /**
   * Brings recovering threads back to a definite state after a restart.
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
  private async recoverAfterGenerationChange(generation: EngineGeneration): Promise<void> {
    for (const context of this.registry.listThreads()) {
      if (context.phase !== "recovering") continue;

      const session = this.registry
        .sessionsForThread(context.threadId)
        .find((entry) => entry !== undefined);
      const config = session?.config;

      try {
        if (config) {
          const thread = await this.options.engine.resumeThread(context.threadId, { config });
          context.engineHandle = thread.handle;
        }
        context.engineGeneration = generation;

        const turn = context.activeTurn;
        if (!turn) {
          this.registry.setPhase(context, "idle");
          this.emitStatus(context);
          continue;
        }
        // Accept events from the replacement child for this turn.
        turn.engineGeneration = generation;

        if (!turn.requestId) {
          // Nothing to reconcile against, so the honest outcome is interrupted.
          turn.complete("interrupted");
          await this.finalizeTurn(context, turn);
          continue;
        }

        const outcome = await this.options.engine.reconcileRequest(
          context.threadId,
          turn.requestId,
        );

        if (outcome.result === "terminal") {
          turn.complete(outcome.status ?? "completed");
          await this.finalizeTurn(context, turn);
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
        this.registry.setPhase(context, "failed", message);
        this.emitStatus(context);
        for (const sessionId of context.bridgeSessionIds) {
          this.options.emit({ type: "session.error", sessionId, data: { error: message } });
        }
      }
    }
  }

  private async finalizeTurn(context: ThreadContext, turn: TurnAccumulator): Promise<void> {
    const state = this.stateFor(context.threadId);

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

    await state.coalescer.flushNow();

    context.activeTurn = null;
    this.registry.setPhase(
      context,
      turn.phase === "failed" ? "failed" : "idle",
      turn.error?.message,
    );
    state.assistantMessageId = undefined;

    for (const sessionId of context.bridgeSessionIds) {
      const session = this.registry.getSession(sessionId);
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

  /** Re-renders the streaming assistant message and pushes a full snapshot. */
  private async publishAssistantMessage(threadId: string): Promise<void> {
    const context = this.registry.getThread(threadId);
    const state = this.threadState.get(threadId);
    if (!context || !state) return;
    const turn = context.activeTurn;
    if (!turn) return;

    const message = context.messages.find((entry) => entry.id === turn.assistantMessageId);
    if (!message) return;

    const rendered = await renderTurn(turn, {
      threadId: context.threadId,
      cwd: context.cwd ?? this.options.cwd,
      state: state.render,
    });
    message.parts = rendered.parts;
    message.content = rendered.content;

    for (const sessionId of context.bridgeSessionIds) {
      this.options.emit({ type: "message.updated", sessionId, data: { message } });
    }
  }

  private emitStatus(context: ThreadContext): void {
    for (const sessionId of context.bridgeSessionIds) {
      this.options.emit({
        type: "session.updated",
        sessionId,
        data: { status: phaseToExternalStatus(context.phase), phase: context.phase },
      });
    }
  }

  // ---------------------------------------------------------------- sessions

  private toEngineConfig(body: Record<string, unknown>): EngineTurnConfig {
    const mode: ConversationMode = body.mode === "plan" ? "plan" : "build";
    const model =
      typeof body.model === "string" && body.model.trim().length > 0 ? body.model.trim() : undefined;
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

  createSession(body: Record<string, unknown>): { sessionId: string; title?: string } {
    const title = typeof body.title === "string" ? body.title : undefined;
    const session = this.registry.createSession({
      id: createSessionId(),
      // No Codex thread yet: an abandoned session must not appear in history.
      threadId: null,
      config: this.toEngineConfig(body),
      title,
      titleSource: title ? "explicit" : undefined,
      titleGenerationAttempted: Boolean(title),
    });
    return { sessionId: session.id, title };
  }

  async resumeSession(body: Record<string, unknown>): Promise<{
    sessionId: string;
    title?: string;
    threadId: string;
    messages: NormalizedMessage[];
  } | null> {
    const threadId =
      typeof body.threadId === "string" && body.threadId.trim().length > 0
        ? body.threadId.trim()
        : null;
    if (!threadId) return null;

    const config = this.toEngineConfig(body);
    const sessionId = createSessionId();
    const session = this.registry.createSession({
      id: sessionId,
      threadId: null,
      config,
      titleGenerationAttempted: true,
    });

    let thread: EngineThread;
    try {
      thread = await this.options.engine.resumeThread(threadId, { config, includeTurns: true });
    } catch (error) {
      // A resume can fail because the rollout is gone. Fall back to the parser so
      // the user still sees their conversation; the next prompt starts a fresh
      // thread with reconstructed context.
      if (!isMissingRolloutError(error)) throw error;
      const hydrated = await hydrateMessagesFromPersistedSession(threadId);
      session.title = hydrated.title;
      session.titleSource = hydrated.titleSource;
      return { sessionId, title: hydrated.title, threadId, messages: hydrated.messages };
    }

    const context = this.registry.attach(sessionId, threadId, {
      engineHandle: thread.handle,
      engineGeneration: this.options.engine.info().generation,
      cwd: thread.cwd,
      name: thread.name,
    });

    // Only hydrate when this is the first tab on the thread; a second tab must
    // join the existing canonical transcript rather than rebuild it.
    if (context.messages.length === 0) {
      const hydrated = await hydrateMessagesFromPersistedSession(threadId);
      context.messages = hydrated.messages;
      session.title = thread.name ?? hydrated.title;
      session.titleSource = thread.name ? "codex" : hydrated.titleSource;
    } else {
      const existing = this.registry
        .sessionsForThread(threadId)
        .find((entry) => entry.id !== sessionId && entry.title);
      session.title = existing?.title ?? thread.name ?? undefined;
      session.titleSource = existing?.titleSource;
    }

    await this.persistSession(session);
    return {
      sessionId,
      title: session.title,
      threadId,
      messages: context.messages,
    };
  }

  async updateConfig(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<"updated" | "not-found" | "running"> {
    const session = this.registry.getSession(sessionId);
    if (!session) return "not-found";
    const context = this.registry.getThreadForSession(sessionId);
    if (context && phaseToExternalStatus(context.phase) === "running") return "running";

    session.config = this.toEngineConfig(body);
    this.registry.touch(sessionId);
    const attached = context ?? (await this.ensureAttached(sessionId));
    if (attached) await this.options.engine.configureThread(attached.engineHandle, session.config);
    return "updated";
  }

  async getMessages(sessionId: string): Promise<NormalizedMessage[] | null> {
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    this.registry.touch(sessionId);
    const context = await this.ensureAttached(sessionId);
    if (!context) return [];

    // Rehydrate the streaming message so a tab that reconnects mid-turn catches
    // up without waiting for the next delta.
    if (context.activeTurn) await this.publishAssistantMessage(context.threadId);
    return context.messages;
  }

  getStatus(sessionId: string): {
    status: "idle" | "running" | "error";
    phase: SessionPhase;
    title?: string;
    error?: string;
    threadId?: string | null;
    turnId?: string;
    requestId?: string;
    engineGeneration: number;
  } | null {
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    this.registry.touch(sessionId);
    const context = this.registry.getThreadForSession(sessionId);
    const phase = context?.phase ?? "idle";

    return {
      // Keeps the pre-migration contract; `phase` carries the new detail.
      status: phaseToExternalStatus(phase),
      phase,
      title: session.title,
      error: context?.error,
      threadId: session.threadId,
      turnId: context?.activeTurn?.turnId,
      requestId: context?.activeTurn?.requestId,
      engineGeneration: this.options.engine.info().generation,
    };
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.registry.getSession(sessionId);
    if (!session) return false;

    // Answered before the registry drops the thread, so the router can still map
    // the approval to a session and the pending turn is not left waiting on a
    // prompt whose UI has gone away.
    const threadId = session.threadId;
    if (threadId) this.options.engine.abandonThreadApprovals(threadId);

    const { removedThread } = this.registry.releaseSession(sessionId);
    await this.store.remove(sessionId).catch(() => undefined);

    if (removedThread) {
      // Last reference: release the thread but never delete the rollout.
      this.threadState.get(removedThread.threadId)?.coalescer.stop();
      this.threadState.delete(removedThread.threadId);
      await this.options.engine.unsubscribeThread(removedThread.engineHandle).catch(() => undefined);
    }
    return true;
  }

  private async persistSession(session: BridgeSession): Promise<void> {
    if (!session.threadId) return;
    await this.store
      .upsert(
        this.store.toRecord({
          bridgeSessionId: session.id,
          threadId: session.threadId,
          cwd: this.options.cwd,
          config: session.config,
          title: session.title,
          titleSource: session.titleSource,
          lastAcceptedRequestId: session.lastAcceptedRequestId,
        }),
      )
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------ prompt

  /**
   * Accepts a prompt, guaranteeing at-most-once execution.
   *
   * The whole body runs under the thread's dispatch lock so two tabs cannot both
   * observe an idle thread and both dispatch.
   */
  async prompt(
    sessionId: string,
    input: { prompt: string; requestId?: string; attachments: PromptAttachmentInput[] },
  ): Promise<
    | { ok: true; result: PromptAcceptedResult }
    | { ok: false; status: 404 | 409 | 503; error: string }
  > {
    const session = this.registry.getSession(sessionId);
    if (!session) return { ok: false, status: 404, error: "Session not found" };
    this.registry.touch(sessionId);

    try {
      return await this.registry.withDispatchLock(session, () =>
        this.dispatchPrompt(session, input),
      );
    } catch (error) {
      if (error instanceof OverlappingTurnError) {
        return { ok: false, status: 409, error: "Session is already running" };
      }
      return {
        ok: false,
        status: 503,
        error: error instanceof Error ? error.message : "Codex is unavailable",
      };
    }
  }

  private async dispatchPrompt(
    session: BridgeSession,
    input: { prompt: string; requestId?: string; attachments: PromptAttachmentInput[] },
  ): Promise<
    | { ok: true; result: PromptAcceptedResult }
    | { ok: false; status: 404 | 409 | 503; error: string }
  > {
    const requestId = input.requestId;

    // 1. Has this exact request been seen? Never dedupe on prompt text — the same
    //    text under a new id is a legitimately different turn.
    if (requestId) {
      const decision = this.journal.classify(requestId);
      if (decision.action === "already-done") {
        return {
          ok: true,
          result: { status: "already-processed", requestId, duplicate: true },
        };
      }
      if (decision.action === "attach") {
        return {
          ok: true,
          result: {
            status: "processing",
            requestId,
            threadId: decision.record?.threadId ?? null,
            turnId: decision.record?.turnId,
            duplicate: true,
          },
        };
      }
      if (decision.action === "reconcile" && decision.record?.threadId) {
        const outcome = await this.options.engine.reconcileRequest(
          decision.record.threadId,
          requestId,
        );
        if (outcome.result === "terminal") {
          await this.journal.markTerminal(requestId, outcome.status ?? "completed", {
            threadId: decision.record.threadId,
            turnId: outcome.turnId,
          });
          return {
            ok: true,
            result: { status: "already-processed", requestId, duplicate: true },
          };
        }
        if (outcome.result === "attach") {
          await this.journal.markAccepted(requestId, {
            threadId: decision.record.threadId,
            turnId: outcome.turnId!,
          });
          return {
            ok: true,
            result: {
              status: "processing",
              requestId,
              threadId: decision.record.threadId,
              turnId: outcome.turnId,
              duplicate: true,
            },
          };
        }
        // Absent: proven not to have run, so dispatching once is safe.
        await this.journal.forget(requestId);
      }
    }

    // Re-attach first: without this a detached session would fall through to
    // `thread/start` below and silently fork a second thread, orphaning the
    // conversation the user was looking at.
    let context = this.registry.getThreadForSession(session.id)
      ?? (await this.ensureAttached(session.id));
    this.registry.assertNoActiveTurn(context);

    // 2. A persistent child snapshots its environment at launch, so re-read
    //    PATH-ish variables and restart before dispatching if they moved.
    await this.options.engine.ensureEnvironmentIsCurrent({
      hasActiveTurns: () =>
        this.registry.listThreads().some((entry) => entry.activeTurn !== null),
      waitForIdle: async () => undefined,
    });

    // 3. Local slash commands never reach the model.
    const cwd = this.options.cwd;
    const resolved = await this.resolveSlashCommand(session, input.prompt, cwd);
    if (resolved?.kind === "builtin") {
      this.emitLocalResponse(session, input.prompt, resolved.response);
      return { ok: true, result: { status: "processing", requestId } };
    }

    const executionPrompt = resolved?.kind === "prompt" ? resolved.expandedPrompt : input.prompt;
    const parsed = parseSlashCommandPrompt(executionPrompt);
    const bypassModeWrapper = !!parsed && isCodexCliNativeSlashCommand(parsed.name);
    const isPlanReview = session.config.mode === "plan" && !bypassModeWrapper;

    // 4. Lazily create the Codex thread on first prompt.
    if (!context) {
      const thread = await this.options.engine.startThread({ config: session.config });
      if (!thread.id) return { ok: false, status: 503, error: "Codex did not return a thread id" };
      context = this.registry.attach(session.id, thread.id, {
        engineHandle: thread.handle,
        engineGeneration: this.options.engine.info().generation,
        cwd: thread.cwd,
      });
      await this.persistSession(session);
    }

    context.dispatchInFlight = true;
    this.registry.setPhase(context, "starting");

    const userMessage = this.appendUserMessage(context, input.prompt, input.attachments);
    const assistantMessage: NormalizedMessage = {
      id: createMessageId(),
      role: "assistant",
      content: "",
      parts: [],
      createdAt: new Date(this.now()).toISOString(),
      ...(isPlanReview ? { planReview: true } : {}),
    };
    context.messages.push(assistantMessage);

    this.applyPromptTitle(session, context, input.prompt);
    for (const id of context.bridgeSessionIds) {
      this.options.emit({ type: "message.updated", sessionId: id, data: { message: assistantMessage } });
    }
    this.emitStatus(context);

    const engineInput: EngineUserInput[] = toEngineInput(
      bypassModeWrapper
        ? executionPrompt
        : wrapPromptForConversationMode(executionPrompt, session.config.mode),
      input.attachments,
    );

    try {
      // 5. Journal *before* the write: everything from here to `markAccepted` is
      //    the ambiguous window.
      if (requestId) {
        await this.journal.markPrepared({
          requestId,
          bridgeSessionId: session.id,
          threadId: context.threadId,
        });
      }

      const turn = await this.options.engine.startTurn({
        handle: context.engineHandle,
        input: engineInput,
        config: session.config,
        requestId,
      });

      if (requestId) {
        await this.journal.markAccepted(requestId, {
          threadId: context.threadId,
          turnId: turn.turnId,
        });
        session.lastAcceptedRequestId = requestId;
      }

      // The user message is persisted now, so the thread has a rollout and can be
      // detached and resumed later.
      context.materialized = true;

      const accumulator = new TurnAccumulator({
        threadId: context.threadId,
        turnId: turn.turnId,
        requestId,
        engineGeneration: turn.engineGeneration,
        assistantMessageId: assistantMessage.id,
      });
      accumulator.markRunning();
      context.activeTurn = accumulator;
      context.engineGeneration = turn.engineGeneration;
      context.dispatchInFlight = false;
      this.registry.setPhase(context, "running");
      const state = this.stateFor(context.threadId);
      state.render = beginTurnRenderState(state.render);
      state.assistantMessageId = assistantMessage.id;

      // The turn is registered now, so anything that arrived while `turn/start`
      // was still in flight can be applied. A fast turn may already have
      // completed here, which is why this runs before returning.
      this.drainPendingEvents(context, turn.turnId);

      return {
        ok: true,
        result: {
          status: "processing",
          requestId,
          threadId: context.threadId,
          turnId: turn.turnId,
        },
      };
    } catch (error) {
      context.dispatchInFlight = false;
      const classified = this.options.engine.classifyFailure(error);

      /**
       * A rejected dispatch definitely did not run, so the session is genuinely
       * idle again. An ambiguous one might be running: report `recovering` rather
       * than idle, so nothing advances a build phase or accepts a new prompt on a
       * turn that may still be executing.
       */
      if (classified.class === "rejected") {
        this.registry.setPhase(context, "failed", classified.engineError.message);
        if (requestId) await this.journal.forget(requestId);
      } else {
        this.registry.setPhase(context, "recovering");
      }
      this.emitStatus(context);
      this.options.emit({
        type: "session.error",
        sessionId: session.id,
        data: { error: classified.engineError.message, code: classified.engineError.code },
      });
      return { ok: false, status: 503, error: classified.engineError.message };
    }
  }

  private appendUserMessage(
    context: ThreadContext,
    prompt: string,
    attachments: PromptAttachmentInput[],
  ): NormalizedMessage {
    const parts: NormalizedPart[] = [];
    if (prompt.length > 0) parts.push({ type: "text", content: prompt });
    for (const attachment of attachments) {
      parts.push({
        type: "file",
        content: attachment.filename || attachment.path,
        fileUrl: attachment.dataUrl || `file://${attachment.path}`,
      });
    }
    const message: NormalizedMessage = {
      id: createMessageId(),
      role: "user",
      content: prompt,
      parts,
      createdAt: new Date(this.now()).toISOString(),
    };
    context.messages.push(message);
    return message;
  }

  /**
   * Title precedence: explicit app-server name → explicit Orkestrator title →
   * generated → prompt fallback. The generated title is dual-written to Codex
   * (`thread/name/set`) and the bridge's own index so rollback keeps titles.
   */
  private applyPromptTitle(session: BridgeSession, context: ThreadContext, prompt: string): void {
    if (!session.title) {
      session.title = buildFallbackSessionTitle(prompt);
      session.titleSource = "prompt";
      for (const id of context.bridgeSessionIds) {
        this.options.emit({
          type: "session.title-updated",
          sessionId: id,
          data: { title: session.title },
        });
      }
    }

    const shouldGenerate =
      session.titleGenerationAttempted !== true
      && (session.titleSource === "prompt" || !session.titleSource);
    if (!shouldGenerate || !this.options.generateTitle) return;

    session.titleGenerationAttempted = true;
    const token = Symbol("title");
    session.titleGenerationToken = token;

    void this.options
      .generateTitle(prompt)
      .then(async (title) => {
        if (session.titleGenerationToken !== token) return;
        session.title = title;
        session.titleSource = "generated";
        session.titleGenerationToken = undefined;

        const threadId = session.threadId;
        if (threadId) {
          // Dual write: Codex owns the display name, but the bridge index is what
          // the SDK engine reads, so rollback must still see the title.
          await this.options.engine.setThreadName(threadId, title).catch(() => false);
          await persistSessionTitle(this.options.codexHome, threadId, title, {
            source: "generated",
          }).catch(() => undefined);
        }
        for (const id of context.bridgeSessionIds) {
          this.options.emit({ type: "session.title-updated", sessionId: id, data: { title } });
        }
      })
      .catch(() => {
        if (session.titleGenerationToken === token) session.titleGenerationToken = undefined;
        console.warn("[codex-bridge] Failed to generate session title; using prompt fallback");
      });
  }

  private async resolveSlashCommand(
    session: BridgeSession,
    prompt: string,
    cwd: string,
  ): Promise<{ kind: "prompt"; expandedPrompt: string } | { kind: "builtin"; response: string } | null> {
    const parsed = parseSlashCommandPrompt(prompt);
    if (!parsed) return null;

    if (parsed.name === "/help") {
      const commands = await getAvailableSlashCommandDefinitions(cwd);
      const builtin = commands.filter((command) => command.source === "builtin");
      const prompts = commands.filter(
        (command): command is PromptSlashCommand => command.source === "prompt",
      );
      const sections = ["Available Codex slash commands:"];
      if (builtin.length > 0) {
        sections.push("", "Built in:");
        for (const command of builtin) {
          sections.push(`- ${command.name}${command.description ? `: ${command.description}` : ""}`);
        }
      }
      if (prompts.length > 0) {
        sections.push("", "Prompt commands:");
        for (const command of prompts) {
          const suffix = command.argumentHint ? ` ${command.argumentHint}` : "";
          sections.push(
            `- ${command.name}${suffix}${command.description ? `: ${command.description}` : ""}`,
          );
        }
      } else {
        sections.push("", "No Codex prompt commands were discovered in this environment.");
      }
      return { kind: "builtin", response: sections.join("\n") };
    }

    if (parsed.name === "/models") {
      const { models } = await this.listModels();
      const current = session.config.model || models[0]?.id || "UNCONFIRMED";
      return {
        kind: "builtin",
        response: [
          "Available Codex models:",
          ...models.map(
            (model) =>
              `- ${model.id}${model.id === current ? " (current)" : ""}${model.description ? `: ${model.description}` : ""}`,
          ),
        ].join("\n"),
      };
    }

    // `/goal` is handled by the Codex CLI itself, so it must reach the model.
    if (isCodexCliNativeSlashCommand(parsed.name)) return null;

    const commands = await getAvailableSlashCommandDefinitions(cwd);
    const promptCommand = commands.find(
      (command): command is PromptSlashCommand =>
        command.source === "prompt" && command.name.toLowerCase() === parsed.name.toLowerCase(),
    );
    if (!promptCommand) return null;
    return {
      kind: "prompt",
      expandedPrompt: await expandPromptTemplate(promptCommand.template, parsed.args, cwd),
    };
  }

  /** Answers a built-in command without involving Codex at all. */
  private emitLocalResponse(session: BridgeSession, prompt: string, response: string): void {
    const context = this.registry.getThreadForSession(session.id);
    const messages = context?.messages;
    const userMessage: NormalizedMessage = {
      id: createMessageId(),
      role: "user",
      content: prompt,
      parts: [{ type: "text", content: prompt }],
      createdAt: new Date(this.now()).toISOString(),
    };
    const assistantMessage: NormalizedMessage = {
      id: createMessageId(),
      role: "assistant",
      content: response,
      parts: [{ type: "text", content: response }],
      createdAt: new Date(this.now()).toISOString(),
    };
    messages?.push(userMessage, assistantMessage);

    if (!session.title) {
      session.title = buildFallbackSessionTitle(prompt);
      session.titleSource = "prompt";
      this.options.emit({
        type: "session.title-updated",
        sessionId: session.id,
        data: { title: session.title },
      });
    }
    this.options.emit({
      type: "message.updated",
      sessionId: session.id,
      data: { message: assistantMessage },
    });
    this.options.emit({ type: "session.updated", sessionId: session.id });
    this.options.emit({
      type: "session.idle",
      sessionId: session.id,
      data: { title: session.title },
    });
  }

  // ------------------------------------------------------------------- abort

  /**
   * Requests interruption and returns immediately with `cancelling`.
   *
   * The session is **not** idle yet. `turn/interrupt` is asynchronous, so going
   * straight to idle would allow a new prompt to overlap a turn that is still
   * executing. The terminal transition happens in the background.
   */
  async abort(
    sessionId: string,
  ): Promise<{ status: "cancelling" | "idle"; phase: SessionPhase } | null> {
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    this.registry.touch(sessionId);

    const context = this.registry.getThreadForSession(sessionId);
    const turn = context?.activeTurn;
    if (!context || !turn) {
      // Nothing running; report the real phase rather than forcing idle.
      return { status: context?.phase === "idle" ? "idle" : "cancelling", phase: context?.phase ?? "idle" };
    }

    turn.markCancelling();
    this.registry.setPhase(context, "cancelling");
    this.emitStatus(context);

    const handle = context.engineHandle;
    const turnId = turn.turnId;
    await this.options.engine.interruptTurn(handle, turnId).catch(() => undefined);

    void (async () => {
      const status = await this.options.engine.waitForTurnTerminal(handle, turnId, {
        allowRestart: true,
      });
      // A terminal event normally finalizes via the event path. This covers the
      // case where escalation resolved it without one.
      if (context.activeTurn === turn && !turn.isTerminal()) {
        turn.complete(status === "unknown" ? "interrupted" : status);
        await this.finalizeTurn(context, turn);
      }
    })();

    return { status: "cancelling", phase: "cancelling" };
  }

  // ------------------------------------------------------------------ models

  /**
   * `model/list` is authoritative, with the persisted cache and the hardcoded
   * fallback catalog behind it so a cold app-server cannot empty the model picker.
   */
  async listModels(): Promise<{ models: BridgeModel[]; source: "app-server" | "cache" | "fallback" }> {
    if (this.modelCache) return { models: this.modelCache, source: "app-server" };
    try {
      const engineModels = await this.options.engine.listModels();
      const models = engineModels
        .filter((model) => !model.hidden)
        .map((model) => toBridgeModel(model));
      if (models.length > 0) {
        this.modelCache = models;
        await this.options.persistModels?.(models).catch(() => undefined);
        return { models, source: "app-server" };
      }
    } catch (error) {
      console.warn(
        "[codex-bridge] model/list failed; falling back to cache:",
        error instanceof Error ? error.message : error,
      );
    }
    return this.options.loadCachedModels();
  }

  // ----------------------------------------------------------------- history

  /**
   * Native `thread/list` first, then the rollout parser.
   *
   * The fallback is not belt-and-braces: archived, malformed and partially-written
   * threads are only visible on disk, and legacy `exec` sessions must keep
   * appearing after the migration.
   */
  async listSessions(): Promise<{ sessions: Array<{ id: string; title?: string; updatedAt: string }>; cwd: string }> {
    const cwd = getWorkingDirectory(this.options.cwd);
    const merged = new Map<string, { id: string; title?: string; updatedAt: string }>();

    try {
      const { threads } = await this.options.engine.listThreads({ cwd });
      for (const thread of threads) {
        if (!thread.id) continue;
        merged.set(thread.id, {
          id: thread.id,
          title: thread.name ?? thread.preview ?? undefined,
          updatedAt: thread.updatedAt ?? new Date(this.now()).toISOString(),
        });
      }
    } catch (error) {
      console.warn(
        "[codex-bridge] thread/list failed; using rollout parser:",
        error instanceof Error ? error.message : error,
      );
    }

    let persisted: PersistedSessionMeta[] = [];
    try {
      persisted = await listPersistedSessionsForCwd(cwd);
    } catch {
      persisted = [];
    }
    for (const meta of persisted) {
      const existing = merged.get(meta.id);
      if (!existing) {
        merged.set(meta.id, { id: meta.id, title: meta.title, updatedAt: meta.updatedAt });
        continue;
      }
      // A custom Orkestrator title outranks app-server's first-message preview.
      if (meta.title && meta.titleSource !== undefined) existing.title = meta.title;
    }

    // Generated titles are the bridge's own, and win over a preview.
    try {
      const generated = await readPersistedSessionTitleEntries(this.options.codexHome);
      for (const session of merged.values()) {
        const entry = generated.get(session.id);
        if (entry) session.title = entry.title;
      }
    } catch {
      // Title index is optional.
    }

    return {
      sessions: [...merged.values()].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
      cwd,
    };
  }

  getHealth(): ReturnType<AppServerEngine["getHealth"]> & {
    activeThreads: number;
    activeTurns: number;
    bridgeSessions: number;
    storage: ReturnType<AppServerRuntime["getStorageStats"]>;
  } {
    const threads = this.registry.listThreads();
    return {
      ...this.options.engine.getHealth(),
      activeThreads: threads.length,
      activeTurns: threads.filter((thread) => thread.activeTurn !== null).length,
      bridgeSessions: this.registry.listSessions().length,
      storage: this.getStorageStats(),
    };
  }
}

function toEngineInput(prompt: string, attachments: PromptAttachmentInput[]): EngineUserInput[] {
  const input: EngineUserInput[] = [];
  if (prompt.length > 0) input.push({ type: "text", text: prompt });
  for (const attachment of attachments) {
    input.push({ type: "local_image", path: attachment.path });
  }
  // A prompt-less turn is not valid; attachments alone still need a text slot.
  if (input.length === 0) input.push({ type: "text", text: prompt });
  return input;
}

/** app-server model → the shape the frontend model picker already consumes. */
function toBridgeModel(model: {
  id: string;
  displayName: string;
  description?: string;
  supportedReasoningEfforts: Array<{ effort: string; description?: string }>;
  defaultReasoningEffort?: string;
}): BridgeModel {
  return {
    id: model.id,
    name: model.displayName || model.id,
    description: model.description,
    // Server order is meaningful; app-server documents that clients must not
    // derive it from the effort names.
    reasoningEfforts: model.supportedReasoningEfforts.map(
      (entry) => entry.effort,
    ) as BridgeModel["reasoningEfforts"],
    reasoningOptions: model.supportedReasoningEfforts.map((entry) => ({
      effort: entry.effort as BridgeModel["reasoningOptions"][number]["effort"],
      label: entry.effort.charAt(0).toUpperCase() + entry.effort.slice(1),
      description: entry.description,
    })),
    defaultReasoningEffort: model.defaultReasoningEffort as BridgeModel["defaultReasoningEffort"],
  };
}

export type { PersistedSessionTitleSource, SessionTitleSource };
