import type { DockerAvailability } from "@orkestrator/protocol/docker-availability";

/**
 * How long one Docker availability answer serves node summary reads. A
 * command node re-reads every project of this machine at once (and every
 * `SUMMARY_RECONCILE_MS`), so without it each read would run `docker info`.
 */
export const DOCKER_AVAILABILITY_CACHE_MS = 30_000;

/**
 * How long a summary read waits for a probe before answering with the last
 * known value (or none). `docker info` can take its full 10 s timeout when the
 * daemon hangs, and a summary read must not.
 */
export const DOCKER_AVAILABILITY_SUMMARY_WAIT_MS = 1_500;

export interface DockerAvailabilityCacheOptions {
  /** The `check_docker` probe. Absent in fixtures: only recorded answers are known. */
  probe?: () => Promise<DockerAvailability>;
  now?: () => number;
  ttlMs?: number;
  waitMs?: number;
}

/**
 * This machine's last Docker availability answer, for the node summaries a
 * command node reads (`get_environment_snapshots` with
 * `NODE_SUMMARY_ENVIRONMENT_READ_ARGS`), so another machine's rows gate
 * container actions as this machine's own rows do. Owned by `BackendRuntime`
 * as `dockerAvailability`; every `check_docker` answer is recorded here too.
 */
export class DockerAvailabilityCache {
  private last: { available: boolean; at: number } | null = null;
  private probing: Promise<void> | null = null;

  constructor(private readonly options: DockerAvailabilityCacheOptions = {}) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  record(result: DockerAvailability): void {
    this.last = { available: result.available, at: this.now() };
  }

  /**
   * A fresh answer when there is one; otherwise one probe (shared by
   * concurrent readers) bounded by the summary wait, falling back to the last
   * known answer. `undefined` means unknown: the field is left out.
   */
  async forSummary(): Promise<boolean | undefined> {
    const last = this.last;
    if (last && this.now() - last.at < (this.options.ttlMs ?? DOCKER_AVAILABILITY_CACHE_MS)) {
      return last.available;
    }
    const probe = this.options.probe;
    if (!probe) return last?.available;
    this.probing ??= probe()
      .then((result) => this.record(result))
      // A failed probe leaves the last answer in place; the next read retries.
      .catch(() => undefined)
      .finally(() => {
        this.probing = null;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.probing,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.waitMs ?? DOCKER_AVAILABILITY_SUMMARY_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    return this.last?.available;
  }
}
