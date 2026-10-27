/**
 * State shared by the `AppServerRuntime` collaborators.
 *
 * Built once by the facade (`app-server-runtime.ts`) and handed to each
 * collaborator: the thread registry, dispatch journal, session store, command
 * catalogue, per-thread render state, and the fences and pending-work sets
 * that shutdown and dispatch admission read. It also carries the few calls a
 * collaborator makes on one built after it, or on the facade itself, as
 * `callbacks`.
 */

import type { ApprovalRequest } from "./app-server/approvals.js";
import type { InteractionRequest } from "./app-server/interactions.js";
import { CodexCommandCatalogue } from "./commands/codex-command-catalogue.js";
import type { EngineRateLimitWindow, EngineUsageSnapshot } from "./engine/types.js";
import { ThreadRegistry } from "./sessions/thread-registry.js";
import { DispatchJournal } from "./sessions/dispatch-journal.js";
import { BridgeSessionStore } from "./sessions/persistence.js";
import {
  MAX_STRUCTURED_OUTPUT_TURNS,
  type StructuredOutputTurnRecord,
} from "@orkestrator/protocol/structured-output";
import type { AppServerRuntimeOptions, ThreadRuntimeState } from "./app-server-runtime-base.js";
import type { CodexRuntimeLifecycle } from "./app-server-runtime-lifecycle.js";
import type { CodexRuntimeSessions } from "./app-server-runtime-sessions.js";
import type { CodexRuntimePrompt } from "./app-server-runtime-prompt.js";
import type { CodexRuntimeTail } from "./app-server-runtime-tail.js";

/**
 * Calls a collaborator cannot make directly, wired once by `AppServerRuntime`.
 *
 * The first group was the base class's `abstract` declarations: each is
 * implemented by a collaborator built after its caller. The second group goes
 * through the facade's own method, as `this.x()` did on the single class, so a
 * test that patches that method on the runtime still sees the internal calls.
 */
export interface CodexRuntimeCallbacks {
  reloadStoredAccountLogin: CodexRuntimePrompt["reloadStoredAccountLogin"];
  notifyThreadActivity: CodexRuntimePrompt["notifyThreadActivity"];
  scheduleRecoveryBackstop: CodexRuntimePrompt["scheduleRecoveryBackstop"];
  bumpMessageRevision: CodexRuntimePrompt["bumpMessageRevision"];
  settleAmbiguousDispatch: CodexRuntimePrompt["settleAmbiguousDispatch"];
  appendUserMessage: CodexRuntimePrompt["appendUserMessage"];
  messagesForSession: CodexRuntimePrompt["messagesForSession"];
  clearCompactionBackstop: CodexRuntimeSessions["clearCompactionBackstop"];
  finishCompaction: CodexRuntimeSessions["finishCompaction"];
  reconcileExternalRevert: CodexRuntimeSessions["reconcileExternalRevert"];

  abort: CodexRuntimeTail["abort"];
  listModels: CodexRuntimeTail["listModels"];
  persistSession: CodexRuntimeSessions["persistSession"];
  touchSession: CodexRuntimeSessions["touchSession"];
  deleteSession: CodexRuntimeSessions["deleteSession"];
  transcriptComplete: CodexRuntimeSessions["transcriptComplete"];
  ensureAttached: CodexRuntimeLifecycle["ensureAttached"];
  primeCommandChanges: CodexRuntimeLifecycle["primeCommandChanges"];
  publishAssistantMessage: CodexRuntimeLifecycle["publishAssistantMessage"];
  finalizeTurn: CodexRuntimeLifecycle["finalizeTurn"];
  recoverAfterGenerationChange: CodexRuntimeLifecycle["recoverAfterGenerationChange"];
}

