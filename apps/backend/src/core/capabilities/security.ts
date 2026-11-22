/**
 * Filesystem safety for capability packages
 * (docs/architecture/agent-capabilities-management.md, "Security").
 *
 * Package content is untrusted: a cloned repository, an uploaded folder or a
 * directory someone else wrote. Every read here is bounded (files, bytes,
 * depth), refuses device files, sockets and FIFOs, and refuses a symbolic
 * link that leaves the tree; a link that stays inside is read as the file it
 * points to, so an artifact never contains a link. Every write goes through
 * `confinedPath`, which joins only a validated relative path under a root
 * the backend chose, so no caller can name a destination.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  lstatSync,
  promises as fs,
  realpathSync,
  renameSync,
} from "node:fs";
import path from "node:path";

import {
  CAPABILITY_LIMITS,
  isSafeCapabilityRelativePath,
} from "@orkestrator/protocol/capability-resources";

export class CapabilityError extends Error {
  constructor(
    readonly code:
      | "invalid-request"
      | "not-found"
      | "conflict"
      | "unsafe-content"
      | "too-large"
      | "unsupported"
      | "stale-epoch"
      | "approval-required"
      | "secrets-detected"
      | "source-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

export interface PackageFile {
  /** Forward-slash relative path inside the package. */
  path: string;
  bytes: number;
  executable: boolean;
  sha256: string;
  content: Buffer;
}

/** Directory names never read into a package. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".DS_Store"]);
/** Marker files Orkestrator itself writes; excluded from digests. */
export const CAPABILITY_MARKER_FILE = ".orkestrator-capability.json";
export const CAPABILITY_LOCATION_INDEX = ".orkestrator-capabilities.json";

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Check every existing directory below the canonical agent-test data root. */
export function assertCapabilityDirectory(directory: string, isolationRoot?: string): void {
  if (!isolationRoot) return;
  const unsafe = () =>
    new CapabilityError(
      "unsafe-content",
      "The capability directory is outside the isolated profile or uses a symbolic link.",
    );
  try {
    if (
      !isInside(isolationRoot, directory) ||
      realpathSync(isolationRoot) !== isolationRoot ||
      !lstatSync(isolationRoot).isDirectory()
    )
      throw unsafe();
    let current = isolationRoot;
    const relative = path.relative(isolationRoot, directory);
    for (const segment of relative ? relative.split(path.sep) : []) {
      current = path.join(current, segment);
      const existing = lstatSync(current, { throwIfNoEntry: false });
      // With a verified parent, a missing suffix can be created safely.
      if (!existing) return;
      if (!existing.isDirectory()) throw unsafe();
    }
  } catch {
    throw unsafe();
  }
}

