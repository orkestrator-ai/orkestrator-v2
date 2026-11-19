import { randomBytes } from "node:crypto";
import { RESOURCE_CHANGED_EVENT, type ResourceChange } from "@orkestrator/protocol/resource-events";
import {
  REVIEW_TRANSCRIPT_PUSH_PARTS,
  REVIEW_TRANSCRIPT_PUSH_TOPIC,
  parseReviewTranscriptPushKey,
  type PushStamp,
  type ReviewTranscriptPushKey,
  type ReviewTranscriptPushPart,
} from "@orkestrator/protocol/push-events";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { PushHubTimers, PushResolveAnswer, PushTopicProvider } from "./push-hub.js";

const log = createLogger("push");

export { REVIEW_TRANSCRIPT_PUSH_TOPIC };

/**
 * A `transcript` change is published at most this often per key. A reviewer
 * streams many bridge revisions a second; the reviewer tab and the flow
 * graph's inspector are glance views that read a bounded tail, so one read a
 * second (the old poll read every 4 s) keeps them current without a viewer
 * reading on every token. `status` changes are never held back.
 */
export const REVIEW_TRANSCRIPT_MIN_PUBLISH_MS = 1_000;
/**
 * While the reviewer's bridge does not announce transcript revisions (its
 * observe stream is down, or the platform has none, as OpenCode), the topic
 * reads the transcript itself at the old poll's cadence, once for every
 * viewer, and publishes when its source token moved.
 */
export const REVIEW_TRANSCRIPT_PROBE_MS = 4_000;
/** After a failed record read the key is read again after this, doubling. */
export const REVIEW_TRANSCRIPT_ERROR_MS = 2_000;
export const REVIEW_TRANSCRIPT_ERROR_MAX_MS = 30_000;

/**
 * What a key's view shows besides its transcript, from the workflow record.
 * Compared, never sent: a frame carries only the key, the stamp and parts.
 */
export interface ReviewTranscriptTarget {
  environmentId: string;
  agent: string;
  /** The provider session whose transcript the view shows; absent while there is none. */
  providerSessionId?: string;
  /** Whether that session may still write: the reviewer or step is running or pending. */
  live: boolean;
  /** A digest of the record fields the view shows (status, dispatch, report, error, progress). */
  digest: string;
}

export interface ReviewTranscriptPushTopicOptions {
  /** The key's current target from the workflow record; `null` when it no longer exists. */
  readTarget(key: ReviewTranscriptPushKey): Promise<ReviewTranscriptTarget | null>;
  /**
   * Whether the bridge serving the target announces every change of its
   * sessions' transcripts through {@link ReviewTranscriptPushTopic.hint}
   * (an observe stream that is live and carries revisions). Must not throw.
   */
  bridgeAnnounces(target: ReviewTranscriptTarget): boolean;
  /**
   * The fallback: the view's own conditional transcript read, answering the
   * source token it returned (`undefined` when it had none).
   */
  probeTranscript(
    key: ReviewTranscriptPushKey,
    knownSourceToken: string | undefined,
  ): Promise<string | undefined>;
  publish(key: string, stamp: PushStamp, parts: readonly ReviewTranscriptPushPart[]): void;
  timers?: PushHubTimers;
  now?: () => number;
}

interface Observed {
  key: string;
  parsed: ReviewTranscriptPushKey;
  generation: string;
  revision: number;
  /** `undefined` until the first successful read sets the baseline. */
  target: ReviewTranscriptTarget | null | undefined;
  reading: Promise<void> | null;
  readAgain: boolean;
  retryTimer: unknown;
  retryMs: number;
  probeTimer: unknown;
  probing: boolean;
  /** The source token of the last probe; `undefined` until a probe answered. */
  probeToken: string | undefined;
  probed: boolean;
  /** The next probe tick runs at once: the key (or its session) is new. */
  probeSoon: boolean;
  lastTranscriptAt: number;
  transcriptTimer: unknown;
  stopped: boolean;
}

