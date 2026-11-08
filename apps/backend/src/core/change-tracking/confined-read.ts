/** Descriptor-relative reads: no mutable pathname ancestor is followed. */
import { constants, closeSync, fstatSync, openSync, read as readBytes, type Stats } from "node:fs";
import { dlopen, FFIType, ptr, read as ffiRead, type Pointer } from "bun:ffi";
import { CaptureError } from "./capture-error.js";

export function validCapturePath(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes).toString("latin1");
  return (
    !!text &&
    !text.includes("\0") &&
    !text.includes("\\") &&
    !/^[A-Za-z]:/.test(text) &&
    text
      .split("/")
      .every((part) => !!part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  );
}

type Libc = {
  openat(dirfd: number, path: Pointer, flags: number, mode: number): number;
  readlinkat(dirfd: number, path: Pointer, buffer: Pointer, size: number): number | bigint;
  errno(): number;
};

let libc: Libc | null = null;
const linkScratch = Buffer.alloc(64 * 1024);

/**
 * libc bound once per process. `dlopen` compiles its trampolines on every
 * call, which cost more than the read itself for a small file; the library
 * stays loaded for the life of the backend.
 */
function loadLibc(): Libc {
  if (libc) return libc;
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new CaptureError("unsupported-platform");
  const symbols = {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    readlinkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
  } as const;
  if (process.platform === "darwin") {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      ...symbols,
      __error: { args: [], returns: FFIType.ptr },
    });
    libc = {
      openat: lib.symbols.openat,
      readlinkat: lib.symbols.readlinkat,
      errno: () => ffiRead.i32(lib.symbols.__error()!, 0),
    };
  } else {
    const lib = dlopen("libc.so.6", {
      ...symbols,
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    libc = {
      openat: lib.symbols.openat,
      readlinkat: lib.symbols.readlinkat,
      errno: () => ffiRead.i32(lib.symbols.__errno_location()!, 0),
    };
  }
  return libc;
}

export interface ConfinedReadOptions {
  /**
   * Called with the opened file's `fstat`. Returning true skips the read:
   * the result carries `bytes: null` and `skipped: true`, so the caller can
   * reuse what it already knows about that exact stat stamp.
   */
  skipRead?: (info: Stats) => boolean;
}

export type ConfinedReadResult =
  | { bytes: Uint8Array; info: null; after: null; symlink: true; skipped: false }
  | { bytes: Uint8Array; info: Stats; after: Stats; symlink: false; skipped: false }
  | { bytes: null; info: Stats; after: Stats; symlink: false; skipped: true };

export async function confinedRead(
  root: string,
  relative: Uint8Array,
  maxBytes: number,
  signal?: AbortSignal,
  options: ConfinedReadOptions = {},
): Promise<ConfinedReadResult> {
  if (!validCapturePath(relative)) throw new CaptureError("unsafe-capture-path");
  const lib = loadLibc();
  const missing = () => lib.errno() === 2;
  const fds: number[] = [];
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    let parent = openSync(root, directoryFlags);
    fds.push(parent);
    const parts = Buffer.from(relative).toString("latin1").split("/");
    const name = Buffer.concat([Buffer.from(parts.pop()!, "latin1"), Buffer.from([0])]);
    for (const part of parts) {
      const encoded = Buffer.concat([Buffer.from(part, "latin1"), Buffer.from([0])]);
      const fd = lib.openat(parent, ptr(encoded), directoryFlags, 0);
      if (fd < 0)
        throw new CaptureError(missing() ? "capture-file-missing" : "unsafe-capture-ancestor");
      fds.push(fd);
      parent = fd;
    }
    // Used synchronously, before any await, so one scratch buffer serves
    // every concurrent read; a symlink target is copied out of it.
    const linkLength = Math.min(maxBytes + 1, linkScratch.length);
    const linkSize = Number(lib.readlinkat(parent, ptr(name), ptr(linkScratch), linkLength));
    if (linkSize >= 0) {
      if (linkSize >= linkLength || linkSize > maxBytes)
        throw new CaptureError("capture-file-too-large");
      return {
        bytes: Buffer.from(linkScratch.subarray(0, linkSize)),
        info: null,
        after: null,
        symlink: true,
        skipped: false,
      };
    }
    const fd = lib.openat(
      parent,
      ptr(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    );
    if (fd < 0)
      throw new CaptureError(missing() ? "capture-file-missing" : "capture-file-unavailable");
    fds.push(fd);
    const info = fstatSync(fd);
    if (!info.isFile()) throw new CaptureError("capture-file-unsupported");
    if (info.size > maxBytes) throw new CaptureError("capture-file-too-large");
    if (options.skipRead?.(info))
      return { bytes: null, info, after: info, symlink: false, skipped: true };
    // Reserve a fixed bound before reading, even if another writer grows it.
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let size = 0;
    while (size < bytes.length) {
      if (signal?.aborted) throw new CaptureError("capture-timeout");
      const n = await new Promise<number>((resolve, reject) => {
        readBytes(
          fd,
          bytes,
          size,
          Math.min(64 * 1024, bytes.length - size),
          null,
          (error, count) => (error ? reject(error) : resolve(count)),
        );
      });
      if (signal?.aborted) throw new CaptureError("capture-timeout");
      if (!n) break;
      size += n;
    }
    if (size > maxBytes) throw new CaptureError("capture-file-too-large");
    return {
      bytes: bytes.subarray(0, size),
      info,
      after: fstatSync(fd),
      symlink: false,
      skipped: false,
    };
  } finally {
    for (const fd of fds.reverse()) closeSync(fd);
  }
}
