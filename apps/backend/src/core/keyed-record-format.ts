import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * On-disk format shared by the keyed record store and the record manifest.
 *
 * One record is one private file: a single line of compact JSON header, a
 * newline, then the opaque payload bytes. The header is small and bounded so
 * enumeration, quota repair and compare-and-swap can read it without buffering
 * or checksumming the payload. The payload checksum is verified only when that
 * record is actually loaded.
 *
 * Filenames are a fixed hash of the namespace and full logical key. The hash
 * makes the filename safe (no traversal characters can come from a key); it is
 * not authorization. Every decoded header must still name the requested key,
 * schema and retention class before its payload is returned.
 */
export const KEYED_RECORD_FORMAT = "ork-keyed-record-v1";
export const KEYED_RECORD_EXTENSION = ".rec";
export const KEYED_RECORD_PREVIOUS_EXTENSION = ".prev";
export const KEYED_RECORD_TEMP_EXTENSION = ".tmp";
export const KEYED_RECORD_DEFAULT_MAX_HEADER_BYTES = 4 * 1024;
const MAX_KEY_LENGTH = 1_024;
const MAX_OWNER_ATTRIBUTES = 8;
const MAX_OWNER_NAME_LENGTH = 64;
const MAX_OWNER_VALUE_LENGTH = 256;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * `durable` records fsync file and directory and keep one validated previous
 * generation. `cache` records are regenerable: they skip the disk barriers and
 * a corrupt payload is an explicit miss, never a recovered older copy.
 */
export type RecordRetentionClass = "cache" | "durable";

export interface KeyedRecordHeader {
  format: typeof KEYED_RECORD_FORMAT;
  schema: string;
  key: string;
  /** Small owner attributes (for example an environment id) for metadata-only filtering. */
  owner: Record<string, string>;
  revision: number;
  byteLength: number;
  /** sha256 hex of the payload bytes. */
  checksum: string;
  retentionClass: RecordRetentionClass;
  /** Milliseconds since the epoch; eviction ordering only, never authority. */
  updatedAt: number;
  /**
   * Bytes this record accounts for in the namespace quota when it differs from
   * the payload itself (a manifest accounts for the chunks it references).
   */
  accountedBytes?: number;
}

export type RecordCorruptReason =
  | "not-regular-file"
  | "oversized"
  | "replaced-during-read"
  | "malformed-header"
  | "identity-mismatch"
  | "length-mismatch"
  | "checksum-mismatch"
  | "unreadable";

export type RawRecordRead =
  | { status: "missing" }
  | { status: "corrupt"; reason: RecordCorruptReason }
  | { status: "ok"; header: KeyedRecordHeader; payload: Buffer; fingerprint: string };

export type RawHeaderRead =
  | { status: "missing" }
  | { status: "corrupt"; reason: RecordCorruptReason; bytes: number }
  | { status: "ok"; header: KeyedRecordHeader; bytes: number; fingerprint: string };

export interface RecordIdentity {
  schema: string;
  key: string;
  retentionClass: RecordRetentionClass;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Fixed-length filename stem for one logical key inside one namespace. */
export function recordFileStem(namespace: string, key: string): string {
  return createHash("sha256").update(namespace).update("\0").update(key).digest("hex");
}

export function isRecordFileStem(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function assertValidRecordKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new Error("Keyed record key is invalid");
  }
}

export function normalizeOwner(owner: Record<string, string> | undefined): Record<string, string> {
  const entries = Object.entries(owner ?? {});
  if (entries.length > MAX_OWNER_ATTRIBUTES) throw new Error("Keyed record owner is too large");
  const normalized: Record<string, string> = {};
  for (const [name, value] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (
      name.length === 0 ||
      name.length > MAX_OWNER_NAME_LENGTH ||
      typeof value !== "string" ||
      value.length > MAX_OWNER_VALUE_LENGTH
    ) {
      throw new Error("Keyed record owner attribute is invalid");
    }
    normalized[name] = value;
  }
  return normalized;
}

export function encodeRecordFile(header: KeyedRecordHeader, payload: Buffer): Buffer {
  const encodedHeader = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  return Buffer.concat([encodedHeader, payload]);
}

