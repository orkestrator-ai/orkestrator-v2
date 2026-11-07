import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { hydrateAgentModelCatalogCache } from "./agent-model-catalog-cache";

const log = createLogger("web.startup");

interface StartupTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface StartAppOptions {
  render(): void;
  /** Reads the stored catalogues only; it must not download anything. */
  hydrate?: () => Promise<void>;
  /** Downloads missing catalogues after rendering, once the read settles or times out. */
  seed?: () => Promise<void>;
  timeoutMs?: number;
  timer?: StartupTimer;
}

const browserTimer: StartupTimer = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/**
 * Restore host-level model catalogues from the durable cache before the first
 * render, then seed missing ones in the background.
 *
 * The first render waits only on the cached read, bounded by `timeoutMs` so an
 * unavailable gateway cannot leave a blank page. The seed, which may start a
 * bridge and its CLI per platform, starts after the render, once the read
 * settles or reaches its timeout. It never holds the render or waits forever
 * for an unavailable cache: a node with a broken platform used to make every cold open
 * wait the whole bound. The stores update when the seed finishes.
 */
export async function startApp({
  render,
  hydrate = () => hydrateAgentModelCatalogCache({ seed: false }),
  seed = () => hydrateAgentModelCatalogCache({ seed: true }),
  timeoutMs = 2_000,
  timer = browserTimer,
}: StartAppOptions): Promise<void> {
  let cacheTimeout: unknown;
  // A late read may still fill the stores; hydration's identity checks keep
  // it from overwriting a newer catalogue installed by the background seed.
  const read = Promise.resolve()
    .then(hydrate)
    .catch((error: unknown) => {
      // A missing/corrupt cache is non-fatal; the stores retain their bundled
      // fallbacks and the background seed or bridge discovery repairs it.
      log.warn("model-catalogue.restore-failed", { error: formatLogError(error) });
    });
  const startSeed = () =>
    Promise.resolve()
      .then(seed)
      .catch((error: unknown) => {
        log.warn("model-catalogue.seed-failed", { error: formatLogError(error) });
      });
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
  void Promise.resolve().then(startSeed);
}
