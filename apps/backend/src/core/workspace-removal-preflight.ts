/** Self-contained so the container runs the same preflight under Node. */
export async function assertNoNestedRepositories(
  root: string,
  target: string,
  operation: "delete" | "rename" = "delete",
): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const stat = async (filename: string) =>
    fs.lstat(filename).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  const visit = async (directory: string): Promise<void> => {
    const absolute = path.join(root, directory);
    if (!(await stat(absolute))?.isDirectory()) return;
    // .git may be a directory, a worktree/submodule file, or a symlink.
    // Bare repositories have no .git entry, but clean protects those too.
    if (
      (await stat(path.join(absolute, ".git"))) ||
      ((await stat(path.join(absolute, "HEAD")))?.isFile() &&
        (await stat(path.join(absolute, "objects")))?.isDirectory() &&
        (await stat(path.join(absolute, "refs")))?.isDirectory())
    ) {
      throw new Error(`Cannot ${operation} ${target}: nested Git repository at ${directory}`);
    }
    const entries = await fs.opendir(absolute);
    for await (const entry of entries) {
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    }
  };
  try {
    await visit(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (operation === "rename" && (code === "EACCES" || code === "EPERM")) {
      throw new Error(
        `Cannot rename ${target}: permission denied while checking for nested Git repositories`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

export function containerRemovalPreflightScript(): string {
  return `(${assertNoNestedRepositories.toString()})(process.argv[1], process.argv[2]).catch(error => { process.stderr.write(error.message + "\\n"); process.exitCode = 1; });`;
}
