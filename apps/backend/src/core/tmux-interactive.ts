import { terminalOutputEvents } from "@orkestrator/protocol/contract/domains/events";
import { CLAUDE_TMUX_INTERACTIVE_LEASE_MS } from "@orkestrator/protocol/contract/domains/claude-tmux";
import * as shared from "./tmux-shared.js";
import { TranscriptTaskTracker, bytesPayload, randomUUID } from "./tmux-shared.js";
import { AsyncMutex, TmuxSession, TmuxSessionManager } from "./tmux-session-manager.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";

const log = createLogger("tmux");
type CommandContext = shared.CommandContext;
type AgentToolConnection = shared.AgentToolConnection;
type Environment = shared.Environment;
type JsonRecord = shared.JsonRecord;
type TaskListSnapshot = shared.TaskListSnapshot;
type TmuxAgentObservation = shared.TmuxAgentObservation;
type CommandHandler = shared.CommandHandler;
type RegisterCommand = shared.RegisterCommand;
type ExecOutput = shared.ExecOutput;
type BackendKind = shared.BackendKind;
type RawExecOutput = shared.RawExecOutput;
type TmuxPollSnapshot = shared.TmuxPollSnapshot;
type SessionHookPaths = shared.SessionHookPaths;
export type InteractiveTmuxLayerTypes = [
  CommandContext,
  AgentToolConnection,
  Environment,
  JsonRecord,
  TaskListSnapshot,
  TmuxAgentObservation,
  TranscriptTaskTracker,
  CommandHandler,
  RegisterCommand,
  ExecOutput,
  BackendKind,
  RawExecOutput,
  TmuxPollSnapshot,
  SessionHookPaths,
  TmuxSession,
  TmuxSessionManager,
  AsyncMutex,
];
export const INTERACTIVE_SNAPSHOT_MIN_MS = 250;
/** Cadence a pane backs off to while nothing at all changes. */
export const INTERACTIVE_SNAPSHOT_MAX_MS = 1_000;

export interface TmuxPaneUpdate {
  text: string;
  full: boolean;
}

/**
 * Drops the terminator `tmux capture-pane -p` writes after the *last* row.
 *
 * A capture of an N-row pane contains exactly N newlines, so replaying it
 * verbatim issues a line feed while the cursor sits on the bottom row. That
 * scrolls the viewport by one, and every subsequent line-addressed patch then
 * names the row below the one it meant to replace. Normalising here keeps the
 * repaint and the patch agreed on which row holds which line.
 */
