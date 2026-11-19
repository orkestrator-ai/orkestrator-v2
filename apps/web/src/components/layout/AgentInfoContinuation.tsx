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
    case "cache-access-time-unknown":
      return `${ago}. The turn reported cache activity, but its freshness is uncertain.`;
    case "model-mismatch":
      return `${ago}. The last response used a different model than the current selection.`;
    case "model-unknown":
      return `${ago}. The last response did not identify its model.`;
    case "context-compacted":
      return "Context was compacted. Waiting for usage from the updated context.";
    case "within-minimum-lifetime":
      return `${ago}. The turn reported cache activity within the shortest lifetime (${minimum}).`;
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
  const lines = [];
  if (tokens !== undefined) {
    lines.push(`Last reported context: about ${formatTokenCount(tokens)} tokens.`);
  }
  if (assessment.reason === "within-minimum-lifetime") {
    lines.push("The cached share of the next request is unknown.");
  }
  if (canCompact && tokens !== undefined) {
    lines.push(
      "Compacting first can reduce retained context. Cache reuse depends on the provider and which parts of the prompt still match.",
    );
  }
  return lines;
}

/**
 * The next continuation, explained from the evidence the provider reported:
 * how likely the prompt cache is to be warm, how long ago the last response
 * was, and how much context the provider reported. "Unknown" stays unknown
 * whenever the evidence is not there.
 */
interface ContinuationExplanationProps {
  provider: AgentPlatform | undefined;
  turns: readonly NativeAgentTurnUsage[] | undefined;
  contextTokens: number | undefined;
  contextCompacted?: boolean;
  selectedModelId?: string;
  resolvedModelId?: string;
  running: boolean;
  canCompact: boolean;
  /** Fixed clock for tests; the panel otherwise reads the time itself. */
  nowMs?: number;
}

export function ContinuationExplanation(props: ContinuationExplanationProps) {
  const lastResponseAt =
    props.running || props.contextCompacted ? undefined : props.turns?.at(-1)?.at;
  return (
    <section aria-label="Next continuation" className="border-t border-border/60 pt-3">
      {/* A newly dated turn needs a fresh clock before its first render. */}
      <ContinuationDetails key={lastResponseAt} {...props} lastResponseAt={lastResponseAt} />
    </section>
  );
}

function ContinuationDetails({
  provider,
  turns,
  contextTokens,
  contextCompacted,
  selectedModelId,
  resolvedModelId,
  running,
  canCompact,
  nowMs: fixedNowMs,
  lastResponseAt,
}: ContinuationExplanationProps & { lastResponseAt: string | undefined }) {
  const nowMs = useContinuationNow(lastResponseAt, fixedNowMs);
  const assessment = assessContinuation({
    provider,
    turns,
    contextTokens,
    contextCompacted,
    selectedModelId,
    resolvedModelId,
    running,
    nowMs,
  });
  const continuation = continuationExplanation(assessment, canCompact);
  return (
    <>
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
    </>
  );
}
