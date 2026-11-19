import { constants, promises as fs, type Stats } from "node:fs";
import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";
import { FILE_WRITE_CONFLICT_MESSAGE } from "@orkestrator/protocol/file-write-precondition";
import { CommandFailedError, runCommandBuffer } from "./command-capture.js";
import { APP_SLUG } from "./constants.js";
import { assertNoNestedRepositories } from "./workspace-removal-preflight.js";

export const MAX_BINARY_FILE_BYTES = 10 * 1024 * 1024;
/** Keep whole-file editor payloads small enough for IPC and Monaco to handle safely. */
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_FILE_SIZE_LABEL = `${MAX_TEXT_FILE_BYTES / (1024 * 1024)} MB`;
export const MAX_WRITE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_BASE64_PAYLOAD_BYTES = Math.ceil(MAX_WRITE_FILE_BYTES / 3) * 4 + 4;

const CONTROL_PATH_CHARS = /[\0\r\n]/;

const ERRNO_ENOENT = 2;
const ERRNO_EEXIST = 17;
const ERRNO_EXDEV = 18;
const ERRNO_ENOTDIR = 20;
const ERRNO_ELOOP_LINUX = 40;
const ERRNO_ELOOP_DARWIN = 62;

type ConfinedPathTestHooks = {
  /** Tests use this to replace a checked pathname after parent handles are pinned. */
  afterDirectoriesOpened?: () => void | Promise<void>;
};

type ConfinedMoveTestHooks = ConfinedPathTestHooks;

