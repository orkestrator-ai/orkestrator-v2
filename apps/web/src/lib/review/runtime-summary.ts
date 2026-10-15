import { formatElapsed } from "@/lib/format-elapsed";
import { formatTokenCount } from "@/lib/context-usage";

/**
 * The two halves of a runtime line, for views that lay them out side by side.
 *
 * `tokens` is the bare count ("12k"); the word is the caller's to add.
 * `tokensPending` marks a live turn whose usage has not been reported yet, which
 * is said rather than shown as zero.
 */
export interface RuntimeParts {
  elapsed: string | null;
  tokens: string | null;
  tokensPending: boolean;
  /** The clock is counting up from `now`, not from a recorded end. */
  live: boolean;
}

/**
 * A turn that never recorded an end is not given one here — an unsettled turn
 * that is no longer running has no honest elapsed time, so only its measured
 * consumption is reported.
 */
export function runtimeParts(
  timing: { startedAt?: string; completedAt?: string; tokenCount?: number },
  running: boolean,
  now: number,
): RuntimeParts | null {
  if (!timing.startedAt) return null;
  const startedAt = Date.parse(timing.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  const tokens = timing.tokenCount === undefined ? null : formatTokenCount(timing.tokenCount);
  const completedAt = timing.completedAt ? Date.parse(timing.completedAt) : Number.NaN;
  const live = running && !Number.isFinite(completedAt);
  if (!live && !Number.isFinite(completedAt)) {
    return tokens ? { elapsed: null, tokens, tokensPending: false, live: false } : null;
  }
  const end = live ? now : completedAt;
  const elapsed = formatElapsed(Math.max(0, Math.floor((end - startedAt) / 1_000)));
  return { elapsed, tokens, tokensPending: live && !tokens, live };
}

/** `{elapsed} · {tokens} tokens`, dropping whichever half is unknown. */
export function formatRuntimeParts(parts: RuntimeParts): string | null {
  const tokens = parts.tokens
    ? `${parts.tokens} tokens`
    : parts.tokensPending
      ? "Tokens pending"
      : null;
  if (!parts.elapsed) return tokens;
  return tokens ? `${parts.elapsed} · ${tokens}` : parts.elapsed;
}

/**
 * The one runtime line Multi Review tiles and build-pipeline review stages share:
 * elapsed time, then what the turn cost.
 */
export function runtimeSummary(
  timing: { startedAt?: string; completedAt?: string; tokenCount?: number },
  running: boolean,
  now: number,
): string | null {
  const parts = runtimeParts(timing, running, now);
  return parts ? formatRuntimeParts(parts) : null;
}
