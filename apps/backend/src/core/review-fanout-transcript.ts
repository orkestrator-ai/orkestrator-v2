/**
 * One reviewer's transcript, read at most once per shape per supervisor pass.
 *
 * Several consumers look at a running reviewer's transcript: the progress probe
 * (one-message tail, throttled to once a minute), usage metering for providers
 * that derive usage from messages, and an owner that mirrors the transcript
 * into its own read model. Before this reader existed the runner started one
 * eager `provider.messages()` request per pass and handed the promise to the
 * throttled probe — which could decline to compare, but could not undo the
 * request. Here nothing is requested until a consumer actually asks.
 *
 * Reads are memoized by shape. A request for a bounded tail may reuse an
 * in-flight or completed read that is at least as large (a full read, or a
 * larger tail), sliced locally. The reverse never happens: a one-message tail
 * is never handed to a consumer that asked for more.
 *
 * The reader lives for one reviewer advance and is then dropped, so transcript
 * content is never retained beyond the pass.
 */
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import {
  recordEfficiency,
  type EfficiencyOwner,
  type MultiReviewEfficiencyObserver,
} from "./multi-review-efficiency.js";

/** Shape key: a positive message limit, or `undefined` for the whole transcript. */
type ReadLimit = number | undefined;

interface ReadEntry {
  limit: ReadLimit;
  promise: Promise<unknown[]>;
}

function covers(existing: ReadLimit, requested: ReadLimit): boolean {
  if (existing === undefined) return true;
  if (requested === undefined) return false;
  return existing >= requested;
}

export class PassTranscriptReader {
  private readonly reads: ReadEntry[] = [];

  constructor(
    private readonly provider: Pick<BuildPipelineProvider, "messages" | "agent">,
    private readonly sessionId: string,
    private readonly measurement: {
      observer?: MultiReviewEfficiencyObserver;
      owner: EfficiencyOwner;
    } = { owner: "multi-review" },
  ) {}

  /** True when some read has already been started this pass. */
  get started(): boolean {
    return this.reads.length > 0;
  }

  /**
   * An already-started read that can answer `limit`, without starting one.
   * Lets an optional consumer piggyback on a read another consumer paid for.
   */
  peek(limit: ReadLimit): Promise<unknown[]> | undefined {
    const reusable = this.reads.find((entry) => covers(entry.limit, limit));
    return reusable ? this.slice(reusable.promise, limit) : undefined;
  }

  /** Returns the transcript (or its tail), reading the provider at most once per shape. */
  read(limit: ReadLimit): Promise<unknown[]> {
    const reused = this.peek(limit);
    if (reused) {
      recordEfficiency(this.measurement.observer, {
        owner: this.measurement.owner,
        operation: "transcript.pass_local_reuse",
        phase: "reviewing",
      });
      return reused;
    }
    recordEfficiency(this.measurement.observer, {
      owner: this.measurement.owner,
      operation: "transcript.provider_read_started",
      phase: "reviewing",
      platform: this.provider.agent as never,
    });
    const promise = this.provider.messages(this.sessionId, limit === undefined ? {} : { limit });
    // Callers attach their own handlers; this one only records the failure and
    // keeps an unobserved rejection from escaping as an unhandled rejection.
    promise.catch(() => {
      recordEfficiency(this.measurement.observer, {
        owner: this.measurement.owner,
        operation: "transcript.provider_read_failed",
        phase: "reviewing",
      });
    });
    this.reads.push({ limit, promise });
    return promise;
  }

  private async slice(promise: Promise<unknown[]>, limit: ReadLimit): Promise<unknown[]> {
    const messages = await promise;
    return limit === undefined || messages.length <= limit ? messages : messages.slice(-limit);
  }
}
