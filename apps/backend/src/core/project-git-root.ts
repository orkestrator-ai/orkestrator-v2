import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { conciseError } from "./commands-error-text.js";
import { CommandFailedError, runCommand } from "./shell.js";
import type { StorageService } from "./storage.js";

/**
 * Names the path and the machine, because a remote machine's project is shown
 * beside local ones and its error otherwise reads as a problem on this device.
 */
function checkoutLocation(localPath: string): string {
  return `${localPath} on ${os.hostname()}`;
}

function checkoutAccessError(localPath: string, error: unknown): Error {
  const location = checkoutLocation(localPath);
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new Error(
      `The project's local checkout does not exist: ${location}. ` +
        "Restore the folder, or remove and re-add the project to clone it again.",
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new Error(
      `Orkestrator does not have permission to open the project's local checkout: ${location}`,
    );
  }
  return new Error(
    `Could not open the project's local checkout: ${location}: ${conciseError(error)}`,
  );
}

function checkoutGitError(localPath: string, error: unknown): Error {
  const location = checkoutLocation(localPath);
  if (error instanceof CommandFailedError && error.executableMissing) {
    return new Error(`Git is not installed or available on PATH on ${os.hostname()}`);
  }
  if (error instanceof CommandFailedError && error.timedOut) {
    return new Error(`Git timed out reading the project's local checkout: ${location}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/detected dubious ownership/i.test(message)) {
    return new Error(
      `Git refused the project's local checkout because another user owns it: ${location}. ` +
        "Change the folder's owner, or add it to Git's safe.directory setting.",
    );
  }
  if (/not a git repository/i.test(message)) {
    return new Error(`The project's local checkout is not a Git repository: ${location}`);
  }
  return new Error(
    `Could not read the project's local checkout: ${location}: ${conciseError(error)}`,
  );
}

export async function resolveProjectGitRoot(
  storage: StorageService,
  projectId: string,
): Promise<string> {
  const project = await storage.getProject(projectId);
  if (!project?.localPath?.trim()) throw new Error("This project has no local checkout configured");
  const localPath = project.localPath;
  const requested = await fs.realpath(localPath).catch((error: unknown) => {
    throw checkoutAccessError(localPath, error);
  });
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: requested,
    timeoutMs: 10_000,
  }).catch((error: unknown) => {
    throw checkoutGitError(localPath, error);
  });
  const root = await fs.realpath(result.stdout.trim());
  if (path.normalize(root) !== path.normalize(requested)) {
    throw new Error(
      `The project's local checkout is a folder inside a Git repository, not its root: ${checkoutLocation(localPath)}. ` +
        `The repository root is ${root}.`,
    );
  }
  return root;
}
