/**
 * Awaited fsync of a file or directory, shared by the object store and the
 * evidence body store. `FileHandle.sync` runs on the thread pool, so a disk
 * flush never stalls the event loop.
 */

import { open } from "node:fs/promises";

export type SyncPath = (path: string, kind: "file" | "directory") => Promise<void>;

/**
 * A platform or filesystem that cannot fsync this kind of path keeps the old
 * atomic-rename guarantee. A real failure (EIO, ENOSPC) must reach the caller,
 * because the object would otherwise be named while not durable.
 */
function syncUnsupported(error: unknown, kind: "file" | "directory"): boolean {
  const code = (error as NodeJS.ErrnoException).code ?? "";
  if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") return true;
  return kind === "directory" && ["EISDIR", "EPERM", "EACCES", "ENOENT"].includes(code);
}

export async function fsyncPath(path: string, kind: "file" | "directory"): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!syncUnsupported(error, kind)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
