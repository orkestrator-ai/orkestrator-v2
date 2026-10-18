#!/usr/bin/env bun
/**
 * Publish the `orkestrator` npm package under its update channel's dist-tag.
 *
 *   bun scripts/publish-cli.ts
 *
 * The tag comes from the package version's suffix, as for the desktop
 * release: `2.23.0` publishes as `latest`, `2.23.0-beta` as `beta` and
 * `2.23.0-alpha` as `alpha`. `bun publish` would otherwise tag every version
 * `latest`, handing a prerelease to every `bunx orkestrator` user and every
 * Stable standalone backend.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HOST_UPDATE_CHANNEL_TAGS,
  hostUpdateChannelOfVersion,
} from "../packages/protocol/src/host-maintenance.js";

const root = path.resolve(import.meta.dir, "..");

export function cliPublishCommand(version: string): string[] {
  const channel = hostUpdateChannelOfVersion(version);
  if (!channel) {
    throw new Error(
      `${version} has a suffix no update channel ships. Use no suffix (Stable), -beta or -alpha (Unstable).`,
    );
  }
  return [
    "bun",
    "publish",
    "--cwd",
    "packages/cli",
    "--access",
    "public",
    "--tag",
    HOST_UPDATE_CHANNEL_TAGS[channel],
  ];
}

if (import.meta.main) {
  try {
    const { version } = JSON.parse(
      readFileSync(path.join(root, "packages/cli/package.json"), "utf8"),
    ) as { version: string };
    const command = cliPublishCommand(version);
    console.log(`\n$ ${command.join(" ")}`);
    const result = Bun.spawnSync(command, { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
    process.exitCode = result.exitCode ?? 1;
  } catch (error) {
    console.error(`publish-cli: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
