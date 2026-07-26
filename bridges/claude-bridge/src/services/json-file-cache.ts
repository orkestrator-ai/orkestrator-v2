// Stat-validated cache for the small JSON config files the bridge consults
// before every prompt.
//
// `~/.claude.json` is the motivating case: it holds the user's project history
// and routinely runs to hundreds of KB, and both the MCP and plugin resolvers
// read it. Re-reading and re-parsing it several times per prompt is pure
// waste, but caching it outright would ignore edits made while the bridge is
// running. Validating against the file's identity and mtime keeps the read
// honest at the cost of one stat.

import { readFile, stat } from "node:fs/promises";

interface CacheEntry {
  /** Identity + version of the file this parse came from. */
  fingerprint: string;
  /** Parsed value, or null when the file was missing or unparseable. */
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

function fingerprintOf(stats: {
  mtimeMs: number;
  size: number;
  ino: number;
  dev: number;
}): string {
  // `ino`/`dev` catch an atomic replace that happens to preserve mtime and
  // size — the common shape of a config file written via rename.
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

/**
 * Read and parse a JSON file, returning null if it is missing or invalid.
 *
 * The returned value is **shared between callers** — treat it as immutable.
 * Every current caller copies what it needs out of the parsed config (spread
 * into a merged record, or mapped into fresh objects) rather than mutating it
 * in place; keep it that way.
 */
export async function readJsonFileCached<T>(filePath: string): Promise<T | null> {
  let fingerprint: string;
  try {
    fingerprint = fingerprintOf(await stat(filePath));
  } catch {
    // Missing or unreadable. Drop any stale parse so a file that reappears is
    // not served from a cache entry describing its previous life.
    cache.delete(filePath);
    return null;
  }

  const cached = cache.get(filePath);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.value as T | null;
  }

  let value: unknown = null;
  try {
    value = JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    // Malformed or raced with a write. Cache the failure against this
    // fingerprint so a persistently broken file is not re-parsed per prompt;
    // the next write changes the fingerprint and retries.
    value = null;
  }

  cache.set(filePath, { fingerprint, value });
  return value as T | null;
}

/** Drop all cached parses. Exported for tests. */
export function clearJsonFileCache(): void {
  cache.clear();
}
