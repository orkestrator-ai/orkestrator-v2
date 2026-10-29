/**
 * The run view header's one-line summary: nodes reached, elapsed time and
 * token usage, each against the run's limit when the template sets one
 * (`limits.maxWallClockMs`, `limits.maxTokens`; enforced by the runtime).
 */
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import { formatTokenCount } from "@/lib/context-usage";
import { formatElapsedWithHours } from "@/lib/format-elapsed";

export function graphRunHeaderSummary(
  run: Pick<GraphRun, "plan" | "usage" | "mock" | "startedAt" | "createdAt" | "finishedAt">,
  options: { reached: number; total: number; now: number },
): string {
  const { maxTokens, maxWallClockMs } = run.plan.limits;
  const startMs = Date.parse(run.startedAt ?? run.createdAt);
  const endMs = run.finishedAt ? Date.parse(run.finishedAt) : options.now;
  let elapsed: string | null = null;
  if (Number.isFinite(startMs)) {
    elapsed = formatElapsedWithHours(Math.max(0, Math.floor((endMs - startMs) / 1_000)));
    if (maxWallClockMs !== undefined) {
      elapsed += ` of ${formatElapsedWithHours(Math.floor(maxWallClockMs / 1_000))}`;
    }
  }
  const tokens = run.usage.tokens;
  // A mock run is never metered: its limit would only mislead.
  const tokenText =
    maxTokens !== undefined && !run.mock
      ? `${formatTokenCount(tokens)} of ${formatTokenCount(maxTokens)} tokens`
      : tokens > 0
        ? `${formatTokenCount(tokens)} tokens`
        : null;
  return [`${options.reached} of ${options.total} nodes`, elapsed, tokenText]
    .filter(Boolean)
    .join(" · ");
}
