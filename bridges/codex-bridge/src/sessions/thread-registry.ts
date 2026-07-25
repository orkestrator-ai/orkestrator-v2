/**
 * Two-layer session model for the app-server engine.
 *
 * app-server notifications identify a Codex **threadId**, not an Orkestrator
 * bridge session id. Two tabs can legitimately resume the same persisted thread,
 * so the bridge needs a canonical owner per thread rather than a transcript per
 * tab:
 *
 *   BridgeSession (one per tab)  ──┐
 *   BridgeSession (one per tab)  ──┼──▶ ThreadContext (one per Codex threadId)
 *                                  │      canonical messages
 *                                  │      at most one active turn
 *                                  └──    reference count
 *
 * Without this, the same conversation would exist as two divergent in-memory
 * transcripts and both tabs could start overlapping turns on one thread.
 */
import type { EngineGeneration, EngineTurnConfig } from "../engine/types.js";
import type { NormalizedMessage } from "../messages/types.js";
import type { TurnAccumulator } from "./turn-accumulator.js";
import type { PersistedSessionTitleSource } from "../session-titles.js";

export type SessionTitleSource = "codex" | PersistedSessionTitleSource;

/**
 * Externally visible session status.
 *
 * `status` keeps the pre-migration `idle | running | error` contract so the build
 * pipeline and existing UI keep working; `phase` carries the detail that
 * app-server makes possible. Crucially `cancelling` and `recovering` both report
 * `running`: reporting them as idle would let the pipeline advance a phase, or a
 * tab start a new prompt, while the previous turn may still be executing.
 */
export type SessionPhase =
  | "starting"
  | "running"
  | "cancelling"
  | "recovering"
  | "idle"
  | "failed";

export type ExternalSessionStatus = "idle" | "running" | "error";

export function phaseToExternalStatus(phase: SessionPhase): ExternalSessionStatus {
  switch (phase) {
    case "starting":
    case "running":
    case "cancelling":
    case "recovering":
      return "running";
    case "failed":
      return "error";
    case "idle":
      return "idle";
  }
}

export interface BridgeSession {
  id: string;
  /** Null until the first prompt materializes a Codex thread. */
  threadId: string | null;
  config: EngineTurnConfig;
  title?: string;
  titleSource?: SessionTitleSource;
  titleGenerationAttempted?: boolean;
  titleGenerationToken?: symbol;
  lastAcceptedRequestId?: string;
  lastAccessed: number;
  createdAt: number;
  /** Attachments staged by the current prompt request. */
  pendingAttachments: PromptAttachmentInput[];
}

export interface PromptAttachmentInput {
  type: "image";
  path: string;
  dataUrl?: string;
  filename?: string;
}

export interface ThreadContext {
  threadId: string;
  /** Engine-side address; changes when a generation restart re-resumes. */
  engineHandle: string;
  /** Generation this context is currently bound to. */
  engineGeneration: EngineGeneration;
  bridgeSessionIds: Set<string>;
  /** The one canonical transcript for this Codex thread. */
  messages: NormalizedMessage[];
  activeTurn: TurnAccumulator | null;
  phase: SessionPhase;
  error?: string;
  /** Set while a dispatch is mid-flight, so a second tab cannot interleave. */
  dispatchInFlight: boolean;
  name?: string | null;
  cwd?: string;
  /** True once `thread/unsubscribe` has been sent. */
  unsubscribed: boolean;
  /**
   * True once at least one user message has been persisted to the rollout.
   *
   * Load-bearing for detaching: a materialized thread survives
   * `thread/unsubscribe` → `thread/resume` with full history, but an
   * unmaterialized one has no rollout, so resume fails with "no rollout found"
   * and the thread is unrecoverable. Verified against codex 0.145.0.
   */
  materialized: boolean;
}

/**
 * Serializes dispatch per thread.
 *
 * The window that matters spans "decide whether this request id is new" through
 * "journal that we sent turn/start". Two concurrent prompts must not both
 * observe an idle thread and both dispatch.
 */
class ThreadLock {
  private readonly chains = new Map<string, Promise<unknown>>();

