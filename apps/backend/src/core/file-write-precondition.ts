/**
 * Server side of `@orkestrator/protocol/file-write-precondition`: an editor
 * save names the SHA-256 of the content it loaded, and the write happens only
 * while the file still has those bytes.
 *
 * Both writers publish atomically: the whole payload goes to a temporary file
 * beside the target, the precondition is checked again, and only then is the
 * temporary file published at the target. Absence checks publish with a hard
 * link that fails if the target already exists. A reader never sees a partial save
 * and a refused or interrupted save leaves the file as it was. The local writer
 * is `writeFileBase64` (`expectedSha256`); the container writer is the script
 * below.
 *
 * Limitation, as for design export (`design/export-writer.ts`): the final step
 * is check-then-rename, not an atomic compare-and-swap. Orkestrator's own
 * saves within each workspace are serialized (`serializeFileWrite`). An agent
 * or terminal writing the file in the instant between the last check and the
 * rename is still replaced. The window is a few system calls wide.
 */
import {
  FILE_WRITE_CONFLICT_MESSAGE,
  type FileWritePrecondition,
} from "@orkestrator/protocol/file-write-precondition";
import { MAX_TEXT_FILE_BYTES } from "./path-safety.js";
import { quoteShell } from "./commands/agent-support.js";

export function fileWriteConflictError(): Error {
  return new Error(FILE_WRITE_CONFLICT_MESSAGE);
}

/** The container writer could not resolve a regular file inside the workspace. */
export function fileWriteNotRegularFileError(): Error {
  return new Error("Cannot save: the path is not a regular file");
}

/** Exit status of the container writer when the precondition fails. */
export const CONTAINER_WRITE_CONFLICT_EXIT = 75;
/** Exit status of the container writer when the target is not a regular file. */
export const CONTAINER_WRITE_NOT_FILE_EXIT = 73;
export const CONTAINER_WRITE_METADATA_EXIT = 76;
export const CONTAINER_WRITE_ACCESS_EXIT = 77;

/**
 * The managed image supplies Node and GNU cp. Pin the destination directory as
 * cwd, stage bytes in it, then publish to one exact directory entry. Copy access
 * metadata only from the existing inode and refuse publication if it cannot be
 * retained. The lexical editor path is checked again before publication.
 */