function nulTerminated(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function directorySegments(relativeDirectory: string): string[] {
  return relativeDirectory === "." ? [] : relativeDirectory.split("/");
}

function assertPinnedDirectoryStillNamed(
  canonicalRoot: string,
  relativeDirectory: string,
  fd: number,
  message = "Workspace directory changed while the file was being moved; please try again",
): void {
  const namedPath =
    relativeDirectory === "." ? canonicalRoot : path.join(canonicalRoot, relativeDirectory);
  let named;
  try {
    named = fsSync.lstatSync(namedPath);
  } catch {
    throw new Error(message);
  }
  const pinned = fsSync.fstatSync(fd);
  if (
    named.isSymbolicLink() ||
    !named.isDirectory() ||
    named.dev !== pinned.dev ||
    named.ino !== pinned.ino
  ) {
    throw new Error(message);
  }
}

function isLoopOrNoFollowError(code: number): boolean {
  return code === ERRNO_ELOOP_LINUX || code === ERRNO_ELOOP_DARWIN;
}

export interface ConfinedMoveOptions {
  /** An in-place rename requires the source to match the kind the caller saw. */
  renameKind?: "file" | "folder";
}

/**
 * Atomically moves a regular file (or, when renaming in place, a folder)
 * without re-resolving mutable ancestors.
 *
 * Every parent directory is opened relative to an already-pinned descriptor
 * with O_NOFOLLOW, then the platform no-replace rename primitive operates on
 * those descriptors. A repository process may rename or replace a pathname,
 * but it cannot redirect the final operation outside the pinned directories.
 */
export async function moveConfinedFile(
  rootPath: string,
  sourcePath: string,
  destinationPath: string,
  testHooks: ConfinedMoveTestHooks = {},
  options: ConfinedMoveOptions = {},
): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Safe workspace file moves are not supported on this platform");
  }

  const source = validateRelativeFilePath(sourcePath, "sourcePath");
  const destination = validateRelativeFilePath(destinationPath, "destinationPath");
  const sourceParent = path.posix.dirname(source);
  const destinationParent = path.posix.dirname(destination);
  const sourceName = path.posix.basename(source);
  const destinationName = path.posix.basename(destination);
  const isFolder = options.renameKind === "folder";
  if (options.renameKind && sourceParent !== destinationParent) {
    throw new Error(`A ${options.renameKind} can only be renamed in place`);
  }
  const notMovable = `Source is not a ${isFolder ? "folder" : "regular file"}: ${source}`;
  const canonicalRoot = await fs.realpath(rootPath);
  const rootStats = await fs.lstat(canonicalRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Workspace root is not a directory");
  }

  const libraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const commonSymbols = {
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  } as const;
  const library =
    process.platform === "darwin"
      ? dlopen(libraryPath, {
          ...commonSymbols,
          renameatx_np: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
            returns: FFIType.i32,
          },
          __error: { args: [], returns: FFIType.ptr },
        })
      : dlopen(libraryPath, {
          ...commonSymbols,
          renameat2: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
            returns: FFIType.i32,
          },
          __errno_location: { args: [], returns: FFIType.ptr },
        });
  const nativeFds: number[] = [];
  const directoryFlags =
    constants.O_RDONLY |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0) |
    ((constants as Record<string, number>).O_CLOEXEC ?? 0);
  const errno = (): number => {
    const errnoPointer =
      process.platform === "darwin"
        ? (library.symbols as { __error(): Pointer }).__error()
        : (library.symbols as { __errno_location(): Pointer }).__errno_location();
    return read.i32(errnoPointer, 0);
  };
  const openAt = (parentFd: number, name: string, flags: number): number => {
    const encoded = nulTerminated(name);
    const fd = library.symbols.openat(parentFd, ptr(encoded), flags, 0);
    if (fd >= 0) nativeFds.push(fd);
    return fd;
  };
  const openDirectory = (rootFd: number, relativeDirectory: string, label: string): number => {
    let current = openAt(rootFd, ".", directoryFlags);
    if (current < 0) throw new Error(`${label} is not available`);
    for (const segment of directorySegments(relativeDirectory)) {
      const next = openAt(current, segment, directoryFlags);
      if (next < 0) {
        if (errno() === ERRNO_ENOENT) throw new Error(`${label} no longer exists`);
        throw new Error(`${label} is not a directory`);
      }
      current = next;
    }
    return current;
  };

  let rootHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    rootHandle = await fs.open(canonicalRoot, directoryFlags);
    const openedRoot = await rootHandle.stat();
    if (openedRoot.dev !== rootStats.dev || openedRoot.ino !== rootStats.ino) {
      throw new Error("Workspace root changed while the file was being moved; please try again");
    }
    const sourceParentFd = openDirectory(rootHandle.fd, sourceParent, "Source directory");
    const destinationParentFd = openDirectory(
      rootHandle.fd,
      destinationParent,
      "Destination directory",
    );
    assertPinnedDirectoryStillNamed(canonicalRoot, sourceParent, sourceParentFd);
    // Linux can read leaf metadata directly through the pinned parent. On
    // macOS, verify the named parents again immediately before the renameat call.
    const sourceRoot =
      process.platform === "linux" ? `/proc/self/fd/${sourceParentFd}` : canonicalRoot;
    const sourceLeaf = process.platform === "linux" ? sourceName : source;
    const namedSource = path.join(sourceRoot, sourceLeaf);
    const readSource = (): Stats => {
      try {
        return fsSync.lstatSync(namedSource);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`Source no longer exists: ${source}`);
        if (code === "EACCES" || code === "EPERM") {
          throw new Error(`Permission denied accessing source: ${source}`, { cause: error });
        }
        throw error;
      }
    };
    const sourceStats = readSource();
    if (isFolder ? !sourceStats.isDirectory() : !sourceStats.isFile()) throw new Error(notMovable);
    if (isFolder) await assertNoNestedRepositories(sourceRoot, sourceLeaf, "rename");

    await testHooks.afterDirectoriesOpened?.();
    assertPinnedDirectoryStillNamed(canonicalRoot, sourceParent, sourceParentFd);
    assertPinnedDirectoryStillNamed(canonicalRoot, destinationParent, destinationParentFd);
    const currentSource = readSource();
    if (
      currentSource.dev !== sourceStats.dev ||
      currentSource.ino !== sourceStats.ino ||
      (isFolder ? !currentSource.isDirectory() : !currentSource.isFile())
    ) {
      throw new Error(`Source changed while it was being moved: ${source}`);
    }

    const encodedSource = nulTerminated(sourceName);
    const encodedDestination = nulTerminated(destinationName);
    const result =
      process.platform === "darwin"
        ? (
            library.symbols as {
              renameatx_np(
                sourceFd: number,
                sourceName: Pointer,
                destinationFd: number,
                destinationName: Pointer,
                flags: number,
              ): number;
            }
          ).renameatx_np(
            sourceParentFd,
            ptr(encodedSource),
            destinationParentFd,
            ptr(encodedDestination),
            0x00000004,
          )
        : (
            library.symbols as {
              renameat2(
                sourceFd: number,
                sourceName: Pointer,
                destinationFd: number,
                destinationName: Pointer,
                flags: number,
              ): number;
            }
          ).renameat2(
            sourceParentFd,
            ptr(encodedSource),
            destinationParentFd,
            ptr(encodedDestination),
            1,
          );
    if (result !== 0) {
      const code = errno();
      if (code === ERRNO_EEXIST) {
        throw new Error(
          isFolder
            ? `A file or folder already exists at ${destination}`
            : `A file already exists at ${destination}`,
        );
      }
      if (code === ERRNO_ENOENT) throw new Error(`Source no longer exists: ${source}`);
      if (code === ERRNO_EXDEV) {
        throw new Error("Source and destination must be on the same filesystem");
      }
      throw new Error(`Unable to move file safely: ${source}`);
    }
    assertPinnedDirectoryStillNamed(canonicalRoot, destinationParent, destinationParentFd);
  } finally {
    for (const fd of nativeFds.reverse()) library.symbols.close(fd);
    library.close();
    await rootHandle?.close();
  }
}

export type ConfinedCreateTestHooks = ConfinedPathTestHooks;

/**
 * Creates one empty directory without re-resolving mutable ancestors.
 *
 * The canonical root and every parent are opened with O_NOFOLLOW, then mkdirat
 * uses the pinned parent descriptor. A repository process may replace a checked
 * pathname with a symlink, but it cannot redirect the new directory outside
 * those pinned handles.
 */
