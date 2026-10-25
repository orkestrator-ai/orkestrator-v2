/** Descriptor-relative reads: no mutable pathname ancestor is followed. */
import { constants, closeSync, fstatSync, openSync, read as readBytes } from "node:fs";
import { dlopen, FFIType, ptr, read as ffiRead, type Pointer } from "bun:ffi";

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

export async function confinedRead(
  root: string,
  relative: Uint8Array,
  maxBytes: number,
  signal?: AbortSignal,
) {
  if (!validCapturePath(relative)) throw new Error("unsafe-capture-path");
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("unsupported-platform");
  const symbols = {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    readlinkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
  } as const;
  const lib =
    process.platform === "darwin"
      ? dlopen("/usr/lib/libSystem.B.dylib", {
          ...symbols,
          __error: { args: [], returns: FFIType.ptr },
        })
      : dlopen("libc.so.6", { ...symbols, __errno_location: { args: [], returns: FFIType.ptr } });
  const missing = () => {
    const pointer =
      process.platform === "darwin"
        ? (lib.symbols as { __error(): Pointer }).__error()
        : (lib.symbols as { __errno_location(): Pointer }).__errno_location();
    return ffiRead.i32(pointer, 0) === 2;
  };
  const fds: number[] = [];
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    let parent = openSync(root, directoryFlags);
    fds.push(parent);
    const parts = Buffer.from(relative).toString("latin1").split("/");
    const name = Buffer.concat([Buffer.from(parts.pop()!, "latin1"), Buffer.from([0])]);
    for (const part of parts) {
      const encoded = Buffer.concat([Buffer.from(part, "latin1"), Buffer.from([0])]);
      const fd = lib.symbols.openat(parent, ptr(encoded), directoryFlags, 0);
      if (fd < 0) throw new Error(missing() ? "capture-file-missing" : "unsafe-capture-ancestor");
      fds.push(fd);
      parent = fd;
    }
    const link = Buffer.alloc(Math.min(maxBytes + 1, 64 * 1024));
    const linkSize = Number(lib.symbols.readlinkat(parent, ptr(name), ptr(link), link.length));
    if (linkSize >= 0) {
      if (linkSize >= link.length || linkSize > maxBytes) throw new Error("capture-file-too-large");
      return { bytes: link.subarray(0, linkSize), info: null, after: null, symlink: true };
    }
    const fd = lib.symbols.openat(
      parent,
      ptr(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    );
    if (fd < 0) throw new Error(missing() ? "capture-file-missing" : "capture-file-unavailable");
    fds.push(fd);
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("capture-file-unsupported");
    if (info.size > maxBytes) throw new Error("capture-file-too-large");
    // Reserve a fixed bound before reading, even if another writer grows it.
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let size = 0;
    while (size < bytes.length) {
      if (signal?.aborted) throw new Error("capture-timeout");
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
      if (signal?.aborted) throw new Error("capture-timeout");
      if (!n) break;
      size += n;
    }
    if (size > maxBytes) throw new Error("capture-file-too-large");
    return { bytes: bytes.subarray(0, size), info, after: fstatSync(fd), symlink: false };
  } finally {
    for (const fd of fds.reverse()) closeSync(fd);
    lib.close();
  }
}
