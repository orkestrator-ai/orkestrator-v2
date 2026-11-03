/**
 * Verified-file stamps for the toolchain cache.
 *
 * Every launch used to SHA-256 every installed byte (about 1.2 GB) twice before
 * the backend could start. A stamp records what a file looked like when its
 * digest was last computed: device, inode, size, and modification and
 * status-change times in nanoseconds. A file whose metadata still matches its
 * stamp is reported with the recorded digest instead of being read again.
 *
 * Any write, replacement, rename-over, truncation, chmod or chown changes the
 * inode or ctime, and ctime cannot be set from user space, so a mismatch on any
 * field re-hashes the file. Two things are not covered by metadata, and are
 * handled explicitly:
 *
 * - A file changed within the timestamp granularity of the moment its stamp was
 *   taken ("racy" stamps, as in git's index). A stamp taken while the file's
 *   mtime or ctime was within `racyWindowMs` of the clock is never trusted on
 *   metadata alone; the file is hashed again, and re-stamped once it has aged.
 * - Someone able to write the data directory can also rewrite the stamp file.
 *   A full check, which ignores every persisted stamp, runs when the stamp file
 *   is missing or unreadable, when `fullCheckIntervalMs` has passed since the
 *   last one, when the clock moved backwards past it, and on an explicit repair.
 *
 * The store is read and written only while the cache-wide install lock is held.
 * Subset checks retain metadata-matching stamps for omitted tools. Removed or
 * changed files are pruned, and the entry limit bounds retained installation
 * history. Full checks discard all old stamps, including omitted tools.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export const STAMP_FILE = ".verified-stamps.json";
const STAMP_FORMAT_VERSION = 1;
const MAX_STAMP_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STAMP_ENTRIES = 20_000;
export const FULL_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;
export const RACY_STAMP_WINDOW_MS = 2_000;

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Anything that can report a file's SHA-256. */
export type FileDigests = {
  sha256(filePath: string): Promise<string>;
};

/** Hashes every time; used for staging files that never become stamps. */
export const directFileDigests: FileDigests = { sha256: sha256File };

export type FileStamp = {
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  /** When the stamp was taken, so a racy stamp can be recognised later. */
  stampedAtNs: string;
  sha256: string;
};

type StampFileContents = {
  version: typeof STAMP_FORMAT_VERSION;
  /** Epoch milliseconds of the last full check that completed successfully. */
  fullCheckAt: number;
  files: Record<string, FileStamp>;
  /**
   * Locally produced files (a re-signed macOS executable) mapped to the pinned
   * digest of the source they were produced from. Their own bytes are pinned
   * nowhere, so the stamp in `files` is the only record of them.
   */
  derived: Record<string, string>;
};

export type StampStoreOptions = {
  now?: () => number;
  fullCheckIntervalMs?: number;
  /**
   * How recently a file may have changed before its stamp is taken and still
   * be trusted on metadata alone. The clock is read in whole milliseconds, so
   * tests that stamp files they have just written pass a negative window.
   */
  racyWindowMs?: number;
  /** Ignore every persisted stamp, as an explicit repair asks for. */
  forceFullCheck?: boolean;
  /** Test seam that counts reads; production always hashes with `sha256File`. */
  hashFileForTests?: (filePath: string) => Promise<string>;
};

export type FileStampStore = FileDigests & {
  /** True when no persisted stamp is trusted in this run. */
  readonly fullCheck: boolean;
  /**
   * Whether `filePath` still holds the bytes it held when it was last stamped.
   * False when there is no stamp to compare with.
   */
  isUnchanged(filePath: string): Promise<boolean>;
  /** The pinned source digest a locally produced file was made from, if recorded. */
  derivedFrom(filePath: string): string | undefined;
  /** Stamp a locally produced file and remember which pinned source it came from. */
  recordDerived(filePath: string, sourceSha256: string): Promise<void>;
  /** Keep a still-valid derived record without producing the file again. */
  retainDerived(filePath: string): void;
  /**
   * Persist this run's stamps for files under `directories`. Called only after
   * the whole set verified; best-effort, since losing it costs one full check.
   */
  save(directories: readonly string[]): Promise<void>;
};

