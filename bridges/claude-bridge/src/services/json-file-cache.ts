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

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

interface CacheEntry {
  /** Identity + version of the file this slice was selected from. */
  fingerprint: string;
  /** Selected value, or null when the file was missing, unparseable, or the slice absent. */
  value: unknown;
  /** sha256 (base64url) of the bytes the slice was parsed from; null if unreadable. */
  digest: string | null;
}

/** A parsed document plus the digest of the exact bytes it came from. */
interface ParsedDocument {
  parsed: unknown;
  digest: string | null;
}

/** A slice together with the content digest of the file it was read from. */
export interface DigestedSlice<Slice> {
  value: Slice | null;
  /**
   * sha256 (base64url) of the file bytes the value was selected from, or null
   * when the file was missing or unreadable. A malformed file still has bytes,
   * so it has a digest: an edit that fixes it must read as a change.
   */
  digest: string | null;
}

interface ReadCohort {
  /** Readers that joined before every member of this cohort settled. */
  readers: number;
  /** Parsed snapshots, bounded by the fingerprints observed by those readers. */
  parses: Map<string, Promise<ParsedDocument>>;
}

/** NUL cannot appear in a path, so it is a safe compound-key separator. */
const SEPARATOR = "\u0000";

/** Slice key used by `readJsonFileCached`, which retains the whole document. */
const WHOLE_DOCUMENT = "";

const slices = new Map<string, CacheEntry>();

/**
 * Overlapping reads, registered before their first await. A parsed document
 * remains available until every reader in its cohort settles, including a
 * reader whose `stat` finishes after the initial parse has completed.
 */
const readCohorts = new Map<string, ReadCohort>();

/** Parses performed per path (not served from cache). Test-only instrumentation. */
const parseCounts = new Map<string, number>();

/** Test-only scheduling seam for proving staggered metadata reads. */
let beforeStatForTesting: ((filePath: string) => Promise<void>) | null = null;

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

/** Join the active per-file cohort before this reader's first await. */
function joinReadCohort(filePath: string): ReadCohort {
  const existing = readCohorts.get(filePath);
  if (existing) {
    existing.readers += 1;
    return existing;
  }

  const cohort: ReadCohort = { readers: 1, parses: new Map() };
  readCohorts.set(filePath, cohort);
  return cohort;
}

function leaveReadCohort(filePath: string, cohort: ReadCohort): void {
  cohort.readers -= 1;
  if (cohort.readers === 0 && readCohorts.get(filePath) === cohort) {
    readCohorts.delete(filePath);
  }
}

/**
 * Read and parse once per fingerprint within an overlapping-reader cohort.
 *
 * Never rejects: a missing, unreadable or malformed file resolves to null so a
 * persistently broken file is not re-parsed per prompt. The next write changes
 * the fingerprint and retries.
 */
function parseOnce(
  filePath: string,
  fingerprint: string,
  cohort: ReadCohort,
): Promise<ParsedDocument> {
  const existing = cohort.parses.get(fingerprint);
  if (existing) return existing;

  const parse = (async (): Promise<ParsedDocument> => {
    parseCounts.set(filePath, (parseCounts.get(filePath) ?? 0) + 1);
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      // Unreadable (the stat raced a permission change).
      return { parsed: null, digest: null };
    }
    // Hashed from the same bytes that are parsed, so the digest names exactly
    // the configuration a caller acted on — never a later write.
    const digest = createHash("sha256").update(bytes).digest("base64url");
    try {
      return { parsed: JSON.parse(bytes.toString("utf-8")) as unknown, digest };
    } catch {
      // Malformed.
      return { parsed: null, digest };
    }
  })();

  // Keep the settled promise until the last overlapping reader leaves. A
  // caller may already belong to this cohort while its `stat` is still queued,
  // so deleting on parse completion reintroduces the duplicate-read race.
  cohort.parses.set(fingerprint, parse);
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
  return (await readJsonSliceCachedWithDigest(filePath, sliceKey, select)).value;
}

/**
 * `readJsonSliceCached`, plus the sha256 of the file bytes the slice came from.
 *
 * Costs nothing extra on a cache hit — the digest is taken once, when the file
 * is actually read — so callers that need to say *which* configuration a turn
 * started with can do so without a second read of a file that may be large.
 */
export async function readJsonSliceCachedWithDigest<Parsed, Slice>(
  filePath: string,
  sliceKey: string,
  select: (parsed: Parsed) => Slice | null | undefined,
): Promise<DigestedSlice<Slice>> {
  // Join synchronously, before the first filesystem await, so every read
  // started in one Promise.all remains part of the same bounded cohort even
  // when the host completes its metadata operations unevenly.
  const cohort = joinReadCohort(filePath);
  try {
    await beforeStatForTesting?.(filePath);

    let fingerprint: string;
    try {
      fingerprint = fingerprintOf(await stat(filePath));
    } catch {
      // Missing or unreadable. Drop any stale slice so a file that reappears is
      // not served from a cache entry describing its previous life.
      forgetFile(filePath);
      return { value: null, digest: null };
    }

    const key = `${filePath}${SEPARATOR}${sliceKey}`;
    const cached = slices.get(key);
    if (cached && cached.fingerprint === fingerprint) {
      return { value: cached.value as Slice | null, digest: cached.digest };
    }

    const { parsed, digest } = await parseOnce(filePath, fingerprint, cohort);

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

    slices.set(key, { fingerprint, value, digest });
    return { value, digest };
  } finally {
    leaveReadCohort(filePath, cohort);
  }
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
  readCohorts.clear();
  parseCounts.clear();
  beforeStatForTesting = null;
}

/** Delay metadata reads in tests; production code must never call this. */
export function setJsonFileCacheBeforeStatForTesting(
  hook: ((filePath: string) => Promise<void>) | null,
): void {
  beforeStatForTesting = hook;
}

/**
 * How many times a file has actually been read and parsed since the last
 * `clearJsonFileCache()`. Exported so tests can assert the cache and the
 * in-flight dedupe are doing their job; not used in production.
 */
export function getJsonFileParseCount(filePath: string): number {
  return parseCounts.get(filePath) ?? 0;
}

/** Snapshot a file's active cohort. Test-only lifecycle instrumentation. */
export function getJsonFileReadCohortStateForTesting(
  filePath: string,
): { readers: number; parses: number } | null {
  const cohort = readCohorts.get(filePath);
  return cohort ? { readers: cohort.readers, parses: cohort.parses.size } : null;
}
