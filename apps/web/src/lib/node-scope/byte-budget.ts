/**
 * A window-wide byte budget shared by every node scope (report §7.4,
 * invariant 11).
 *
 * Per-node store instances must not multiply memory, so heavy data
 * (transcripts, artifacts, images) reserves from one budget per kind that the
 * `WindowScope` owns. A reservation is keyed by `(nodeId, key)`; the key is the
 * owner's own identifier (a session id, an artifact digest) and is never
 * logged.
 *
 * Eviction policy when a reservation does not fit:
 *
 * 1. least-recently-used entries of nodes other than the reserving node and
 *    the shown node;
 * 2. then the reserving node's own older entries (the shown node's too, for
 *    its own reservations: plan item 4002, so a window showing one node can
 *    still page through that node's sessions);
 * 3. never an entry of the shown node for another node's reservation.
 *
 * If that still cannot make room, the reservation is refused and nothing is
 * evicted, so the budget is a hard bound. Evicted owners hear about it through
 * the `onEvict` they passed when reserving; they drop the data and may reserve
 * again later. `setShownNode` is the policy hook the lifecycle manager (plan
 * item 4002, `lifecycle.ts`) drives while it manages any scope; it also drops
 * a hidden node's entries under pressure (`evictNode`).
 */

import type { BackendId } from "@orkestrator/protocol/federation";

export interface ByteBudgetEntry {
  readonly nodeId: BackendId;
  readonly key: string;
  readonly bytes: number;
}

export interface ReserveOptions {
  /** Called after the entry was evicted to make room for another reservation. */
  onEvict?: (entry: ByteBudgetEntry) => void;
}

export type ReserveResult =
  | { readonly granted: true; readonly evicted: readonly ByteBudgetEntry[] }
  | { readonly granted: false; readonly evicted: readonly [] };

interface Reservation extends ByteBudgetEntry {
  onEvict: ((entry: ByteBudgetEntry) => void) | undefined;
}

const entryKey = (nodeId: BackendId, key: string): string => `${nodeId}\u0000${key}`;

export class ByteBudget {
  /** Insertion order is recency order: the first entry is the least recently used. */
  private readonly entries = new Map<string, Reservation>();
  private used = 0;
  private shownNode: BackendId | null = null;

