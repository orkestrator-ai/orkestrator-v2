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

export function assertBase64PayloadWithinLimit(base64Data: string): void {
  const normalized = base64Data.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("File payload is not valid base64");
  }
  if (normalized.length > MAX_BASE64_PAYLOAD_BYTES) {
    throw new Error(`File payload exceeds ${MAX_WRITE_FILE_BYTES} bytes`);
  }
  if (Buffer.from(normalized, "base64").byteLength > MAX_WRITE_FILE_BYTES) {
    throw new Error(`File payload exceeds ${MAX_WRITE_FILE_BYTES} bytes`);
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
