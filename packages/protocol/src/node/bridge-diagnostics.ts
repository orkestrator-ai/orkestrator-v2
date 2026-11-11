import { createHash } from "node:crypto";
import { EVENT_LOOP_STALL_ALWAYS_LOG_MS } from "../event-loop-stall-monitor.js";
import { MAX_BRIDGE_DIAGNOSTIC_BYTES } from "../log-vocabulary/bridge.js";
import { createLogger, tryWriteLog, type LogEventOf } from "../logger.js";

export { MAX_BRIDGE_DIAGNOSTIC_BYTES };

const log = createLogger("bridge.diagnostics");

/** How often a scope's timer looks at the turn; at debug, every look is written. */
export const BRIDGE_DIAGNOSTICS_INTERVAL_MS = 60_000;
const INTERVAL_MS = BRIDGE_DIAGNOSTICS_INTERVAL_MS;
/**
 * No delta for this long while the scope waits on its provider is a stall. Two
 * intervals: one quiet look can be a model pause, and two quiet snapshots were
 * the earliest the per-minute stream told a stall from a pause.
 */
export const STALL_NO_DELTA_MS = 2 * INTERVAL_MS;
/**
 * One tool pending this long is a stall even while deltas still arrive. The app's
 * own stall warning (Multi Review, the build pipeline) is ten minutes; a pending
 * tool alone is weaker evidence than silence, because builds and subagents run
 * long and unmatched starts are common (cursor-diagnostics.md).
 */
export const STALL_TOOL_PENDING_MS = 10 * 60_000;
/** A timer this late means the event loop was held: the threshold `error` already uses. */
export const STALL_TICK_DELAY_MS = EVENT_LOOP_STALL_ALWAYS_LOG_MS;
/** With nothing else to write, a scope still writes this often, so a gap is bounded. */
export const BRIDGE_DIAGNOSTICS_KEEPALIVE_MS = 10 * 60_000;
const MAX_PENDING_TOOLS = 128;
const MAX_REPORTED_TOOLS = 8;
const MAX_ID_LENGTH = 1024;
const TOOL_KINDS = new Set([
  "shell",
  "read",
  "write",
  "edit",
  "delete",
  "grep",
  "glob",
  "ls",
  "task",
  "mcp",
  "bash",
  "web",
  "request",
  "initialize",
  "authenticate",
  "session/new",
  "session/load",
  "session/prompt",
  "session/set_mode",
  "session/set_config_option",
]);
const UPDATE_KINDS = new Set([
  "message",
  "notification",
  "response",
  "request",
  "approval",
  "stderr",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_end",
  "agent_start",
  "agent_end",
  "auto_retry_start",
  "auto_retry_end",
  "text-delta",
  "thinking-delta",
  "thinking-completed",
  "token-delta",
  "partial-tool-call",
  "tool-call-started",
  "tool-call-completed",
  "tool-call-delta",
  "shell-output-delta",
  "summary",
  "summary-started",
  "summary-completed",
  "user-message-appended",
  "turn-ended",
  "step-started",
  "step-completed",
]);

export type Phase =
  "sending" | "following" | "draining" | "send-failed" | "finished" | "attached" | "cancelling";
type Counter =
  | "stderrBytes"
  | "requestsSent"
  | "responsesReceived"
  | "timeouts"
  | "notificationsReceived"
  | "protocolErrors";
export type BridgeName = "cursor" | "claude" | "pi" | "acp" | "codex";
export type DiagnosticState = {
  id: string;
  revision?: number;
  status?: string;
  activeSubagentDescriptors?: { size: number };
};
export type CancellationReason = "user" | "timeout" | "turn-ended";
type Outcome = "pending" | "resolved" | "rejected";
type PendingTool = { kind: string; since: number; stage: "partial" | "started"; nested: boolean };
export type StallSignal = "no-delta" | "tool-pending" | "tick-delay";
/** Which stall signals hold, and which tools crossed the pending threshold. */
type StallState = { signals: ReadonlySet<StallSignal>; tools: ReadonlySet<string> };
/** What the last written snapshot showed: the change-driven rule compares against it. */
type Baseline = {
  at: number;
  phase: Phase;
  pending: ReadonlySet<string>;
  counters: Readonly<Record<Counter, number>>;
  stall: StallState;
};

