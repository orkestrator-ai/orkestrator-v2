/**
 * Safe repository export of design canvases (`.orkdes` files).
 *
 * The generic `write_local_file` / `write_container_file` writers overwrite
 * unconditionally (and the container one truncates the destination before the
 * payload has arrived). Export instead follows the destination write protocol
 * in docs/improvements/design-space/plan/05-safe-saving-and-export.md:
 *
 * 1. validate a repository-root file name;
 * 2. serialize Orkestrator writers per destination;
 * 3. write a unique same-directory temporary file (0600, fsync);
 * 4. re-check the expected destination state immediately before publishing;
 * 5. publish atomically — `link()` for "absent" (atomic no-clobber), `rename()`
 *    for "present" — then fsync the directory where supported;
 * 6. remove only this operation's temporary file on failure.
 *
 * Guarantee for replacing an existing file: the replace path is
 * check-then-rename, NOT an atomic compare-and-swap against arbitrary external
 * writers (an editor or agent in the worktree). Orkestrator's own exports are
 * serialized, so they cannot race each other; an external write landing in the
 * narrow window between the digest check and the rename would be replaced. To
 * keep that recoverable, the bytes that were verified and then overwritten are
 * returned as `previous` so the caller can keep a private backup.
 *
 * Every failure is a content-free `DesignError`; messages name at most the
 * relative export path, never an absolute host path or file contents.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { DesignError } from "./design-errors.js";

export type DesignExportDestination =
  | { kind: "local"; worktreePath: string }
  | { kind: "container"; containerId: string };

/** Repository-root file names only; nested directories are deliberately not supported yet. */
export const DESIGN_EXPORT_PATH = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.orkdes$/;
/** Largest v1 document (4 MiB) plus envelope headroom. */
export const DESIGN_EXPORT_MAX_BYTES = 4 * 1024 * 1024 + 64 * 1024;
export const DESIGN_EXPORT_CONTAINER_TIMEOUT_MS = 30_000;
const CONTAINER_WORKSPACE_ROOT = "/workspace";
/** Plain piped spawn. Deliberately not `shell.ts`, whose imports need Bun-only FFI. */
const spawnCommand: DesignExportSpawn = (command, args) => spawn(command, args, { stdio: "pipe" });
const MIN_HELPER_STDOUT_BYTES = 6 * 1024 * 1024;
const MAX_HELPER_STDERR_BYTES = 8 * 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const ERRNO_PATTERN = /^E[A-Z0-9]{1,20}$/;

export interface DesignExportTargetState {
  exists: boolean;
  /** False when the target exists but is unreadable, not a regular file, or over the limit. */
  readable: boolean;
  digest?: string;
  bytes?: Buffer;
  symlink?: boolean;
}

export type DesignExportExpectation = { state: "absent" } | { state: "present"; digest: string };

export interface DesignExportWriteResult {
  digest: string;
  replaced: boolean;
  /** Bytes that were verified and then overwritten, for a private recoverable backup. */
  previous?: Buffer;
}

export type DesignExportSpawn = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

export interface DesignExportInspectOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Test seam for the container transport; defaults to a piped `spawn`. */
  spawn?: DesignExportSpawn;
}

export interface DesignExportWriteOptions extends DesignExportInspectOptions {
  /** Test-only fault injection for the local writer. */
  faults?: { beforePublish?: () => void | Promise<void> };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function validateDesignExportPath(relativePath: string): string {
  if (typeof relativePath !== "string" || !DESIGN_EXPORT_PATH.test(relativePath)) {
    throw new DesignError(
      "invalid-input",
      "Design export path must be a repository-root file name ending in .orkdes",
      { details: { reason: "invalid-path" } },
    );
  }
  return relativePath;
}

export function designExportDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Suggests a default export file name: a sanitized human name plus a short
 * canvas-ID suffix, so repeated default names and names that sanitize to the
 * same string still produce distinct suggestions for distinct canvases.
 */
export function planDefaultDesignExportPath(name: string, canvasId: string): string {
  const trimSeparators = (value: string) => value.replace(/^[-_]+|[-_]+$/g, "");
  let base = trimSeparators(
    String(name ?? "")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/_{2,}/g, "_"),
  );
  base = trimSeparators(base.slice(0, 60));
  if (!base) base = "design";
  const compactId = String(canvasId ?? "")
    .replaceAll("-", "")
    .toLowerCase();
  const suffix = /^[0-9a-f]{8}/.test(compactId)
    ? compactId.slice(0, 8)
    : createHash("sha256")
        .update(String(canvasId ?? ""))
        .digest("hex")
        .slice(0, 8);
  return `${base}-${suffix}.orkdes`;
}

