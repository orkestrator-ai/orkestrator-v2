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
import { AppServerRuntimePrompt } from "./app-server-runtime-prompt.js";
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
import { toBridgeModel } from "./app-server-runtime-helpers.js";


export class AppServerRuntimeTail extends AppServerRuntimePrompt {
  async abort(
    sessionId: string,
  ): Promise<{ status: "cancelling" | "idle"; phase: SessionPhase } | null> {
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    await this.touchSession(sessionId);

    const context = this.registry.getThreadForSession(sessionId);
    // Cancelling releases a compaction hold too. Compaction has no interrupt, but
    // an explicit stop must not leave the thread pinned busy on a notification
    // that may never arrive. Released through `finishCompaction` so every mounted
    // tab gets the same status/`compacting: false`/idle retraction frames a
    // finished compaction emits — silently clearing the flag left other tabs
    // showing busy until their next refetch.
    if (context?.compacting) this.finishCompaction(context);
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
        await this.runFinalization(context, turn);
      }
    })().catch(async (error) => {
      // The only rejection after waitForTurnTerminal's internal catches is a
      // replacement-start failure. restartNow has already terminated the old
      // generation, so the turn is definitively no longer executing.
      if (context.activeTurn === turn && !turn.isTerminal()) {
        turn.complete("interrupted");
        await this.runFinalization(context, turn);
      }
      const message =
        error instanceof Error ? error.message : "Failed to restart Codex after cancellation";
      for (const id of context.bridgeSessionIds) {
        this.options.emit({
          type: "session.error",
          sessionId: id,
          data: { error: message },
        });
      }
    });

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
    // The listing already read and parsed the generated-title index; reuse its
    // map instead of paying a second read + line parse per request.
    let generatedTitles: Map<string, { title: string }> | null = null;
    try {
      const listing = await listPersistedSessionsWithTitlesForCwd(cwd);
      persisted = listing.sessions;
      generatedTitles = listing.generatedTitles;
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
      const generated =
        generatedTitles ?? await readPersistedSessionTitleEntries(this.options.codexHome);
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
    storage: ReturnType<AppServerRuntimeTail["getStorageStats"]>;
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