/**
 * A counter that moved this much since the last snapshot is a change. Errors and
 * requests count once each; stderr counts in pages, so a trickle accumulates
 * rather than writing every minute. Notifications are the delta stream itself
 * (every ACP `session/update`), so they never count as a change: a streaming
 * turn would otherwise write every minute, and their silence is what the
 * no-delta stall signal already watches.
 */
export const COUNTER_CHANGE_THRESHOLDS: Readonly<Record<Counter, number>> = {
  stderrBytes: 4096,
  requestsSent: 1,
  responsesReceived: 1,
  timeouts: 1,
  notificationsReceived: Number.POSITIVE_INFINITY,
  protocolErrors: 1,
};
/** Phases in which a turn scope is waiting on its provider. */
const WAITING_PHASES: ReadonlySet<Phase> = new Set([
  "sending",
  "following",
  "draining",
  "cancelling",
]);

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** Provider-controlled identifiers are hashed, never printed or retained verbatim. */
function identity(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > MAX_ID_LENGTH) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function readBridgeDebugFlag(value: string | undefined): boolean {
  return value?.trim() === "1";
}

/**
 * The setting the backend last sent, or undefined before it has sent one. Until
 * then the environment is the startup default; after that the environment no
 * longer decides, in either direction.
 */
let liveDiagnostics: boolean | undefined;
/** Open scopes, so turning detail on reports them now rather than at the next tick. */
const liveScopes = new Set<BridgeRunDiagnostics>();

export function liveBridgeDiagnostics(): boolean | undefined {
  return liveDiagnostics;
}

/** Applies at once to every open scope, turns already running included. */
export function setLiveBridgeDiagnostics(enabled: boolean | undefined): void {
  liveDiagnostics = enabled;
  for (const scope of Array.from(liveScopes)) scope.syncActive();
}

/**
 * The live setting when one has arrived, else `ORKESTRATOR_BRIDGE_DEBUG`, the
 * startup default every launcher passes. The per-bridge spellings
 * (`CLAUDE_BRIDGE_DEBUG`, …) are no longer read.
 */
export function bridgeDebugEnabled(
  _bridge: BridgeName,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (liveDiagnostics !== undefined && env === process.env) return liveDiagnostics;
  return readBridgeDebugFlag(env.ORKESTRATOR_BRIDGE_DEBUG);
}

/** Whitelisted scalar metrics only; never spread a provider's health/error object. */
export function safeDiagnosticMetrics(
  value: Record<string, unknown>,
): Record<string, number | boolean | string> {
  const result: Record<string, number | boolean | string> = {};
  for (const key of [
    "httpStatus",
    "durationMs",
    "costUSD",
    "answerCount",
    "sdkMessageCount",
    "mcpServerCount",
    "pluginCount",
    "slashCommandCount",
    "subscriberCount",
    "revision",
    "pendingRequests",
    "pendingApprovals",
    "generation",
    "restartCount",
    "notificationQueueDepth",
    "notificationQueueHighWaterMark",
    "unknownNotifications",
    "unknownServerRequests",
    "requestsSent",
    "responsesReceived",
    "errorResponses",
    "overloadResponses",
    "serverRequestsReceived",
    "notificationsReceived",
    "protocolViolations",
    "timeouts",
    "writeBackpressureEvents",
    "oversizedInboundLines",
    "exitCode",
  ]) {
    const v = value[key];
    if (typeof v === "number" && Number.isFinite(v)) result[key] = v;
  }
  for (const key of ["circuitOpen", "cancelled"])
    if (typeof value[key] === "boolean") result[key] = value[key];
  if (
    typeof value.state === "string" &&
    [
      "idle",
      "running",
      "error",
      "ready",
      "starting",
      "stopped",
      "failed",
      "recovering",
      "stopping",
    ].includes(value.state)
  )
    result.state = value.state;
  return result;
}