export interface ReviewTranscriptPushTopicMetrics {
  observers: number;
  reads: number;
  readFailures: number;
  hints: number;
  probes: number;
  probeFailures: number;
  changes: number;
}

const defaultTimers: PushHubTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Which parts moved between two targets of one key. */
export function reviewTranscriptChangedParts(
  previous: ReviewTranscriptTarget | null,
  next: ReviewTranscriptTarget | null,
): ReviewTranscriptPushPart[] {
  if (previous === null && next === null) return [];
  if (previous === null || next === null) return [...REVIEW_TRANSCRIPT_PUSH_PARTS];
  // A restarted reviewer shows another session's transcript.
  if (previous.providerSessionId !== next.providerSessionId) {
    return [...REVIEW_TRANSCRIPT_PUSH_PARTS];
  }
  return previous.digest !== next.digest || previous.live !== next.live ? ["status"] : [];
}

/**
 * The `review-transcript` topic: a Multi Review reviewer's transcript, or a
 * preparation, consolidation or Fix step's, for the reviewer tab and the flow
 * graph's inspector.
 *
 * Two signals, so no viewer polls:
 *
 * - **The record.** Every save of the workflow announces a `resource-changed`
 *   for `multi-review`; for a subscribed key that reads its target from
 *   storage (no bridge) and publishes `status` when what the view shows
 *   moved, and `transcript` too when the reviewer was given a new session.
 * - **The transcript.** The Multi Review service's providers report their
 *   bridge's observe-stream hints here ({@link hint}). A hint for the key's
 *   provider session that names its transcript (or names nothing: lost
 *   continuity) publishes `transcript` without reading anything, at most once
 *   a second per key; the viewers then make the conditional read they already
 *   had. While the bridge does not announce revisions (its stream is down, or
 *   OpenCode), a live key is probed with that same conditional read every 4 s,
 *   once for all its viewers, and publishes when the source token moved.
 *
 * Frames never announce completion: the view's read says what the reviewer is.
 */
export class ReviewTranscriptPushTopic implements PushTopicProvider {
  readonly topic = REVIEW_TRANSCRIPT_PUSH_TOPIC;
  /** A decision or a finished reviewer is never held behind the transcript throttle. */
  readonly urgentParts = ["status"] as const;
  private readonly observed = new Map<string, Observed>();
  /** Workflow id → its subscribed keys, so a record save reads only those. */
  private readonly byWorkflow = new Map<string, Set<string>>();
  private readonly timers: PushHubTimers;
  private readonly now: () => number;
  private readonly processGeneration = randomBytes(6).toString("base64url");
  private generationCounter = 0;
  private readonly counters = {
    reads: 0,
    readFailures: 0,
    hints: 0,
    probes: 0,
    probeFailures: 0,
    changes: 0,
  };

  constructor(private readonly options: ReviewTranscriptPushTopicOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? Date.now;
  }

  validKey(key: string): boolean {
    return parseReviewTranscriptPushKey(key) !== null;
  }

  async resolve(key: string): Promise<PushResolveAnswer> {
    if (!parseReviewTranscriptPushKey(key)) return { status: "denied" };
    const entry = this.observed.get(key);
    if (!entry) return { status: "missing" };
    if (entry.target === undefined) await this.refresh(entry);
    if (entry.stopped) return { status: "missing" };
    if (entry.target === undefined) throw new Error("Review transcript target read failed");
    if (entry.target === null) return { status: "missing" };
    return { status: "ok", generation: entry.generation, revision: entry.revision };
  }

  retain(key: string): void {
    const parsed = parseReviewTranscriptPushKey(key);
    if (!parsed || this.observed.has(key)) return;
    this.generationCounter += 1;
    this.observed.set(key, {
      key,
      parsed,
      generation: `${this.processGeneration}.${this.generationCounter}`,
      revision: 0,
      target: undefined,
      reading: null,
      readAgain: false,
      retryTimer: null,
      retryMs: REVIEW_TRANSCRIPT_ERROR_MS,
      probeTimer: null,
      probing: false,
      probeToken: undefined,
      probed: false,
      probeSoon: true,
      lastTranscriptAt: Number.NEGATIVE_INFINITY,
      transcriptTimer: null,
      stopped: false,
    });
    let keys = this.byWorkflow.get(parsed.workflowId);
    if (!keys) {
      keys = new Set();
      this.byWorkflow.set(parsed.workflowId, keys);
    }
    keys.add(key);
  }