  constructor(
    /** A bounded label for diagnostics (`"transcripts"`). */
    readonly name: string,
    readonly totalBytes: number,
  ) {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
      throw new Error(`Byte budget ${name} needs a non-negative integer total.`);
    }
  }

  get usedBytes(): number {
    return this.used;
  }

  usedBytesFor(nodeId: BackendId): number {
    let total = 0;
    for (const entry of this.entries.values()) if (entry.nodeId === nodeId) total += entry.bytes;
    return total;
  }

  has(nodeId: BackendId, key: string): boolean {
    return this.entries.has(entryKey(nodeId, key));
  }

  /** The node whose entries are never evicted; `null` protects none. */
  setShownNode(nodeId: BackendId | null): void {
    this.shownNode = nodeId;
  }

  /**
   * Reserves `bytes` for `(nodeId, key)`, replacing an earlier reservation for
   * the same key and marking it most recently used. Evicts by the policy above
   * when the total would be exceeded.
   */
  reserve(
    nodeId: BackendId,
    key: string,
    bytes: number,
    options: ReserveOptions = {},
  ): ReserveResult {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`A ${this.name} reservation needs a non-negative integer size.`);
    }
    const id = entryKey(nodeId, key);
    const previous = this.entries.get(id);
    const needed = this.used - (previous?.bytes ?? 0) + bytes - this.totalBytes;
    const victims = needed > 0 ? this.chooseVictims(nodeId, id, needed) : [];
    if (victims === null) return { granted: false, evicted: [] };

    for (const victim of victims) this.remove(entryKey(victim.nodeId, victim.key));
    if (previous) this.remove(id);
    this.entries.set(id, { nodeId, key, bytes, onEvict: options.onEvict ?? previous?.onEvict });
    this.used += bytes;

    const evicted: ByteBudgetEntry[] = [];
    for (const victim of victims) {
      const entry = { nodeId: victim.nodeId, key: victim.key, bytes: victim.bytes };
      evicted.push(entry);
      notifyEvicted(victim, entry);
    }
    return { granted: true, evicted };
  }

  /**
   * Best-effort room: evicts by the policy above, least recently used first,
   * until `usedBytes <= targetBytes` or nothing evictable is left. Never
   * evicts `(nodeId, key)` itself, nor an entry of the shown node unless
   * `nodeId` is the shown node. Unlike
   * `reserve`, it evicts even when it cannot reach the target (a reader
   * freeing room before it asks for a page sized to what is left). Returns
   * the evicted entries; their owners hear through `onEvict`.
   */
  evictUntil(nodeId: BackendId, key: string, targetBytes: number): readonly ByteBudgetEntry[] {
    if (this.used <= targetBytes) return [];
    const victims: Reservation[] = [];
    let used = this.used;
    for (const entry of this.evictionOrder(nodeId, entryKey(nodeId, key))) {
      if (used <= targetBytes) break;
      victims.push(entry);
      used -= entry.bytes;
    }
    for (const victim of victims) this.remove(entryKey(victim.nodeId, victim.key));
    const evicted: ByteBudgetEntry[] = [];
    for (const victim of victims) {
      const entry = { nodeId: victim.nodeId, key: victim.key, bytes: victim.bytes };
      evicted.push(entry);
      notifyEvicted(victim, entry);
    }
    return evicted;
  }

  /**
   * Evicts every entry of `nodeId`, oldest first, and tells their owners
   * through `onEvict` (the lifecycle's pressure path, plan item 4002: a
   * hidden node's heavy data goes). Unlike `releaseNode`, owners hear about
   * it. Returns the evicted entries.
   */
  evictNode(nodeId: BackendId): readonly ByteBudgetEntry[] {
    const victims: Reservation[] = [];
    for (const [id, entry] of Array.from(this.entries)) {
      if (entry.nodeId !== nodeId) continue;
      victims.push(entry);
      this.remove(id);
    }
    const evicted: ByteBudgetEntry[] = [];
    for (const victim of victims) {
      const entry = { nodeId: victim.nodeId, key: victim.key, bytes: victim.bytes };
      evicted.push(entry);
      notifyEvicted(victim, entry);
    }
    return evicted;
  }

  /** Marks an entry most recently used without changing its size. */
  touch(nodeId: BackendId, key: string): void {
    const id = entryKey(nodeId, key);
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  /** The owner gives a reservation back. Does not call `onEvict`. */
  release(nodeId: BackendId, key: string): void {
    this.remove(entryKey(nodeId, key));
  }

  /** Releases every reservation of one node (its scope was disposed). */
  releaseNode(nodeId: BackendId): void {
    for (const [id, entry] of Array.from(this.entries)) {
      if (entry.nodeId === nodeId) this.remove(id);
    }
  }

  /**
   * Moves every reservation of `from` to `to`, keeping the recency order: a
   * command scope opened under a provisional id learnt its proven one (plan
   * item 2011). Where `to` already holds the same key, `to`'s is kept.
   */
  renameNode(from: BackendId, to: BackendId): void {
    if (from === to) return;
    const entries = Array.from(this.entries);
    const ids = new Set(this.entries.keys());
    this.entries.clear();
    for (const [id, entry] of entries) {
      if (entry.nodeId !== from) {
        this.entries.set(id, entry);
        continue;
      }
      const renamed = entryKey(to, entry.key);
      if (ids.has(renamed)) {
        this.used -= entry.bytes;
        continue;
      }
      this.entries.set(renamed, { ...entry, nodeId: to });
    }
    if (this.shownNode === from) this.shownNode = to;
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.used -= entry.bytes;
  }

  /** Evictable entries in policy order: other nodes' LRU first, then `nodeId`'s own. */
  private evictionOrder(nodeId: BackendId, reservingId: string): Reservation[] {
    const others: Reservation[] = [];
    const own: Reservation[] = [];
    for (const [id, entry] of this.entries) {
      if (id === reservingId) continue;
      // The shown node gives way only to itself.
      if (entry.nodeId === this.shownNode && nodeId !== this.shownNode) continue;
      (entry.nodeId === nodeId ? own : others).push(entry);
    }
    return [...others, ...own];
  }

  /** The entries to evict to free `needed` bytes, or `null` if they cannot. */
  private chooseVictims(
    nodeId: BackendId,
    reservingId: string,
    needed: number,
  ): Reservation[] | null {
    const victims: Reservation[] = [];
    let freed = 0;
    for (const entry of this.evictionOrder(nodeId, reservingId)) {
      if (freed >= needed) break;
      victims.push(entry);
      freed += entry.bytes;
    }
    return freed >= needed ? victims : null;
  }
}

function notifyEvicted(victim: Reservation, entry: ByteBudgetEntry): void {
  if (!victim.onEvict) return;
  try {
    victim.onEvict(entry);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

/** The budgets every node scope in a window shares. */
export interface WindowByteBudgets {
  readonly transcripts: ByteBudget;
  readonly artifacts: ByteBudget;
  readonly images: ByteBudget;
}

const MIB = 1024 * 1024;

/**
 * Placeholder totals until plan item 0004 measures per-scope cost and 4002
 * sets per-host values. The transcript total is the retained native-agent
 * history bound the renderer had before scopes (plan item 3009: every node's
 * retained history pages reserve from it). The artifact total matches the
 * existing settled-render cache bound
 * (`FRONTEND_RENDER_POLICY.maxSettledCacheBytes`).
 */
export const DEFAULT_WINDOW_BYTE_BUDGETS = {
  transcripts: 32 * MIB,
  artifacts: 16 * MIB,
  images: 32 * MIB,
} as const satisfies Record<keyof WindowByteBudgets, number>;

export function createWindowByteBudgets(
  totals: Partial<Record<keyof WindowByteBudgets, number>> = {},
): WindowByteBudgets {
  const total = (name: keyof WindowByteBudgets) =>
    totals[name] ?? DEFAULT_WINDOW_BYTE_BUDGETS[name];
  return {
    transcripts: new ByteBudget("transcripts", total("transcripts")),
    artifacts: new ByteBudget("artifacts", total("artifacts")),
    images: new ByteBudget("images", total("images")),
  };
}

export function releaseNodeFromBudgets(budgets: WindowByteBudgets, nodeId: BackendId): void {
  budgets.transcripts.releaseNode(nodeId);
  budgets.artifacts.releaseNode(nodeId);
  budgets.images.releaseNode(nodeId);
}

/** `ByteBudget.renameNode` on every budget of the window. */
export function renameNodeInBudgets(
  budgets: WindowByteBudgets,
  from: BackendId,
  to: BackendId,
): void {
  budgets.transcripts.renameNode(from, to);
  budgets.artifacts.renameNode(from, to);
  budgets.images.renameNode(from, to);
}
