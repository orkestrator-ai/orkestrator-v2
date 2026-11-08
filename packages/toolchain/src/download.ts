/**
 * Resumable, pinned archive downloads for the toolchain cache.
 *
 * Downloads used to run under a five-minute total deadline into a staging
 * directory that was discarded on failure, so below about 3.5 Mbit/s a large
 * archive could never finish and every retry started from zero. Now:
 *
 * - The deadline is an idle timeout: a download fails only after receiving
 *   nothing for `idleTimeoutMs`, however long the whole transfer takes.
 * - Bytes land in `<rootDir>/.downloads/<sha256>.partial`, which outlives the
 *   staging directory. The name is the pinned archive digest, so a partial can
 *   only ever be resumed into the archive it was started for.
 * - A resumed attempt re-hashes the bytes already on disk, then asks for the
 *   rest with `Range:`. A server that ignores the range (200) restarts the file;
 *   a `206` must name exactly the missing range. The finished file must still
 *   match the pinned size and SHA-256; a resumed file that does not is discarded
 *   and fetched again from zero, a fresh one that does not is an error.
 * - Within one call an interrupted transfer is retried, with the same checks,
 *   while each attempt makes progress, up to `attempts`. An attempt that makes
 *   no progress fails at once; the partial is kept for the next launch or retry.
 *   The exception is a request Chromium aborted with `ERR_NETWORK_CHANGED`
 *   (Electron's `net.fetch`): a host interface appeared or disappeared, which
 *   Docker does for every container and network it creates, so the attempt says
 *   nothing about the server and is retried within the same `attempts`.
 *
 * Integrity failures (an untrusted host, a size mismatch, an oversized body)
 * delete the partial, since its bytes can no longer be trusted to belong to the
 * pinned archive.
 *
 * The caller's `signal` (a user's Ctrl-C) cancels the transfer and any retry
 * delay at once and is never retried; the call rejects with `abortError`, not
 * with "download stalled", which is reserved for the idle timeout. The partial
 * is kept like any interrupted transfer's, so the next run resumes it.
 */
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ToolchainArchive } from "./manifest.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const PARTIAL_DOWNLOAD_DIRECTORY = ".downloads";
const PARTIAL_SUFFIX = ".partial";
const UNREFERENCED_PARTIAL_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type DownloadTimings = {
  /** Abort when nothing arrives for this long, headers included. */
  idleTimeoutMs: number;
  /** Attempts per call, counting the first; only progressing attempts retry. */
  attempts: number;
  /** Delay before retry n is n times this. */
  retryDelayMs: number;
};

export const DEFAULT_DOWNLOAD_TIMINGS: DownloadTimings = {
  idleTimeoutMs: 60_000,
  attempts: 5,
  retryDelayMs: 1_000,
};

export type DownloadArchiveOptions = {
  label: string;
  archive: ToolchainArchive;
  /** Keep verified bytes available until the caller commits installation. */
  retainComplete?: boolean;
  /** Where the verified archive is staged once complete. */
  archivePath: string;
  /** The toolchain root; partials live in its `.downloads` directory. */
  rootDir: string;
  fetchImpl: FetchLike;
  /** Total archive bytes on disk, resumed bytes included. */
  onBytes: (received: number) => void;
  allowInsecureDownloadsForTests: boolean;
  timings: DownloadTimings;
  /** Cancels the download and any retry delay; an aborted download is not retried. */
  signal?: AbortSignal;
};

type AttemptFailure = Error & {
  /** Delete the partial and do not retry. */
  untrusted?: boolean;
  /** Delete the partial and retry from zero. */
  restart?: boolean;
};

function failure(message: string, kind: "untrusted" | "restart" | "transient"): AttemptFailure {
  const error: AttemptFailure = new Error(message);
  if (kind === "untrusted") error.untrusted = true;
  if (kind === "restart") error.restart = true;
  return error;
}

const NETWORK_CHANGED = "ERR_NETWORK_CHANGED";

/** Chromium aborted the request because a host network interface changed. */
function isNetworkChangeAbort(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if (current instanceof Error) {
      if (current.message.includes(NETWORK_CHANGED)) return true;
      current = current.cause;
    } else {
      return typeof current === "string" && current.includes(NETWORK_CHANGED);
    }
  }
  return false;
}

