import type { BackendEmit, CommandContext } from "./commands-context.js";
import type { PtyProcess } from "./pty.js";
import { containerIdMatches } from "./commands-review.js";
import {
  compactTerminalOutputBuffer,
  createTerminalOutputBuffer,
  isHighSurrogate,
  isLowSurrogate,
  isSetupTerminalSessionId,
  MAX_TERMINAL_OUTPUT_BUFFER_CHUNKS,
  MAX_TERMINAL_OUTPUT_DELTA_BYTES,
  MAX_TERMINAL_OUTPUT_DELTAS,
  setupTerminalSessionId,
  terminalOutputPayload,
  trimOrphanedLowSurrogate,
} from "./commands-terminal.js";
import { TerminalHistory, type TerminalHistoryOptions } from "./terminal-history.js";

export type TerminalSessionConfig = (
  | {
      kind: "container";
      containerId: string;
      cols: number;
      rows: number;
      user?: string;
      environmentId?: string;
      activityEnvironmentId?: string;
      trackEnvironmentActivity?: boolean;
    }
  | {
      kind: "local";
      environmentId: string;
      cols: number;
      rows: number;
      trackEnvironmentActivity?: boolean;
    }
) & { bootstrapped?: boolean; bootstrapDataHash?: string };

export type TerminalOutputBuffer = {
  chunks: string[];
  headIndex: number;
  headOffset: number;
  length: number;
};

export type TerminalOutputDelta = { revision: number; text: string };

type TerminalActivityCompletionState = {
  id: string;
  generation: number;
  cancelled: boolean;
  retryTimers: Set<ReturnType<typeof setTimeout>>;
};

export const MAX_TERMINAL_OUTPUT_BUFFER_CHARS = 500 * 1024;
/** Keep exited PTY snapshots long enough for a lagging SSE client to recover. */
export const TERMINAL_OUTPUT_RETENTION_MS = 5 * 60_000;
/** Bound worst-case retained output to 32 × 500 KB. */
export const MAX_RETAINED_TERMINAL_OUTPUT_BUFFERS = 32;
export const TERMINAL_ACTIVITY_SETTLE_MS = 750;
export const TERMINAL_ACTIVITY_PERSIST_RETRY_DELAYS_MS = [100, 250, 500] as const;
export const TERMINAL_COMPLETION_NOTIFY_RETRY_DELAYS_MS = [100, 250, 500] as const;

export type TerminalRuntimeOptions = {
  /** How long an exited one-shot session's output stays readable. Tests shorten it. */
  outputRetentionMs?: number;
  /** Durable terminal history; tests pass hooks and a smaller directory bound. */
  history?: TerminalHistoryOptions;
};

/**
 * The PTYs, replay buffers, stable tab identities, activity tracking, durable
 * history and launched account homes of one backend instance. Owned by
 * `BackendRuntime` and reached through `context.runtime.terminals` at call time.
 */
export class TerminalRuntime {
  /** Durable terminal history and restorable state (`terminal-history.ts`). */
  readonly history: TerminalHistory;
  private readonly processes = new Map<string, PtyProcess>();
  private readonly sessionConfigs = new Map<string, TerminalSessionConfig>();
  private readonly outputBuffers = new Map<string, TerminalOutputBuffer>();
  private readonly outputRevisions = new Map<string, number>();
  private readonly outputGenerations = new Map<string, number>();
  private readonly outputDeltas = new Map<string, TerminalOutputDelta[]>();
  private readonly outputDeltaBytes = new Map<string, number>();
  private readonly outputTruncated = new Set<string>();
  private readonly outputRetentionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sessionIdsByStableKey = new Map<string, string>();
  private readonly stableKeysBySessionId = new Map<string, string>();
  private readonly orphanedMissingSince = new Map<string, number>();
  private readonly activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activityArmed = new Set<string>();
  private readonly activityGenerations = new Map<string, number>();
  private readonly activityCompletions = new Map<string, number>();
  private readonly activityCompletionStates = new Map<number, TerminalActivityCompletionState>();
  private lastActivityGeneration = 0;
  /**
   * Agent account homes running terminals were launched with, keyed by
   * `<sessionId>:<home>` for PTYs and `tmux:<environmentId>:<tabId>` for tmux
   * agent sessions. An account cannot be removed while one of these uses it.
   */
  private readonly accountHomes = new Map<string, string>();
  private readonly outputRetentionMs: number;