type BigStats = Awaited<ReturnType<typeof lstatBig>>;

function lstatBig(filePath: string) {
  return lstat(filePath, { bigint: true });
}

function metadataMatches(stamp: FileStamp, info: BigStats): boolean {
  return (
    info.isFile() &&
    stamp.dev === String(info.dev) &&
    stamp.ino === String(info.ino) &&
    stamp.size === Number(info.size) &&
    stamp.mtimeNs === String(info.mtimeNs) &&
    stamp.ctimeNs === String(info.ctimeNs)
  );
}

function sameMetadata(left: BigStats, right: BigStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isStampShape(value: unknown): value is FileStamp {
  if (!value || typeof value !== "object") return false;
  const stamp = value as Record<string, unknown>;
  return (
    typeof stamp.dev === "string" &&
    typeof stamp.ino === "string" &&
    typeof stamp.size === "number" &&
    Number.isSafeInteger(stamp.size) &&
    typeof stamp.mtimeNs === "string" &&
    typeof stamp.ctimeNs === "string" &&
    typeof stamp.stampedAtNs === "string" &&
    /^\d+$/.test(stamp.mtimeNs) &&
    /^\d+$/.test(stamp.ctimeNs) &&
    /^\d+$/.test(stamp.stampedAtNs) &&
    typeof stamp.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(stamp.sha256)
  );
}

async function readStampFile(filePath: string): Promise<StampFileContents | null> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.size > MAX_STAMP_FILE_BYTES) return null;
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<StampFileContents>;
    if (
      parsed.version !== STAMP_FORMAT_VERSION ||
      typeof parsed.fullCheckAt !== "number" ||
      !Number.isFinite(parsed.fullCheckAt) ||
      !parsed.files ||
      typeof parsed.files !== "object" ||
      !parsed.derived ||
      typeof parsed.derived !== "object"
    ) {
      return null;
    }
    const files: Record<string, FileStamp> = {};
    for (const [key, stamp] of Object.entries(parsed.files)) {
      if (isStampShape(stamp)) files[key] = stamp;
    }
    const derived: Record<string, string> = {};
    for (const [key, source] of Object.entries(parsed.derived)) {
      if (typeof source === "string" && /^[a-f0-9]{64}$/.test(source)) derived[key] = source;
    }
    return { version: STAMP_FORMAT_VERSION, fullCheckAt: parsed.fullCheckAt, files, derived };
  } catch {
    return null;
  }
}

function isUnder(filePath: string, directories: readonly string[]): boolean {
  return directories.some((directory) => filePath.startsWith(directory + path.sep));
}