/** `root/<relative>`, after validating `relative`; throws when it would escape. */
export function confinedPath(root: string, relative: string): string {
  if (!isSafeCapabilityRelativePath(relative)) {
    throw new CapabilityError("unsafe-content", "A package path is not a safe relative path.");
  }
  const resolved = path.resolve(root, ...relative.split("/"));
  if (!isInside(path.resolve(root), resolved)) {
    throw new CapabilityError("unsafe-content", "A package path leaves its directory.");
  }
  return resolved;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Digest(data: Buffer | string): string {
  return `sha256:${sha256Hex(data)}`;
}

/**
 * The content digest of a file tree: paths, the executable bit and each
 * file's hash, in path order. Independent of timestamps, owners and the
 * order the filesystem lists entries in.
 */
export function treeDigest(
  files: ReadonlyArray<Pick<PackageFile, "path" | "executable" | "sha256">>,
): string {
  const lines = [...files]
    .filter((file) => !isMarkerPath(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\0${file.executable ? 1 : 0}\0${file.sha256}\n`);
  return sha256Digest(lines.join(""));
}

/** Code-point order: the same on every machine and locale. */
function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function isMarkerPath(relative: string): boolean {
  const base = relative.split("/").pop() ?? relative;
  return base === CAPABILITY_MARKER_FILE || base === CAPABILITY_LOCATION_INDEX;
}

export interface ReadTreeOptions {
  within?: string;
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
  /** Read only these top-level relative entries (a single command file). */
  only?: string[];
}

/**
 * Reads a directory into memory with every bound enforced. Throws
 * `unsafe-content` for a device file, socket, FIFO or escaping link, and
 * `too-large` past a bound, so a hostile tree fails closed rather than
 * being partly imported.
 */
export async function readPackageTree(
  root: string,
  options: ReadTreeOptions = {},
): Promise<PackageFile[]> {
  const maxFiles = options.maxFiles ?? CAPABILITY_LIMITS.maxPackageFiles;
  const maxBytes = options.maxBytes ?? CAPABILITY_LIMITS.maxPackageBytes;
  const maxFileBytes = options.maxFileBytes ?? CAPABILITY_LIMITS.maxFileBytes;
  const realRoot = await fs.realpath(root);
  if (
    options.within &&
    realRoot !== path.join(await fs.realpath(options.within), path.basename(root))
  ) {
    throw new CapabilityError(
      "unsafe-content",
      "The inventory item is outside the provider directory.",
    );
  }
  const files: PackageFile[] = [];
  let total = 0;

  const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > CAPABILITY_LIMITS.maxPathDepth) {
      throw new CapabilityError("too-large", "The package is nested too deeply.");
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (depth === 0 && options.only && !options.only.includes(entry.name)) continue;
      if (isMarkerPath(childRelative)) continue;
      if (!isSafeCapabilityRelativePath(childRelative)) {
        throw new CapabilityError(
          "unsafe-content",
          "The package contains a file name that is not safe.",
        );
      }
      const absolute = path.join(directory, entry.name);
      let stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        const target = await fs.realpath(absolute).catch(() => null);
        if (!target || !isInside(realRoot, target)) {
          throw new CapabilityError(
            "unsafe-content",
            `The package contains a symbolic link (${childRelative}) that points outside it.`,
          );
        }
        stat = await fs.stat(target);
        if (stat.isDirectory()) {
          throw new CapabilityError(
            "unsafe-content",
            `The package contains a symbolic link to a directory (${childRelative}).`,
          );
        }
      }
      if (stat.isDirectory()) {
        await visit(absolute, childRelative, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        throw new CapabilityError(
          "unsafe-content",
          `The package contains a special file (${childRelative}).`,
        );
      }
      if (files.length >= maxFiles) {
        throw new CapabilityError("too-large", `The package has more than ${maxFiles} files.`);
      }
      if (stat.size > maxFileBytes) {
        throw new CapabilityError(
          "too-large",
          `${childRelative} is larger than the per-file limit.`,
        );
      }
      total += stat.size;
      if (total > maxBytes) {
        throw new CapabilityError("too-large", "The package is larger than the size limit.");
      }
      const content = await fs.readFile(absolute);
      files.push({
        path: childRelative,
        bytes: content.length,
        executable: (stat.mode & 0o111) !== 0,
        sha256: sha256Hex(content),
        content,
      });
    }
  };

  await visit(realRoot, "", 0);
  return files.sort(byPath);
}

/** Validates in-memory files (an upload, an authored package, a received bundle). */
export function validatePackageFiles(
  input: ReadonlyArray<{ path: string; content: Buffer; executable?: boolean }>,
): PackageFile[] {
  if (input.length > CAPABILITY_LIMITS.maxPackageFiles) {
    throw new CapabilityError("too-large", "The package has too many files.");
  }
  let total = 0;
  const seen = new Set<string>();
  const files: PackageFile[] = [];
  for (const file of input) {
    if (!isSafeCapabilityRelativePath(file.path)) {
      throw new CapabilityError("unsafe-content", "A file path is not a safe relative path.");
    }
    if (
      isMarkerPath(file.path) ||
      file.path.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment))
    )
      continue;
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      throw new CapabilityError("unsafe-content", `Two files map to ${file.path}.`);
    }
    seen.add(key);
    if (file.content.length > CAPABILITY_LIMITS.maxFileBytes) {
      throw new CapabilityError("too-large", `${file.path} is larger than the per-file limit.`);
    }
    total += file.content.length;
    if (total > CAPABILITY_LIMITS.maxPackageBytes) {
      throw new CapabilityError("too-large", "The package is larger than the size limit.");
    }
    files.push({
      path: file.path,
      bytes: file.content.length,
      executable: file.executable === true,
      sha256: sha256Hex(file.content),
      content: file.content,
    });
  }
  return files.sort(byPath);
}

const RETIRED_DIRECTORY_SUFFIX = ".orkestrator-retired";

function retiredDirectory(destination: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}${RETIRED_DIRECTORY_SUFFIX}`,
  );
}

/** Restores the previous copy if the process stopped between the two renames. */
export function recoverDirectoryReplacement(destination: string): void {
  const retired = retiredDirectory(destination);
  const previous = lstatSync(retired, { throwIfNoEntry: false });
  if (!previous) return;
  if (!previous.isDirectory())
    throw new CapabilityError("unsafe-content", "The retired capability path is not a directory.");
  if (!lstatSync(destination, { throwIfNoEntry: false })) renameSync(retired, destination);
}

/** Repairs a missing installation before directory observations enumerate entries. */
export async function recoverLocationReplacements(
  directory: string,
  isolationRoot?: string,
): Promise<void> {
  assertCapabilityDirectory(directory, isolationRoot);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(".") ||
      !entry.name.endsWith(RETIRED_DIRECTORY_SUFFIX)
    )
      continue;
    const name = entry.name.slice(1, -RETIRED_DIRECTORY_SUFFIX.length);
    if (!name || name === "." || name === "..") continue;
    const marker = path.join(directory, entry.name, CAPABILITY_MARKER_FILE);
    assertCapabilityDirectory(path.dirname(marker), isolationRoot);
    if (!(await fs.lstat(marker).catch(() => null))?.isFile()) continue;
    assertCapabilityDirectory(directory, isolationRoot);
    recoverDirectoryReplacement(path.join(directory, name));
  }
}

