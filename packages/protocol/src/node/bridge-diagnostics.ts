import { createHash } from "node:crypto";

const INTERVAL_MS = 60_000;
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
  | "sending"
  | "following"
  | "draining"
  | "send-failed"
  | "finished"
  | "attached"
  | "cancelling";
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

/** Provider-controlled identifiers are hashed, never printed or retained verbatim. */
function identity(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > MAX_ID_LENGTH) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function readBridgeDebugFlag(value: string | undefined): boolean {
  return value?.trim() === "1";
}

/** A common flag takes precedence over legacy per-bridge overrides, including explicit off. */
export function bridgeDebugEnabled(
  bridge: BridgeName,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.ORKESTRATOR_BRIDGE_DEBUG ?? env[`${bridge.toUpperCase()}_BRIDGE_DEBUG`];
  return readBridgeDebugFlag(value);
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

/** Bound every serialized diagnostic; sink errors never affect execution. */
const MAX_ENTRY_BYTES = 8192;
function writeDiagnostic(
  bridge: BridgeName,
  payload: Record<string, unknown>,
  write: (line: string) => void,
): void {
  try {
    let json = JSON.stringify({ bridge, ...payload });
    if (Buffer.byteLength(json) > MAX_ENTRY_BYTES)
      json = JSON.stringify({
        bridge,
        event: "snapshot-overflow",
        omittedBytes: Buffer.byteLength(json),
      });
    write(`[bridge-diagnostics] ${json}`);
  } catch {
    /* Diagnostic failures cannot affect execution. */
  }
}

/**
 * Metadata only. SDK callbacks update bounded counters; the timer writes one
 * snapshot per minute off the producer path. No raw SDK logger is enabled:
 * its errors, arguments and payloads can contain credentials or user content.
 * Lifetime belongs to the backend turn, including while the UI is unmounted.
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
  private terminal: Outcome = "pending";
  private stream: Outcome = "pending";
  private cancellation: "none" | Outcome = "none";
  private cancelReason?: CancellationReason;
  private run?: string;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly bridge: BridgeName,
    private readonly state: DiagnosticState,
    private readonly now: () => number = Date.now,
    private readonly write: (line: string) => void = (line) => console.info(line),
    private readonly intervalMs = INTERVAL_MS,
    private readonly metrics: () => Record<string, unknown> = () => ({}),
  ) {
    this.startedAt = this.lastTick = now();
    this.timer = setInterval(() => this.report("heartbeat"), intervalMs);
    this.timer.unref();
    this.report("send-started");
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
      this.pending.delete(key);
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
  }

  checkpoint(phase: Phase): void {
    this.phase = phase;
  }
  count(key: Counter, amount = 1): void {
    if (!this.closed && Number.isSafeInteger(amount) && amount >= 0) this.counters[key] += amount;
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
    if (outcome === "resolved") this.phase = "draining";
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
    const age = (time: number | undefined) => (time === undefined ? null : Math.max(0, now - time));
    const tickDelayMs =
      event === "heartbeat" ? Math.max(0, now - this.lastTick - this.intervalMs) : 0;
    if (event === "heartbeat") this.lastTick = now;
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
      writeDiagnostic(
        this.bridge,
        {
          event,
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
    } catch {
      // A diagnostic sink must never fail an agent turn.
    }
  }

  close(phase: "send-failed" | "finished" = "finished"): void {
    if (this.closed) return;
    this.phase = phase;
    this.report("closed");
    this.closed = true;
    clearInterval(this.timer);
    this.pending.clear();
  }
}

export function createBridgeDiagnostics(
  bridge: BridgeName,
  state: DiagnosticState,
  metrics?: () => Record<string, unknown>,
): BridgeRunDiagnostics | undefined {
  return bridgeDebugEnabled(bridge)
    ? new BridgeRunDiagnostics(bridge, state, undefined, undefined, undefined, metrics)
    : undefined;
}

/** Batch legacy diagnostic sites too: no write per token and no arbitrary payloads. */
export function createBufferedDebugLogger(
  bridge: BridgeName,
  allowedEvents: ReadonlySet<string>,
  enabled = bridgeDebugEnabled(bridge),
  write: (line: string) => void = (line) => console.info(line),
) {
  const entries = new Map<
    string,
    { count: number; metrics: Record<string, number | boolean | string> }
  >();
  let dropped = 0;
  let closed = false;
  const flush = () => {
    if (!enabled || closed || (entries.size === 0 && dropped === 0)) return;
    try {
      writeDiagnostic(
        bridge,
        {
          event: "debug-events",
          dropped,
          events: Array.from(entries.entries()).map(([event, value]) => ({ event, ...value })),
        },
        write,
      );
    } catch {
      /* Logging never owns the operation being diagnosed. */
    }
    entries.clear();
    dropped = 0;
  };
  const timer = enabled ? setInterval(flush, INTERVAL_MS) : undefined;
  timer?.unref();
  return {
    record(event: unknown, ...args: unknown[]) {
      if (!enabled || closed) return;
      if (typeof event !== "string" || event.length > 160 || !allowedEvents.has(event)) {
        dropped++;
        return;
      }
      const previous = entries.get(event);
      if (!previous && entries.size >= 16) {
        dropped++;
        return;
      }
      // Read only fixed fields, never recurse into an Error, SDK message or config.
      const metrics: Record<string, number | boolean | string> = {};
      for (const arg of args.slice(0, 4)) {
        if (arg && typeof arg === "object" && !(arg instanceof Error)) {
          Object.assign(metrics, safeDiagnosticMetrics(arg as Record<string, unknown>));
        }
      }
      entries.set(event, { count: (previous?.count ?? 0) + 1, metrics });
    },
    flush,
    close() {
      flush();
      closed = true;
      if (timer) clearInterval(timer);
      entries.clear();
    },
  };
}