/**
 * Whether a bridge writes a `change` snapshot as soon as the phase, the pending
 * tools or a counter past its threshold changes: `bridge.diagnostics` at trace.
 * Read per call, so it applies to a turn already running.
 */
export function bridgeDiagnosticsChangesEnabled(): boolean {
  return log.isEnabled("trace");
}

/** One snapshot: nested JSON is not a logger field, so `payload` carries it as one string. */
export interface BridgeDiagnosticEntry {
  bridge: BridgeName;
  event: LogEventOf<"bridge.diagnostics">;
  payload: string;
}
export type BridgeDiagnosticWrite = (entry: BridgeDiagnosticEntry) => void;

export function writeBridgeDiagnostic({ bridge, event, payload }: BridgeDiagnosticEntry): boolean {
  return tryWriteLog("info", "bridge.diagnostics", event, { bridge, payload });
}

/** Read per call, so a level replaced at runtime applies to scopes already open. */
export function bridgeDiagnosticsActive(): boolean {
  return log.isEnabled("info");
}

/**
 * Whether a bridge writes the per-minute stream now: `bridge.diagnostics` at debug
 * or trace, either as this process's level or as the switch the backend sends.
 * Read per call, so turning it on or off applies to a turn already running.
 */
export function bridgeDiagnosticsStreamEnabled(bridge: BridgeName): boolean {
  return bridgeDebugEnabled(bridge) || log.isEnabled("debug");
}

/** Bound every serialized diagnostic; sink errors never affect execution. */
function writeDiagnostic(
  bridge: BridgeName,
  event: BridgeDiagnosticEntry["event"],
  payload: Record<string, unknown>,
  write: BridgeDiagnosticWrite,
): boolean {
  try {
    const json = JSON.stringify({ bridge, event, ...payload });
    const bytes = Buffer.byteLength(json);
    if (bytes <= MAX_BRIDGE_DIAGNOSTIC_BYTES) {
      const accepted: unknown = write({ bridge, event, payload: json });
      return accepted !== false;
    }
    const accepted: unknown = write({
      bridge,
      event: "snapshot-overflow",
      payload: JSON.stringify({ bridge, event: "snapshot-overflow", omittedBytes: bytes }),
    });
    return accepted !== false;
  } catch {
    /* Diagnostic failures cannot affect execution. */
    return false;
  }
}

/**
 * Metadata only. SDK callbacks update bounded counters; the timer looks at the
 * turn once a minute off the producer path. No raw SDK logger is enabled: its
 * errors, arguments and payloads can contain credentials or user content.
 * Lifetime belongs to the backend turn, including while the UI is unmounted.
 *
 * Lifecycle events are written whenever `bridge.diagnostics` allows `info`. A
 * look is written every minute while `active()` says the per-minute stream is
 * on (`bridge.diagnostics` at debug); otherwise only when a stall signal starts
 * or clears, when something changes during a silent stall, or as a keepalive.
 * At trace a change of phase, pending tools or a counter is also written as a
 * `change` snapshot as soon as it happens. A healthy turn's changes are never
 * written at info. docs/architecture/bridge-diagnostics.md, "When a snapshot is
 * written".
 *
 * A scope counts whether or not it is writing. Turning detail on mid-turn is how
 * someone looks at a stuck agent, so the first snapshot has to cover the turn so
 * far: which tools are pending and when anything last moved.
 */
