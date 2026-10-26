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
 *
 * `AppServerRuntime` is a facade. Its state lives in one `CodexRuntimeContext`
 * (`app-server-runtime-context.ts`), and the work is done by collaborators
 * that take it, none extending another (`tests/unit/inheritance-chains.test.ts`):
 *
 * - `app-server-runtime-lifecycle.ts`: start/stop, dispatch-journal recovery,
 *   idle detach and reattach, the engine event path, finalization and the
 *   ordered publish queue.
 * - `app-server-runtime-sessions.ts`: the session registry: create, resume,
 *   fork, compact, steer, review, config, transcript reads and persistence.
 * - `app-server-runtime-prompt.ts`: prompt dispatch, ambiguous-dispatch
 *   settlement, the command catalogue and the idle drain for account reloads.
 * - `app-server-runtime-tail.ts`: cancellation, tab close, models, history
 *   listing and health.
 * - `app-server-runtime-approvals.ts`: approval and interaction cards.
 *
 * The app-server stdout loop reaches this class only through the engine
 * subscription and the approval/interaction handlers wired below. Each is a
 * synchronous call into a collaborator; nothing on that path awaits.
 */

export * from "./app-server-runtime-base.js";
export * from "./app-server-runtime-helpers.js";
export { SESSION_CLOSING_ERROR } from "./app-server-runtime-sessions.js";

import type { AppServerRuntimeOptions } from "./app-server-runtime-base.js";
import { CodexRuntimeApprovals } from "./app-server-runtime-approvals.js";
import { CodexRuntimeContext } from "./app-server-runtime-context.js";
import { CodexRuntimeLifecycle } from "./app-server-runtime-lifecycle.js";
import { CodexRuntimePrompt } from "./app-server-runtime-prompt.js";
import { CodexRuntimeSessions } from "./app-server-runtime-sessions.js";
import { CodexRuntimeTail } from "./app-server-runtime-tail.js";
import type { BridgeSessionStore } from "./sessions/persistence.js";
import type { ThreadRegistry } from "./sessions/thread-registry.js";

export class AppServerRuntime {
  private readonly context: CodexRuntimeContext;
  private readonly lifecycle: CodexRuntimeLifecycle;
  private readonly sessions: CodexRuntimeSessions;
  private readonly prompts: CodexRuntimePrompt;
  private readonly tail: CodexRuntimeTail;
  private readonly approvals: CodexRuntimeApprovals;

  constructor(options: AppServerRuntimeOptions) {
    this.context = new CodexRuntimeContext(options, {
      reloadStoredAccountLogin: (...args) => this.prompts.reloadStoredAccountLogin(...args),
      notifyThreadActivity: (...args) => this.prompts.notifyThreadActivity(...args),
      scheduleRecoveryBackstop: (...args) => this.prompts.scheduleRecoveryBackstop(...args),
      bumpMessageRevision: (...args) => this.prompts.bumpMessageRevision(...args),
      settleAmbiguousDispatch: (...args) => this.prompts.settleAmbiguousDispatch(...args),
      appendUserMessage: (...args) => this.prompts.appendUserMessage(...args),
      messagesForSession: (...args) => this.prompts.messagesForSession(...args),
      clearCompactionBackstop: (...args) => this.sessions.clearCompactionBackstop(...args),
      finishCompaction: (...args) => this.sessions.finishCompaction(...args),

      abort: (...args) => this.abort(...args),
      listModels: (...args) => this.listModels(...args),
      persistSession: (...args) => this.persistSession(...args),
      touchSession: (...args) => this.touchSession(...args),
      deleteSession: (...args) => this.deleteSession(...args),
      transcriptComplete: (...args) => this.transcriptComplete(...args),
      ensureAttached: (...args) => this.ensureAttached(...args),
      primeCommandChanges: (...args) => this.primeCommandChanges(...args),
      publishAssistantMessage: (...args) => this.publishAssistantMessage(...args),
      finalizeTurn: (...args) => this.finalizeTurn(...args),
      recoverAfterGenerationChange: (...args) => this.recoverAfterGenerationChange(...args),
    });
    this.lifecycle = new CodexRuntimeLifecycle(this.context);
    this.sessions = new CodexRuntimeSessions(this.context, this.lifecycle);
    this.prompts = new CodexRuntimePrompt(this.context, this.lifecycle, this.sessions);
    this.tail = new CodexRuntimeTail(this.context, this.lifecycle, this.sessions);
    this.approvals = new CodexRuntimeApprovals(this.context, this.lifecycle);

    options.engine.subscribe((event) => this.lifecycle.onEngineEvent(event));

    options.engine.setApprovalHandlers({
      present: (request) => this.approvals.presentApproval(request),
      resolved: (request, decision, resolution) =>
        this.approvals.onApprovalResolved(request, decision, resolution),
    });
    options.engine.setInteractionHandlers({
      present: (request) => this.approvals.presentInteraction(request),
      resolved: (request, answer, resolution) =>
        this.approvals.onInteractionResolved(request, answer, resolution),
    });
  }