  release(key: string): void {
    const entry = this.observed.get(key);
    if (!entry) return;
    entry.stopped = true;
    this.cancel(entry, "retryTimer");
    this.cancel(entry, "probeTimer");
    this.cancel(entry, "transcriptTimer");
    this.observed.delete(key);
    const keys = this.byWorkflow.get(entry.parsed.workflowId);
    keys?.delete(key);
    if (keys?.size === 0) this.byWorkflow.delete(entry.parsed.workflowId);
  }

  /** Every backend event passes through here; only a subscribed workflow's save reads. */
  observeEvent(event: string, payload: unknown): void {
    if (this.observed.size === 0 || event !== RESOURCE_CHANGED_EVENT) return;
    const change = payload as Partial<ResourceChange> | null;
    if (change?.resource !== "multi-review" || typeof change.id !== "string") return;
    const keys = this.byWorkflow.get(change.id);
    if (!keys) return;
    for (const key of Array.from(keys)) {
      const entry = this.observed.get(key);
      if (entry) void this.refresh(entry);
    }
  }

  /**
   * A Multi Review provider's bridge says a session moved (`sessionId`), or
   * that its stream lost continuity (`undefined`). Synchronous and
   * non-throwing: it runs on the observe stream's read loop.
   */
  hint(
    environmentId: string,
    agent: string,
    sessionId: string | undefined,
    parts?: readonly string[],
  ): void {
    if (this.observed.size === 0) return;
    // A state-only revision is not the transcript; the record's save carries status.
    if (parts && !parts.includes("transcript")) return;
    for (const entry of this.observed.values()) {
      const target = entry.target;
      if (!target?.providerSessionId) continue;
      if (target.environmentId !== environmentId || target.agent !== agent) continue;
      if (sessionId !== undefined && target.providerSessionId !== sessionId) continue;
      this.counters.hints += 1;
      this.publishTranscript(entry);
    }
  }

  metrics(): ReviewTranscriptPushTopicMetrics {
    return { observers: this.observed.size, ...this.counters };
  }

  dispose(): void {
    for (const key of Array.from(this.observed.keys())) this.release(key);
  }

  /** One record read at a time per key; a save during it reads once more afterwards. */
  private refresh(entry: Observed): Promise<void> {
    if (entry.reading) {
      entry.readAgain = true;
      return entry.reading;
    }
    const reading = (async () => {
      try {
        do {
          entry.readAgain = false;
          await this.readOnce(entry);
        } while (entry.readAgain && !entry.stopped);
      } finally {
        entry.reading = null;
      }
    })();
    entry.reading = reading;
    return reading;
  }

  private async readOnce(entry: Observed): Promise<void> {
    this.cancel(entry, "retryTimer");
    this.counters.reads += 1;
    let next: ReviewTranscriptTarget | null;
    try {
      next = await this.options.readTarget(entry.parsed);
    } catch (error) {
      this.counters.readFailures += 1;
      log.warn("review-transcript.read-failed", { error: formatLogError(error) });
      this.scheduleRetry(entry);
      return;
    }
    if (entry.stopped) return;
    entry.retryMs = REVIEW_TRANSCRIPT_ERROR_MS;
    const previous = entry.target;
    entry.target = next;
    if (previous !== undefined && previous?.providerSessionId !== next?.providerSessionId) {
      // The probe's token belongs to the replaced session.
      entry.probeToken = undefined;
      entry.probed = false;
      entry.probeSoon = true;
      this.cancel(entry, "probeTimer");
    }
    this.scheduleProbe(entry);
    // The first answer is the baseline: the subscriber reads once on it anyway.
    if (previous === undefined) return;
    const parts = reviewTranscriptChangedParts(previous, next);
    if (parts.length === 0) return;
    if (parts.includes("transcript")) {
      this.cancel(entry, "transcriptTimer");
      entry.lastTranscriptAt = this.now();
    }
    this.emit(entry, parts);
  }