export async function createConfinedDirectory(
  rootPath: string,
  relativePath: string,
  testHooks: ConfinedCreateTestHooks = {},
): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Safe workspace folder creation is not supported on this platform");
  }

  const target = validateRelativeFilePath(relativePath, "folderPath");
  const parentDirectory = path.posix.dirname(target);
  const folderName = path.posix.basename(target);
  const canonicalRoot = await fs.realpath(rootPath);
  const rootStats = await fs.lstat(canonicalRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Workspace root is not a directory");
  }

  const libraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const library =
    process.platform === "darwin"
      ? dlopen(libraryPath, {
          openat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
            returns: FFIType.i32,
          },
          mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
          readlinkat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64],
            returns: FFIType.i64,
          },
          close: { args: [FFIType.i32], returns: FFIType.i32 },
          __error: { args: [], returns: FFIType.ptr },
        })
      : dlopen(libraryPath, {
          openat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
            returns: FFIType.i32,
          },
          mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
          readlinkat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64],
            returns: FFIType.i64,
          },
          close: { args: [FFIType.i32], returns: FFIType.i32 },
          __errno_location: { args: [], returns: FFIType.ptr },
        });
  const nativeFds: number[] = [];
  const directoryFlags =
    constants.O_RDONLY |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0) |
    ((constants as Record<string, number>).O_CLOEXEC ?? 0);
  const errno = (): number => {
    const errnoPointer =
      process.platform === "darwin"
        ? (library.symbols as { __error(): Pointer }).__error()
        : (library.symbols as { __errno_location(): Pointer }).__errno_location();
    return read.i32(errnoPointer, 0);
  };
  const openAt = (parentFd: number, name: string, flags: number): number => {
    const encoded = nulTerminated(name);
    const fd = library.symbols.openat(parentFd, ptr(encoded), flags, 0);
    if (fd >= 0) nativeFds.push(fd);
    return fd;
  };
  const isSymlinkName = (parentFd: number, name: string): boolean => {
    const encoded = nulTerminated(name);
    const scratch = Buffer.alloc(1);
    return library.symbols.readlinkat(parentFd, ptr(encoded), ptr(scratch), 1) >= 0;
  };
  const rejectAncestor = (parentFd: number, name: string, code: number): never => {
    if (code === ERRNO_ENOENT) {
      throw new Error(`Parent directory does not exist: ${parentDirectory}`);
    }
    if (isLoopOrNoFollowError(code) || isSymlinkName(parentFd, name)) {
      throw new Error(`Invalid filePath: symlink ancestor is not allowed: ${target}`);
    }
    throw new Error(`Invalid filePath: ancestor is not a directory: ${target}`);
  };
  const changedMessage =
    "Workspace directory changed while the folder was being created; please try again";

  let rootHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    rootHandle = await fs.open(canonicalRoot, directoryFlags);
    const openedRoot = await rootHandle.stat();
    if (openedRoot.dev !== rootStats.dev || openedRoot.ino !== rootStats.ino) {
      throw new Error(changedMessage);
    }

    let parentFd = openAt(rootHandle.fd, ".", directoryFlags);
    if (parentFd < 0) throw new Error("Workspace root is not available");
    for (const segment of directorySegments(parentDirectory)) {
      const next = openAt(parentFd, segment, directoryFlags);
      if (next < 0) rejectAncestor(parentFd, segment, errno());
      parentFd = next;
    }

    await testHooks.afterDirectoriesOpened?.();
    assertPinnedDirectoryStillNamed(canonicalRoot, parentDirectory, parentFd, changedMessage);

    const encodedName = nulTerminated(folderName);
    const created = library.symbols.mkdirat(parentFd, ptr(encodedName), 0o777);
    if (created !== 0) {
      const code = errno();
      if (code === ERRNO_EEXIST) {
        throw new Error(`A file or folder already exists at ${target}`);
      }
      if (code === ERRNO_ENOENT) {
        throw new Error(`Parent directory does not exist: ${parentDirectory}`);
      }
      if (isLoopOrNoFollowError(code)) {
        throw new Error(`Invalid filePath: symlink ancestor is not allowed: ${target}`);
      }
      if (code === ERRNO_ENOTDIR) {
        throw new Error(`Invalid filePath: ancestor is not a directory: ${target}`);
      }
      throw new Error(`Unable to create folder safely: ${target}`);
    }
    assertPinnedDirectoryStillNamed(canonicalRoot, parentDirectory, parentFd, changedMessage);
  } finally {
    for (const fd of nativeFds.reverse()) library.symbols.close(fd);
    library.close();
    await rootHandle?.close();
  }
}

function defaultReadableHostRoots(): string[] {
  return [path.join(os.homedir(), APP_SLUG, "workspaces")];
}

function isPathInsideRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function rejectControlCharacters(filePath: string, label: string): void {
  if (CONTROL_PATH_CHARS.test(filePath)) {
    throw new Error(`Invalid ${label}: control characters are not allowed`);
  }
}

