/**
 * A window-wide LRU of protected rich content, keyed by `(nodeId, key)`, whose
 * byte total is reserved from the window's shared `ByteBudget` (report §7.4,
 * invariant 11; plan item 3016).
 *
 * Several live nodes share one budget per kind (`images`, `artifacts`), so
 * per-node data does not multiply memory, and the budget's eviction policy
 * (other nodes first, never the shown node) decides what goes when it is
 * full. The cache keeps its own count bound and a per-entry size cap, and
 * drops an entry whenever the budget evicts its reservation.
 *
 * A reservation can also vanish without an eviction callback: a disposed node
 * scope releases all of its node's reservations, and a test may replace the
 * app window scope (and so the budgets). An entry whose reservation is gone is
 * treated as absent and is swept before every write, so after any write the
 * cache holds only what the budget has granted.
 *
 * Keys are the owner's own identifiers and are never logged.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { ByteBudget, WindowByteBudgets } from "@/lib/node-scope/byte-budget";

export interface NodeByteCacheOptions {
  /** Bounded and unique: prefixes this cache's reservations in the shared budget. */
  readonly name: string;
  readonly budget: keyof WindowByteBudgets;
  readonly maxEntries: number;
  /** Larger values are served but not retained. */
  readonly maxEntryBytes?: number;
  /** Tests: the budgets to reserve from. Defaults to the app window scope's, read per call. */
  readonly budgets?: () => WindowByteBudgets;
}

export interface NodeByteCacheEntry<V> {
  readonly nodeId: string;
  readonly key: string;
  readonly value: V;
  readonly bytes: number;
}

interface Held<V> extends NodeByteCacheEntry<V> {
  readonly budget: ByteBudget;
}

const entryId = (nodeId: string, key: string) => `${nodeId}\u0000${key}`;

export class NodeByteCache<V> {
  /** Insertion order is recency order: the first entry is the least recently used. */
  private readonly entries = new Map<string, Held<V>>();

  constructor(private readonly options: NodeByteCacheOptions) {}

  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  get bytes(): number {
    this.sweep();
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    return total;
  }

  has(nodeId: string, key: string): boolean {
    return this.live(entryId(nodeId, key)) !== undefined;
  }

  /** The value, marked most recently used here and in the budget. */
  get(nodeId: string, key: string): V | undefined {
    const id = entryId(nodeId, key);
    const entry = this.live(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    entry.budget.touch(entry.nodeId as BackendId, this.reservationKey(key));
    return entry.value;
  }

  /** The value without changing its recency. */
  peek(nodeId: string, key: string): V | undefined {
    return this.live(entryId(nodeId, key))?.value;
  }

  /**
   * Retains `value` under `(nodeId, key)` if the budget grants `bytes`,
   * replacing an earlier value. Returns whether it was retained; a value that
   * was not is simply served uncached by the caller.
   */
  set(nodeId: string, key: string, value: V, bytes: number): boolean {
    const id = entryId(nodeId, key);
    const size = Math.max(0, Math.ceil(bytes));
    if (this.options.maxEntryBytes !== undefined && size > this.options.maxEntryBytes) {
      this.delete(nodeId, key);
      return false;
    }
    this.sweep();
    const budget = this.budget();
    const reservation = this.reservationKey(key);
    const previous = this.entries.get(id);
    if (previous) this.entries.delete(id);
    const entry: Held<V> = { nodeId, key, value, bytes: size, budget };
    const result = budget.reserve(nodeId as BackendId, reservation, size, {
      onEvict: () => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
      },
    });
    if (!result.granted) {
      // A refused reservation leaves the earlier one in place; give it back.
      budget.release(nodeId as BackendId, reservation);
      return false;
    }
    this.entries.set(id, entry);
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.values().next().value;
      if (!oldest) break;
      this.drop(entryId(oldest.nodeId, oldest.key), oldest);
    }
    return true;
  }

  delete(nodeId: string, key: string): boolean {
    const id = entryId(nodeId, key);
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.drop(id, entry);
    return true;
  }

  /** Drops every entry `matches` selects; returns how many. */
  deleteWhere(matches: (entry: NodeByteCacheEntry<V>) => boolean): number {
    let dropped = 0;
    for (const [id, entry] of Array.from(this.entries)) {
      if (!matches(entry)) continue;
      this.drop(id, entry);
      dropped++;
    }
    return dropped;
  }

  clearNode(nodeId: string): number {
    return this.deleteWhere((entry) => entry.nodeId === nodeId);
  }

  clear(): void {
    for (const [id, entry] of Array.from(this.entries)) this.drop(id, entry);
  }

  /** Live entries, least recently used first. */
  values(): NodeByteCacheEntry<V>[] {
    this.sweep();
    return Array.from(this.entries.values());
  }

  private budget(): ByteBudget {
    return (this.options.budgets?.() ?? getWindowScope().budgets)[this.options.budget];
  }

  private reservationKey(key: string): string {
    return `${this.options.name}\u0000${key}`;
  }

  /** The entry if its reservation still stands in the current budget; otherwise drops it. */
  private live(id: string): Held<V> | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (this.reserved(entry)) return entry;
    this.entries.delete(id);
    return undefined;
  }

  private reserved(entry: Held<V>): boolean {
    return (
      entry.budget === this.budget() &&
      entry.budget.has(entry.nodeId as BackendId, this.reservationKey(entry.key))
    );
  }

  private sweep(): void {
    for (const [id, entry] of Array.from(this.entries)) {
      if (!this.reserved(entry)) this.entries.delete(id);
    }
  }

  private drop(id: string, entry: Held<V>): void {
    if (this.entries.get(id) === entry) this.entries.delete(id);
    entry.budget.release(entry.nodeId as BackendId, this.reservationKey(entry.key));
  }
}

/**
 * The node rich content is accounted to: the open node scope named by the
 * content's authenticated `backendId` when this window has one, otherwise the
 * command scope (whose transport every renderer read goes through until reads
 * take a scope, plan items 3008 and 3009).
 */
export function richContentNodeId(backendId?: string | null): string {
  const windowScope = getWindowScope();
  if (backendId) {
    const scope = windowScope.get(backendId as BackendId);
    if (scope) return scope.nodeId;
  }
  return windowScope.commandScope().nodeId;
}