  // -------------------------------------------------------------------------
  // Revised rows

  getRevisedRowsOverflowVersion(
    ...args: Parameters<CodexRuntimeContext["getRevisedRowsOverflowVersion"]>
  ): ReturnType<CodexRuntimeContext["getRevisedRowsOverflowVersion"]> {
    return this.context.getRevisedRowsOverflowVersion(...args);
  }

  getRevisedMessageIds(
    ...args: Parameters<CodexRuntimeContext["getRevisedMessageIds"]>
  ): ReturnType<CodexRuntimeContext["getRevisedMessageIds"]> {
    return this.context.getRevisedMessageIds(...args);
  }

  // -------------------------------------------------------------------------
  // Approvals and interactions

  listApprovals(
    ...args: Parameters<CodexRuntimeApprovals["listApprovals"]>
  ): ReturnType<CodexRuntimeApprovals["listApprovals"]> {
    return this.approvals.listApprovals(...args);
  }

  respondToApproval(
    ...args: Parameters<CodexRuntimeApprovals["respondToApproval"]>
  ): ReturnType<CodexRuntimeApprovals["respondToApproval"]> {
    return this.approvals.respondToApproval(...args);
  }

  listInteractions(
    ...args: Parameters<CodexRuntimeApprovals["listInteractions"]>
  ): ReturnType<CodexRuntimeApprovals["listInteractions"]> {
    return this.approvals.listInteractions(...args);
  }

  respondToInteraction(
    ...args: Parameters<CodexRuntimeApprovals["respondToInteraction"]>
  ): ReturnType<CodexRuntimeApprovals["respondToInteraction"]> {
    return this.approvals.respondToInteraction(...args);
  }

  holdApproval(
    ...args: Parameters<CodexRuntimeApprovals["holdApproval"]>
  ): ReturnType<CodexRuntimeApprovals["holdApproval"]> {
    return this.approvals.holdApproval(...args);
  }

  holdInteraction(
    ...args: Parameters<CodexRuntimeApprovals["holdInteraction"]>
  ): ReturnType<CodexRuntimeApprovals["holdInteraction"]> {
    return this.approvals.holdInteraction(...args);
  }

  // -------------------------------------------------------------------------
  // Process lifecycle and supervision

  start(
    ...args: Parameters<CodexRuntimeLifecycle["start"]>
  ): ReturnType<CodexRuntimeLifecycle["start"]> {
    return this.lifecycle.start(...args);
  }

  stop(
    ...args: Parameters<CodexRuntimeLifecycle["stop"]>
  ): ReturnType<CodexRuntimeLifecycle["stop"]> {
    return this.lifecycle.stop(...args);
  }

  drainPendingWork(
    ...args: Parameters<CodexRuntimeLifecycle["drainPendingWork"]>
  ): ReturnType<CodexRuntimeLifecycle["drainPendingWork"]> {
    return this.lifecycle.drainPendingWork(...args);
  }

