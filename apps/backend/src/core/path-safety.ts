import { constants, promises as fs, type Stats } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { APP_SLUG } from "./constants.js";

export const MAX_BINARY_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_WRITE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_BASE64_PAYLOAD_BYTES = Math.ceil(MAX_WRITE_FILE_BYTES / 3) * 4 + 4;

const CONTROL_PATH_CHARS = /[\0\r\n]/;

function defaultReadableHostRoots(): string[] {
  return [path.join(os.homedir(), APP_SLUG, "workspaces")];
}

function isPathInsideRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function rejectControlCharacters(filePath: string, label: string): void {
  if (CONTROL_PATH_CHARS.test(filePath)) {
    throw new Error(`Invalid ${label}: control characters are not allowed`);
  }
}

export function validateRelativeFilePath(filePath: string, label = "file path"): string {
  if (filePath.length === 0) {
    throw new Error(`Invalid ${label}: path is empty`);
  }

  rejectControlCharacters(filePath, label);

  if (path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error(`Invalid ${label}: absolute paths are not allowed`);
  }

  const slashPath = filePath.replaceAll("\\", "/");
  if (slashPath.split("/").includes("..")) {
    throw new Error(`Invalid ${label}: parent directory traversal is not allowed`);
  }

  const normalized = path.posix.normalize(slashPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Invalid ${label}: path must stay inside the workspace`);
  }

  return normalized;
}

export function workspaceFilePath(filePath: string): string {
  return `/workspace/${validateRelativeFilePath(filePath)}`;
}

/** Exact decoded size of a padded, whitespace-free base64 string. */
export function base64DecodedByteLength(normalizedBase64: string): number {
  const padding = normalizedBase64.endsWith("==") ? 2 : normalizedBase64.endsWith("=") ? 1 : 0;
  return (normalizedBase64.length / 4) * 3 - padding;
}

/**
 * Validates an untrusted base64 payload once and returns the normalized form.
 *
 * Callers reuse the returned string rather than stripping whitespace again:
 * every `replace(/\s/g, "")` allocates a fresh copy of a payload that may be
 * 11MB. The decoded size is computed arithmetically for the same reason - a
 * `Buffer.from(..., "base64")` purely to measure the result is another full
 * allocation.
 */
export function assertBase64PayloadWithinLimit(
  base64Data: string,
  options: { rejectEmpty?: boolean } = {},
): string {
  const normalized = base64Data.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("File payload is not valid base64");
  }
  // Ordered before the structural checks so an oversized payload is reported as
  // oversized rather than as a base64 defect it also happens to have.
  if (normalized.length > MAX_BASE64_PAYLOAD_BYTES) {
    throw new Error(`File payload exceeds ${MAX_WRITE_FILE_BYTES} bytes`);
  }
  // Emptiness is only a defect for a payload that is supposed to carry content.
  // A file write may legitimately truncate a file to nothing - the editor does
  // exactly that when the user clears a buffer - so only callers that would
  // otherwise advertise a 0-byte artifact opt in.
  if (options.rejectEmpty && normalized.length === 0) {
    throw new Error("File payload must not be empty");
  }
  if (normalized.length % 4 !== 0) {
    throw new Error("File payload is not valid base64");
  }
  if (base64DecodedByteLength(normalized) > MAX_WRITE_FILE_BYTES) {
    throw new Error(`File payload exceeds ${MAX_WRITE_FILE_BYTES} bytes`);
  }
  return normalized;
}

type ConfinedWriteOptions = {
  /**
   * Refuse the write when the target already exists (`O_EXCL`). Attachment
   * batches own a freshly created, unpredictable directory and must never adopt
   * a planted file. Overwrite-intended writers pass `false` and atomically
   * publish a fully-written sibling over the prior entry.
   */
  exclusive?: boolean;
  /** Label used in path validation errors. */
  label?: string;
  /** Dedicated command-owned artifacts may have a larger audited budget. */
  maxBytes?: number;
  /** Final mode applied to the still-open temporary inode before publication. */
  fileMode?: number;
};

// The helper's cwd is resolved by the kernel during spawn and remains pinned to
// that directory object even if a repository process renames an ancestor. All
// opens, publishes, and cleanup are relative to that cwd, so no post-validation
// pathname lookup can reach a replacement directory outside the worktree.
const PINNED_CWD_WRITE_HELPER = String.raw`
const fs = require("node:fs");
const [targetPath, mode, expectedDev, expectedIno, expectedBytes, fileMode] = process.argv.slice(1);
const invalidAncestor = () => { process.stderr.write("symlink or non-directory ancestor"); process.exit(73); };
const cwd = fs.statSync(".");
if (String(cwd.dev) !== expectedDev || String(cwd.ino) !== expectedIno) invalidAncestor();
const segments = targetPath.split("/");
const target = segments.pop();
for (const segment of segments) {
  try {
    const stat = fs.lstatSync(segment);
    if (stat.isSymbolicLink() || !stat.isDirectory()) invalidAncestor();
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    try { fs.mkdirSync(segment, { mode: 0o700 }); }
    catch (mkdirError) { if (!mkdirError || mkdirError.code !== "EEXIST") throw mkdirError; }
  }
  const expected = fs.lstatSync(segment);
  process.chdir(segment);
  const pinned = fs.statSync(".");
  if (pinned.dev !== expected.dev || pinned.ino !== expected.ino) invalidAncestor();
}
const chunks = [];
let bytes = 0;
process.stdin.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > Number(expectedBytes)) process.exit(74);
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  if (bytes !== Number(expectedBytes)) process.exit(74);
  const temp = "." + target + "." + require("node:crypto").randomUUID() + ".tmp";
  let fd;
  let identity;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    identity = fs.fstatSync(fd);
    fs.writeFileSync(fd, Buffer.concat(chunks));
    fs.fchmodSync(fd, Number(fileMode));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (mode === "exclusive") {
      fs.linkSync(temp, target);
      fs.unlinkSync(temp);
    } else {
      fs.renameSync(temp, target);
    }
    const published = fs.lstatSync(target);
    if (published.isSymbolicLink() || !published.isFile() || published.dev !== identity.dev || published.ino !== identity.ino) {
      process.exit(75);
    }
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try {
      const current = fs.lstatSync(temp);
      if (identity && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(temp);
    } catch {}
    const code = error && typeof error.code === "string" ? error.code : "WRITE_FAILED";
    process.stderr.write(code);
    process.exit(76);
  }
});
`;

const PINNED_CWD_REMOVE_DIRECTORY_HELPER = String.raw`
const fs = require("node:fs");
const [relativePath, expectedDev, expectedIno] = process.argv.slice(1);
const root = fs.statSync(".");
if (String(root.dev) !== expectedDev || String(root.ino) !== expectedIno) process.exit(73);
const segments = relativePath.split("/"), target = segments.pop();
for (const segment of segments) {
  let stat; try { stat = fs.lstatSync(segment); } catch { process.exit(0); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) process.exit(0);
  process.chdir(segment);
  const pinned = fs.statSync(".");
  if (pinned.dev !== stat.dev || pinned.ino !== stat.ino) process.exit(73);
}
let final; try { final = fs.lstatSync(target); } catch { process.exit(0); }
if (final.isSymbolicLink() || !final.isDirectory()) process.exit(0);
fs.rmSync(target, { recursive: true, force: true });
`;

async function writeFromPinnedRoot(
  rootPath: string,
  rootStats: Stats,
  target: string,
  content: Buffer,
  exclusive: boolean,
  fileMode: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        PINNED_CWD_WRITE_HELPER,
        target,
        exclusive ? "exclusive" : "overwrite",
        String(rootStats.dev),
        String(rootStats.ino),
        String(content.byteLength),
        String(fileMode),
      ],
      {
        cwd: rootPath,
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 1_024) stderr += chunk.toString().slice(0, 1_024 - stderr.length);
    });
    child.once("error", reject);
    // `exit` can precede the final stderr data event. Settle on `close`, which
    // fires after the stdio streams close, so a fail-closed helper diagnostic
    // is not nondeterministically replaced by the bare exit code.
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Confined file write failed (${stderr || `exit ${code}`})`));
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // An identity/symlink rejection can close stdin before the bounded
      // payload is consumed. The exit status is the authoritative failure.
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(content);
  });
}