const CONTAINER_FILE_WRITER = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const [root, requested, expected, byteLength, digestLimit] = process.argv.slice(1);
const checked = expected !== "-";
const canonicalRoot = fs.realpathSync(root);
const originalTarget = path.join(canonicalRoot, path.relative(root, requested));
const fail = (message, exitCode = 1) => Object.assign(new Error(message), { exitCode });
const conflict = () => fail("file changed", ${CONTAINER_WRITE_CONFLICT_EXIT});
const invalidTarget = () => checked ? conflict() : fail("not a regular file", ${CONTAINER_WRITE_NOT_FILE_EXIT});
const inside = (file) => {
  const relative = path.relative(canonicalRoot, file);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
function resolveTarget() {
  try {
    const lexical = lstat(requested);
    if (expected === "absent" && lexical) throw conflict();
    if (lexical) {
      const resolved = fs.realpathSync(requested);
      if (resolved === canonicalRoot || !inside(resolved)) throw invalidTarget();
      return resolved;
    }
    const parent = fs.realpathSync(path.dirname(requested));
    if (!inside(parent)) throw invalidTarget();
    return path.join(parent, path.basename(requested));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP") {
      throw invalidTarget();
    }
    throw error;
  }
}
const sameInode = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
const sameVersion = (a, b) => sameInode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function verifyDigest(fd, stats) {
  const limit = Number(digestLimit);
  if (stats.size > limit) throw conflict();
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(65536);
  let total = 0;
  while (total <= limit) {
    const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, limit + 1 - total), total);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    total += read;
  }
  if (total > limit || total !== stats.size || hash.digest("hex") !== expected) throw conflict();
}
function assertDestination(resolved, directory) {
  if (resolveTarget() !== resolved || !sameInode(fs.statSync(path.dirname(resolved)), directory)) {
    throw invalidTarget();
  }
}
function openCurrent(target) {
  const current = lstat(target);
  if (!current) {
    if (checked && expected !== "absent") throw conflict();
    return undefined;
  }
  if (expected === "absent" || !current.isFile()) throw invalidTarget();
  // Enforce access as the container user, even if the parent permits renames.
  const access = checked ? fs.constants.O_RDWR : fs.constants.O_WRONLY;
  let fd;
  try {
    fd = fs.openSync(target, access | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS") {
      throw fail("file is not writable", ${CONTAINER_WRITE_ACCESS_EXIT});
    }
    if (["EISDIR", "ENOTDIR", "ENOENT", "ELOOP"].includes(error.code)) throw invalidTarget();
    throw error;
  }
  if (!sameInode(current, fs.fstatSync(fd))) {
    fs.closeSync(fd);
    throw invalidTarget();
  }
  return { current, fd };
}
function stageAndPublish(resolved, directory, target, payload) {
  assertDestination(resolved, directory);
  const temp = ".orkestrator-save." + crypto.randomUUID();
  const staged = fs.openSync(temp, "wx", 0o600);
  const identity = fs.fstatSync(staged);
  let existing;
  try {
    fs.writeFileSync(staged, payload);
    fs.fsyncSync(staged);
    existing = openCurrent(target);
    if (existing) {
      const { current, fd } = existing;
      // Pin both sides of the metadata copy to their open Linux inodes.
      const descriptors = "/proc/" + process.pid + "/fd/";
      const copied = spawnSync("cp", [
        "--dereference", "--attributes-only", "--preserve=mode,ownership,xattr",
        "--", descriptors + fd, descriptors + staged,
      ], { stdio: "ignore", timeout: 15000 });
      const metadata = fs.fstatSync(staged);
      if (copied.status !== 0 || metadata.uid !== current.uid || metadata.gid !== current.gid ||
          (metadata.mode & 0o7777) !== (current.mode & 0o7777)) {
        throw fail("could not preserve file access metadata", ${CONTAINER_WRITE_METADATA_EXIT});
      }
      if (checked) verifyDigest(fd, current);
      if (!sameVersion(current, fs.fstatSync(fd)) || !sameVersion(current, lstat(target))) {
        throw invalidTarget();
      }
    } else {
      fs.fchmodSync(staged, 0o666 & ~process.umask());
    }
    assertDestination(resolved, directory);
    if (!sameInode(identity, lstat(temp))) throw fail("staging file changed");
    if (existing) fs.renameSync(temp, target);
    else {
      try { fs.linkSync(temp, target); }
      catch (error) { if (error.code === "EEXIST") throw invalidTarget(); throw error; }
    }
  } catch (error) {
    if (error.code === "EISDIR" || error.code === "ENOTDIR") throw invalidTarget();
    throw error;
  } finally {
    if (existing) fs.closeSync(existing.fd);
    fs.closeSync(staged);
    if (sameInode(identity, lstat(temp))) fs.unlinkSync(temp);
  }
}
async function main() {
  const relative = path.relative(root, requested);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw invalidTarget();
  }
  if (!checked) {
    // Validate the prospective canonical parent before creating below it.
    let ancestor = path.dirname(originalTarget);
    while (!lstat(ancestor)) ancestor = path.dirname(ancestor);
    const pinnedAncestor = fs.realpathSync(ancestor);
    if (!inside(pinnedAncestor)) throw invalidTarget();
    process.chdir(pinnedAncestor);
    if (process.cwd() !== pinnedAncestor) throw invalidTarget();
    const remainder = path.relative(ancestor, path.dirname(originalTarget));
    for (const segment of remainder.split(path.sep).filter(Boolean)) {
      try { fs.mkdirSync(segment); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const named = lstat(segment);
      if (!named?.isDirectory()) throw invalidTarget();
      process.chdir(segment);
      if (!sameInode(named, fs.statSync("."))) throw invalidTarget();
    }
  }
  const resolved = resolveTarget();
  const target = path.basename(resolved);
  process.chdir(path.dirname(resolved));
  const directory = fs.statSync(".");
  assertDestination(resolved, directory);
  const existing = openCurrent(target);
  if (existing) {
    try { if (checked) verifyDigest(existing.fd, existing.current); }
    finally { fs.closeSync(existing.fd); }
  }
  const chunks = [];
  const encodedLength = Math.ceil(Number(byteLength) / 3) * 4;
  let received = 0;
  for await (const chunk of process.stdin) {
    received += chunk.length;
    if (received > encodedLength) throw fail("invalid payload length");
    chunks.push(chunk);
  }
  const encoded = Buffer.concat(chunks).toString("ascii");
  const payload = Buffer.from(encoded, "base64");
  if (received !== encodedLength || payload.length !== Number(byteLength) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw fail("incomplete or invalid payload");
  }
  stageAndPublish(resolved, directory, target, payload);
}
main().catch((error) => {
  process.stderr.write((error.exitCode ? error.message : (error.code || "file write failed")) + "\n");
  process.exit(error.exitCode || 1);
});
`;

export function containerFileWriteScript(
  fullPath: string,
  expected: FileWritePrecondition | undefined,
  byteLength: number,
  workspaceRoot = "/workspace",
): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("Invalid byte length");
  const precondition = expected ? ("sha256" in expected ? expected.sha256 : "absent") : "-";
  return `node -e ${quoteShell(CONTAINER_FILE_WRITER)} -- ${quoteShell(workspaceRoot)} ${quoteShell(fullPath)} ${quoteShell(precondition)} ${byteLength} ${MAX_TEXT_FILE_BYTES}`;
}

const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Serialize workspace saves so a path and its symlink aliases cannot both
 * pass the same precondition before either writes.
 */
export function serializeFileWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(key, settled);
  void settled.then(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  });
  return next;
}
