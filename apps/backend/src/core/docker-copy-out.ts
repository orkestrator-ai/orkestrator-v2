import {
  isDockerCopyRemountRefused,
  isDockerDaemonUnreachable,
  isDockerPathNotFound,
} from "./docker-cli-errors.js";
import { CommandFailedError, runCommandBuffer } from "./shell.js";

/**
 * Bounded reads of one small file out of a container with `docker cp … -`,
 * which works on a created or stopped container as well as a running one.
 */

export type CopyOutResult =
  | { kind: "bytes"; tar: Buffer }
  /** The daemon answered that the path does not exist. */
  | { kind: "absent" }
  /** The CLI reached no daemon. */
  | { kind: "daemon-unavailable" }
  /**
   * The daemon could not remount one of the container's read-only binds, so
   * it refuses every copy for this container (`docker-copy-refusal.ts`).
   */
  | { kind: "refused" }
  | { kind: "failed" }
  | { kind: "oversized" };

/** Docker's own message; generous so it cannot read as an oversized file. */
const MAX_COPY_OUT_STDERR_BYTES = 64 * 1024;

export async function copyOutBounded(
  containerId: string,
  filePath: string,
  maxBytes: number,
  timeoutMs = 30_000,
): Promise<CopyOutResult> {
  try {
    const { stdout } = await runCommandBuffer("docker", ["cp", `${containerId}:${filePath}`, "-"], {
      timeoutMs,
      // A tar stream of one small file is its content plus headers and padding.
      maxOutputBytes: maxBytes + 4 * 1024,
      maxStderrBytes: MAX_COPY_OUT_STDERR_BYTES,
    });
    return { kind: "bytes", tar: stdout };
  } catch (error) {
    if (!(error instanceof CommandFailedError) || error.timedOut) return { kind: "failed" };
    if (error.outputLimitExceeded) return { kind: "oversized" };
    if (isDockerPathNotFound(error.stderr)) return { kind: "absent" };
    if (isDockerDaemonUnreachable(error.stderr)) return { kind: "daemon-unavailable" };
    if (isDockerCopyRemountRefused(error.stderr)) return { kind: "refused" };
    return { kind: "failed" };
  }
}

/**
 * Extracts the single regular file from a `docker cp … -` tar stream. The tar
 * header carries the type and size, so a symlink, directory or oversized entry
 * is refused without trusting anything but the bytes Docker produced.
 */
export function extractSingleTarFile(
  tar: Buffer,
  maxBytes: number,
): { ok: true; content: string } | { ok: false; reason: string } {
  if (tar.length < 512) return { ok: false, reason: "truncated" };
  const header = tar.subarray(0, 512);
  const type = String.fromCharCode(header[156] ?? 0);
  if (type !== "0" && type !== "\0") return { ok: false, reason: "not-a-regular-file" };
  const sizeField = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
  const size = Number.parseInt(sizeField, 8);
  if (!Number.isSafeInteger(size) || size < 0) return { ok: false, reason: "malformed" };
  if (size > maxBytes) return { ok: false, reason: "oversized" };
  if (tar.length < 512 + size) return { ok: false, reason: "truncated" };
  return { ok: true, content: tar.subarray(512, 512 + size).toString("utf8") };
}