export function validateRelativeFilePath(filePath: string, label = "file path"): string {
  if (filePath.length === 0) {
    throw new Error(`Invalid ${label}: path is empty`);
  }

  rejectControlCharacters(filePath, label);

  if (path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error(`Invalid ${label}: absolute paths are not allowed`);
  }

  const slashPath = filePath.replaceAll("\\", "/");
  if (slashPath.split("/").includes("..")) {
    throw new Error(`Invalid ${label}: parent directory traversal is not allowed`);
  }

  const normalized = path.posix.normalize(slashPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Invalid ${label}: path must stay inside the workspace`);
  }

  return normalized;
}

export function workspaceFilePath(filePath: string): string {
  return `/workspace/${validateRelativeFilePath(filePath)}`;
}

/** Exact decoded size of a padded, whitespace-free base64 string. */
export function base64DecodedByteLength(normalizedBase64: string): number {
  const padding = normalizedBase64.endsWith("==") ? 2 : normalizedBase64.endsWith("=") ? 1 : 0;
  return (normalizedBase64.length / 4) * 3 - padding;
}

/**
 * Validates an untrusted base64 payload once and returns the normalized form.
 *
 * Callers reuse the returned string rather than stripping whitespace again:
 * every `replace(/\s/g, "")` allocates a fresh copy of a payload that may be
 * 11MB. The decoded size is computed arithmetically for the same reason - a
 * `Buffer.from(..., "base64")` purely to measure the result is another full
 * allocation.
 */
export function assertBase64PayloadWithinLimit(
  base64Data: string,
  options: { rejectEmpty?: boolean } = {},
): string {
  const normalized = base64Data.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("File payload is not valid base64");
  }
  // Ordered before the structural checks so an oversized payload is reported as
  // oversized rather than as a base64 defect it also happens to have.
  if (normalized.length > MAX_BASE64_PAYLOAD_BYTES) {
    throw new Error(`File payload exceeds ${MAX_WRITE_FILE_BYTES} bytes`);
  }
  // Emptiness is only a defect for a payload that is supposed to carry content.
  // A file write may legitimately truncate a file to nothing - the editor does
  // exactly that when the user clears a buffer - so only callers that would
  // otherwise advertise a 0-byte artifact opt in.
  if (options.rejectEmpty && normalized.length === 0) {
    throw new Error("File payload must not be empty");
  }
  if (normalized.length % 4 !== 0) {
    throw new Error("File payload is not valid base64");
  }
  if (base64DecodedByteLength(normalized) > MAX_WRITE_FILE_BYTES) {
    throw new Error(`File payload exceeds ${MAX_WRITE_FILE_BYTES} bytes`);
  }
  return normalized;
}

type ConfinedWriteOptions = {
  /**
   * Refuse the write when the target already exists (`O_EXCL`). Attachment
   * batches own a freshly created, unpredictable directory and must never adopt
   * a planted file. Overwrite-intended writers pass `false` and atomically
   * publish a fully-written sibling over the prior entry.
   */
  exclusive?: boolean;
  /** Require every parent directory to exist instead of creating missing ones. */
  createAncestors?: boolean;
  /** Label used in path validation errors. */
  label?: string;
  /** Dedicated command-owned artifacts may have a larger audited budget. */
  maxBytes?: number;
  /** Final mode applied to the still-open temporary inode before publication. */
  fileMode?: number;
  /**
   * Replacing an existing regular file keeps its permission bits instead of
   * `fileMode` (an editor save must not drop a script's execute bit or narrow
   * a shared file to owner-only). `fileMode` still applies to a new file.
   */
  preserveExistingMode?: boolean;
  /**
   * Publish only while the destination is a regular file whose bytes hash to
   * this lower-case hex SHA-256. Checked after the payload is fully written to
   * the temporary file and immediately before the rename; a mismatch, a
   * missing file or a non-file fails with `FILE_WRITE_CONFLICT_MESSAGE` and
   * leaves the destination untouched. This is check-then-rename, not an
   * atomic compare-and-swap: a write by another process that lands between
   * the check and the rename is still replaced.
   */
  expectedSha256?: string;
  /** Map an occupied exclusive destination or missing parent to a save conflict. */
  expectedAbsent?: boolean;
  /** Test-only synchronization point after the destination directory is pinned. */
  testHooks?: ConfinedPathTestHooks;
};

// The helper's cwd is resolved by the kernel during spawn and remains pinned to
// that directory object even if a repository process renames an ancestor. All
// opens, publishes, and cleanup are relative to that cwd, so no post-validation
// pathname lookup can reach a replacement directory outside the worktree.
const PINNED_CWD_WRITE_HELPER = String.raw`
const fs = require("node:fs"), path = require("node:path");
const [targetPath, mode, expectedDev, expectedIno, expectedBytes, fileMode, ancestorMode, modePolicy, expectedSha256, digestLimit, readyToken] = process.argv.slice(1);
const checked = expectedSha256 !== "-";
const invalidAncestor = () => { process.stderr.write("symlink or non-directory ancestor"); process.exit(checked ? 78 : 73); };
const cwd = fs.statSync(".");
if (String(cwd.dev) !== expectedDev || String(cwd.ino) !== expectedIno) invalidAncestor();
const rootPath = process.cwd();
let segments;
let target;
function pinParent(relative) {
  segments = relative.split("/");
  target = segments.pop();
  for (const segment of segments) {
    try {
      const stat = fs.lstatSync(segment);
      if (stat.isSymbolicLink() || !stat.isDirectory()) invalidAncestor();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (ancestorMode === "existing") {
        process.stderr.write("ENOENT_ANCESTOR");
        process.exit(checked ? 78 : 77);
      }
      try { fs.mkdirSync(segment, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
    }
    const expected = fs.lstatSync(segment);
    if (expected.isSymbolicLink() || !expected.isDirectory()) invalidAncestor();
    process.chdir(segment);
    const pinned = fs.statSync(".");
    if (pinned.dev !== expected.dev || pinned.ino !== expected.ino) invalidAncestor();
  }
}
pinParent(targetPath);
let referent;
if (modePolicy === "existing" && expectedSha256 !== "absent") {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      referent = fs.realpathSync(target);
      const relative = path.relative(rootPath, referent);
      if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        invalidAncestor();
      }
      process.chdir(rootPath);
      const root = fs.statSync(".");
      if (root.dev !== cwd.dev || root.ino !== cwd.ino) invalidAncestor();
      pinParent(relative);
    }
  } catch (error) {
    if (error.code === "ELOOP" || (error.code === "ENOENT" && referent === undefined)) {
      if (error.code === "ELOOP") invalidAncestor();
      // Missing entries are handled at publication. A dangling link still
      // exists and fails the final lstat check.
    } else throw error;
  }
}
const assertDirectoryStillNamed = () => {
  let current = rootPath, named;
  try {
    named = fs.lstatSync(current);
    if (named.isSymbolicLink() || !named.isDirectory()) throw new Error("invalid root");
    for (const segment of segments) {
      current = path.join(current, segment);
      named = fs.lstatSync(current);
      if (named.isSymbolicLink() || !named.isDirectory()) throw new Error("invalid ancestor");
    }
  } catch { const error = new Error("workspace directory changed"); error.code = "ESTALE_DIRECTORY"; throw error; }
  const pinned = fs.statSync(".");
  if (named.dev !== pinned.dev || named.ino !== pinned.ino) {
    const error = new Error("workspace directory changed"); error.code = "ESTALE_DIRECTORY"; throw error;
  }
};
if (readyToken) process.stdout.write(readyToken + "\n");
const chunks = [];
let bytes = 0;
process.stdin.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > Number(expectedBytes)) process.exit(74);
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  if (bytes !== Number(expectedBytes)) process.exit(74);
  const temp = ".orkestrator-save." + require("node:crypto").randomUUID();
  let fd;
  let identity;
  let published = false;
  try {
    assertDirectoryStillNamed();
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    identity = fs.fstatSync(fd);
    fs.writeFileSync(fd, Buffer.concat(chunks));
    fs.fsyncSync(fd);
    let finalMode = Number(fileMode);
    const conflict = () => { const error = new Error("file changed"); error.code = "FILE_WRITE_CONFLICT"; throw error; };
    if (referent) {
      try {
        if (fs.realpathSync(path.join(rootPath, targetPath)) !== referent) conflict();
      } catch { conflict(); }
    }
    if (expectedSha256 !== "absent" && (checked || modePolicy === "existing")) {
      let current;
      try { current = fs.lstatSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (checked) {
        let matches = false;
        const limit = Number(digestLimit);
        if (current && current.isFile() && current.size <= limit) {
          let existingFd;
          try {
            existingFd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            const opened = fs.fstatSync(existingFd);
            if (opened.isFile() && opened.dev === current.dev && opened.ino === current.ino && opened.size <= limit) {
              const hash = require("node:crypto").createHash("sha256");
              const buffer = Buffer.allocUnsafe(65536);
              let total = 0;
              while (total <= limit) {
                const read = fs.readSync(existingFd, buffer, 0, Math.min(buffer.length, limit + 1 - total), null);
                if (read === 0) break;
                hash.update(buffer.subarray(0, read));
                total += read;
              }
              const final = fs.fstatSync(existingFd);
              const named = fs.lstatSync(target);
              matches = total <= limit && total === final.size && final.size === opened.size &&
                final.mtimeMs === opened.mtimeMs && final.ctimeMs === opened.ctimeMs &&
                named.dev === opened.dev && named.ino === opened.ino &&
                hash.digest("hex") === expectedSha256;
            }
          } catch {} finally { if (existingFd !== undefined) try { fs.closeSync(existingFd); } catch {} }
        }
        if (!matches) conflict();
      }
      if (current && !current.isFile()) throw new Error("target is not a regular file");
      if (modePolicy === "existing" && current) finalMode = current.mode & 0o777;
    }
    fs.fchmodSync(fd, finalMode);
    fs.closeSync(fd);
    fd = undefined;
    assertDirectoryStillNamed();
    if (mode === "exclusive") {
      try { fs.linkSync(temp, target); } catch (error) {
        if (expectedSha256 === "absent" && error.code === "EEXIST") conflict();
        throw error;
      }
      fs.unlinkSync(temp);
    } else {
      fs.renameSync(temp, target);
    }
    published = true;
    const publishedStat = fs.lstatSync(target);
    if (publishedStat.isSymbolicLink() || !publishedStat.isFile() || publishedStat.dev !== identity.dev || publishedStat.ino !== identity.ino) {
      process.exit(75);
    }
    assertDirectoryStillNamed();
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    if (published && mode === "exclusive") try {
      const current = fs.lstatSync(target);
      if (identity && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(target);
    } catch {}
    try {
      const current = fs.lstatSync(temp);
      if (identity && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(temp);
    } catch {}
    const code = error && typeof error.code === "string" ? error.code : "WRITE_FAILED";
    process.stderr.write(code);
    process.exit(code === "FILE_WRITE_CONFLICT" ? 78 : 76);
  }
});
`;

const PINNED_CWD_REMOVE_DIRECTORY_HELPER = String.raw`
const fs = require("node:fs");
const [relativePath, expectedDev, expectedIno, childDev, childIno] = process.argv.slice(1);
const root = fs.statSync(".");
if (String(root.dev) !== expectedDev || String(root.ino) !== expectedIno) process.exit(73);
const segments = relativePath.split("/"), target = segments.pop();
for (const segment of segments) {
  let stat; try { stat = fs.lstatSync(segment); } catch { process.exit(0); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) process.exit(0);
  process.chdir(segment);
  const pinned = fs.statSync(".");
  if (pinned.dev !== stat.dev || pinned.ino !== stat.ino) process.exit(73);
}
let final; try { final = fs.lstatSync(target); } catch { process.exit(0); }
if (final.isSymbolicLink() || !final.isDirectory()) process.exit(0);
if (childDev && (String(final.dev) !== childDev || String(final.ino) !== childIno)) process.exit(73);
fs.rmSync(target, { recursive: true, force: true });
`;

const MAX_HELPER_DIAGNOSTIC_CHARS = 1_024;
const READY_TOKEN = "ORK_WRITE_READY";

/** Exit status of the write helper when `expectedSha256` no longer matches. */
const CONFINED_WRITE_CONFLICT_EXIT = 78;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function confinedWriteFailure(stderr: string, exitCode: number | null): Error {
  if (exitCode === CONFINED_WRITE_CONFLICT_EXIT) return new Error(FILE_WRITE_CONFLICT_MESSAGE);
  const diagnostic = stderr.slice(0, MAX_HELPER_DIAGNOSTIC_CHARS);
  return new Error(`Confined file write failed (${diagnostic || `exit ${exitCode}`})`);
}

/**
 * Runs the helper with a stdout handshake instead of a capture: `afterDirectoriesOpened`
 * must act between the helper pinning its directories and it receiving the payload,
 * which needs a live read. Only tests set that hook.
 */
function writeThroughHandshake(
  rootPath: string,
  helperArgs: string[],
  content: Buffer,
  afterDirectoriesOpened: () => void | Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...helperArgs, READY_TOKEN], {
      cwd: rootPath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_HELPER_DIAGNOSTIC_CHARS) stderr += chunk.toString();
    });
    child.once("error", reject);
    // `exit` can precede the final stderr data event. Settle on `close`, which
    // fires after the stdio streams close, so a fail-closed helper diagnostic
    // is not nondeterministically replaced by the bare exit code.
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(confinedWriteFailure(stderr, code));
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // An identity/symlink rejection can close stdin before the bounded
      // payload is consumed. The exit status is the authoritative failure.
      if (error.code !== "EPIPE") reject(error);
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!stdout.includes(`${READY_TOKEN}\n`)) return;
      stdout = "";
      void Promise.resolve(afterDirectoriesOpened())
        .then(() => child.stdin.end(content))
        .catch((error) => {
          child.kill();
          reject(error);
        });
    });
  });
}

async function writeFromPinnedRoot(
  rootPath: string,
  rootStats: Stats,
  target: string,
  content: Buffer,
  exclusive: boolean,
  fileMode: number,
  createAncestors: boolean,
  publish: { preserveExistingMode: boolean; expectedSha256?: string; expectedAbsent?: boolean },
  testHooks: ConfinedPathTestHooks = {},
): Promise<void> {
  const helperArgs = [
    "-e",
    PINNED_CWD_WRITE_HELPER,
    target,
    exclusive ? "exclusive" : "overwrite",
    String(rootStats.dev),
    String(rootStats.ino),
    String(content.byteLength),
    String(fileMode),
    createAncestors ? "create" : "existing",
    publish.preserveExistingMode ? "existing" : "fixed",
    publish.expectedAbsent ? "absent" : (publish.expectedSha256 ?? "-"),
    String(MAX_TEXT_FILE_BYTES),
  ];
  if (testHooks.afterDirectoriesOpened) {
    await writeThroughHandshake(rootPath, helperArgs, content, testHooks.afterDirectoriesOpened);
    return;
  }
  try {
    // No deadline: a bounded payload on a slow disk still has to finish or fail.
    await runCommandBuffer(process.execPath, helperArgs, {
      cwd: rootPath,
      stdin: content,
      timeoutMs: 0,
    });
  } catch (error) {
    if (!(error instanceof CommandFailedError) || error.executableMissing) throw error;
    throw confinedWriteFailure(error.stderr, error.exitCode);
  }
}

/** Removes one directory tree relative to a root-pinned child cwd. */
export async function removeConfinedDirectory(
  rootPath: string,
  relativePath: string,
  expectedIdentity?: { dev: number; ino: number },
  options: {
    /**
     * Kills the helper. The promise still settles only once the helper has
     * exited, so a caller that sees the rejection knows nothing is removing.
     */
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const target = validateRelativeFilePath(relativePath, "directory path");
  const canonicalRoot = await fs.realpath(rootPath);
  const rootStats = await fs.lstat(canonicalRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return;
  const { signal } = options;
  if (signal?.aborted) throw new Error("Confined directory cleanup stopped");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        PINNED_CWD_REMOVE_DIRECTORY_HELPER,
        target,
        String(rootStats.dev),
        String(rootStats.ino),
        expectedIdentity ? String(expectedIdentity.dev) : "",
        expectedIdentity ? String(expectedIdentity.ino) : "",
      ],
      { cwd: canonicalRoot, stdio: ["ignore", "ignore", "ignore"] },
    );
    const stop = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("exit", (code) => {
      signal?.removeEventListener("abort", stop);
      if (code === 0) resolve();
      else if (signal?.aborted) reject(new Error("Confined directory cleanup stopped"));
      else reject(new Error(`Confined directory cleanup failed (exit ${code})`));
    });
  });
}

/**
 * Writes a file inside a worktree using pinned directories.
 *
 * Artifact writes reject symlinked ancestors. Editor writes can follow a
 * final link whose referent stays inside the worktree and can be pinned.
 *
 * Every ancestor is created and checked segment by segment, and the file itself
 * is opened with `O_NOFOLLOW`. Re-checking the path and descriptor identity
 * before and after the write detects replacement races instead of reporting an
 * unsafe or ambiguous write as successful.
 *
 * `payload` may be a pre-decoded buffer so a batch that already validated and
 * decoded its items does not pay for a second strip and decode per file.
 */
export async function writeConfinedFile(
  rootPath: string,
  relativePath: string,
  payload: string | Buffer,
  options: ConfinedWriteOptions = {},
): Promise<string> {
  const label = options.label ?? "attachment path";
  const target = validateRelativeFilePath(relativePath, label);
  const content =
    typeof payload === "string"
      ? Buffer.from(assertBase64PayloadWithinLimit(payload), "base64")
      : payload;
  const maxBytes = options.maxBytes ?? MAX_WRITE_FILE_BYTES;
  if (content.byteLength > maxBytes) {
    throw new Error(`File payload exceeds ${maxBytes} bytes`);
  }
  const fileMode = options.fileMode ?? 0o600;
  if (!Number.isInteger(fileMode) || fileMode < 0 || fileMode > 0o777) {
    throw new Error("Invalid confined file mode");
  }
  if (options.expectedSha256 !== undefined) {
    if (!SHA256_HEX.test(options.expectedSha256)) throw new Error("Invalid expected file digest");
    if (options.exclusive !== false) throw new Error("An expected digest needs an overwrite write");
  }
  if (
    options.expectedAbsent &&
    (options.exclusive === false || options.expectedSha256 !== undefined)
  ) {
    throw new Error("An absent destination needs an exclusive write");
  }
  const canonicalRoot = await fs.realpath(rootPath);
  const fullPath = path.join(canonicalRoot, target);
  const rootStats = await fs.lstat(canonicalRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Invalid ${label}: worktree root is not a directory`);
  }
  await writeFromPinnedRoot(
    canonicalRoot,
    rootStats,
    target,
    content,
    options.exclusive !== false,
    fileMode,
    options.createAncestors !== false,
    {
      preserveExistingMode: options.preserveExistingMode === true,
      expectedSha256: options.expectedSha256,
      expectedAbsent: options.expectedAbsent,
    },
    options.testHooks,
  );
  return fullPath;
}

