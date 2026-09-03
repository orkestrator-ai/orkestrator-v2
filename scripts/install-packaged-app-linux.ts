import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_SLUG, LINUX_DESKTOP_ENTRY_FILENAME } from "../apps/desktop/electron/app-constants";

const applicationId = APP_SLUG;
const executableName = APP_SLUG;

export interface LinuxInstallTargets {
  applicationDir: string;
  launcherPath: string;
  desktopEntryPath: string;
  iconPath: string;
}

function absoluteXdgDirectory(value: string | undefined, fallback: string): string {
  return value && path.isAbsolute(value) ? value : fallback;
}

export function resolveLinuxInstallTargets(
  environment: NodeJS.ProcessEnv = process.env,
): LinuxInstallTargets {
  const home = environment.HOME || os.homedir();
  const dataHome = absoluteXdgDirectory(environment.XDG_DATA_HOME, path.join(home, ".local/share"));
  const binHome = path.join(home, ".local/bin");

  return {
    applicationDir: path.join(dataHome, applicationId),
    launcherPath: path.join(binHome, executableName),
    desktopEntryPath: path.join(dataHome, "applications", LINUX_DESKTOP_ENTRY_FILENAME),
    iconPath: path.join(dataHome, "icons/hicolor/512x512/apps", `${applicationId}.png`),
  };
}

export async function findLinuxBundle(
  releaseDirectory: string,
  architecture: NodeJS.Architecture = process.arch,
  bundleExecutableName = executableName,
): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(releaseDirectory, { withFileTypes: true });
  } catch {
    return null;
  }

  const expectedDirectoryNames =
    architecture === "x64"
      ? ["linux-unpacked", "linux-x64-unpacked"]
      : architecture === "arm"
        ? ["linux-armv7l-unpacked"]
        : [`linux-${architecture}-unpacked`];
  const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));

  for (const directoryName of expectedDirectoryNames) {
    const entry = entriesByName.get(directoryName);
    if (!entry?.isDirectory()) continue;
    const directory = path.join(releaseDirectory, directoryName);
    try {
      if ((await stat(path.join(directory, bundleExecutableName))).isFile()) return directory;
    } catch {
      // This is not a complete electron-builder Linux bundle.
    }
  }

  return null;
}

function quoteDesktopExec(argument: string): string {
  return (
    '"' +
    argument.replace(/["\\`$]/g, (character) =>
      character === "\\" ? "\\\\\\\\" : `\\\\${character}`,
    ) +
    '"'
  );
}

export function createDesktopEntry(launcherPath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Orkestrator AI",
    "Comment=Manage isolated AI development environments",
    `Exec=${quoteDesktopExec(launcherPath)}`,
    `Icon=${applicationId}`,
    "Terminal=false",
    "Categories=Development;",
    `StartupWMClass=${applicationId}`,
    "",
  ].join("\n");
}

export async function installLinuxBundle(
  source: string,
  iconSource: string,
  targets: LinuxInstallTargets,
): Promise<void> {
  const sourceExecutable = path.join(source, executableName);
  let sourceExecutableInfo = null;
  try {
    sourceExecutableInfo = await stat(sourceExecutable);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  if (!sourceExecutableInfo?.isFile()) {
    throw new Error(`${source} is not an Orkestrator Linux bundle`);
  }

  const replacements: StagedReplacement[] = [];
  try {
    replacements.push(
      await stageReplacement(targets.applicationDir, async (stagedPath) => {
        await cp(source, stagedPath, { recursive: true, verbatimSymlinks: true });
        await chmod(path.join(stagedPath, executableName), 0o755);
      }),
    );
    replacements.push(
      await stageReplacement(targets.launcherPath, async (stagedPath) => {
        await symlink(path.join(targets.applicationDir, executableName), stagedPath);
      }),
    );
    replacements.push(
      await stageReplacement(targets.iconPath, async (stagedPath) => {
        await cp(iconSource, stagedPath);
      }),
    );
    replacements.push(
      await stageReplacement(targets.desktopEntryPath, async (stagedPath) => {
        await writeFile(stagedPath, createDesktopEntry(targets.launcherPath), { mode: 0o644 });
      }),
    );
  } catch (error) {
    await cleanupReplacements(replacements);
    throw error;
  }

  try {
    for (const replacement of replacements) await promoteReplacement(replacement);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const replacement of Array.from(replacements).reverse()) {
      try {
        await rollbackReplacement(replacement);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Linux installation failed and rollback was incomplete; recovery files remain beside the install targets",
      );
    }
    await cleanupReplacements(replacements);
    throw error;
  }

  await cleanupReplacements(replacements);
}

interface StagedReplacement {
  targetPath: string;
  stagingDirectory: string;
  stagedPath: string;
  backupPath: string;
  hadPreviousTarget: boolean;
  promoted: boolean;
}

async function stageReplacement(
  targetPath: string,
  create: (stagedPath: string) => Promise<void>,
): Promise<StagedReplacement> {
  const parentDirectory = path.dirname(targetPath);
  await mkdir(parentDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(
    path.join(parentDirectory, `.${path.basename(targetPath)}.install-`),
  );
  const stagedPath = path.join(stagingDirectory, "next");

  try {
    await create(stagedPath);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    targetPath,
    stagingDirectory,
    stagedPath,
    backupPath: path.join(stagingDirectory, "previous"),
    hadPreviousTarget: false,
    promoted: false,
  };
}

async function promoteReplacement(replacement: StagedReplacement): Promise<void> {
  try {
    await lstat(replacement.targetPath);
    await rename(replacement.targetPath, replacement.backupPath);
    replacement.hadPreviousTarget = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await rename(replacement.stagedPath, replacement.targetPath);
  replacement.promoted = true;
}

async function rollbackReplacement(replacement: StagedReplacement): Promise<void> {
  if (replacement.promoted) {
    await rm(replacement.targetPath, { recursive: true, force: true });
    replacement.promoted = false;
  }
  if (replacement.hadPreviousTarget) {
    await rename(replacement.backupPath, replacement.targetPath);
    replacement.hadPreviousTarget = false;
  }
}

async function cleanupReplacements(replacements: StagedReplacement[]): Promise<void> {
  await Promise.all(
    replacements.map((replacement) =>
      rm(replacement.stagingDirectory, { recursive: true, force: true }),
    ),
  );
}

export function assertLinuxInstallerPlatform(platform = process.platform): void {
  if (platform !== "linux") throw new Error("The Linux package installer must be run on Linux.");
}

async function main(): Promise<void> {
  try {
    assertLinuxInstallerPlatform();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const releaseDirectory = path.resolve("release");
  const source = await findLinuxBundle(releaseDirectory);
  if (!source) {
    console.error(`Could not find a Linux app bundle under ${releaseDirectory}.`);
    process.exit(1);
  }

  const targets = resolveLinuxInstallTargets();
  const iconSource = path.resolve("apps/desktop/electron/resources/icon.png");

  try {
    await installLinuxBundle(source, iconSource, targets);
    console.log(`Installed Orkestrator AI to ${targets.applicationDir}`);
    console.log(`Launcher: ${targets.launcherPath}`);
    console.log(`Desktop entry: ${targets.desktopEntryPath}`);
    if (!process.env.PATH?.split(path.delimiter).includes(path.dirname(targets.launcherPath))) {
      console.log(`Add ${path.dirname(targets.launcherPath)} to PATH to launch from a terminal.`);
    }
  } catch (error) {
    console.error("Failed to install Orkestrator AI for the current Linux user.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) await main();