export class BridgeRunDiagnostics {
  private readonly counters: Record<Counter, number> = {
    stderrBytes: 0,
    requestsSent: 0,
    responsesReceived: 0,
    timeouts: 0,
    notificationsReceived: 0,
    protocolErrors: 0,
  };
  private readonly startedAt: number;
  private lastTick: number;
  private lastDelta?: number;
  private lastStream?: number;
  private lastNestedDelta?: number;
  private lastUpdate = "none";
  private deltaCount = 0;
  private streamCount = 0;
  private translationFailures = 0;
  private untrackedTools = 0;
  private completedTools = 0;
  private readonly pending = new Map<string, PendingTool>();
  private phase: Phase = "sending";
  private processScope = false;
  private terminal: Outcome = "pending";
  private stream: Outcome = "pending";
  private cancellation: "none" | Outcome = "none";
  private cancelReason?: CancellationReason;
  private run?: string;
  private closed = false;
  private wasActive: boolean;
  private baseline?: Baseline;
  /** A `change` snapshot is queued for the end of the producer's synchronous work. */
  private changeQueued = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly bridge: BridgeName,
    private readonly state: DiagnosticState,
    private readonly now: () => number = Date.now,
    private readonly write: BridgeDiagnosticWrite = writeBridgeDiagnostic,
    private readonly intervalMs = INTERVAL_MS,
    private readonly metrics: () => Record<string, unknown> = () => ({}),
    /** Whether the per-minute stream is on; read per tick. */
    protected readonly active: () => boolean = () => true,
  ) {
    this.startedAt = this.lastTick = now();
    this.wasActive = active();
    this.timer = setInterval(() => this.report("heartbeat"), intervalMs);
    this.timer.unref();
    liveScopes.add(this);
    this.report("send-started");
  }

  /** The setting may have changed: a stream turned on reports where the turn is now. */
  syncActive(): void {
    const active = this.active();
    if (active && !this.wasActive) this.report("heartbeat");
    this.wasActive = active;
  }

  sent(runId: string): void {
    this.run = identity(runId);
    this.phase = "following";
    this.report("send-resolved");
  }

  activity(kind: string, nested = false): void {
    if (this.closed) return;
    this.lastDelta = this.now();
    this.deltaCount++;
    this.lastUpdate = UPDATE_KINDS.has(kind) ? kind : "unknown";
    if (nested) this.lastNestedDelta = this.lastDelta;
  }

  tool(
    callId: unknown,
    kind: unknown,
    stage: "partial" | "started" | "completed",
    nested = false,
  ): void {
    if (this.closed) return;
    const key = identity(callId);
    if (!key) {
      this.untrackedTools++;
      return;
    }
    if (stage === "completed") {
      if (this.pending.delete(key)) this.changed();
      this.completedTools++;
      return;
    }
    const existing = this.pending.get(key);
    if (!existing && this.pending.size >= MAX_PENDING_TOOLS) {
      this.untrackedTools++;
      return;
    }
    this.pending.set(key, {
      kind: typeof kind === "string" && TOOL_KINDS.has(kind) ? kind : "other",
      since: existing?.since ?? this.now(),
      stage: stage === "started" || existing?.stage === "started" ? "started" : "partial",
      nested,
    });
    if (!existing) this.changed();
  }

  checkpoint(phase: Phase): void {
    if (phase === "attached") this.processScope = true;
    if (phase === this.phase) return;
    this.phase = phase;
    this.changed();
  }
  count(key: Counter, amount = 1): void {
    if (this.closed || !Number.isSafeInteger(amount) || amount < 0) return;
    this.counters[key] += amount;
    if (amount > 0 && Number.isFinite(COUNTER_CHANGE_THRESHOLDS[key])) this.changed();
  }

  translationFailed(): void {
    this.translationFailures++;
  }
  streamEvent(): void {
    if (this.closed) return;
    this.lastStream = this.now();
    this.streamCount++;
  }
  streamSettled(outcome: Outcome): void {
    this.stream = outcome;
  }
  terminalSettled(outcome: Outcome): void {
    this.terminal = outcome;
    if (outcome === "resolved" && this.phase !== "draining") {
      this.phase = "draining";
      this.changed();
    }
  }

  requestCancellation(reason: CancellationReason = "user"): void {
    this.cancellation = "pending";
    this.cancelReason = reason;
    this.phase = "cancelling";
    this.report("cancel-requested");
  }

  async cancel(run: { cancel(): Promise<void> }, reason: CancellationReason): Promise<void> {
    this.requestCancellation(reason);
    try {
      await run.cancel();
      this.cancellation = "resolved";
    } catch {
      this.cancellation = "rejected";
    }
    this.report("cancel-settled");
  }

  report(
    event:
      | "heartbeat"
      | "send-started"
      | "send-resolved"
      | "cancel-requested"
      | "cancel-settled"
      | "closed",
  ): void {
    if (this.closed) return;
    const now = this.now();
    const tickDelayMs =
      event === "heartbeat" ? Math.max(0, now - this.lastTick - this.intervalMs) : 0;
    if (event === "heartbeat") this.lastTick = now;
    if (!bridgeDiagnosticsActive()) return;
    const stall = this.stallState(now, tickDelayMs);
    if (event === "heartbeat" && !this.active() && !this.periodicDue(now, stall)) return;
    this.writeSnapshot(event, now, tickDelayMs, stall);
  }

  /**
   * Something a `change` snapshot compares may have moved. Below trace this is one
   * level check and nothing else. At trace the comparison and the write wait for
   * the producer's synchronous work to finish, so a burst of updates (a tool
   * replaced by another, a batch of requests) is one snapshot, and a tool that
   * starts and finishes in one burst changes nothing.
   */
  private changed(): void {
    if (this.closed || this.changeQueued || !bridgeDiagnosticsChangesEnabled()) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      this.reportChange();
    });
  }

  private reportChange(): void {
    if (this.closed || !bridgeDiagnosticsChangesEnabled() || !bridgeDiagnosticsActive()) return;
    const last = this.baseline;
    if (last && !this.changedSince(last)) return;
    const now = this.now();
    try {
      this.writeSnapshot("change", now, 0, this.stallState(now, 0));
    } catch {
      // A diagnostic sink must never fail an agent turn.
    }
  }

  private writeSnapshot(
    event: BridgeDiagnosticEntry["event"],
    now: number,
    tickDelayMs: number,
    stall: StallState,
  ): void {
    const age = (time: number | undefined) => (time === undefined ? null : Math.max(0, now - time));
    const pendingTools = Array.from(this.pending.entries())
      .slice(0, MAX_REPORTED_TOOLS)
      .map(([id, tool]) => ({
        id,
        kind: tool.kind,
        stage: tool.stage,
        nested: tool.nested,
        ageMs: age(tool.since),
      }));
    try {
      const written = writeDiagnostic(
        this.bridge,
        event,
        {
          session: identity(this.state.id),
          run: this.run,
          phase: this.phase,
          elapsedMs: age(this.startedAt),
          lastDeltaAgoMs: age(this.lastDelta),
          lastStreamAgoMs: age(this.lastStream),
          lastNestedDeltaAgoMs: age(this.lastNestedDelta),
          lastUpdate: this.lastUpdate,
          deltaCount: this.deltaCount,
          streamCount: this.streamCount,
          translationFailures: this.translationFailures,
          terminal: this.terminal,
          stream: this.stream,
          cancellation: this.cancellation,
          cancelReason: this.cancelReason,
          revision: this.state.revision,
          sessionStatus: safeDiagnosticMetrics({ state: this.state.status }).state,
          activeSubagents: this.state.activeSubagentDescriptors?.size ?? 0,
          counters: this.counters,
          metrics: safeDiagnosticMetrics(this.metrics()),
          pendingToolCount: this.pending.size,
          pendingTools,
          untrackedTools: this.untrackedTools,
          completedTools: this.completedTools,
          tickDelayMs,
        },
        this.write,
      );
      if (!written) return;
      this.baseline = {
        at: now,
        phase: this.phase,
        pending: new Set(this.pending.keys()),
        counters: { ...this.counters },
        stall,
      };
    } catch {
      // A diagnostic sink must never fail an agent turn.
    }
  }

  /**
   * Off the per-minute stream, a look is written only when it is stall evidence
   * the last snapshot did not carry: the timer fired late; a stall signal started
   * or cleared (or another tool crossed the pending threshold); or, while the turn
   * is silent (no delta), the phase, the set of pending tools or a counter past
   * its threshold changed. Otherwise only the keepalive. A healthy turn's changes
   * are not written at info: they are what a healthy turn does (`change`, at trace,
   * writes them).
   */
  private periodicDue(now: number, stall: StallState): boolean {
    // Each late firing is a separate observation, not an age of a persistent stall.
    if (stall.signals.has("tick-delay")) return true;
    const last = this.baseline;
    if (!last) return true;
    if (!sameSet(stall.signals, last.stall.signals) || !sameSet(stall.tools, last.stall.tools))
      return true;
    if (stall.signals.has("no-delta") && this.changedSince(last)) return true;
    return now - last.at >= BRIDGE_DIAGNOSTICS_KEEPALIVE_MS;
  }

  private changedSince(last: Baseline): boolean {
    if (this.phase !== last.phase) return true;
    if (this.pending.size !== last.pending.size) return true;
    for (const key of this.pending.keys()) if (!last.pending.has(key)) return true;
    for (const key of Object.keys(this.counters) as Counter[])
      if (this.counters[key] - last.counters[key] >= COUNTER_CHANGE_THRESHOLDS[key]) return true;
    return false;
  }

  /** From fields the snapshot already carries: `lastDeltaAgoMs`, `pendingTools`, `tickDelayMs`. */
  private stallState(now: number, tickDelayMs: number): StallState {
    const signals = new Set<StallSignal>();
    const tools = new Set<string>();
    let oldestPending: number | undefined;
    for (const [key, tool] of this.pending) {
      if (oldestPending === undefined || tool.since < oldestPending) oldestPending = tool.since;
      if (now - tool.since >= STALL_TOOL_PENDING_MS) tools.add(key);
    }
    // A turn waits from its start; a process scope only while a request is pending.
    const waitingSince = this.processScope
      ? oldestPending
      : WAITING_PHASES.has(this.phase)
        ? this.startedAt
        : undefined;
    if (waitingSince !== undefined) {
      const quietSince = Math.max(this.lastDelta ?? waitingSince, waitingSince);
      if (now - quietSince >= STALL_NO_DELTA_MS) signals.add("no-delta");
    }
    if (tools.size > 0) signals.add("tool-pending");
    if (tickDelayMs >= STALL_TICK_DELAY_MS) signals.add("tick-delay");
    return { signals, tools };
  }

  close(phase: "send-failed" | "finished" = "finished"): void {
    if (this.closed) return;
    this.phase = phase;
    this.report("closed");
    this.closed = true;
    liveScopes.delete(this);
    clearInterval(this.timer);
    this.pending.clear();
  }
}

