/// <reference types="bun" />
import { constants, fstatSync } from "node:fs";
import { dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";

/** Descriptor-relative operations only. Unsupported platforms fail closed. */
export function designExportDirectory() {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Descriptor-relative exports unavailable");
  const at = [FFIType.i32, FFIType.ptr] as const;
  const symbols = {
    openat: { args: [...at, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    mkdirat: { args: [...at, FFIType.i32], returns: FFIType.i32 },
    readlinkat: { args: [...at, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    linkat: { args: [...at, ...at, FFIType.i32], returns: FFIType.i32 },
    renameat: { args: [...at, ...at], returns: FFIType.i32 },
    unlinkat: { args: [...at, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  } as const;
  const library =
    process.platform === "darwin"
      ? dlopen("/usr/lib/libSystem.B.dylib", {
          ...symbols,
          __error: { args: [], returns: FFIType.ptr },
        })
      : dlopen("libc.so.6", { ...symbols, __errno_location: { args: [], returns: FFIType.ptr } });
  const fds: number[] = [];
  const encoded = (name: string) => Buffer.from(`${name}\0`);
  const errno = () =>
    read.i32(
      process.platform === "darwin"
        ? (library.symbols as { __error(): Pointer }).__error()
        : (library.symbols as { __errno_location(): Pointer }).__errno_location(),
      0,
    );
  const codes: Record<number, string> = {
    2: "ENOENT",
    17: "EEXIST",
    20: "ENOTDIR",
    40: "ELOOP",
    62: "ELOOP",
  };
  const check = (result: number) => {
    if (result < 0)
      throw Object.assign(new Error("Descriptor operation failed"), {
        code: codes[errno()] ?? "EIO",
      });
    return result;
  };
  const open = (parent: number, name: string, flags: number, mode = 0) => {
    const value = encoded(name);
    // libc opens must not leak repository descriptors into unrelated children.
    const closeOnExec =
      (constants as Record<string, number>).O_CLOEXEC ??
      (process.platform === "darwin" ? 0x1000000 : 0x80000);
    const fd = check(library.symbols.openat(parent, ptr(value), flags | closeOnExec, mode));
    fds.push(fd);
    return fd;
  };
  const isSymlink = (parent: number, name: string) => {
    const value = encoded(name),
      scratch = Buffer.alloc(1);
    return library.symbols.readlinkat(parent, ptr(value), ptr(scratch), 1) >= 0;
  };
  return {
    open,
    isSymlink,
    directory(parent: number, name: string, create: boolean) {
      const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
      try {
        return open(parent, name, flags);
      } catch (error) {
        if (create && (error as NodeJS.ErrnoException).code === "ENOENT") {
          const value = encoded(name);
          const result = library.symbols.mkdirat(parent, ptr(value), 0o755);
          if (result < 0 && errno() !== 17) check(result);
          return open(parent, name, flags);
        }
        if (isSymlink(parent, name)) throw Object.assign(new Error("Symlink"), { code: "ELOOP" });
        throw error;
      }
    },
    publish(parent: number, temp: string, target: string, replace: boolean) {
      const source = encoded(temp),
        destination = encoded(target);
      check(
        replace
          ? library.symbols.renameat(parent, ptr(source), parent, ptr(destination))
          : library.symbols.linkat(parent, ptr(source), parent, ptr(destination), 0),
      );
    },
    unlink(parent: number, name: string) {
      const value = encoded(name);
      check(library.symbols.unlinkat(parent, ptr(value), 0));
    },
    stats: fstatSync,
    close() {
      for (const fd of fds.reverse()) library.symbols.close(fd);
      library.close();
    },
  };
}