  getRegistry(
    ...args: Parameters<CodexRuntimeLifecycle["getRegistry"]>
  ): ReturnType<CodexRuntimeLifecycle["getRegistry"]> {
    return this.lifecycle.getRegistry(...args);
  }

  getJournal(
    ...args: Parameters<CodexRuntimeLifecycle["getJournal"]>
  ): ReturnType<CodexRuntimeLifecycle["getJournal"]> {
    return this.lifecycle.getJournal(...args);
  }

  sweepIdle(
    ...args: Parameters<CodexRuntimeLifecycle["sweepIdle"]>
  ): ReturnType<CodexRuntimeLifecycle["sweepIdle"]> {
    return this.lifecycle.sweepIdle(...args);
  }

  getStorageStats(
    ...args: Parameters<CodexRuntimeLifecycle["getStorageStats"]>
  ): ReturnType<CodexRuntimeLifecycle["getStorageStats"]> {
    return this.lifecycle.getStorageStats(...args);
  }

  // -------------------------------------------------------------------------
  // Thread and session registry

  createSession(
    ...args: Parameters<CodexRuntimeSessions["createSession"]>
  ): ReturnType<CodexRuntimeSessions["createSession"]> {
    return this.sessions.createSession(...args);
  }

  resumeSession(
    ...args: Parameters<CodexRuntimeSessions["resumeSession"]>
  ): ReturnType<CodexRuntimeSessions["resumeSession"]> {
    return this.sessions.resumeSession(...args);
  }

  forkSession(
    ...args: Parameters<CodexRuntimeSessions["forkSession"]>
  ): ReturnType<CodexRuntimeSessions["forkSession"]> {
    return this.sessions.forkSession(...args);
  }

  compactSession(
    ...args: Parameters<CodexRuntimeSessions["compactSession"]>
  ): ReturnType<CodexRuntimeSessions["compactSession"]> {
    return this.sessions.compactSession(...args);
  }

  steerSession(
    ...args: Parameters<CodexRuntimeSessions["steerSession"]>
  ): ReturnType<CodexRuntimeSessions["steerSession"]> {
    return this.sessions.steerSession(...args);
  }

  steerDispatchStatus(
    ...args: Parameters<CodexRuntimeSessions["steerDispatchStatus"]>
  ): ReturnType<CodexRuntimeSessions["steerDispatchStatus"]> {
    return this.sessions.steerDispatchStatus(...args);
  }

  startNativeReview(
    ...args: Parameters<CodexRuntimeSessions["startNativeReview"]>
  ): ReturnType<CodexRuntimeSessions["startNativeReview"]> {
    return this.sessions.startNativeReview(...args);
  }

  getRuntimeHealth(
    ...args: Parameters<CodexRuntimeSessions["getRuntimeHealth"]>
  ): ReturnType<CodexRuntimeSessions["getRuntimeHealth"]> {
    return this.sessions.getRuntimeHealth(...args);
  }

  listMcpServers(
    ...args: Parameters<CodexRuntimeSessions["listMcpServers"]>
  ): ReturnType<CodexRuntimeSessions["listMcpServers"]> {
    return this.sessions.listMcpServers(...args);
  }

  performMcpAction(
    ...args: Parameters<CodexRuntimeSessions["performMcpAction"]>
  ): ReturnType<CodexRuntimeSessions["performMcpAction"]> {
    return this.sessions.performMcpAction(...args);
  }

  readAuthStatus(
    ...args: Parameters<CodexRuntimeSessions["readAuthStatus"]>
  ): ReturnType<CodexRuntimeSessions["readAuthStatus"]> {
    return this.sessions.readAuthStatus(...args);
  }

  beginAuthLogin(
    ...args: Parameters<CodexRuntimeSessions["beginAuthLogin"]>
  ): ReturnType<CodexRuntimeSessions["beginAuthLogin"]> {
    return this.sessions.beginAuthLogin(...args);
  }

