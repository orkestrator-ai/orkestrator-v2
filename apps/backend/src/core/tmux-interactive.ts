import * as shared from "./tmux-shared.js";
import * as sessionManager from "./tmux-session-manager.js";
const {
  existsSync,
  fs,
  path,
  os,
  createHash,
  randomUUID,
  spawn,
  delay,
  ORKESTRATOR_AGENT_MCP_SERVER_NAME,
  runCommand,
  TranscriptTaskTracker,
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  parseTmuxAgentObservation,
  parseTmuxSelectionPrompt,
  tmuxSelectionPromptFingerprint,
  CLAUDE_TMUX_EVENT,
  POLL_INTERVAL_MS,
  TMUX_OBSERVATION_INTERVAL_MS,
  TMUX_BUSY_OBSERVATION_INTERVAL_MS,
  LIVENESS_CHECK_EVERY_TICKS,
  HOOK_TIMEOUT_SECS,
  COMMAND_IDLE_TIMEOUT_MS,
  COMMAND_NO_HOOK_SETTLE_MS,
  COMMAND_AFTER_IDLE_SETTLE_MS,
  PERMISSION_MODE_SWITCH_TIMEOUT_MS,
  PERMISSION_MODE_POLL_MS,
  FAST_MODE_SWITCH_TIMEOUT_MS,
  FAST_MODE_POLL_MS,
  FAST_MODE_TMUX_OPTION,
  BACKUP_SENTINEL_NO_ORIGINAL,
  CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN,
  RUNTIME_ROOT_PREFIX,
  claudeTmuxRuntimeRootPrefix,
  agentMcpConfigJson,
  agentToolConnectionTarget,
  runtimeRootPrefixForContext,
  isMissingTmuxSessionError,
  THINKING_MODE_ARGS,
  THINKING_DISPLAY_FLAG,
  THINKING_DISPLAY_VALUE,
  THINKING_DISPLAY_PROBE_VALUE,
  THINKING_DISPLAY_PROBE_TIMEOUT_MS,
  HOOK_EVENT_KINDS,
  containerExecArgs,
  asString,
  asOptionalString,
  asBoolean,
  asPositiveInt,
  asNonNegativeInt,
  asStringArray,
  shellArg,
  shellDq,
  readableIdPrefix,
  tmuxSessionName,
  tmuxSessionNamePrefix,
  parseTmuxSessionNames,
  selectReapableTmuxSessions,
  isBlockingHook,
  parseEventFilename,
  responseFilename,
  pathDirname,
  bytesPayload,
  countNewlines,
  execWithOutput,
  execWithRawOutput,
  POLL_SNAPSHOT_PENDING_MARKER,
  POLL_SNAPSHOT_TIMEOUT_MARKER,
  POLL_SNAPSHOT_SIZE_MARKER,
  pollSnapshotScript,
  parsePollSnapshotOutput,
  parsePollSnapshotExecOutput,
  tailFromOffsetCommand,
  TRANSCRIPT_HEAD_MARKER,
  transcriptHeadCommand,
  parseTranscriptHeadOutput,
  MAX_PREVIOUS_SESSIONS,
  PREVIOUS_SESSION_STAT_CONCURRENCY,
  jsonlByMtimeFindCommand,
  isDirectJsonlChild,
  listLocalJsonlByMtime,
  parseFreshJsonlFindOutput,
  INTERACTIVE_KEY_SEQUENCES,
  sendInteractiveData,
  TmuxSession,
  stripAnsi,
  paneOutputAfterCommand,
  fastModeFromPane,
  fastModeRejectionFromPane,
  paneHasSelectionPrompt,
  paneHasClaudeExited,
  AsyncMutex,
  TmuxSessionManager,
  tmuxManager,
  tmuxActivityWrites,
  orphanedTmuxMissingSince,
  lastTmuxOrphanSweepAt,
  persistTmuxEnvironmentActivity,
  workspaceAndClaudeHome,
  resolveBackend,
  resolveBundledClaudePath,
  resolvePinnedClaudeCommand,
  getOrCreateSession,
  killOrphanSession,
  killEnvironmentTmuxSessions,
  getLastTmuxOrphanSweepAt,
  setLastTmuxOrphanSweepAt,
} = Object.assign({}, shared, sessionManager);
void [existsSync, fs, path, os, createHash, randomUUID, spawn, delay, ORKESTRATOR_AGENT_MCP_SERVER_NAME, runCommand, TranscriptTaskTracker, AGENT_INTERACTION_DEFAULT_TIMEOUT_MS, parseTmuxAgentObservation, parseTmuxSelectionPrompt, tmuxSelectionPromptFingerprint, CLAUDE_TMUX_EVENT, POLL_INTERVAL_MS, TMUX_OBSERVATION_INTERVAL_MS, TMUX_BUSY_OBSERVATION_INTERVAL_MS, LIVENESS_CHECK_EVERY_TICKS, HOOK_TIMEOUT_SECS, COMMAND_IDLE_TIMEOUT_MS, COMMAND_NO_HOOK_SETTLE_MS, COMMAND_AFTER_IDLE_SETTLE_MS, PERMISSION_MODE_SWITCH_TIMEOUT_MS, PERMISSION_MODE_POLL_MS, FAST_MODE_SWITCH_TIMEOUT_MS, FAST_MODE_POLL_MS, FAST_MODE_TMUX_OPTION, BACKUP_SENTINEL_NO_ORIGINAL, CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN, RUNTIME_ROOT_PREFIX, claudeTmuxRuntimeRootPrefix, agentMcpConfigJson, agentToolConnectionTarget, runtimeRootPrefixForContext, isMissingTmuxSessionError, THINKING_MODE_ARGS, THINKING_DISPLAY_FLAG, THINKING_DISPLAY_VALUE, THINKING_DISPLAY_PROBE_VALUE, THINKING_DISPLAY_PROBE_TIMEOUT_MS, HOOK_EVENT_KINDS, containerExecArgs, asString, asOptionalString, asBoolean, asPositiveInt, asNonNegativeInt, asStringArray, shellArg, shellDq, readableIdPrefix, tmuxSessionName, tmuxSessionNamePrefix, parseTmuxSessionNames, selectReapableTmuxSessions, isBlockingHook, parseEventFilename, responseFilename, pathDirname, bytesPayload, countNewlines, execWithOutput, execWithRawOutput, POLL_SNAPSHOT_PENDING_MARKER, POLL_SNAPSHOT_TIMEOUT_MARKER, POLL_SNAPSHOT_SIZE_MARKER, pollSnapshotScript, parsePollSnapshotOutput, parsePollSnapshotExecOutput, tailFromOffsetCommand, TRANSCRIPT_HEAD_MARKER, transcriptHeadCommand, parseTranscriptHeadOutput, MAX_PREVIOUS_SESSIONS, PREVIOUS_SESSION_STAT_CONCURRENCY, jsonlByMtimeFindCommand, isDirectJsonlChild, listLocalJsonlByMtime, parseFreshJsonlFindOutput, INTERACTIVE_KEY_SEQUENCES, sendInteractiveData, TmuxSession, stripAnsi, paneOutputAfterCommand, fastModeFromPane, fastModeRejectionFromPane, paneHasSelectionPrompt, paneHasClaudeExited, AsyncMutex, TmuxSessionManager, tmuxManager, tmuxActivityWrites, orphanedTmuxMissingSince, lastTmuxOrphanSweepAt, persistTmuxEnvironmentActivity, workspaceAndClaudeHome, resolveBackend, resolveBundledClaudePath, resolvePinnedClaudeCommand, getOrCreateSession, killOrphanSession, killEnvironmentTmuxSessions, getLastTmuxOrphanSweepAt, setLastTmuxOrphanSweepAt];
type CommandContext = shared.CommandContext;
type AgentToolConnection = shared.AgentToolConnection;
type Environment = shared.Environment;
type JsonRecord = shared.JsonRecord;
type TaskListSnapshot = shared.TaskListSnapshot;
type TmuxAgentObservation = shared.TmuxAgentObservation;
type TranscriptTaskTracker = shared.TranscriptTaskTracker;
type CommandHandler = shared.CommandHandler;
type RegisterCommand = shared.RegisterCommand;
type ExecOutput = shared.ExecOutput;
type BackendKind = shared.BackendKind;
type RawExecOutput = shared.RawExecOutput;
type TmuxPollSnapshot = shared.TmuxPollSnapshot;
type SessionHookPaths = shared.SessionHookPaths;
type TmuxSession = sessionManager.TmuxSession;
type TmuxSessionManager = sessionManager.TmuxSessionManager;
type AsyncMutex = sessionManager.AsyncMutex;
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
  if (
    changed.length * 2 >= after.length
    || after.every((line) => line.trim().length === 0)
  ) {
    return full();
  }
  return {
    text: changed
      .map((index) => `\x1b[${index + 1};1H\x1b[2K${after[index] ?? ""}`)
      .join(""),
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
  context?: CommandContext;
};

