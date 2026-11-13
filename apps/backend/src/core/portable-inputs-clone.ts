/// <reference types="bun" />
import { constants as fsConstants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";

/**
 * Clones the open, identity-checked file `fd` to `destination`, which must not
 * exist (an existing one fails with `EEXIST`). Any other failure means the
 * clone did not happen and the caller copies instead. The clone always comes
 * from the descriptor, never from the source path, so a file swapped in at
 * that path after the check is never staged (to-do 6740 (retired), task 1).
 */
export type DescriptorClone = (fd: number, destination: string) => Promise<void>;

/**
 * Linux: `/proc/self/fd/<fd>` reopens the very file the descriptor names, so
 * `copyFile` with `COPYFILE_FICLONE_FORCE` reflinks that file and fails where
 * the filesystem cannot (ext4, tmpfs, another device).
 */
export function linuxDescriptorClone(copy: typeof copyFile = copyFile): DescriptorClone {
  return (fd, destination) =>
    copy(
      `/proc/self/fd/${fd}`,
      destination,
      fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE,
    );
}

/** `AT_FDCWD` on macOS: an absolute destination ignores it anyway. */
const DARWIN_AT_FDCWD = -2;
/** `CLONE_NOOWNERCOPY`: the clone is owned by the backend, as a copy would be. */
const DARWIN_CLONE_NOOWNERCOPY = 0x0002;
/** `XATTR_NOFOLLOW`. */
const DARWIN_XATTR_NOFOLLOW = 0x0001;
/** `ENOATTR`, which `os.constants.errno` does not name. */
const DARWIN_ENOATTR = 93;
/**
 * The kernel attaches this to every file the backend writes, a plain copy
 * included, and reattaches it after removal, so it is left alone.
 */
const DARWIN_PROVENANCE_XATTR = "com.apple.provenance";

interface DarwinCloneSymbols {
  fclonefileat(srcfd: number, dirfd: number, name: unknown, flags: number): number;
  lchflags(path: unknown, flags: number): number;
  listxattr(path: unknown, names: unknown, size: number, options: number): number | bigint;
  removexattr(path: unknown, name: unknown, options: number): number;
  __error(): unknown;
}

interface DarwinCloneLibrary {
  symbols: DarwinCloneSymbols;
  ptr(value: Buffer): unknown;
  errno(): number;
}

type LoadFfi = () => unknown;

const defaultLoadFfi: LoadFfi = () => createRequire(import.meta.url)("bun:ffi");

/** Loaded once per process; `null` once loading has failed. */
let darwinLibrary: DarwinCloneLibrary | null | undefined;

function loadDarwinLibrary(loadFfi: LoadFfi): DarwinCloneLibrary | null {
  try {
    const ffi = loadFfi() as typeof import("bun:ffi");
    const { dlopen, FFIType, ptr, read } = ffi;
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      fclonefileat: {
        args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      lchflags: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      listxattr: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.i32],
        returns: FFIType.i64,
      },
      removexattr: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    const symbols = library.symbols as unknown as DarwinCloneSymbols;
    return {
      symbols,
      ptr: (value) => ptr(value),
      errno: () => read.i32(symbols.__error() as never, 0),
    };
  } catch {
    // Not Bun (no `bun:ffi`) or no libSystem: staging copies, as before.
    return null;
  }
}

const errnoNames = new Map<number, string>(
  Object.entries(os.constants.errno).map(([name, value]) => [value, name]),
);

function errnoError(operation: string, errno: number): NodeJS.ErrnoException {
  const code = errnoNames.get(errno) ?? `ERRNO_${errno}`;
  return Object.assign(new Error(`${operation} failed (${code})`), { code, errno: -errno });
}

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf8");
}

/**
 * Leaves a fresh clone as a plain copy would be: `fclonefileat` also copies
 * the source's file flags (an `uchg` clone could not be chmodded or removed)
 * and its extended attributes (a resource fork is data nobody staged). Both
 * are cleared on the clone, which sits in the backend's private partial
 * revision, so naming it by path reaches only that file.
 */
function scrubDarwinClone(library: DarwinCloneLibrary, destination: string): void {
  const { symbols, ptr } = library;
  const target = cString(destination);
  if (symbols.lchflags(ptr(target), 0) !== 0) throw errnoError("lchflags", library.errno());
  const size = Number(symbols.listxattr(ptr(target), null, 0, DARWIN_XATTR_NOFOLLOW));
  if (size < 0) throw errnoError("listxattr", library.errno());
  if (size === 0) return;
  const names = Buffer.alloc(size);
  const listed = Number(symbols.listxattr(ptr(target), ptr(names), size, DARWIN_XATTR_NOFOLLOW));
  if (listed < 0) throw errnoError("listxattr", library.errno());
  for (const name of names.subarray(0, listed).toString("utf8").split("\0")) {
    if (!name || name === DARWIN_PROVENANCE_XATTR) continue;
    if (symbols.removexattr(ptr(target), ptr(cString(name)), DARWIN_XATTR_NOFOLLOW) !== 0) {
      const errno = library.errno();
      // ENOATTR: gone already, which is the outcome wanted.
      if (errno !== DARWIN_ENOATTR) throw errnoError("removexattr", errno);
    }
  }
}

/**
 * macOS: `fclonefileat(2)` clones from a descriptor; `clonefile(2)` and
 * Node's `COPYFILE_FICLONE` resolve a path, and `/dev/fd/<fd>` duplicates a
 * descriptor on open rather than naming a file. Neither Node nor Bun exposes
 * it, so it is reached through `bun:ffi`. Undefined where that is not
 * available (not macOS, or not running under Bun): the caller copies.
 * It fails with `ENOTSUP` off APFS and `EXDEV` across volumes.
 */
export function darwinDescriptorClone(
  platform: NodeJS.Platform = process.platform,
  loadFfi?: LoadFfi,
): DescriptorClone | undefined {
  if (platform !== "darwin") return undefined;
  const library =
    loadFfi !== undefined
      ? loadDarwinLibrary(loadFfi)
      : (darwinLibrary ??= process.versions.bun ? loadDarwinLibrary(defaultLoadFfi) : null);
  if (!library) return undefined;
  return async (fd, destination) => {
    const name = cString(destination);
    const result = library.symbols.fclonefileat(
      fd,
      DARWIN_AT_FDCWD,
      library.ptr(name),
      DARWIN_CLONE_NOOWNERCOPY,
    );
    if (result !== 0) throw errnoError("fclonefileat", library.errno());
    scrubDarwinClone(library, destination);
  };
}

/**
 * The descriptor clone this platform supports, or undefined where staging
 * always copies (Windows, or macOS outside Bun).
 */
export function platformDescriptorClone(
  copy: typeof copyFile = copyFile,
  platform: NodeJS.Platform = process.platform,
): DescriptorClone | undefined {
  if (platform === "linux") return linuxDescriptorClone(copy);
  return darwinDescriptorClone(platform);
}