export function paneRows(capture: string): string[] {
  const rows = capture.split("\n");
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

/** Build a bounded ANSI line patch, falling back to an exact pane repaint. */
export function buildTmuxPaneUpdate(
  previous: string | undefined,
  next: string,
  force = false,
): TmuxPaneUpdate {
  const after = paneRows(next);
  const full = (): TmuxPaneUpdate => ({
    text: `\x1b[H\x1b[2J${after.join("\r\n")}`,
    full: true,
  });
  if (force || previous === undefined) return full();
  const before = paneRows(previous);
  if (before.length !== after.length) return full();

  const changed: number[] = [];
  for (let index = 0; index < after.length; index += 1) {
    if (before[index] !== after[index]) changed.push(index);
  }
  if (changed.length === 0) return { text: "", full: false };
  // Clear-heavy transitions and widespread redraws are both smaller and safer
  // as a full pane, especially around alternate-screen applications.
  if (changed.length * 2 >= after.length || after.every((line) => line.trim().length === 0)) {
    return full();
  }
  return {
    text: changed.map((index) => `\x1b[${index + 1};1H\x1b[2K${after[index] ?? ""}`).join(""),
    full: false,
  };
}

export type InteractiveTerminalSession = {
  id: string;
  tmux: TmuxSession;
  timer?: unknown;
  lastSnapshot?: string;
  /**
   * Invalidates captures that began before a forced restart or resize. A
   * capture may outlive the operation that superseded it, so attachment alone
   * is not enough to decide whether its result is still authoritative.
   */
  captureGeneration: number;
  /** Suppresses timer captures while tmux is changing the pane geometry. */
  captureSuspended: boolean;
  /** The first capture after a geometry change must repaint the whole pane. */
  forceNextSnapshot: boolean;
  /** Serializes resize-window commands so an older resize cannot finish last. */
  geometryTail: Promise<void>;
  cols: number;
  rows: number;
  /** Current gap between captures; doubles while the pane is static. */
  intervalMs: number;
  /** When the armed timer is due, so a reschedule can tell sooner from later. */
  nextCaptureAt?: number;
  /**
   * When the client's lease runs out (to-do 7745, retired). Unset for a terminal whose
   * client never announced a lease (an older renderer), which keeps today's
   * detach-on-unmount behaviour.
   */
  leaseExpiresAt?: number;
  context?: CommandContext;
};

export type InteractiveTmuxTerminalManagerOptions = {
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  /** Wall-clock milliseconds for lease expiry; tests step it. */
  now?: () => number;
  /** How long a lease lasts after a renewal; tests shorten it. */
  leaseMs?: number;
  metrics?: RecurringWorkMetrics;
};

export type CreateInteractiveTerminalOptions = {
  /** The client renews the terminal and wants it detached when it stops. */
  leased?: boolean;
};

export class InteractiveTmuxTerminalManager {
  private readonly terminals = new Map<string, InteractiveTerminalSession>();
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelTimeout: (timer: unknown) => void;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly metrics: RecurringWorkMetrics;

  constructor(options: InteractiveTmuxTerminalManagerOptions = {}) {
    this.scheduleTimeout =
      options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimeout = options.cancel ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? CLAUDE_TMUX_INTERACTIVE_LEASE_MS;
    this.metrics = options.metrics ?? recurringWorkMetrics;
  }

  create(
    tmux: TmuxSession,
    cols: number,
    rows: number,
    options: CreateInteractiveTerminalOptions = {},
  ): string {
    // A leased terminal that was created but never started has no timer to
    // notice its lapse, so creation sweeps those.
    this.detachLapsed();
    const id = `tmux:${tmux.environmentId}:${tmux.tabId}:${randomUUID()}`;
    this.terminals.set(id, {
      id,
      tmux,
      cols,
      rows,
      intervalMs: INTERACTIVE_SNAPSHOT_MIN_MS,
      captureGeneration: 0,
      captureSuspended: false,
      forceNextSnapshot: true,
      geometryTail: Promise.resolve(),
      ...(options.leased ? { leaseExpiresAt: this.now() + this.leaseMs } : {}),
    });
    return id;
  }

  /**
   * Extends the terminal's lease; `false` when the backend no longer holds
   * it (lapsed, detached, or its environment's tmux was cleaned up), so the
   * client creates a new one. Renewing a terminal created without a lease
   * arms one: only a client that renews ever calls this.
   */
  renew(id: string): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal) return false;
    if (this.lapsed(terminal)) {
      this.detachForLapse(terminal);
      return false;
    }
    terminal.leaseExpiresAt = this.now() + this.leaseMs;
    return true;
  }

  /** How many terminals this manager holds; diagnostics and tests. */
  size(): number {
    return this.terminals.size;
  }

  async start(id: string, context: CommandContext): Promise<void> {
    const terminal = this.require(id);
    const release = context.runtime.environments.fence.beginAgentWork(terminal.tmux.environmentId);
    try {
      terminal.context = context;
      await this.changeGeometry(terminal, terminal.cols, terminal.rows);
      await this.emitSnapshot(terminal, context, true);
      this.schedule(terminal);
    } finally {
      release();
    }
  }

  async write(id: string, data: string, context: CommandContext): Promise<void> {
    const terminal = this.require(id);
    const release = context.runtime.environments.fence.beginAgentWork(terminal.tmux.environmentId);
    try {
      // Input is about to produce output, so undo any backoff before it lands.
      terminal.intervalMs = INTERACTIVE_SNAPSHOT_MIN_MS;
      if (terminal.timer !== undefined) this.schedule(terminal);
      await terminal.tmux.writeInteractive(data);
    } finally {
      release();
    }
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const terminal = this.require(id);
    terminal.cols = cols;
    terminal.rows = rows;
    await this.changeGeometry(terminal, cols, rows);
  }

  detach(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    if (terminal.timer !== undefined) this.cancelTimeout(terminal.timer);
    terminal.timer = undefined;
    this.terminals.delete(id);
  }

  detachEnvironment(environmentId: string): void {
    for (const [id, terminal] of this.terminals) {
      if (terminal.tmux.environmentId !== environmentId) continue;
      if (terminal.timer !== undefined) this.cancelTimeout(terminal.timer);
      terminal.timer = undefined;
      this.terminals.delete(id);
    }
  }

  /** Stops every pane snapshot timer; the backend is shutting down. */
  detachAll(): void {
    for (const id of Array.from(this.terminals.keys())) this.detach(id);
  }

  private require(id: string): InteractiveTerminalSession {
    const terminal = this.terminals.get(id);
    if (!terminal || this.lapsed(terminal)) {
      if (terminal) this.detachForLapse(terminal);
      throw new Error("tmux interactive terminal session not found");
    }
    return terminal;
  }

  private lapsed(terminal: InteractiveTerminalSession): boolean {
    return terminal.leaseExpiresAt !== undefined && this.now() >= terminal.leaseExpiresAt;
  }

  private detachForLapse(terminal: InteractiveTerminalSession): void {
    // Content-free: the terminal id names only the environment and tab.
    log.info("interactive.lease-lapsed", () => ({
      environmentId: terminal.tmux.environmentId,
    }));
    this.detach(terminal.id);
  }

  private detachLapsed(): void {
    for (const terminal of Array.from(this.terminals.values())) {
      if (this.lapsed(terminal)) this.detachForLapse(terminal);
    }
  }

  private beginGeometryChange(terminal: InteractiveTerminalSession): number {
    terminal.captureGeneration += 1;
    terminal.captureSuspended = true;
    return terminal.captureGeneration;
  }

  private async changeGeometry(
    terminal: InteractiveTerminalSession,
    cols: number,
    rows: number,
  ): Promise<void> {
    const generation = this.beginGeometryChange(terminal);
    const operation = terminal.geometryTail.then(
      () => terminal.tmux.resize(cols, rows),
      () => terminal.tmux.resize(cols, rows),
    );
    terminal.geometryTail = operation.then(
      () => undefined,
      () => undefined,
    );
    try {
      await operation;
    } finally {
      this.finishGeometryChange(terminal, generation);
    }
  }

  private finishGeometryChange(terminal: InteractiveTerminalSession, generation: number): void {
    if (this.terminals.get(terminal.id) !== terminal || terminal.captureGeneration !== generation) {
      return;
    }
    terminal.captureSuspended = false;
    terminal.forceNextSnapshot = true;
  }

  /**
   * Self-rescheduling rather than a fixed interval, so a pane nobody is looking
   * at costs one `tmux capture-pane` per second instead of four — and so a
   * capture that runs long cannot stack up behind itself.
   *
   * Only ever pulls the next capture *forward*. `write` reschedules on every
   * keystroke, so an unconditional re-arm let anything faster than one
   * character per {@link INTERACTIVE_SNAPSHOT_MIN_MS} — ordinary typing, or key
   * auto-repeat — push the deadline out for as long as the user kept typing,
   * and the pane appeared frozen exactly while they were using it.
   */
  private schedule(terminal: InteractiveTerminalSession): void {
    if (this.terminals.get(terminal.id) !== terminal) return;
    const dueAt = Date.now() + terminal.intervalMs;
    if (terminal.timer !== undefined) {
      if (terminal.nextCaptureAt !== undefined && terminal.nextCaptureAt <= dueAt) return;
      this.cancelTimeout(terminal.timer);
    }
    terminal.nextCaptureAt = dueAt;
    terminal.timer = this.scheduleTimeout(() => {
      terminal.nextCaptureAt = undefined;
      const context = terminal.context;
      if (!context || this.terminals.get(terminal.id) !== terminal) return;
      // No client renewed the lease: whoever attached reloaded, closed the
      // window or lost the link without detaching (to-do 7745, retired).
      if (this.lapsed(terminal)) {
        this.detachForLapse(terminal);
        return;
      }
      // One timer capture is one B19 attempt; its `docker exec` or tmux spawn
      // is charged to it.
      void this.metrics
        .observe("tmux-interactive-capture", async (span) => {
          if (await this.emitSnapshot(terminal, context, false)) span.changed();
          else span.unchanged();
        })
        .catch((error) => {
          log.debug("interactive.snapshot-failed", () => ({
            error: formatLogError(error, { stack: false }),
          }));
        })
        .finally(() => {
          if (this.terminals.get(terminal.id) === terminal) this.schedule(terminal);
        });
    }, terminal.intervalMs);
  }

  /** Captures the pane; `true` when something changed (or a repaint was sent). */
  private async emitSnapshot(
    terminal: InteractiveTerminalSession,
    context: CommandContext,
    force: boolean,
  ): Promise<boolean> {
    if (terminal.captureSuspended) return false;
    const generation = terminal.captureGeneration;
    const snapshot = await terminal.tmux.capturePane({ ansi: true, joinWrapped: false });
    // Detach can happen while capture-pane is in flight. Never emit the late
    // snapshot or revive its timer after the terminal has been removed. A
    // resize or forced restart also makes an earlier capture stale even if it
    // finishes last.
    if (
      this.terminals.get(terminal.id) !== terminal ||
      terminal.captureGeneration !== generation ||
      terminal.captureSuspended
    ) {
      return false;
    }
    const repaint = force || terminal.forceNextSnapshot;
    if (!repaint && snapshot === terminal.lastSnapshot) {
      terminal.intervalMs = Math.min(INTERACTIVE_SNAPSHOT_MAX_MS, terminal.intervalMs * 2);
      return false;
    }
    // Any change snaps the cadence back: output usually arrives in bursts.
    terminal.intervalMs = INTERACTIVE_SNAPSHOT_MIN_MS;
    const update = buildTmuxPaneUpdate(terminal.lastSnapshot, snapshot, repaint);
    terminal.lastSnapshot = snapshot;
    terminal.forceNextSnapshot = false;
    if (update.text) {
      context.emit(terminalOutputEvents.at(terminal.id), bytesPayload(update.text, update.full));
    }
    return true;
  }
}