export type InteractiveTmuxTerminalManagerOptions = {
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
};

export class InteractiveTmuxTerminalManager {
  private readonly terminals = new Map<string, InteractiveTerminalSession>();
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelTimeout: (timer: unknown) => void;

  constructor(options: InteractiveTmuxTerminalManagerOptions = {}) {
    this.scheduleTimeout = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimeout = options.cancel ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  create(tmux: TmuxSession, cols: number, rows: number): string {
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
    });
    return id;
  }

  async start(id: string, context: CommandContext): Promise<void> {
    const terminal = this.require(id);
    terminal.context = context;
    await this.changeGeometry(terminal, terminal.cols, terminal.rows);
    await this.emitSnapshot(terminal, context, true);
    this.schedule(terminal);
  }

  async write(id: string, data: string): Promise<void> {
    const terminal = this.require(id);
    // Input is about to produce output, so undo any backoff before it lands.
    terminal.intervalMs = INTERACTIVE_SNAPSHOT_MIN_MS;
    if (terminal.timer !== undefined) this.schedule(terminal);
    await terminal.tmux.writeInteractive(data);
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

  private require(id: string): InteractiveTerminalSession {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error("tmux interactive terminal session not found");
    return terminal;
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

  private finishGeometryChange(
    terminal: InteractiveTerminalSession,
    generation: number,
  ): void {
    if (
      this.terminals.get(terminal.id) !== terminal
      || terminal.captureGeneration !== generation
    ) {
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
      void this.emitSnapshot(terminal, context, false)
        .catch((error) => {
          console.debug("[tmux] interactive snapshot failed", error);
        })
        .finally(() => {
          if (this.terminals.get(terminal.id) === terminal) this.schedule(terminal);
        });
    }, terminal.intervalMs);
  }

  private async emitSnapshot(terminal: InteractiveTerminalSession, context: CommandContext, force: boolean): Promise<void> {
    if (terminal.captureSuspended) return;
    const generation = terminal.captureGeneration;
    const snapshot = await terminal.tmux.capturePane({ ansi: true, joinWrapped: false });
    // Detach can happen while capture-pane is in flight. Never emit the late
    // snapshot or revive its timer after the terminal has been removed. A
    // resize or forced restart also makes an earlier capture stale even if it
    // finishes last.
    if (
      this.terminals.get(terminal.id) !== terminal
      || terminal.captureGeneration !== generation
      || terminal.captureSuspended
    ) {
      return;
    }
    const repaint = force || terminal.forceNextSnapshot;
    if (!repaint && snapshot === terminal.lastSnapshot) {
      terminal.intervalMs = Math.min(INTERACTIVE_SNAPSHOT_MAX_MS, terminal.intervalMs * 2);
      return;
    }
    // Any change snaps the cadence back: output usually arrives in bursts.
    terminal.intervalMs = INTERACTIVE_SNAPSHOT_MIN_MS;
    const update = buildTmuxPaneUpdate(terminal.lastSnapshot, snapshot, repaint);
    terminal.lastSnapshot = snapshot;
    terminal.forceNextSnapshot = false;
    if (update.text) {
      context.emit(
        `terminal-output-${terminal.id}`,
        bytesPayload(update.text, update.full),
      );
    }
  }
}

export const interactiveTerminals = new InteractiveTmuxTerminalManager();

export function detachInteractiveTerminalsForEnvironment(environmentId: string): void {
  interactiveTerminals.detachEnvironment(environmentId);
}

