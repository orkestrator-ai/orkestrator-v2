import { promises as fs } from "node:fs";
import path from "node:path";

import {
  MAX_PROJECT_COPY_BYTES,
  MAX_PROJECT_COPY_CANDIDATES,
  MAX_PROJECT_COPY_FILES,
  isEnvFileName,
  isHeavyProjectPath,
  type ProjectCopyCandidate,
  type ProjectCopyFileList,
} from "@orkestrator/protocol/project-copy";

import { isPathInsideRoot, normalizeConfiguredProjectFiles } from "../commands-project-files.js";
import { validateRelativeFilePath } from "../path-safety.js";
import { runCommandBuffer } from "../shell.js";
import { MAX_NODE_FILE_BYTES } from "./node-files.js";
import { SEED_MANIFEST } from "./node-seed.js";

/**
 * The source side of copying a project to another machine: which files Git
 * does not carry (untracked and ignored), and the regular files under the
 * ones the user picked.
 *
 * Paths are relative to the project root, use `/`, and never enter `.git`
 * or follow a symbolic link. Directory walks are bounded, so listing a
 * project with a large `node_modules` stays cheap: its size is reported as
 * "at least" once the walk stops.
 */

/** Files one directory walk counts before reporting a lower bound. */
const MEASURE_FILES_PER_ENTRY = 20_000;
/** Entries all walks of one listing visit together. */
const MEASURE_ENTRIES_TOTAL = 200_000;
const GIT_TIMEOUT_MS = 30_000;
const UPLOAD_PREFIX = ".orkestrator-upload-";

function isProtectedPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return (
    parts.some((part) => part.toLowerCase() === ".git") ||
    relativePath === SEED_MANIFEST ||
    parts.some((part) => part.startsWith(UPLOAD_PREFIX))
  );
}

async function gitPaths(root: string, args: string[]): Promise<string[]> {
  const { stdout } = await runCommandBuffer(
    "git",
    ["-c", "core.quotePath=false", "ls-files", "-z", ...args],
    { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
  );
  return stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

type Budget = { visited: number };

/** Size and file count of one directory, bounded; symlinks and `.git` are skipped. */
async function measureDirectory(
  absolute: string,
  budget: Budget,
): Promise<{ bytes: number; files: number; truncated: boolean }> {
  let bytes = 0;
  let files = 0;
  const stack = [absolute];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      budget.visited += 1;
      if (files >= MEASURE_FILES_PER_ENTRY || budget.visited > MEASURE_ENTRIES_TOTAL) {
        return { bytes, files, truncated: true };
      }
      if (entry.isSymbolicLink() || entry.name.toLowerCase() === ".git") continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        const stat = await fs.lstat(child).catch(() => null);
        if (!stat?.isFile()) continue;
        bytes += stat.size;
        files += 1;
      }
    }
  }
  return { bytes, files, truncated: false };
}

async function describe(
  root: string,
  relativePath: string,
  ignored: boolean,
  suggested: ReadonlySet<string>,
  budget: Budget,
): Promise<ProjectCopyCandidate | null> {
  const isDirectory = relativePath.endsWith("/");
  const bare = isDirectory ? relativePath.slice(0, -1) : relativePath;
  if (!bare || isProtectedPath(bare)) return null;
  const absolute = path.join(root, bare);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return null;
  const heavy = isHeavyProjectPath(bare);
  const name = path.posix.basename(bare);
  const base = {
    ignored,
    heavy,
    suggested:
      !heavy && (suggested.has(bare.toLowerCase()) || (!isDirectory && isEnvFileName(name))),
  };
  if (stat.isDirectory()) {
    const measured = await measureDirectory(absolute, budget);
    if (measured.files === 0 && !measured.truncated) return null;
    return { path: `${bare}/`, kind: "directory", ...measured, ...base };
  }
  if (!stat.isFile()) return null;
  return {
    path: bare,
    kind: "file",
    bytes: stat.size,
    files: 1,
    truncated: false,
    ...base,
  };
}

/**
 * Untracked and ignored entries of a project root, wholly untracked or
 * ignored directories collapsed into one entry. Configured files to copy
 * are listed on their own (and suggested) even inside a collapsed
 * directory, so picking them never means picking the whole directory.
 */
