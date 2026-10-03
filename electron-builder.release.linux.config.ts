import type { Configuration } from "electron-builder";
import { readFileSync } from "node:fs";
import { releasePublish } from "./electron-builder.release.config";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  build: Configuration;
};

/**
 * Linux releases are unsigned. The AppImage is the self-updating artifact (it
 * bundles its own FUSE runtime, see `toolsets.appimage`); the pacman package is
 * for Arch-based distributions such as Omarchy, which update it through their
 * package manager.
 */
export function createLinuxReleaseConfig(): Configuration {
  return {
    ...packageJson.build,
    publish: releasePublish,
    linux: {
      ...packageJson.build.linux,
      target: ["AppImage", "pacman"],
    },
  };
}

export default function linuxReleaseConfig(): Configuration {
  return createLinuxReleaseConfig();
}
