import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("models");

/**
 * How long a failed seed suppresses the next one: 15 minutes.
 *
 * A signed-out host, or a platform whose CLI answers with an empty list (Grok
 * on a host where it is enabled but unusable), fails every time, and each
 * attempt spawns a whole bridge and its CLI. Every renderer start asks for a
 * seed in the background (`startApp`), and before plan items 6002 and 6003
 * retired workspace realms a window also rebooted an evicted realm whenever
 * the user went back to that node, so a 30-second cooldown let almost every
 * cold open pay for a doomed download (2026-11-06: every `download.deferred`
 * line for Grok sat at a realm open). Fifteen minutes caps a broken platform
 * at four attempts an hour while still retrying on its own within one working
 * session. Nothing waits on it: the renderer draws from the cached catalogues
 * first. A completed sign-in clears it (`resetCooldown`), and Settings'
 * Refresh downloads directly without consulting it.
 */
export const HOST_CATALOG_SEED_FAILURE_COOLDOWN_MS = 15 * 60_000;

/** One seed attempt's reads and writes, against the storage of the backend that asked. */
export type HostCatalogSeedAttempt = {
  /** Whether the durable cache already holds models. */
  cached(): Promise<boolean>;
  /** Downloads and saves the catalogue; throws when it cannot. */
  download(): Promise<void>;
  now(): number;
};

/** OpenCode's catalogue is per project; every other platform's is host-wide. */
function seedKey(agent: AgentPlatform, projectId?: string): string {
  return agent === "opencode" ? `opencode:${projectId ?? ""}` : agent;
}

/**
 * One backend's host catalogue seeds: the single flight per platform (and
 * project, for OpenCode), the failure cooldown, and the generation a sign-in
 * bumps. Owned by `LocalServerRuntime` as `catalogSeeds`, so a second backend
 * in one process neither joins this one's download, which writes this
 * backend's storage, nor waits out its cooldown
 * (docs/architecture/backend-runtime.md). `host-model-catalog-seed.ts` runs
 * the download itself.
 */
export class HostCatalogSeeds {
  private readonly failedAt = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly flights = new Map<string, { generation: number; promise: Promise<boolean> }>();

  /** Forget recorded failures for a platform, for example because the user just signed in. */
  resetCooldown(agent: AgentPlatform): void {
    const keys = new Set([...this.failedAt.keys(), ...this.flights.keys(), agent]);
    for (const key of keys) {
      if (key === agent || key.startsWith(`${agent}:`)) {
        this.failedAt.delete(key);
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      }
    }
  }

  /**
   * Runs `attempt` unless a current one is in flight or a recent failure is
   * cooling down. Resolves whether the cache now holds models; never rejects.
   */
  seed(
    agent: AgentPlatform,
    projectId: string | undefined,
    attempt: HostCatalogSeedAttempt,
  ): Promise<boolean> {
    const key = seedKey(agent, projectId);
    const generation = this.generations.get(key) ?? 0;
    const existing = this.flights.get(key);
    if (existing?.generation === generation) return existing.promise;

    const run = async (): Promise<boolean> => {
      try {
        if (await attempt.cached()) return true;
        const lastFailure = this.failedAt.get(key);
        if (
          lastFailure !== undefined &&
          attempt.now() - lastFailure < HOST_CATALOG_SEED_FAILURE_COOLDOWN_MS
        ) {
          return false;
        }
        await attempt.download();
        if ((this.generations.get(key) ?? 0) === generation) this.failedAt.delete(key);
        return true;
      } catch (error) {
        // A sign-in may invalidate this attempt while its old credentials are
        // still in use. Do not let that stale failure reinstate the cooldown.
        if ((this.generations.get(key) ?? 0) === generation) this.failedAt.set(key, attempt.now());
        // The message is the bridge's own error text; it carries no credentials.
        log.warn("download.deferred", { agent, error: formatLogError(error) });
        return false;
      }
    };

    // A reset during an in-flight pre-login probe queues exactly one fresh
    // attempt behind it. This avoids concurrent writers while ensuring the
    // authenticated request is not absorbed by the stale flight.
    const started = existing ? existing.promise.then(run, run) : run();
    const flight = started.finally(() => {
      if (this.flights.get(key)?.promise === flight) this.flights.delete(key);
    });
    this.flights.set(key, { generation, promise: flight });
    return flight;
  }
}