  logoutAuth(
    ...args: Parameters<CodexRuntimeSessions["logoutAuth"]>
  ): ReturnType<CodexRuntimeSessions["logoutAuth"]> {
    return this.sessions.logoutAuth(...args);
  }

  cancelAuthLogin(
    ...args: Parameters<CodexRuntimeSessions["cancelAuthLogin"]>
  ): ReturnType<CodexRuntimeSessions["cancelAuthLogin"]> {
    return this.sessions.cancelAuthLogin(...args);
  }

  rewindMessages(
    ...args: Parameters<CodexRuntimeSessions["rewindMessages"]>
  ): ReturnType<CodexRuntimeSessions["rewindMessages"]> {
    return this.sessions.rewindMessages(...args);
  }

  setSessionTitle(
    ...args: Parameters<CodexRuntimeSessions["setSessionTitle"]>
  ): ReturnType<CodexRuntimeSessions["setSessionTitle"]> {
    return this.sessions.setSessionTitle(...args);
  }

  updateConfig(
    ...args: Parameters<CodexRuntimeSessions["updateConfig"]>
  ): ReturnType<CodexRuntimeSessions["updateConfig"]> {
    return this.sessions.updateConfig(...args);
  }

  getMessages(
    ...args: Parameters<CodexRuntimeSessions["getMessages"]>
  ): ReturnType<CodexRuntimeSessions["getMessages"]> {
    return this.sessions.getMessages(...args);
  }

  getCachedMessages(
    ...args: Parameters<CodexRuntimeSessions["getCachedMessages"]>
  ): ReturnType<CodexRuntimeSessions["getCachedMessages"]> {
    return this.sessions.getCachedMessages(...args);
  }

  transcriptComplete(
    ...args: Parameters<CodexRuntimeSessions["transcriptComplete"]>
  ): ReturnType<CodexRuntimeSessions["transcriptComplete"]> {
    return this.sessions.transcriptComplete(...args);
  }

  getUsage(
    ...args: Parameters<CodexRuntimeSessions["getUsage"]>
  ): ReturnType<CodexRuntimeSessions["getUsage"]> {
    return this.sessions.getUsage(...args);
  }

  getStatus(
    ...args: Parameters<CodexRuntimeSessions["getStatus"]>
  ): ReturnType<CodexRuntimeSessions["getStatus"]> {
    return this.sessions.getStatus(...args);
  }

  getActivity(
    ...args: Parameters<CodexRuntimeSessions["getActivity"]>
  ): ReturnType<CodexRuntimeSessions["getActivity"]> {
    return this.sessions.getActivity(...args);
  }

  humanPromptOutput(sessionId: string) {
    return this.sessions.humanPromptOutput(sessionId);
  }

  getActivitySnapshot(
    ...args: Parameters<CodexRuntimeSessions["getActivitySnapshot"]>
  ): ReturnType<CodexRuntimeSessions["getActivitySnapshot"]> {
    return this.sessions.getActivitySnapshot(...args);
  }

  getStructuredOutput(
    ...args: Parameters<CodexRuntimeSessions["getStructuredOutput"]>
  ): ReturnType<CodexRuntimeSessions["getStructuredOutput"]> {
    return this.sessions.getStructuredOutput(...args);
  }

  deleteSession(
    ...args: Parameters<CodexRuntimeSessions["deleteSession"]>
  ): ReturnType<CodexRuntimeSessions["deleteSession"]> {
    return this.sessions.deleteSession(...args);
  }

  getConfig(
    ...args: Parameters<CodexRuntimeSessions["getConfig"]>
  ): ReturnType<CodexRuntimeSessions["getConfig"]> {
    return this.sessions.getConfig(...args);
  }

  // -------------------------------------------------------------------------
  // Turn dispatch and commands

  prompt(
    ...args: Parameters<CodexRuntimePrompt["prompt"]>
  ): ReturnType<CodexRuntimePrompt["prompt"]> {
    return this.prompts.prompt(...args);
  }