export function isKeyedRecordHeader(value: unknown): value is KeyedRecordHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const header = value as Record<string, unknown>;
  if (
    header.format !== KEYED_RECORD_FORMAT ||
    typeof header.schema !== "string" ||
    header.schema.length === 0 ||
    typeof header.key !== "string" ||
    header.key.length === 0 ||
    header.key.length > MAX_KEY_LENGTH ||
    !header.owner ||
    typeof header.owner !== "object" ||
    Array.isArray(header.owner) ||
    typeof header.revision !== "number" ||
    !Number.isSafeInteger(header.revision) ||
    header.revision <= 0 ||
    typeof header.byteLength !== "number" ||
    !Number.isSafeInteger(header.byteLength) ||
    header.byteLength < 0 ||
    typeof header.checksum !== "string" ||
    !/^[0-9a-f]{64}$/.test(header.checksum) ||
    (header.retentionClass !== "cache" && header.retentionClass !== "durable") ||
    typeof header.updatedAt !== "number" ||
    !Number.isFinite(header.updatedAt) ||
    (header.accountedBytes !== undefined &&
      (typeof header.accountedBytes !== "number" ||
        !Number.isSafeInteger(header.accountedBytes) ||
        header.accountedBytes < 0))
  ) {
    return false;
  }
  const owner = Object.entries(header.owner as Record<string, unknown>);
  return (
    owner.length <= MAX_OWNER_ATTRIBUTES &&
    owner.every(
      ([name, entry]) =>
        name.length > 0 &&
        name.length <= MAX_OWNER_NAME_LENGTH &&
        typeof entry === "string" &&
        entry.length <= MAX_OWNER_VALUE_LENGTH,
    )
  );
}

function headerMatchesIdentity(header: KeyedRecordHeader, identity: RecordIdentity): boolean {
  return (
    header.schema === identity.schema &&
    header.key === identity.key &&
    header.retentionClass === identity.retentionClass
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

export function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Opens a record path for reading without following a final symlink, and
 * proves the descriptor is the regular file that was lstat'ed. A swapped-in
 * symlink, FIFO or directory is reported as corrupt rather than followed.
 */
async function openPinnedRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<
  | { status: "missing" }
  | { status: "corrupt"; reason: RecordCorruptReason; bytes: number }
  | { status: "ok"; handle: fs.FileHandle; size: number; fingerprint: string }
> {
  let named;
  try {
    named = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) return { status: "missing" };
    return { status: "corrupt", reason: "unreadable", bytes: 0 };
  }
  if (!named.isFile()) return { status: "corrupt", reason: "not-regular-file", bytes: 0 };
  // Admission before any buffering: a file already past the cap is refused
  // without allocating for it.
  if (named.size > BigInt(maxBytes)) {
    return { status: "corrupt", reason: "oversized", bytes: Number(named.size) };
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (isMissingPathError(error)) return { status: "missing" };
    return { status: "corrupt", reason: "not-regular-file", bytes: Number(named.size) };
  }
  try {
    const pinned = await handle.stat({ bigint: true });
    if (!pinned.isFile() || pinned.ino !== named.ino || pinned.dev !== named.dev) {
      await handle.close();
      return { status: "corrupt", reason: "replaced-during-read", bytes: Number(named.size) };
    }
    return {
      status: "ok",
      handle,
      size: Number(pinned.size),
      fingerprint: `${pinned.dev}:${pinned.ino}:${pinned.size}:${pinned.mtimeNs}`,
    };
  } catch {
    await handle.close().catch(() => undefined);
    return { status: "corrupt", reason: "unreadable", bytes: Number(named.size) };
  }
}

/**
 * Reads at most `maxBytes + 1` bytes, counting as it goes. The stat above is
 * only admission: a writer that grows the file afterwards is still refused
 * once the counted bytes pass the cap, so the buffer can never exceed it.
 */
async function readCounted(handle: fs.FileHandle, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const want = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total);
    if (want <= 0) return null;
    const chunk = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(chunk, 0, want, total);
    if (bytesRead === 0) break;
    chunks.push(bytesRead === want ? chunk : chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) return null;
  }
  return Buffer.concat(chunks, total);
}

function splitHeader(
  bytes: Buffer,
  maxHeaderBytes: number,
): { header: KeyedRecordHeader; headerBytes: number } | null {
  const newline = bytes.indexOf(0x0a);
  if (newline <= 0 || newline > maxHeaderBytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
  } catch {
    return null;
  }
  return isKeyedRecordHeader(parsed) ? { header: parsed, headerBytes: newline + 1 } : null;
}

export interface BoundedReadLimits {
  maxHeaderBytes: number;
  maxPayloadBytes: number;
}

