import { accountUsageFromLimits } from "./app-server-runtime-base.js";
import type { CodexRuntimeContext } from "./app-server-runtime-context.js";
import type { CodexRuntimeLifecycle } from "./app-server-runtime-lifecycle.js";
import type { CodexRuntimeSessions } from "./app-server-runtime-sessions.js";
import type { AppServerEngine } from "./engine/app-server-engine.js";
import type { EngineAccountUsageWindow } from "./engine/types.js";
import type { SessionPhase } from "./sessions/thread-registry.js";
import type { TurnAccumulator } from "./sessions/turn-accumulator.js";
import {
  getWorkingDirectory,
  listPersistedSessionsWithTitlesForCwd,
  type PersistedSessionMeta,
} from "./history/rollout.js";
import { readPersistedSessionTitleEntries } from "./session-titles.js";
import type { BridgeModel } from "./models-cache.js";
import { toBridgeModel } from "./app-server-runtime-helpers.js";

export class CodexRuntimeTail {
  constructor(
    private readonly ctx: CodexRuntimeContext,
    private readonly lifecycle: CodexRuntimeLifecycle,
    private readonly sessions: CodexRuntimeSessions,
  ) {}

  /**
   * Stops every running turn because the backend that owned this bridge is
   * gone, waiting at most `budgetMs`. Each turn settles as a restart mid-turn
   * (`TurnAccumulator.stoppedByShutdown`), exactly as if app-server had been
   * killed, so a build stage still continues it once after the restart; only
   * the agent stops sooner, and its rollout records where. Returns how many
   * turns it asked to stop. A turn app-server has not named yet is left to the
   * shutdown that follows, which ends the child either way.
   */
  async interruptForParentExit(budgetMs: number): Promise<number> {
    const stopping: Promise<unknown>[] = [];
    for (const context of this.ctx.registry.listThreads()) {
      const turn = context.activeTurn;
      if (!turn || turn.isTerminal() || turn.isUnconfirmed()) continue;
      turn.stoppedByShutdown = true;
      const { engineHandle } = context;
      stopping.push(
        this.ctx.options.engine
          .interruptTurn(engineHandle, turn.turnId)
          .then(() =>
            this.ctx.options.engine.waitForTurnTerminal(engineHandle, turn.turnId, {
              timeoutMs: budgetMs,
            }),
          )
          .catch(() => undefined),
      );
    }
    if (stopping.length === 0) return 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(stopping),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
    clearTimeout(timer);
    return stopping.length;
  }

  async abort(
    sessionId: string,
  ): Promise<{ status: "cancelling" | "idle"; phase: SessionPhase } | null> {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session) return null;
    await this.ctx.callbacks.touchSession(sessionId);

    const context = this.ctx.registry.getThreadForSession(sessionId);
    // Cancelling releases a compaction hold too. Compaction has no interrupt, but
    // an explicit stop must not leave the thread pinned busy on a notification
    // that may never arrive. Released through `finishCompaction` so every mounted
    // tab gets the same status/`compacting: false`/idle retraction frames a
    // finished compaction emits — silently clearing the flag left other tabs
    // showing busy until their next refetch.
    if (context?.compacting) this.sessions.finishCompaction(context);
    const turn = context?.activeTurn;
    if (!context || !turn) {
      // Nothing running; report the real phase rather than forcing idle.
      return {
        status: context?.phase === "idle" ? "idle" : "cancelling",
        phase: context?.phase ?? "idle",
      };
    }

    this.ctx.threadState.get(context.threadId)?.refusedCellTail?.tail.close();
    turn.markCancelling();
    this.ctx.registry.setPhase(context, "cancelling");
    this.lifecycle.emitStatus(context);

    const handle = context.engineHandle;
    const turnId = turn.turnId;
    await this.ctx.options.engine.interruptTurn(handle, turnId).catch(() => undefined);

