import { humanPromptObservation } from "@orkestrator/protocol/human-prompts";
import {
  SteerOrdering,
  DEFAULT_SESSION_RETENTION_MS,
  DEFAULT_SESSION_ACTIVITY_PERSIST_INTERVAL_MS,
  mergeAccountUsage,
  accountUsageFromLimits,
  DEFAULT_COMPACTION_TIMEOUT_MS,
  MAX_STEER_REQUESTS,
} from "./app-server-runtime-base.js";
import { inheritCommandChanges } from "./sessions/command-changes.js";
import { inheritTypedPrompts } from "./sessions/typed-prompts.js";
import type { NativeAgentReadiness } from "@orkestrator/protocol/native-agent";
import type { CodexRuntimeContext } from "./app-server-runtime-context.js";
import type { CodexRuntimeLifecycle } from "./app-server-runtime-lifecycle.js";
import { openAssistantRow } from "./app-server-runtime-rows.js";
import { createHash, randomUUID } from "node:crypto";
import {
  CODEX_SIGN_IN_REQUIRED_MESSAGE,
  type AppServerEngine,
} from "./engine/app-server-engine.js";

import type { EngineThread, EngineUsageSnapshot } from "./engine/types.js";
import {
  phaseToExternalStatus,
  type BridgeSession,
  CODEX_RESTARTED_MID_TURN_MESSAGE,
  type SessionPhase,
  type ThreadAuthNotice,
  type ThreadContext,
} from "./sessions/thread-registry.js";
import { TurnAccumulator } from "./sessions/turn-accumulator.js";

import { createMessageId, createSessionId, type NormalizedMessage } from "./messages/types.js";
import { externalRevertCut } from "./sessions/external-revert.js";

import type { ConversationMode } from "./prompts/slash-commands.js";
import {
  hydrateMessagesFromPersistedSession,
  invalidateTranscriptCatalogCache,
  clearTranscriptPathCache,
} from "./history/rollout.js";
import { normalizeExplicitSessionTitle, persistSessionTitle } from "./session-title-index.js";

import { AppServerRpcError, isMissingRolloutError } from "./app-server/errors.js";

import { type StructuredOutputResult } from "@orkestrator/protocol/structured-output";

/** Fixed, content-free refusal for work arriving while a tab close is retiring the session. */
export const SESSION_CLOSING_ERROR = "Session is closing";

/** One bridge process; see `getActivitySnapshot`'s content revision. */
const ACTIVITY_PROCESS = randomUUID();

export class CodexRuntimeSessions {
  /**
   * Admission fence for `POST /session/:id/close`.
   *
   * Set once close has decided to retire the session and cleared only when the
   * close is confirmed. While set, prompts, steers, compactions and reviews on
   * the session are refused, so nothing can start a turn between "the last turn
   * is terminal" and the release that would orphan it.
   */
  /**
   * Session objects whose removal is being (or has been) published. Their
   * records are never upserted again: a write queued behind the tombstone would
   * resurrect the session on the next start. Weak, so retired objects are not
   * retained.
   */
  readonly retiredSessions = new WeakSet<BridgeSession>();

  constructor(
    private readonly ctx: CodexRuntimeContext,
    private readonly lifecycle: CodexRuntimeLifecycle,
  ) {}

  /** True once close fenced this session, or it is no longer the registered object. */
  sessionAdmissionClosed(session: BridgeSession): boolean {
    return (
      this.ctx.closingSessionIds.has(session.id) ||
      this.ctx.registry.getSession(session.id) !== session
    );
  }

  createSession(body: Record<string, unknown>): { sessionId: string; title?: string } {
    const clientSessionKey =
      typeof body.clientSessionKey === "string" &&
      body.clientSessionKey.trim().length > 0 &&
      body.clientSessionKey.length <= 512
        ? body.clientSessionKey
        : undefined;
    const sessionId = clientSessionKey
      ? `session-client-${createHash("sha256")
          .update(this.ctx.options.cwd)
          .update("\0")
          .update(clientSessionKey)
          .digest("hex")
          .slice(0, 32)}`
      : createSessionId();
    const existing = this.ctx.registry.getSession(sessionId);
    if (existing) {
      this.ctx.registry.touch(sessionId);
      return { sessionId, title: existing.title };
    }

    const title = typeof body.title === "string" ? body.title : undefined;
    const session = this.ctx.registry.createSession({
      id: sessionId,
      // No Codex thread yet: an abandoned session must not appear in history.
      threadId: null,
      config: this.lifecycle.toEngineConfig(body),
      title,
      titleSource: title ? "explicit" : undefined,
    });
    return { sessionId: session.id, title };
  }