/**
 * The error an aborted install rejects with: the signal's reason when it is an
 * `Error`, otherwise an `AbortError` (the CLI aborts with the signal's name).
 */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === "string" && reason.length > 0
      ? `Toolchain installation was interrupted (${reason})`
      : "Toolchain installation was interrupted",
    "AbortError",
  );
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Waits `milliseconds`, or rejects with `abortError` as soon as `signal` aborts. */
export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function partialDownloadDirectory(rootDir: string): string {
  return path.join(rootDir, PARTIAL_DOWNLOAD_DIRECTORY);
}

export function partialDownloadPath(rootDir: string, archive: ToolchainArchive): string {
  return path.join(partialDownloadDirectory(rootDir), `${archive.sha256}${PARTIAL_SUFFIX}`);
}

export function assertDownloadLocation(
  label: string,
  archive: ToolchainArchive,
  response: Response,
  allowInsecureDownloadsForTests: boolean,
): void {
  const requested = new URL(archive.url);
  const resolved = new URL(response.url || archive.url);
  if (
    !allowInsecureDownloadsForTests &&
    (requested.protocol !== "https:" || resolved.protocol !== "https:")
  ) {
    throw failure(`${label} download did not use HTTPS`, "untrusted");
  }
  if (!archive.allowedHosts.includes(requested.hostname)) {
    throw failure(`${label} download host is not allowlisted: ${requested.hostname}`, "untrusted");
  }
  if (!archive.allowedHosts.includes(resolved.hostname)) {
    throw failure(`${label} redirected to an untrusted host: ${resolved.hostname}`, "untrusted");
  }
}

/** Bytes already downloaded; anything unusable is removed and counts as none. */
async function existingPartialSize(
  partialPath: string,
  archive: ToolchainArchive,
): Promise<number> {
  const info = await lstat(partialPath).catch(() => null);
  if (!info) return 0;
  if (!info.isFile() || info.size > archive.size) {
    await rm(partialPath, { force: true, recursive: true });
    return 0;
  }
  return info.size;
}

function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number | null } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header?.trim() ?? "");
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? null : Number(match[3]),
  };
}

async function downloadAttempt(
  options: DownloadArchiveOptions,
  partialPath: string,
): Promise<void> {
  const { label, archive, fetchImpl, onBytes, timings, signal } = options;
  throwIfAborted(signal);
  let offset = await existingPartialSize(partialPath, archive);
  let hash = createHash("sha256");
  if (offset > 0) {
    // The bytes on disk are re-read rather than trusted: the final digest
    // covers them, and they are where any damage from the interruption lies.
    for await (const chunk of createReadStream(partialPath, { start: 0, end: offset - 1 })) {
      hash.update(chunk as Buffer);
    }
    onBytes(offset);
    if (offset === archive.size) {
      if (hash.digest("hex") === archive.sha256) return;
      throw failure(`${label} partial archive did not match the pinned manifest`, "restart");
    }
  }

  // The idle timeout aborts `controller`; the caller's signal aborts the same
  // request, and the catch below tells the two apart.
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), timings.idleTimeoutMs);
  };
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let response: Response | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let finished = false;
  try {
    resetIdle();
    const headers: Record<string, string> = { "user-agent": "OrkestratorV2 toolchain installer" };
    if (offset > 0) headers.range = `bytes=${offset}-`;
    response = await fetchImpl(archive.url, {
      redirect: "follow",
      signal: requestSignal,
      headers,
    });
    resetIdle();
    if (offset > 0 && response.status === 416) {
      throw failure(`${label} server refused to resume the download`, "restart");
    }
    if (!response.ok || !response.body) {
      throw failure(`${label} download failed with HTTP ${response.status}`, "transient");
    }
    assertDownloadLocation(label, archive, response, options.allowInsecureDownloadsForTests);

    let flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW;
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      if (offset === 0) {
        throw failure(
          `${label} server sent a partial response that was not requested`,
          "untrusted",
        );
      }
      if (
        !range ||
        range.start !== offset ||
        range.end !== archive.size - 1 ||
        (range.total !== null && range.total !== archive.size)
      ) {
        throw failure(`${label} server resumed the download at the wrong range`, "restart");
      }
      flags |= constants.O_APPEND;
    } else {
      // The server sent the whole archive: start the file again.
      if (offset > 0) {
        offset = 0;
        hash = createHash("sha256");
        onBytes(0);
      }
      flags |= constants.O_TRUNC;
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== archive.size - offset) {
      throw failure(`${label} archive size header did not match the pinned manifest`, "untrusted");
    }

    handle = await open(partialPath, flags, 0o600);
    reader = response.body.getReader();
    let received = offset;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      resetIdle();
      received += value.byteLength;
      if (received > archive.size) {
        throw failure(`${label} archive exceeded its pinned size`, "untrusted");
      }
      hash.update(value);
      await handle.writeFile(value);
      onBytes(received);
    }
    await handle.close();
    handle = null;

    if (received !== archive.size) {
      throw failure(`${label} archive was truncated`, "transient");
    }
    if (hash.digest("hex") !== archive.sha256) {
      throw failure(
        `${label} archive checksum did not match the pinned manifest`,
        offset > 0 ? "restart" : "untrusted",
      );
    }
  } catch (error) {
    // A user abort is reported as such, never as a stall, whatever the
    // interrupted read threw.
    if (signal?.aborted) throw abortError(signal);
    if (controller.signal.aborted && !(error as AttemptFailure).untrusted) {
      throw failure(
        `${label} download stalled: nothing received for ${Math.round(timings.idleTimeoutMs / 1_000)}s`,
        "transient",
      );
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
    await handle?.close().catch(() => undefined);
    // Release the connection of a response this attempt stopped reading.
    if (reader && !finished) await reader.cancel().catch(() => undefined);
    else if (!reader && response?.body) await response.body.cancel().catch(() => undefined);
  }
}