  constructor(options: TerminalRuntimeOptions = {}) {
    this.outputRetentionMs = options.outputRetentionMs ?? TERMINAL_OUTPUT_RETENTION_MS;
    this.history = new TerminalHistory(options.history);
  }

  // Processes

  process(id: string): PtyProcess | undefined {
    return this.processes.get(id);
  }

  hasProcess(id: string): boolean {
    return this.processes.has(id);
  }

  processIds(): string[] {
    return Array.from(this.processes.keys());
  }

  processCount(): number {
    return this.processes.size;
  }

  /** Live terminals whose shell runs in a container (`docker exec`), not on the host. */
  containerProcessCount(): number {
    let count = 0;
    for (const id of this.processes.keys()) {
      if (this.sessionConfigs.get(id)?.kind === "container") count += 1;
    }
    return count;
  }

  /** Live local terminal shells and the environment each was opened for. */
  localProcessRoots(): Array<{ environmentId: string; pid: number }> {
    const roots: Array<{ environmentId: string; pid: number }> = [];
    for (const [id, process] of this.processes) {
      const config = this.sessionConfigs.get(id);
      if (config?.kind === "local" && process.pid > 1) {
        roots.push({ environmentId: config.environmentId, pid: process.pid });
      }
    }
    return roots;
  }

  registerProcess(id: string, process: PtyProcess): void {
    this.processes.set(id, process);
  }

  // Output buffers

  readOutput(sessionId: string): string {
    const buffer = this.outputBuffers.get(sessionId);
    return buffer ? compactTerminalOutputBuffer(buffer) : "";
  }

  outputLength(sessionId: string): number {
    return this.outputBuffers.get(sessionId)?.length ?? 0;
  }

  outputRevision(sessionId: string): number | undefined {
    return this.outputRevisions.get(sessionId);
  }

  outputGeneration(sessionId: string): number | undefined {
    return this.outputGenerations.get(sessionId);
  }

  retainedOutputDeltas(sessionId: string): readonly TerminalOutputDelta[] {
    return this.outputDeltas.get(sessionId) ?? [];
  }

  isOutputTruncated(sessionId: string): boolean {
    return this.outputTruncated.has(sessionId);
  }

  /** Characters, live chunk slots and revision; for tests and diagnostics. */
  outputBufferStats(sessionId: string): { chars: number; chunks: number; sequence: number } {
    const buffer = this.outputBuffers.get(sessionId);
    return {
      chars: buffer?.length ?? 0,
      chunks: buffer ? buffer.chunks.length - buffer.headIndex : 0,
      sequence: this.outputRevisions.get(sessionId) ?? 0,
    };
  }

  retainedOutputCount(): number {
    return this.outputRetentionTimers.size;
  }

  deleteRetainedOutput(sessionId: string): void {
    const timer = this.outputRetentionTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.outputRetentionTimers.delete(sessionId);
    this.outputBuffers.delete(sessionId);
    this.outputRevisions.delete(sessionId);
    this.outputGenerations.delete(sessionId);
    this.outputDeltas.delete(sessionId);
    this.outputDeltaBytes.delete(sessionId);
    this.outputTruncated.delete(sessionId);
  }

