import { constants, promises as fs, type Stats } from "node:fs";
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
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
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
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid ${label}: path must stay inside the workspace`);
  }

  return normalized;
}

export function workspaceFilePath(filePath: string): string {
  return `/workspace/${validateRelativeFilePath(filePath)}`;
}

/** Exact decoded size of a padded, whitespace-free base64 string. */
export function base64DecodedByteLength(normalizedBase64: string): number {
  const padding = normalizedBase64.endsWith("==")
    ? 2
    : normalizedBase64.endsWith("=")
      ? 1
      : 0;
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
   * a planted file. Overwrite-intended writers (an editor save, a re-staged
   * clipboard image) pass `false` and get `O_TRUNC` instead.
   */
  exclusive?: boolean;
  /** Label used in path validation errors. */
  label?: string;
};

async function isSameDirectoryEntry(
  directoryPath: string,
  expected: Stats,
): Promise<boolean> {
  // Identity, not spelling. Comparing `realpath(parent)` to the lexical parent
  // string rejects a legitimate directory on a case-insensitive filesystem: a
  // pre-existing `.Orkestrator` makes mkdir return EEXIST and realpath report
  // the on-disk casing, which never equals the requested `.orkestrator`.
  try {
    const stats = await fs.lstat(directoryPath);
    return !stats.isSymbolicLink()
      && stats.isDirectory()
      && stats.dev === expected.dev
      && stats.ino === expected.ino;
  } catch {
    return false;
  }
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
  const content = typeof payload === "string"
    ? Buffer.from(assertBase64PayloadWithinLimit(payload), "base64")
    : payload;
  if (content.byteLength > MAX_WRITE_FILE_BYTES) {
    throw new Error(`File payload exceeds ${MAX_WRITE_FILE_BYTES} bytes`);
  }
  const canonicalRoot = await fs.realpath(rootPath);
  const fullPath = path.join(canonicalRoot, target);
  const parentPath = path.dirname(fullPath);

  let current = canonicalRoot;
  let parentStats = await fs.lstat(canonicalRoot);
  for (const segment of target.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Invalid ${label}: symlink or non-directory ancestor: ${target}`);
    }
    const canonicalDirectory = await fs.realpath(current);
    if (!isPathInsideRoot(canonicalDirectory, canonicalRoot)) {
      throw new Error(`Invalid ${label}: path leaves the local worktree: ${target}`);
    }
    parentStats = stats;
  }

  // Validate the immediate parent again immediately before opening the file.
  if (!await isSameDirectoryEntry(parentPath, parentStats)) {
    throw new Error(`Invalid ${label}: symlink ancestor is not allowed: ${target}`);
  }
  const handle = await fs.open(
    fullPath,
    constants.O_WRONLY
      | constants.O_CREAT
      | (options.exclusive === false ? constants.O_TRUNC : constants.O_EXCL)
      | (constants.O_NOFOLLOW || 0),
    0o600,
  );
  let completed = false;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Attachment target is not a regular file");
    const pathStats = await fs.lstat(fullPath);
    if (
      pathStats.isSymbolicLink()
      || pathStats.dev !== opened.dev
      || pathStats.ino !== opened.ino
    ) {
      throw new Error("Attachment target changed while it was being opened");
    }
    if (!isPathInsideRoot(await fs.realpath(fullPath), canonicalRoot)) {
      throw new Error("Attachment target is outside the local worktree");
    }

    await handle.writeFile(content);
    const finalOpened = await handle.stat();
    const finalPath = await fs.lstat(fullPath);
    if (
      !finalOpened.isFile()
      || finalOpened.size !== content.byteLength
      || finalPath.isSymbolicLink()
      || finalPath.dev !== finalOpened.dev
      || finalPath.ino !== finalOpened.ino
      || !await isSameDirectoryEntry(parentPath, parentStats)
    ) {
      throw new Error("Attachment target changed while it was being written");
    }
    completed = true;
    return fullPath;
  } finally {
    await handle.close().catch(() => undefined);
    // Only an exclusively created file is unambiguously ours to remove. An
    // overwrite failure leaves a truncated file the caller already owned;
    // deleting it would turn a failed save into a deleted file.
    if (!completed && options.exclusive !== false) {
      await fs.rm(fullPath, { force: true }).catch(() => undefined);
    }
  }
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
    !pathStats.isFile()
    || !openedStats.isFile()
    || pathStats.dev !== openedStats.dev
    || pathStats.ino !== openedStats.ino
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
  const handle = await fs.open(
    targetPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );

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
      const remaining = (MAX_BINARY_FILE_BYTES + 1) - totalBytes;
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
      finalStats.dev !== initialStats.dev
      || finalStats.ino !== initialStats.ino
      || finalStats.size !== initialStats.size
      || finalStats.size !== totalBytes
      || finalStats.mtimeMs !== initialStats.mtimeMs
      || finalStats.ctimeMs !== initialStats.ctimeMs
    ) {
      throw new Error("File changed while it was being read; please try again");
    }

    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}
