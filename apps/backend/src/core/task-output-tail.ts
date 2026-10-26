import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { isTaskOutputFile } from "./agent-human-prompt-monitor.js";

/**
 * The last `bytes` of a provider's background-task output file, or `null`.
 *
 * Only the provider's own task output files are opened (see
 * `isTaskOutputFile`): the path comes from the agent's transcript, so it is
 * never trusted to name anything else.
 */
async function readTail(path: string, bytes: number): Promise<string | null> {
  if (!isTaskOutputFile(path)) return null;
  // Never follow a link planted where a task file is expected.
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const { size } = stat;
    const length = Math.min(size, Math.max(0, bytes), 64 * 1024);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** A slow filesystem must not pin the monitor's whole pass. */
export async function readTaskOutputTail(path: string, bytes: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readTail(path, bytes),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