function resolveMaxBytes(maxBytes: number | undefined): number {
  const value = maxBytes ?? DESIGN_EXPORT_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DesignError("invalid-input", "Invalid design export size limit", {
      details: { reason: "invalid-limit" },
    });
  }
  return value;
}

function validateExpectation(expected: DesignExportExpectation): DesignExportExpectation {
  if (expected?.state === "absent") return expected;
  if (
    expected?.state === "present" &&
    typeof expected.digest === "string" &&
    DIGEST_PATTERN.test(expected.digest)
  ) {
    return expected;
  }
  throw new DesignError("invalid-input", "Invalid design export expectation", {
    details: { reason: "invalid-expectation" },
  });
}

function validateContainerId(containerId: string): string {
  if (typeof containerId !== "string" || !CONTAINER_ID_PATTERN.test(containerId)) {
    throw new DesignError("invalid-input", "Invalid container identifier", {
      details: { reason: "invalid-container" },
    });
  }
  return containerId;
}

type ExportReason =
  | "exists"
  | "missing"
  | "changed"
  | "not-regular"
  | "unreadable"
  | "symlink"
  | "too-large"
  | "invalid-path"
  | "invalid-limit"
  | "root-unavailable"
  | "root-changed"
  | "incomplete-input"
  | "link-unsupported"
  | "io";

const REASON_CODES: Record<ExportReason, "export-collision" | "invalid-input" | "storage"> = {
  exists: "export-collision",
  missing: "export-collision",
  changed: "export-collision",
  "not-regular": "export-collision",
  unreadable: "export-collision",
  symlink: "invalid-input",
  "too-large": "invalid-input",
  "invalid-path": "invalid-input",
  "invalid-limit": "invalid-input",
  "root-unavailable": "storage",
  "root-changed": "storage",
  "incomplete-input": "storage",
  "link-unsupported": "storage",
  io: "storage",
};

function reasonMessage(reason: ExportReason, relativePath: string, maxBytes: number): string {
  switch (reason) {
    case "exists":
      return `${relativePath} already exists; choose a new name or replace it explicitly`;
    case "missing":
      return `${relativePath} no longer exists; save it as a new file`;
    case "changed":
      return `${relativePath} changed since it was inspected; review it before replacing`;
    case "not-regular":
      return `${relativePath} is not a regular file`;
    case "unreadable":
      return `${relativePath} cannot be read safely for comparison`;
    case "symlink":
      return `Design export refuses to follow a symbolic link at ${relativePath}`;
    case "too-large":
      return `Design export exceeds ${maxBytes} bytes`;
    case "invalid-path":
      return "Design export path must be a repository-root file name ending in .orkdes";
    case "invalid-limit":
      return "Invalid design export size limit";
    case "root-unavailable":
      return "The repository is not available for export";
    case "root-changed":
      return "The repository changed during export; please try again";
    case "incomplete-input":
      return "The export payload was not received completely; nothing was published";
    case "link-unsupported":
      return "The repository filesystem does not support safe no-clobber export";
    case "io":
      return `Design export to ${relativePath} failed`;
  }
}

function exportError(
  reason: ExportReason,
  relativePath: string,
  maxBytes: number,
  errno?: string,
): DesignError {
  return new DesignError(REASON_CODES[reason], reasonMessage(reason, relativePath, maxBytes), {
    details: {
      reason,
      path: relativePath,
      ...(errno && ERRNO_PATTERN.test(errno) ? { errno } : {}),
    },
  });
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

// ---------------------------------------------------------------------------
// Per-destination serialization
// ---------------------------------------------------------------------------

const destinationLocks = new Map<string, Promise<void>>();

async function withDestinationLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = destinationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  destinationLocks.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (destinationLocks.get(key) === tail) destinationLocks.delete(key);
  }
}