export class CodexRuntimeContext {
  readonly options: AppServerRuntimeOptions;
  readonly registry: ThreadRegistry;
  readonly journal: DispatchJournal;
  readonly store: BridgeSessionStore;
  readonly threadState = new Map<string, ThreadRuntimeState>();
  readonly now: () => number;
  started = false;
  /** Shared by concurrent callers; cleared after failure so startup can retry. */
  startPromise: Promise<void> | null = null;
  stopping = false;
  sweepTimer: ReturnType<typeof setInterval> | null = null;
  detachedThreads = 0;
  reattachedThreads = 0;
  /** Last activity timestamp scheduled for durable persistence, by bridge id. */
  readonly lastPersistedAccess = new Map<string, number>();
  /** In-flight registry writes that graceful shutdown must not abandon. */
  readonly pendingSessionWrites = new Set<Promise<void>>();
  /**
   * Terminal notification work intentionally runs off the transport read loop.
   *
   * Tracking it separately preserves that non-blocking transport contract while
   * giving shutdown and deterministic callers a way to wait for journal,
   * rendering, persistence, and terminal SSE publication to finish.
   */
  readonly pendingFinalizations = new Set<Promise<void>>();
  /**
   * Worktree measurements and journal writes for shell commands. Off the read
   * loop like finalization, and tracked the same way so shutdown can let a
   * measurement reach its journal and tests can wait for one to land.
   */
  readonly pendingCommandChanges = new Set<Promise<void>>();
  /** Dispatch preparation must cross the RPC boundary before a reload gates RPCs. */
  readonly admittedDispatches = new Set<Promise<void>>();
  accountReload: Promise<void> | null = null;
  private pendingDispatchAdmissions = 0;
  resolveDispatchAdmissionStop!: () => void;
  readonly dispatchAdmissionStopped = new Promise<void>((resolve) => {
    this.resolveDispatchAdmissionStop = resolve;
  });

  async withDispatchAdmission<T>(dispatch: () => Promise<T>): Promise<T> {
    // Bound both preparation claims and requests waiting for the reload fence.
    if (this.pendingDispatchAdmissions >= 256) throw new Error("Codex dispatch admission is full");
    this.pendingDispatchAdmissions += 1;
    let done: Promise<void> | undefined;
    let release: (() => void) | undefined;
    try {
      while (this.accountReload && !this.stopping) await this.accountReload;
      if (this.stopping) throw new Error("Codex bridge is stopping");
      done = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.admittedDispatches.add(done);
      return await dispatch();
    } finally {
      this.pendingDispatchAdmissions -= 1;
      if (done) this.admittedDispatches.delete(done);
      release?.();
    }
  }

  /** Serializes and exposes generation recovery to request paths. */
  generationRecovery: Promise<void> = Promise.resolve();
  /**
   * Exposes startup dispatch recovery to request paths.
   *
   * The HTTP server is listening before `start()` resolves, so a prompt can
   * arrive while unresolved journal records are still being settled. Dispatching
   * in that window would race recovery for the same thread.
   */
  dispatchRecovery: Promise<void> = Promise.resolve();
  /**
   * Threads with an unresolved dispatch that recovery has not reached yet.
   *
   * Populated synchronously at startup so `getStatus` can never report `idle`
   * for a session whose last turn may still have been executing — the build
   * pipeline would advance on it.
   */
  readonly threadsAwaitingDispatchRecovery = new Set<string>();
  /**
   * Wake-ups for the pre-restart drain.
   *
   * Turn transitions are the only thing that can end the wait, so the drain
   * listens for them rather than polling the registry at speed.
   */
  readonly idleWaiters = new Set<() => void>();
  /** Forces `recovering` → `failed`, keyed by thread, so it can never be permanent. */
  readonly recoveryBackstops = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Releases a thread whose `thread/compacted` never arrived.
   *
   * Compaction has no response to wait on, so a lost notification would leave
   * the thread `running` for the life of the bridge.
   */
  readonly compactionBackstops = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Approvals the UI has been told about and can still answer.
   *
   * The router is the authority on lifetime; this holds the session mapping the
   * router has no way to compute, and is what `/session/:id/approvals` reads so a
   * remounting tab rehydrates rather than depending on having seen the SSE frame.
   */
  readonly pendingApprovals = new Map<string, { request: ApprovalRequest }>();
  readonly pendingInteractions = new Map<string, { request: InteractionRequest }>();
  readonly usageByThread = new Map<string, EngineUsageSnapshot>();
  /**
   * In-flight rollout reads keyed by thread id.
   *
   * `attach()` publishes the thread before `hydrateMessagesFromPersistedSession`
   * resolves. Concurrent `ensureAttached` callers must wait for that assignment
   * instead of fast-returning an empty context as the exact transcript.
   */
  readonly transcriptHydrateInFlight = new Map<string, Promise<void>>();
  /**
   * Prompt requests between route entry and their return, counted per request
   * id. `/dispatch` never answers `absent` for one: it may not have journaled
   * yet. Bounded by the prompt requests in flight; each entry is removed in a
   * `finally`.
   */
  readonly promptRequestsInFlight = new Map<string, number>();
  /**
   * Bounded, process-local steering idempotency state.
   *
   * app-server persists `clientUserMessageId` on every steered userMessage, so
   * an ambiguous response can be reconciled through thread/read. Remembering the
   * request here prevents a confirmed response from being dispatched twice and
   * tells an ambiguous retry that it must reconcile before doing anything.
   */
  readonly steerRequests = new Map<
    string,
    {
      threadId: string;
      turnId: string;
      inputDigest: string;
      state: "accepted" | "unknown";
      requestedAt: string;
    }
  >();
  /**
   * Executable command catalogue: built-ins, prompt templates and the private
   * skill registry. Shared by the picker route, `/help` and prompt dispatch so
   * all three resolve names identically.
   */
  readonly commandCatalogue: CodexCommandCatalogue;
  /** Invalidation only; refreshing exclusions runs outside the stdout loop. */
  projectSkillsRevision = 0;
  accountRateLimits: EngineRateLimitWindow[] = [];
  accountCredits?: import("./engine/types.js").EngineCreditSnapshot;