/** Removes one directory tree relative to a root-pinned child cwd. */
export async function removeConfinedDirectory(
  rootPath: string,
  relativePath: string,
): Promise<void> {
  const target = validateRelativeFilePath(relativePath, "directory path");
  const canonicalRoot = await fs.realpath(rootPath);
  const rootStats = await fs.lstat(canonicalRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        PINNED_CWD_REMOVE_DIRECTORY_HELPER,
        target,
        String(rootStats.dev),
        String(rootStats.ino),
      ],
      { cwd: canonicalRoot, stdio: ["ignore", "ignore", "ignore"] },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Confined directory cleanup failed (exit ${code})`)),
    );
  });
}

/**
 * Writes one command-owned artifact into a worktree without following a
 * repository symlink.
 *
 * Every ancestor is created and checked segment by segment, and the file itself
 * is opened with `O_NOFOLLOW`. Re-checking the path and descriptor identity
 * before and after the write detects replacement races instead of reporting an
 * unsafe or ambiguous write as successful.
 *
 * `payload` may be a pre-decoded buffer so a batch that already validated and
 * decoded its items does not pay for a second strip and decode per file.
 */
export async function writeConfinedFile(
  rootPath: string,
  relativePath: string,
  payload: string | Buffer,
  options: ConfinedWriteOptions = {},
): Promise<string> {
  const label = options.label ?? "attachment path";
  const target = validateRelativeFilePath(relativePath, label);
  const content =
    typeof payload === "string"
      ? Buffer.from(assertBase64PayloadWithinLimit(payload), "base64")
      : payload;
  const maxBytes = options.maxBytes ?? MAX_WRITE_FILE_BYTES;
  if (content.byteLength > maxBytes) {
    throw new Error(`File payload exceeds ${maxBytes} bytes`);
  }
  const fileMode = options.fileMode ?? 0o600;
  if (!Number.isInteger(fileMode) || fileMode < 0 || fileMode > 0o777) {
    throw new Error("Invalid confined file mode");
  }
  const canonicalRoot = await fs.realpath(rootPath);
  const fullPath = path.join(canonicalRoot, target);
  const rootStats = await fs.lstat(canonicalRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Invalid ${label}: worktree root is not a directory`);
  }
  await writeFromPinnedRoot(
    canonicalRoot,
    rootStats,
    target,
    content,
    options.exclusive !== false,
    fileMode,
  );
  let current = canonicalRoot;
  for (const segment of target.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Invalid ${label}: ancestor changed after the write: ${target}`);
    }
    if (!isPathInsideRoot(await fs.realpath(current), canonicalRoot)) {
      throw new Error(`Invalid ${label}: path leaves the local worktree: ${target}`);
    }
  }
  return fullPath;
}

async function resolveReadableHostTarget(
  filePath: string,
  allowedRoots: string[],
): Promise<{ canonicalRoot: string; canonicalTarget: string; targetPath: string }> {
  if (filePath.length === 0) {
    throw new Error("Invalid file path: path is empty");
  }

  rejectControlCharacters(filePath, "file path");

  if (!path.isAbsolute(filePath)) {
    throw new Error("Invalid file path: absolute path is required");
  }

  const targetPath = path.resolve(filePath);
  const lexicalRoots = allowedRoots.map((root) => path.resolve(root));
  const lexicalRoot = lexicalRoots.find((root) => isPathInsideRoot(targetPath, root));
  if (!lexicalRoot) {
    throw new Error("Invalid file path: file is outside Orkestrator workspace storage");
  }

  let currentPath = lexicalRoot;
  const relativeTarget = path.relative(lexicalRoot, targetPath);
  for (const segment of relativeTarget.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const stats = await fs.lstat(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error("Invalid file path: symbolic links are not allowed");
    }
  }

  const [canonicalRoot, canonicalTarget] = await Promise.all([
    fs.realpath(lexicalRoot),
    fs.realpath(targetPath),
  ]);
  if (!isPathInsideRoot(canonicalTarget, canonicalRoot)) {
    throw new Error("Invalid file path: file is outside Orkestrator workspace storage");
  }

  return { canonicalRoot, canonicalTarget, targetPath };
}

async function assertOpenedHostFile(
  targetPath: string,
  canonicalRoot: string,
  openedStats: Stats,
): Promise<void> {
  const [pathStats, canonicalTarget] = await Promise.all([
    fs.lstat(targetPath),
    fs.realpath(targetPath),
  ]);
  if (pathStats.isSymbolicLink()) {
    throw new Error("Invalid file path: symbolic links are not allowed");
  }
  if (
    !pathStats.isFile() ||
    !openedStats.isFile() ||
    pathStats.dev !== openedStats.dev ||
    pathStats.ino !== openedStats.ino
  ) {
    throw new Error("Invalid file path: not a stable regular file");
  }
  if (!isPathInsideRoot(canonicalTarget, canonicalRoot)) {
    throw new Error("Invalid file path: file is outside Orkestrator workspace storage");
  }
}

/**
 * Reads one bounded snapshot from Orkestrator-managed workspace storage.
 * Validation, fstat, and reads all apply to the same no-follow file handle.
 */
export async function readReadableHostFile(
  filePath: string,
  allowedRoots = defaultReadableHostRoots(),
  testHooks?: {
    afterInitialValidation?: () => void | Promise<void>;
  },
): Promise<Buffer> {
  const { canonicalRoot, targetPath } = await resolveReadableHostTarget(filePath, allowedRoots);
  const handle = await fs.open(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));

  try {
    const initialStats = await handle.stat();
    await assertOpenedHostFile(targetPath, canonicalRoot, initialStats);
    if (initialStats.size > MAX_BINARY_FILE_BYTES) {
      throw new Error(`File exceeds ${MAX_BINARY_FILE_BYTES} bytes`);
    }
    await testHooks?.afterInitialValidation?.();

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_BINARY_FILE_BYTES) {
      const remaining = MAX_BINARY_FILE_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_BINARY_FILE_BYTES) {
      throw new Error(`File exceeds ${MAX_BINARY_FILE_BYTES} bytes`);
    }

    const finalStats = await handle.stat();
    await assertOpenedHostFile(targetPath, canonicalRoot, finalStats);
    if (
      finalStats.dev !== initialStats.dev ||
      finalStats.ino !== initialStats.ino ||
      finalStats.size !== initialStats.size ||
      finalStats.size !== totalBytes ||
      finalStats.mtimeMs !== initialStats.mtimeMs ||
      finalStats.ctimeMs !== initialStats.ctimeMs
    ) {
      throw new Error("File changed while it was being read; please try again");
    }

    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}
