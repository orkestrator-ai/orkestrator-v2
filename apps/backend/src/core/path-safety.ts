import { promises as fs } from "node:fs";
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
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

export async function resolveReadableHostFilePath(filePath: string, allowedRoots = defaultReadableHostRoots()): Promise<string> {
  if (filePath.length === 0) {
    throw new Error("Invalid file path: path is empty");
  }

  rejectControlCharacters(filePath, "file path");

  if (!path.isAbsolute(filePath)) {
    throw new Error("Invalid file path: absolute path is required");
  }

  const realPath = await fs.realpath(filePath);
  const stats = await fs.stat(realPath);
  if (!stats.isFile()) {
    throw new Error(`Invalid file path: not a regular file: ${filePath}`);
  }
  if (stats.size > MAX_BINARY_FILE_BYTES) {
    throw new Error(`File exceeds ${MAX_BINARY_FILE_BYTES} bytes: ${filePath}`);
  }

  const normalizedRealPath = realPath.split(path.sep).join("/");
  const normalizedAllowedRoots = await Promise.all(allowedRoots.map(async (root) => fs.realpath(root).catch(() => path.resolve(root))));
  if (!normalizedAllowedRoots.some((root) => isPathInsideRoot(realPath, root))) {
    throw new Error("Invalid file path: file is outside Orkestrator workspace storage");
  }

  return normalizedRealPath.split("/").join(path.sep);
}
