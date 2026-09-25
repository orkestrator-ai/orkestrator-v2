/**
 * Safe writes and ownership-checked removal of materialized annotation
 * evidence under the app-generated `.orkestrator/annotations/` directory.
 *
 * The directory lives inside a workspace the agent (and anything it runs)
 * can modify, so every path component is re-checked at use: no component
 * from the canonical workspace root to the file may be a symbolic link, the
 * file is written to an exclusive temp name and renamed into place (a rename
 * replaces a name; it never follows a link planted at the target), and a
 * removal deletes only a regular file whose bytes still hash to the digest
 * recorded for the request that wrote it. User files that happen to share
 * the directory are never touched.
 *
 * Container variants run as `node -e` scripts inside the container, the same
 * way the existing safe container reader does.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { WEB_ANNOTATION_WORKSPACE_DIRECTORY } from "@orkestrator/protocol/web-annotations";

/** True for app-generated evidence paths (relative to the workspace root). */
export function isAnnotationEvidencePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return (
    normalized.startsWith(`${WEB_ANNOTATION_WORKSPACE_DIRECTORY}/`) &&
    !normalized.split("/").some((part) => part === ".." || part === "." || part === "") &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.png$/.test(path.posix.basename(normalized))
  );
}

const SCRIPT_PRELUDE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
function fail(message) {
  const error = new Error(message);
  error.safeMessage = true;
  throw error;
}
function inside(rootPath, targetPath) {
  const child = path.relative(rootPath, targetPath);
  return child !== "" && child !== ".." && !child.startsWith(".." + path.sep) && !path.isAbsolute(child);
}
function report(error) {
  process.stderr.write((error && error.safeMessage ? error.message : "Evidence file operation failed") + "\n");
  process.exit(3);
}
`;

/**
 * `node -e SCRIPT -- <root> <relative path> <max base64 chars>`; base64 PNG
 * on stdin. Creates missing directories, refuses any symbolic link, writes an
 * exclusive temp file (O_EXCL | O_NOFOLLOW), fsyncs, and renames it over the
 * final name.
 */
export const CONTAINER_EVIDENCE_WRITER = `${SCRIPT_PRELUDE}
const root = path.resolve(process.argv[1]);
const relative = process.argv[2];
const limit = Number(process.argv[3]);
const chunks = [];
let size = 0;
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > limit) report(Object.assign(new Error("Evidence payload is too large"), { safeMessage: true }));
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  try {
    const data = Buffer.from(Buffer.concat(chunks).toString("latin1").replace(/\\s/g, ""), "base64");
    const canonicalRoot = fs.realpathSync(root);
    const target = path.resolve(canonicalRoot, relative);
    if (!inside(canonicalRoot, target)) fail("Evidence path is outside the container workspace");
    let current = canonicalRoot;
    for (const segment of path.relative(canonicalRoot, path.dirname(target)).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stats;
      try {
        stats = fs.lstatSync(current);
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
        fs.mkdirSync(current, { mode: 0o755 });
        stats = fs.lstatSync(current);
      }
      if (stats.isSymbolicLink()) fail("Symbolic links are not allowed in the evidence path");
      if (!stats.isDirectory()) fail("Evidence parent is not a directory");
    }
    let existing = null;
    try {
      existing = fs.lstatSync(target);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    if (existing && !existing.isFile()) fail("Evidence target is not a regular file");
    const temp = path.join(path.dirname(target), "." + path.basename(target) + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp");
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o644);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temp, target);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
    process.stdout.write(target);
  } catch (error) {
    report(error);
  }
});
`;

/**
 * `node -e SCRIPT -- <root> <relative path> <sha256 hex> <max bytes>`.
 * Prints `removed`, `missing`, or `mismatch`. Never follows a link and never
 * removes a file whose content no longer matches the recorded digest.
 */
export const CONTAINER_EVIDENCE_REMOVER = `${SCRIPT_PRELUDE}
try {
  const root = path.resolve(process.argv[1]);
  const relative = process.argv[2];
  const digest = process.argv[3];
  const limit = Number(process.argv[4]);
  const canonicalRoot = fs.realpathSync(root);
  const target = path.resolve(canonicalRoot, relative);
  if (!inside(canonicalRoot, target)) fail("Evidence path is outside the container workspace");
  let current = canonicalRoot;
  let outcome = null;
  for (const segment of path.relative(canonicalRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (error && error.code === "ENOENT") { outcome = "missing"; break; }
      throw error;
    }
    if (stats.isSymbolicLink()) { outcome = "mismatch"; break; }
  }
  if (!outcome) {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let matches = false;
    try {
      const stats = fs.fstatSync(fd);
      if (stats.isFile() && stats.size <= limit) {
        const hash = crypto.createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let read;
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
        matches = hash.digest("hex") === digest;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (matches) {
      fs.unlinkSync(target);
      outcome = "removed";
    } else {
      outcome = "mismatch";
    }
  }
  process.stdout.write(outcome);
} catch (error) {
  report(error);
}
`;

export type EvidenceRemovalOutcome = "removed" | "missing" | "mismatch";

type SpawnPipe = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

/**
 * Run one of the scripts above inside a container (`docker exec -i ... node
 * -e`), piping `stdin` and returning bounded stdout. Failures surface the
 * script's own content-free message (first line, bounded).
 */
export function runContainerEvidenceScript(
  spawn: SpawnPipe,
  containerId: string,
  script: string,
  args: string[],
  stdin: string,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["exec", "-i", containerId, "node", "-e", script, "--", ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 8_192) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_048) stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolvePromise(stdout);
      const message = stderr.split("\n", 1)[0]?.trim().slice(0, 300);
      reject(new Error(message || `docker exec exited with ${code}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

/** False when a component is missing; throws on a link or a non-directory parent. */
async function assertNoLinks(root: string, target: string): Promise<boolean> {
  let current = root;
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      return false;
    }
    if (stats.isSymbolicLink())
      throw new Error("Symbolic links are not allowed in the evidence path");
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error("Evidence parent is not a directory");
    }
  }
  return true;
}

function resolveInside(root: string, relativePath: string): string {
  if (!isAnnotationEvidencePath(relativePath)) {
    throw new Error("Path is not an app-generated evidence path");
  }
  const target = path.resolve(root, relativePath);
  const child = path.relative(root, target);
  if (!child || child.startsWith("..") || path.isAbsolute(child)) {
    throw new Error("Evidence path is outside the workspace");
  }
  return target;
}

/**
 * Local-worktree counterpart of `CONTAINER_EVIDENCE_REMOVER`. (Local writes
 * already go through `writeConfinedFile`, which pins the canonical root and
 * refuses links.)
 */
export async function removeLocalEvidence(
  worktreePath: string,
  relativePath: string,
  digest: string,
  maxBytes: number,
): Promise<EvidenceRemovalOutcome> {
  let root: string;
  try {
    root = await realpath(worktreePath);
  } catch {
    return "missing";
  }
  const target = resolveInside(root, relativePath);
  try {
    if (!(await assertNoLinks(root, target))) return "missing";
  } catch {
    return "mismatch";
  }
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "mismatch";
  }
  let matches = false;
  try {
    const stats = await handle.stat();
    if (stats.isFile() && stats.size <= maxBytes) {
      matches =
        createHash("sha256")
          .update(await handle.readFile())
          .digest("hex") === digest;
    }
  } finally {
    await handle.close();
  }
  if (!matches) return "mismatch";
  await unlink(target);
  return "removed";
}
