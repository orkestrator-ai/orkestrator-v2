import * as shared from "./tmux-shared.js";
import { TranscriptTaskTracker, runCommand } from "./tmux-shared.js";
import type { StateSignalCredential } from "./agent-tools.js";
import { TmuxBackend } from "./tmux-backend.js";
import { AsyncMutex, TmuxSession, TmuxSessionManager } from "./tmux-session-manager.js";
import {
  recurringWorkMetrics,
  type RecurringWorkMetrics,
  type RecurringWorkSpan,
} from "./recurring-work-metrics.js";
import {
  emptySignalHealthStates,
  recurringDiagnosticsRegistry,
  type SignalDemotionReason,
  type SignalHealthState,
  type SignalHealthStatus,
} from "./recurring-diagnostics.js";
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
  intervalMs: number;
  lastState: string;
  lastRevision?: number;
  lastCompletions?: number;
  observationRetry: boolean;
  failedReads: number;
  stale: boolean;
  active: boolean;
  pollRequested: boolean;
  inFlight?: Promise<void>;
  context: CommandContext;
  /** When storage last confirmed the environment still owns a running container. */
  lastRetirementCheckAt?: number;
  /** This lineage's doorbell credential, while one is issued. */
  signal?: StateSignalCredential;
  /**
   * A doorbell from `signal` arrived, so a change is read when it is announced
   * and a counter snapshot allows the timer to become the safety read.
   */
  signalConfirmed: boolean;
  /** The image has no signal; the container keeps the 1 s poll for its life. */
  signalUnsupported: boolean;
  signalArming?: Promise<void>;
  /** The signal was demoted or failed to arm, and has not been confirmed since. */
  signalDemoted: boolean;
  lastSignalAttemptAt?: number;
  /** Doorbells received, and the count when the previous read started. */
  rings: number;
  ringsAtPreviousRead: number;
  /** Rate window for {@link CLAUDE_STATE_SIGNAL_MAX_RINGS_PER_MINUTE}. */
  ringWindowStartedAt?: number;
  ringsInWindow: number;
};

/** `unknown`: the image could not be inspected right now; ask again later. */
export type ClaudeStateSignalSupport = "supported" | "unsupported" | "unknown";

/** Puts the doorbell config into a container (`claude-state-signal.ts`). */
export interface ClaudeStateSignalInstaller {
  support(containerId: string, context: CommandContext): Promise<ClaudeStateSignalSupport>;
  /** Resolves once the config is written and its probe ring has been sent. */
  install(
    containerId: string,
    credential: StateSignalCredential,
    context: CommandContext,
    isCurrent: () => boolean,
  ): Promise<void>;
}

export type ClaudeStatePollManagerOptions = {
  readState?: (containerId: string) => Promise<string>;
  schedule?: (callback: () => void, intervalMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => string;
  nowMs?: () => number;
  /** Content-free cost accounting; defaults to the process-wide recorder. */
  metrics?: RecurringWorkMetrics;
  /** Without one every container keeps the 1 s poll. */
  signal?: ClaudeStateSignalInstaller;
};

/** How long the agent has to answer before a state read is abandoned. */
export const CLAUDE_STATE_READ_TIMEOUT_MS = 5_000;
/**
 * Gap between state reads for a container without a working signal (an older
 * image, or one whose doorbell has not rung yet). Each tick coalesces behind
 * any in-flight read.
 */
export const CLAUDE_STATE_POLL_INTERVAL_MS = 1_000;
/**
 * Gap between reads once the doorbell works. Changes are read when announced;
 * this read only catches one the doorbell missed, and proves it missed: a
 * change seen here with no ring since the previous read demotes the container
 * to the 1 s poll.
 */
export const CLAUDE_STATE_SAFETY_READ_INTERVAL_MS = 30_000;
/**
 * Least gap between attempts to arm the doorbell for one container, so a path
 * that cannot work (firewall, a user's own hooks) costs a few execs every five
 * minutes rather than on every 2 s reconciliation.
 */
export const CLAUDE_STATE_SIGNAL_RETRY_MS = 300_000;
/**
 * Doorbells one container may ring in a minute. A turn rings twice, so this is
 * far above real use; past it the container returns to the 1 s poll, so code
 * in a container can never make the host run more state reads than the poll
 * it replaced.
 */
export const CLAUDE_STATE_SIGNAL_MAX_RINGS_PER_MINUTE = 30;
/**
 * How often a poll that observed *no* change still asks storage whether its
 * environment is still running. A changed state consults storage immediately;
 * this bounds how long a poll can outlive the environment it belongs to, for
 * the case where nothing else retired it.
 */
export const CLAUDE_STATE_RETIREMENT_CHECK_MS = 15_000;

/**
 * What the read prints when neither state file exists: terminal Claude has
 * not run in this container (its hooks create the files). Framed with a
 * control character so no file content can produce it.
 */
export const CLAUDE_STATE_ABSENT_MARKER = "\u001eabsent";

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
    args: [
      "exec",
      containerId,
      "sh",
      "-c",
      "if [ -f /tmp/.claude-state-snapshot ]; then head -c 256 /tmp/.claude-state-snapshot; elif [ -f /tmp/.claude-state ]; then head -c 256 /tmp/.claude-state; else printf '\\036absent'; fi",
    ],
    options: { timeoutMs: CLAUDE_STATE_READ_TIMEOUT_MS },
  };
}