export function createBridgeDiagnostics(
  bridge: BridgeName,
  state: DiagnosticState,
  metrics?: () => Record<string, unknown>,
): BridgeRunDiagnostics {
  return new BridgeRunDiagnostics(bridge, state, undefined, undefined, undefined, metrics, () =>
    bridgeDiagnosticsStreamEnabled(bridge),
  );
}

/** A numeric metric across a batch: how many carried it, and their range and total. */
type MetricSummary = { n: number; min: number; max: number; sum: number };
/** A boolean or vocabulary metric across a batch: how many times each value was seen. */
type MetricTally = Record<string, number>;
type BufferedEntry = {
  count: number;
  numbers: Map<string, MetricSummary>;
  values: Map<string, MetricTally>;
};

/** Open buffered loggers, flushed when the process exits or is signalled to. */
const bufferedFlushes = new Set<() => void>();
const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;
let shutdownFlushInstalled = false;

/** Writes what every open buffered logger holds; for a bridge's own shutdown path. */
export function flushBufferedDebugLoggers(): void {
  for (const flush of Array.from(bufferedFlushes)) flush();
}

/**
 * `exit` covers `process.exit()` and a drained loop. A signal flushes, then is
 * left to whoever else handles it; with no one else, it is raised again so the
 * process still ends the way it would have. Listeners never keep a process alive.
 */
