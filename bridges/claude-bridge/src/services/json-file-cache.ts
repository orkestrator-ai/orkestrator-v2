// Stat-validated cache for the small JSON config files the bridge consults
// before every prompt.
//
// `~/.claude.json` is the motivating case: it holds the user's project history
// and routinely runs to hundreds of KB, and both the MCP and plugin resolvers
// read it. Re-reading and re-parsing it several times per prompt is pure
// waste, but caching it outright would ignore edits made while the bridge is
// running. Validating against the file's identity and mtime keeps the read
// honest at the cost of one stat.
//
// Two properties matter beyond "don't re-read":
//
//   Concurrent misses share one parse. Both `getMergedMcpServers` and
//   `getMergedPlugins` fan out to several readers of the same path inside a
//   single `Promise.all`, so a cold cache would otherwise parse the same file
//   three or four times in one tick.
//
//   Only the slice a caller asked for is retained. The parsed document is
//   transient; what survives in the cache is `config.mcpServers` or
//   `config.projects[cwd].plugins`, not the megabyte of unrelated project
//   history sitting alongside them in `~/.claude.json`.

import { readFile, stat } from "node:fs/promises";

interface CacheEntry {
  /** Identity + version of the file this slice was selected from. */
  fingerprint: string;
  /** Selected value, or null when the file was missing, unparseable, or the slice absent. */
  value: unknown;
}

/** NUL cannot appear in a path, so it is a safe compound-key separator. */
const SEPARATOR = "\u0000";

/** Slice key used by `readJsonFileCached`, which retains the whole document. */
const WHOLE_DOCUMENT = "";

const slices = new Map<string, CacheEntry>();

/**
 * Parses currently in flight, keyed by path *and* fingerprint so two readers
 * only share a parse when they agree on which version of the file they want.
 */
const inFlightParses = new Map<string, Promise<unknown>>();

/** Parses performed (not served from cache). Test-only instrumentation. */
let parseCount = 0;

function fingerprintOf(stats: { mtimeMs: number; size: number; ino: number; dev: number }): string {
  // `ino`/`dev` catch an atomic replace that happens to preserve mtime and
  // size — the common shape of a config file written via rename.
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

/** Drop every slice remembered for a path. */
function forgetFile(filePath: string): void {
  const prefix = `${filePath}${SEPARATOR}`;
  for (const key of slices.keys()) {
    if (key.startsWith(prefix)) slices.delete(key);
  }
}

/**
 * Read and parse the file once per (path, fingerprint), sharing the work with
 * any caller that asks for the same version while the read is outstanding.
 *
 * Never rejects: a missing, unreadable or malformed file resolves to null so a
 * persistently broken file is not re-parsed per prompt. The next write changes
 * the fingerprint and retries.
 */
function parseOnce(filePath: string, fingerprint: string): Promise<unknown> {
  const key = `${filePath}${SEPARATOR}${fingerprint}`;
  const existing = inFlightParses.get(key);
  if (existing) return existing;

  const parse = (async () => {
    parseCount += 1;
    try {
      return JSON.parse(await readFile(filePath, "utf-8")) as unknown;
    } catch {
      // Unreadable (the stat raced a permission change) or malformed.
      return null;
    }
  })();

  inFlightParses.set(key, parse);
  // The promise above cannot reject, but settle both ways so a future change
  // to it cannot strand an entry in the map forever.
  void parse.then(
    () => inFlightParses.delete(key),
    () => inFlightParses.delete(key),
  );
  return parse;
}

/**
 * Read a JSON file and cache **only the slice `select` returns**.
 *
 * `sliceKey` names the slice and must be stable and unique for a given
 * selector — including any parameter the selector closes over, e.g.
 * `projects:${cwd}:mcpServers`. Two selectors sharing a key would serve each
 * other's results.
 *
 * The returned value is **shared between callers** — treat it as immutable.
 * Every current caller copies what it needs out of the slice (spread into a
 * merged record, or mapped into fresh objects) rather than mutating it in
 * place; keep it that way.
 */
export async function readJsonSliceCached<Parsed, Slice>(
  filePath: string,
  sliceKey: string,
  select: (parsed: Parsed) => Slice | null | undefined,
): Promise<Slice | null> {
  let fingerprint: string;
  try {
    fingerprint = fingerprintOf(await stat(filePath));
  } catch {
    // Missing or unreadable. Drop any stale slice so a file that reappears is
    // not served from a cache entry describing its previous life.
    forgetFile(filePath);
    return null;
  }

  const key = `${filePath}${SEPARATOR}${sliceKey}`;
  const cached = slices.get(key);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.value as Slice | null;
  }

  const parsed = await parseOnce(filePath, fingerprint);

  let value: Slice | null = null;
  if (parsed !== null && parsed !== undefined) {
    try {
      value = select(parsed as Parsed) ?? null;
    } catch {
      // A selector that trips over an unexpected shape is treated the same as
      // an absent slice; a config file is not worth crashing a turn over.
      value = null;
    }
  }

  slices.set(key, { fingerprint, value });
  return value;
}

/**
 * Read and parse a whole JSON file, returning null if it is missing or invalid.
 *
 * Retains the entire parsed document, so prefer `readJsonSliceCached` for any
 * file that is large or holds data the caller does not need. Same immutability
 * contract as `readJsonSliceCached`.
 */
export async function readJsonFileCached<T>(filePath: string): Promise<T | null> {
  return readJsonSliceCached<T, T>(filePath, WHOLE_DOCUMENT, (parsed) => parsed);
}

/** Drop all cached slices. Exported for tests. */
export function clearJsonFileCache(): void {
  slices.clear();
  inFlightParses.clear();
  parseCount = 0;
}

/**
 * How many times a file has actually been read and parsed since the last
 * `clearJsonFileCache()`. Exported so tests can assert the cache and the
 * in-flight dedupe are doing their job; not used in production.
 */
export function getJsonFileParseCount(): number {
  return parseCount;
}
