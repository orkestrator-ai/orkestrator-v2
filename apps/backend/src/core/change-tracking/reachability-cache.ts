/**
 * The objects each manifest makes reachable, kept between retention passes
 * (ST-20).
 *
 * The parsed-manifest cache serves live views and is not filled by a pass, so
 * an hourly pass over a long history found almost none of its manifests there
 * and parsed nearly every one again. Manifests are immutable, so the object
 * ids one names never change; this keeps just those ids, 20 bytes each, which
 * is a few percent of the parsed manifest.
 *
 * Bounded by count and bytes. A pass reads every manifest in the same order,
 * so least-recently-used eviction would evict each entry just before it is
 * needed again. Instead an entry is admitted only while there is room, and an
 * entry the latest pass did not walk (its snapshots are gone) is dropped at the
 * end of that pass, which makes room for the trees that took its place.
 */

export interface ReachabilityCacheLimits {
  maxEntries: number;
  maxBytes: number;
}

export const REACHABILITY_CACHE_MAX_ENTRIES = 4096;
export const REACHABILITY_CACHE_MAX_BYTES = 32 * 1024 * 1024;

const OID_BYTES = 20;

export class ReachabilityCache {
  private readonly entries = new Map<string, Buffer>();
  private readonly limits: ReachabilityCacheLimits;
  private bytes = 0;
  private walked = new Set<string>();

  constructor(limits: Partial<ReachabilityCacheLimits> = {}) {
    this.limits = {
      maxEntries: limits.maxEntries ?? REACHABILITY_CACHE_MAX_ENTRIES,
      maxBytes: limits.maxBytes ?? REACHABILITY_CACHE_MAX_BYTES,
    };
  }

  /** Start a pass: entries this pass does not walk are dropped by {@link endPass}. */
  beginPass(): void {
    this.walked = new Set();
  }

  /** Add the objects `manifestId` names to `reachable`; false when not cached. */
  addTo(manifestId: string, reachable: Set<string>): boolean {
    const oids = this.entries.get(manifestId);
    if (!oids) return false;
    this.walked.add(manifestId);
    for (let offset = 0; offset < oids.length; offset += OID_BYTES)
      reachable.add(oids.toString("hex", offset, offset + OID_BYTES));
    return true;
  }

  /** Keep the object ids `manifestId` names, if they fit. */
  remember(manifestId: string, oids: readonly string[]): void {
    this.walked.add(manifestId);
    if (this.entries.has(manifestId)) return;
    const bytes = oids.length * OID_BYTES;
    if (this.entries.size >= this.limits.maxEntries || this.bytes + bytes > this.limits.maxBytes)
      return;
    const packed = Buffer.allocUnsafe(bytes);
    for (const [index, oid] of oids.entries()) {
      // Only full-length hex ids pack exactly; anything else is not cached.
      if (!/^[0-9a-f]{40}$/.test(oid)) return;
      packed.write(oid, index * OID_BYTES, OID_BYTES, "hex");
    }
    this.entries.set(manifestId, packed);
    this.bytes += bytes;
  }

  /** Drop a manifest whose object is gone. */
  forget(manifestId: string): void {
    const entry = this.entries.get(manifestId);
    if (!entry) return;
    this.entries.delete(manifestId);
    this.bytes -= entry.length;
  }

  /** End a pass that completed: entries it did not walk name no snapshot now. */
  endPass(): void {
    for (const id of Array.from(this.entries.keys())) if (!this.walked.has(id)) this.forget(id);
  }

  /** For tests and diagnostics: sizes only. */
  snapshot() {
    return { entries: this.entries.size, bytes: this.bytes };
  }
}