  /** Close admission fence shared with lazy thread reattachment. */
  readonly closingSessionIds = new Set<string>();

  constructor(
    options: AppServerRuntimeOptions,
    readonly callbacks: CodexRuntimeCallbacks,
  ) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.registry = new ThreadRegistry({ now: this.now });
    this.journal = new DispatchJournal({
      codexHome: options.codexHome,
      cwd: options.cwd,
      maxRecords: options.dispatchJournalMaxRecords,
      maxBytes: options.dispatchJournalMaxBytes,
    });
    this.store = new BridgeSessionStore({
      codexHome: options.codexHome,
      cwd: options.cwd,
      now: this.now,
      retentionMs: options.sessionRetentionMs,
    });
    this.commandCatalogue = new CodexCommandCatalogue({
      engine: options.engine,
      cwd: options.cwd,
      now: this.now,
      ...(options.skillInventoryTtlMs !== undefined
        ? { skillTtlMs: options.skillInventoryTtlMs }
        : {}),
      ...(options.skillRefreshDebounceMs !== undefined
        ? { skillRefreshDebounceMs: options.skillRefreshDebounceMs }
        : {}),
      ...(options.skillColdSettleMs !== undefined
        ? { skillColdSettleMs: options.skillColdSettleMs }
        : {}),
    });
  }

  /** Rows recently changed for a session, newest first; see `BridgeSession.revisedRows`. */
  getRevisedRowsOverflowVersion(sessionId: string): number {
    return this.registry.getSession(sessionId)?.revisedRows?.overflowVersion ?? 0;
  }

  getRevisedMessageIds(sessionId: string): readonly string[] {
    return this.registry.getSession(sessionId)?.revisedRows?.ids() ?? [];
  }

  sessionIdsForThread(threadId: string): string[] {
    return this.registry.sessionsForThread(threadId).map((session) => session.id);
  }

  /** Union the durable structured-turn ledger across every tab bound to a thread. */
  structuredOutputTurnsForThread(threadId: string): StructuredOutputTurnRecord[] {
    const turns = new Map<string, boolean>();
    for (const session of this.registry.boundSessionsForThread(threadId)) {
      for (const entry of session.structuredOutputTurns ?? []) {
        turns.set(entry.turnId, (turns.get(entry.turnId) ?? false) || entry.accepted);
      }
    }
    return [...turns]
      .slice(-MAX_STRUCTURED_OUTPUT_TURNS)
      .map(([turnId, accepted]) => ({ turnId, accepted }));
  }
}
