/**
 * Reads one blob with a single `git cat-file --batch` process, which answers
 * the object's type and size on its header line before the body. A read that
 * used to spawn `cat-file -s` and then `show` now spawns once, and the size is
 * still checked before the body is consumed: an oversized blob is refused
 * from its header, never read in full.
 */
import { HARDENED_GIT_CONFIG } from "./git-fsmonitor.js";
import { nonInteractiveGitEnv as localGitEnv } from "./shell.js";

/** Longest header line accepted: `<object> missing` echoes the request. */
export const GIT_BATCH_HEADER_MAX_BYTES = 16 * 1024;
const GIT_BLOB_READ_TIMEOUT_MS = 30_000;

export type GitBatchHeader =
  { kind: "object"; oid: string; type: string; size: number } | { kind: "missing" };

export type GitBlobRead =
  | { kind: "blob"; bytes: Buffer }
  | { kind: "missing" }
  | { kind: "not-blob"; type: string }
  | { kind: "too-large"; size: number };

/**
 * Parses a `--batch` header line (without its newline). `missing` and
 * `ambiguous` both mean no single object answers the name.
 */
export function parseGitBatchHeader(line: string): GitBatchHeader {
  const object = /^([0-9a-f]{40,64}) ([a-z]+) (\d+)$/.exec(line);
  if (object) {
    const size = Number(object[3]);
    if (!Number.isSafeInteger(size)) throw new Error("git cat-file reported an invalid size");
    return { kind: "object", oid: object[1]!, type: object[2]!, size };
  }
  if (line.endsWith(" missing") || line.endsWith(" ambiguous")) return { kind: "missing" };
  throw new Error("git cat-file returned an unexpected header");
}

/**
 * Interprets the bytes one `--batch` request produced: a header line, then,
 * for an object, its body. `output` may be cut short by a reader that stopped
 * after the size limit; a blob is returned only when its whole body is there.
 */
export function decodeGitBatchOutput(output: Buffer, maxBytes: number): GitBlobRead | null {
  const newline = output.indexOf(0x0a);
  if (newline < 0) {
    if (output.byteLength > GIT_BATCH_HEADER_MAX_BYTES) {
      throw new Error("git cat-file returned an unexpected header");
    }
    return null;
  }
  const header = parseGitBatchHeader(output.subarray(0, newline).toString("utf8"));
  if (header.kind === "missing") return { kind: "missing" };
  if (header.type !== "blob") return { kind: "not-blob", type: header.type };
  if (header.size > maxBytes) return { kind: "too-large", size: header.size };
  const body = output.subarray(newline + 1);
  if (body.byteLength < header.size) return null;
  return { kind: "blob", bytes: Buffer.from(body.subarray(0, header.size)) };
}

/**
 * The shell command a container runs for one bounded read: one `cat-file`
 * process, its output cut after the largest answer that can be accepted, then
 * base64 for the text channel. Without `pipefail`, `head` closing early is
 * not a failure.
 */
export function containerGitBlobReadCommand(object: string, maxBytes: number): string {
  const quoted = `'${object.replace(/'/g, `'\\''`)}'`;
  const limit = maxBytes + GIT_BATCH_HEADER_MAX_BYTES + 1;
  return `printf '%s\\n' ${quoted} | git cat-file --batch 2>/dev/null | head -c ${limit} | base64`;
}

/**
 * One `git cat-file --batch` read in `cwd`. Stops reading (and kills the
 * process) as soon as the answer is known, so an oversized blob costs its
 * header only.
 */
export async function readGitBlob(
  cwd: string,
  object: string,
  maxBytes: number,
  options: { timeoutMs?: number } = {},
): Promise<GitBlobRead> {
  if (/[\r\n\0]/.test(object)) throw new Error("Invalid git object name");
  const child = Bun.spawn(["git", ...HARDENED_GIT_CONFIG, "-C", cwd, "cat-file", "--batch"], {
    env: localGitEnv(undefined),
    stdin: Buffer.from(`${object}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(
    () => child.kill("SIGKILL"),
    options.timeoutMs ?? GIT_BLOB_READ_TIMEOUT_MS,
  );
  const reader = child.stdout.getReader();
  // Header bytes until the first newline, then body chunks until `size` arrived.
  let head = Buffer.alloc(0);
  let header: Extract<GitBatchHeader, { kind: "object" }> | null = null;
  const body: Buffer[] = [];
  let bodyBytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value && value.byteLength > 0) {
        let chunk = Buffer.from(value);
        if (!header) {
          head = Buffer.concat([head, chunk]);
          const newline = head.indexOf(0x0a);
          if (newline < 0) {
            if (head.byteLength > GIT_BATCH_HEADER_MAX_BYTES) {
              throw new Error("git cat-file returned an unexpected header");
            }
            if (done) break;
            continue;
          }
          const parsed = parseGitBatchHeader(head.subarray(0, newline).toString("utf8"));
          if (parsed.kind === "missing") return { kind: "missing" };
          if (parsed.type !== "blob") return { kind: "not-blob", type: parsed.type };
          if (parsed.size > maxBytes) return { kind: "too-large", size: parsed.size };
          header = parsed;
          chunk = head.subarray(newline + 1);
        }
        body.push(chunk);
        bodyBytes += chunk.byteLength;
        if (bodyBytes >= header.size) {
          return { kind: "blob", bytes: Buffer.concat(body, bodyBytes).subarray(0, header.size) };
        }
      }
      if (done) break;
    }
    const stderr = (await new Response(child.stderr).text()).trim().slice(0, 2_000);
    throw new Error(stderr || "git cat-file ended before answering");
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
    // The answer is complete (or the read failed): the process has nothing
    // more this read needs, and an oversized body is never drained.
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