/**
 * Download `archive` to `archivePath`, resuming any partial an earlier attempt
 * left. Resolves only with a file of the pinned size and SHA-256.
 */
export async function downloadArchive(options: DownloadArchiveOptions): Promise<void> {
  const partialPath = partialDownloadPath(options.rootDir, options.archive);
  await mkdir(path.dirname(partialPath), { recursive: true, mode: 0o700 });
  const attempts = Math.max(1, options.timings.attempts);
  for (let attempt = 1; ; attempt += 1) {
    const startSize = await existingPartialSize(partialPath, options.archive);
    try {
      await downloadAttempt(options, partialPath);
      if (options.retainComplete) await copyFile(partialPath, options.archivePath);
      else await rename(partialPath, options.archivePath);
      return;
    } catch (error) {
      // Never retry after the caller aborted; the partial stays for a resume.
      if (options.signal?.aborted) throw abortError(options.signal);
      const attemptFailure = error as AttemptFailure;
      if (attemptFailure.untrusted || attemptFailure.restart) {
        await rm(partialPath, { force: true });
      }
      if (attemptFailure.untrusted || attempt >= attempts) throw error;
      if (!attemptFailure.restart && !isNetworkChangeAbort(error)) {
        const endSize = (await lstat(partialPath).catch(() => null))?.size ?? 0;
        if (endSize <= startSize) throw error;
      }
      await abortableDelay(options.timings.retryDelayMs * attempt, options.signal);
    }
  }
}

/**
 * Remove partial downloads no current archive can resume once they have sat
 * unused for a day. Another build pinning other versions may share this cache,
 * so an unreferenced partial is not removed the moment it is seen.
 */
export async function prunePartialDownloads(
  rootDir: string,
  archives: readonly ToolchainArchive[],
  now: number = Date.now(),
): Promise<void> {
  const directory = partialDownloadDirectory(rootDir);
  const keep = new Set(archives.map((archive) => `${archive.sha256}${PARTIAL_SUFFIX}`));
  const entries = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((name) => !keep.has(name))
      .map(async (name) => {
        const entryPath = path.join(directory, name);
        const info = await lstat(entryPath).catch(() => null);
        if (!info) return;
        if (info.isFile() && now - info.mtimeMs < UNREFERENCED_PARTIAL_RETENTION_MS) return;
        await rm(entryPath, { force: true, recursive: true }).catch(() => undefined);
      }),
  );
}