/** Load the stamp store for one toolchain root. Never throws for a bad file. */
export async function openFileStampStore(
  rootDir: string,
  options: StampStoreOptions = {},
): Promise<FileStampStore> {
  const now = options.now ?? Date.now;
  const hashFile = options.hashFileForTests ?? sha256File;
  const fullCheckIntervalMs = options.fullCheckIntervalMs ?? FULL_CHECK_INTERVAL_MS;
  const racyWindowNs =
    BigInt(Math.trunc(options.racyWindowMs ?? RACY_STAMP_WINDOW_MS)) * 1_000_000n;
  const stampPath = path.join(rootDir, STAMP_FILE);
  const persisted = await readStampFile(stampPath);
  const startedAt = now();
  const fullCheck =
    options.forceFullCheck === true ||
    persisted === null ||
    startedAt - persisted.fullCheckAt >= fullCheckIntervalMs ||
    persisted.fullCheckAt > startedAt;
  // Persisted stamps are consulted only outside a full check; stamps taken in
  // this run are always usable, which is what spares the final verification.
  const previousFiles = fullCheck ? {} : (persisted?.files ?? {});
  const previousDerived = fullCheck ? {} : (persisted?.derived ?? {});
  const runFiles = new Map<string, FileStamp>();
  const runDerived = new Map<string, string>();

  const lookup = (filePath: string): FileStamp | undefined =>
    runFiles.get(filePath) ?? previousFiles[filePath];

  const isRacy = (stamp: FileStamp): boolean => {
    const stampedAt = BigInt(stamp.stampedAtNs);
    const newest =
      BigInt(stamp.mtimeNs) > BigInt(stamp.ctimeNs) ? BigInt(stamp.mtimeNs) : BigInt(stamp.ctimeNs);
    return stampedAt - newest < racyWindowNs;
  };

  const hashAndStamp = async (filePath: string, before: BigStats): Promise<string> => {
    const stampedAtNs = BigInt(now()) * 1_000_000n;
    const digest = await hashFile(filePath);
    const after = await lstatBig(filePath).catch(() => null);
    if (after && before.isFile() && after.isFile() && sameMetadata(before, after)) {
      runFiles.set(filePath, {
        dev: String(after.dev),
        ino: String(after.ino),
        size: Number(after.size),
        mtimeNs: String(after.mtimeNs),
        ctimeNs: String(after.ctimeNs),
        stampedAtNs: String(stampedAtNs),
        sha256: digest,
      });
    } else {
      // The file moved under the hash; its digest describes no single state.
      runFiles.delete(filePath);
    }
    return digest;
  };

  const sha256 = async (filePath: string): Promise<string> => {
    const info = await lstatBig(filePath);
    const stamp = lookup(filePath);
    if (stamp && metadataMatches(stamp, info) && !isRacy(stamp)) {
      runFiles.set(filePath, stamp);
      return stamp.sha256;
    }
    return hashAndStamp(filePath, info);
  };

  return {
    fullCheck,
    sha256,
    async isUnchanged(filePath) {
      const stamp = lookup(filePath);
      if (!stamp) return false;
      try {
        return (await sha256(filePath)) === stamp.sha256;
      } catch {
        return false;
      }
    },
    derivedFrom(filePath) {
      return runDerived.get(filePath) ?? previousDerived[filePath];
    },
    async recordDerived(filePath, sourceSha256) {
      const info = await lstatBig(filePath);
      await hashAndStamp(filePath, info);
      if (runFiles.has(filePath)) runDerived.set(filePath, sourceSha256);
      else runDerived.delete(filePath);
    },
    retainDerived(filePath) {
      const source = previousDerived[filePath];
      if (source !== undefined && runFiles.has(filePath)) runDerived.set(filePath, source);
    },
    async save(directories) {
      const files: Record<string, FileStamp> = {};
      let count = 0;
      for (const [filePath, stamp] of runFiles) {
        if (!isUnder(filePath, directories)) continue;
        if (count >= MAX_STAMP_ENTRIES) break;
        files[filePath] = stamp;
        count += 1;
      }
      // Prioritise this run's verified set, then retain omitted tools only.
      // Never resurrect an unchecked entry inside the set just verified.
      for (const [filePath, stamp] of Object.entries(previousFiles)) {
        if (count >= MAX_STAMP_ENTRIES) break;
        if (isUnder(filePath, directories) || !isUnder(filePath, [rootDir])) continue;
        const info = await lstatBig(filePath).catch(() => null);
        if (!info || !metadataMatches(stamp, info)) continue;
        files[filePath] = stamp;
        count += 1;
      }
      const derived: Record<string, string> = {};
      for (const [filePath, source] of Object.entries(previousDerived)) {
        if (files[filePath] && !isUnder(filePath, directories)) derived[filePath] = source;
      }
      for (const [filePath, source] of runDerived) {
        if (files[filePath]) derived[filePath] = source;
      }
      const contents: StampFileContents = {
        version: STAMP_FORMAT_VERSION,
        fullCheckAt: fullCheck ? startedAt : persisted!.fullCheckAt,
        files,
        derived,
      };
      const temporaryPath = path.join(rootDir, `.${STAMP_FILE}-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(contents));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, stampPath);
      } catch {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    },
  };
}
