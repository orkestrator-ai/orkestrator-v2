import * as shared from "./tmux-shared.js";
import * as backend from "./tmux-backend.js";
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
  TmuxBackend,
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
} = Object.assign({}, shared, backend, sessionManager);
void [existsSync, fs, path, os, createHash, randomUUID, spawn, delay, ORKESTRATOR_AGENT_MCP_SERVER_NAME, runCommand, TranscriptTaskTracker, AGENT_INTERACTION_DEFAULT_TIMEOUT_MS, parseTmuxAgentObservation, parseTmuxSelectionPrompt, tmuxSelectionPromptFingerprint, CLAUDE_TMUX_EVENT, POLL_INTERVAL_MS, TMUX_OBSERVATION_INTERVAL_MS, TMUX_BUSY_OBSERVATION_INTERVAL_MS, LIVENESS_CHECK_EVERY_TICKS, HOOK_TIMEOUT_SECS, COMMAND_IDLE_TIMEOUT_MS, COMMAND_NO_HOOK_SETTLE_MS, COMMAND_AFTER_IDLE_SETTLE_MS, PERMISSION_MODE_SWITCH_TIMEOUT_MS, PERMISSION_MODE_POLL_MS, FAST_MODE_SWITCH_TIMEOUT_MS, FAST_MODE_POLL_MS, FAST_MODE_TMUX_OPTION, BACKUP_SENTINEL_NO_ORIGINAL, CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN, RUNTIME_ROOT_PREFIX, claudeTmuxRuntimeRootPrefix, agentMcpConfigJson, agentToolConnectionTarget, runtimeRootPrefixForContext, isMissingTmuxSessionError, THINKING_MODE_ARGS, THINKING_DISPLAY_FLAG, THINKING_DISPLAY_VALUE, THINKING_DISPLAY_PROBE_VALUE, THINKING_DISPLAY_PROBE_TIMEOUT_MS, HOOK_EVENT_KINDS, containerExecArgs, asString, asOptionalString, asBoolean, asPositiveInt, asNonNegativeInt, asStringArray, shellArg, shellDq, readableIdPrefix, tmuxSessionName, tmuxSessionNamePrefix, parseTmuxSessionNames, selectReapableTmuxSessions, isBlockingHook, parseEventFilename, responseFilename, pathDirname, bytesPayload, countNewlines, execWithOutput, execWithRawOutput, POLL_SNAPSHOT_PENDING_MARKER, POLL_SNAPSHOT_TIMEOUT_MARKER, POLL_SNAPSHOT_SIZE_MARKER, pollSnapshotScript, parsePollSnapshotOutput, parsePollSnapshotExecOutput, tailFromOffsetCommand, TRANSCRIPT_HEAD_MARKER, transcriptHeadCommand, parseTranscriptHeadOutput, MAX_PREVIOUS_SESSIONS, PREVIOUS_SESSION_STAT_CONCURRENCY, jsonlByMtimeFindCommand, isDirectJsonlChild, listLocalJsonlByMtime, parseFreshJsonlFindOutput, INTERACTIVE_KEY_SEQUENCES, sendInteractiveData, TmuxBackend, TmuxSession, stripAnsi, paneOutputAfterCommand, fastModeFromPane, fastModeRejectionFromPane, paneHasSelectionPrompt, paneHasClaudeExited, AsyncMutex, TmuxSessionManager, tmuxManager, tmuxActivityWrites, orphanedTmuxMissingSince, lastTmuxOrphanSweepAt, persistTmuxEnvironmentActivity, workspaceAndClaudeHome, resolveBackend, resolveBundledClaudePath, resolvePinnedClaudeCommand, getOrCreateSession, killOrphanSession, killEnvironmentTmuxSessions, getLastTmuxOrphanSweepAt, setLastTmuxOrphanSweepAt];
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
type TmuxBackend = backend.TmuxBackend;
type TmuxSession = sessionManager.TmuxSession;
type TmuxSessionManager = sessionManager.TmuxSessionManager;
type AsyncMutex = sessionManager.AsyncMutex;
export type PollTmuxLayerTypes = [
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
  TmuxBackend,
  TmuxSession,
  TmuxSessionManager,
  AsyncMutex,
];
export type ClaudeStatePoll = {
  timer: unknown;
  lastState: string;
  failedReads: number;
  stale: boolean;
  active: boolean;
  pollRequested: boolean;
  inFlight?: Promise<void>;
  context: CommandContext;
  /** When storage last confirmed the environment still owns a running container. */
  lastRetirementCheckAt?: number;
};

export type ClaudeStatePollManagerOptions = {
  readState?: (containerId: string) => Promise<string>;
  schedule?: (callback: () => void) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => string;
  nowMs?: () => number;
};

/** How long the agent has to answer before a state read is abandoned. */
export const CLAUDE_STATE_READ_TIMEOUT_MS = 5_000;
/** Gap between state reads. Each tick coalesces behind any in-flight read. */
export const CLAUDE_STATE_POLL_INTERVAL_MS = 1_000;
/**
 * How often a poll that observed *no* change still asks storage whether its
 * environment is still running. A changed state consults storage immediately;
 * this bounds how long a poll can outlive the environment it belongs to, for
 * the case where nothing else retired it.
 */