/** A lexical read root whose mutable ancestors must be opened below a trusted directory. */
export type ReadableHostRoot = string | { path: string; trustedParent: string };

async function openAnchoredHostFile(targetPath: string, root: Exclude<ReadableHostRoot, string>) {
  const relative = validateRelativeFilePath(
    path.relative(root.trustedParent, targetPath),
    "filePath",
  );
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Invalid file path: anchored host reads are unavailable");
  }
  const canonicalParent = await fs.realpath(root.trustedParent);
  const darwin = process.platform === "darwin";
  // Node does not expose O_CLOEXEC, and these raw descriptors outlive awaits.
  const closeOnExec = darwin ? 0x1000000 : 0x80000;
  const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;
  const directoryFlags = readFlags | constants.O_DIRECTORY;
  const parent = await fs.open(canonicalParent, directoryFlags);
  try {
    const lib = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      openat: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      [darwin ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
    });
    const errno = (lib.symbols as Record<string, () => Pointer>)[
      darwin ? "__error" : "__errno_location"
    ]!;
    let fd = parent.fd;
    try {
      const segments = relative.split("/");
      for (const [index, segment] of segments.entries()) {
        const name = nulTerminated(segment);
        const flags = index === segments.length - 1 ? readFlags : directoryFlags;
        const next = lib.symbols.openat(fd, ptr(name), flags, 0);
        if (next < 0) {
          const code = read.i32(errno(), 0);
          if (code === ERRNO_ENOTDIR || isLoopOrNoFollowError(code)) {
            throw new Error(
              "Invalid file path: symbolic links and non-directory ancestors are not allowed",
            );
          }
          throw new Error("Invalid file path: report image path could not be opened");
        }
        if (fd !== parent.fd) lib.symbols.close(fd);
        fd = next;
      }
      const pinned = fsSync.fstatSync(fd);
      if (!pinned.isFile() || pinned.nlink !== 1) {
        throw new Error("Invalid file path: report image must be a regular, single-link file");
      }
      // Duplicate the pinned file into a FileHandle for bounded and ranged reads.
      const handle = await fs.open(
        `${darwin ? "/dev/fd" : "/proc/self/fd"}/${fd}`,
        constants.O_RDONLY,
      );
      try {
        const stats = await handle.stat();
        const canonicalRoot = path.join(
          canonicalParent,
          path.relative(root.trustedParent, root.path),
        );
        await assertOpenedHostFile(targetPath, canonicalRoot, stats);
        return { handle, stats, targetPath, canonicalRoot };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } finally {
      if (fd !== parent.fd) lib.symbols.close(fd);
      lib.close();
    }
  } finally {
    await parent.close();
  }
}

