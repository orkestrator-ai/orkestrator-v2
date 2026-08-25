import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyAppBundle } from "../../scripts/install-packaged-app";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("packaged app installer", () => {
  test("preserves relative framework symlinks inside the installed app", async () => {
    if (process.platform === "win32") return;

    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-app-install-"));
    temporaryRoots.push(root);
    const source = path.join(root, "release", "OrkestratorV2.app");
    const destination = path.join(root, "Applications", "OrkestratorV2.app");
    const sourceFramework = path.join(
      source,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
    );
    const installedFramework = path.join(
      destination,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
    );
    const icuData = Buffer.from("pinned ICU data");

    await mkdir(path.join(sourceFramework, "Versions", "A", "Resources"), { recursive: true });
    await writeFile(
      path.join(sourceFramework, "Versions", "A", "Resources", "icudtl.dat"),
      icuData,
    );
    await symlink("A", path.join(sourceFramework, "Versions", "Current"));
    await symlink("Versions/Current/Resources", path.join(sourceFramework, "Resources"));

    await copyAppBundle(source, destination);

    expect(await readlink(path.join(installedFramework, "Versions", "Current"))).toBe("A");
    expect(await readlink(path.join(installedFramework, "Resources"))).toBe(
      "Versions/Current/Resources",
    );
    expect(await realpath(path.join(installedFramework, "Resources"))).toBe(
      await realpath(path.join(installedFramework, "Versions", "A", "Resources")),
    );
    expect(await readFile(path.join(installedFramework, "Resources", "icudtl.dat"))).toEqual(
      icuData,
    );
  });
});
