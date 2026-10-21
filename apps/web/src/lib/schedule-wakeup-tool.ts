/**
 * Structured view of Claude Code's `ScheduleWakeup` tool call (the self-paced
 * `/loop` heartbeat), so a transcript row can show the delay, reason and wake
 * prompt as fields instead of the raw JSON arguments.
 */

/** The prompt Claude passes back for an autonomous `/loop` with no user prompt. */
export const AUTONOMOUS_LOOP_SENTINEL = "<<autonomous-loop-dynamic>>";

const KNOWN_KEYS = new Set(["delaySeconds", "noop", "prompt", "reason", "stop"]);

export interface ScheduleWakeupCall {
  /** The loop was ended rather than rescheduled. */
  stop: boolean;
  delaySeconds?: number;
  /** `true` when the tick changed nothing, `false` when it did; absent when unreported. */
  noop?: boolean;
  reason?: string;
  prompt?: string;
  /** The prompt is the autonomous-loop sentinel, not text a person wrote. */
  autonomous: boolean;
  /** Arguments this view does not model, kept so nothing the call carried is hidden. */
  extra: Array<[string, unknown]>;
}

export interface ScheduleWakeupResult {
  /** Wall-clock time the harness reported, as written (e.g. "21:16:00"). */
  scheduledFor: string;
  /** Seconds until the wakeup fires, after the runtime's clamping. */
  inSeconds?: number;
}

/** Whether a tool name is Claude Code's `ScheduleWakeup`, whatever its spelling. */
export function isScheduleWakeupTool(toolName?: string): boolean {
  if (!toolName) return false;
  return (
    toolName
      .trim()
      .toLowerCase()
      .replace(/[_\-\s]+/g, "") === "schedulewakeup"
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/**
 * The wakeup a `ScheduleWakeup` call carries, or `null` for another tool or
 * arguments that carry nothing this view can show.
 */
export function parseScheduleWakeupArgs(
  toolName?: string,
  toolArgs?: Record<string, unknown>,
): ScheduleWakeupCall | null {
  if (!isScheduleWakeupTool(toolName) || !toolArgs) return null;
  const stop = toolArgs.stop === true;
  const delaySeconds = finiteNumber(toolArgs.delaySeconds);
  const noop = typeof toolArgs.noop === "boolean" ? toolArgs.noop : undefined;
  const reason = nonEmptyString(toolArgs.reason);
  const prompt = nonEmptyString(toolArgs.prompt);
  const extra = Object.entries(toolArgs).filter(
    ([key, value]) => !KNOWN_KEYS.has(key) && value !== undefined && value !== null,
  );
  if (!stop && delaySeconds === undefined && noop === undefined && !reason && !prompt) {
    return null;
  }
  return {
    stop,
    ...(delaySeconds !== undefined ? { delaySeconds } : {}),
    ...(noop !== undefined ? { noop } : {}),
    ...(reason ? { reason } : {}),
    ...(prompt ? { prompt } : {}),
    autonomous: prompt === AUTONOMOUS_LOOP_SENTINEL,
    extra,
  };
}

const SCHEDULED_PATTERN = /scheduled for\s+([^()]+?)\s*(?:\(in\s+(\d+)\s*s\))?[.,]/i;

/** The fire time the harness reported in the tool result, when it reported one. */
export function parseScheduleWakeupResult(toolOutput?: string): ScheduleWakeupResult | null {
  if (!toolOutput) return null;
  const match = SCHEDULED_PATTERN.exec(toolOutput);
  const scheduledFor = match?.[1]?.trim();
  if (!scheduledFor) return null;
  const inSeconds = match?.[2] === undefined ? undefined : Number(match[2]);
  return inSeconds === undefined ? { scheduledFor } : { scheduledFor, inSeconds };
}

/**
 * A wakeup delay in the largest units that describe it, dropping empty ones:
 * "45s", "30m", "1h 5m", "2m 30s".
 */
export function formatWakeupDelay(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts = [
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    secs || total === 0 ? `${secs}s` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

/** The collapsed row's one-line summary of the call. */
export function scheduleWakeupPreview(call: ScheduleWakeupCall): string {
  const head = call.stop
    ? "Loop stopped"
    : call.delaySeconds !== undefined
      ? `in ${formatWakeupDelay(call.delaySeconds)}`
      : undefined;
  return [head, call.reason].filter(Boolean).join(" · ");
}
