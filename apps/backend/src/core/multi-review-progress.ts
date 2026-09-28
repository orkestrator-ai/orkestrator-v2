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
 * The caller supplies a sample: normally a bounded, conditional one-message
 * snapshot (`transcript-progress.ts`), which an unchanged session answers
 * without any transcript body; a provider without that surface falls back to
 * its newest message. Either way the probe is throttled per session rather
 * than run on every supervisor tick, and only a fixed-size digest of the tail
 * plus the provider's opaque source token is retained.
 *
 * The digest is also persisted on the workflow. After a restart the in-memory
 * map is empty, but the next successful probe compares against that durable
 * digest instead of treating the session as never-before-seen. A digest taken
 * in another comparison base (an older digest format, another history epoch or
 * bridge generation) is replaced without being reported as progress. A failed
 * or throttled probe reports that nothing was learned about the fingerprint;
 * the caller still evaluates the durable stall clock (`progressAt` /
 * `startedAt`) because a wedged session whose transcript cannot be read is
 * still wedged.
 *
 * It reads a tab-facing route, which is a liveness touch. That is deliberate and
 * safe here, unlike in a background reconciler: the supervisor owns these
 * sessions and already reads their status every tick, so they were never
 * candidates for idle detaching or transcript eviction in the first place.
 */
import {
  compareProgressDigests,
  legacyProgressDigest,
  type KnownProgressSource,
  type ProgressSample,
} from "./transcript-progress.js";

export { PROGRESS_TRANSCRIPT_TAIL_MESSAGES } from "./transcript-progress.js";

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
   * failed. Neither is evidence of a stall or of progress, so the caller must
   * not treat it as a fingerprint comparison. The durable stall clock still
   * ticks; a failed read is not a reason to pause it.
   */
  probed: boolean;
  /** True when this successful probe created the first comparable baseline. */
  baselineEstablished: boolean;
  /** True when this probe saw the transcript change since the previous one. */
  changed: boolean;
  /** Present on a successful probe so the caller can persist the digest. */
  digest?: string;
  /**
   * True when the previous digest belonged to another comparison base (older
   * format, history epoch or generation) and this probe replaced it. Neither
   * progress nor a first baseline: the durable stall clock simply continues.
   */
  rebased?: boolean;
}

const NOT_PROBED: ProgressObservation = {
  probed: false,
  baselineEstablished: false,
  changed: false,
};

/** Classify a successful probe against its comparison base. */
function comparedObservation(baseline: string | undefined, digest: string): ProgressObservation {
  const comparison = compareProgressDigests(baseline, digest);
  return {
    probed: true,
    baselineEstablished: comparison === "baseline",
    changed: comparison === "changed",
    digest,
    ...(comparison === "rebased" ? { rebased: true } : {}),
  };
}

/**
 * Fixed-size digest of a `messages()` tail in the original format. Digests of
 * this key are already persisted as progress baselines, so providers without
 * a snapshot surface stay comparable across the upgrade.
 */
export function progressFingerprint(messages: unknown[]): string {
  return legacyProgressDigest(messages);
}

/**
 * Throttled transcript-change detector.
 *
 * Fixed-size fingerprint digests are held in memory and, separately, on the
 * workflow. After tracker state is lost, the caller passes the persisted digest
 * so the first successful read is a comparison rather than a new baseline.
 * Each entry also keeps the provider source token of the sample that produced
 * its digest, so the next probe can be answered `unchanged` without a body.
 */
/** `fingerprint` is undefined until a read succeeds; there is no baseline yet. */
interface TrackedSession {
  fingerprint: string | undefined;
  /** Provider token of the sample that produced `fingerprint`, never another. */
  sourceToken?: string;
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
   * whether it changed. The first observation of a session with no in-memory
   * and no persisted digest establishes the baseline and reports no change.
   *
   * A failed read answers "nothing learned" rather than propagating. The caller
   * runs inside a per-reviewer failure boundary, so a transient transcript read
   * error would otherwise fail a healthy reviewer outright. The attempt is still
   * recorded so a bridge that is refusing reads is retried on the probe interval
   * instead of on every supervisor tick.
   *
   * `readTranscript` receives the source of the previous successful sample,
   * for a conditional read, and answers a progress sample — or, under the
   * original contract, the transcript tail to digest.
   */
  async observe(
    sessionId: string,
    readTranscript: (known: KnownProgressSource | undefined) => Promise<unknown[] | ProgressSample>,
    persistedDigest?: string,
  ): Promise<ProgressObservation> {
    const timestamp = this.now();
    const existing = this.entries.get(sessionId);
    if (existing && timestamp - existing.probedAt < this.probeIntervalMs) return NOT_PROBED;
    const known =
      existing?.fingerprint !== undefined && existing.sourceToken !== undefined
        ? { sourceToken: existing.sourceToken, digest: existing.fingerprint }
        : undefined;
    let sample: ProgressSample;
    try {
      const read = await readTranscript(known);
      sample = Array.isArray(read) ? { digest: progressFingerprint(read) } : read;
    } catch {
      // Keep whatever baseline (and its token) there was; a failed read must
      // not become one.
      this.record(sessionId, {
        fingerprint: existing?.fingerprint,
        ...(existing?.sourceToken === undefined ? {} : { sourceToken: existing.sourceToken }),
        probedAt: this.now(),
      });
      return NOT_PROBED;
    }
    const fingerprint = sample.digest;
    const priorFingerprint = existing?.fingerprint ?? persistedDigest;
    // Re-read after the await: a concurrent probe for the same session may have
    // recorded a newer entry, and the older read must not overwrite it.
    const current = this.entries.get(sessionId);
    if (current && current.probedAt > timestamp) {
      return comparedObservation(current.fingerprint ?? persistedDigest, fingerprint);
    }
    this.record(sessionId, {
      fingerprint,
      ...(sample.sourceToken === undefined ? {} : { sourceToken: sample.sourceToken }),
      probedAt: this.now(),
    });
    return comparedObservation(priorFingerprint, fingerprint);
  }

  /**
   * Epoch milliseconds at which the next probe of this session is allowed.
   * `0` for a session never probed by this process, which is due immediately.
   * Lets a caller skip transcript-dependent work — and a scheduler sleep —
   * until the probe can actually run, instead of asking every tick.
   */
  nextProbeAt(sessionId: string): number {
    const existing = this.entries.get(sessionId);
    return existing ? existing.probedAt + this.probeIntervalMs : 0;
  }

  /** True when {@link observe} would read the transcript right now. */
  isProbeDue(sessionId: string): boolean {
    return this.now() >= this.nextProbeAt(sessionId);
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