/** Full bounded read: header, payload length and checksum all verified. */
export async function readRecordFile(
  filePath: string,
  identity: RecordIdentity,
  limits: BoundedReadLimits,
): Promise<RawRecordRead> {
  const maxBytes = limits.maxHeaderBytes + 1 + limits.maxPayloadBytes;
  const opened = await openPinnedRegularFile(filePath, maxBytes);
  if (opened.status === "missing") return opened;
  if (opened.status === "corrupt") return { status: "corrupt", reason: opened.reason };
  let bytes: Buffer | null;
  try {
    bytes = await readCounted(opened.handle, maxBytes);
  } catch {
    return { status: "corrupt", reason: "unreadable" };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
  if (!bytes) return { status: "corrupt", reason: "oversized" };
  const split = splitHeader(bytes, limits.maxHeaderBytes);
  if (!split) return { status: "corrupt", reason: "malformed-header" };
  if (!headerMatchesIdentity(split.header, identity)) {
    return { status: "corrupt", reason: "identity-mismatch" };
  }
  const payload = bytes.subarray(split.headerBytes);
  if (payload.length !== split.header.byteLength || payload.length > limits.maxPayloadBytes) {
    return { status: "corrupt", reason: "length-mismatch" };
  }
  if (sha256Hex(payload) !== split.header.checksum) {
    return { status: "corrupt", reason: "checksum-mismatch" };
  }
  return { status: "ok", header: split.header, payload, fingerprint: opened.fingerprint };
}

/**
 * Metadata-only read: at most `maxHeaderBytes + 1` bytes, no payload buffer
 * and no checksum. `identity` is optional so enumeration can classify a file
 * whose key it does not know yet; callers then check `header.key` themselves.
 */
export async function readRecordHeader(
  filePath: string,
  expected: { schema: string; retentionClass: RecordRetentionClass; key?: string },
  limits: BoundedReadLimits,
): Promise<RawHeaderRead> {
  const opened = await openPinnedRegularFile(
    filePath,
    limits.maxHeaderBytes + 1 + limits.maxPayloadBytes,
  );
  if (opened.status !== "ok") return opened;
  let prefix: Buffer;
  try {
    const want = Math.min(opened.size, limits.maxHeaderBytes + 1);
    prefix = Buffer.allocUnsafe(want);
    const { bytesRead } = await opened.handle.read(prefix, 0, want, 0);
    prefix = prefix.subarray(0, bytesRead);
  } catch {
    return { status: "corrupt", reason: "unreadable", bytes: opened.size };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
  const split = splitHeader(prefix, limits.maxHeaderBytes);
  if (!split) return { status: "corrupt", reason: "malformed-header", bytes: opened.size };
  if (
    split.header.schema !== expected.schema ||
    split.header.retentionClass !== expected.retentionClass ||
    (expected.key !== undefined && split.header.key !== expected.key)
  ) {
    return { status: "corrupt", reason: "identity-mismatch", bytes: opened.size };
  }
  if (opened.size !== split.headerBytes + split.header.byteLength) {
    return { status: "corrupt", reason: "length-mismatch", bytes: opened.size };
  }
  return {
    status: "ok",
    header: split.header,
    bytes: opened.size,
    fingerprint: opened.fingerprint,
  };
}

/** Bounded read of a small private metadata file (index, markers, progress). */
export async function readBoundedFile(
  filePath: string,
  maxBytes: number,
): Promise<
  | { status: "missing" }
  | { status: "corrupt"; reason: RecordCorruptReason }
  | { status: "ok"; bytes: Buffer; fingerprint: string }
> {
  const opened = await openPinnedRegularFile(filePath, maxBytes);
  if (opened.status === "missing") return opened;
  if (opened.status === "corrupt") return { status: "corrupt", reason: opened.reason };
  try {
    const bytes = await readCounted(opened.handle, maxBytes);
    if (!bytes) return { status: "corrupt", reason: "oversized" };
    return { status: "ok", bytes, fingerprint: opened.fingerprint };
  } catch {
    return { status: "corrupt", reason: "unreadable" };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** Cheap change detector for decoded-value caches: one lstat, no read. */
export async function statFingerprint(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(filePath, { bigint: true });
    if (!stat.isFile()) return null;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return null;
  }
}

/**
 * Creates the namespace directory privately and refuses to operate through a
 * symlinked or non-directory namespace. The data directory itself is owned by
 * the storage layer; this protects the one directory this primitive owns.
 */
export async function ensureNamespaceDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error("Keyed record namespace must be absolute");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Keyed record namespace is not a private directory");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Keyed record namespace is owned by another user");
  }
  if ((stat.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
}

/**
 * Writes `contents` to a brand-new private file (O_EXCL, no symlink follow).
 * `durable` flushes the file before returning.
 */
export async function writeExclusivePrivateFile(
  filePath: string,
  contents: Buffer,
  durable: boolean,
): Promise<void> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents);
    // An inherited umask can widen nothing here, but an explicit chmod keeps
    // the mode private even where open() ignores the requested mode.
    await handle.chmod(0o600);
    if (durable) await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Flushes a directory entry after rename. POSIX platforms (Linux, macOS)
 * support fsync on a directory descriptor; Windows cannot open a directory
 * this way, so durable records there rely on the rename alone (documented).
 */
export async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EISDIR" && code !== "EPERM" && code !== "EINVAL" && code !== "EACCES") {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function tempFileName(stem: string, unique: string): string {
  return `.${stem}.${unique}${KEYED_RECORD_TEMP_EXTENSION}`;
}