    void (async () => {
      const status = await this.ctx.options.engine.waitForTurnTerminal(handle, turnId, {
        allowRestart: true,
      });
      // A terminal event normally finalizes via the event path. This covers the
      // case where escalation resolved it without one.
      if (context.activeTurn === turn && !turn.isTerminal()) {
        turn.complete(status === "unknown" ? "interrupted" : status);
        await this.lifecycle.runFinalization(context, turn);
      }
    })().catch(async (error) => {
      // The only rejection after waitForTurnTerminal's internal catches is a
      // replacement-start failure. restartNow has already terminated the old
      // generation, so the turn is definitively no longer executing.
      if (context.activeTurn === turn && !turn.isTerminal()) {
        turn.complete("interrupted");
        await this.lifecycle.runFinalization(context, turn);
      }
      const message =
        error instanceof Error ? error.message : "Failed to restart Codex after cancellation";
      for (const id of context.bridgeSessionIds) {
        this.ctx.options.emit({
          type: "session.error",
          sessionId: id,
          data: { error: message },
        });
      }
    });

    return { status: "cancelling", phase: "cancelling" };
  }

  /** Upper bound on how long a close waits for a last-reference turn to stop. */
  closeStopBudgetMs = 4_000;
  private readonly closeAttempts = new Map<string, Promise<"closed" | "missing" | "pending">>();

  /**
   * Ordinary tab close: retire this bridge session without touching the rollout.
   *
   * Never calls `thread/delete`. What close adds over DELETE is proof:
   *
   * 1. Admission is fenced first (`closingSessionIds`): a prompt, steer,
   *    compaction or review arriving from here on is refused with
   *    `SESSION_CLOSING_ERROR`, so no turn can start between "the last turn is
   *    terminal" and the release below, which would orphan it.
   * 2. On the last reference, a dispatch already in flight (`turn/start` sent,
   *    no turn id yet) is waited for, and a running turn is interrupted through
   *    the same escalating path as an explicit stop; close continues only once
   *    the turn is terminal. A shared thread's other tabs are untouched.
   * 3. The removal is published strictly: a failed tombstone write keeps the
   *    session registered.
   *
   * `pending` (budget exhausted, or the tombstone did not land) leaves the
   * session registered — any interrupt escalation keeps running in the
   * background — and deliberately leaves the admission fence up. The tab that
   * owned this session is gone and the backend's durable close intent retries
   * until it is confirmed, so reopening admission would only let a late prompt
   * start a turn that the retry must then stop. A retry of the same close
   * resumes from the fence; concurrent calls share one attempt.
   */
  closeSessionRetaining(sessionId: string): Promise<"closed" | "missing" | "pending"> {
    const running = this.closeAttempts.get(sessionId);
    if (running) return running;
    const attempt = this.closeSessionOnce(sessionId).finally(() => {
      this.closeAttempts.delete(sessionId);
    });
    this.closeAttempts.set(sessionId, attempt);
    return attempt;
  }

  private async closeSessionOnce(sessionId: string): Promise<"closed" | "missing" | "pending"> {
    if (!this.ctx.registry.getSession(sessionId)) {
      this.ctx.closingSessionIds.delete(sessionId);
      return "missing";
    }
    this.ctx.closingSessionIds.add(sessionId);

    const deadline = Date.now() + Math.max(0, this.closeStopBudgetMs);
    let interrupted: TurnAccumulator | undefined;
    for (;;) {
      const context = this.ctx.registry.getThreadForSession(sessionId);
      // Only the last reference owns the thread's work.
      if (!context || context.bridgeSessionIds.size !== 1) break;
      const turn = context.activeTurn;
      if (!context.dispatchInFlight) {
        if (!turn || turn.isTerminal()) break;
        if (interrupted !== turn) {
          interrupted = turn;
          await this.ctx.callbacks.abort(sessionId);
          continue;
        }
      }
      // A dispatch in flight has no turn id to interrupt yet: the fence stops
      // any new one, so wait for this one to register its turn (or fail).
      if (Date.now() >= deadline) return "pending";
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const released = await this.sessions.releaseBridgeSession(sessionId, "strict");
    if (released === "unpublished") return "pending";
    this.ctx.closingSessionIds.delete(sessionId);
    return released === "released" ? "closed" : "missing";
  }

  // ------------------------------------------------------------------ models

  /**
   * `model/list` is authoritative, with the persisted cache and the hardcoded
   * fallback catalog behind it so a cold app-server cannot empty the model picker.
   */
  async listModels(): Promise<{
    models: BridgeModel[];
    source: "app-server" | "cache" | "fallback";
    supportedModelIds?: string[];
  }> {
    // Read on every request: account changes and child replacement must never
    // leave a previous login's catalogue labelled as live availability.
    try {
      const engineModels = await this.ctx.options.engine.listModels();
      const models = engineModels
        .filter((model) => !model.hidden)
        .map((model) => toBridgeModel(model));
      if (models.length > 0) {
        await this.ctx.options.persistModels?.(models).catch(() => undefined);
        return {
          models,
          source: "app-server",
          supportedModelIds: engineModels.map((model) => model.id),
        };
      }
    } catch (error) {
      console.warn(
        "[codex-bridge] model/list failed; falling back to cache:",
        error instanceof Error ? error.message : error,
      );
    }
    return this.ctx.options.loadCachedModels();
  }

  /**
   * Account plan limits, read fresh from app-server without a thread.
   *
   * Distinct from `getUsage`, which is session-scoped. The settings page has no
   * session, and the app-server answers `account/rateLimits/read` globally.
   */
  async readPlanUsage(): Promise<EngineAccountUsageWindow[] | undefined> {
    const limits = await this.ctx.options.engine.readRateLimitWindows();
    const windows = accountUsageFromLimits(limits, this.ctx.accountCredits);
    // An empty list is a soft-empty read: app-server returned no usable windows
    // (or the payload was malformed). Signal unavailable rather than letting
    // the settings card state the account has no metered limits.
    return windows.length > 0 ? windows : undefined;
  }

  // ----------------------------------------------------------------- history

  /**
   * Native `thread/list` first, then the rollout parser.
   *
   * The fallback is not belt-and-braces: archived, malformed and partially-written
   * threads are only visible on disk, and legacy `exec` sessions must keep
   * appearing after the migration.
   */
  async listSessions(): Promise<{
    sessions: Array<{ id: string; title?: string; detail?: string; updatedAt: string }>;
    cwd: string;
  }> {
    const cwd = getWorkingDirectory(this.ctx.options.cwd);
    const merged = new Map<
      string,
      { id: string; title?: string; detail?: string; updatedAt: string }
    >();

    try {
      const { threads } = await this.ctx.options.engine.listThreads({ cwd });
      for (const thread of threads) {
        if (!thread.id) continue;
        merged.set(thread.id, {
          id: thread.id,
          title: thread.name ?? thread.preview ?? undefined,
          ...(thread.originator ? { detail: `Created by ${thread.originator.slice(0, 120)}` } : {}),
          updatedAt: thread.updatedAt ?? new Date(this.ctx.now()).toISOString(),
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
        generatedTitles ?? (await readPersistedSessionTitleEntries(this.ctx.options.codexHome));
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

  /**
   * Process-wide MCP configuration reload for the management apply path.
   * Session-free on purpose: it must work after a bridge restart that forgot
   * every session, and it must not touch liveness or re-attach a thread.
   */
  reloadMcpConfigurationIfRunning(): ReturnType<AppServerEngine["reloadMcpServersIfRunning"]> {
    return this.ctx.options.engine.reloadMcpServersIfRunning();
  }

  getHealth(): ReturnType<AppServerEngine["getHealth"]> & {
    activeThreads: number;
    activeTurns: number;
    bridgeSessions: number;
    storage: ReturnType<CodexRuntimeLifecycle["getStorageStats"]>;
  } {
    const threads = this.ctx.registry.listThreads();
    return {
      ...this.ctx.options.engine.getHealth(),
      activeThreads: threads.length,
      activeTurns: threads.filter((thread) => thread.activeTurn !== null).length,
      bridgeSessions: this.ctx.registry.listSessions().length,
      storage: this.lifecycle.getStorageStats(),
    };
  }
}
