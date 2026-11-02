import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { hydrateAgentModelCatalogCache } from "./agent-model-catalog-cache";

const log = createLogger("web.startup");

interface StartupTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface StartAppOptions {
  render(): void;
  hydrate?: () => Promise<void>;
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
 * Restore host-level model catalogues before the first render, without letting
 * an unavailable gateway leave the application on a blank page.
 */
export async function startApp({
  render,
  hydrate = () => hydrateAgentModelCatalogCache({ seed: true }),
  timeoutMs = 2_000,
  timer = browserTimer,
}: StartAppOptions): Promise<void> {
  let cacheTimeout: unknown;
  try {
    await Promise.race([
      hydrate(),
      new Promise<void>((resolve) => {
        // The hydration promise remains live after this timeout and may still
        // update the stores when its backend request eventually completes.
        cacheTimeout = timer.set(resolve, timeoutMs);
      }),
    ]);
  } catch (error) {
    // A missing/corrupt cache is non-fatal; the stores retain their bundled
    // fallbacks and the normal bridge discovery path will repair it later.
    log.warn("model-catalogue.restore-failed", { error: formatLogError(error) });
  } finally {
    if (cacheTimeout !== undefined) timer.clear(cacheTimeout);
  }

  render();
}
