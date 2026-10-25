import type { AgentModel } from "@orkestrator/protocol/native-agent";

/** How long an empty or failed probe suppresses the next one. */
export const PI_CATALOG_EMPTY_PROBE_BACKOFF_MS = 5 * 60_000;

export type PiCatalogProbesOptions = {
  /** Epoch milliseconds; tests pass a controllable clock to cross the backoff. */
  now?: () => number;
};

/**
 * One backend's Pi catalogue probes: the single-flight promises, the
 * empty-result backoff and the probe generation counter. Owned by
 * `LocalServerRuntime` as `piCatalog`; `pi-model-catalog-seeding.ts` runs the
 * probe itself.
 */
export class PiCatalogProbes {
  /** One first-use catalogue probe at a time. */
  private discovery: Promise<AgentModel[]> | null = null;
  /** A user-requested follow-up probe, shared by concurrent manual refreshes. */
  private forcedDiscovery: Promise<AgentModel[]> | null = null;
  /**
   * When the last probe produced no catalogue, as epoch milliseconds.
   *
   * A probe that yields nothing is the expensive case, not the cheap one: it
   * still spawns a bridge and pays the full health budget before answering. Pi
   * fronts the user's own providers, so "no models" is a perfectly ordinary
   * steady state for an installation that has never run `/login` — without
   * this, every launch and every open of the new-environment dialog would
   * repeat that cost and store nothing to show for it.
   */
  private emptyProbeAt: number | null = null;
  /**
   * Distinguishes concurrent probe generations in the ownership registry. Never
   * rewound: a probe that is still terminating must not release its
   * successor's ownership entry.
   */
  private probeSequence = 0;
  private readonly now: () => number;

  constructor(options: PiCatalogProbesOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * The catalogue from `run`, shared by concurrent callers. An automatic call
   * inside the backoff after an empty or failed probe answers `[]` without
   * running; `force` (a manual refresh) clears the backoff and starts a new
   * generation once any automatic probe in flight has settled.
   */
  discover(force: boolean, run: () => Promise<AgentModel[]>): Promise<AgentModel[]> {
    if (force) {
      this.emptyProbeAt = null;
      if (this.forcedDiscovery) return this.forcedDiscovery;
      const preceding = this.discovery;
      const forced = (preceding ? preceding.catch(() => []) : Promise.resolve([]))
        .then(() => {
          // State may have changed while the earlier automatic probe was
          // running; a manual refresh always starts a new generation after it
          // settles.
          this.emptyProbeAt = null;
          return this.tracked(run);
        })
        .finally(() => {
          if (this.forcedDiscovery === forced) this.forcedDiscovery = null;
          if (this.discovery === forced) this.discovery = null;
        });
      this.forcedDiscovery = forced;
      // Ordinary cache-first callers arriving while the forced refresh is
      // queued join it instead of opening a third bridge between the two
      // generations.
      this.discovery = forced;
      return forced;
    }
    if (
      this.emptyProbeAt !== null &&
      this.now() - this.emptyProbeAt < PI_CATALOG_EMPTY_PROBE_BACKOFF_MS
    ) {
      return Promise.resolve([]);
    }
    if (this.discovery) return this.discovery;
    const discovery = this.tracked(run).finally(() => {
      if (this.discovery === discovery) this.discovery = null;
    });
    this.discovery = discovery;
    return discovery;
  }

  /**
   * The ownership key for the next probe's bridge. Never an environment id, so
   * it cannot collide with a real Pi bridge in `peekLocalAgentBridge`.
   */
  nextProbeKey(): string {
    this.probeSequence += 1;
    return `pi:catalog-seed:${this.probeSequence}`;
  }

  private tracked(run: () => Promise<AgentModel[]>): Promise<AgentModel[]> {
    return run().then(
      (models) => {
        if (models.length === 0) this.emptyProbeAt = this.now();
        return models;
      },
      (error: unknown) => {
        // A probe that could not run is as expensive to repeat as one that ran
        // and found nothing, so it arms the same backoff. The error still
        // reaches this caller; only the retries within the window are dropped.
        this.emptyProbeAt = this.now();
        throw error;
      },
    );
  }
}
