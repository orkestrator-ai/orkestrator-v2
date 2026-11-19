import { useEffect, useState } from "react";
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentTurnUsage } from "@orkestrator/protocol/native-agent";
import { formatTokenCount } from "@/lib/context-usage";
import {
  assessContinuation,
  formatIdleDuration,
  formatLifetime,
  type ContinuationAssessment,
  type ContinuationCacheState,
} from "@/lib/continuation-assessment";
import { cn } from "@/lib/utils";

/**
 * How often the idle time is re-read. The verdict only changes on a minute
 * scale, and re-reading never refreshes the cache it describes.
 */
const CONTINUATION_CLOCK_INTERVAL_MS = 60_000;

/**
 * The clock ticks only while there is a dated last response to age: with no
 * response, or one still running, nothing on the panel moves with time.
 */
function useContinuationNow(lastResponseAt: string | undefined, fixedNowMs: number | undefined) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (fixedNowMs !== undefined || lastResponseAt === undefined) return;
    const updateClock = () => setNowMs(Date.now());
    updateClock();
    const interval = window.setInterval(updateClock, CONTINUATION_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [lastResponseAt, fixedNowMs]);
  return fixedNowMs ?? nowMs;
}

const CACHE_LABELS: Record<ContinuationCacheState, string> = {
  "likely-warm": "Likely warm",
  "likely-expired": "Likely expired",
  unknown: "Unknown",
};

const CACHE_DOT_CLASSES: Record<ContinuationCacheState, string> = {
  "likely-warm": "bg-emerald-500",
  "likely-expired": "bg-amber-500",
  unknown: "bg-muted-foreground/50",
};

function providerName(provider: AgentPlatform | undefined): string {
  return provider ? AGENT_PLATFORM_LABELS[provider] : "This provider";
}

/** One sentence saying why the cache verdict is what it is. */
export function cacheExplanation(
  assessment: ContinuationAssessment,
  provider: AgentPlatform | undefined,
): string {
  const ago =
    assessment.idleMs !== undefined
      ? `Last response ${formatIdleDuration(assessment.idleMs)} ago`
      : undefined;
  const minimum = assessment.lifetime ? formatLifetime(assessment.lifetime.minimumMs) : "";
  const maximum =
    assessment.lifetime?.maximumMs !== undefined
      ? formatLifetime(assessment.lifetime.maximumMs)
      : "";
  switch (assessment.reason) {
    case "response-running":
      return "A response is running; the cache is judged again once it finishes.";
    case "no-response":
      return "No response has reported usage yet.";
    case "undated-response":
      return `${providerName(provider)} did not date its last response, so its cache age is unknown.`;
    case "clock-mismatch":
      return "The last response's time does not agree with this clock, so its cache age is unknown.";
    case "lifetime-unknown":
      return provider === "opencode" || provider === "pi"
        ? `${ago}. Cache lifetime depends on the model provider and is not reported.`
        : `${ago}. ${providerName(provider)} does not report how long its cache lasts.`;
    case "no-cache-report":
      return `${ago}. It did not report whether it used the cache.`;
    case "no-cache-activity":
      return `${ago}. It recorded no cache reads or writes.`;
    case "within-minimum-lifetime":
      return `${ago}, inside the shortest cache lifetime (${minimum}).`;
    case "past-minimum-lifetime":
      return maximum
        ? `${ago}, past the shortest cache lifetime (${minimum}); still warm only if the session used longer caching (up to ${maximum}).`
        : `${ago}, past the shortest cache lifetime (${minimum}).`;
    case "past-maximum-lifetime":
      return `${ago}, past the longest cache lifetime (${maximum}).`;
  }
}

/** What sending the next message, or compacting first, would do. */
export function continuationExplanation(
  assessment: ContinuationAssessment,
  canCompact: boolean,
): string[] {
  const tokens = assessment.contextTokens;
  if (tokens === undefined) return [];
  const amount = `about ${formatTokenCount(tokens)} tokens`;
  const lines = [
    assessment.cache === "likely-warm"
      ? `Continuing re-sends ${amount}; most should be read from cache.`
      : assessment.cache === "likely-expired"
        ? `Continuing re-sends ${amount}, likely processed again in full without a cache discount.`
        : `Continuing re-sends ${amount}; whether they are read from cache is unknown.`,
  ];
  if (canCompact) {
    lines.push(
      "Compacting first replaces the history with a summary: a smaller request that starts a new cache.",
    );
  }
  return lines;
}

/**
 * The next continuation, explained from the evidence the provider reported:
 * how likely the prompt cache is to be warm, how long ago the last response
 * was, and what continuing or compacting would send. "Unknown" stays unknown
 * whenever the evidence is not there.
 */
export function ContinuationExplanation({
  provider,
  turns,
  contextTokens,
  running,
  canCompact,
  nowMs: fixedNowMs,
}: {
  provider: AgentPlatform | undefined;
  turns: readonly NativeAgentTurnUsage[] | undefined;
  contextTokens: number | undefined;
  running: boolean;
  canCompact: boolean;
  /** Fixed clock for tests; the panel otherwise reads the time itself. */
  nowMs?: number;
}) {
  const lastResponseAt = running ? undefined : turns?.at(-1)?.at;
  const nowMs = useContinuationNow(lastResponseAt, fixedNowMs);
  const assessment = assessContinuation({ provider, turns, contextTokens, running, nowMs });
  const continuation = continuationExplanation(assessment, canCompact);
  return (
    <section aria-label="Next continuation" className="border-t border-border/60 pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Next continuation
        </div>
        {assessment.largeContext ? (
          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
            Large context
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-2 text-sm text-foreground">
        <span
          aria-hidden="true"
          className={cn("h-2 w-2 shrink-0 rounded-full", CACHE_DOT_CLASSES[assessment.cache])}
        />
        <span>
          Cache: <span className="font-medium">{CACHE_LABELS[assessment.cache]}</span>
        </span>
      </div>
      <div className="mt-1 space-y-1 text-xs leading-relaxed text-muted-foreground">
        <p>{cacheExplanation(assessment, provider)}</p>
        {continuation.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p className="text-[10px]">
          Cache read and write totals are history: they do not promise the next request hits the
          cache, especially after a model, account or context change.
        </p>
      </div>
    </section>
  );
}