  async resumeSession(body: Record<string, unknown>): Promise<{
    sessionId: string;
    title?: string;
    threadId: string;
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

    const config = this.lifecycle.toEngineConfig(body);
    const sessionId = createSessionId();
    const session = this.ctx.registry.createSession({
      id: sessionId,
      threadId: null,
      config,
    });

    let thread: EngineThread;
    try {
      thread = await this.ctx.options.engine.resumeThread(threadId, { config, includeTurns: true });
    } catch (error) {
      // A resume can fail because the rollout is gone. Fall back to the parser so
      // the user still sees their conversation; the next prompt starts a fresh
      // thread with reconstructed context.
      if (!isMissingRolloutError(error)) throw error;
      const hydrated = await hydrateMessagesFromPersistedSession(threadId, {
        structuredOutputTurns: this.ctx.structuredOutputTurnsForThread(threadId),
      });
      session.title = hydrated.title;
      session.titleSource = hydrated.titleSource;
      this.ctx.registry.appendLocalMessages(session, ...hydrated.messages);
      if (hydrated.messages.length > 0) this.ctx.registry.bumpContentEpoch(session);
      session.recoveredContextPending = hydrated.messages.length > 0;
      return { sessionId, title: hydrated.title, threadId };
    }

    const modelsBeforeAttach = this.lifecycle.snapshotBoundModelOverrides(threadId);
    const context = this.ctx.registry.attach(sessionId, threadId, {
      engineHandle: thread.handle,
      engineGeneration: this.ctx.options.engine.info().generation,
      cwd: thread.cwd,
      name: thread.name,
      modelId: thread.model,
    });
    context.materialized = true;

    // Only hydrate when this is the first tab on the thread; a second tab must
    // join the existing canonical transcript rather than rebuild it.
    let unreadable = false;
    if (context.messages.length === 0) {
      const hydrated = await hydrateMessagesFromPersistedSession(threadId, {
        structuredOutputTurns: this.ctx.structuredOutputTurnsForThread(threadId),
      });
      context.messages = hydrated.messages;
      this.ctx.registry.indexHydratedAsyncQuestions(context);
      this.lifecycle.applyPersistedModelOverrides(context);
      if (hydrated.messages.length > 0) {
        this.ctx.callbacks.bumpMessageRevision(context);
        this.ctx.registry.bumpContentEpoch(session);
      }
      session.title = thread.name ?? hydrated.title;
      session.titleSource = thread.name ? "codex" : hydrated.titleSource;
      if (hydrated.readFailed) unreadable = true;
    } else {
      this.lifecycle.publishPersistedModelOverrides(context);
      const existing = this.ctx.registry
        .sessionsForThread(threadId)
        .find((entry) => entry.id !== sessionId && entry.title);
      session.title = existing?.title ?? thread.name ?? undefined;
      session.titleSource = existing?.titleSource;
    }
    // A rollout that could not be read at all is not an empty conversation:
    // leave the transcript unhydrated so readers keep reporting a cached,
    // incomplete preview (and the next attach retries) instead of an
    // authoritative empty history that would overwrite a display tail.
    if (!unreadable) context.transcriptHydrated = true;

    await this.lifecycle.synchronizeAttachedModelOverrides(context, modelsBeforeAttach);
    await this.ctx.callbacks.persistSession(session);
    return {
      sessionId,
      title: session.title,
      threadId,
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
      }
    | { outcome: "not-found" | "running" | "unknown-message" | "no-fork-point" | "unavailable" }
  > {
    const parent = this.ctx.registry.getSession(sessionId);
    if (!parent?.threadId) return { outcome: "not-found" };
    const parentContext = await this.ctx.callbacks.ensureAttached(sessionId);
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
      fork = await this.ctx.options.engine.forkThread(parent.threadId, parent.config, lastTurnId);
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
    const child = this.ctx.registry.createSession({
      id: createSessionId(),
      threadId: null,
      config: { ...parent.config },
      title: parent.title ? `${parent.title} (fork)` : "Forked session",
      titleSource: "explicit",
      confirmedModelsByTurn: { ...parent.confirmedModelsByTurn },
      structuredOutputTurns: parent.structuredOutputTurns?.map((entry) => ({ ...entry })),
    });
    try {
      const context = this.ctx.registry.attach(child.id, fork.id, {
        engineHandle: fork.handle,
        engineGeneration: this.ctx.options.engine.info().generation,
        cwd: fork.cwd,
        name: fork.name,
        modelId: fork.model,
      });
      context.materialized = true;
      // Before the first replay, so the fork's own reloads show what was typed too.
      await inheritTypedPrompts(this.ctx.options.codexHome, parent.threadId, fork.id);
      const hydrated = await hydrateMessagesFromPersistedSession(fork.id, {
        structuredOutputTurns: this.ctx.structuredOutputTurnsForThread(fork.id),
      });
      await inheritCommandChanges(
        this.ctx.options.codexHome,
        parent.threadId,
        fork.id,
        hydrated.messages,
      );
      context.messages = hydrated.messages;
      this.ctx.registry.indexHydratedAsyncQuestions(context);
      this.lifecycle.applyPersistedModelOverrides(context);
      if (hydrated.messages.length > 0) {
        this.ctx.callbacks.bumpMessageRevision(context);
        this.ctx.registry.bumpContentEpoch(child);
      }
      // A rollout that could not be read at all is not an empty conversation:
      // leave the transcript unhydrated so readers keep reporting a cached,
      // incomplete preview (and the next attach retries) instead of an
      // authoritative empty history that would overwrite a display tail.
      if (!hydrated.readFailed) context.transcriptHydrated = true;
      await this.ctx.callbacks.persistSession(child);
      return {
        outcome: "created",
        sessionId: child.id,
        title: child.title,
        threadId: fork.id,
      };
    } catch (error) {
      // The child session was registered above; failing here would leave an
      // orphan bridge session bound to a fork no client ever learned about.
      // Close it — which unsubscribes, never `thread/delete` — before reporting.
      await this.ctx.callbacks.deleteSession(child.id).catch(() => undefined);
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
  async resolveTurnIdFromEngine(
    context: ThreadContext,
    message: NormalizedMessage,
  ): Promise<string | undefined> {
    let turns: { id: string }[] | undefined;
    try {
      const thread = await this.ctx.options.engine.readThread(context.threadId, {
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
  ): Promise<"accepted" | "not-found" | "running" | "unavailable" | "closing"> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session?.threadId) return "not-found";
    if (this.sessionAdmissionClosed(session)) return "closing";
    const context = await this.ctx.callbacks.ensureAttached(sessionId);
    if (!context) return "not-found";
    if (this.sessionAdmissionClosed(session)) return "closing";
    try {
      this.ctx.registry.assertNoActiveTurn(context);
    } catch {
      return "running";
    }

    // Claimed before the first await, so a prompt arriving during the RPC sees a
    // busy thread rather than an idle one.
    context.compacting = true;
    this.ctx.registry.setPhase(context, "running");
    this.lifecycle.emitStatus(context);
    this.armCompactionBackstop(context.threadId);

    try {
      await this.ctx.options.engine.compactThread(session.threadId);
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
        this.ctx.options.emit({
          type: "session.updated",
          sessionId: id,
          data: { compacted: true, compacting: true },
        });
      }
    }
    return "accepted";
  }

  armCompactionBackstop(threadId: string): void {
    this.clearCompactionBackstop(threadId);
    const timer = setTimeout(() => {
      this.ctx.compactionBackstops.delete(threadId);
      const context = this.ctx.registry.getThread(threadId);
      if (!context?.compacting) return;
      this.finishCompaction(
        context,
        "Codex never reported that compaction finished. The session was released.",
      );
    }, this.ctx.options.compactionTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS);
    timer.unref?.();
    this.ctx.compactionBackstops.set(threadId, timer);
  }

  clearCompactionBackstop(threadId: string): void {
    const timer = this.ctx.compactionBackstops.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    this.ctx.compactionBackstops.delete(threadId);
  }

  /**
   * Releases the compaction hold.
   *
   * Never overrides a turn: an `abort` or a generation recovery may already have
   * moved the thread on, and compaction finishing must not drag it back to idle.
   */
  finishCompaction(context: ThreadContext, error?: string): void {
    this.clearCompactionBackstop(context.threadId);
    if (!context.compacting) return;
    context.compacting = false;
    if (!context.activeTurn && !context.dispatchInFlight && context.phase === "running") {
      this.ctx.registry.setPhase(context, error ? "failed" : "idle", error);
    }
    this.lifecycle.emitStatus(context);
    for (const sessionId of context.bridgeSessionIds) {
      if (error) {
        this.ctx.options.emit({ type: "session.error", sessionId, data: { error } });
        continue;
      }
      this.ctx.options.emit({
        type: "session.updated",
        sessionId,
        data: { compacted: true, compacting: false },
      });
      this.ctx.options.emit({
        type: "session.idle",
        sessionId,
        data: {
          title: this.ctx.registry.getSession(sessionId)?.title,
          phase: context.phase,
        },
      });
    }
    this.ctx.callbacks.notifyThreadActivity();
  }

  async steerSession(
    sessionId: string,
    input: string,
    expectedTurnId: string,
    requestId: string,
  ): Promise<"accepted" | "not-found" | "idle" | "mismatch" | "unknown" | "closing"> {
    const session = this.ctx.registry.getSession(sessionId);
    const context = this.ctx.registry.getThreadForSession(sessionId);
    const turn = context?.activeTurn;
    if (!session?.threadId || !context) return "not-found";
    if (this.sessionAdmissionClosed(session)) return "closing";
    const inputDigest = createHash("sha256").update(input).digest("hex");
    const previous = this.ctx.steerRequests.get(requestId);
    if (previous) {
      // Reusing an id for different input or a different target cannot be
      // interpreted safely. Do not dispatch either version again.
      if (
        previous.threadId !== session.threadId ||
        previous.turnId !== expectedTurnId ||
        previous.inputDigest !== inputDigest
      ) {
        return "unknown";
      }
      if (previous.state === "accepted") return "accepted";

      try {
        const reconciled = await this.ctx.options.engine.reconcileRequest(
          session.threadId,
          requestId,
        );
        if (
          (reconciled.result === "attach" || reconciled.result === "terminal") &&
          reconciled.turnId === expectedTurnId
        ) {
          this.rememberSteerRequest(requestId, { ...previous, state: "accepted" });
          await this.ctx.options.engine.drainNotifications(session.threadId);
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
        this.ctx.steerRequests.delete(requestId);
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
      const reconciled = await this.ctx.options.engine.reconcileRequest(
        session.threadId,
        requestId,
      );
      if (reconciled.result === "attach" || reconciled.result === "terminal") {
        if (reconciled.turnId !== expectedTurnId) return "mismatch";
        this.rememberSteerRequest(requestId, {
          threadId: session.threadId,
          turnId: expectedTurnId,
          inputDigest,
          state: "accepted",
          requestedAt: new Date(this.ctx.now()).toISOString(),
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
        requestedAt: new Date(this.ctx.now()).toISOString(),
      });
      return "unknown";
    }

    const attemptedAt = new Date(this.ctx.now()).toISOString();
    try {
      await this.ctx.options.engine.steerTurn(
        session.threadId,
        expectedTurnId,
        [{ type: "text", text: input }],
        requestId,
      );
      let ordering: SteerOrdering = {};
      try {
        const reconciled = await this.ctx.options.engine.reconcileRequest(
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
      await this.ctx.options.engine.drainNotifications(session.threadId);
      // Stamped only once app-server has acknowledged the steer, and once the
      // ordering read it is paired with has been taken. Sampling before the RPC
      // dated the row boundary earlier than the steer could possibly have
      // landed, so anything Codex emitted during the round-trip was attributed
      // to the row below while its item stayed in the row above.
      const requestedAt = new Date(this.ctx.now()).toISOString();
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
        error instanceof AppServerRpcError &&
        (/expectedTurnId.*(?:match|stale)/i.test(error.message) ||
          /expected\s+turn(?:\s+id)?.*(?:match|stale)/i.test(error.message) ||
          /no longer accepting input/i.test(error.message))
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

  /**
   * No-touch positive reconciliation for the backend coordinator.
   *
   * It does not attach, refresh liveness, or render. A missing cache entry is
   * checked against authoritative thread history; every failure remains
   * `unknown`, never evidence that the request was absent.
   */
  async steerDispatchStatus(
    sessionId: string,
    requestId: string,
  ): Promise<"dispatched" | "unknown"> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session?.threadId) return "unknown";
    const previous = this.ctx.steerRequests.get(requestId);
    if (previous?.threadId === session.threadId && previous.state === "accepted") {
      return "dispatched";
    }
    try {
      const reconciled = await this.ctx.options.engine.reconcileRequest(
        session.threadId,
        requestId,
      );
      return reconciled.result === "attach" || reconciled.result === "terminal"
        ? "dispatched"
        : "unknown";
    } catch {
      return "unknown";
    }
  }

  rememberSteerRequest(
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
    this.ctx.steerRequests.delete(requestId);
    this.ctx.steerRequests.set(requestId, record);
    while (this.ctx.steerRequests.size > MAX_STEER_REQUESTS) {
      const oldest = this.ctx.steerRequests.keys().next().value;
      if (typeof oldest !== "string") break;
      this.ctx.steerRequests.delete(oldest);
    }
  }

  async appendAcceptedSteer(
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
    const state = this.lifecycle.stateFor(context.threadId);
    const placement = turn.placeSteer(ordering);
    if (placement.kind === "before") {
      this.insertSteerBefore(context, input, turnId, placement.assistantMessageId);
      await state.coalescer.flushNow();
      this.lifecycle.emitStatus(context);
      return;
    }
    const boundary = turn.freezeAssistantSegment(placement.boundary, ordering.requestedAt);

    // Finish the pre-steer row before announcing the user message. The
    // coalescer serializes this against a render already in flight, while the
    // frozen boundary prevents items arriving during the await from leaking
    // above the steer.
    await state.coalescer.flushNow();

    const userMessage = this.ctx.callbacks.appendUserMessage(context, input, []);
    userMessage.turnId = turnId;
    const assistantMessage = openAssistantRow(context, state, turn, {
      boundary,
      startedAt: ordering.requestedAt,
      createdAt: new Date(this.ctx.now()).toISOString(),
      keepsRenderedItems: false,
    });
    // Announced below together with the user message, which must precede it.
    state.publishedMessageId = assistantMessage.id;
    this.ctx.callbacks.bumpMessageRevision(context);
    for (const id of context.bridgeSessionIds) {
      this.ctx.options.emit({
        type: "message.updated",
        sessionId: id,
        data: { message: userMessage },
      });
      this.ctx.options.emit({
        type: "message.updated",
        sessionId: id,
        data: { message: assistantMessage },
      });
    }

    // Items can arrive after the boundary while the old row is flushing. Make
    // their suffix visible immediately instead of waiting for another engine
    // event to happen to schedule the new row.
    await state.coalescer.flushNow();
    this.lifecycle.emitStatus(context);
  }

  /**
   * Puts a steer's user row directly above `rowId`, the first assistant row
   * whose items all followed it (`TurnAccumulator.placeSteer`). No row opens:
   * the live one already holds what came after the steer.
   *
   * Synchronous, so no item can land between choosing the row and placing the
   * user row above it. Readers re-read the transcript window by revision, and
   * the rows involved opened during the steer itself, so they are at its tail.
   */
  private insertSteerBefore(
    context: ThreadContext,
    input: string,
    turnId: string,
    rowId: string,
  ): void {
    const userMessage = this.ctx.callbacks.appendUserMessage(context, input, []);
    userMessage.turnId = turnId;
    let index = context.messages.length - 2;
    while (index >= 0 && context.messages[index]!.id !== rowId) index -= 1;
    if (index >= 0) {
      context.messages.pop();
      // Local command rows merge by timestamp. Match the response's clock so
      // their stable sort preserves the steer's position above that response.
      userMessage.createdAt = context.messages[index]!.createdAt;
      context.messages.splice(index, 0, userMessage);
    }
    this.ctx.callbacks.bumpMessageRevision(context);
    for (const id of context.bridgeSessionIds) {
      this.ctx.options.emit({
        type: "message.updated",
        sessionId: id,
        data: { message: userMessage },
      });
    }
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
    | { outcome: "closing" }
  > {
    try {
      return await this.ctx.withDispatchAdmission(() =>
        this.dispatchNativeReview(sessionId, target),
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  private async dispatchNativeReview(
    sessionId: string,
    target: Parameters<CodexRuntimeSessions["startNativeReview"]>[1],
  ): ReturnType<CodexRuntimeSessions["startNativeReview"]> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session?.threadId) return { outcome: "not-found" };
    if (this.sessionAdmissionClosed(session)) return { outcome: "closing" };
    const context = await this.ctx.callbacks.ensureAttached(sessionId);
    if (!context) return { outcome: "not-found" };
    // Re-checked after the only await, immediately before the claim below.
    if (this.sessionAdmissionClosed(session)) return { outcome: "closing" };

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
      this.ctx.registry.assertNoActiveTurn(context);
    } catch {
      return { outcome: "running" };
    }
    const phaseBeforeReview = context.phase;
    const errorBeforeReview = context.error;
    context.dispatchInFlight = true;
    this.ctx.registry.setPhase(context, "starting");
    await this.ctx.callbacks.primeCommandChanges(context);

    const modelForReview = context.modelId ?? session.config.model;
    const assistantMessage: NormalizedMessage = {
      id: createMessageId(),
      role: "assistant",
      content: "",
      parts: [],
      createdAt: new Date(this.ctx.now()).toISOString(),
      revision: 1,
      ...(modelForReview ? { modelId: modelForReview } : {}),
    };
    const streamingState = this.lifecycle.stateFor(context.threadId);
    streamingState.publishedMessageId = assistantMessage.id;
    streamingState.publishedParts = [];
    streamingState.publishedModelId = assistantMessage.modelId;
    context.messages.push(assistantMessage);
    this.ctx.callbacks.bumpMessageRevision(context);
    for (const id of context.bridgeSessionIds) {
      this.ctx.options.emit({
        type: "message.updated",
        sessionId: id,
        data: { message: assistantMessage },
      });
    }

    try {
      const review = await this.ctx.options.engine.startReview(session.threadId, target, "inline");
      const accumulator = new TurnAccumulator({
        threadId: context.threadId,
        turnId: review.turnId,
        engineGeneration: this.ctx.options.engine.info().generation,
        assistantMessageId: assistantMessage.id,
        configurationRevision: session.configurationRevision,
        expectsStructuredOutput: false,
        startedAt: context.turnStartedAt,
      });
      accumulator.markRunning();
      assistantMessage.turnId = review.turnId;
      context.activeTurn = accumulator;
      context.dispatchInFlight = false;
      this.ctx.registry.setPhase(context, "running");
      // Re-read: generation-change recovery can release this thread's runtime
      // state while `startReview` is in flight, and `stateFor` then hands every
      // later reader a *different* object. Writing the streaming identity to the
      // pre-dispatch reference would leave the live state without an
      // `assistantMessageId`, so `publishAssistantMessage` returns early and the
      // turn runs without ever streaming.
      const liveState = this.lifecycle.stateFor(context.threadId);
      this.lifecycle.beginAssistantTurnRender(liveState, assistantMessage);
      this.lifecycle.emitStatus(context);
      this.lifecycle.drainPendingEvents(context, review.turnId);
      await Promise.all(
        this.ctx.registry
          .boundSessionsForThread(context.threadId)
          .filter((entry) => {
            if (!entry.restartFailure) return false;
            entry.restartFailure = undefined;
            return true;
          })
          .map((entry) => this.ctx.callbacks.persistSession(entry)),
      );
      return { outcome: "accepted", turnId: review.turnId };
    } catch (error) {
      context.dispatchInFlight = false;
      context.messages = context.messages.filter((message) => message.id !== assistantMessage.id);
      /**
       * The optimistic bubble was announced with a revision bump, so its removal
       * needs one too: a tab that was unmounted for the SSE frames reconciles on
       * `messageRevision`, and without a second bump it would keep a permanently
       * blank assistant bubble with nothing to tell it to refetch.
       */
      this.ctx.callbacks.bumpMessageRevision(context);
      for (const id of context.bridgeSessionIds) {
        this.ctx.options.emit({
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
        this.ctx.registry.setPhase(context, phaseBeforeReview, errorBeforeReview);
      }
      this.lifecycle.emitStatus(context);
      const message = error instanceof Error ? error.message : "Native review failed";
      for (const id of context.bridgeSessionIds) {
        this.ctx.options.emit({ type: "session.error", sessionId: id, data: { error: message } });
      }
      return { outcome: "unavailable" };
    }
  }

  async getRuntimeHealth(sessionId: string): Promise<unknown | null> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return null;
    // Runtime metadata is a no-touch read: it must not resume every durable
    // thread merely because the backend refreshes a projection. App-server only
    // accepts thread-scoped MCP inventory requests for a thread loaded in the
    // current generation, so a lazy/restored or idle-detached session uses the
    // engine-global inventory until another route attaches it.
    return this.ctx.options.engine.getRuntimeHealth(this.loadedThreadId(sessionId));
  }

  async listMcpServers(sessionId: string): Promise<unknown | null> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return null;
    return this.ctx.options.engine.listMcpServers(this.loadedThreadId(sessionId));
  }

  /** A thread id app-server can currently use without re-attaching the session. */
  private loadedThreadId(sessionId: string): string | null {
    const context = this.ctx.registry.getThreadForSession(sessionId);
    if (!context || context.unsubscribed) return null;
    if (context.engineGeneration !== this.ctx.options.engine.info().generation) return null;
    return context.threadId;
  }

  async performMcpAction(
    sessionId: string,
    name: string,
    action: "reconnect" | "sign-in",
  ): Promise<{ authorizationUrl?: string } | null> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return null;
    if (action === "sign-in") {
      return this.ctx.options.engine.beginMcpOauth(name, session.threadId);
    }
    await this.ctx.options.engine.reconnectMcpServers();
    return {};
  }

  readAuthStatus(): Promise<unknown> {
    return this.ctx.options.engine.readAccount();
  }

  beginAuthLogin(method?: "browser" | "device-code"): Promise<unknown> {
    return this.ctx.options.engine.beginAccountLogin(method);
  }

  logoutAuth(): Promise<void> {
    return this.ctx.options.engine.logoutAccount();
  }

  cancelAuthLogin(): Promise<"canceled" | "none"> {
    return this.ctx.options.engine.cancelAccountLogin();
  }

  async rewindMessages(
    sessionId: string,
    messageId: string,
  ): Promise<"rewound" | "not-found" | "running" | "unavailable"> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return "not-found";
    const context = this.ctx.registry.getThreadForSession(sessionId);
    if (!context || !session.threadId) return "unavailable";
    if (phaseToExternalStatus(context.phase) === "running") return "running";
    const index = context.messages.findIndex((message) => message.id === messageId);
    const beforeTurnId = context.messages[index]?.turnId;
    if (index < 0 || !beforeTurnId) return "unavailable";
    await this.ctx.options.engine.revertThread(session.threadId, beforeTurnId);
    clearTranscriptPathCache();
    invalidateTranscriptCatalogCache();
    context.messages.splice(index);
    context.error = undefined;
    this.ctx.registry.setPhase(context, "idle");
    this.ctx.registry.bumpContentEpoch(session);
    this.ctx.callbacks.bumpMessageRevision(context);
    for (const id of context.bridgeSessionIds) {
      this.ctx.options.emit({ type: "session.reconcile-required", sessionId: id });
    }
    return "rewound";
  }

  /**
   * Adopts a rewind made by another client (`thread/reverted`): trims the
   * transcript this bridge serves to the turns app-server still has. Our own
   * `rewindMessages` has already trimmed, so its echo finds nothing to cut.
   * Never throws: it runs detached from the notification that started it.
   */
  async reconcileExternalRevert(context: ThreadContext): Promise<void> {
    clearTranscriptPathCache();
    invalidateTranscriptCatalogCache();
    const engineHandle = context.engineHandle;
    const generation = context.engineGeneration;
    const revisions = [...context.bridgeSessionIds].map((id) => {
      const session = this.ctx.registry.getSession(id);
      return { id, session, revision: session?.messageRevision };
    });
    let turns: { id: string }[] | undefined;
    try {
      turns = (await this.ctx.options.engine.readThread(context.threadId, { includeTurns: true }))
        ?.turns;
    } catch (error) {
      console.warn(
        `[codex-bridge] Could not read turns after a revert of thread ${context.threadId}:`,
        error instanceof Error ? error.message : error,
      );
      return;
    }
    // Detached or replaced while reading: the next attach rehydrates from the
    // rollout, which records the rollback itself. A turn running now may have
    // started after the read and be missing from it, so nothing is cut under
    // one. The revision fence also rejects a turn that started and finished
    // during the read; the transcript catches up on the next hydration.
    if (!turns || this.ctx.registry.getThread(context.threadId) !== context) return;
    if (
      phaseToExternalStatus(context.phase) === "running" ||
      context.dispatchInFlight ||
      context.engineHandle !== engineHandle ||
      context.engineGeneration !== generation ||
      revisions.some(
        ({ id, session, revision }) =>
          this.ctx.registry.getSession(id) !== session || session?.messageRevision !== revision,
      )
    )
      return;
    const cut = externalRevertCut(
      context.messages,
      turns.map((turn) => turn.id),
      false,
    );
    if (cut === undefined) return;
    context.messages.splice(cut);
    for (const id of context.bridgeSessionIds) {
      const session = this.ctx.registry.getSession(id);
      if (session) this.ctx.registry.bumpContentEpoch(session);
    }
    this.ctx.callbacks.bumpMessageRevision(context);
    for (const id of context.bridgeSessionIds) {
      this.ctx.options.emit({ type: "session.reconcile-required", sessionId: id });
    }
  }

  async setSessionTitle(sessionId: string, title: string): Promise<boolean> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return false;
    title = normalizeExplicitSessionTitle(title);
    if (!title) return false;
    const siblings = session.threadId
      ? this.ctx.registry.listSessions().filter((entry) => entry.threadId === session.threadId)
      : [session];
    for (const entry of siblings) {
      entry.title = title;
      entry.titleSource = "explicit";
    }
    if (session.threadId) {
      await this.ctx.options.engine.setThreadName(session.threadId, title);
      // Codex keeps the name in `session_index.jsonl` at its home root, which a
      // container rebuild does not preserve; the bridge index is preserved.
      await persistSessionTitle(this.ctx.options.codexHome, session.threadId, title, {
        source: "explicit",
      }).catch(() => undefined);
    }
    for (const entry of siblings) {
      await this.ctx.callbacks.persistSession(entry);
      this.ctx.options.emit({
        type: "session.title-updated",
        sessionId: entry.id,
        data: { title },
      });
    }
    return true;
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
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return "not-found";
    await this.ctx.callbacks.touchSession(sessionId);
    const context = this.ctx.registry.getThreadForSession(sessionId);
    if (context && phaseToExternalStatus(context.phase) === "running") return "running";

    const nextConfig = this.lifecycle.toEngineConfig({
      ...body,
      ...(body.policy ? {} : { policy: session.config.policy }),
    });
    const requestedModelChanged = session.config.model !== nextConfig.model;
    let attached: ThreadContext | undefined;
    let previousConfirmedModel: string | undefined;
    try {
      // ensureAttached fast-returns a healthy current-generation context, but
      // re-resumes one invalidated by a failed generation recovery. Never update
      // configuration through a handle owned by the dead child.
      attached = await this.ctx.callbacks.ensureAttached(sessionId);
      if (attached && phaseToExternalStatus(attached.phase) === "running") return "running";
      if (attached) {
        previousConfirmedModel = attached.modelId;
        if (requestedModelChanged) attached.modelId = undefined;
        // Configuration is transactional from the bridge's perspective: a failed
        // engine update must leave both memory and the durable session record on
        // the last configuration the engine actually accepted.
        await this.ctx.options.engine.configureThread(attached.engineHandle, nextConfig);
        if (
          session.config.policy?.projectResources !== nextConfig.policy?.projectResources ||
          (session.config.cwd ?? this.ctx.options.cwd) !== (nextConfig.cwd ?? this.ctx.options.cwd)
        ) {
          // A loaded resume ignores trust and skill overrides. Confirm the old
          // thread is unsubscribed before publishing the new resource policy.
          await this.lifecycle.detachThread(attached, true);
        }
      }
    } catch (error) {
      if (attached) {
        await this.ctx.options.engine
          .configureThread(attached.engineHandle, session.config)
          .catch(() => undefined);
      }
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

    if (session.config.policy?.projectResources !== nextConfig.policy?.projectResources) {
      this.ctx.commandCatalogue.markPolicyChanged();
    }
    session.config = nextConfig;
    session.configurationRevision += 1;
    this.ctx.registry.touch(sessionId);
    return (await this.persistSessionVerified(session)) ? "updated" : "memory-only";
  }

  async getMessages(sessionId: string): Promise<NormalizedMessage[] | null> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return null;
    await this.ctx.callbacks.touchSession(sessionId);

    let context: ThreadContext | undefined;
    try {
      context = await this.ctx.callbacks.ensureAttached(sessionId);
    } catch (error) {
      // A read must never fail on an ambiguous re-attach. The binding is
      // deliberately preserved for the next attempt (see ensureAttached), so the
      // honest answer here is the last transcript we know about rather than a 500
      // in place of a conversation.
      console.warn(
        `[codex-bridge] Serving the last known transcript for session ${sessionId}:`,
        error instanceof Error ? error.message : error,
      );
      const known = this.ctx.registry.getThreadForSession(sessionId);
      return known
        ? this.ctx.callbacks.messagesForSession(session, known)
        : [...session.localMessages];
    }
    if (!context) return [...session.localMessages];

    return this.ctx.callbacks.messagesForSession(session, context);
  }

  /**
   * Read the bridge-owned display tail without touching liveness or attaching a
   * detached app-server thread. The ordinary getMessages path remains the
   * exact recovery surface; progressive display uses this preview first.
   */
  getCachedMessages(sessionId: string): {
    messages: NormalizedMessage[];
    freshness: "cached" | "current";
    complete: boolean;
  } | null {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return null;
    const context = this.ctx.registry.getThreadForSession(sessionId);
    const complete = this.ctx.callbacks.transcriptComplete(sessionId);
    // An attached thread's transcript is the same array `getMessages` would
    // return, so it is current; only the detached fallback to the retained
    // local tail is a cache. Reporting the difference is what lets the backend
    // decide whether the tail is worth persisting for the next cold start.
    //
    // Attach happens before the rollout body is read. Until that assignment
    // finishes — or when recovery attached an empty placeholder — treat the
    // thread like the detached preview: cached and incomplete. Otherwise a
    // concurrent poll can persist `{ current, complete, [] }` over the tail.
    if (context?.transcriptHydrated)
      return {
        messages: this.ctx.callbacks.messagesForSession(session, context),
        freshness: "current",
        complete,
      };
    return { messages: [...session.localMessages], freshness: "cached", complete };
  }

  /**
   * Whether every message this session ever held is still readable.
   *
   * The local ring buffer is the only transcript store the bridge silently
   * evicts from, and for a session whose rollout could not be resumed it holds
   * the whole conversation. Reporting the drop is what stops the display from
   * presenting the retained tail as the complete history; the dropped messages
   * are genuinely gone, so this is a notice rather than a paging cursor.
   */
  transcriptComplete(sessionId: string): boolean {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session || session.localMessagesTrimmed) return false;

    /*
     * A durable session is restored with its thread id but without the rollout
     * body. Until `ensureAttached` has finished reading that body — and not
     * merely attached an empty context or recovery placeholder — `localMessages`
     * is only an empty preview. Reporting it complete prevents the backend's
     * progressive reader from falling through to the exact `/messages` recovery
     * surface, so its persisted display tail is replaced by an
     * authoritative-looking empty transcript after an app restart.
     *
     * Threadless sessions are different: their local ring is the authoritative
     * transcript (for example recovered context whose rollout is gone).
     */
    if (session.threadId === null) return true;
    return this.ctx.registry.getThreadForSession(sessionId)?.transcriptHydrated === true;
  }

  async getUsage(sessionId: string): Promise<EngineUsageSnapshot | undefined | null> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return null;
    void this.ctx.callbacks.touchSession(sessionId);
    const readAccountUsage = this.ctx.options.engine.readAccountUsage;
    const providerAccount = readAccountUsage
      ? await readAccountUsage.call(this.ctx.options.engine)
      : undefined;
    const previous = session.threadId ? this.ctx.usageByThread.get(session.threadId) : undefined;
    const withLimits = mergeAccountUsage(
      previous?.account,
      accountUsageFromLimits(this.ctx.accountRateLimits, this.ctx.accountCredits),
    );
    const account = mergeAccountUsage(withLimits, providerAccount);
    if (!previous && !account) return undefined;
    const usage: EngineUsageSnapshot = {
      ...(previous ?? {
        usedTokens: 0,
        totalTokens: 0,
        percentUsed: 0,
        estimated: false,
        source: "codex",
        updatedAt: new Date(this.ctx.now()).toISOString(),
      }),
      ...(account ? { account } : {}),
      updatedAt: new Date(this.ctx.now()).toISOString(),
    };
    if (session.threadId) this.ctx.usageByThread.set(session.threadId, usage);
    this.ctx.options.emit({
      type: "session.updated",
      sessionId,
      data: { contextUsage: usage },
    });
    return usage;
  }

  getStatus(
    sessionId: string,
    touch = true,
  ): {
    status: "idle" | "running" | "error";
    phase: SessionPhase;
    title?: string;
    error?: string;
    /**
     * Why the last turn failed, when it was not the model's doing. `restart`:
     * an app-server restart stopped the turn partway; the thread is intact and
     * a new prompt continues it.
     */
    interruption?: "restart";
    /** The request whose turn `interruption` cut short, while the journal holds it. */
    interruptedRequestId?: string;
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
    contentEpoch: number;
    commandRevision?: number;
    policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy;
    readiness?: NativeAgentReadiness;
    authNotice?: ThreadAuthNotice;
  } | null {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return null;
    if (touch) void this.ctx.callbacks.touchSession(sessionId);
    const context = this.ctx.registry.getThreadForSession(sessionId);
    // A restored thread whose journal record has not been settled yet may still
    // be executing its last turn. `idle` here would let the build pipeline
    // advance on a turn whose fate is unknown.
    const awaitingRecovery =
      session.threadId !== null && this.ctx.threadsAwaitingDispatchRecovery.has(session.threadId);
    const phase =
      context?.phase ??
      (awaitingRecovery ? "recovering" : session.restartFailure ? "failed" : "idle");
    const latestDispatch = this.ctx.journal.latestForSession(sessionId);
    // Session status is per session; this names the request the notice is
    // about, so a workflow can tell it from a newer request not yet started.
    const interruptedRequestId = session.restartFailure
      ? this.ctx.journal.requestIdForTurn(session.restartFailure.turnId)
      : undefined;
    const error =
      context?.error ??
      (phase === "failed" && session.restartFailure ? CODEX_RESTARTED_MID_TURN_MESSAGE : undefined);

    return {
      // Keeps the pre-migration contract; `phase` carries the new detail.
      status: phaseToExternalStatus(phase),
      ...(session.config.policy ? { policy: session.config.policy } : {}),
      phase,
      // A title read back from the first prompt is a resume-list label, not a
      // title: leaving it out lets the backend name the session.
      title: session.titleSource === "prompt" ? undefined : session.title,
      error,
      // Structured so a workflow can continue the turn without matching text.
      // The notice clears when the next turn is accepted, and the error check
      // keeps a later, unrelated failure from inheriting it.
      ...(phase === "failed" && session.restartFailure && error === CODEX_RESTARTED_MID_TURN_MESSAGE
        ? {
            interruption: "restart" as const,
            ...(interruptedRequestId ? { interruptedRequestId } : {}),
          }
        : {}),
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
      contextUsage: session.threadId ? this.ctx.usageByThread.get(session.threadId) : undefined,
      engineGeneration: this.ctx.options.engine.info().generation,
      messageRevision: session.messageRevision,
      contentEpoch: session.contentEpoch,
      // The command inventory revision `/session/:id/commands` reports. An
      // in-memory counter: reading it scans nothing and lists no skills. The
      // backend revalidates its cached catalogue when it moves.
      ...(this.ctx.commandCatalogue.revision > 0
        ? { commandRevision: this.ctx.commandCatalogue.revision }
        : {}),
      // A provider login Codex had to renew during this thread's turns.
      ...(context?.authNotice ? { authNotice: context.authNotice } : {}),
      // Omitted rather than "ready" otherwise: only a confirmed sign-out is known.
      ...(this.ctx.options.engine.isAccountSignInRequired()
        ? {
            readiness: {
              state: "authentication-required" as const,
              message: CODEX_SIGN_IN_REQUIRED_MESSAGE,
              // `/global/auth/login` returns the browser URL the tab opens.
              signIn: { kind: "browser-url" as const },
            },
          }
        : {}),
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
    const session = this.ctx.registry.getSession(sessionId);
    // In-band, so the caller can tell "this session is gone" apart from "this
    // bridge does not have the route" (see the /session/:id/activity handler).
    if (!session) return "missing";

    const context = this.ctx.registry.getThreadForSession(sessionId);
    // Same rule as `getStatus`: a restored thread whose journal record has not
    // been settled yet may still be executing its last turn.
    const awaitingRecovery =
      session.threadId !== null && this.ctx.threadsAwaitingDispatchRecovery.has(session.threadId);
    const phase = context?.phase ?? (awaitingRecovery ? "recovering" : "idle");

    // `starting`, `cancelling` and `recovering` all map to `running`. Reporting
    // any of them as idle would let the build pipeline advance on a turn that
    // may still be executing.
    if (phaseToExternalStatus(phase) !== "running") return "idle";
    return this.hasParkedInput(session) ? "waiting" : "working";
  }

  /** No-touch activity read with bounded, content-free background attention. */
  humanPromptOutput(sessionId: string) {
    return humanPromptObservation(this.ctx.registry.getThreadForSession(sessionId)?.messages);
  }

  getActivitySnapshot(sessionId: string): {
    activity: "idle" | "working" | "waiting" | "missing";
    asyncQuestionItemIds?: string[];
    contentRevision?: string;
  } {
    const activity = this.getActivity(sessionId);
    if (activity === "missing") return { activity };
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return { activity: "missing" };
    return {
      activity,
      ...(session.asyncQuestionItemIds.length > 0
        ? { asyncQuestionItemIds: [...session.asyncQuestionItemIds] }
        : {}),
      /*
       * Opaque revision of what the session view shows beyond its activity:
       * the transcript revision the transcript routes key their token on, and
       * the async-question index. A late change on an idle thread (an async
       * question, a settled command's measured lines) moves it without an
       * activity transition, and the backend announces it so an idle view can
       * read less often. Process-scoped, so a restarted bridge never repeats
       * a revision an older read saw.
       */
      contentRevision: `${ACTIVITY_PROCESS}:${session.contentEpoch}.${session.messageRevision}:${session.asyncQuestionItemIds.length}`,
    };
  }

  /**
   * Whether a card is parked on this session's thread awaiting a human.
   *
   * Same thread-matching rule as `listApprovals`/`listInteractions`, without
   * materializing their arrays — this runs on the backend's activity poll, once
   * per session, every couple of seconds.
   */
  hasParkedInput(session: BridgeSession): boolean {
    if (!session.threadId) return false;
    for (const entry of this.ctx.pendingApprovals.values()) {
      if (entry.request.threadId === session.threadId) return true;
    }
    for (const entry of this.ctx.pendingInteractions.values()) {
      if (entry.request.threadId === session.threadId) return true;
    }
    return false;
  }

  getStructuredOutput(
    sessionId: string,
    requestId?: string,
  ): { requestId?: string; structuredOutput: StructuredOutputResult | null } | null {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return null;
    void this.ctx.callbacks.touchSession(sessionId);
    if (
      requestId &&
      session.structuredOutputRequestId &&
      requestId !== session.structuredOutputRequestId
    ) {
      return { requestId, structuredOutput: null };
    }
    return {
      requestId: session.structuredOutputRequestId,
      structuredOutput: session.structuredOutput ?? null,
    };
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.ctx.registry.getSession(sessionId);
    if (session) this.deleteClaims.add(session);
    return (await this.releaseBridgeSession(sessionId, "best-effort")) === "released";
  }

  /** A destructive release wins over a concurrent close's failed-write rollback. */
  private readonly deleteClaims = new WeakSet<BridgeSession>();

  /**
   * Shared release for DELETE and the ordinary tab close.
   *
   * The removal is published *before* the registry lets go, with persistence
   * fenced for this session object, so a failed write leaves nothing to
   * restore: the session is still registered and a retry reaches it.
   *
   * - `best-effort` (DELETE): a failed tombstone is logged and the session is
   *   released anyway, as it always was.
   * - `strict` (close): a failed tombstone answers `unpublished` and the session
   *   stays registered, so the caller can report pending instead of claiming a
   *   removal that the next start would undo.
   */
  async releaseBridgeSession(
    sessionId: string,
    publication: "best-effort" | "strict",
  ): Promise<"released" | "missing" | "unpublished"> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return "missing";

    const context = this.ctx.registry.getThreadForSession(sessionId);
    const turn = context?.activeTurn;
    // Last tab: stop the turn before detaching. DELETE used to only
    // unsubscribe, so Codex kept editing the worktree after the UI closed.
    if (context && turn && context.bridgeSessionIds.size === 1) {
      await this.ctx.options.engine
        .interruptTurn(context.engineHandle, turn.turnId)
        .catch(() => undefined);
    }

    this.retiredSessions.add(session);
    try {
      await this.ctx.store.publishRemoval(sessionId);
    } catch (error) {
      if (publication === "strict") {
        if (!this.deleteClaims.has(session)) {
          this.retiredSessions.delete(session);
          // Restore updates only if no concurrent DELETE has claimed removal.
          if (this.ctx.registry.getSession(sessionId) === session)
            await this.ctx.callbacks.persistSession(session);
        }
        return "unpublished";
      }
      console.warn(
        "[codex-bridge] Failed to persist bridge session registry:",
        error instanceof Error ? error.message : error,
      );
    }
    // A concurrent release may have won the race while the write was in flight.
    if (this.ctx.registry.getSession(sessionId) !== session) return "released";

    // Answered before the registry drops the thread, so the router can still map
    // the approval to a session and the pending turn is not left waiting on a
    // prompt whose UI has gone away.
    const { removedThread } = this.ctx.registry.releaseSession(sessionId);
    this.ctx.lastPersistedAccess.delete(sessionId);
    // The id is free again: a client-keyed session may legitimately be recreated.
    this.ctx.closingSessionIds.delete(sessionId);

    if (removedThread) {
      // Only the final tab releases the human decision. Another tab attached to
      // this canonical thread can still show and answer the same approval.
      this.ctx.options.engine.abandonThreadApprovals(removedThread.threadId);
      // Last reference: release the thread but never delete the rollout.
      this.lifecycle.releaseThreadRuntimeState(removedThread.threadId);
      await this.ctx.options.engine
        .unsubscribeThread(removedThread.engineHandle)
        .catch(() => undefined);
    }
    return "released";
  }

  async persistSession(session: BridgeSession): Promise<void> {
    if (!session.threadId) return;
    if (this.retiredSessions.has(session)) return;
    this.ctx.lastPersistedAccess.set(session.id, session.lastAccessed);
    const write = this.ctx.store
      .upsert(
        this.ctx.store.toRecord({
          bridgeSessionId: session.id,
          threadId: session.threadId,
          cwd: this.ctx.options.cwd,
          config: session.config,
          title: session.title,
          titleSource: session.titleSource,
          lastAcceptedRequestId: session.lastAcceptedRequestId,
          structuredOutputRequestId: session.structuredOutputRequestId,
          structuredOutput: session.structuredOutput,
          structuredOutputTurns: session.structuredOutputTurns,
          restartFailure: session.restartFailure,
          confirmedModelsByTurn: session.confirmedModelsByTurn,
          asyncQuestionItemIds: session.asyncQuestionItemIds,
        }),
      )
      .catch(() => undefined);
    this.ctx.pendingSessionWrites.add(write);
    try {
      await write;
    } finally {
      this.ctx.pendingSessionWrites.delete(write);
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
  async persistSessionVerified(session: BridgeSession): Promise<boolean> {
    if (!session.threadId) return true;
    await this.ctx.callbacks.persistSession(session);
    return this.isSessionConfigPersisted(session);
  }

  async isSessionConfigPersisted(session: BridgeSession): Promise<boolean> {
    if (!session.threadId) return true;
    try {
      const persisted = (await this.ctx.store.load()).find(
        (record) => record.bridgeSessionId === session.id,
      );
      if (!persisted) return false;
      // Round-tripped so both sides drop `undefined` members identically; key
      // order is the store's own serialization of this same object.
      const { agentMcp: _agentMcp, ...persistableConfig } = session.config;
      return (
        JSON.stringify(persisted.config) ===
        JSON.stringify(JSON.parse(JSON.stringify(persistableConfig)))
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
    policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy;
  } | null> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return null;
    await this.ctx.callbacks.touchSession(sessionId);
    return {
      ...(session.config.model ? { model: session.config.model } : {}),
      ...(session.config.reasoningEffort
        ? { modelReasoningEffort: session.config.reasoningEffort }
        : {}),
      mode: session.config.mode,
      fastMode: session.config.serviceTier === "fast",
      ...(session.config.policy ? { policy: session.config.policy } : {}),
      durable: await this.isSessionConfigPersisted(session),
    };
  }

  /**
   * Updates the in-memory activity clock and periodically carries it to disk.
   *
   * The interval shrinks for deliberately short retention windows, which keeps
   * the invariant that at least one heartbeat is possible before expiry.
   */
  touchSession(sessionId: string): Promise<void> {
    this.ctx.registry.touch(sessionId);
    const session = this.ctx.registry.getSession(sessionId);
    if (!session?.threadId) return Promise.resolve();

    const retentionMs = this.ctx.options.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS;
    const persistIntervalMs =
      retentionMs > 0
        ? Math.min(DEFAULT_SESSION_ACTIVITY_PERSIST_INTERVAL_MS, Math.max(1, retentionMs / 2))
        : DEFAULT_SESSION_ACTIVITY_PERSIST_INTERVAL_MS;
    const lastPersisted = this.ctx.lastPersistedAccess.get(sessionId) ?? 0;
    if (session.lastAccessed - lastPersisted < persistIntervalMs) return Promise.resolve();

    // Reserve the interval before awaiting the store so concurrent status polls
    // coalesce onto one write instead of all observing the old timestamp.
    this.ctx.lastPersistedAccess.set(sessionId, session.lastAccessed);
    return this.ctx.callbacks.persistSession(session);
  }

  // ------------------------------------------------------------------ prompt

  /**
   * Accepts a prompt, guaranteeing at-most-once execution.
   *
   * The whole body runs under the thread's dispatch lock so two tabs cannot both
   * observe an idle thread and both dispatch.
   */
}