  getCommandCatalogue(
    ...args: Parameters<CodexRuntimePrompt["getCommandCatalogue"]>
  ): ReturnType<CodexRuntimePrompt["getCommandCatalogue"]> {
    return this.prompts.getCommandCatalogue(...args);
  }

  refreshCommandCatalogue(
    ...args: Parameters<CodexRuntimePrompt["refreshCommandCatalogue"]>
  ): ReturnType<CodexRuntimePrompt["refreshCommandCatalogue"]> {
    return this.prompts.refreshCommandCatalogue(...args);
  }

  // -------------------------------------------------------------------------
  // Cancellation, close, models, history and health

  /** Upper bound on how long a close waits for a last-reference turn to stop. */
  get closeStopBudgetMs(): number {
    return this.tail.closeStopBudgetMs;
  }

  set closeStopBudgetMs(value: number) {
    this.tail.closeStopBudgetMs = value;
  }

  interruptForParentExit(
    ...args: Parameters<CodexRuntimeTail["interruptForParentExit"]>
  ): ReturnType<CodexRuntimeTail["interruptForParentExit"]> {
    return this.tail.interruptForParentExit(...args);
  }

  abort(...args: Parameters<CodexRuntimeTail["abort"]>): ReturnType<CodexRuntimeTail["abort"]> {
    return this.tail.abort(...args);
  }

  closeSessionRetaining(
    ...args: Parameters<CodexRuntimeTail["closeSessionRetaining"]>
  ): ReturnType<CodexRuntimeTail["closeSessionRetaining"]> {
    return this.tail.closeSessionRetaining(...args);
  }

  listModels(
    ...args: Parameters<CodexRuntimeTail["listModels"]>
  ): ReturnType<CodexRuntimeTail["listModels"]> {
    return this.tail.listModels(...args);
  }

  readPlanUsage(
    ...args: Parameters<CodexRuntimeTail["readPlanUsage"]>
  ): ReturnType<CodexRuntimeTail["readPlanUsage"]> {
    return this.tail.readPlanUsage(...args);
  }

  listSessions(
    ...args: Parameters<CodexRuntimeTail["listSessions"]>
  ): ReturnType<CodexRuntimeTail["listSessions"]> {
    return this.tail.listSessions(...args);
  }

  reloadMcpConfigurationIfRunning(
    ...args: Parameters<CodexRuntimeTail["reloadMcpConfigurationIfRunning"]>
  ): ReturnType<CodexRuntimeTail["reloadMcpConfigurationIfRunning"]> {
    return this.tail.reloadMcpConfigurationIfRunning(...args);
  }

  getHealth(
    ...args: Parameters<CodexRuntimeTail["getHealth"]>
  ): ReturnType<CodexRuntimeTail["getHealth"]> {
    return this.tail.getHealth(...args);
  }

  // -------------------------------------------------------------------------
  // Internals the old single class exposed through `this`
  //
  // Tests reach these through a cast. The first group is also what
  // collaborators call through `callbacks`, so patching one of them on the
  // runtime still intercepts the internal calls, as it did before the split.

  protected persistSession(
    ...args: Parameters<CodexRuntimeSessions["persistSession"]>
  ): ReturnType<CodexRuntimeSessions["persistSession"]> {
    return this.sessions.persistSession(...args);
  }

  protected touchSession(
    ...args: Parameters<CodexRuntimeSessions["touchSession"]>
  ): ReturnType<CodexRuntimeSessions["touchSession"]> {
    return this.sessions.touchSession(...args);
  }

  protected ensureAttached(
    ...args: Parameters<CodexRuntimeLifecycle["ensureAttached"]>
  ): ReturnType<CodexRuntimeLifecycle["ensureAttached"]> {
    return this.lifecycle.ensureAttached(...args);
  }

  protected primeCommandChanges(
    ...args: Parameters<CodexRuntimeLifecycle["primeCommandChanges"]>
  ): ReturnType<CodexRuntimeLifecycle["primeCommandChanges"]> {
    return this.lifecycle.primeCommandChanges(...args);
  }