  private retainOutput(sessionId: string): void {
    const previous = this.outputRetentionTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => this.deleteRetainedOutput(sessionId), this.outputRetentionMs);
    timer.unref?.();
    this.outputRetentionTimers.delete(sessionId);
    this.outputRetentionTimers.set(sessionId, timer);
    while (this.outputRetentionTimers.size > MAX_RETAINED_TERMINAL_OUTPUT_BUFFERS) {
      const oldest = this.outputRetentionTimers.keys().next().value;
      if (oldest === undefined) break;
      this.deleteRetainedOutput(oldest);
    }
  }

  private ensureOutputGeneration(sessionId: string): number {
    const existing = this.outputGenerations.get(sessionId);
    if (existing !== undefined) return existing;
    this.outputGenerations.set(sessionId, 1);
    return 1;
  }

  appendOutput(sessionId: string, data: string | Buffer): number {
    this.ensureOutputGeneration(sessionId);
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    if (!text) return this.outputRevisions.get(sessionId) ?? 0;
    let buffer = this.outputBuffers.get(sessionId);
    if (!buffer) {
      buffer = createTerminalOutputBuffer();
      this.outputBuffers.set(sessionId, buffer);
    }

    // Tiny PTY callbacks can otherwise retain hundreds of thousands of string
    // and array slots even though their text is capped. Compact at a fixed slot
    // count; the amortized work is bounded and trimming never shifts the array.
    if (buffer.chunks.length - buffer.headIndex >= MAX_TERMINAL_OUTPUT_BUFFER_CHUNKS) {
      compactTerminalOutputBuffer(buffer);
    }
    buffer.chunks.push(text);
    buffer.length += text.length;

    let excess = buffer.length - MAX_TERMINAL_OUTPUT_BUFFER_CHARS;
    if (excess > 0) this.outputTruncated.add(sessionId);
    while (excess > 0) {
      const head = buffer.chunks[buffer.headIndex];
      if (head === undefined) break;
      const available = head.length - buffer.headOffset;
      if (available > excess) {
        let trim = excess;
        const boundary = buffer.headOffset + trim;
        if (
          isLowSurrogate(head.charCodeAt(boundary)) &&
          isHighSurrogate(head.charCodeAt(boundary - 1))
        ) {
          trim += 1;
        }
        buffer.headOffset += trim;
        buffer.length -= trim;
        break;
      }
      buffer.headIndex += 1;
      buffer.headOffset = 0;
      buffer.length -= available;
      excess -= available;
    }
    trimOrphanedLowSurrogate(buffer);
    if (buffer.headIndex >= MAX_TERMINAL_OUTPUT_BUFFER_CHUNKS) {
      compactTerminalOutputBuffer(buffer);
    }
    const revision = (this.outputRevisions.get(sessionId) ?? 0) + 1;
    this.outputRevisions.set(sessionId, revision);
    let deltas = this.outputDeltas.get(sessionId);
    if (!deltas) {
      deltas = [];
      this.outputDeltas.set(sessionId, deltas);
    }
    deltas.push({ revision, text });
    let deltaBytes = (this.outputDeltaBytes.get(sessionId) ?? 0) + Buffer.byteLength(text, "utf8");
    while (
      deltas.length > MAX_TERMINAL_OUTPUT_DELTAS ||
      deltaBytes > MAX_TERMINAL_OUTPUT_DELTA_BYTES
    ) {
      const removed = deltas.shift();
      if (!removed) break;
      deltaBytes -= Buffer.byteLength(removed.text, "utf8");
    }
    this.outputDeltaBytes.set(sessionId, deltaBytes);
    return revision;
  }

  emitOutput(sessionId: string, data: string | Buffer, emit: BackendEmit): void {
    const revision = this.appendOutput(sessionId, data);
    const generation = this.outputGenerations.get(sessionId) ?? 1;
    this.history.append(
      sessionId,
      Buffer.isBuffer(data) ? data.toString("utf8") : data,
      revision,
      generation,
    );
    emit(`terminal-output-${sessionId}`, terminalOutputPayload(data, revision, generation));
  }

  resetOutput(sessionId: string): void {
    const retentionTimer = this.outputRetentionTimers.get(sessionId);
    if (retentionTimer) clearTimeout(retentionTimer);
    this.outputRetentionTimers.delete(sessionId);
    this.outputBuffers.set(sessionId, createTerminalOutputBuffer());
    this.outputRevisions.set(sessionId, 0);
    this.outputDeltas.set(sessionId, []);
    this.outputDeltaBytes.set(sessionId, 0);
    this.outputTruncated.delete(sessionId);
    this.outputGenerations.set(sessionId, (this.outputGenerations.get(sessionId) ?? 0) + 1);
  }

  // Sessions and stable tab identities

  sessionConfig(id: string): TerminalSessionConfig | undefined {
    return this.sessionConfigs.get(id);
  }

  rememberSession(id: string, config: TerminalSessionConfig): string {
    this.sessionConfigs.set(id, {
      ...config,
      bootstrapped: false,
      bootstrapDataHash: undefined,
    });
    this.ensureOutputGeneration(id);
    return id;
  }

  isBootstrapped(id: string): boolean {
    return this.sessionConfigs.get(id)?.bootstrapped === true;
  }

  rememberStableSession(
    id: string,
    config: TerminalSessionConfig,
    stableKey: string | null,
  ): string {
    this.rememberSession(id, config);
    if (stableKey) {
      this.sessionIdsByStableKey.set(stableKey, id);
      this.stableKeysBySessionId.set(id, stableKey);
    }
    return id;
  }

  existingStableSession(stableKey: string | null): string | null {
    if (!stableKey) return null;
    const id = this.sessionIdsByStableKey.get(stableKey);
    if (!id) return null;
    if (this.sessionConfigs.has(id) || this.processes.has(id)) return id;
    this.sessionIdsByStableKey.delete(stableKey);
    this.stableKeysBySessionId.delete(id);
    return null;
  }

  /** The session currently registered under a stable tab key, without pruning. */
  sessionIdForStableKey(stableKey: string): string | undefined {
    return this.sessionIdsByStableKey.get(stableKey);
  }

  stableKeyForSession(id: string): string | undefined {
    return this.stableKeysBySessionId.get(id);
  }

  stableKeyEnvironmentId(id: string): string | null {
    const stableKey = this.stableKeysBySessionId.get(id);
    return stableKey?.split("\0")[1] ?? null;
  }

  containerConfigMatches(
    id: string,
    expected: Extract<TerminalSessionConfig, { kind: "container" }>,
  ): boolean {
    const config = this.sessionConfigs.get(id);
    return (
      config?.kind === "container" &&
      containerIdMatches(config.containerId, expected.containerId) &&
      config.user === expected.user &&
      config.environmentId === expected.environmentId &&
      config.activityEnvironmentId === expected.activityEnvironmentId &&
      config.trackEnvironmentActivity === expected.trackEnvironmentActivity
    );
  }

  localConfigMatches(
    id: string,
    expected: Extract<TerminalSessionConfig, { kind: "local" }>,
  ): boolean {
    const config = this.sessionConfigs.get(id);
    return (
      config?.kind === "local" &&
      config.environmentId === expected.environmentId &&
      config.trackEnvironmentActivity === expected.trackEnvironmentActivity
    );
  }

  /**
   * Closes stable tab sessions whose tab no pane layout has referenced for
   * `graceMs`. Returns how many were closed.
   */
  reapOrphanedSessions(
    isReferenced: (environmentId: string, tabId: string) => boolean,
    now: number,
    graceMs: number,
  ): number {
    let reaped = 0;
    for (const [sessionId, stableKey] of Array.from(this.stableKeysBySessionId)) {
      const [, environmentId, tabId] = stableKey.split("\0");
      if (!environmentId || !tabId) continue;
      if (isReferenced(environmentId, tabId)) {
        this.orphanedMissingSince.delete(sessionId);
        continue;
      }
      const missingSince = this.orphanedMissingSince.get(sessionId);
      if (missingSince === undefined) {
        this.orphanedMissingSince.set(sessionId, now);
        continue;
      }
      if (now - missingSince < graceMs) continue;
      console.warn(`[backend] Reaping orphaned terminal ${environmentId}/${tabId}`);
      this.explicitlyCloseSession(sessionId);
      this.orphanedMissingSince.delete(sessionId);
      reaped += 1;
    }
    return reaped;
  }

  cleanupSession(id: string, options: { explicit?: boolean } = {}): void {
    this.orphanedMissingSince.delete(id);
    const activityTimer = this.activityTimers.get(id);
    if (activityTimer) clearTimeout(activityTimer);
    this.activityTimers.delete(id);
    this.activityArmed.delete(id);
    this.activityGenerations.delete(id);
    this.activityCompletions.delete(id);
    if (options.explicit) this.cancelTrackedCompletions(id);
    this.processes.delete(id);
    for (const key of Array.from(this.accountHomes.keys())) {
      if (key.startsWith(`${id}:`)) this.accountHomes.delete(key);
    }
    const stableKey = this.stableKeysBySessionId.get(id);
    const retainStableState =
      !options.explicit && stableKey !== undefined && this.sessionConfigs.has(id);
    // Bootstrap ownership belongs to one concrete PTY lifetime. Stable tabs keep
    // their identity and replay buffer across a natural shell exit, but the
    // replacement PTY must be allowed to receive its launch command once.
    const retainedConfig = this.sessionConfigs.get(id);
    if (retainedConfig) {
      retainedConfig.bootstrapped = false;
      retainedConfig.bootstrapDataHash = undefined;
    }
    if (retainStableState) return;

    this.sessionConfigs.delete(id);
    if (stableKey) {
      this.stableKeysBySessionId.delete(id);
      if (this.sessionIdsByStableKey.get(stableKey) === id) {
        this.sessionIdsByStableKey.delete(stableKey);
      }
    }
    // Setup-session buffers are retained until their environment is removed.
    // Stable tab sessions returned above retain their bounded transcript until
    // explicit tab or environment cleanup. A one-shot session gets a bounded,
    // short-lived recovery window because a lagging renderer may be told to
    // refetch after the PTY itself has already exited.
    if (!isSetupTerminalSessionId(id)) {
      if (!options.explicit && this.outputBuffers.has(id)) {
        this.retainOutput(id);
      } else {
        this.deleteRetainedOutput(id);
      }
    }
  }

  explicitlyCloseSession(id: string): void {
    this.processes.get(id)?.kill();
    this.cleanupSession(id, { explicit: true });
    this.history.dispose(id);
  }

  private sessionIdsForEnvironment(environmentId: string): Set<string> {
    const sessionIds = new Set<string>([setupTerminalSessionId(environmentId)]);
    for (const [id, config] of this.sessionConfigs) {
      if (
        (config.kind === "local" && config.environmentId === environmentId) ||
        (config.kind === "container" &&
          (config.environmentId === environmentId ||
            config.activityEnvironmentId === environmentId)) ||
        this.stableKeyEnvironmentId(id) === environmentId
      ) {
        sessionIds.add(id);
      }
    }
    return sessionIds;
  }

  cleanupSessionsForEnvironment(environmentId: string): void {
    for (const id of this.sessionIdsForEnvironment(environmentId)) {
      this.explicitlyCloseSession(id);
    }
  }

  /**
   * Closes every terminal of an environment and waits for each process tree,
   * including the setup session's build descendants, to exit. Deletion calls this
   * before removing the worktree so nothing can write into it afterwards.
   * Resolves with the sessions whose tree was still alive after SIGKILL.
   */
  async terminateSessionsForEnvironment(environmentId: string): Promise<string[]> {
    const sessionIds = [...this.sessionIdsForEnvironment(environmentId)];
    const survivors: string[] = [];
    await Promise.all(
      sessionIds.map(async (id) => {
        const process = this.processes.get(id);
        if (!process) return;
        const exited = await Promise.resolve()
          .then(() => process.terminate())
          .catch(() => false);
        if (!exited) survivors.push(id);
      }),
    );
    // Keep surviving processes registered so the next deletion attempt can
    // terminate and verify them before the worktree is removed.
    for (const id of sessionIds) {
      if (!survivors.includes(id)) this.explicitlyCloseSession(id);
    }
    return survivors;
  }

  // Launched account homes

  /**
   * Records that a running terminal uses an agent account home. `key` is
   * `<sessionId>:<home>` for a PTY, pruned when the session is cleaned up, or
   * `tmux:<environmentId>:<tabId>` for a tmux agent session, forgotten when it
   * stops.
   */
  recordAccountHome(key: string, home: string): void {
    this.accountHomes.set(key, home);
  }

  forgetAccountHome(key: string): void {
    this.accountHomes.delete(key);
  }

  /** Whether any running terminal was launched with this account home. */
  isAccountHomeInUse(home: string): boolean {
    for (const used of this.accountHomes.values()) if (used === home) return true;
    return false;
  }

  /** The home recorded under `key`; for tests and diagnostics. */
  accountHome(key: string): string | undefined {
    return this.accountHomes.get(key);
  }

  // Environment activity tracking

  private trackedEnvironmentId(id: string): string | null {
    const config = this.sessionConfigs.get(id);
    if (!config?.trackEnvironmentActivity) return null;
    return config.kind === "local" ? config.environmentId : (config.activityEnvironmentId ?? null);
  }

  private finishTrackedCompletion(id: string, generation: number): void {
    if (this.activityGenerations.get(id) === generation) {
      this.activityArmed.delete(id);
    }
    if (this.activityCompletions.get(id) === generation) {
      this.activityCompletions.delete(id);
    }
    const state = this.activityCompletionStates.get(generation);
    if (state?.id === id) {
      for (const timer of state.retryTimers) clearTimeout(timer);
      this.activityCompletionStates.delete(generation);
    }
  }

  private isTrackedCompletionActive(id: string, generation: number): boolean {
    const state = this.activityCompletionStates.get(generation);
    return state?.id === id && !state.cancelled;
  }

  private scheduleTrackedCompletionRetry(
    id: string,
    generation: number,
    callback: () => void,
    delay: number,
  ): void {
    const state = this.activityCompletionStates.get(generation);
    if (!state || state.id !== id || state.cancelled) return;
    const timer = setTimeout(() => {
      state.retryTimers.delete(timer);
      if (!state.cancelled) callback();
    }, delay);
    timer.unref?.();
    state.retryTimers.add(timer);
  }

  private cancelTrackedCompletions(id: string): void {
    for (const [generation, state] of Array.from(this.activityCompletionStates)) {
      if (state.id !== id) continue;
      state.cancelled = true;
      for (const timer of state.retryTimers) clearTimeout(timer);
      this.activityCompletionStates.delete(generation);
    }
  }

  private notifyTrackedCompletion(
    id: string,
    environmentId: string,
    generation: number,
    context: CommandContext,
    attempt = 0,
  ): void {
    if (!this.isTrackedCompletionActive(id, generation)) return;
    const notify = context.notifyAgentTurnCompleted;
    if (!notify) {
      this.finishTrackedCompletion(id, generation);
      return;
    }
    void notify(environmentId).then(
      () => this.finishTrackedCompletion(id, generation),
      (error) => {
        const delay = TERMINAL_COMPLETION_NOTIFY_RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) {
          this.scheduleTrackedCompletionRetry(
            id,
            generation,
            () => this.notifyTrackedCompletion(id, environmentId, generation, context, attempt + 1),
            delay,
          );
          return;
        }
        this.finishTrackedCompletion(id, generation);
        console.error("Failed to notify terminal agent completion", {
          environmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  private persistTrackedCompletion(
    id: string,
    environmentId: string,
    occurredAt: string,
    generation: number,
    context: CommandContext,
    attempt = 0,
  ): void {
    if (!this.isTrackedCompletionActive(id, generation)) return;
    void context.storage
      .recordEnvironmentCompletion(environmentId, occurredAt)
      .then((environment) => {
        if (!this.isTrackedCompletionActive(id, generation)) return;
        context.emit("environment-activity-recorded", {
          environment_id: environment.id,
          occurred_at: environment.lastActivityAt ?? occurredAt,
          activity_kind: "completed",
        });
        this.notifyTrackedCompletion(id, environmentId, generation, context);
      })
      .catch((error) => {
        const delay = TERMINAL_ACTIVITY_PERSIST_RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) {
          this.scheduleTrackedCompletionRetry(
            id,
            generation,
            () =>
              this.persistTrackedCompletion(
                id,
                environmentId,
                occurredAt,
                generation,
                context,
                attempt + 1,
              ),
            delay,
          );
          return;
        }
        this.finishTrackedCompletion(id, generation);
        console.error("Failed to record terminal environment activity", {
          environmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private persistActivity(
    id: string,
    context: CommandContext,
    activityKind: "prompt" | "completed",
  ): void {
    const timer = this.activityTimers.get(id);
    if (timer) clearTimeout(timer);
    this.activityTimers.delete(id);

    if (!this.activityArmed.has(id)) return;
    const environmentId = this.trackedEnvironmentId(id);
    if (!environmentId) return;
    if (activityKind === "completed") {
      const generation = this.activityGenerations.get(id) ?? 0;
      if (this.activityCompletions.get(id) === generation) return;
      this.activityCompletions.set(id, generation);
      this.activityCompletionStates.set(generation, {
        id,
        generation,
        cancelled: false,
        retryTimers: new Set(),
      });
      this.persistTrackedCompletion(
        id,
        environmentId,
        new Date().toISOString(),
        generation,
        context,
      );
      return;
    }

    const occurredAt = new Date().toISOString();
    void context.storage
      .recordEnvironmentActivity(environmentId, occurredAt)
      .then((environment) => {
        context.emit("environment-activity-recorded", {
          environment_id: environment.id,
          occurred_at: environment.lastActivityAt ?? occurredAt,
          activity_kind: "prompt",
        });
      })
      .catch((error) => {
        console.error("Failed to record terminal environment activity", {
          environmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  recordInputActivity(id: string, data: string, context: CommandContext): void {
    if (!/[\r\n]/.test(data) || !this.trackedEnvironmentId(id)) return;
    this.lastActivityGeneration += 1;
    this.activityGenerations.set(id, this.lastActivityGeneration);
    this.activityArmed.add(id);
    this.persistActivity(id, context, "prompt");
  }

  private scheduleOutputActivity(id: string, context: CommandContext): void {
    if (!this.activityArmed.has(id) || !this.trackedEnvironmentId(id)) return;
    const existingTimer = this.activityTimers.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(
      () => this.persistActivity(id, context, "completed"),
      TERMINAL_ACTIVITY_SETTLE_MS,
    );
    timer.unref?.();
    this.activityTimers.set(id, timer);
  }

  activityHooks(id: string, context: CommandContext): { onData: () => void; onExit: () => void } {
    return {
      onData: () => this.scheduleOutputActivity(id, context),
      onExit: () => this.persistActivity(id, context, "completed"),
    };
  }

  /** Clears every timer this runtime owns; called once on backend shutdown. */
  shutdown(): void {
    for (const timer of this.outputRetentionTimers.values()) clearTimeout(timer);
    this.outputRetentionTimers.clear();
    for (const timer of this.activityTimers.values()) clearTimeout(timer);
    this.activityTimers.clear();
    for (const state of this.activityCompletionStates.values()) {
      state.cancelled = true;
      for (const timer of state.retryTimers) clearTimeout(timer);
    }
    this.activityCompletionStates.clear();
    this.history.shutdown();
  }
}
