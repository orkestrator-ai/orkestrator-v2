/**
 * Parsed manifests by object id, one cache per store (ST-5).
 *
 * Objects are content-addressed, so a parsed manifest never goes stale; a turn
 * rereads the same start and end manifests for every provisional pass, restore
 * preview and diff page, and each read otherwise costs an inflate, a hash and a
 * parse. Every reader shares one copy, so it is deep-frozen before anyone sees it.
 *
 * Bounded by count and by an estimate of the parsed size, least recently used
 * evicted first. A manifest too large for the byte bound alone is handed back
 * uncached and is parsed on every read, as before the cache.
 */

import type { Manifest } from "./capture.js";

export interface ManifestCacheLimits {
  maxEntries: number;
  maxBytes: number;
}

export const MANIFEST_CACHE_MAX_ENTRIES = 32;
export const MANIFEST_CACHE_MAX_BYTES = 128 * 1024 * 1024;
/**
 * Parsed size over serialized size, rounded up from 1.4 measured on the heap for a
 * 100,000-entry manifest. The policy's largest manifest is then about 28 MiB
 * estimated, so the byte bound holds four of them.
 */
export const PARSED_BYTES_PER_SERIALIZED_BYTE = 2;

export class ManifestCache {
  private readonly entries = new Map<string, { manifest: Manifest; bytes: number }>();
  private readonly limits: ManifestCacheLimits;
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private parses = 0;

  constructor(limits: Partial<ManifestCacheLimits> = {}) {
    this.limits = {
      maxEntries: limits.maxEntries ?? MANIFEST_CACHE_MAX_ENTRIES,
      maxBytes: limits.maxBytes ?? MANIFEST_CACHE_MAX_BYTES,
    };
  }

  get(id: string): Manifest | null {
    const hit = this.entries.get(id);
    if (!hit) {
      this.misses++;
      return null;
    }
    this.hits++;
    // Refresh recency: Map iteration order is insertion order.
    this.entries.delete(id);
    this.entries.set(id, hit);
    return hit.manifest;
  }

  /** Freeze `manifest`, keep it if it fits, and return the frozen copy. */
  remember(id: string, manifest: Manifest, serializedBytes: number): Manifest {
    freezeManifest(manifest);
    this.forget(id);
    const bytes = serializedBytes * PARSED_BYTES_PER_SERIALIZED_BYTE;
    if (bytes > this.limits.maxBytes || this.limits.maxEntries < 1) return manifest;
    this.entries.set(id, { manifest, bytes });
    this.bytes += bytes;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limits.maxEntries && this.bytes <= this.limits.maxBytes) break;
      this.forget(oldest);
    }
    return manifest;
  }

  forget(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.bytes -= entry.bytes;
  }

  noteParse(): void {
    this.parses++;
  }

  /** For tests and diagnostics: sizes and counters, nothing about the content. */
  snapshot() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      parses: this.parses,
    };
  }
}

function freezeManifest(manifest: Manifest): void {
  for (const entry of manifest.entries) Object.freeze(entry);
  Object.freeze(manifest.entries);
  // An older or foreign payload is checked only for `v` and `entries`.
  for (const omission of manifest.omitted ?? []) Object.freeze(omission);
  if (manifest.omitted) Object.freeze(manifest.omitted);
  if (manifest.unstable) Object.freeze(manifest.unstable);
  Object.freeze(manifest);
}
