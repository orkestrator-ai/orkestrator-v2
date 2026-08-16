import { fs, os, path, runCommand, validateRelativeFilePath } from "./commands-dependencies.js";

/**
 * Staging for the files a project is configured to copy into a container.
 *
 * A leaf: `commands-containers` needs these and nothing else from
 * `commands-environment`, so hosting them there made the container module a
 * back-edge into the environment module. This file must not import any other
 * `commands-*` module beyond `commands-dependencies`.
 */

export function normalizeConfiguredProjectFiles(filesToCopy: string[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const filePath of filesToCopy ?? []) {
    const trimmed = filePath.trim();
    if (!trimmed) continue;
    const safePath = validateRelativeFilePath(trimmed, "file to copy");
    const key = safePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(safePath);
  }

  return normalized;
}

export function isPathInsideRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function copyConfiguredProjectFilesToDirectory(
  projectPath: string,
  destinationRoot: string,
  filesToCopy: string[] | undefined,
): Promise<void> {
  const configuredFiles = normalizeConfiguredProjectFiles(filesToCopy);
  if (configuredFiles.length === 0) return;

  const projectRoot = await fs.realpath(projectPath);

  for (const relativePath of configuredFiles) {
    const sourcePath = path.join(projectRoot, relativePath);
    let realSourcePath: string;
    try {
      realSourcePath = await fs.realpath(sourcePath);
    } catch {
      throw new Error(`Configured file to copy not found: ${relativePath}`);
    }

    if (!isPathInsideRoot(realSourcePath, projectRoot)) {
      throw new Error(`Configured file to copy must stay inside the project: ${relativePath}`);
    }

    const stats = await fs.stat(realSourcePath);
    if (!stats.isFile()) {
      throw new Error(`Configured path to copy is not a file: ${relativePath}`);
    }

    const destinationPath = path.join(destinationRoot, relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(realSourcePath, destinationPath);
  }
}

export async function stageConfiguredProjectFilesForContainer(
  containerId: string,
  projectPath: string,
  filesToCopy: string[] | undefined,
): Promise<void> {
  const configuredFiles = normalizeConfiguredProjectFiles(filesToCopy);
  if (configuredFiles.length === 0) return;

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestrator-project-files-"));
  try {
    await copyConfiguredProjectFilesToDirectory(projectPath, stagingDir, configuredFiles);
    await runCommand("docker", ["cp", `${stagingDir}${path.sep}.`, `${containerId}:/project-files`], { timeoutMs: 120_000 });
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