async function resolveReadableHostTarget(
  filePath: string,
  allowedRoots: string[],
): Promise<{ canonicalRoot: string; canonicalTarget: string; targetPath: string }> {
  if (filePath.length === 0) {
    throw new Error("Invalid file path: path is empty");
  }

  rejectControlCharacters(filePath, "file path");

  if (!path.isAbsolute(filePath)) {
    throw new Error("Invalid file path: absolute path is required");
  }

  const targetPath = path.resolve(filePath);
  const lexicalRoots = allowedRoots.map((root) => path.resolve(root));
  const lexicalRoot = lexicalRoots.find((root) => isPathInsideRoot(targetPath, root));
  if (!lexicalRoot) {
    throw new Error("Invalid file path: file is outside Orkestrator workspace storage");
  }

  let currentPath = lexicalRoot;
  const relativeTarget = path.relative(lexicalRoot, targetPath);
  for (const segment of relativeTarget.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const stats = await fs.lstat(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error("Invalid file path: symbolic links are not allowed");
    }
  }

  const [canonicalRoot, canonicalTarget] = await Promise.all([
    fs.realpath(lexicalRoot),
    fs.realpath(targetPath),
  ]);
  if (!isPathInsideRoot(canonicalTarget, canonicalRoot)) {
    throw new Error("Invalid file path: file is outside Orkestrator workspace storage");
  }

  return { canonicalRoot, canonicalTarget, targetPath };
}

