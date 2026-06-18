import { cp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const appName = "OrkestratorV2.app";
const releaseDir = path.resolve("release");
const applicationsDir = "/Applications";
const destination = path.join(applicationsDir, appName);

async function findAppBundle(dir: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name === appName) {
      return fullPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith(".app")) continue;
    const found = await findAppBundle(path.join(dir, entry.name));
    if (found) return found;
  }

  return null;
}

const source = await findAppBundle(releaseDir);

if (!source) {
  console.error(`Could not find ${appName} under ${releaseDir}.`);
  process.exit(1);
}

try {
  const sourceInfo = await stat(source);
  if (!sourceInfo.isDirectory()) {
    throw new Error(`${source} is not an app bundle directory`);
  }

  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  console.log(`Installed ${appName} to ${destination}`);
} catch (error) {
  console.error(`Failed to install ${appName} to ${applicationsDir}.`);
  console.error(error instanceof Error ? error.message : String(error));
  console.error("You may need to rerun the package command with permission to write to /Applications.");
  process.exit(1);
}
