import { formatElapsed } from "@/lib/format-elapsed";
import { formatTokenCount } from "@/lib/context-usage";

/**
 * The one runtime line Multi Review tiles and build-pipeline review stages share:
 * elapsed time, then what the turn cost.
 *
 * A turn that never recorded an end is not given one here — an unsettled turn
 * that is no longer running has no honest elapsed time, so only its measured
 * consumption is reported.
 */
export function runtimeSummary(
  timing: { startedAt?: string; completedAt?: string; tokenCount?: number },
  running: boolean,
  now: number,
): string | null {
  if (!timing.startedAt) return null;
  const startedAt = Date.parse(timing.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  const tokens =
    timing.tokenCount === undefined ? null : `${formatTokenCount(timing.tokenCount)} tokens`;
  const completedAt = timing.completedAt ? Date.parse(timing.completedAt) : Number.NaN;
  const activelyRunning = running && !Number.isFinite(completedAt);
  if (!activelyRunning && !Number.isFinite(completedAt)) return tokens;
  const end = activelyRunning ? now : completedAt;
  const elapsed = formatElapsed(Math.max(0, Math.floor((end - startedAt) / 1_000)));
  if (!tokens) return activelyRunning ? `${elapsed} · Tokens pending` : elapsed;
  return `${elapsed} · ${tokens}`;
}
