import { formatElapsed } from "@/lib/format-elapsed";
import { parseBackendTurnStartedAt } from "@/lib/session-timer";
import type { NativeAgentStatus } from "./native-agent-status";

/**
 * Format a settled agent runtime. Sub-second values stay in milliseconds so a
 * genuinely short child is distinguishable from a still-running one.
 */
export function formatAgentDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  return formatElapsed(Math.round(seconds));
}

/**
 * Elapsed runtime for an agent card, from backend clocks only.
 *
 * Active agents tick from the launch timestamp the backend stamped on the
 * spawn part. Vendor spawn-echo `durationMs` is ignored while running — that
 * is launch wall-clock, not child runtime. Settled agents show the
 * backend-stamped duration; a missing duration is not invented.
 */
export function nativeAgentElapsedMs(options: {
  status: NativeAgentStatus;
  startedAt?: string;
  durationMs?: number;
  now?: number;
}): number | undefined {
  const { status, startedAt, durationMs, now = Date.now() } = options;
  if (status === "active") {
    const startedAtMs = parseBackendTurnStartedAt(startedAt);
    if (startedAtMs === undefined) return undefined;
    return Math.max(0, now - startedAtMs);
  }
  return durationMs;
}

/**
 * Live cards use whole seconds so the value can tick without a millisecond
 * flash. Settled cards keep the more precise duration the backend stored.
 */
export function formatNativeAgentElapsed(options: {
  status: NativeAgentStatus;
  elapsedMs?: number;
}): string | undefined {
  const { status, elapsedMs } = options;
  if (elapsedMs === undefined) return undefined;
  if (status === "active") {
    return formatElapsed(Math.floor(elapsedMs / 1000));
  }
  return formatAgentDurationMs(elapsedMs);
}