  /** Publish `transcript` now, or once the per-key spacing has passed. */
  private publishTranscript(entry: Observed): void {
    if (entry.stopped || entry.transcriptTimer !== null) return;
    const wait = entry.lastTranscriptAt + REVIEW_TRANSCRIPT_MIN_PUBLISH_MS - this.now();
    if (wait <= 0) {
      entry.lastTranscriptAt = this.now();
      this.emit(entry, ["transcript"]);
      return;
    }
    entry.transcriptTimer = this.timers.setTimeout(() => {
      entry.transcriptTimer = null;
      if (entry.stopped) return;
      entry.lastTranscriptAt = this.now();
      this.emit(entry, ["transcript"]);
    }, wait);
  }

  private emit(entry: Observed, parts: readonly ReviewTranscriptPushPart[]): void {
    entry.revision += 1;
    this.counters.changes += 1;
    try {
      this.options.publish(
        entry.key,
        { generation: entry.generation, revision: entry.revision },
        parts,
      );
    } catch (error) {
      log.warn("review-transcript.publish-failed", { error: formatLogError(error) });
    }
  }

  /**
   * Keep a live key's fallback probe ticking. Each tick asks whether the
   * bridge announces revisions now and reads only when it does not, so a
   * stream that drops later falls back without a new subscription.
   */
  private scheduleProbe(entry: Observed): void {
    const target = entry.target;
    if (entry.stopped || !target?.live || !target.providerSessionId) {
      this.cancel(entry, "probeTimer");
      return;
    }
    if (entry.probeTimer !== null) return;
    // The first probe sets the baseline at once, so a change between the
    // viewer's first read and the next tick is not lost.
    entry.probeTimer = this.timers.setTimeout(
      () => {
        entry.probeTimer = null;
        entry.probeSoon = false;
        void this.probe(entry).finally(() => this.scheduleProbe(entry));
      },
      entry.probeSoon ? 0 : REVIEW_TRANSCRIPT_PROBE_MS,
    );
  }

  private async probe(entry: Observed): Promise<void> {
    const target = entry.target;
    if (entry.stopped || entry.probing || !target?.providerSessionId) return;
    let announces = false;
    try {
      announces = this.options.bridgeAnnounces(target);
    } catch {
      announces = false;
    }
    if (announces) {
      // Hints carry this key now; a later probe starts from a fresh token.
      entry.probed = false;
      entry.probeToken = undefined;
      return;
    }
    entry.probing = true;
    this.counters.probes += 1;
    try {
      const sessionId = target.providerSessionId;
      const token = await this.options.probeTranscript(entry.parsed, entry.probeToken);
      if (entry.stopped || entry.target?.providerSessionId !== sessionId) return;
      const moved = entry.probed && token !== entry.probeToken;
      entry.probeToken = token;
      entry.probed = true;
      if (moved) this.publishTranscript(entry);
    } catch (error) {
      this.counters.probeFailures += 1;
      log.warn("review-transcript.probe-failed", { error: formatLogError(error) });
    } finally {
      entry.probing = false;
    }
  }

  private scheduleRetry(entry: Observed): void {
    if (entry.stopped || entry.retryTimer !== null) return;
    const delay = entry.retryMs;
    entry.retryMs = Math.min(entry.retryMs * 2, REVIEW_TRANSCRIPT_ERROR_MAX_MS);
    entry.retryTimer = this.timers.setTimeout(() => {
      entry.retryTimer = null;
      if (!entry.stopped) void this.refresh(entry);
    }, delay);
  }

  private cancel(entry: Observed, field: "retryTimer" | "probeTimer" | "transcriptTimer"): void {
    if (entry[field] === null) return;
    this.timers.clearTimeout(entry[field]);
    entry[field] = null;
  }
}
