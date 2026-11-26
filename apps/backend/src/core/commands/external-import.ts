import { randomUUID } from "node:crypto";
import path from "node:path";
import { canonicalWorktreePath } from "@orkestrator/protocol/node/worktree-paths";
import type { ArgsOf } from "@orkestrator/protocol/contract/command";
import type { importExternalEntryCommand } from "@orkestrator/protocol/contract/domains/files";
import {
  CONTAINER_PINNED_ATTACHMENT_WRITE,
  containerAttachmentWriteFailure,
  containerCreateFolderCommand,
  containerDeleteFileCommand,
  containerMoveFileCommand,
  copyExternalFileToLocalWorkspace,
  deleteLocalFile,
  resolveWorkspaceExternalFileCopy,
  resolveWorkspaceFolderCreate,
  validateWorkspaceMutationPath,
} from "./files.js";
import type { RegistryDependencies } from "./registry-types.js";
import { dockerExec } from "./container-exec.js";
import {
  assertBase64PayloadWithinLimit,
  base64DecodedByteLength,
  createConfinedDirectory,
  moveConfinedFile,
} from "../path-safety.js";

type ImportArgs = ArgsOf<typeof importExternalEntryCommand>;
type CopyDependencies = Pick<
  RegistryDependencies,
  "runContainerFileCopyCommand" | "containerFileCopyTimeoutMs"
>;

export async function copyExternalFileToContainerWorkspace(
  containerId: string,
  copy: ReturnType<typeof resolveWorkspaceExternalFileCopy>,
  data: string,
  dependencies: CopyDependencies,
): Promise<void> {
  try {
    await dependencies.runContainerFileCopyCommand(
      "docker",
      [
        "exec",
        "-i",
        containerId,
        "node",
        "-e",
        CONTAINER_PINNED_ATTACHMENT_WRITE,
        "/workspace",
        copy.directory,
        copy.fileName,
        String(base64DecodedByteLength(data)),
        "",
        "exclusive",
        String(0o644),
        "existing",
      ],
      { stdin: data, timeoutMs: dependencies.containerFileCopyTimeoutMs },
    );
  } catch (error) {
    const failure = containerAttachmentWriteFailure(error);
    if (failure === "exists") throw new Error(`A file already exists at ${copy.destination}`);
    if (failure === "missing-parent") {
      throw new Error(
        copy.directory === "."
          ? "Workspace root is not available"
          : `Destination directory no longer exists: ${copy.directory}`,
      );
    }
    throw new Error("The file could not be copied into the container workspace");
  }
}

const stagingPrefix = ".orkestrator-import-";
const stagingName =
  /^\.orkestrator-import-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type Workspace = { worktreePath: string } | { containerId: string };

export async function importExternalEntry(
  workspace: Workspace,
  target: ImportArgs["target"],
  action: ImportArgs["action"],
  dependencies: CopyDependencies,
): Promise<string> {
  // Check the reconciled, authorized destination used by this very mutation.
  // Never use a caller-supplied path or container ID to select where to write.
  if ("worktreePath" in workspace) {
    if (
      target.kind !== "local" ||
      !path.isAbsolute(target.identity) ||
      canonicalWorktreePath(workspace.worktreePath) !== canonicalWorktreePath(target.identity)
    ) {
      throw new Error(
        "The project checkout changed. Drop the items again in the intended checkout.",
      );
    }
  } else if (target.kind !== "container" || workspace.containerId !== target.identity) {
    throw new Error(
      "The workspace container changed. Drop the items again in the intended container.",
    );
  }

  switch (action.kind) {
    case "stage":
    case "mkdir": {
      const options = { literalName: true };
      const destination = resolveWorkspaceFolderCreate(action.directory, action.name, options);
      const created =
        action.kind === "stage"
          ? resolveWorkspaceFolderCreate(
              destination.directory,
              stagingPrefix + randomUUID(),
              options,
            )
          : destination;
      if ("worktreePath" in workspace) {
        await createConfinedDirectory(workspace.worktreePath, created.folderPath);
      } else {
        await dockerExec(
          workspace.containerId,
          containerCreateFolderCommand(created.directory, created.folderPath),
        );
      }
      return created.folderPath;
    }
    case "copy": {
      const data = assertBase64PayloadWithinLimit(action.base64Data);
      if ("worktreePath" in workspace) {
        return copyExternalFileToLocalWorkspace(
          workspace.worktreePath,
          action.directory,
          action.name,
          data,
        );
      }
      const copy = resolveWorkspaceExternalFileCopy(action.directory, action.name);
      await copyExternalFileToContainerWorkspace(workspace.containerId, copy, data, dependencies);
      return copy.destination;
    }
    case "publish":
    case "discard": {
      const staging = validateWorkspaceMutationPath(action.stagingPath, "stagingPath");
      if (staging !== action.stagingPath || !stagingName.test(path.posix.basename(staging))) {
        throw new Error("Invalid folder import staging path");
      }
      if (action.kind === "discard") {
        if ("worktreePath" in workspace) {
          return deleteLocalFile(workspace.worktreePath, staging);
        }
        await dockerExec(workspace.containerId, containerDeleteFileCommand(staging));
        return staging;
      }
      const destination = resolveWorkspaceFolderCreate(path.posix.dirname(staging), action.name, {
        literalName: true,
      });
      const rename = { renameKind: "folder" } as const;
      if ("worktreePath" in workspace) {
        await moveConfinedFile(workspace.worktreePath, staging, destination.folderPath, {}, rename);
      } else {
        await dockerExec(
          workspace.containerId,
          containerMoveFileCommand(staging, destination.directory, destination.folderPath, rename),
        );
      }
      return destination.folderPath;
    }
  }
}
