import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { hydrateAgentModelCatalogCache } from "./agent-model-catalog-cache";
import { beginRealmBoot, recordRealmBootStep } from "./realm-boot-timing";

const log = createLogger("web.startup");

interface StartupTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface StartAppOptions {
  render(): void;
  /** Reads the stored catalogues only; it must not download anything. */
  hydrate?: () => Promise<void>;
  /** Downloads missing catalogues and updates the stores; runs after the read. */
  seed?: () => Promise<void>;
  timeoutMs?: number;
  timer?: StartupTimer;
  now?: () => number;
}

const browserTimer: StartupTimer = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

/**
 * Restore host-level model catalogues from the durable cache before the first
 * render, then seed missing ones in the background.
 *
 * The first render waits only on the cached read, bounded by `timeoutMs` so an
 * unavailable gateway cannot leave a blank page. The seed, which may start a
 * bridge and its CLI per platform, starts after the render and once that read
 * has settled (so its result is compared against the stores the read filled),
 * and never holds the render: a realm on a node with a broken platform used to wait the whole
 * bound on every cold open. The stores update when the seed finishes.
 */
export async function startApp({
  render,
  hydrate = () => hydrateAgentModelCatalogCache({ seed: false }),
  seed = () => hydrateAgentModelCatalogCache({ seed: true }),
  timeoutMs = 2_000,
  timer = browserTimer,
  now = monotonicNow,
}: StartAppOptions): Promise<void> {
  beginRealmBoot();
  let cacheTimeout: unknown;
  const readStarted = now();
  // The read stays live after the timeout and may still fill the stores; the
  // seed waits for it either way.
  const read = Promise.resolve()
    .then(hydrate)
    .then(
      () => {
        recordRealmBootStep("catalogue-read", now() - readStarted, { outcome: "ok" });
      },
      (error: unknown) => {
        // A missing/corrupt cache is non-fatal; the stores retain their bundled
        // fallbacks and the background seed or bridge discovery repairs it.
        log.warn("model-catalogue.restore-failed", { error: formatLogError(error) });
        recordRealmBootStep("catalogue-read", now() - readStarted, { outcome: "failed" });
      },
    );
  const startSeed = () => {
    const seedStarted = now();
    return Promise.resolve()
      .then(seed)
      .then(
        () => {
          // A resolved cache RPC does not prove provider seeding succeeded: the
          // backend deliberately absorbs individual provider failures.
          recordRealmBootStep("catalogue-seed", now() - seedStarted);
        },
        (error: unknown) => {
          log.warn("model-catalogue.seed-failed", { error: formatLogError(error) });
          recordRealmBootStep("catalogue-seed", now() - seedStarted, { outcome: "failed" });
        },
      );
  };
  try {
    await Promise.race([
      read,
      new Promise<void>((resolve) => {
        cacheTimeout = timer.set(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (cacheTimeout !== undefined) timer.clear(cacheTimeout);
  }

  render();
  void read.then(startSeed);
}
