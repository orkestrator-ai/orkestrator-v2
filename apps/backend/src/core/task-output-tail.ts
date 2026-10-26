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
export async function readTaskOutputTail(path: string, bytes: number): Promise<string | null> {
  if (!isTaskOutputFile(path)) return null;
  // Never follow a link planted where a task file is expected.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const { size } = stat;
    const length = Math.min(size, bytes);
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