export async function listProjectCopyCandidates(
  root: string,
  filesToCopy: readonly string[] | undefined,
): Promise<{ candidates: ProjectCopyCandidate[]; truncated: boolean }> {
  const configured = normalizeConfiguredProjectFiles([...(filesToCopy ?? [])]).map((entry) =>
    entry.split(path.sep).join("/"),
  );
  const suggested = new Set(configured.map((entry) => entry.toLowerCase()));
  const [untracked, ignored] = await Promise.all([
    gitPaths(root, ["--others", "--exclude-standard", "--directory", "--no-empty-directory"]),
    gitPaths(root, [
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
    ]),
  ]);
  const ignoredSet = new Set(ignored);
  const listed = new Set<string>();
  const ordered: Array<{ path: string; ignored: boolean }> = [];
  for (const entry of [...untracked, ...ignored]) {
    if (listed.has(entry)) continue;
    listed.add(entry);
    ordered.push({ path: entry, ignored: ignoredSet.has(entry) });
  }
  for (const entry of configured) {
    if (listed.has(entry) || listed.has(`${entry}/`)) continue;
    // Only configured files Git does not track: a tracked file arrives with the clone.
    const inside = ordered.some((item) => item.path.endsWith("/") && entry.startsWith(item.path));
    if (!inside) continue;
    listed.add(entry);
    ordered.push({ path: entry, ignored: true });
  }
  const budget: Budget = { visited: 0 };
  const candidates: ProjectCopyCandidate[] = [];
  let truncated = false;
  for (const entry of ordered) {
    if (candidates.length >= MAX_PROJECT_COPY_CANDIDATES) {
      truncated = true;
      break;
    }
    const candidate = await describe(root, entry.path, entry.ignored, suggested, budget);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort(
    (a, b) =>
      Number(b.suggested) - Number(a.suggested) ||
      Number(a.heavy) - Number(b.heavy) ||
      a.path.localeCompare(b.path),
  );
  return { candidates, truncated };
}

/**
 * The regular files under the chosen paths, deduplicated, with sizes.
 * Refuses (rather than truncates) past the copy limits, so a copy is never
 * silently partial.
 */
export async function listProjectCopyFiles(
  root: string,
  paths: readonly string[],
): Promise<ProjectCopyFileList> {
  const realRoot = await fs.realpath(root);
  const files = new Map<string, number>();
  let skipped = 0;
  const tooLarge: string[] = [];
  let totalBytes = 0;
  const add = (relativePath: string, bytes: number) => {
    if (files.has(relativePath)) return;
    if (isProtectedPath(relativePath)) {
      skipped += 1;
      return;
    }
    if (bytes > MAX_NODE_FILE_BYTES) {
      if (tooLarge.length < 20) tooLarge.push(relativePath);
      return;
    }
    files.set(relativePath, bytes);
    totalBytes += bytes;
    if (files.size > MAX_PROJECT_COPY_FILES) {
      throw new Error(
        `That selection has more than ${MAX_PROJECT_COPY_FILES.toLocaleString("en-US")} files. Pick fewer.`,
      );
    }
    if (totalBytes > MAX_PROJECT_COPY_BYTES) {
      throw new Error("That selection is larger than 2 GiB. Pick fewer files.");
    }
  };
  for (const requested of paths) {
    const bare = requested.endsWith("/") ? requested.slice(0, -1) : requested;
    const safe = validateRelativeFilePath(bare, "file path").split(path.sep).join("/");
    if (isProtectedPath(safe)) {
      skipped += 1;
      continue;
    }
    const absolute = path.join(realRoot, safe);
    // A folder on the way may itself be a link out of the project.
    const parent = await fs.realpath(path.dirname(absolute)).catch(() => null);
    const stat =
      parent && isPathInsideRoot(parent, realRoot)
        ? await fs.lstat(absolute).catch(() => null)
        : null;
    if (!stat || stat.isSymbolicLink()) {
      skipped += 1;
      continue;
    }
    if (stat.isFile()) {
      add(safe, stat.size);
      continue;
    }
    if (!stat.isDirectory()) {
      skipped += 1;
      continue;
    }
    const stack = [safe];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      const entries = await fs
        .readdir(path.join(realRoot, dir), { withFileTypes: true })
        .catch(() => []);
      for (const entry of entries) {
        const child = `${dir}/${entry.name}`;
        if (entry.isSymbolicLink() || entry.name.toLowerCase() === ".git") {
          skipped += 1;
          continue;
        }
        if (entry.isDirectory()) {
          stack.push(child);
        } else if (entry.isFile()) {
          const fileStat = await fs.lstat(path.join(realRoot, child)).catch(() => null);
          if (fileStat?.isFile()) add(child, fileStat.size);
        } else {
          skipped += 1;
        }
      }
    }
  }
  return {
    files: [...files].map(([file, bytes]) => ({ path: file, bytes })),
    totalBytes,
    skipped,
    tooLarge,
  };
}
