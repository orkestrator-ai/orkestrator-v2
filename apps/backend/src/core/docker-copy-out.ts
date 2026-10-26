import { isDockerDaemonUnreachable, isDockerPathNotFound } from "./docker-cli-errors.js";
import { spawnCommand } from "./shell.js";

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
  | { kind: "failed" }
  | { kind: "oversized" };

export async function copyOutBounded(
  containerId: string,
  filePath: string,
  maxBytes: number,
  timeoutMs = 30_000,
): Promise<CopyOutResult> {
  // A tar stream of one small file is its content plus headers and padding.
  const limit = maxBytes + 4 * 1024;
  return new Promise((resolve) => {
    const child = spawnCommand("docker", ["cp", `${containerId}:${filePath}`, "-"]);
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let settled = false;
    const finish = (value: CopyOutResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ kind: "failed" });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        child.kill("SIGKILL");
        finish({ kind: "oversized" });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString();
    });
    child.on("error", () => finish({ kind: "failed" }));
    child.on("close", (code) => {
      if (code === 0) finish({ kind: "bytes", tar: Buffer.concat(chunks) });
      else if (isDockerPathNotFound(stderr)) finish({ kind: "absent" });
      else if (isDockerDaemonUnreachable(stderr)) finish({ kind: "daemon-unavailable" });
      else finish({ kind: "failed" });
    });
  });
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