  protected publishAssistantMessage(
    ...args: Parameters<CodexRuntimeLifecycle["publishAssistantMessage"]>
  ): ReturnType<CodexRuntimeLifecycle["publishAssistantMessage"]> {
    return this.lifecycle.publishAssistantMessage(...args);
  }

  protected finalizeTurn(
    ...args: Parameters<CodexRuntimeLifecycle["finalizeTurn"]>
  ): ReturnType<CodexRuntimeLifecycle["finalizeTurn"]> {
    return this.lifecycle.finalizeTurn(...args);
  }

  protected recoverAfterGenerationChange(
    ...args: Parameters<CodexRuntimeLifecycle["recoverAfterGenerationChange"]>
  ): ReturnType<CodexRuntimeLifecycle["recoverAfterGenerationChange"]> {
    return this.lifecycle.recoverAfterGenerationChange(...args);
  }

  protected get options(): AppServerRuntimeOptions {
    return this.context.options;
  }

  protected get registry(): ThreadRegistry {
    return this.context.registry;
  }

  protected get store(): BridgeSessionStore {
    return this.context.store;
  }

  protected get threadState(): CodexRuntimeContext["threadState"] {
    return this.context.threadState;
  }

  protected get threadsAwaitingDispatchRecovery(): CodexRuntimeContext["threadsAwaitingDispatchRecovery"] {
    return this.context.threadsAwaitingDispatchRecovery;
  }

  protected get pendingFinalizations(): CodexRuntimeContext["pendingFinalizations"] {
    return this.context.pendingFinalizations;
  }

  protected get pendingInteractions(): CodexRuntimeContext["pendingInteractions"] {
    return this.context.pendingInteractions;
  }

  protected get usageByThread(): CodexRuntimeContext["usageByThread"] {
    return this.context.usageByThread;
  }

  protected reloadStoredAccountLogin(
    ...args: Parameters<CodexRuntimePrompt["reloadStoredAccountLogin"]>
  ): ReturnType<CodexRuntimePrompt["reloadStoredAccountLogin"]> {
    return this.prompts.reloadStoredAccountLogin(...args);
  }

  protected waitForAllThreadsIdle(
    ...args: Parameters<CodexRuntimePrompt["waitForAllThreadsIdle"]>
  ): ReturnType<CodexRuntimePrompt["waitForAllThreadsIdle"]> {
    return this.prompts.waitForAllThreadsIdle(...args);
  }

  protected detachThread(
    ...args: Parameters<CodexRuntimeLifecycle["detachThread"]>
  ): ReturnType<CodexRuntimeLifecycle["detachThread"]> {
    return this.lifecycle.detachThread(...args);
  }

  protected releaseThreadRuntimeState(
    ...args: Parameters<CodexRuntimeLifecycle["releaseThreadRuntimeState"]>
  ): ReturnType<CodexRuntimeLifecycle["releaseThreadRuntimeState"]> {
    return this.lifecycle.releaseThreadRuntimeState(...args);
  }

  protected bufferEvent(
    ...args: Parameters<CodexRuntimeLifecycle["bufferEvent"]>
  ): ReturnType<CodexRuntimeLifecycle["bufferEvent"]> {
    return this.lifecycle.bufferEvent(...args);
  }

  protected enqueueAfterMessageFlush(
    ...args: Parameters<CodexRuntimeLifecycle["enqueueAfterMessageFlush"]>
  ): ReturnType<CodexRuntimeLifecycle["enqueueAfterMessageFlush"]> {
    return this.lifecycle.enqueueAfterMessageFlush(...args);
  }

  protected applyCommandChanges(
    ...args: Parameters<CodexRuntimeLifecycle["applyCommandChanges"]>
  ): ReturnType<CodexRuntimeLifecycle["applyCommandChanges"]> {
    return this.lifecycle.applyCommandChanges(...args);
  }
}