  async run<T>(threadKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(threadKey) ?? Promise.resolve();
    const attempt = previous.then(task, task);
    // Swallow rejection for the *chain* only; `attempt` still rejects to caller.
    this.chains.set(
      threadKey,
      attempt.catch(() => undefined),
    );
    try {
      return await attempt;
    } finally {
      if (this.chains.get(threadKey) === attempt) this.chains.delete(threadKey);
    }
  }

  isBusy(threadKey: string): boolean {
    return this.chains.has(threadKey);
  }
}

export class OverlappingTurnError extends Error {
  constructor(readonly threadId: string) {
    super(`A turn is already running on thread ${threadId}`);
    this.name = "OverlappingTurnError";
  }
}

export interface ThreadRegistryOptions {
  now?: () => number;
  /** Called when the last bridge session releases a thread. */
  onThreadReleased?: (context: ThreadContext) => void;
}

export class ThreadRegistry {
  private readonly sessions = new Map<string, BridgeSession>();
  private readonly threads = new Map<string, ThreadContext>();
  /** Pre-thread sessions key their lock by session id instead. */
  private readonly lock = new ThreadLock();
  private readonly now: () => number;

  constructor(private readonly options: ThreadRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  createSession(session: Omit<BridgeSession, "lastAccessed" | "createdAt" | "pendingAttachments">): BridgeSession {
    const record: BridgeSession = {
      ...session,
      pendingAttachments: [],
      lastAccessed: this.now(),
      createdAt: this.now(),
    };
    this.sessions.set(record.id, record);
    if (record.threadId) this.attach(record.id, record.threadId, { engineHandle: record.threadId });
    return record;
  }

  getSession(sessionId: string): BridgeSession | undefined {
    return this.sessions.get(sessionId);
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastAccessed = this.now();
  }

  listSessions(): BridgeSession[] {
    return [...this.sessions.values()];
  }

  getThread(threadId: string): ThreadContext | undefined {
    return this.threads.get(threadId);
  }

  listThreads(): ThreadContext[] {
    return [...this.threads.values()];
  }

  /** The thread a session is bound to, if it has one yet. */
  getThreadForSession(sessionId: string): ThreadContext | undefined {
    const threadId = this.sessions.get(sessionId)?.threadId;
    return threadId ? this.threads.get(threadId) : undefined;
  }

  /**
   * Binds a session to a thread, creating the canonical context on first use and
   * joining the existing one otherwise. Joining is what makes two tabs on one
   * thread share a transcript instead of forking it.
   */
  attach(
    sessionId: string,
    threadId: string,
    options: { engineHandle: string; engineGeneration?: EngineGeneration; cwd?: string; name?: string | null },
  ): ThreadContext {
    const session = this.sessions.get(sessionId);
    if (session) session.threadId = threadId;

    let context = this.threads.get(threadId);
    if (!context) {
      context = {
        threadId,
        engineHandle: options.engineHandle,
        engineGeneration: options.engineGeneration ?? 0,
        bridgeSessionIds: new Set(),
        messages: [],
        activeTurn: null,
        phase: "idle",
        dispatchInFlight: false,
        unsubscribed: false,
        materialized: false,
        cwd: options.cwd,
        name: options.name ?? null,
      };
      this.threads.set(threadId, context);
    } else {
      // Re-attaching after a restart refreshes the engine address.
      context.engineHandle = options.engineHandle;
      if (options.engineGeneration !== undefined) {
        context.engineGeneration = options.engineGeneration;
      }
      context.unsubscribed = false;
    }

    context.bridgeSessionIds.add(sessionId);
    return context;
  }

  /**
   * Releases a bridge session. The thread is only surrendered when the last
   * reference goes: closing one tab must not unsubscribe a thread another tab is
   * still watching, and must never hard-delete the rollout.
   */
  releaseSession(sessionId: string): { removedThread: ThreadContext | null } {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (!session?.threadId) return { removedThread: null };

    const context = this.threads.get(session.threadId);
    if (!context) return { removedThread: null };

    context.bridgeSessionIds.delete(sessionId);
    if (context.bridgeSessionIds.size > 0) return { removedThread: null };

    // Last reference. Keep the context out of the map but hand it back so the
    // caller can `thread/unsubscribe` — deliberately not `thread/delete`, which
    // would destroy the user's conversation and its descendants.
    this.threads.delete(context.threadId);
    this.options.onThreadReleased?.(context);
    return { removedThread: context };
  }

  /**
   * Idle threads eligible to be detached: nothing running, and untouched for
   * `idleMs`. A thread with an active turn is never detached, however idle its
   * sessions look — the turn is still executing.
   */
  detachableThreads(idleMs: number): ThreadContext[] {
    const cutoff = this.now() - idleMs;
    return this.listThreads().filter((context) => {
      if (context.activeTurn || context.dispatchInFlight) return false;
      if (context.phase !== "idle" && context.phase !== "failed") return false;
      const sessions = this.sessionsForThread(context.threadId);
      if (sessions.length === 0) return true;
      return sessions.every((session) => session.lastAccessed <= cutoff);
    });
  }

  /**
   * Drops a thread's in-memory state while leaving its bridge sessions bound.
   *
   * Unlike `releaseSession` this is not a close: the sessions still exist and
   * still point at the thread, so the next request re-attaches transparently.
   * Safe because the Codex rollout — not this map — is the authoritative
   * transcript.
   */
  detachThread(threadId: string): ThreadContext | undefined {
    const context = this.threads.get(threadId);
    if (!context) return undefined;
    this.threads.delete(threadId);
    context.messages = [];
    return context;
  }

  /**
   * Forgets a thread id that can no longer be resumed.
   *
   * An unmaterialized thread has no rollout, so `thread/resume` would fail. The
   * next prompt must call `thread/start` instead, which only happens if the
   * stale id is cleared.
   */
  clearThreadBinding(threadId: string): void {
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId) session.threadId = null;
    }
  }

  /** Bridge sessions untouched for `idleMs` and not bound to a live thread. */
  expiredSessions(idleMs: number): BridgeSession[] {
    const cutoff = this.now() - idleMs;
    return [...this.sessions.values()].filter((session) => {
      if (session.lastAccessed > cutoff) return false;
      return session.threadId === null || !this.threads.has(session.threadId);
    });
  }

  referenceCount(threadId: string): number {
    return this.threads.get(threadId)?.bridgeSessionIds.size ?? 0;
  }

  /**
   * Runs `task` holding the thread's dispatch lock.
   *
   * Sessions without a thread yet lock on their own id: two prompts racing to
   * create the first thread for one session must still serialize, or they would
   * both call `thread/start`.
   */
  withDispatchLock<T>(session: BridgeSession, task: () => Promise<T>): Promise<T> {
    return this.lock.run(session.threadId ?? `session:${session.id}`, task);
  }

  /**
   * Guards against overlapping turns on one thread, including when the second
   * prompt arrives through a *different* bridge session.
   */
  assertNoActiveTurn(context: ThreadContext | undefined): void {
    if (!context) return;
    const busy =
      context.activeTurn !== null
      || context.dispatchInFlight
      || context.phase === "running"
      || context.phase === "starting"
      // Between the interrupt response and the terminal event the turn may still
      // be executing, so accepting a new one here could overlap them.
      || context.phase === "cancelling"
      || context.phase === "recovering";
    if (busy) throw new OverlappingTurnError(context.threadId);
  }

  setPhase(context: ThreadContext, phase: SessionPhase, error?: string): void {
    context.phase = phase;
    context.error = phase === "failed" ? error : undefined;
  }

  /** Every session that should be told about a thread-scoped change. */
  sessionsForThread(threadId: string): BridgeSession[] {
    const context = this.threads.get(threadId);
    if (!context) return [];
    return [...context.bridgeSessionIds]
      .map((id) => this.sessions.get(id))
      .filter((session): session is BridgeSession => session !== undefined);
  }

  /**
   * Marks every loaded thread as recovering after a generation change. They are
   * explicitly *not* failed: a crash must not look like a finished turn, or the
   * build pipeline would advance on it.
   */
  markAllRecovering(): ThreadContext[] {
    const affected: ThreadContext[] = [];
    for (const context of this.threads.values()) {
      if (context.phase === "running" || context.phase === "starting" || context.activeTurn) {
        this.setPhase(context, "recovering");
        affected.push(context);
      }
    }
    return affected;
  }

  removeThread(threadId: string): void {
    this.threads.delete(threadId);
  }
}
