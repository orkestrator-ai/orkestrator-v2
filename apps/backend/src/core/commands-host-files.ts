import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { asString, assertOnlyKeys } from "./commands-validation.js";
import type { CommandRegistrar } from "./commands-registry-types.js";

/** Upper bound on entries returned for one directory; the rest are reported as truncated. */
export const MAX_HOST_DIRECTORY_ENTRIES = 2_000;
const MAX_HOST_PATH_LENGTH = 4_096;
/** Common filesystem limit for a single path component, in UTF-8 bytes. */
const MAX_HOST_FOLDER_NAME_BYTES = 255;
/** Characters Windows rejects in file names, in addition to path separators. */
const WINDOWS_RESERVED_NAME_CHARACTERS = /[<>:"|?*]/;
/** Symlinks need a follow-up stat to learn whether they point at a directory. */
const SYMLINK_STAT_CONCURRENCY = 16;

export type HostDirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export type HostDirectoryListing = {
  /** Absolute directory that was actually listed (the nearest existing ancestor of the request). */
  path: string;
  /** Normalized explicitly requested non-directory, independent of the listing cap. */
  requestedFile: string | null;
  /** Parent directory, or null at a filesystem root. */
  parent: string | null;
  home: string;
  /** Top-level locations to jump to: `/` on POSIX, existing drive letters on Windows. */
  roots: string[];
  entries: HostDirectoryEntry[];
  /** True when the directory held more than MAX_HOST_DIRECTORY_ENTRIES visible entries. */
  truncated: boolean;
};

function expandHome(requested: string): string {
  if (requested === "~") return os.homedir();
  if (requested.startsWith("~/") || requested.startsWith("~\\")) {
    return path.join(os.homedir(), requested.slice(2));
  }
  return requested;
}

export async function listHostDirectoryRoots(platform = process.platform): Promise<string[]> {
  if (platform !== "win32") return [path.parse(os.homedir()).root || "/"];
  const drives = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  const present = await Promise.all(
    drives.map((drive) =>
      fs.access(drive).then(
        () => drive,
        () => null,
      ),
    ),
  );
  return present.filter((drive): drive is string => drive !== null);
}

/**
 * Resolves the directory to show for a typed or remembered path. A path that no
 * longer exists (or is a file) falls back to the nearest ancestor directory so
 * the picker always opens somewhere useful instead of failing on a stale default.
 */
async function resolveListableDirectory(
  requested: string | undefined,
): Promise<{ directory: string; requestedFile: string | null }> {
  const trimmed = requested?.trim();
  if (trimmed && trimmed.length > MAX_HOST_PATH_LENGTH) {
    throw new Error("path is too long");
  }
  const expanded = trimmed ? expandHome(trimmed) : os.homedir();
  if (!path.isAbsolute(expanded)) {
    throw new Error("path must be absolute or start with ~");
  }
  let candidate = path.resolve(expanded);
  let requestedFile: string | null = null;
  const normalizedRequest = candidate;
  for (;;) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return { directory: candidate, requestedFile };
      if (candidate === normalizedRequest) requestedFile = candidate;
    } catch {
      // Missing or unreadable: try the parent.
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return { directory: candidate, requestedFile };
    candidate = parent;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Lists one directory of the filesystem the backend runs on. Orkestrator's file
 * and folder pickers are rendered by the client but must browse the host, so a
 * remote client sees the remote machine rather than its own.
 */
export async function listHostDirectory(
  requestedPath: string | undefined,
  options: { includeFiles: boolean; showHidden: boolean },
): Promise<HostDirectoryListing> {
  const { directory, requestedFile } = await resolveListableDirectory(requestedPath);
  let dirents;
  try {
    dirents = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Permission denied reading ${directory}`);
    }
    throw error;
  }

  const visible = dirents.filter((dirent) => options.showHidden || !dirent.name.startsWith("."));
  const resolved = await mapWithConcurrency(visible, SYMLINK_STAT_CONCURRENCY, async (dirent) => {
    const entryPath = path.join(directory, dirent.name);
    if (dirent.isDirectory()) return { name: dirent.name, path: entryPath, isDirectory: true };
    if (dirent.isSymbolicLink()) {
      try {
        const target = await fs.stat(entryPath);
        return { name: dirent.name, path: entryPath, isDirectory: target.isDirectory() };
      } catch {
        return null; // Broken link: nothing to pick.
      }
    }
    return { name: dirent.name, path: entryPath, isDirectory: false };
  });

  const entries = resolved
    .filter((entry): entry is HostDirectoryEntry => entry !== null)
    .filter((entry) => entry.isDirectory || options.includeFiles)
    .sort(
      (a, b) =>
        Number(b.isDirectory) - Number(a.isDirectory) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

  const parent = path.dirname(directory);
  return {
    path: directory,
    requestedFile: options.includeFiles ? requestedFile : null,
    parent: parent === directory ? null : parent,
    home: os.homedir(),
    roots: await listHostDirectoryRoots(),
    entries: entries.slice(0, MAX_HOST_DIRECTORY_ENTRIES),
    truncated: entries.length > MAX_HOST_DIRECTORY_ENTRIES,
  };
}

/**
 * Checks a folder name typed into the picker. It must name exactly one new
 * entry inside the parent, so separators and `.`/`..` are refused rather than
 * letting the name escape into another directory.
 */
export function validateHostFolderName(name: string, platform = process.platform): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Folder name is required");
  if (trimmed === "." || trimmed === "..") throw new Error("Folder name cannot be . or ..");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("Folder name cannot contain / or \\");
  }
  if (Array.from(trimmed).some((character) => character.charCodeAt(0) < 0x20)) {
    throw new Error("Folder name cannot contain control characters");
  }
  if (platform === "win32" && WINDOWS_RESERVED_NAME_CHARACTERS.test(trimmed)) {
    throw new Error('Folder name cannot contain < > : " | ? *');
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_HOST_FOLDER_NAME_BYTES) {
    throw new Error("Folder name is too long");
  }
  return trimmed;
}

/**
 * Creates one new folder inside an existing directory on the backend host, so
 * the picker can make a destination (for example a new project's parent) on the
 * machine it is browsing. It never creates missing parents or reuses an
 * existing entry.
 */
export async function createHostDirectory(parent: string, name: string): Promise<{ path: string }> {
  const trimmedParent = parent.trim();
  if (!trimmedParent) throw new Error("parent is required");
  if (trimmedParent.length > MAX_HOST_PATH_LENGTH) throw new Error("path is too long");
  const expandedParent = expandHome(trimmedParent);
  if (!path.isAbsolute(expandedParent)) {
    throw new Error("path must be absolute or start with ~");
  }
  const directory = path.resolve(expandedParent);
  const folderName = validateHostFolderName(name);

  let parentStat;
  try {
    parentStat = await fs.stat(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`Folder ${directory} does not exist`);
    if (code === "ENOTDIR") throw new Error(`${directory} is not a folder`);
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Permission denied accessing ${directory}`);
    }
    throw error;
  }
  if (!parentStat.isDirectory()) throw new Error(`${directory} is not a folder`);

  const target = path.join(directory, folderName);
  if (target.length > MAX_HOST_PATH_LENGTH) throw new Error("path is too long");
  try {
    await fs.mkdir(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(`"${folderName}" already exists in ${directory}`);
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new Error(`Permission denied creating a folder in ${directory}`);
    }
    throw error;
  }
  return { path: target };
}

export function registerHostFileCommands(register: CommandRegistrar): void {
  register("list_host_directory", async (args) => {
    assertOnlyKeys(args, ["path", "includeFiles", "showHidden"], "arguments");
    const requestedPath = args.path === undefined ? undefined : asString(args.path, "path");
    for (const flag of ["includeFiles", "showHidden"] as const) {
      if (args[flag] !== undefined && typeof args[flag] !== "boolean") {
        throw new Error(`Expected ${flag} to be a boolean`);
      }
    }
    return listHostDirectory(requestedPath, {
      includeFiles: args.includeFiles === true,
      showHidden: args.showHidden === true,
    });
  });

  register("create_host_directory", async (args) => {
    assertOnlyKeys(args, ["parent", "name"], "arguments");
    return createHostDirectory(asString(args.parent, "parent"), asString(args.name, "name"));
  });
}
