/**
 * What `GET /session/list` answers while no session file has changed, for up to 30 s.
 *
 * `SessionManager.list` reads and parses every session file in full, and Pi
 * does not export the per-file step, so the result can only be kept whole: one
 * changed file parses them all again. Unchanged costs one directory listing and
 * one `stat` per file. The stamp is a fixed-size digest, so a huge directory
 * retains no more than a small one.
 */
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { NativeAgentResumeEntry } from "@orkestrator/protocol/native-agent";
import { encodedJsonBytes } from "@orkestrator/protocol/node/transcript-budget";

/** The SDK suppresses some read failures, so even an unchanged stamp must retry. */
export const SESSION_LIST_CACHE_TTL_MS = 30_000;

/** The most a list may hold to be kept; the backend refuses a larger body anyway. */
export const MAX_CACHED_SESSION_LIST_BYTES = 2 * 1024 * 1024;

interface CachedSessionList {
  expiresAt: number;
  directory: string;
  stamp: string;
  entries: NativeAgentResumeEntry[];
}

let cached: CachedSessionList | undefined;

/** Undefined when the directory cannot be read, which never matches a kept list. */
export async function sessionFilesStamp(directory: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return undefined;
  }
  const stats = await Promise.all(
    names.map((name) => stat(join(directory, name)).catch(() => undefined)),
  );
  const hash = createHash("sha256");
  for (const [index, name] of names.entries()) {
    const file = stats[index];
    hash.update(
      file
        ? `${name}\0${file.size}\0${file.mtimeMs}\0${file.ctimeMs}\0${file.ino}\n`
        : `${name}\0gone\n`,
    );
  }
  return hash.digest("hex");
}

export function cachedSessionList(
  directory: string,
  stamp: string | undefined,
): NativeAgentResumeEntry[] | undefined {
  if (
    stamp === undefined ||
    cached?.directory !== directory ||
    cached.stamp !== stamp ||
    performance.now() >= cached.expiresAt
  ) {
    return undefined;
  }
  return cached.entries;
}

/** `stamp` was taken before the read, so a file changing meanwhile re-reads next time. */
export function rememberSessionList(
  directory: string,
  stamp: string | undefined,
  entries: NativeAgentResumeEntry[],
): void {
  cached =
    stamp !== undefined && encodedJsonBytes(entries) <= MAX_CACHED_SESSION_LIST_BYTES
      ? { directory, stamp, entries, expiresAt: performance.now() + SESSION_LIST_CACHE_TTL_MS }
      : undefined;
}
