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
 * The caller asks for the newest message only. A provider whose transport can
 * fetch a bounded tail does so; the HTTP bridge route has no tail parameter, so
 * its provider trims the response and the read still crosses the wire in full.
 * Either way the probe is throttled per session rather than run on every
 * supervisor tick, and only a fixed-size digest of the tail is retained.
 *
 * It reads a tab-facing route, which is a liveness touch. That is deliberate and
 * safe here, unlike in a background reconciler: the supervisor owns these
 * sessions and already reads their status every tick, so they were never
 * candidates for idle detaching or transcript eviction in the first place.
 */
import { createHash } from "node:crypto";
import { transcriptFingerprint } from "./build-pipeline-service-helpers.js";

/** How often one running session's transcript is re-read for progress. */
export const DEFAULT_PROGRESS_PROBE_INTERVAL_MS = 60_000;
/** A changing tail entry is enough to detect append and streaming rewrites. */
export const PROGRESS_TRANSCRIPT_TAIL_MESSAGES = 1;
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
  /** True when this successful probe created the first comparable baseline. */
  baselineEstablished: boolean;
  /** True when this probe saw the transcript change since the previous one. */
  changed: boolean;
}

const NOT_PROBED: ProgressObservation = {
  probed: false,
  baselineEstablished: false,
  changed: false,
};

/** Without a baseline there is nothing to compare, so nothing has changed. */
function changedFrom(baseline: string | undefined, fingerprint: string): boolean {
  return baseline !== undefined && baseline !== fingerprint;
}

/**
 * Convert the content-bearing shared fingerprint into fixed-size state.
 * Transcript tails may contain megabytes of tool output, prompts, or diffs;
 * none of that content should be retained merely to compare the next probe.
 */
export function progressFingerprint(messages: unknown[]): string {
  return createHash("sha256").update(transcriptFingerprint(messages)).digest("hex");
}

/**
 * Throttled transcript-change detector.
 *
 * Fixed-size fingerprint digests are held in memory only. The durable half of
 * the clock (`progressAt`) is a timestamp in the workflow store. After tracker
 * state is lost, the caller treats the first successful read as a new baseline
 * and persists a fresh grace clock because activity during downtime cannot be
 * compared safely.
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
   * baseline and reports no change. The separate `baselineEstablished` signal
   * lets the caller grant restart grace without claiming that a comparison
   * actually observed progress.
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
    const fingerprint = progressFingerprint(messages);
    // Re-read after the await: a concurrent probe for the same session may have
    // recorded a newer entry, and the older read must not overwrite it.
    const current = this.entries.get(sessionId);
    if (current && current.probedAt > timestamp) {
      return {
        probed: true,
        baselineEstablished: current.fingerprint === undefined,
        changed: changedFrom(current.fingerprint, fingerprint),
      };
    }
    this.record(sessionId, { fingerprint, probedAt: this.now() });
    return {
      probed: true,
      baselineEstablished: existing?.fingerprint === undefined,
      changed: changedFrom(existing?.fingerprint, fingerprint),
    };
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

/**
 * The progress timestamp granted to a session whose in-memory baseline was lost.
 *
 * The first read after a restart cannot be compared against activity made while
 * the process was down, so the newly observed state is given grace rather than
 * being judged against an unknowably old digest. The grace is bounded to one
 * warning interval and never moves an existing clock forward past that floor: a
 * session that was already wedged for hours keeps everything beyond the floor,
 * so restarting the backend cannot postpone the abandon backstop indefinitely.
 *
 * A session with no durable clock yet has nothing to bound and starts from now;
 * `noProgressElapsedMs` still falls back to `startedAt`, which is the later of
 * the two for a session that has only just begun.
 */
export function baselineProgressAt(
  progressAt: string | undefined,
  stallWarningMs: number,
  now: number = Date.now(),
): string {
  const existing = progressAt ? Date.parse(progressAt) : Number.NaN;
  if (!Number.isFinite(existing)) return new Date(now).toISOString();
  return new Date(Math.max(existing, now - Math.max(0, stallWarningMs))).toISOString();
}
