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
import { AppServerRuntimeSessions } from "./app-server-runtime-sessions.js";
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
import { toEngineInput } from "./app-server-runtime-helpers.js";


export abstract class AppServerRuntimePrompt extends AppServerRuntimeSessions {
  async prompt(
    sessionId: string,
    input: {
      prompt: string;
      requestId?: string;
      attachments: PromptAttachmentInput[];
      outputSchema?: JsonSchema;
    },
  ): Promise<
    | { ok: true; result: PromptAcceptedResult }
    | { ok: false; status: 400 | 404 | 409 | 503; error: string }
  > {
    const session = this.registry.getSession(sessionId);
    if (!session) return { ok: false, status: 404, error: "Session not found" };
    if (!input.requestId?.trim()) {
      return { ok: false, status: 400, error: "requestId is required" };
    }
    await this.touchSession(sessionId);
    // Startup recovery may still be deciding whether this thread's last turn is
    // running. Dispatching underneath it would race that decision.
    await this.dispatchRecovery;

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

  protected async dispatchPrompt(
    session: BridgeSession,
    input: {
      prompt: string;
      requestId?: string;
      attachments: PromptAttachmentInput[];
      outputSchema?: JsonSchema;
    },
  ): Promise<
    | { ok: true; result: PromptAcceptedResult }
    | { ok: false; status: 400 | 404 | 409 | 503; error: string }
  > {
    const requestId = input.requestId!;
    await this.generationRecovery;

    // 1. Has this exact request been seen? Never dedupe on prompt text — the same
    //    text under a new id is a legitimately different turn.
    {
      const decision = this.journal.classify(requestId);
      if (decision.action === "blocked") {
        return {
          ok: false,
          status: 503,
          error: decision.reason ?? "Dispatch journal is unavailable",
        };
      }
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
            ...(decision.record?.threadId
              && this.registry.getThread(decision.record.threadId)?.turnStartedAt
              ? {
                  turnStartedAt:
                    this.registry.getThread(decision.record.threadId)!.turnStartedAt,
                }
              : {}),
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
              ...(this.registry.getThread(decision.record.threadId)?.turnStartedAt
                ? {
                    turnStartedAt:
                      this.registry.getThread(decision.record.threadId)!.turnStartedAt,
                  }
                : {}),
              duplicate: true,
            },
          };
        }
        // Absent: proven not to have run, so dispatching once is safe.
        await this.journal.forget(requestId);
      }
    }

    // `/steer` is reserved even for a schema-constrained prompt. Structured
    // output bypasses other local commands so the provider can satisfy the
    // schema, but allowing this command through would start a brand-new model
    // turn containing raw steering text.
    if (parseCodexSteerCommand(input.prompt) && input.outputSchema) {
      return {
        ok: false,
        status: 400,
        error: "/steer cannot be used with structured output",
      };
    }
    if (parseCodexSteerCommand(input.prompt)) {
      const resolvedSteer = await this.resolveSlashCommand(session, input.prompt, this.options.cwd);
      if (resolvedSteer?.kind === "builtin") {
        this.emitLocalResponse(session, input.prompt, resolvedSteer.response);
        return { ok: true, result: { status: "processing", requestId } };
      }
    }

    if (input.outputSchema) {
      session.structuredOutput = undefined;
      session.structuredOutputRequestId = requestId;
    }

    // Re-attach first: without this a detached session would fall through to
    // `thread/start` below and silently fork a second thread, orphaning the
    // conversation the user was looking at.
    let context = await this.ensureAttached(session.id);
    this.registry.assertNoActiveTurn(context);

    // 2. A persistent child snapshots its environment at launch, so re-read
    //    managed runtime variables and restart before dispatching if they moved.
    const generationBeforeDrain = this.options.engine.info().generation;
    // This thread is excluded from its own drain. The wait runs inside the
    // supervisor's `drainPromise` and every RPC queues behind it, so waiting on
    // work this call is itself about to perform would be a wait on ourselves.
    const drainingThreadId = context?.threadId ?? null;
    await this.options.engine.ensureEnvironmentIsCurrent({
      hasActiveTurns: () => this.hasActiveWorkOtherThan(drainingThreadId),
      waitForIdle: () =>
        this.waitForAllThreadsIdle(generationBeforeDrain, { excludeThreadId: drainingThreadId }),
    });
    // A controlled environment restart and an unexpected child death both
    // announce the new generation before ensureEnvironmentIsCurrent resolves.
    // Recovery refreshes handles and reconciles active turns; never dispatch on
    // the pre-restart context while that work is still in flight.
    await this.generationRecovery;
    context = await this.ensureAttached(session.id);
    this.registry.assertNoActiveTurn(context);

    // 3. Local slash commands never reach the model.
    const cwd = this.options.cwd;
    // Structured turns must reach the provider. A local slash-command response is
    // plaintext and can never satisfy the caller's schema.
    const resolved = input.outputSchema
      ? undefined
      : await this.resolveSlashCommand(session, input.prompt, cwd);
    if (resolved?.kind === "builtin") {
      this.emitLocalResponse(session, input.prompt, resolved.response);
      return { ok: true, result: { status: "processing", requestId } };
    }

    const executionPrompt = resolved?.kind === "prompt" ? resolved.expandedPrompt : input.prompt;
    const parsed = parseSlashCommandPrompt(executionPrompt);
    const bypassModeWrapper = !!parsed && isCodexCliNativeSlashCommand(parsed.name);
    const isPlanReview = session.config.mode === "plan" && !bypassModeWrapper;
    let confirmedModelForTurn: string | undefined;

    // 4. Lazily create the Codex thread on first prompt.
    if (!context) {
      const thread = await this.options.engine.startThread({ config: session.config });
      if (!thread.id) return { ok: false, status: 503, error: "Codex did not return a thread id" };
      // A new thread means a new rollout on disk; the next /session/list must
      // not answer from a catalog scanned before it existed.
      invalidateTranscriptCatalogCache();
      context = this.registry.attach(session.id, thread.id, {
        engineHandle: thread.handle,
        engineGeneration: this.options.engine.info().generation,
        cwd: thread.cwd,
        modelId: thread.model,
      });
      // The top-level response value is the engine-observed setting for this
      // accepted thread. Later settings/reroute notifications supersede it.
      confirmedModelForTurn = thread.model;
      await this.persistSession(session);
    } else if (context.modelId) {
      confirmedModelForTurn = context.modelId;
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
      revision: 1,
      ...(confirmedModelForTurn ? { modelId: confirmedModelForTurn } : {}),
      ...(isPlanReview ? { planReview: true } : {}),
    };
    const streamingState = this.stateFor(context.threadId);
    streamingState.publishedMessageId = assistantMessage.id;
    streamingState.publishedParts = [];
    streamingState.publishedModelId = assistantMessage.modelId;
    context.messages.push(assistantMessage);
    this.bumpMessageRevision(context);

    this.applyPromptTitle(session, context, input.prompt);
    const provisionalSessionIds = [...context.bridgeSessionIds];
    let provisionalMessagesRetracted = false;
    const retractProvisionalMessages = () => {
      if (provisionalMessagesRetracted) return;
      provisionalMessagesRetracted = true;
      this.retractPromptMessages(
        context!,
        provisionalSessionIds,
        [userMessage.id, assistantMessage.id],
      );
    };
    // Set only after app-server explicitly says an initial attempt did not run.
    // It stays true throughout retry preparation, where any failure is still a
    // definite non-dispatch, and clears immediately before the replacement
    // turn/start enters its own ambiguous write window.
    let dispatchDefinitelyDidNotRun = false;
    for (const id of provisionalSessionIds) {
      // Direct renderer sends already have an optimistic user row, but prompts
      // dispatched by the backend queue do not. Publish the authoritative user
      // row as well as the assistant placeholder so every mounted client sees
      // the complete turn immediately. The renderer reconciles this echo with
      // any matching optimistic row.
      this.options.emit({ type: "message.updated", sessionId: id, data: { message: userMessage } });
      this.options.emit({ type: "message.updated", sessionId: id, data: { message: assistantMessage } });
    }
    this.emitStatus(context);

    const promptWithRecoveredContext = session.recoveredContextPending
      ? buildRecoveredContextPrompt(session.localMessages, executionPrompt)
      : executionPrompt;
    const engineInput: EngineUserInput[] = toEngineInput(
      bypassModeWrapper
        ? promptWithRecoveredContext
        : wrapPromptForConversationMode(promptWithRecoveredContext, session.config.mode),
      input.attachments,
    );

    try {
      // 5. Journal *before* the write: everything from here to `markAccepted` is
      //    the ambiguous window.
      await this.journal.markPrepared({
        requestId,
        bridgeSessionId: session.id,
        threadId: context.threadId,
      });

      const startTurn = () => this.options.engine.startTurn({
        handle: context!.engineHandle,
        input: engineInput,
        config: session.config,
        requestId,
        outputSchema: input.outputSchema,
      });
      let turn;
      try {
        turn = await startTurn();
      } catch (error) {
        const failure = this.options.engine.classifyFailure(error);
        if (
          !requestId.startsWith("initial-prompt:")
          || !failure.retryImmediately
        ) {
          throw error;
        }
        dispatchDefinitelyDidNotRun = true;
        // Overload is the sole definite rejection: app-server guarantees the
        // turn did not run. Persist that fact throughout the delay so a bridge
        // shutdown cannot erase the only evidence that reusing this id is safe.
        // Generation recovery can start as soon as the failed request exposes a
        // dead child. It clears an unmaterialized context's `messages` property
        // when detaching that thread, so retain the actual array before the first
        // await in this recovery path. Capturing it after the journal write left
        // a race where the replacement turn ran with an empty local transcript.
        const retryMessages = context.messages;
        await this.journal.markRetryable(requestId);
        await new Promise((resolve) => setTimeout(
          resolve,
          this.options.initialPromptRetryDelayMs ?? DEFAULT_INITIAL_PROMPT_RETRY_DELAY_MS,
        ));
        let liveSession = this.registry.getSession(session.id);
        if (this.stopping || liveSession !== session) {
          context.dispatchInFlight = false;
          // The phase was moved to `starting` before the dispatch, and `starting`
          // reports `running`. Settling it is not optional: the thread can outlive
          // this bridge session (another tab may share it, and `releaseSession`
          // only drops the thread once the last reference goes), so an unsettled
          // context would 409 every later prompt with nothing scheduled to
          // resolve it. `failed` rather than `idle` because it carries the reason
          // to the surviving tabs, and it matches the rejected-dispatch exit
          // below — the overload already proved this turn did not run, so this is
          // not a `cancelling`/`recovering` phase that must keep reporting busy.
          if (liveSession === session) {
            retractProvisionalMessages();
            this.registry.setPhase(context, "failed", "Codex bridge is stopping");
            this.emitStatus(context);
            // The marker was persisted before the delay, so shutdown can return
            // without launching work or writing new state after engine stop.
            return { ok: false, status: 503, error: "Codex bridge is stopping" };
          }
          retractProvisionalMessages();
          this.registry.setPhase(context, "failed", "Session was deleted before its retry");
          this.emitStatus(context);
          // A deleted session has no consumer to rehydrate this marker and must
          // never launch work after its final tab has gone away.
          await this.journal.forget(requestId);
          return { ok: false, status: 404, error: "Session not found" };
        }

        // The child may restart while the retry is deliberately delayed. Wait
        // for generation recovery, then resolve the handle again instead of
        // dispatching through the closure's pre-restart context. An initial
        // prompt's empty thread has no rollout and is intentionally discarded by
        // generation recovery, so recreate it and carry the already-published
        // optimistic transcript onto the replacement context.
        await this.generationRecovery;
        liveSession = this.registry.getSession(session.id);
        if (this.stopping || liveSession !== session) {
          context.dispatchInFlight = false;
          const message = this.stopping
            ? "Codex bridge stopped during retry recovery"
            : "Session was deleted during retry recovery";
          retractProvisionalMessages();
          this.registry.setPhase(context, "failed", message);
          this.emitStatus(context);
          if (liveSession !== session) await this.journal.forget(requestId);
          return {
            ok: false,
            status: liveSession === session ? 503 : 404,
            error: message,
          };
        }
        const staleContext = context;
        let reboundContext = await this.ensureAttached(session.id);
        // The replacement child can still be inside supervisor startup when the
        // delay expires. In that case the wait above observes the prior settled
        // recovery; ensureAttached is the RPC that finishes startup and publishes
        // the new generation event. Wait again, then discard any context that
        // recovery detached while that RPC was in flight.
        await this.generationRecovery;
        reboundContext = this.registry.getThreadForSession(session.id);
        if (reboundContext) {
          context = reboundContext;
          // Recovery can win the race and create the replacement canonical
          // context before this retry resumes. That context may have hydrated an
          // empty, not-yet-materialized rollout, so carry the optimistic exchange
          // just as the explicit thread/start path below does. Merge by id in
          // case re-attachment did recover part of the same transcript.
          if (context.messages !== retryMessages) {
            const reboundMessageIds = new Set(context.messages.map((message) => message.id));
            context.messages.push(
              ...retryMessages.filter((message) => !reboundMessageIds.has(message.id)),
            );
          }
        } else {
          let thread;
          try {
            thread = await this.options.engine.startThread({ config: session.config });
          } catch (error) {
            const message = error instanceof Error
              ? error.message
              : "Codex failed to create a replacement thread";
            staleContext.dispatchInFlight = false;
            retractProvisionalMessages();
            this.registry.setPhase(staleContext, "failed", message);
            this.emitStatus(staleContext);
            return { ok: false, status: 503, error: message };
          }
          if (!thread.id) {
            const message = "Codex did not return a thread id";
            staleContext.dispatchInFlight = false;
            retractProvisionalMessages();
            this.registry.setPhase(staleContext, "failed", message);
            this.emitStatus(staleContext);
            return { ok: false, status: 503, error: message };
          }
          invalidateTranscriptCatalogCache();
          context = this.registry.attach(session.id, thread.id, {
            engineHandle: thread.handle,
            engineGeneration: this.options.engine.info().generation,
            cwd: thread.cwd,
            modelId: thread.model,
          });
          if (thread.model) {
            confirmedModelForTurn = thread.model;
            assistantMessage.modelId = thread.model;
          }
        }
        // Close the overlap window before the first await below, exactly as the
        // main dispatch path does. Recovery leaves a re-attached thread `idle`
        // with `turnStartedAt` cleared, so this also restores the busy state a
        // shared tab needs to see; `starting` reports `running`.
        context.dispatchInFlight = true;
        this.registry.setPhase(context, "starting");
        if (context !== staleContext) {
          // Only the replacement-thread branch above can reach this today: every
          // path that removes a thread from the registry also clears the session
          // binding, so `ensureAttached` returns undefined rather than a second
          // context. Kept as a guard rather than an assertion because the cost is
          // one identity check, and a future rebind would otherwise silently lose
          // the optimistic exchange published before the rejected dispatch.
          context.messages = retryMessages;
          const replacementState = this.stateFor(context.threadId);
          replacementState.publishedMessageId = assistantMessage.id;
          replacementState.publishedParts = [];
          replacementState.publishedModelId = assistantMessage.modelId;
          await this.persistSession(session);
        }
        await this.journal.markPrepared({
          requestId,
          bridgeSessionId: session.id,
          threadId: context.threadId,
        });
        dispatchDefinitelyDidNotRun = false;
        turn = await startTurn();
      }
      // Both halves of the exchange, so "fork from here" works on either bubble
      // for the lifetime of this process; hydration re-derives the same ids from
      // the rollout afterwards.
      userMessage.turnId = turn.turnId;
      assistantMessage.turnId = turn.turnId;

      await this.journal.markAccepted(requestId, {
        threadId: context.threadId,
        turnId: turn.turnId,
      });
      session.lastAcceptedRequestId = requestId;
      session.recoveredContextPending = false;

      // The user message is persisted now, so the thread has a rollout and can be
      // detached and resumed later.
      context.materialized = true;
      await this.persistSession(session);

      const accumulator = new TurnAccumulator({
        threadId: context.threadId,
        turnId: turn.turnId,
        requestId,
        engineGeneration: turn.engineGeneration,
        assistantMessageId: assistantMessage.id,
        expectsStructuredOutput: input.outputSchema !== undefined,
        startedAt: context.turnStartedAt,
      });
      accumulator.markRunning();
      context.activeTurn = accumulator;
      context.engineGeneration = turn.engineGeneration;
      context.dispatchInFlight = false;
      this.registry.setPhase(context, "running");
      // Re-read: `recoverAfterGenerationChange` releases runtime state for an
      // unmaterialized thread — precisely a first prompt in flight — so the
      // reference captured before the dispatch may now be orphaned. Every later
      // reader goes through `stateFor`, and writing the streaming identity to a
      // dead object would leave the turn running but never streaming.
      const liveState = this.stateFor(context.threadId);
      this.beginAssistantTurnRender(liveState, assistantMessage);

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
          turnStartedAt: context.turnStartedAt,
        },
      };
    } catch (error) {
      context.dispatchInFlight = false;
      if (error instanceof DispatchJournalAdmissionError) {
        retractProvisionalMessages();
        this.registry.setPhase(context, "failed", error.message);
        this.emitStatus(context);
        this.options.emit({
          type: "session.error",
          sessionId: session.id,
          data: { error: error.message, code: "dispatch_journal_capacity" },
        });
        return { ok: false, status: 503, error: error.message };
      }
      const classified = this.options.engine.classifyFailure(error);
      let ambiguousResolution: AmbiguousDispatchResolution | undefined;

      /**
       * A rejected dispatch definitely did not run, so the session is genuinely
       * idle again. An ambiguous one might be running: report `recovering` rather
       * than idle, so nothing advances a build phase or accepts a new prompt on a
       * turn that may still be executing.
       */
      if (classified.class === "rejected" || dispatchDefinitelyDidNotRun) {
        retractProvisionalMessages();
        this.registry.setPhase(context, "failed", classified.engineError.message);
        await this.journal.markRetryable(requestId);
      } else {
        ambiguousResolution = await this.settleAmbiguousDispatch(
          context,
          requestId,
          assistantMessage.id,
        );
        // `absent` is a *proven* non-dispatch, exactly like an explicit
        // rejection: `thread/read` is the one authority that can say the write
        // never landed, and it said no turn ever carried this request. Withdraw
        // the exchange announced before the write, or the renderer keeps a
        // prompt bubble and a blank reply for a turn that never existed — its
        // own rollback targets the optimistic id, which this turn's authoritative
        // user echo has already retired.
        //
        // `attached` and `terminal` must keep the rows: that turn really ran.
        // `recovering` is still unknown, and retracting there would erase a
        // prompt that may be executing.
        if (ambiguousResolution === "absent") retractProvisionalMessages();
      }

      if (
        ambiguousResolution === "attached"
        || ambiguousResolution === "recovering"
      ) {
        // A lost turn/start response is not a rejected prompt. The provider may
        // still be executing it, so keep structured output pending and return
        // the same accepted/processing contract as an ordinary dispatch.
        if (ambiguousResolution === "attached") {
          session.lastAcceptedRequestId = requestId;
        }
        await this.persistSession(session);
        this.emitStatus(context);
        return {
          ok: true,
          result: {
            status: "processing",
            requestId,
            threadId: context.threadId,
            ...(ambiguousResolution === "attached" && context.activeTurn
              ? { turnId: context.activeTurn.turnId }
              : {}),
            ...(context.turnStartedAt
              ? { turnStartedAt: context.turnStartedAt }
              : {}),
            duplicate: true,
          },
        };
      }

      if (input.outputSchema) {
        const marker = `${classified.engineError.code ?? ""} ${classified.engineError.message}`
          .toLowerCase();
        const compactMarker = marker.replace(/[^a-z0-9]/g, "");
        session.structuredOutput = structuredOutputFailure(
          "codex",
          (
            marker.includes("structured") && marker.includes("retr")
          ) || compactMarker.includes("structuredoutputretry")
            ? "schema_retry_exhausted"
            : "provider_error",
          classified.engineError.message,
          {
            requestId,
            details: classified.engineError.code
              ? { code: classified.engineError.code }
              : undefined,
          },
        );
        await this.persistSession(session);
        this.options.emit({
          type: "session.structured-output",
          sessionId: session.id,
          data: { structuredOutput: session.structuredOutput },
        });
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

  /**
   * Resolves an ambiguous `turn/start` failure to a definite phase.
   *
   * The dispatch is **never** re-sent — only an explicit overload proves a turn
   * did not run — but leaving the thread in `recovering` is not neutral either:
   * it reports `running`, so `assertNoActiveTurn` rejects every later prompt with
   * a 409 and the session is bricked. `thread/read` is the one authority that can
   * say whether the write landed, so ask it and settle from the answer.
   */
  protected async settleAmbiguousDispatch(
    context: ThreadContext,
    requestId: string,
    assistantMessageId: string,
    options: { forgetIfAbsent?: boolean } = {},
  ): Promise<AmbiguousDispatchResolution> {
    this.registry.setPhase(context, "recovering");
    let accumulator = context.activeTurn;
    if (!accumulator || accumulator.requestId !== requestId) {
      accumulator = new TurnAccumulator({
        threadId: context.threadId,
        turnId: unconfirmedTurnId(requestId),
        requestId,
        engineGeneration: this.options.engine.info().generation,
        assistantMessageId,
        startedAt:
          context.turnStartedAt
          ?? context.messages.find((message) => message.id === assistantMessageId)?.createdAt
          ?? new Date(this.now()).toISOString(),
        expectsStructuredOutput: [...context.bridgeSessionIds].some((sessionId) =>
          this.registry.getSession(sessionId)?.structuredOutputRequestId === requestId
        ),
      });
      accumulator.markRunning();
      context.activeTurn = accumulator;
      // `recovering` was set before the accumulator existed. Re-apply it so the
      // registry can adopt the recovered backend/rollout timestamp immediately.
      this.registry.setPhase(context, "recovering");
      // Goes through the shared helper so the publish baseline is reset with the
      // render state. Resetting only `render` left the first publish of this
      // recovered row emitting a patch against the previous turn's parts.
      const recoveredModelId = context.messages.find(
        (message) => message.id === assistantMessageId,
      )?.modelId;
      this.beginAssistantTurnRender(this.stateFor(context.threadId), {
        id: assistantMessageId,
        ...(recoveredModelId ? { modelId: recoveredModelId } : {}),
      });
    }

    // Armed before the read so a reconciliation that hangs or throws still ends
    // in a definite phase.
    this.scheduleRecoveryBackstop(context);
    let outcome: Awaited<ReturnType<AppServerEngine["reconcileRequest"]>>;
    try {
      outcome = await this.options.engine.reconcileRequest(context.threadId, requestId);
    } catch (error) {
      console.warn(
        `[codex-bridge] Could not reconcile ${requestId} on thread ${context.threadId}:`,
        error instanceof Error ? error.message : error,
      );
      return "recovering";
    }

    if (outcome.result === "attach") {
      // It really is executing. Adopt the turn so its terminal event finalizes
      // the transcript instead of arriving for a turn nobody is tracking.
      await this.journal.markAccepted(requestId, {
        threadId: context.threadId,
        turnId: outcome.turnId!,
      });
      // The turn that carried the recovered transcript did run, so the next
      // prompt must not prepend it a second time.
      this.clearRecoveredContextPending(context);
      accumulator.turnId = outcome.turnId!;
      accumulator.engineGeneration = this.options.engine.info().generation;
      this.clearRecoveryBackstop(context.threadId);
      this.registry.setPhase(context, "running");
      // Anything that arrived for this turn while it had no owner.
      this.drainPendingEvents(context, outcome.turnId!);
      return "attached";
    }

    this.clearRecoveryBackstop(context.threadId);
    context.activeTurn = null;
    if (outcome.result === "terminal") {
      await this.journal.markTerminal(requestId, outcome.status ?? "completed", {
        threadId: context.threadId,
        turnId: outcome.turnId,
      });
      // It ran to completion carrying the recovered transcript; do not resend it.
      this.clearRecoveredContextPending(context);
      this.registry.setPhase(
        context,
        outcome.status === "failed" ? "failed" : "idle",
        AMBIGUOUS_DISPATCH_FAILURE_MESSAGE,
      );
      this.notifyThreadActivity();
      return "terminal";
    }

    // Absent: provably never executed, so release the id for a clean retry.
    if (options.forgetIfAbsent !== false) {
      await this.journal.forget(requestId);
    } else {
      await this.journal.markTerminal(requestId, "failed", {
        threadId: context.threadId,
        turnId: outcome.turnId,
      });
    }
    this.registry.setPhase(context, "failed", AMBIGUOUS_DISPATCH_FAILURE_MESSAGE);
    this.notifyThreadActivity();
    return "absent";
  }

  /**
   * Escalates unresolved ambiguity by replacing the child.
   *
   * A timeout alone proves nothing about whether the turn is executing. Killing
   * its generation is the only safe way to release the overlap guard.
   */
  protected scheduleRecoveryBackstop(context: ThreadContext): void {
    this.clearRecoveryBackstop(context.threadId);
    const timeoutMs =
      this.options.ambiguousRecoveryTimeoutMs ?? DEFAULT_AMBIGUOUS_RECOVERY_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.recoveryBackstops.delete(context.threadId);
      void this.restartForAmbiguousDispatch(context.threadId);
    }, timeoutMs);
    timer.unref?.();
    this.recoveryBackstops.set(context.threadId, timer);
  }

  protected async restartForAmbiguousDispatch(threadId: string): Promise<void> {
    const context = this.registry.getThread(threadId);
    if (!context || context.phase !== "recovering") return;
    try {
      await this.options.engine
        .getSupervisor()
        .restartNow(`ambiguous dispatch on thread ${threadId}`);
      await this.generationRecovery;
    } catch (error) {
      // Safe failure: keep the overlap guard in recovering. Reporting failed/idle
      // here would permit a second turn without proof that the first stopped.
      const message =
        error instanceof Error ? error.message : "Failed to restart Codex safely";
      for (const sessionId of context.bridgeSessionIds) {
        this.options.emit({
          type: "session.error",
          sessionId,
          data: { error: message },
        });
      }
      /**
       * Re-arm rather than give up.
       *
       * A restart can fail for reasons that clear on their own — an open circuit
       * breaker, transient pidfile ownership contention. The backstop timer
       * already removed itself before calling us, so without this the thread
       * stays `recovering` (reported as `running`) with nothing left to move it,
       * and every later prompt 409s until an unrelated generation change.
       */
      const current = this.registry.getThread(threadId);
      if (current && current.phase === "recovering") {
        this.scheduleRecoveryBackstop(current);
      }
    }
  }

  /**
   * Marks the recovered-rollout transcript as delivered for every session on the
   * thread. Only the clean `markAccepted` path clears this inline; reconciliation
   * has to do the same whenever it proves the carrying turn actually ran.
   */
  protected clearRecoveredContextPending(context: ThreadContext): void {
    for (const sessionId of context.bridgeSessionIds) {
      const session = this.registry.getSession(sessionId);
      if (session) session.recoveredContextPending = false;
    }
  }

  /** Advances every bridge view of the canonical thread transcript together. */
  protected bumpMessageRevision(context: ThreadContext): void {
    for (const sessionId of context.bridgeSessionIds) {
      const session = this.registry.getSession(sessionId);
      if (session) session.messageRevision += 1;
    }
  }

  /**
   * Removes a prompt exchange that was announced before dispatch but is now
   * known not to have run. The original context can be detached during the
   * initial-prompt retry path, so clean both it and any live replacement before
   * publishing removal frames to every client that saw the provisional rows.
   */
  protected retractPromptMessages(
    context: ThreadContext,
    sessionIds: readonly string[],
    messageIds: readonly string[],
  ): void {
    const ids = new Set(messageIds);
    const contexts = new Set<ThreadContext>([context]);
    for (const sessionId of sessionIds) {
      const liveContext = this.registry.getThreadForSession(sessionId);
      if (liveContext) contexts.add(liveContext);
    }
    for (const candidate of contexts) {
      candidate.messages = candidate.messages.filter((message) => !ids.has(message.id));
    }

    for (const sessionId of sessionIds) {
      const session = this.registry.getSession(sessionId);
      if (session) session.messageRevision += 1;
      for (const removedMessageId of messageIds) {
        this.options.emit({
          type: "message.updated",
          sessionId,
          data: { removedMessageId },
        });
      }
    }
  }

  protected clearRecoveryBackstop(threadId: string): void {
    const timer = this.recoveryBackstops.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    this.recoveryBackstops.delete(threadId);
  }

  protected appendUserMessage(
    context: ThreadContext,
    prompt: string,
    attachments: PromptAttachmentInput[],
  ): NormalizedMessage {
    const parts: NormalizedPart[] = [];
    if (prompt.length > 0) parts.push({ type: "text", content: prompt });
    for (const attachment of attachments) {
      // `content` is the path, not the filename: this row has to be identical
      // to the one `extractAttachmentTags` rebuilds after a rehydration, and
      // the renderer reads the path from `content` to load the bytes. An inline
      // `dataUrl` is still preferred for `fileUrl` while we have it, since it
      // shows the thumbnail without a workspace read.
      parts.push({
        type: "file",
        content: attachment.path,
        fileUrl: attachment.dataUrl || attachment.path,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
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
  protected applyPromptTitle(session: BridgeSession, context: ThreadContext, prompt: string): void {
    if (!session.title) {
      const fallback = buildFallbackSessionTitle(prompt);
      for (const id of context.bridgeSessionIds) {
        const attached = this.registry.getSession(id);
        if (attached && !attached.title) {
          attached.title = fallback;
          attached.titleSource = "prompt";
        }
        this.options.emit({
          type: "session.title-updated",
          sessionId: id,
          data: { title: fallback },
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
          const attached = this.registry.getSession(id);
          if (attached) {
            attached.title = title;
            attached.titleSource = "generated";
            attached.titleGenerationAttempted = true;
            attached.titleGenerationToken = undefined;
            await this.persistSession(attached);
          }
          this.options.emit({ type: "session.title-updated", sessionId: id, data: { title } });
        }
      })
      .catch(() => {
        if (session.titleGenerationToken === token) session.titleGenerationToken = undefined;
        console.warn("[codex-bridge] Failed to generate session title; using prompt fallback");
      });
  }

  protected async resolveSlashCommand(
    session: BridgeSession,
    prompt: string,
    cwd: string,
  ): Promise<{ kind: "prompt"; expandedPrompt: string } | { kind: "builtin"; response: string } | null> {
    // `/steer` accepts multiline free text, whereas the general slash-command
    // parser deliberately rejects newlines. Handle it first so an idle or stale
    // client never starts a fresh model turn with the raw command text.
    const steer = parseCodexSteerCommand(prompt);
    if (steer) {
      return {
        kind: "builtin",
        response: steer.args
          ? "There is no active Codex turn to steer. Start a turn, then use /steer while it is running."
          : "Usage: /steer <instructions>. Run it while a Codex turn is active.",
      };
    }

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
            (model: BridgeModel) =>
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
  protected emitLocalResponse(session: BridgeSession, prompt: string, response: string): void {
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
    // Capped: these have no rollout to fall back on and survive detaching, so
    // they are the one transcript buffer nothing else ever evicts.
    this.registry.appendLocalMessages(session, userMessage, assistantMessage);

    if (!session.title) {
      session.title = buildFallbackSessionTitle(prompt);
      session.titleSource = "prompt";
      this.options.emit({
        type: "session.title-updated",
        sessionId: session.id,
        data: { title: session.title },
      });
    }
    for (const message of [userMessage, assistantMessage]) {
      this.options.emit({
        type: "message.updated",
        sessionId: session.id,
        data: { message },
      });
    }
    this.options.emit({ type: "session.updated", sessionId: session.id });
    this.options.emit({
      type: "session.idle",
      sessionId: session.id,
      data: { title: session.title },
    });
  }

  protected messagesForSession(
    session: BridgeSession,
    context: ThreadContext,
  ): NormalizedMessage[] {
    if (session.localMessages.length === 0) return context.messages;
    // Local commands can appear between model turns. Their timestamps are the
    // only shared ordering key because they deliberately have no rollout item.
    return [...context.messages, ...session.localMessages].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  protected threadHasActiveWork(context: ThreadContext): boolean {
    return (
      context.activeTurn !== null
      || context.dispatchInFlight
      || context.compacting
      || phaseToExternalStatus(context.phase) === "running"
    );
  }

  /** Active work anywhere except the thread asking, which never waits on itself. */
  protected hasActiveWorkOtherThan(threadId: string | null | undefined): boolean {
    return this.registry
      .listThreads()
      .some((entry) => entry.threadId !== threadId && this.threadHasActiveWork(entry));
  }

  /** Wakes the drain; over-notifying is free because it re-checks the registry. */
  protected notifyThreadActivity(): void {
    if (this.idleWaiters.size === 0) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const wake of waiters) wake();
  }

  /**
   * Waits for other threads' turns to finish before the child is replaced.
   *
   * Three properties are load-bearing, because this runs inside the supervisor's
   * drain and therefore blocks *every* RPC in the environment:
   *
   *   - it is driven by turn transitions, not by a spin;
   *   - it never waits on the calling thread, which is about to dispatch itself;
   *   - it gives up at a deadline, so a turn that never reports terminal costs one
   *     interrupted turn rather than a wedged bridge.
   */
  protected async waitForAllThreadsIdle(
    expectedGeneration: EngineGeneration,
    options: { excludeThreadId?: string | null } = {},
  ): Promise<void> {
    // Deliberately real time, not the injected clock: this bounds an actual wait
    // on real timers, and a frozen test clock must not disable the deadline.
    const deadline =
      Date.now() + (this.options.environmentDrainTimeoutMs ?? DEFAULT_ENVIRONMENT_DRAIN_TIMEOUT_MS);

    while (this.hasActiveWorkOtherThan(options.excludeThreadId)) {
      if (this.stopping || this.shouldAbandonDrain(expectedGeneration)) return;
      if (Date.now() >= deadline) {
        console.warn(
          "[codex-bridge] Restarting app-server with turns still in flight: the drain deadline expired.",
        );
        return;
      }
      await this.waitForThreadActivity();
    }
  }

  /** True when nothing this drain is waiting for can still finish. */
  protected shouldAbandonDrain(expectedGeneration: EngineGeneration): boolean {
    if (this.options.engine.info().generation !== expectedGeneration) return true;
    const health = this.options.engine.getHealth();
    if (health.state === "restarting" || health.state === "failed" || health.state === "stopped") {
      return true;
    }
    // `draining` covers two cases. The environment drain that called us still
    // owns a live child, so its turns can genuinely still finish; a shutdown
    // drain has already released the generation, so nothing ever will.
    return health.state === "draining" && health.pid === null;
  }

  protected waitForThreadActivity(): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.idleWaiters.delete(wake);
        resolve();
      };
      // Backstop only: a phase change that forgets to notify must not strand the
      // drain until its deadline.
      const timer = setTimeout(() => {
        this.idleWaiters.delete(wake);
        resolve();
      }, IDLE_WAIT_POLL_MS);
      timer.unref?.();
      this.idleWaiters.add(wake);
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

}
