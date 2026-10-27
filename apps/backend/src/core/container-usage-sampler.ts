import type { ContainerUsageSnapshot } from "@orkestrator/protocol/container-resources";

/** A visible surface treats older samples as stale. */
const USAGE_STALE_MS = 15_000;
/** Callers within this window share one sample. */
const USAGE_MIN_INTERVAL_MS = 5_000;

/**
 * The container usage sample of one backend (`sampleContainerUsage`). It lists
 * only this backend's owner-labelled containers and carries its OOM counts,
 * so it is per backend rather than host-wide. Owned by `BackendRuntime` as
 * `containerUsage`.
 */
export class ContainerUsageSampler {
  private cache: { at: number; value: ContainerUsageSnapshot } | null = null;
  private inflight: Promise<ContainerUsageSnapshot> | null = null;

  /**
   * One sample shared by every caller within the minimum interval; concurrent
   * callers wait on the same subprocesses. Staleness is computed on read.
   */
  async sample(sampleNow: () => Promise<ContainerUsageSnapshot>): Promise<ContainerUsageSnapshot> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < USAGE_MIN_INTERVAL_MS) {
      return { ...this.cache.value, stale: now - this.cache.at > USAGE_STALE_MS };
    }
    if (!this.inflight) {
      this.inflight = sampleNow()
        .then((value) => {
          if (value.sampledAt) this.cache = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    const value = await this.inflight;
    if (value.sampledAt) return value;
    // Docker unavailable: the last good sample, marked stale, beats nothing.
    return this.cache ? { ...this.cache.value, stale: true, error: value.error } : value;
  }
}
