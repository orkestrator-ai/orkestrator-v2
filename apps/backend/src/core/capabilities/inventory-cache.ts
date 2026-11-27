/**
 * The slow part of this machine's inventory, read once and shared
 * (docs/architecture/agent-capabilities-management.md, "Inventory reads").
 *
 * The native plugin listings run each provider's CLI, and one of them can
 * hang (`codex plugin list --json` waits on a remote service). Concurrent
 * readers share one listing in flight, and a settled listing serves readers
 * for `INVENTORY_PLUGIN_TTL_MS`. Every change this machine applies (a
 * capability write, an MCP change, a plugin switch) calls `invalidate`, which
 * advances the generation: a listing started before it is never served after
 * it. Launch evidence takes a fresh observation outside the discovery window.
 */
import type { InventoryPluginListing } from "./inventory.js";

/** How long a settled plugin listing serves readers; matches `EXTENSION_DISCOVERY_TTL_MS`. */
export const INVENTORY_PLUGIN_TTL_MS = 60_000;

interface Entry<T> {
  generation: number;
  startedAt: number;
  settled: boolean;
  listing: Promise<T>;
}

export class InventoryPluginCache<T = InventoryPluginListing> {
  private generationValue = 0;
  private entry: Entry<T> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly load: () => Promise<T>,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? INVENTORY_PLUGIN_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Advances on every invalidation: equal values mean nothing changed in between. */
  get generation(): number {
    return this.generationValue;
  }

  /**
   * The current listing. `refresh` skips a settled listing but still joins
   * one in flight.
   */
  read(options: { refresh?: boolean } = {}): Promise<T> {
    const current = this.entry;
    if (current && current.generation === this.generationValue) {
      if (!current.settled) return current.listing;
      if (!options.refresh && this.now() - current.startedAt < this.ttlMs) return current.listing;
    }
    const entry: Entry<T> = {
      generation: this.generationValue,
      startedAt: this.now(),
      settled: false,
      listing: Promise.resolve().then(() => this.load()),
    };
    this.entry = entry;
    entry.listing.then(
      () => {
        entry.settled = true;
      },
      () => {
        // A failed listing is not kept: the next reader tries again.
        if (this.entry === entry) this.entry = null;
      },
    );
    return entry.listing;
  }

  /** Something on this machine changed: the next read lists again. */
  invalidate(): void {
    this.generationValue += 1;
    this.entry = null;
  }
}
