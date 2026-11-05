import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentDiscoveryView } from "@orkestrator/protocol/native-agent";
import {
  NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PLATFORMS,
  NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS,
} from "@orkestrator/protocol/native-agent-observation";
import { DATA_SAVING_ACTIVE_PROJECTION_REFRESH_MS } from "@/lib/data-saving-policy";
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
 * every view), and an idle view of the provider cannot change without such an
 * announcement.
 *
 * Backoff additionally requires the connected backend to advertise those
 * announcements (`observationEvents`); an older backend keeps the baseline.
 */
export const NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS: ReadonlySet<AgentPlatform> = new Set(
  NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS,
);

/**
 * Claude and Codex change an idle view without a transition (background task
 * output, async questions). They back off only while the backend marks the
 * session `turn.quietObservation`, meaning it announces those content changes
 * too; otherwise they keep {@link IDLE_PROJECTION_REFRESH_MS}.
 */
export const NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PROVIDERS: ReadonlySet<AgentPlatform> = new Set(
  NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PLATFORMS,
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
    /** The session's `turn.quietObservation`: content changes are announced too. */
    quietObservation?: boolean;
  },
): Required<ReadDemand> {
  const responsive = isResponsiveNativeTurnPhase(phase);
  const qualified =
    options.observationEvents === true &&
    (options.qualifiedProviders ?? NATIVE_QUIET_BACKOFF_QUALIFIED_PROVIDERS).has(platform) &&
    (!NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PROVIDERS.has(platform) ||
      options.quietObservation === true);
  return {
    active: options.active,
    intervalMs: responsive ? ACTIVE_PROJECTION_REFRESH_MS : IDLE_PROJECTION_REFRESH_MS,
    priority: "critical",
    // Running/blocked/recovering views keep their latency budget regardless.
    quietBackoffMs: !responsive && qualified ? NATIVE_QUIET_BACKOFF_TRIAL_MS : null,
    // Data saving slows only the responsive backstop; idle views keep theirs.
    dataSaving: responsive ? { intervalMs: DATA_SAVING_ACTIVE_PROJECTION_REFRESH_MS } : null,
  };
}

/**
 * The most a settled view goes without a discovery read. It covers a missed
 * announcement, and it is what makes the backend look again: a section is only
 * refreshed when a read finds it expired (30 s), so with no read nothing would
 * ever be announced.
 */
export const DISCOVERY_BACKSTOP_MS = 30_000;
/** A section still loading or refreshing: the backend settles those within 2 s. */
const DISCOVERY_SETTLING_READ_MS = 2_000;
/** A section with no value: the backend retries one 5 s after it failed. */
const DISCOVERY_UNAVAILABLE_READ_MS = 5_000;

/** How soon a held discovery view wants another look, if it is not settled. */
function discoveryFollowUpMs(view: NativeAgentDiscoveryView): number | null {
  const availabilities = Object.values(view.sections).map((section) => section.availability);
  if (availabilities.includes("loading") || availabilities.includes("stale")) {
    return DISCOVERY_SETTLING_READ_MS;
  }
  return availabilities.includes("unavailable") ? DISCOVERY_UNAVAILABLE_READ_MS : null;
}

/**
 * When a mounted view's background round includes a discovery read. Discovery
 * changes far less often than transcript and state, so it leaves the fast round
 * and is read when something says it may have moved:
 *
 * - {@link markDue}: mount, a session or identity change, a resync, a resume or
 *   reconnect, an invalidation that names discovery, and any read that failed or
 *   was discarded;
 * - a change of turn phase;
 * - a section not settled yet, soon enough to see it settle;
 * - otherwise every {@link DISCOVERY_BACKSTOP_MS}, reusing the view's token.
 *
 * Explicit reads always include discovery (`claimExplicit`).
 */
export class NativeDiscoveryReadSchedule {
  private due = true;
  private lastReadAt = Number.NEGATIVE_INFINITY;
  private phase: string | undefined;
  private followUpMs: number | null = null;

  markDue(): void {
    this.due = true;
  }

  /** A background round asks; `true` means it must send the read. */
  claim(now: number, phase: string | undefined): boolean {
    const elapsed = now - this.lastReadAt;
    // Learning the phase for the first time is not a change: the read that
    // mounted the view is what taught it.
    const phaseChanged = this.phase !== undefined && phase !== undefined && phase !== this.phase;
    const read =
      this.due ||
      phaseChanged ||
      elapsed >= DISCOVERY_BACKSTOP_MS ||
      (this.followUpMs !== null && elapsed >= this.followUpMs);
    if (phase !== undefined) this.phase = phase;
    if (!read) return false;
    this.due = false;
    this.lastReadAt = now;
    return true;
  }

  claimExplicit(now: number, phase: string | undefined): void {
    if (phase !== undefined) this.phase = phase;
    this.due = false;
    this.lastReadAt = now;
  }

  /** The view this schedule's reads now hold, whichever status delivered it. */
  observe(view: NativeAgentDiscoveryView | undefined): void {
    this.followUpMs = view ? discoveryFollowUpMs(view) : null;
  }
}
