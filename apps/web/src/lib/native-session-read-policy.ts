import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS } from "@orkestrator/protocol/native-agent-observation";
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
 * 06 task 8; qualified per provider in step 07). A qualified provider's idle,
 * unchanged view slows through these intervals; any invalidation, a phase
 * change or a visible-document reconcile returns it to
 * {@link IDLE_PROJECTION_REFRESH_MS} immediately.
 */
export const NATIVE_QUIET_BACKOFF_TRIAL_MS: readonly number[] = [3_000, 5_000, 10_000, 15_000];

/**
 * Providers qualified for quiet backoff — the protocol's single list, shared
 * with the backend's observation capability matrix. Qualification (step 07):
 * the backend announces every activity transition of the provider with a
 * stamped, session-scoped invalidation (`native-observation-events.ts` turns
 * those into coordinator invalidations, and a revision gap into a re-read of
 * every view), and an idle view of the provider cannot change without such a
 * transition. Claude and Codex are not qualified: background task output and
 * async questions change an idle view without one.
 *
 * Backoff additionally requires the connected backend to advertise those
 * announcements (`observationEvents`); an older backend keeps the baseline.
 */
export const NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS: ReadonlySet<AgentPlatform> = new Set(
  NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS,
);

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
    /** The backend announces stamped, session-scoped activity invalidations. */
    observationEvents?: boolean;
  },
): Required<ReadDemand> {
  const responsive = isResponsiveNativeTurnPhase(phase);
  const qualified =
    options.observationEvents === true &&
    (options.qualifiedProviders ?? NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS).has(platform);
  return {
    active: options.active,
    intervalMs: responsive ? ACTIVE_PROJECTION_REFRESH_MS : IDLE_PROJECTION_REFRESH_MS,
    priority: "critical",
    // Running/blocked/recovering views keep their latency budget regardless.
    quietBackoffMs: !responsive && qualified ? NATIVE_QUIET_BACKOFF_TRIAL_MS : null,
  };
}
