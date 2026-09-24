import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { ReadDemand } from "@/lib/read-coordinator";

/**
 * Presentation-read cadence for a mounted native agent session.
 *
 * These are the foreground cadences the session view shipped with before the
 * read coordinator existed; the coordinator migration preserves them exactly.
 */
export const ACTIVE_PROJECTION_REFRESH_MS = 500;
export const IDLE_PROJECTION_REFRESH_MS = 1_500;

/**
 * Trial quiet backoff for idle native views (recurring-processes plan, step
 * 06 task 8). **Gated and disabled**: it may be enabled for a provider only
 * after step 07's interaction/completion event coverage and step 11's
 * missed-event recovery tests pass for that provider, and the per-refresh
 * command/provider request counts have been recorded. Until then a quiet idle
 * view keeps polling at {@link IDLE_PROJECTION_REFRESH_MS}.
 */
export const NATIVE_QUIET_BACKOFF_TRIAL_MS: readonly number[] = [3_000, 5_000, 10_000, 15_000];

/**
 * Providers qualified for quiet backoff. Empty by design: adding a provider
 * here is the single switch that enables {@link NATIVE_QUIET_BACKOFF_TRIAL_MS}
 * for its idle views, and doing so requires the qualification above.
 */
export const NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS: ReadonlySet<AgentPlatform> = new Set();

/** Turn phases that keep the responsive cadence and never back off. */
export function isResponsiveNativeTurnPhase(phase: string | undefined): boolean {
  return (
    phase === "running" || phase === "blocked" || phase === "cancelling" || phase === "recovering"
  );
}

/**
 * Coordinator demand for a native session view. Session state and pending
 * interactions ride on this read, so it is always `critical` for resume.
 */
export function nativeSessionReadDemand(
  platform: AgentPlatform,
  phase: string | undefined,
  options: {
    active: boolean;
    qualifiedProviders?: ReadonlySet<AgentPlatform>;
  },
): Required<ReadDemand> {
  const responsive = isResponsiveNativeTurnPhase(phase);
  const qualified = (options.qualifiedProviders ?? NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS).has(
    platform,
  );
  return {
    active: options.active,
    intervalMs: responsive ? ACTIVE_PROJECTION_REFRESH_MS : IDLE_PROJECTION_REFRESH_MS,
    priority: "critical",
    // Running/blocked/recovering views keep their latency budget regardless.
    quietBackoffMs: !responsive && qualified ? NATIVE_QUIET_BACKOFF_TRIAL_MS : null,
  };
}