export const CLAUDE_STATE_RETIREMENT_CHECK_MS = 15_000;

/**
 * The command that reads the agent's self-reported state out of a container.
 * Extracted so the argv is assertable without a Docker daemon — a typo here
 * degrades to "always idle" rather than to a visible failure.
 */
export function claudeStateReadCommand(containerId: string): {
  command: string;
  args: string[];
  options: { timeoutMs: number };
} {
  return {
    command: "docker",
    args: ["exec", containerId, "cat", "/tmp/.claude-state"],
    options: { timeoutMs: CLAUDE_STATE_READ_TIMEOUT_MS },
  };
}

export class ClaudeStatePollManager {
  private readonly polls = new Map<string, ClaudeStatePoll>();
  private readonly readState: (containerId: string) => Promise<string>;
  private readonly schedule: (callback: () => void) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private readonly now: () => string;
  private readonly nowMs: () => number;

  constructor(options: ClaudeStatePollManagerOptions = {}) {
    this.readState = options.readState ?? (async (containerId) => {
      const { command, args, options: runOptions } =
        claudeStateReadCommand(containerId);
      return (await runCommand(command, args, runOptions)).stdout.trim();
    });
    this.schedule = options.schedule
      ?? ((callback) => setInterval(callback, CLAUDE_STATE_POLL_INTERVAL_MS));
    this.cancel = options.cancel ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  start(
    containerId: string,
    context: CommandContext,
  ): void {
    const existing = this.polls.get(containerId);
    if (existing) {
      // Adopt the newest backend context after a supervisor reconciliation.
      existing.context = context;
      return;
    }
    const poll: ClaudeStatePoll = {
      timer: undefined,
      lastState: "",
      failedReads: 0,
      stale: false,
      active: true,
      pollRequested: false,
      context,
    };
    poll.timer = this.schedule(() => this.requestPoll(containerId, poll));
    this.polls.set(containerId, poll);
    this.requestPoll(containerId, poll);
  }

  /** Adopt every running container without waiting for a renderer lease. */
  async reconcile(context: CommandContext): Promise<void> {
    const environments = await context.storage.loadEnvironments();
    const running = new Set<string>();
    for (const environment of environments) {
      if (environment.status !== "running" || !environment.containerId) continue;
      running.add(environment.containerId);
      this.start(environment.containerId, context);
    }
    for (const containerId of this.polls.keys()) {
      if (!running.has(containerId)) this.shutdown(containerId);
    }
  }

  /**
   * Retire a poll immediately, regardless of leases or environment status.
   * Used when the container itself is going away, so the next `docker exec`
   * would be against something that no longer exists.
   */
  shutdown(containerId: string): void {
    const poll = this.polls.get(containerId);
    if (poll) this.deactivate(containerId, poll);
  }

  private deactivate(containerId: string, poll: ClaudeStatePoll): void {
    if (this.polls.get(containerId) !== poll) return;
    poll.active = false;
    this.cancel(poll.timer);
    this.polls.delete(containerId);
  }

  private requestPoll(containerId: string, poll: ClaudeStatePoll): void {
    if (!poll.active || this.polls.get(containerId) !== poll) return;
    if (poll.inFlight) {
      poll.pollRequested = true;
      return;
    }
    poll.inFlight = this.poll(containerId, poll)
      .catch(() => undefined)
      .finally(() => {
        poll.inFlight = undefined;
        if (
          poll.active
          && this.polls.get(containerId) === poll
          && poll.pollRequested
        ) {
          poll.pollRequested = false;
          this.requestPoll(containerId, poll);
        }
      });
  }

  private isCurrent(containerId: string, poll: ClaudeStatePoll): boolean {
    return poll.active && this.polls.get(containerId) === poll;
  }

  /**
   * Whether an unchanged tick should still confirm the environment is running.
   * Undefined means it never has, which is why the first tick always checks.
   */
  private isRetirementCheckDue(poll: ClaudeStatePoll): boolean {
    return poll.lastRetirementCheckAt === undefined
      || this.nowMs() - poll.lastRetirementCheckAt >= CLAUDE_STATE_RETIREMENT_CHECK_MS;
  }

  private async poll(containerId: string, poll: ClaudeStatePoll): Promise<void> {
    const state = (await this.readState(containerId).catch(() => "")).trim();
    if (!this.isCurrent(containerId, poll)) return;

    const known = state === "working" || state === "waiting" || state === "idle";
    if (known) poll.failedReads = 0;
    else poll.failedReads += 1;
    const changed = known && (state !== poll.lastState || poll.stale);
    // A tick that observed nothing new must cost nothing beyond the state read.
    // Loading environments here parses the whole environments file, once per
    // second per running container, to answer a question whose answer has not
    // changed. The retirement check below is what that read is *for*, and it
    // only has to be timely enough to stop polling a container that has gone.
    if (!changed && !this.isRetirementCheckDue(poll)) return;

    const environment = (await poll.context.storage.loadEnvironments()).find(
      (candidate) => candidate.containerId === containerId,
    );
    if (!this.isCurrent(containerId, poll)) return;
    poll.lastRetirementCheckAt = this.nowMs();
    if (!environment || environment.status !== "running") {
      this.deactivate(containerId, poll);
      return;
    }
    if (!known && poll.failedReads >= 3 && !poll.stale) {
      const previous = poll.lastState === "working"
        || poll.lastState === "waiting"
        || poll.lastState === "idle"
        ? poll.lastState
        : environment.agentActivitySources?.["claude-terminal"]?.state ?? "idle";
      await poll.context.storage.setEnvironmentAgentActivity(
        environment.id,
        previous,
        this.now(),
        "claude-terminal",
        undefined,
        true,
      );
      if (!this.isCurrent(containerId, poll)) return;
      poll.lastState = previous;
      poll.stale = true;
      return;
    }
    if (!changed) return;
    const occurredAt = this.now();
    const persisted = await poll.context.storage.setEnvironmentAgentActivity(
      environment.id,
      state,
      occurredAt,
      "claude-terminal",
    );
    if (!this.isCurrent(containerId, poll)) return;
    const persistedTerminal = persisted?.agentActivitySources?.["claude-terminal"];
    if (persistedTerminal?.state !== state) {
      // Storage rejected a stale token, or answered without the source at all.
      // Either way this observation did not land, so keep the previous observed
      // state and let a later poll retry with a fresh backend timestamp. Note
      // this must not emit: the renderer would adopt a state storage rejected.
      return;
    }
    // Production hooks write `working` at UserPromptSubmit and `waiting` at
    // Stop. `idle` is retained for older hook writers and recovery from a
    // backend restart. Storage's durable PR-recheck intent is authoritative,
    // so ordinary unarmed terminal turns do not manufacture monitor work.
    const completedTurn = Boolean(environment.prRecheckAfterAgentCompletionArmedAt)
      && (state === "idle" || state === "waiting") && (
      poll.lastState === "working"
      || poll.lastState === ""
    );
    // The turn-end edge as *this* transport sees it, which is deliberately not
    // `isAgentTurnEndTransition` from the native path. There, a bridge reports
    // `waiting` for a turn that is parked on an approval and still live, so only
    // idle ends a turn. Here the Stop hook writes `waiting`, so `waiting` is the
    // ordinary end of a Claude tmux turn. Do not unify the two: the same word
    // means "still running" on one transport and "finished" on the other.
    //
    // Unlike `completedTurn` this deliberately excludes the `lastState === ""`
    // cold start. An armed recheck is a durable, user-initiated intent worth
    // honouring across a restart, but a first observation of waiting/idle is a
    // turn that ended before this poll existed — probing it would cost one `gh`
    // call per running Claude tmux container on every backend start, which is
    // the standing per-environment cost the probe exists to avoid.
    const endedTurn = (state === "idle" || state === "waiting")
      && poll.lastState === "working";
    poll.lastState = state;
    poll.stale = false;
    if (completedTurn) {
      void poll.context.notifyAgentTurnCompleted?.(environment.id).catch((error) => {
        console.warn(
          `[tmux] Failed to schedule PR refresh after terminal completion for ${environment.id}:`,
          error instanceof Error ? error.message : error,
        );
      });
    }
    // Independent of the armed gate above: a Claude tmux agent can run
    // `gh pr create` itself, and an environment with no stored PR carries no
    // polling timer that would ever notice. Transition-only, because this poll
    // runs about once a second per container.
    if (endedTurn) this.probeForAgentCreatedPullRequest(poll, environment.id);
    poll.context.emit(`claude-state-${containerId}`, {
      container_id: containerId,
      state,
      occurred_at: persistedTerminal.updatedAt,
    });
  }

  /**
   * Fire-and-forget one-shot PR discovery for a Claude tmux turn that ended.
   *
   * Never awaited: this poll loop owes the renderer a `claude-state-*` frame,
   * and GitHub being slow or absent must not delay or cancel it. A hook that
   * throws synchronously is caught for the same reason.
   */
  private probeForAgentCreatedPullRequest(
    poll: ClaudeStatePoll,
    environmentId: string,
  ): void {
    const warn = (error: unknown): void => {
      console.warn(
        `[tmux] Failed to probe for an agent-created PR in ${environmentId}:`,
        error instanceof Error ? error.message : error,
      );
    };
    try {
      void Promise.resolve(poll.context.probeAgentCreatedPullRequest?.(environmentId))
        .catch(warn);
    } catch (error) {
      warn(error);
    }
  }
}

export const defaultClaudeStatePolls = new ClaudeStatePollManager();

/**
 * Retire state polling for a container that is being stopped or deleted.
 *
 * Polling deliberately outlives every renderer, and `poll()` only notices a
 * dead environment on its next tick. Calling this from the lifecycle commands
 * stops the read immediately instead of leaving one `docker exec` aimed at a
 * container that is already going away.
 */
export function shutdownClaudeStatePolling(containerId: string): void {
  defaultClaudeStatePolls.shutdown(containerId);
}

export function environmentContainerId(environment: Environment | null | undefined): string {
  return environment?.containerId ?? "";
}