async function assertOpenedHostFile(
  targetPath: string,
  canonicalRoot: string,
  openedStats: Stats,
): Promise<void> {
  const [pathStats, canonicalTarget] = await Promise.all([
    fs.lstat(targetPath),
    fs.realpath(targetPath),
  ]);
  if (pathStats.isSymbolicLink()) {
    throw new Error("Invalid file path: symbolic links are not allowed");
  }
  if (
    !pathStats.isFile() ||
    !openedStats.isFile() ||
    pathStats.dev !== openedStats.dev ||
    pathStats.ino !== openedStats.ino
  ) {
    throw new Error("Invalid file path: not a stable regular file");
  }
  if (!isPathInsideRoot(canonicalTarget, canonicalRoot)) {
    throw new Error("Invalid file path: file is outside Orkestrator workspace storage");
  }
}

/**
 * Opens one regular file in Orkestrator-managed workspace storage with the
 * same confinement as `readReadableHostFile`: lexical root match, no symbolic
 * link on any segment below the root, canonical target inside the canonical
 * root, a nonblocking no-follow open, and a handle-backed regular-file and
 * identity check. The caller owns (and must close) the returned handle; ranged
 * reads on it read exactly the validated file.
 */
export async function openReadableHostFile(
  filePath: string,
  allowedRoots: readonly ReadableHostRoot[],
): Promise<{ handle: FileHandle; stats: Stats; targetPath: string; canonicalRoot: string }> {
  const target = path.resolve(filePath);
  const anchored = allowedRoots.find(
    (root) => typeof root !== "string" && isPathInsideRoot(target, root.path),
  );
  if (anchored && typeof anchored !== "string") {
    rejectControlCharacters(filePath, "file path");
    if (!path.isAbsolute(filePath)) throw new Error("Invalid file path: absolute path is required");
    return openAnchoredHostFile(target, anchored);
  }
  const { canonicalRoot, targetPath } = await resolveReadableHostTarget(
    filePath,
    allowedRoots.filter((root): root is string => typeof root === "string"),
  );
  const handle = await fs.open(
    targetPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stats = await handle.stat();
    await assertOpenedHostFile(targetPath, canonicalRoot, stats);
    return { handle, stats, targetPath, canonicalRoot };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Reads one bounded snapshot from Orkestrator-managed workspace storage.
 * Validation, fstat, and reads all apply to the same no-follow file handle.
 */
export async function readReadableHostFile(
  filePath: string,
  allowedRoots: readonly ReadableHostRoot[] = defaultReadableHostRoots(),
  testHooks?: {
    afterInitialValidation?: () => void | Promise<void>;
  },
): Promise<Buffer> {
  // A FIFO blocks during a read-only open until a writer appears. Open every
  // candidate nonblocking, then let the handle-backed regular-file check
  // reject FIFOs, devices, and sockets without tying up a libuv worker.
  const {
    handle,
    stats: initialStats,
    targetPath,
    canonicalRoot,
  } = await openReadableHostFile(filePath, allowedRoots);

  try {
    if (initialStats.size > MAX_BINARY_FILE_BYTES) {
      throw new Error(`File exceeds ${MAX_BINARY_FILE_BYTES} bytes`);
    }
    await testHooks?.afterInitialValidation?.();

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_BINARY_FILE_BYTES) {
      const remaining = MAX_BINARY_FILE_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_BINARY_FILE_BYTES) {
      throw new Error(`File exceeds ${MAX_BINARY_FILE_BYTES} bytes`);
    }

    const finalStats = await handle.stat();
    await assertOpenedHostFile(targetPath, canonicalRoot, finalStats);
    if (
      finalStats.dev !== initialStats.dev ||
      finalStats.ino !== initialStats.ino ||
      finalStats.size !== initialStats.size ||
      finalStats.size !== totalBytes ||
      finalStats.mtimeMs !== initialStats.mtimeMs ||
      finalStats.ctimeMs !== initialStats.ctimeMs
    ) {
      throw new Error("File changed while it was being read; please try again");
    }

    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}