/** Publishes a complete tree and leaves a recoverable old copy until publication. */
export async function replaceDirectoryAtomically(
  destination: string,
  files: readonly PackageFile[],
  extra: ReadonlyArray<{ path: string; content: string }> = [],
  isolationRoot?: string,
): Promise<void> {
  const parent = path.dirname(destination);
  assertCapabilityDirectory(parent, isolationRoot);
  await fs.mkdir(parent, { recursive: true });
  const token = randomBytes(6).toString("hex");
  const staging = path.join(parent, `.${path.basename(destination)}.orkestrator-new-${token}`);
  const retired = retiredDirectory(destination);
  assertCapabilityDirectory(parent, isolationRoot);
  recoverDirectoryReplacement(destination);
  await fs.mkdir(staging, { recursive: false });
  try {
    for (const file of files) {
      const target = confinedPath(staging, file.path);
      assertCapabilityDirectory(path.dirname(target), isolationRoot);
      await fs.mkdir(path.dirname(target), { recursive: true });
      assertCapabilityDirectory(path.dirname(target), isolationRoot);
      await fs.writeFile(target, file.content, {
        mode: file.executable ? 0o755 : 0o644,
        flag: "wx",
      });
    }
    for (const file of extra) {
      assertCapabilityDirectory(staging, isolationRoot);
      await fs.writeFile(confinedPath(staging, file.path), file.content, {
        mode: 0o644,
        flag: "wx",
      });
    }
    // Keep the two renames adjacent so an in-process observer cannot see the gap.
    assertCapabilityDirectory(staging, isolationRoot);
    recoverDirectoryReplacement(destination);
    const existing = lstatSync(destination, { throwIfNoEntry: false });
    if (existing && !existing.isDirectory()) {
      throw new CapabilityError(
        "unsafe-content",
        "The installation path is a symbolic link; Orkestrator does not write through links.",
      );
    }
    // A previous publication may have stopped after making the new copy live.
    if (lstatSync(retired, { throwIfNoEntry: false })) {
      const discard = `${retired}-${token}`;
      renameSync(retired, discard);
      void fs.rm(discard, { recursive: true, force: true }).catch(() => undefined);
    }
    if (existing) renameSync(destination, retired);
    try {
      renameSync(staging, destination);
    } catch (error) {
      recoverDirectoryReplacement(destination);
      throw error;
    }
    if (existing) {
      const discard = `${retired}-${token}`;
      renameSync(retired, discard);
      await fs.rm(discard, { recursive: true, force: true });
    }
  } finally {
    assertCapabilityDirectory(parent, isolationRoot);
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Writes one file atomically (temporary sibling, then rename), refusing a link at the target. */
export async function writeFileAtomically(
  destination: string,
  content: Buffer | string,
  mode = 0o644,
  isolationRoot?: string,
): Promise<void> {
  const parent = path.dirname(destination);
  assertCapabilityDirectory(parent, isolationRoot);
  await fs.mkdir(parent, { recursive: true });
  assertCapabilityDirectory(parent, isolationRoot);
  const existing = await fs.lstat(destination).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new CapabilityError("unsafe-content", "The installation path is a symbolic link.");
  }
  const temporary = `${destination}.orkestrator-${randomBytes(6).toString("hex")}`;
  assertCapabilityDirectory(parent, isolationRoot);
  const handle = await fs.open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    mode,
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  assertCapabilityDirectory(parent, isolationRoot);
  await fs.rename(temporary, destination);
}

/** Removes a managed directory or file; refuses links and anything outside `root`. */
export async function removeManagedPath(
  root: string,
  relative: string,
  isolationRoot?: string,
): Promise<boolean> {
  assertCapabilityDirectory(root, isolationRoot);
  const target = confinedPath(root, relative);
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    throw new CapabilityError("unsafe-content", "Refusing to remove through a symbolic link.");
  }
  assertCapabilityDirectory(root, isolationRoot);
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

/** Text files are scanned for secrets; binaries are not. */
export function looksLikeText(content: Buffer): boolean {
  const sample = content.subarray(0, 8_192);
  return !sample.includes(0);
}

/** A bounded, content-free description of an error for logs and receipts. */
export function boundedReason(error: unknown): string {
  if (error instanceof CapabilityError)
    return error.message.slice(0, CAPABILITY_LIMITS.maxReasonChars);
  if (error instanceof Error) {
    // File paths in OS errors name the user's home; keep only the code.
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `File system error (${code}).` : "The operation failed.";
  }
  return "The operation failed.";
}