function localLockKey(canonicalRoot: string, relativePath: string): string {
  // Case-folding filesystems map differently-cased names to one file.
  const name =
    process.platform === "darwin" || process.platform === "win32"
      ? relativePath.toLowerCase()
      : relativePath;
  return `local:${path.join(canonicalRoot, name)}`;
}

// ---------------------------------------------------------------------------
// Local destination
// ---------------------------------------------------------------------------

interface LocalRoot {
  canonicalRoot: string;
  rootStats: Stats;
  target: string;
}

async function resolveLocalRoot(
  worktreePath: string,
  relativePath: string,
  maxBytes: number,
): Promise<LocalRoot> {
  try {
    const canonicalRoot = await fs.realpath(worktreePath);
    const rootStats = await fs.lstat(canonicalRoot);
    if (!rootStats.isDirectory()) throw new Error("not a directory");
    return { canonicalRoot, rootStats, target: path.join(canonicalRoot, relativePath) };
  } catch (error) {
    throw exportError("root-unavailable", relativePath, maxBytes, errnoOf(error));
  }
}

async function lstatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return null;
    throw error;
  }
}

type BoundedRead =
  | { kind: "bytes"; bytes: Buffer }
  | { kind: "missing" }
  | { kind: "symlink" }
  | { kind: "unreadable" };

/** Reads one regular file through a no-follow descriptor, bounded to `maxBytes`. */
async function readLocalBounded(target: string, maxBytes: number): Promise<BoundedRead> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP" || code === "EMLINK") return { kind: "symlink" };
    return { kind: "unreadable" };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) return { kind: "unreadable" };
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) return { kind: "unreadable" };
    return { kind: "bytes", bytes: Buffer.concat(chunks, total) };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  // Directory fsync makes the new name durable where supported. The file is
  // already published at this point, so any failure (EISDIR/EPERM/EINVAL on
  // platforms without directory fsync, or otherwise) must not report failure.
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // best effort
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspectLocal(
  worktreePath: string,
  relativePath: string,
  maxBytes: number,
): Promise<DesignExportTargetState> {
  const { target } = await resolveLocalRoot(worktreePath, relativePath, maxBytes);
  let stats: Stats | null;
  try {
    stats = await lstatOrNull(target);
  } catch {
    return { exists: true, readable: false };
  }
  if (!stats) return { exists: false, readable: false };
  if (stats.isSymbolicLink()) return { exists: true, readable: false, symlink: true };
  if (!stats.isFile()) return { exists: true, readable: false };
  const current = await readLocalBounded(target, maxBytes);
  switch (current.kind) {
    case "missing":
      return { exists: false, readable: false };
    case "symlink":
      return { exists: true, readable: false, symlink: true };
    case "unreadable":
      return { exists: true, readable: false };
    case "bytes":
      return {
        exists: true,
        readable: true,
        digest: designExportDigest(current.bytes),
        bytes: current.bytes,
      };
  }
}

const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