/**
 * Bounded v2 snapshots retain completion evidence even when both rings are lost.
 *
 * `absent` (no state file at all) is a successful read, not a failure: the
 * counters a first hook would start from (revision 0, no completions). It is
 * still no state to show, so it never emits or persists one.
 */
export function parseClaudeStateSnapshot(value: string): {
  state: string;
  revision?: number;
  completions?: number;
  absent?: true;
} {
  if (value === CLAUDE_STATE_ABSENT_MARKER) {
    return { state: "", revision: 0, completions: 0, absent: true };
  }
  if (value === "working" || value === "waiting" || value === "idle") return { state: value };
  if (value.length > 255) return { state: "" };
  const match = /^(working|waiting|idle) ([0-9]{1,15}) ([0-9]{1,15})$/.exec(value);
  if (!match) return { state: "" };
  const revision = Number(match[2]);
  const completions = Number(match[3]);
  if (completions > revision) return { state: "" };
  return { state: match[1]!, revision, completions };
}

export class ClaudeStatePollManager {
  private readonly polls = new Map<string, ClaudeStatePoll>();
  /** Survives retirement until the old installer has stopped writing. */
  private readonly signalInstallations = new Map<string, Promise<void>>();
  private readonly readState: (containerId: string) => Promise<string>;
  private readonly schedule: (callback: () => void, intervalMs: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly metrics: RecurringWorkMetrics;
  private signalInstaller: ClaudeStateSignalInstaller | null;
  /** Lifetime counters for {@link status}. */
  private readonly demotions: Partial<Record<SignalDemotionReason, number>> = {};
  private acceptedRings = 0;

  constructor(options: ClaudeStatePollManagerOptions = {}) {
    this.metrics = options.metrics ?? recurringWorkMetrics;
    this.signalInstaller = options.signal ?? null;
    this.readState =
      options.readState ??
      (async (containerId) => {
        const { command, args, options: runOptions } = claudeStateReadCommand(containerId);
        return (await runCommand(command, args, runOptions)).stdout.trim();
      });
    this.schedule =
      options.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancel = options.cancel ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /**
   * The registry installs the Docker-backed installer on the process-wide
   * manager; the poll module itself never reaches into container setup.
   */
  setSignalInstaller(installer: ClaudeStateSignalInstaller | null): void {
    this.signalInstaller = installer;
  }

  start(containerId: string, context: CommandContext): void {
    const existing = this.polls.get(containerId);
    if (existing) {
      // Adopt the newest backend context after a supervisor reconciliation.
      existing.context = context;
      this.armSignal(containerId, existing);
      return;
    }
    const poll: ClaudeStatePoll = {
      timer: undefined,
      intervalMs: CLAUDE_STATE_POLL_INTERVAL_MS,
      lastState: "",
      observationRetry: false,
      failedReads: 0,
      stale: false,
      active: true,
      pollRequested: false,
      context,
      signalConfirmed: false,
      signalUnsupported: false,
      signalDemoted: false,
      rings: 0,
      ringsAtPreviousRead: 0,
      ringsInWindow: 0,
    };
    poll.timer = this.schedule(
      () => this.requestPoll(containerId, poll),
      CLAUDE_STATE_POLL_INTERVAL_MS,
    );
    this.polls.set(containerId, poll);
    this.requestPoll(containerId, poll);
    this.armSignal(containerId, poll);
  }

  /**
   * Issues this lineage a doorbell credential and installs it, at most once
   * per retry window. Nothing changes until the install's probe ring arrives:
   * a credential that never rings leaves the 1 s poll in place.
   */
  private armSignal(containerId: string, poll: ClaudeStatePoll): void {
    const installer = this.signalInstaller;
    const agentTools = poll.context.agentTools;
    if (!installer || !agentTools?.issueStateSignal) return;
    if (poll.signalUnsupported || poll.signalConfirmed || poll.signalArming) return;
    const now = this.nowMs();
    if (
      poll.lastSignalAttemptAt !== undefined &&
      now - poll.lastSignalAttemptAt < CLAUDE_STATE_SIGNAL_RETRY_MS
    ) {
      return;
    }
    poll.lastSignalAttemptAt = now;
    const previous = this.signalInstallations.get(containerId);
    const arming = (async () => {
      await previous;
      if (!this.isCurrent(containerId, poll)) return;
      const support = await installer.support(containerId, poll.context);
      if (!this.isCurrent(containerId, poll)) return;
      if (support !== "supported") {
        poll.signalUnsupported = support === "unsupported";
        return;
      }
      this.revokeSignal(poll);
      let credential: StateSignalCredential | null = null;
      credential = agentTools.issueStateSignal!(() => {
        if (credential && poll.signal === credential) this.ring(containerId, poll);
      });
      if (!credential) return;
      poll.signal = credential;
      await installer.install(containerId, credential, poll.context, () =>
        this.isCurrent(containerId, poll),
      );
    })()
      .catch((error: unknown) => {
        // The poll is unchanged; the next attempt waits for the retry window.
        if (this.isCurrent(containerId, poll)) {
          poll.signalConfirmed = false;
          poll.signalDemoted = true;
          this.countDemotion("arm-failed");
          this.reschedule(containerId, poll, CLAUDE_STATE_POLL_INTERVAL_MS);
        }
        this.revokeSignal(poll);
        console.warn(
          `[tmux] Could not arm the Claude state signal for ${containerId}:`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        if (poll.signalArming === arming) poll.signalArming = undefined;
        if (this.signalInstallations.get(containerId) === arming)
          this.signalInstallations.delete(containerId);
      });
    poll.signalArming = arming;
    this.signalInstallations.set(containerId, arming);
  }

  /** A doorbell from this lineage's credential: read now, and trust the signal. */
  private ring(containerId: string, poll: ClaudeStatePoll): void {
    if (!this.isCurrent(containerId, poll)) return;
    const now = this.nowMs();
    if (poll.ringWindowStartedAt === undefined || now - poll.ringWindowStartedAt >= 60_000) {
      poll.ringWindowStartedAt = now;
      poll.ringsInWindow = 0;
    }
    poll.ringsInWindow += 1;
    if (poll.ringsInWindow > CLAUDE_STATE_SIGNAL_MAX_RINGS_PER_MINUTE) {
      this.demoteSignal(containerId, poll, "rang-too-often");
      return;
    }
    poll.rings += 1;
    this.acceptedRings += 1;
    poll.signalConfirmed = true;
    poll.signalDemoted = false;
    this.requestPoll(containerId, poll);
  }

  /**
   * Stop trusting the doorbell: poll every second again. Revoking the
   * credential makes any further ring a 401 that costs no read.
   */
  private demoteSignal(
    containerId: string,
    poll: ClaudeStatePoll,
    reason: Extract<SignalDemotionReason, "missed-change" | "rang-too-often">,
  ): void {
    poll.signalConfirmed = false;
    poll.signalDemoted = true;
    this.countDemotion(reason);
    this.revokeSignal(poll);
    this.reschedule(containerId, poll, CLAUDE_STATE_POLL_INTERVAL_MS);
    console.warn(
      `[tmux] Claude state signal in ${containerId} ${reason === "missed-change" ? "missed a change" : "rang too often"}; polling every second until it is re-armed`,
    );
  }

  private countDemotion(reason: SignalDemotionReason): void {
    this.demotions[reason] = (this.demotions[reason] ?? 0) + 1;
  }

  /**
   * Content-free signal health for recurring diagnostics: per-state counts of
   * the polls held now, how many run the 1 s poll, and lifetime demotions.
   */
  status(): SignalHealthStatus {
    const states = emptySignalHealthStates();
    let fallback = 0;
    for (const poll of this.polls.values()) {
      states[this.healthOf(poll)] += 1;
      if (poll.intervalMs !== CLAUDE_STATE_SAFETY_READ_INTERVAL_MS) fallback += 1;
    }
    return {
      containers: this.polls.size,
      states,
      fallback,
      demotions: { ...this.demotions },
      rings: this.acceptedRings,
    };
  }

  private healthOf(poll: ClaudeStatePoll): SignalHealthState {
    if (poll.signalUnsupported) return "unsupported";
    if (poll.signalConfirmed) return "confirmed";
    if (poll.signal) return "armed";
    if (poll.signalArming) return "arming";
    if (poll.signalDemoted) return "demoted";
    return "unarmed";
  }

  private revokeSignal(poll: ClaudeStatePoll): void {
    poll.signal?.revoke();
    poll.signal = undefined;
  }

  private reschedule(containerId: string, poll: ClaudeStatePoll, intervalMs: number): void {
    if (poll.intervalMs === intervalMs) return;
    poll.intervalMs = intervalMs;
    this.cancel(poll.timer);
    poll.timer = this.schedule(() => this.requestPoll(containerId, poll), intervalMs);
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
    this.revokeSignal(poll);
    this.polls.delete(containerId);
  }

  private requestPoll(containerId: string, poll: ClaudeStatePoll): void {
    if (!poll.active || this.polls.get(containerId) !== poll) return;
    this.metrics.requested("tmux-poll");
    if (poll.inFlight) {
      this.metrics.coalesced("tmux-poll");
      poll.pollRequested = true;
      return;
    }
    poll.inFlight = this.metrics
      .observe("tmux-poll", (span) => this.poll(containerId, poll, span))
      .catch(() => {
        if (this.isCurrent(containerId, poll)) this.retryObservation(containerId, poll);
      })
      .finally(() => {
        poll.inFlight = undefined;
        if (poll.active && this.polls.get(containerId) === poll && poll.pollRequested) {
          poll.pollRequested = false;
          this.requestPoll(containerId, poll);
        }
      });
  }

  private retryObservation(containerId: string, poll: ClaudeStatePoll): void {
    if (poll.signalConfirmed && !poll.observationRetry)
      this.reschedule(containerId, poll, CLAUDE_STATE_POLL_INTERVAL_MS);
    poll.observationRetry = true;
  }

  private acceptObservation(
    containerId: string,
    poll: ClaudeStatePoll,
    rings: number,
    revision?: number,
    completions?: number,
  ): void {
    poll.ringsAtPreviousRead = rings;
    poll.lastRevision = revision;
    poll.lastCompletions = completions;
    // A legacy state has no way to expose a whole missed turn: keep fast polling.
    const slow = poll.signalConfirmed && revision !== undefined;
    this.reschedule(
      containerId,
      poll,
      slow ? CLAUDE_STATE_SAFETY_READ_INTERVAL_MS : CLAUDE_STATE_POLL_INTERVAL_MS,
    );
    poll.observationRetry = false;
  }

  private isCurrent(containerId: string, poll: ClaudeStatePoll): boolean {
    return poll.active && this.polls.get(containerId) === poll;
  }

  /**
   * Whether an unchanged tick should still confirm the environment is running.
   * Undefined means it never has, which is why the first tick always checks.
   */
  private isRetirementCheckDue(poll: ClaudeStatePoll): boolean {
    return (
      poll.lastRetirementCheckAt === undefined ||
      this.nowMs() - poll.lastRetirementCheckAt >= CLAUDE_STATE_RETIREMENT_CHECK_MS
    );
  }

  private async poll(
    containerId: string,
    poll: ClaudeStatePoll,
    span?: RecurringWorkSpan,
  ): Promise<void> {
    // Any doorbell since the previous read started announces what this read
    // finds: that read may have run before the hook wrote the file.
    const ringsBeforePreviousRead = poll.ringsAtPreviousRead;
    const ringsAtReadStart = poll.rings;
    const { state, revision, completions, absent } = parseClaudeStateSnapshot(
      (await this.readState(containerId).catch(() => "")).trim(),
    );
    if (!this.isCurrent(containerId, poll)) return;

    const known = state === "working" || state === "waiting" || state === "idle";
    if (known) poll.failedReads = 0;
    else poll.failedReads += 1;
    const recoveredCompletion =
      completions !== undefined &&
      poll.lastCompletions !== undefined &&
      completions > poll.lastCompletions;
    const revisionChanged =
      revision !== undefined && poll.lastRevision !== undefined && revision !== poll.lastRevision;
    const changed = known && (state !== poll.lastState || poll.stale || revisionChanged);
    if (changed) span?.changed();
    else span?.unchanged();
    // A container where terminal Claude never ran has no state file. That is
    // an answer, not a failed read: it must not hold a confirmed doorbell on
    // the 1 s poll (it still counts towards stale marking below, as before).
    const observed = known || absent === true;
    if (!observed) this.retryObservation(containerId, poll);
    // A tick that observed nothing new must cost nothing beyond the state read.
    // Loading environments here parses the whole environments file, once per
    // second per running container, to answer a question whose answer has not
    // changed. The retirement check below is what that read is *for*, and it
    // only has to be timely enough to stop polling a container that has gone.
    if (!changed && !this.isRetirementCheckDue(poll)) {
      if (observed) {
        this.acceptObservation(containerId, poll, ringsAtReadStart, revision, completions);
      }
      return;
    }

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
      const previous =
        poll.lastState === "working" || poll.lastState === "waiting" || poll.lastState === "idle"
          ? poll.lastState
          : (environment.agentActivitySources?.["claude-terminal"]?.state ?? "idle");
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
      if (absent)
        this.acceptObservation(containerId, poll, ringsAtReadStart, revision, completions);
      return;
    }
    if (!changed) {
      if (observed) {
        this.acceptObservation(containerId, poll, ringsAtReadStart, revision, completions);
      }
      return;
    }
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
      this.retryObservation(containerId, poll);
      // Storage rejected a stale token, or answered without the source at all.
      // Either way this observation did not land, so keep the previous observed
      // state and let a later poll retry with a fresh backend timestamp. Note
      // this must not emit: the renderer would adopt a state storage rejected.
      return;
    }
    // Storage may have seen waiting both before and after a whole missed turn.
    // Publish its durable completion token without inventing a working state.
    if (
      recoveredCompletion &&
      !(poll.lastState === "working" && (state === "waiting" || state === "idle"))
    ) {
      await poll.context.storage.recordEnvironmentSessionCompletion(environment.id, occurredAt);
      if (!this.isCurrent(containerId, poll)) return;
    }
    if (
      poll.signalConfirmed &&
      !poll.observationRetry &&
      poll.lastState !== "" &&
      (state !== poll.lastState || revisionChanged) &&
      poll.rings === ringsBeforePreviousRead
    ) {
      this.demoteSignal(containerId, poll, "missed-change");
    }
    this.acceptObservation(containerId, poll, ringsAtReadStart, revision, completions);
    // Production hooks write `working` at UserPromptSubmit and `waiting` at
    // Stop. `idle` is retained for older hook writers and recovery from a
    // backend restart. Storage's durable PR-recheck intent is authoritative,
    // so ordinary unarmed terminal turns do not manufacture monitor work.
    const completedTurn =
      Boolean(environment.prRecheckAfterAgentCompletionArmedAt) &&
      (recoveredCompletion ||
        ((state === "idle" || state === "waiting") &&
          (poll.lastState === "working" || poll.lastState === "")));
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
    const endedTurn =
      recoveredCompletion ||
      ((state === "idle" || state === "waiting") && poll.lastState === "working");
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
  private probeForAgentCreatedPullRequest(poll: ClaudeStatePoll, environmentId: string): void {
    const warn = (error: unknown): void => {
      console.warn(
        `[tmux] Failed to probe for an agent-created PR in ${environmentId}:`,
        error instanceof Error ? error.message : error,
      );
    };
    try {
      void Promise.resolve(poll.context.probeAgentCreatedPullRequest?.(environmentId)).catch(warn);
    } catch (error) {
      warn(error);
    }
  }
}

export const defaultClaudeStatePolls = new ClaudeStatePollManager();
recurringDiagnosticsRegistry.addSignalSource("claude-state-signal", defaultClaudeStatePolls);

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