function installShutdownFlush(): void {
  if (shutdownFlushInstalled) return;
  shutdownFlushInstalled = true;
  process.once("exit", flushBufferedDebugLoggers);
  for (const signal of SHUTDOWN_SIGNALS) {
    // Run before existing once-handlers remove themselves and begin async cleanup.
    // Their presence means they own termination, even if they later remove themselves.
    process.prependOnceListener(signal, () => {
      flushBufferedDebugLoggers();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

function summarize(entry: BufferedEntry, metrics: Record<string, number | boolean | string>) {
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number") {
      const summary = entry.numbers.get(key);
      if (!summary) {
        entry.numbers.set(key, { n: 1, min: value, max: value, sum: value });
        continue;
      }
      summary.n++;
      summary.min = Math.min(summary.min, value);
      summary.max = Math.max(summary.max, value);
      summary.sum += value;
      continue;
    }
    // Booleans, and `state`, whose vocabulary safeDiagnosticMetrics fixes.
    const tally = entry.values.get(key) ?? {};
    const label = String(value);
    tally[label] = (tally[label] ?? 0) + 1;
    entry.values.set(key, tally);
  }
}

/**
 * Batch legacy diagnostic sites too: no write per token and no arbitrary payloads.
 * A batch keeps each label's count and its metrics summed up across the batch, not
 * just the last call's. It is written every minute, on `flush`/`close`, and when
 * the process shuts down.
 */
export function createBufferedDebugLogger(
  bridge: BridgeName,
  allowedEvents: ReadonlySet<string>,
  /** Read per call, so a setting changed mid-turn applies to the next event. */
  enabled: () => boolean = () => bridgeDebugEnabled(bridge),
  write: BridgeDiagnosticWrite = writeBridgeDiagnostic,
) {
  const entries = new Map<string, BufferedEntry>();
  let dropped = 0;
  let closed = false;
  const flush = () => {
    if (closed || (entries.size === 0 && dropped === 0)) return;
    try {
      const accepted = writeDiagnostic(
        bridge,
        "debug-events",
        {
          dropped,
          events: Array.from(entries.entries()).map(([event, value]) => ({
            event,
            count: value.count,
            metrics: {
              ...Object.fromEntries(value.numbers),
              ...Object.fromEntries(value.values),
            },
          })),
        },
        write,
      );
      if (accepted) {
        entries.clear();
        dropped = 0;
      }
    } catch {
      /* Logging never owns the operation being diagnosed. */
    }
  };
  const timer = setInterval(flush, INTERVAL_MS);
  timer.unref();
  bufferedFlushes.add(flush);
  installShutdownFlush();
  return {
    record(event: unknown, ...args: unknown[]) {
      if (closed || !enabled() || !bridgeDiagnosticsActive()) return;
      if (typeof event !== "string" || event.length > 160 || !allowedEvents.has(event)) {
        dropped++;
        return;
      }
      let entry = entries.get(event);
      if (!entry) {
        if (entries.size >= 16) {
          dropped++;
          return;
        }
        entry = { count: 0, numbers: new Map(), values: new Map() };
        entries.set(event, entry);
      }
      entry.count++;
      // Read only fixed fields, never recurse into an Error, SDK message or config.
      const metrics: Record<string, number | boolean | string> = {};
      for (const arg of args.slice(0, 4)) {
        if (arg && typeof arg === "object" && !(arg instanceof Error)) {
          Object.assign(metrics, safeDiagnosticMetrics(arg as Record<string, unknown>));
        }
      }
      summarize(entry, metrics);
    },
    flush,
    close() {
      flush();
      closed = true;
      bufferedFlushes.delete(flush);
      clearInterval(timer);
      entries.clear();
    },
  };
}
