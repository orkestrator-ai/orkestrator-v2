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
  AppServerRuntimeBase
} from "./app-server-runtime-base.js";
import { AppServerRuntimeLifecycle } from "./app-server-runtime-lifecycle.js";
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


export class AppServerRuntimeSessions extends AppServerRuntimeLifecycle {
  createSession(body: Record<string, unknown>): { sessionId: string; title?: string } {
    const clientSessionKey =
      typeof body.clientSessionKey === "string"
      && body.clientSessionKey.trim().length > 0
      && body.clientSessionKey.length <= 512
        ? body.clientSessionKey
        : undefined;
    const sessionId = clientSessionKey
      ? `session-client-${
          createHash("sha256")
            .update(this.options.cwd)
            .update("\0")
            .update(clientSessionKey)
            .digest("hex")
            .slice(0, 32)
        }`
      : createSessionId();
    const existing = this.registry.getSession(sessionId);
    if (existing) {
      this.registry.touch(sessionId);
      return { sessionId, title: existing.title };
    }

    const title = typeof body.title === "string" ? body.title : undefined;
    const session = this.registry.createSession({
      id: sessionId,
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

    // A resume often follows on-disk changes made outside this process, and both
    // hydration paths below may consult the cwd listing; do not serve them a
    // catalog cached from before those changes.
    invalidateTranscriptCatalogCache();

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
      this.registry.appendLocalMessages(session, ...hydrated.messages);
      session.recoveredContextPending = hydrated.messages.length > 0;
      return { sessionId, title: hydrated.title, threadId, messages: hydrated.messages };
    }

    const modelsBeforeAttach = this.snapshotBoundModelOverrides(threadId);
    const context = this.registry.attach(sessionId, threadId, {
      engineHandle: thread.handle,
      engineGeneration: this.options.engine.info().generation,
      cwd: thread.cwd,
      name: thread.name,
      modelId: thread.model,
    });
    context.materialized = true;

    // Only hydrate when this is the first tab on the thread; a second tab must
    // join the existing canonical transcript rather than rebuild it.
    if (context.messages.length === 0) {
      const hydrated = await hydrateMessagesFromPersistedSession(threadId);
      context.messages = hydrated.messages;
      this.applyPersistedModelOverrides(context);
      if (hydrated.messages.length > 0) this.bumpMessageRevision(context);
      session.title = thread.name ?? hydrated.title;
      session.titleSource = thread.name ? "codex" : hydrated.titleSource;
    } else {
      this.publishPersistedModelOverrides(context);
      const existing = this.registry
        .sessionsForThread(threadId)
        .find((entry) => entry.id !== sessionId && entry.title);
      session.title = existing?.title ?? thread.name ?? undefined;
      session.titleSource = existing?.titleSource;
    }

    await this.synchronizeAttachedModelOverrides(context, modelsBeforeAttach);
    await this.persistSession(session);
    return {
      sessionId,
      title: session.title,
      threadId,
      messages: context.messages,
    };
  }

  /**
   * Forks the thread, optionally truncated at a message.
   *
   * The outcomes are deliberately distinct. Everything used to collapse into
   * `null`, which the route reported as "cannot be forked while running or
   * before its first turn" — the wrong explanation for the most common failure,
   * which was a message the bridge could not resolve to a turn at all.
   */
  async forkSession(
    sessionId: string,
    lastMessageId?: string,
  ): Promise<
    | {
        outcome: "created";
        sessionId: string;
        title?: string;
        threadId: string;
        messages: NormalizedMessage[];
      }
    | { outcome: "not-found" | "running" | "unknown-message" | "no-fork-point" | "unavailable" }
  > {
    const parent = this.registry.getSession(sessionId);
    if (!parent?.threadId) return { outcome: "not-found" };
    const parentContext = await this.ensureAttached(sessionId);
    if (!parentContext) return { outcome: "not-found" };
    if (phaseToExternalStatus(parentContext.phase) === "running") {
      return { outcome: "running" };
    }

    let lastTurnId: string | undefined;
    if (lastMessageId) {
      const message = parentContext.messages.find((entry) => entry.id === lastMessageId);
      if (!message) return { outcome: "unknown-message" };
      lastTurnId = message.turnId ?? (await this.resolveTurnIdFromEngine(parentContext, message));
      // Present in the transcript but not attributable to a Codex turn: a local
      // slash-command reply, or a rollout too old to record turn boundaries.
      // Neither is a boundary `thread/fork` could honour.
      if (!lastTurnId) return { outcome: "no-fork-point" };
    }

    let fork: Awaited<ReturnType<AppServerEngine["forkThread"]>>;
    try {
      fork = await this.options.engine.forkThread(parent.threadId, parent.config, lastTurnId);
    } catch (error) {
      // A restarting or failed app-server rejects here. That is an availability
      // problem, not a route bug — surface it as the mapped 503, never a raw 500.
      console.warn(
        `[codex-bridge] thread/fork failed for ${parent.threadId}:`,
        error instanceof Error ? error.message : error,
      );
      return { outcome: "unavailable" };
    }
    if (!fork.id) return { outcome: "unavailable" };
    // The fork's rollout was just born; a catalog cached before it existed must
    // not answer the hydration or the next /session/list.
    invalidateTranscriptCatalogCache();
    const child = this.registry.createSession({
      id: createSessionId(),
      threadId: null,
      config: { ...parent.config },
      title: parent.title ? `${parent.title} (fork)` : "Forked session",
      titleSource: "explicit",
      titleGenerationAttempted: true,
      confirmedModelsByTurn: { ...(parent.confirmedModelsByTurn ?? {}) },
    });
    try {
      const context = this.registry.attach(child.id, fork.id, {
        engineHandle: fork.handle,
        engineGeneration: this.options.engine.info().generation,
        cwd: fork.cwd,
        name: fork.name,
        modelId: fork.model,
      });
      context.materialized = true;
      const hydrated = await hydrateMessagesFromPersistedSession(fork.id);
      context.messages = hydrated.messages;
      this.applyPersistedModelOverrides(context);
      if (hydrated.messages.length > 0) this.bumpMessageRevision(context);
      await this.persistSession(child);
      return {
        outcome: "created",
        sessionId: child.id,
        title: child.title,
        threadId: fork.id,
        messages: context.messages,
      };
    } catch (error) {
      // The child session was registered above; failing here would leave an
      // orphan bridge session bound to a fork no client ever learned about.
      // Close it — which unsubscribes, never `thread/delete` — before reporting.
      await this.deleteSession(child.id).catch(() => undefined);
      console.warn(
        `[codex-bridge] Fork of ${parent.threadId} could not be hydrated:`,
        error instanceof Error ? error.message : error,
      );
      return { outcome: "unavailable" };
    }
  }

  /**
   * Last resort for a message with no reconstructed `turnId`.
   *
   * Asks app-server for the thread's turns and, if the transcript's shape lines
   * up, backfills every message's turn so the *next* fork is a straight lookup.
   * Deliberately conservative: an alignment it cannot prove yields `undefined`
   * and the caller reports "not a usable fork point" rather than forking the
   * conversation at a turn the user did not choose.
   */
  protected async resolveTurnIdFromEngine(
    context: ThreadContext,
    message: NormalizedMessage,
  ): Promise<string | undefined> {
    let turns: { id: string }[] | undefined;
    try {
      const thread = await this.options.engine.readThread(context.threadId, {
        includeTurns: true,
      });
      turns = thread?.turns;
    } catch (error) {
      console.warn(
        `[codex-bridge] Could not read turns for thread ${context.threadId}:`,
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
    if (!turns?.length) return undefined;

    // One turn per user message is app-server's own model of a thread. If the
    // transcript disagrees, the mapping is unprovable and nothing is backfilled.
    const userMessages = context.messages.filter((entry) => entry.role === "user");
    if (userMessages.length !== turns.length) return undefined;

    let index = -1;
    for (const entry of context.messages) {
      if (entry.role === "user") index += 1;
      if (index < 0) continue;
      const turnId = turns[index]?.id;
      if (turnId && !entry.turnId) entry.turnId = turnId;
    }
    return message.turnId;
  }

  /**
   * Compacts the thread's context.
   *
   * `thread/compact/start` returns as soon as the request is accepted and the
   * rewrite continues in the background, ending with `thread/compacted`. The
   * thread is busy for that whole span: reporting `idle` in between let the next
   * prompt — or a build-pipeline step — race a context rewrite in progress.
   */
  async compactSession(
    sessionId: string,
  ): Promise<"accepted" | "not-found" | "running" | "unavailable"> {
    const session = this.registry.getSession(sessionId);
    if (!session?.threadId) return "not-found";
    const context = await this.ensureAttached(sessionId);
    if (!context) return "not-found";
    try {
      this.registry.assertNoActiveTurn(context);
    } catch {
      return "running";
    }

    // Claimed before the first await, so a prompt arriving during the RPC sees a
    // busy thread rather than an idle one.
    context.compacting = true;
    this.registry.setPhase(context, "running");
    this.emitStatus(context);
    this.armCompactionBackstop(context.threadId);

    try {
      await this.options.engine.compactThread(session.threadId);
    } catch (error) {
      this.finishCompaction(
        context,
        error instanceof Error ? error.message : "Compaction could not be started",
      );
      return "unavailable";
    }

    // Recheck after the round-trip: the hold may already have been released — by
    // an abort, a generation change, or a `thread/compacted` delivered in the
    // same stdout chunk as the RPC response (the JSONL client dispatches every
    // line of a chunk synchronously). Announcing `compacting: true` then would be
    // the last frame clients ever see, with nothing left to retract it.
    if (context.compacting) {
      for (const id of context.bridgeSessionIds) {
        this.options.emit({
          type: "session.updated",
          sessionId: id,
          data: { compacted: true, compacting: true },
        });
      }
    }
    return "accepted";
  }

  protected armCompactionBackstop(threadId: string): void {
    this.clearCompactionBackstop(threadId);
    const timer = setTimeout(() => {
      this.compactionBackstops.delete(threadId);
      const context = this.registry.getThread(threadId);
      if (!context?.compacting) return;
      this.finishCompaction(
        context,
        "Codex never reported that compaction finished. The session was released.",
      );
    }, this.options.compactionTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS);
    timer.unref?.();
    this.compactionBackstops.set(threadId, timer);
  }

  protected clearCompactionBackstop(threadId: string): void {
    const timer = this.compactionBackstops.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    this.compactionBackstops.delete(threadId);
  }

  /**
   * Releases the compaction hold.
   *
   * Never overrides a turn: an `abort` or a generation recovery may already have
   * moved the thread on, and compaction finishing must not drag it back to idle.
   */
  protected finishCompaction(context: ThreadContext, error?: string): void {
    this.clearCompactionBackstop(context.threadId);
    if (!context.compacting) return;
    context.compacting = false;
    if (!context.activeTurn && !context.dispatchInFlight && context.phase === "running") {
      this.registry.setPhase(context, error ? "failed" : "idle", error);
    }
    this.emitStatus(context);
    for (const sessionId of context.bridgeSessionIds) {
      if (error) {
        this.options.emit({ type: "session.error", sessionId, data: { error } });
        continue;
      }
      this.options.emit({
        type: "session.updated",
        sessionId,
        data: { compacted: true, compacting: false },
      });
      this.options.emit({
        type: "session.idle",
        sessionId,
        data: {
          title: this.registry.getSession(sessionId)?.title,
          phase: context.phase,
        },
      });
    }
    this.notifyThreadActivity();
  }

  async steerSession(
    sessionId: string,
    input: string,
    expectedTurnId: string,
    requestId: string,
  ): Promise<"accepted" | "not-found" | "idle" | "mismatch" | "unknown"> {
    const session = this.registry.getSession(sessionId);
    const context = this.registry.getThreadForSession(sessionId);
    const turn = context?.activeTurn;
    if (!session?.threadId || !context) return "not-found";
    const inputDigest = createHash("sha256").update(input).digest("hex");
    const previous = this.steerRequests.get(requestId);
    if (previous) {
      // Reusing an id for different input or a different target cannot be
      // interpreted safely. Do not dispatch either version again.
      if (
        previous.threadId !== session.threadId
        || previous.turnId !== expectedTurnId
        || previous.inputDigest !== inputDigest
      ) {
        return "unknown";
      }
      if (previous.state === "accepted") return "accepted";

      try {
        const reconciled = await this.options.engine.reconcileRequest(session.threadId, requestId);
        if (
          (reconciled.result === "attach" || reconciled.result === "terminal")
          && reconciled.turnId === expectedTurnId
        ) {
          this.rememberSteerRequest(requestId, { ...previous, state: "accepted" });
          await this.options.engine.drainNotifications(session.threadId);
          // The original attempt is when this steer reached app-server, so it,
          // not now, is the instant that divides the two rows. Using `now` here
          // would sweep everything Codex has produced since into the row above.
          await this.appendAcceptedSteer(context, input, expectedTurnId, {
            requestedAt: previous.requestedAt,
            precedingItemIds: reconciled.precedingItemIds,
            followingItemIds: reconciled.followingItemIds,
          });
          return "accepted";
        }
        // A successful authoritative read found no matching client id, proving
        // the ambiguous write did not land. It is now safe to try the same id.
        this.steerRequests.delete(requestId);
      } catch {
        return "unknown";
      }
    }

    if (!turn || phaseToExternalStatus(context.phase) !== "running") return "idle";
    // Pin steering to the turn the renderer observed. The engine repeats this
    // check atomically, but rejecting the already-stale request here avoids an
    // RPC and makes the ordinary race unambiguous to the caller.
    if (turn.turnId !== expectedTurnId) return "mismatch";

    // The browser deliberately retains the same id after an ambiguous response.
    // The bounded cache above covers the normal retry, while this authoritative
    // read closes the bridge-restart and cache-eviction gaps. Steering is rare;
    // paying one read is preferable to ever applying the same instruction twice.
    try {
      const reconciled = await this.options.engine.reconcileRequest(session.threadId, requestId);
      if (reconciled.result === "attach" || reconciled.result === "terminal") {
        if (reconciled.turnId !== expectedTurnId) return "mismatch";
        this.rememberSteerRequest(requestId, {
          threadId: session.threadId,
          turnId: expectedTurnId,
          inputDigest,
          state: "accepted",
          requestedAt: new Date(this.now()).toISOString(),
        });
        // A request found after cache loss came from an earlier runtime. Its
        // transcript is already authoritative; appending here would duplicate it.
        return "accepted";
      }
    } catch {
      this.rememberSteerRequest(requestId, {
        threadId: session.threadId,
        turnId: expectedTurnId,
        inputDigest,
        state: "unknown",
        requestedAt: new Date(this.now()).toISOString(),
      });
      return "unknown";
    }

    const attemptedAt = new Date(this.now()).toISOString();
    try {
      await this.options.engine.steerTurn(
        session.threadId,
        expectedTurnId,
        [{ type: "text", text: input }],
        requestId,
      );
      let ordering: SteerOrdering = {};
      try {
        const reconciled = await this.options.engine.reconcileRequest(
          session.threadId,
          requestId,
        );
        if (reconciled.turnId === expectedTurnId) {
          ordering = {
            precedingItemIds: reconciled.precedingItemIds,
            followingItemIds: reconciled.followingItemIds,
          };
        }
      } catch {
        // The steer response itself is authoritative. A failed ordering read
        // falls back to the live boundary rather than changing acceptance.
      }
      await this.options.engine.drainNotifications(session.threadId);
      // Stamped only once app-server has acknowledged the steer, and once the
      // ordering read it is paired with has been taken. Sampling before the RPC
      // dated the row boundary earlier than the steer could possibly have
      // landed, so anything Codex emitted during the round-trip was attributed
      // to the row below while its item stayed in the row above.
      const requestedAt = new Date(this.now()).toISOString();
      this.rememberSteerRequest(requestId, {
        threadId: session.threadId,
        turnId: expectedTurnId,
        inputDigest,
        state: "accepted",
        requestedAt,
      });
      await this.appendAcceptedSteer(context, input, expectedTurnId, {
        requestedAt,
        ...ordering,
      });
      return "accepted";
    } catch (error) {
      // A structured rejection that explicitly says the expected turn is stale
      // proves the text was not applied. Transport failures (including timeout
      // and process exit) are ambiguous: the write may have landed before the
      // response was lost, so they must never be described as unsent.
      if (
        error instanceof AppServerRpcError
        && (
          /expectedTurnId.*(?:match|stale)/i.test(error.message)
          || /expected\s+turn(?:\s+id)?.*(?:match|stale)/i.test(error.message)
          || /no longer accepting input/i.test(error.message)
        )
      ) {
        return "mismatch";
      }
      this.rememberSteerRequest(requestId, {
        threadId: session.threadId,
        turnId: expectedTurnId,
        inputDigest,
        state: "unknown",
        requestedAt: attemptedAt,
      });
      return "unknown";
    }
  }

  protected rememberSteerRequest(
    requestId: string,
    record: {
      threadId: string;
      turnId: string;
      inputDigest: string;
      state: "accepted" | "unknown";
      requestedAt: string;
    },
  ): void {
    // Refresh insertion order so the cap retains the most recently used ids.
    this.steerRequests.delete(requestId);
    this.steerRequests.set(requestId, record);
    while (this.steerRequests.size > MAX_STEER_REQUESTS) {
      const oldest = this.steerRequests.keys().next().value;
      if (typeof oldest !== "string") break;
      this.steerRequests.delete(oldest);
    }
  }

  protected async appendAcceptedSteer(
    context: ThreadContext,
    input: string,
    turnId: string,
    ordering: SteerOrdering & { requestedAt: string },
  ): Promise<void> {
    // app-server persists a successful steer as another user message inside the
    // active turn. Its live userMessage item is intentionally not rendered by
    // the engine reducer, so split the current assistant stream at the accepted
    // item boundary and append the text between the two assistant rows. A
    // detach/re-attach reconstructs this same shape from rollout record order.
    const turn = context.activeTurn;
    if (!turn || turn.turnId !== turnId) return;
    const state = this.stateFor(context.threadId);
    const boundary = turn.freezeAssistantSegment(
      turn.boundaryAfterItems(ordering),
      ordering.requestedAt,
    );

    // Finish the pre-steer row before announcing the user message. The
    // coalescer serializes this against a render already in flight, while the
    // frozen boundary prevents items arriving during the await from leaking
    // above the steer.
    await state.coalescer.flushNow();

    const userMessage = this.appendUserMessage(context, input, []);
    userMessage.turnId = turnId;
    const previousAssistant = context.messages.find(
      (message) => message.id === turn.assistantMessageId,
    );
    const assistantMessage: NormalizedMessage = {
      id: createMessageId(),
      role: "assistant",
      content: "",
      parts: [],
      createdAt: new Date(this.now()).toISOString(),
      turnId,
      revision: 1,
      ...(previousAssistant?.modelId ? { modelId: previousAssistant.modelId } : {}),
      ...(previousAssistant?.planReview ? { planReview: true } : {}),
    };
    context.messages.push(assistantMessage);
    state.historicalAssistantSegments.set(turn.assistantMessageId, {
      render: state.render,
      publishedParts: state.publishedParts.slice(),
      ...(state.publishedModelId ? { publishedModelId: state.publishedModelId } : {}),
    });
    // `Map` iterates in insertion order, so the first key is the oldest row.
    // Dropping it stops that row re-rendering; its published parts stand and the
    // rollout can rebuild it exactly on the next hydration. Deliberately *not*
    // `releaseTurnRenderState`: every row shares one `fileChange` context, so
    // releasing a historical row would clear the live row's diff baselines.
    while (state.historicalAssistantSegments.size > MAX_HISTORICAL_ASSISTANT_SEGMENTS) {
      const oldest = state.historicalAssistantSegments.keys().next().value;
      if (typeof oldest !== "string") break;
      state.historicalAssistantSegments.delete(oldest);
    }
    turn.startAssistantSegment(assistantMessage.id, boundary, ordering.requestedAt);
    state.render = beginTurnRenderState(state.render);
    state.assistantMessageId = assistantMessage.id;
    state.publishedMessageId = assistantMessage.id;
    state.publishedParts = [];
    state.publishedModelId = assistantMessage.modelId;
    this.bumpMessageRevision(context);
    for (const id of context.bridgeSessionIds) {
      this.options.emit({ type: "message.updated", sessionId: id, data: { message: userMessage } });
      this.options.emit({
        type: "message.updated",
        sessionId: id,
        data: { message: assistantMessage },
      });
    }

    // Items can arrive after the boundary while the old row is flushing. Make
    // their suffix visible immediately instead of waiting for another engine
    // event to happen to schedule the new row.
    await state.coalescer.flushNow();
    this.emitStatus(context);
  }

  async startNativeReview(
    sessionId: string,
    target:
      | { type: "uncommittedChanges" }
      | { type: "baseBranch"; branch: string }
      | { type: "commit"; sha: string; title: string | null }
      | { type: "custom"; instructions: string },
  ): Promise<
    | { outcome: "accepted"; turnId: string }
    // Split rather than a union of literals in one member, so a route that has
    // handled the three failures narrows to the accepted shape.
    | { outcome: "not-found" }
    | { outcome: "running" }
    | { outcome: "unavailable" }
  > {
    const session = this.registry.getSession(sessionId);
    if (!session?.threadId) return { outcome: "not-found" };
    const context = await this.ensureAttached(sessionId);
    if (!context) return { outcome: "not-found" };

    /**
     * Close the overlap window *before* the first await, exactly as the prompt
     * path does.
     *
     * `review/start` is a full RPC round-trip. Checking liveness and only then
     * awaiting left the thread reading idle to `assertNoActiveTurn` for its whole
     * duration, so a `/prompt` arriving in the gap was accepted, registered its
     * own accumulator, and was then silently replaced when the review turn was
     * assigned — its `turn.completed` classified stale and dropped, leaving the
     * thread `running` on a turn nothing would ever complete.
     */
    try {
      this.registry.assertNoActiveTurn(context);
    } catch {
      return { outcome: "running" };
    }
    const phaseBeforeReview = context.phase;
    const errorBeforeReview = context.error;
    context.dispatchInFlight = true;
    this.registry.setPhase(context, "starting");

    const assistantMessage: NormalizedMessage = {
      id: createMessageId(),
      role: "assistant",
      content: "",
      parts: [],
      createdAt: new Date(this.now()).toISOString(),
      revision: 1,
      ...(context.modelId ? { modelId: context.modelId } : {}),
    };
    const streamingState = this.stateFor(context.threadId);
    streamingState.publishedMessageId = assistantMessage.id;
    streamingState.publishedParts = [];
    streamingState.publishedModelId = assistantMessage.modelId;
    context.messages.push(assistantMessage);
    this.bumpMessageRevision(context);
    for (const id of context.bridgeSessionIds) {
      this.options.emit({
        type: "message.updated",
        sessionId: id,
        data: { message: assistantMessage },
      });
    }

    try {
      const review = await this.options.engine.startReview(
        session.threadId,
        target,
        "inline",
      );
      const accumulator = new TurnAccumulator({
        threadId: context.threadId,
        turnId: review.turnId,
        engineGeneration: this.options.engine.info().generation,
        assistantMessageId: assistantMessage.id,
        expectsStructuredOutput: false,
        startedAt: context.turnStartedAt,
      });
      accumulator.markRunning();
      assistantMessage.turnId = review.turnId;
      context.activeTurn = accumulator;
      context.dispatchInFlight = false;
      this.registry.setPhase(context, "running");
      // Re-read: generation-change recovery can release this thread's runtime
      // state while `startReview` is in flight, and `stateFor` then hands every
      // later reader a *different* object. Writing the streaming identity to the
      // pre-dispatch reference would leave the live state without an
      // `assistantMessageId`, so `publishAssistantMessage` returns early and the
      // turn runs without ever streaming.
      const liveState = this.stateFor(context.threadId);
      this.beginAssistantTurnRender(liveState, assistantMessage);
      this.emitStatus(context);
      this.drainPendingEvents(context, review.turnId);
      return { outcome: "accepted", turnId: review.turnId };
    } catch (error) {
      context.dispatchInFlight = false;
      context.messages = context.messages.filter(
        (message) => message.id !== assistantMessage.id,
      );
      /**
       * The optimistic bubble was announced with a revision bump, so its removal
       * needs one too: a tab that was unmounted for the SSE frames reconciles on
       * `messageRevision`, and without a second bump it would keep a permanently
       * blank assistant bubble with nothing to tell it to refetch.
       */
      this.bumpMessageRevision(context);
      for (const id of context.bridgeSessionIds) {
        this.options.emit({
          type: "message.updated",
          sessionId: id,
          data: { removedMessageId: assistantMessage.id },
        });
      }
      /**
       * The *thread* did not fail — no turn ran. Marking it `failed` reported the
       * whole session as `error` because a review could not be started, which is
       * a different and much louder claim. Restore what it was.
       */
      // A child failure can move the thread to `recovering` while review/start
      // rejects. Only undo the phase while this dispatch still owns `starting`;
      // never overwrite the replacement-generation recovery guard with `idle`.
      if (context.phase === "starting") {
        this.registry.setPhase(context, phaseBeforeReview, errorBeforeReview);
      }
      this.emitStatus(context);
      const message = error instanceof Error ? error.message : "Native review failed";
      for (const id of context.bridgeSessionIds) {
        this.options.emit({ type: "session.error", sessionId: id, data: { error: message } });
      }
      return { outcome: "unavailable" };
    }
  }

  async getRuntimeHealth(sessionId: string): Promise<unknown | null> {
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    return this.options.engine.getRuntimeHealth(session.threadId ?? undefined);
  }

  /**
   * Applies a configuration change to the engine, memory and disk.
   *
   * `unavailable` and `memory-only` are deliberately distinct from `updated`: the
   * caller must be able to tell "the engine is running this" from "only this
   * process believes it". The persisted config is re-hydrated into
   * `resumeThread`/`startTurn` after a restart, and plan ↔ build is
   * read-only ↔ danger-full-access, so silently reporting success on a failed
   * write is a sandbox regression waiting for the next restart.
   */
  async updateConfig(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<"updated" | "not-found" | "running" | "unavailable" | "memory-only"> {
    const session = this.registry.getSession(sessionId);
    if (!session) return "not-found";
    await this.touchSession(sessionId);
    const context = this.registry.getThreadForSession(sessionId);
    if (context && phaseToExternalStatus(context.phase) === "running") return "running";

    const nextConfig = this.toEngineConfig(body);
    const requestedModelChanged = session.config.model !== nextConfig.model;
    let attached: ThreadContext | undefined;
    let previousConfirmedModel: string | undefined;
    try {
      // ensureAttached fast-returns a healthy current-generation context, but
      // re-resumes one invalidated by a failed generation recovery. Never update
      // configuration through a handle owned by the dead child.
      attached = await this.ensureAttached(sessionId);
      if (attached && phaseToExternalStatus(attached.phase) === "running") return "running";
      if (attached) {
        previousConfirmedModel = attached.modelId;
        if (requestedModelChanged) attached.modelId = undefined;
        // Configuration is transactional from the bridge's perspective: a failed
        // engine update must leave both memory and the durable session record on
        // the last configuration the engine actually accepted.
        await this.options.engine.configureThread(attached.engineHandle, nextConfig);
      }
    } catch (error) {
      if (attached && requestedModelChanged) {
        attached.modelId = previousConfirmedModel;
      }
      // A transient resume, an in-flight restart or an open circuit are all
      // retryable. Reported as an outcome rather than thrown so the route answers
      // 503 instead of leaking a stack trace as a 500.
      console.warn(
        `[codex-bridge] Could not apply configuration for session ${sessionId}:`,
        error instanceof Error ? error.message : error,
      );
      return "unavailable";
    }

    session.config = nextConfig;
    this.registry.touch(sessionId);
    return (await this.persistSessionVerified(session)) ? "updated" : "memory-only";
  }

  async getMessages(sessionId: string): Promise<NormalizedMessage[] | null> {
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    await this.touchSession(sessionId);

    let context: ThreadContext | undefined;
    try {
      context = await this.ensureAttached(sessionId);
    } catch (error) {
      // A read must never fail on an ambiguous re-attach. The binding is
      // deliberately preserved for the next attempt (see ensureAttached), so the
      // honest answer here is the last transcript we know about rather than a 500
      // in place of a conversation.
      console.warn(
        `[codex-bridge] Serving the last known transcript for session ${sessionId}:`,
        error instanceof Error ? error.message : error,
      );
      const known = this.registry.getThreadForSession(sessionId);
      return known ? this.messagesForSession(session, known) : [...session.localMessages];
    }
    if (!context) return [...session.localMessages];

    return this.messagesForSession(session, context);
  }

  getStatus(sessionId: string): {
    status: "idle" | "running" | "error";
    phase: SessionPhase;
    title?: string;
    error?: string;
    threadId?: string | null;
    turnId?: string;
    turnStartedAt?: string;
    requestId?: string;
    structuredOutputRequestId?: string;
    structuredOutput?: StructuredOutputResult;
    contextUsage?: EngineUsageSnapshot;
    unconfirmedDispatch?: { requestId: string; retryable: boolean };
    engineGeneration: number;
    messageRevision: number;
  } | null {
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    void this.touchSession(sessionId);
    const context = this.registry.getThreadForSession(sessionId);
    // A restored thread whose journal record has not been settled yet may still
    // be executing its last turn. `idle` here would let the build pipeline
    // advance on a turn whose fate is unknown.
    const awaitingRecovery =
      session.threadId !== null
      && this.threadsAwaitingDispatchRecovery.has(session.threadId);
    const phase = context?.phase ?? (awaitingRecovery ? "recovering" : "idle");
    const latestDispatch = this.journal.latestForSession(sessionId);

    return {
      // Keeps the pre-migration contract; `phase` carries the new detail.
      status: phaseToExternalStatus(phase),
      phase,
      title: session.title,
      error: context?.error,
      threadId: session.threadId,
      turnId: context?.activeTurn?.turnId,
      turnStartedAt: context?.turnStartedAt,
      requestId: context?.activeTurn?.requestId,
      ...(latestDispatch?.state === "retryable"
        ? {
            unconfirmedDispatch: {
              requestId: latestDispatch.requestId,
              retryable: true,
            },
          }
        : {}),
      structuredOutputRequestId: session.structuredOutputRequestId,
      structuredOutput: session.structuredOutput,
      contextUsage: session.threadId
        ? this.usageByThread.get(session.threadId)
        : undefined,
      engineGeneration: this.options.engine.info().generation,
      messageRevision: session.messageRevision,
    };
  }

  /**
   * Whether a session is doing work, waiting on a human, idle, or gone.
   *
   * Deliberately synchronous and side-effect free: it must never call
   * `touchSession`, `registry.touch` or `ensureAttached`. The backend polls this
   * for *every* persisted session every couple of seconds, and a touch on that
   * cadence keeps `lastAccessed` permanently inside the idle window, so
   * `detachableThreads` never yields and `sweepIdle` never frees anything — the
   * bridge would accumulate every transcript, render state and app-server
   * subscription it has ever touched. For the same reason a detached thread is
   * read as detached rather than transparently re-attached: a poll must not
   * resurrect a conversation nobody is looking at.
   */
  getActivity(sessionId: string): "idle" | "working" | "waiting" | "missing" {
    const session = this.registry.getSession(sessionId);
    // In-band, so the caller can tell "this session is gone" apart from "this
    // bridge does not have the route" (see the /session/:id/activity handler).
    if (!session) return "missing";

    const context = this.registry.getThreadForSession(sessionId);
    // Same rule as `getStatus`: a restored thread whose journal record has not
    // been settled yet may still be executing its last turn.
    const awaitingRecovery =
      session.threadId !== null
      && this.threadsAwaitingDispatchRecovery.has(session.threadId);
    const phase = context?.phase ?? (awaitingRecovery ? "recovering" : "idle");

    // `starting`, `cancelling` and `recovering` all map to `running`. Reporting
    // any of them as idle would let the build pipeline advance on a turn that
    // may still be executing.
    if (phaseToExternalStatus(phase) !== "running") return "idle";
    return this.hasParkedInput(session) ? "waiting" : "working";
  }

  /**
   * Whether a card is parked on this session's thread awaiting a human.
   *
   * Same thread-matching rule as `listApprovals`/`listInteractions`, without
   * materializing their arrays — this runs on the backend's activity poll, once
   * per session, every couple of seconds.
   */
  protected hasParkedInput(session: BridgeSession): boolean {
    if (!session.threadId) return false;
    for (const entry of this.pendingApprovals.values()) {
      if (entry.request.threadId === session.threadId) return true;
    }
    for (const entry of this.pendingInteractions.values()) {
      if (entry.request.threadId === session.threadId) return true;
    }
    return false;
  }

  getStructuredOutput(
    sessionId: string,
    requestId?: string,
  ): { requestId?: string; structuredOutput: StructuredOutputResult | null } | null {
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    void this.touchSession(sessionId);
    if (
      requestId
      && session.structuredOutputRequestId
      && requestId !== session.structuredOutputRequestId
    ) {
      return { requestId, structuredOutput: null };
    }
    return {
      requestId: session.structuredOutputRequestId,
      structuredOutput: session.structuredOutput ?? null,
    };
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.registry.getSession(sessionId);
    if (!session) return false;

    // Answered before the registry drops the thread, so the router can still map
    // the approval to a session and the pending turn is not left waiting on a
    // prompt whose UI has gone away.
    const { removedThread } = this.registry.releaseSession(sessionId);
    this.lastPersistedAccess.delete(sessionId);
    await this.store.remove(sessionId).catch(() => undefined);

    if (removedThread) {
      // Only the final tab releases the human decision. Another tab attached to
      // this canonical thread can still show and answer the same approval.
      this.options.engine.abandonThreadApprovals(removedThread.threadId);
      // Last reference: release the thread but never delete the rollout.
      this.releaseThreadRuntimeState(removedThread.threadId);
      await this.options.engine.unsubscribeThread(removedThread.engineHandle).catch(() => undefined);
    }
    return true;
  }

  protected async persistSession(session: BridgeSession): Promise<void> {
    if (!session.threadId) return;
    this.lastPersistedAccess.set(session.id, session.lastAccessed);
    const write = this.store
      .upsert(
        this.store.toRecord({
          bridgeSessionId: session.id,
          threadId: session.threadId,
          cwd: this.options.cwd,
          config: session.config,
          title: session.title,
          titleSource: session.titleSource,
          lastAcceptedRequestId: session.lastAcceptedRequestId,
          structuredOutputRequestId: session.structuredOutputRequestId,
          structuredOutput: session.structuredOutput,
          confirmedModelsByTurn: session.confirmedModelsByTurn,
        }),
      )
      .catch(() => undefined);
    this.pendingSessionWrites.add(write);
    try {
      await write;
    } finally {
      this.pendingSessionWrites.delete(write);
    }
  }

  /**
   * Persists and reports whether the record actually landed.
   *
   * `BridgeSessionStore.upsert` warns and resolves on failure, so an awaited
   * write proves nothing on its own. Reading the record back is the only signal
   * available from outside the store, and it is affordable on the configuration
   * path: that route is rare and user-initiated, unlike the activity heartbeat.
   *
   * A session with no thread yet has nothing durable to write, which is the
   * designed state rather than a failure.
   */
  protected async persistSessionVerified(session: BridgeSession): Promise<boolean> {
    if (!session.threadId) return true;
    await this.persistSession(session);
    return this.isSessionConfigPersisted(session);
  }

  protected async isSessionConfigPersisted(session: BridgeSession): Promise<boolean> {
    if (!session.threadId) return true;
    try {
      const persisted = (await this.store.load()).find(
        (record) => record.bridgeSessionId === session.id,
      );
      if (!persisted) return false;
      // Round-tripped so both sides drop `undefined` members identically; key
      // order is the store's own serialization of this same object.
      return (
        JSON.stringify(persisted.config)
        === JSON.stringify(JSON.parse(JSON.stringify(session.config)))
      );
    } catch {
      return false;
    }
  }

  async getConfig(sessionId: string): Promise<{
    model?: string;
    modelReasoningEffort?: string;
    mode: ConversationMode;
    fastMode: boolean;
    durable: boolean;
  } | null> {
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    await this.touchSession(sessionId);
    return {
      ...(session.config.model ? { model: session.config.model } : {}),
      ...(session.config.reasoningEffort
        ? { modelReasoningEffort: session.config.reasoningEffort }
        : {}),
      mode: session.config.mode,
      fastMode: session.config.serviceTier === "fast",
      durable: await this.isSessionConfigPersisted(session),
    };
  }

  /**
   * Updates the in-memory activity clock and periodically carries it to disk.
   *
   * The interval shrinks for deliberately short retention windows, which keeps
   * the invariant that at least one heartbeat is possible before expiry.
   */
  protected touchSession(sessionId: string): Promise<void> {
    this.registry.touch(sessionId);
    const session = this.registry.getSession(sessionId);
    if (!session?.threadId) return Promise.resolve();

    const retentionMs = this.options.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS;
    const persistIntervalMs = retentionMs > 0
      ? Math.min(DEFAULT_SESSION_ACTIVITY_PERSIST_INTERVAL_MS, Math.max(1, retentionMs / 2))
      : DEFAULT_SESSION_ACTIVITY_PERSIST_INTERVAL_MS;
    const lastPersisted = this.lastPersistedAccess.get(sessionId) ?? 0;
    if (session.lastAccessed - lastPersisted < persistIntervalMs) return Promise.resolve();

    // Reserve the interval before awaiting the store so concurrent status polls
    // coalesce onto one write instead of all observing the old timestamp.
    this.lastPersistedAccess.set(sessionId, session.lastAccessed);
    return this.persistSession(session);
  }

  // ------------------------------------------------------------------ prompt

  /**
   * Accepts a prompt, guaranteeing at-most-once execution.
   *
   * The whole body runs under the thread's dispatch lock so two tabs cannot both
   * observe an idle thread and both dispatch.
   */

}
