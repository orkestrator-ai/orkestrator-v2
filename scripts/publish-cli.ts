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
 *
 * `bun publish` rebuilds the package in its `prepack` step, without Turbo, so
 * this is where the published backend gets its build commit.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCommitEnv } from "../packages/protocol/src/node/build-commit.js";
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

/** The runner is injectable so tests can exercise prepack without publishing. */
export function publishCli(
  repositoryRoot: string = root,
  run: (
    command: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["inherit", "inherit", "inherit"] },
  ) => { exitCode: number | null } = Bun.spawnSync,
): number {
  const { version } = JSON.parse(
    readFileSync(path.join(repositoryRoot, "packages/cli/package.json"), "utf8"),
  ) as { version: string };
  const command = cliPublishCommand(version);
  console.log(`\n$ ${command.join(" ")}`);
  const result = run(command, {
    cwd: repositoryRoot,
    env: buildCommitEnv(repositoryRoot),
    stdio: ["inherit", "inherit", "inherit"],
  });
  return result.exitCode ?? 1;
}

if (import.meta.main) {
  try {
    process.exitCode = publishCli();
  } catch (error) {
    console.error(`publish-cli: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
