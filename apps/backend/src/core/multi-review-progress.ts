/**
 * No-progress detection for the supervised sessions a Multi Review drives.
 *
 * A reviewer that reports `running` forever is indistinguishable from one that
 * is working, and the review pass will not leave the `reviewing` phase while any
 * reviewer is still pending or running. One wedged agent — a Cursor parent
 * holding its turn open for a background child whose transcript stopped moving —
 * therefore halts the whole workflow, including consolidation and the fix stage.
 *
 * The only signal that separates "slow" from "wedged" is whether the session's
 * transcript is still changing. The bridges stream sub-agent activity into the
 * parent transcript, so a genuinely long turn keeps moving even while it waits
 * on a child; a stuck one does not. That makes the transcript fingerprint the
 * right clock, and a wall-clock turn budget the wrong one — the latter would cut
 * off a legitimately long review.
 *
 * The read is expensive (it pulls the session's whole transcript), so it is
 * throttled per session rather than run on every supervisor tick.
 *
 * It reads a tab-facing route, which is a liveness touch. That is deliberate and
 * safe here, unlike in a background reconciler: the supervisor owns these
 * sessions and already reads their status every tick, so they were never
 * candidates for idle detaching or transcript eviction in the first place.
 */
import { transcriptFingerprint } from "./build-pipeline-service-helpers.js";

/** How often one running session's transcript is re-read for progress. */
export const DEFAULT_PROGRESS_PROBE_INTERVAL_MS = 60_000;
/** No transcript change for this long marks the session stalled in the UI. */
export const DEFAULT_STALL_WARNING_MS = 10 * 60_000;
/**
 * No transcript change for this long abandons the session so the rest of the
 * workflow can continue. Deliberately far above the warning: the warning asks a
 * person to look, and this is the backstop for when nobody does.
 */
export const DEFAULT_STALL_ABANDON_MS = 45 * 60_000;

/**
 * One entry per live supervised session. Reviewers and the consolidation
 * session are both bounded by the workflow's reviewer cap, and entries are
 * dropped when a session settles, so this cannot grow with workflow history.
 */
const MAX_TRACKED_SESSIONS = 512;

export interface ProgressObservation {
  /**
   * False when nothing was learned — the probe was throttled, or the read
   * failed. Neither is evidence of a stall, so the caller must not count it.
   */
  probed: boolean;
  /** True when this probe saw the transcript change since the previous one. */
  changed: boolean;
}

const NOT_PROBED: ProgressObservation = { probed: false, changed: false };

/** Without a baseline there is nothing to compare, so nothing has changed. */
function changedFrom(baseline: string | undefined, fingerprint: string): boolean {
  return baseline !== undefined && baseline !== fingerprint;
}

/**
 * Throttled transcript-change detector.
 *
 * Fingerprints are held in memory only. Persisting one would put a transcript
 * tail — prompt and file content — into the workflow store, and the durable half
 * of the clock (`progressAt`) is a timestamp that survives a restart on its own.
 * A restart costs one baseline observation, never a false stall.
 */
/** `fingerprint` is undefined until a read succeeds; there is no baseline yet. */
interface TrackedSession {
  fingerprint: string | undefined;
  probedAt: number;
}

export class MultiReviewProgressTracker {
  private readonly entries = new Map<string, TrackedSession>();

  constructor(
    private readonly probeIntervalMs: number = DEFAULT_PROGRESS_PROBE_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Read the session's transcript at most once per probe interval and report
   * whether it changed. The first observation of a session establishes the
   * baseline and reports no change: an unseen transcript is not evidence of
   * progress, and treating it as progress would restart the stall clock every
   * time the backend restarted.
   *
   * A failed read answers "nothing learned" rather than propagating. The caller
   * runs inside a per-reviewer failure boundary, so a transient transcript read
   * error would otherwise fail a healthy reviewer outright. The attempt is still
   * recorded so a bridge that is refusing reads is retried on the probe interval
   * instead of on every supervisor tick.
   */
  async observe(
    sessionId: string,
    readTranscript: () => Promise<unknown[]>,
  ): Promise<ProgressObservation> {
    const timestamp = this.now();
    const existing = this.entries.get(sessionId);
    if (existing && timestamp - existing.probedAt < this.probeIntervalMs) return NOT_PROBED;
    let messages: unknown[];
    try {
      messages = await readTranscript();
    } catch {
      // Keep whatever baseline there was; a failed read must not become one.
      this.record(sessionId, { fingerprint: existing?.fingerprint, probedAt: this.now() });
      return NOT_PROBED;
    }
    const fingerprint = transcriptFingerprint(messages);
    // Re-read after the await: a concurrent probe for the same session may have
    // recorded a newer entry, and the older read must not overwrite it.
    const current = this.entries.get(sessionId);
    if (current && current.probedAt > timestamp) {
      return { probed: true, changed: changedFrom(current.fingerprint, fingerprint) };
    }
    this.record(sessionId, { fingerprint, probedAt: this.now() });
    return { probed: true, changed: changedFrom(existing?.fingerprint, fingerprint) };
  }

  /** Drop a settled session so its fingerprint cannot outlive the workflow. */
  forget(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  clear(): void {
    this.entries.clear();
  }

  private record(sessionId: string, entry: TrackedSession): void {
    if (!this.entries.has(sessionId) && this.entries.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(sessionId, entry);
  }
}

/**
 * Milliseconds since the session last showed progress, falling back to when it
 * started. Returns null when neither timestamp is usable, which must be read as
 * "no verdict" rather than "stalled".
 */
export function noProgressElapsedMs(
  progressAt: string | undefined,
  startedAt: string | undefined,
  now: number = Date.now(),
): number | null {
  const parsed = [progressAt, startedAt]
    .map((timestamp) => (timestamp ? Date.parse(timestamp) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  return parsed.length > 0 ? now - Math.max(...parsed) : null;
}

export function stalledMinutes(elapsedMs: number): number {
  return Math.max(1, Math.round(elapsedMs / 60_000));
}