async function writeLocal(
  worktreePath: string,
  relativePath: string,
  bytes: Buffer,
  expected: DesignExportExpectation,
  maxBytes: number,
  faults: DesignExportWriteOptions["faults"],
): Promise<DesignExportWriteResult> {
  const { canonicalRoot, rootStats, target } = await resolveLocalRoot(
    worktreePath,
    relativePath,
    maxBytes,
  );
  return withDestinationLock(localLockKey(canonicalRoot, relativePath), async () => {
    const fail = (reason: ExportReason, errno?: string) =>
      exportError(reason, relativePath, maxBytes, errno);
    let tempPath: string | undefined;
    try {
      const before = await lstatOrNull(target);
      if (before?.isSymbolicLink()) throw fail("symlink");
      if (before && !before.isFile()) throw fail("not-regular");
      if (expected.state === "absent" && before) throw fail("exists");
      if (expected.state === "present" && !before) throw fail("missing");

      const candidate = path.join(canonicalRoot, `.${relativePath}.${randomUUID()}.tmp`);
      const handle = await fs.open(candidate, "wx", 0o600);
      tempPath = candidate;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Repository files are normally world-readable; mode 0600 was only for
      // the private, partially written temporary file.
      await fs.chmod(tempPath, 0o644);

      await faults?.beforePublish?.();

      const rootNow = await fs.lstat(canonicalRoot);
      if (
        rootNow.isSymbolicLink() ||
        rootNow.dev !== rootStats.dev ||
        rootNow.ino !== rootStats.ino
      ) {
        throw fail("root-changed");
      }

      let previous: Buffer | undefined;
      if (expected.state === "absent") {
        // link() never replaces an existing name: atomic no-clobber publish.
        try {
          await fs.link(tempPath, target);
        } catch (error) {
          const code = errnoOf(error);
          if (code === "EEXIST") throw fail("exists");
          if (code && LINK_UNSUPPORTED.has(code)) throw fail("link-unsupported", code);
          throw error;
        }
      } else {
        // Check-then-rename: see the module comment for the guarantee.
        const current = await readLocalBounded(target, maxBytes);
        if (current.kind === "symlink") throw fail("symlink");
        if (current.kind === "missing") throw fail("missing");
        if (current.kind === "unreadable") throw fail("unreadable");
        if (designExportDigest(current.bytes) !== expected.digest) throw fail("changed");
        previous = current.bytes;
        await fs.rename(tempPath, target);
        tempPath = undefined;
      }
      await syncDirectoryBestEffort(canonicalRoot);
      return {
        digest: designExportDigest(bytes),
        replaced: expected.state === "present",
        ...(previous ? { previous } : {}),
      };
    } catch (error) {
      if (error instanceof DesignError) throw error;
      throw fail("io", errnoOf(error));
    } finally {
      // For "absent" the published name is a second link to the same inode, so
      // removing the temporary name is always correct. Only this op's temp.
      if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// Container destination: owned helpers run with `docker exec -i ... node -e`
// ---------------------------------------------------------------------------

const CONTAINER_HELPER_PRELUDE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.orkdes$/;
let emitted = false;
function emit(result) {
  if (emitted) return;
  emitted = true;
  process.stdout.write(JSON.stringify(result) + "\n");
}
function fail(code, reason) {
  const error = new Error(reason);
  error.designCode = code;
  error.designReason = reason;
  throw error;
}
function run(step) {
  try {
    emit(Object.assign({ ok: true }, step()));
  } catch (error) {
    const errno = error && typeof error.code === "string" ? error.code : undefined;
    emit({
      ok: false,
      code: (error && error.designCode) || "storage",
      reason: (error && error.designReason) || "io",
      errno,
    });
    process.exitCode = 1;
  }
}
function digestOf(bytes) {
  return "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
}
function resolveTarget(rootArg, rel, maxBytes) {
  if (typeof rel !== "string" || !NAME.test(rel)) fail("invalid-input", "invalid-path");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail("invalid-input", "invalid-limit");
  let root;
  let rootStats;
  try {
    root = fs.realpathSync(rootArg);
    rootStats = fs.lstatSync(root);
  } catch {
    fail("storage", "root-unavailable");
  }
  if (!rootStats.isDirectory()) fail("storage", "root-unavailable");
  const target = path.join(root, rel);
  if (path.dirname(target) !== root) fail("invalid-input", "invalid-path");
  return { root, rootStats, target };
}
function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}
function readBounded(target, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
    );
  } catch (error) {
    const code = error && error.code;
    if (code === "ENOENT") return { missing: true };
    if (code === "ELOOP" || code === "EMLINK") return { symlink: true };
    return { unreadable: true };
  }
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size > maxBytes) return { unreadable: true };
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maxBytes + 1 - total));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) return { unreadable: true };
    return { bytes: Buffer.concat(chunks, total) };
  } catch {
    return { unreadable: true };
  } finally {
    fs.closeSync(fd);
  }
}
function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // best effort: the file is already published
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}
`;

/**
 * Container inspector. argv: <root> <relativePath> <maxBytes>.
 * Prints one JSON line: {ok, exists, readable, digest?, symlink?, bytes?(base64)}.
 */
export const DESIGN_EXPORT_CONTAINER_INSPECTOR = `${CONTAINER_HELPER_PRELUDE}
const [rootArg, rel, maxArg] = process.argv.slice(1);
run(() => {
  const maxBytes = Number(maxArg);
  const { target } = resolveTarget(rootArg, rel, maxBytes);
  let stats;
  try {
    stats = lstatOrNull(target);
  } catch {
    return { exists: true, readable: false };
  }
  if (!stats) return { exists: false, readable: false };
  if (stats.isSymbolicLink()) return { exists: true, readable: false, symlink: true };
  if (!stats.isFile()) return { exists: true, readable: false };
  const current = readBounded(target, maxBytes);
  if (current.missing) return { exists: false, readable: false };
  if (current.symlink) return { exists: true, readable: false, symlink: true };
  if (!current.bytes) return { exists: true, readable: false };
  return {
    exists: true,
    readable: true,
    digest: digestOf(current.bytes),
    bytes: current.bytes.toString("base64"),
  };
});
`.trim();

/**
 * Container writer. argv: <root> <relativePath> <absent|present>
 * <expectedDigest|-> <maxBytes> <contentDigest>; the payload arrives on stdin.
 * The content digest lets the helper refuse a truncated stream (for example a
 * dropped connection) instead of publishing a partial file.
 * Prints one JSON line: {ok:true,digest,replaced,previous?} or {ok:false,code,reason,errno?}.
 */
export const DESIGN_EXPORT_CONTAINER_WRITER = `${CONTAINER_HELPER_PRELUDE}
const [rootArg, rel, mode, expectedDigest, maxArg, contentDigest] = process.argv.slice(1);
const maxBytes = Number(maxArg);
function publish(input) {
  const { root, rootStats, target } = resolveTarget(rootArg, rel, maxBytes);
  const before = lstatOrNull(target);
  if (before && before.isSymbolicLink()) fail("invalid-input", "symlink");
  if (before && !before.isFile()) fail("export-collision", "not-regular");
  if (mode === "absent" && before) fail("export-collision", "exists");
  if (mode === "present" && !before) fail("export-collision", "missing");
  let temp = path.join(root, "." + rel + "." + crypto.randomUUID() + ".tmp");
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      let offset = 0;
      while (offset < input.length) offset += fs.writeSync(fd, input, offset, input.length - offset);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(temp, 0o644);
    const rootNow = fs.lstatSync(root);
    if (rootNow.isSymbolicLink() || rootNow.dev !== rootStats.dev || rootNow.ino !== rootStats.ino) {
      fail("storage", "root-changed");
    }
    let previous;
    if (mode === "absent") {
      try {
        fs.linkSync(temp, target);
      } catch (error) {
        const code = error && error.code;
        if (code === "EEXIST") fail("export-collision", "exists");
        if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS") {
          fail("storage", "link-unsupported");
        }
        throw error;
      }
    } else {
      const current = readBounded(target, maxBytes);
      if (current.symlink) fail("invalid-input", "symlink");
      if (current.missing) fail("export-collision", "missing");
      if (!current.bytes) fail("export-collision", "unreadable");
      if (digestOf(current.bytes) !== expectedDigest) fail("export-collision", "changed");
      previous = current.bytes;
      fs.renameSync(temp, target);
      temp = undefined;
    }
    syncDirectory(root);
    const result = { digest: digestOf(input), replaced: mode === "present" };
    if (previous) result.previous = previous.toString("base64");
    return result;
  } finally {
    if (temp !== undefined) {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
}
let argumentsValid = false;
try {
  resolveTarget(rootArg, rel, maxBytes);
  if (mode !== "absent" && mode !== "present") fail("invalid-input", "invalid-path");
  argumentsValid = true;
} catch (error) {
  run(() => {
    throw error;
  });
}
if (argumentsValid) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  process.stdin.on("data", (chunk) => {
    if (tooLarge) return;
    total += chunk.length;
    if (total > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  process.stdin.on("error", () => run(() => fail("storage", "incomplete-input")));
  process.stdin.on("end", () =>
    run(() => {
      if (tooLarge) fail("invalid-input", "too-large");
      const input = Buffer.concat(chunks, total);
      if (digestOf(input) !== contentDigest) fail("storage", "incomplete-input");
      return publish(input);
    }),
  );
}
`.trim();

interface HelperOutcome {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
  /** The docker client itself could not be started; nothing ran. */
  notStarted: boolean;
}

function runContainerHelper(
  spawnFn: DesignExportSpawn,
  containerId: string,
  script: string,
  args: string[],
  input: Buffer | null,
  timeoutMs: number,
  maxStdoutBytes: number,
): Promise<HelperOutcome> {
  return new Promise<HelperOutcome>((resolve) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    const finish = (notStarted = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr,
        timedOut,
        overflow,
        notStarted,
      });
    };
    const kill = () => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    // Resolve on the deadline even if the child never reports `close`: the
    // caller's lifetime is bounded regardless of the docker client's behaviour.
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish();
    }, timeoutMs);
    let spawned: ChildProcessWithoutNullStreams;
    try {
      spawned = spawnFn("docker", [
        "exec",
        "-i",
        containerId,
        "node",
        "-e",
        script,
        "--",
        CONTAINER_WORKSPACE_ROOT,
        ...args,
      ]);
    } catch {
      finish(true);
      return;
    }
    child = spawned;
    spawned.stdout.on("data", (chunk: Buffer) => {
      if (overflow || settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        overflow = true;
        stdout.length = 0;
        stdoutBytes = 0;
        kill();
        finish();
        return;
      }
      stdout.push(chunk);
    });
    spawned.stderr.on("data", (chunk: Buffer) => {
      // Kept only to classify docker client errors; never surfaced.
      if (stderr.length < MAX_HELPER_STDERR_BYTES) {
        stderr += chunk.toString("utf8").slice(0, MAX_HELPER_STDERR_BYTES - stderr.length);
      }
    });
    spawned.stdout.on("error", () => undefined);
    spawned.stderr.on("error", () => undefined);
    // EPIPE when the helper exits early (for example on invalid arguments).
    spawned.stdin.on("error", () => undefined);
    spawned.once("error", () => finish(spawned.pid === undefined));
    spawned.once("close", () => finish());
    try {
      spawned.stdin.end(input ?? undefined);
    } catch {
      // surfaced through `error`/`close`
    }
  });
}

function parseHelperLine(stdout: string): Record<string, unknown> | null {
  const line = stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decodeBase64(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value) || value.length % 4 !== 0) {
    return null;
  }
  if (value.length > Math.ceil(maxBytes / 3) * 4) return null;
  return Buffer.from(value, "base64");
}

function helperFailure(
  parsed: Record<string, unknown>,
  relativePath: string,
  maxBytes: number,
): DesignError | null {
  if (parsed.ok !== false) return null;
  const reason = typeof parsed.reason === "string" ? parsed.reason : "io";
  const known = Object.hasOwn(REASON_CODES, reason) ? (reason as ExportReason) : "io";
  const errno = typeof parsed.errno === "string" ? parsed.errno : undefined;
  return exportError(known, relativePath, maxBytes, errno);
}

function isContainerUnavailable(stderr: string): boolean {
  return /Error response from daemon: .*(No such container|is not running|is paused|is restarting)/i.test(
    stderr,
  );
}

function stdoutLimit(maxBytes: number): number {
  return Math.max(MIN_HELPER_STDOUT_BYTES, Math.ceil(maxBytes / 3) * 4 + 64 * 1024);
}

async function inspectContainer(
  containerId: string,
  relativePath: string,
  maxBytes: number,
  timeoutMs: number,
  spawnFn: DesignExportSpawn,
): Promise<DesignExportTargetState> {
  const outcome = await runContainerHelper(
    spawnFn,
    containerId,
    DESIGN_EXPORT_CONTAINER_INSPECTOR,
    [relativePath, String(maxBytes)],
    null,
    timeoutMs,
    stdoutLimit(maxBytes),
  );
  const unavailable = () =>
    new DesignError("storage", `Could not inspect ${relativePath} in the container`, {
      details: {
        reason: outcome.timedOut ? "timeout" : "helper-failed",
        path: relativePath,
      },
    });
  if (outcome.timedOut || outcome.overflow || outcome.notStarted) throw unavailable();
  const parsed = parseHelperLine(outcome.stdout);
  if (!parsed) {
    if (isContainerUnavailable(outcome.stderr)) {
      throw exportError("root-unavailable", relativePath, maxBytes);
    }
    throw unavailable();
  }
  const failure = helperFailure(parsed, relativePath, maxBytes);
  if (failure) throw failure;
  if (parsed.ok !== true || typeof parsed.exists !== "boolean") throw unavailable();
  if (!parsed.exists) return { exists: false, readable: false };
  if (parsed.readable !== true) {
    return { exists: true, readable: false, ...(parsed.symlink === true ? { symlink: true } : {}) };
  }
  const bytes = decodeBase64(parsed.bytes, maxBytes);
  if (!bytes || bytes.byteLength > maxBytes) throw unavailable();
  const digest = designExportDigest(bytes);
  if (parsed.digest !== digest) throw unavailable();
  return { exists: true, readable: true, digest, bytes };
}

async function writeContainer(
  containerId: string,
  relativePath: string,
  bytes: Buffer,
  expected: DesignExportExpectation,
  maxBytes: number,
  timeoutMs: number,
  spawnFn: DesignExportSpawn,
): Promise<DesignExportWriteResult> {
  const digest = designExportDigest(bytes);
  return withDestinationLock(`container:${containerId}:${relativePath}`, async () => {
    const outcome = await runContainerHelper(
      spawnFn,
      containerId,
      DESIGN_EXPORT_CONTAINER_WRITER,
      [
        relativePath,
        expected.state,
        expected.state === "present" ? expected.digest : "-",
        String(maxBytes),
        digest,
      ],
      bytes,
      timeoutMs,
      stdoutLimit(maxBytes),
    );
    const unknown = (reason: string) =>
      new DesignError(
        "unknown-outcome",
        `The container export of ${relativePath} did not report a result; inspect the file before retrying`,
        { details: { reason, path: relativePath } },
      );
    if (outcome.notStarted) {
      throw exportError("root-unavailable", relativePath, maxBytes);
    }
    if (outcome.timedOut) throw unknown("timeout");
    if (outcome.overflow) throw unknown("output-overflow");
    const parsed = parseHelperLine(outcome.stdout);
    if (!parsed) {
      // A daemon-side refusal happens before the helper starts, so nothing ran.
      if (isContainerUnavailable(outcome.stderr)) {
        throw exportError("root-unavailable", relativePath, maxBytes);
      }
      throw unknown("no-result");
    }
    const failure = helperFailure(parsed, relativePath, maxBytes);
    if (failure) throw failure;
    if (
      parsed.ok !== true ||
      parsed.digest !== digest ||
      parsed.replaced !== (expected.state === "present")
    ) {
      throw unknown("invalid-result");
    }
    if (expected.state === "absent") {
      if (parsed.previous !== undefined) throw unknown("invalid-result");
      return { digest, replaced: false };
    }
    const previous = decodeBase64(parsed.previous, maxBytes);
    if (!previous || designExportDigest(previous) !== expected.digest) {
      throw unknown("invalid-result");
    }
    return { digest, replaced: true, previous };
  });
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function inspectDesignExportTarget(
  dest: DesignExportDestination,
  relativePath: string,
  options: DesignExportInspectOptions = {},
): Promise<DesignExportTargetState> {
  const rel = validateDesignExportPath(relativePath);
  const maxBytes = resolveMaxBytes(options.maxBytes);
  if (dest.kind === "local") return inspectLocal(dest.worktreePath, rel, maxBytes);
  return inspectContainer(
    validateContainerId(dest.containerId),
    rel,
    maxBytes,
    options.timeoutMs ?? DESIGN_EXPORT_CONTAINER_TIMEOUT_MS,
    options.spawn ?? spawnCommand,
  );
}

export async function writeDesignExport(
  dest: DesignExportDestination,
  relativePath: string,
  bytes: Buffer,
  expected: DesignExportExpectation,
  options: DesignExportWriteOptions = {},
): Promise<DesignExportWriteResult> {
  const rel = validateDesignExportPath(relativePath);
  const maxBytes = resolveMaxBytes(options.maxBytes);
  const expectation = validateExpectation(expected);
  if (!Buffer.isBuffer(bytes)) {
    throw new DesignError("invalid-input", "Design export payload must be bytes", {
      details: { reason: "invalid-payload" },
    });
  }
  if (bytes.byteLength > maxBytes) throw exportError("too-large", rel, maxBytes);
  if (dest.kind === "local") {
    return writeLocal(dest.worktreePath, rel, bytes, expectation, maxBytes, options.faults);
  }
  return writeContainer(
    validateContainerId(dest.containerId),
    rel,
    bytes,
    expectation,
    maxBytes,
    options.timeoutMs ?? DESIGN_EXPORT_CONTAINER_TIMEOUT_MS,
    options.spawn ?? spawnCommand,
  );
}
