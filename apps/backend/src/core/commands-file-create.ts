/**
 * Creating one empty file from the files panel's "New file" action, in a local
 * worktree or a container workspace.
 *
 * Both paths publish through the same exclusive writers the external-file copy
 * uses: the new file is staged as a sibling and hard-linked into place, so an
 * existing file or folder with the same name is never replaced, and every
 * ancestor directory is pinned so a swapped-in symlink cannot redirect the
 * write outside the workspace.
 */
import {
  CONTAINER_PINNED_ATTACHMENT_WRITE,
  containerAttachmentWriteFailure,
  resolveWorkspaceLeafCreate,
} from "./commands-files.js";
import { writeConfinedFile, type ConfinedCreateTestHooks } from "./path-safety.js";
import type { runCommand } from "./shell.js";

export interface WorkspaceFileCreate {
  /** Existing parent directory, `.` for the workspace root. */
  readonly directory: string;
  /** The trimmed leaf name. */
  readonly fileName: string;
  /** Workspace-relative path of the file to create. */
  readonly filePath: string;
}

/**
 * Resolve a single-segment file name against an existing parent directory.
 *
 * Mirrors folder creation: the name is a leaf only, so a right-click location
 * cannot be used to create a nested path elsewhere in the workspace. The byte
 * limit is the file-name limit, which leaves room for the writer's staging
 * sibling.
 */
export function resolveWorkspaceFileCreate(
  parentDirectory: string,
  fileName: string,
): WorkspaceFileCreate {
  const { directory, name, entryPath } = resolveWorkspaceLeafCreate(
    parentDirectory,
    fileName,
    "file",
  );
  return { directory, fileName: name, filePath: entryPath };
}

function alreadyExists(filePath: string): Error {
  return new Error(`A file or folder already exists at ${filePath}`);
}

function parentMissing(directory: string): Error {
  return new Error(
    directory === "."
      ? "Workspace root is not available"
      : `Parent directory does not exist: ${directory}`,
  );
}

/** Create one empty file in a local worktree without replacing an existing path. */
export async function createLocalFile(
  worktreePath: string,
  parentDirectory: string,
  fileName: string,
  testHooks?: ConfinedCreateTestHooks,
): Promise<string> {
  const created = resolveWorkspaceFileCreate(parentDirectory, fileName);
  try {
    await writeConfinedFile(worktreePath, created.filePath, Buffer.alloc(0), {
      exclusive: true,
      createAncestors: false,
      label: "filePath",
      fileMode: 0o644,
      testHooks,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("(EEXIST)")) throw alreadyExists(created.filePath);
    if (message.includes("(ENOENT_ANCESTOR)")) throw parentMissing(created.directory);
    throw error;
  }
  return created.filePath;
}

/** `docker exec` arguments that create `created` as an empty file in the container. */
export function containerCreateFileArgs(
  containerId: string,
  created: WorkspaceFileCreate,
): string[] {
  return [
    "exec",
    "-i",
    containerId,
    "node",
    "-e",
    CONTAINER_PINNED_ATTACHMENT_WRITE,
    "/workspace",
    created.directory,
    created.fileName,
    // Expected decoded bytes, ready token, write mode, file mode, ancestors.
    "0",
    "",
    "exclusive",
    String(0o644),
    "existing",
  ];
}

/** Turn the container writer's exit into the same messages the local path gives. */
export function containerFileCreateFailure(error: unknown, created: WorkspaceFileCreate): Error {
  const failure = containerAttachmentWriteFailure(error);
  if (failure === "exists") return alreadyExists(created.filePath);
  if (failure === "missing-parent") return parentMissing(created.directory);
  if (failure === "invalid-parent") {
    return new Error(
      `Invalid parentDirectory: not a folder inside the workspace: ${created.directory}`,
    );
  }
  return new Error("The file could not be created in the container workspace");
}

/** Create one empty file in a container workspace without replacing an existing path. */
export async function createContainerFile(
  execute: typeof runCommand,
  containerId: string,
  parentDirectory: string,
  fileName: string,
  timeoutMs: number,
): Promise<string> {
  const created = resolveWorkspaceFileCreate(parentDirectory, fileName);
  try {
    // No stdin payload: the writer reads an empty body and publishes zero bytes.
    await execute("docker", containerCreateFileArgs(containerId, created), { timeoutMs });
  } catch (error) {
    throw containerFileCreateFailure(error, created);
  }
  return created.filePath;
}
