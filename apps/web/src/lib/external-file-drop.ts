/**
 * Reading folders dropped onto the files panel from the operating system.
 *
 * A browser drop hands over a folder as a `FileSystemDirectoryEntry`
 * (`DataTransferItem.webkitGetAsEntry()`). The entry must be taken during the
 * drop event, but it stays readable afterwards, so the panel captures the
 * entries synchronously and walks them here once the copy starts. The walk
 * turns every dropped folder into a plan: the folders to create, parents
 * first, and the files to copy into each of them. The backend stages and
 * publishes each root using the workspace's confined file operations.
 */

/** The parts of `FileSystemEntry` the walk reads. */
export interface DroppedEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

/** The parts of `FileSystemFileEntry` the walk reads. */
export interface DroppedFileEntry extends DroppedEntry {
  file(success: (file: File) => void, error?: (error: unknown) => void): void;
}

/** The parts of `FileSystemDirectoryEntry` the walk reads. */
export interface DroppedDirectoryEntry extends DroppedEntry {
  createReader(): {
    readEntries(success: (entries: DroppedEntry[]) => void, error?: (error: unknown) => void): void;
  };
}

/** What one external drop carries: loose files and whole folders. */
export type ExternalFileDrop = {
  files: File[];
  folders: DroppedDirectoryEntry[];
};

/** Files and folders a folder drop may hold in total, so a stray `node_modules` is refused. */
export const MAX_EXTERNAL_FOLDER_DROP_ENTRY_COUNT = 2000;
/** Bytes a folder drop may hold in total. Each file keeps its own per-file limit too. */
export const MAX_EXTERNAL_FOLDER_DROP_BYTES = 256 * 1024 * 1024;

function skipEntry(entry: Pick<DroppedEntry, "name" | "isFile">): boolean {
  return entry.name.toLowerCase() === ".git" || (entry.isFile && entry.name === ".DS_Store");
}

export function skipLooseDropFile(file: File): boolean {
  return skipEntry({ name: file.name, isFile: true });
}

export type FolderCopyFailure = { name: string; message: string };

/** One file of a folder drop and where it goes, relative to the drop target. */
export type PlannedFolderFile = {
  /** Folder the file is copied into, relative to the drop target. */
  directory: string;
  /** The file's own path relative to the drop target. */
  path: string;
  file: File;
};

export type ExternalFolderCopyPlan = {
  /** Folders to create, relative to the drop target, every parent before its children. */
  folders: string[];
  files: PlannedFolderFile[];
  /** Entries left out on purpose (Git metadata, `.DS_Store`), relative to the drop target. */
  skipped: string[];
  failures: FolderCopyFailure[];
  totalBytes: number;
};

/** A folder drop that is larger than the panel copies. Nothing has been written. */
export class ExternalDropLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalDropLimitError";
  }
}

export function isDroppedDirectoryEntry(entry: unknown): entry is DroppedDirectoryEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as DroppedEntry).isDirectory === true &&
    typeof (entry as DroppedDirectoryEntry).createReader === "function"
  );
}

function isDroppedFileEntry(entry: DroppedEntry): entry is DroppedFileEntry {
  return entry.isFile && typeof (entry as DroppedFileEntry).file === "function";
}

function readEntryBatch(
  reader: ReturnType<DroppedDirectoryEntry["createReader"]>,
): Promise<DroppedEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** Every entry of one directory; `readEntries` answers in batches until it answers none. */
async function readAllEntries(
  directory: DroppedDirectoryEntry,
  countEntry: () => void,
): Promise<DroppedEntry[]> {
  const reader = directory.createReader();
  const entries: DroppedEntry[] = [];
  for (;;) {
    const batch = await readEntryBatch(reader);
    if (batch.length === 0) break;
    for (const entry of batch) {
      countEntry();
      entries.push(entry);
    }
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function readFile(entry: DroppedFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function childPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/**
 * Walk dropped folders into a copy plan. Refuses, before anything is written,
 * a drop holding more than `maxEntries` files and folders or more than
 * `maxBytes` in total.
 */
export async function planExternalFolderCopy(
  folders: readonly DroppedDirectoryEntry[],
  limits: {
    maxEntries?: number;
    maxBytes?: number;
    initialEntries?: number;
    initialBytes?: number;
  } = {},
): Promise<ExternalFolderCopyPlan> {
  const maxEntries = limits.maxEntries ?? MAX_EXTERNAL_FOLDER_DROP_ENTRY_COUNT;
  const maxBytes = limits.maxBytes ?? MAX_EXTERNAL_FOLDER_DROP_BYTES;
  const plan: ExternalFolderCopyPlan = {
    folders: [],
    files: [],
    skipped: [],
    failures: [],
    totalBytes: limits.initialBytes ?? 0,
  };
  let entryCount = limits.initialEntries ?? 0;
  const countEntry = () => {
    entryCount += 1;
    if (entryCount > maxEntries) {
      throw new ExternalDropLimitError(
        `Drop folders holding up to ${maxEntries} files and folders at a time`,
      );
    }
  };

  const recordFailure = (name: string, error: unknown) => {
    if (error instanceof ExternalDropLimitError) throw error;
    plan.failures.push({
      name,
      message: `Could not read ${name}: ${error instanceof Error ? error.message : String(error)}`,
    });
  };

  // Reserve each batch's entries before recursing so all live reader buffers
  // share the same budget, including metadata and unreadable entries.
  const visit = async (directory: DroppedDirectoryEntry, path: string): Promise<void> => {
    plan.folders.push(path);
    let entries: DroppedEntry[];
    try {
      entries = await readAllEntries(directory, countEntry);
    } catch (error) {
      recordFailure(path, error);
      return;
    }
    for (const entry of entries) {
      const entryPath = childPath(path, entry.name);
      if (skipEntry(entry)) {
        plan.skipped.push(entryPath);
      } else if (isDroppedDirectoryEntry(entry)) {
        await visit(entry, entryPath);
      } else {
        try {
          if (!isDroppedFileEntry(entry)) throw new Error("Unsupported directory entry");
          const file = await readFile(entry);
          if (file.name !== entry.name) throw new Error("The file name changed");
          plan.totalBytes += file.size;
          if (plan.totalBytes > maxBytes) {
            throw new ExternalDropLimitError(
              `Dropped folders exceed the ${Math.round(maxBytes / (1024 * 1024))} MB limit`,
            );
          }
          plan.files.push({ directory: path, path: entryPath, file });
        } catch (error) {
          recordFailure(entryPath, error);
        }
      }
    }
  };

  for (const folder of folders) {
    countEntry();
    if (skipEntry(folder)) {
      plan.skipped.push(folder.name);
      continue;
    }
    await visit(folder, folder.name);
  }
  return plan;
}

/** Join a path relative to the drop target onto the target directory (`.` is the root). */
export function workspacePathInDropTarget(destinationDirectory: string, relative: string): string {
  if (relative === "") return destinationDirectory;
  return destinationDirectory === "." ? relative : `${destinationDirectory}/${relative}`;
}

/** The folder holding `relative`, relative to the drop target (`""` for a top-level entry). */
export function dropParentPath(relative: string): string {
  const separator = relative.lastIndexOf("/");
  return separator === -1 ? "" : relative.slice(0, separator);
}

export function dropBaseName(relative: string): string {
  return relative.slice(relative.lastIndexOf("/") + 1);
}

/** A duplicate file or folder would target the same workspace entry. */
export function duplicateDropPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) duplicates.add(path);
    seen.add(path);
  }
  return [...duplicates];
}
