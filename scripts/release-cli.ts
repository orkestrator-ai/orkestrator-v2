#!/usr/bin/env bun
/**
 * Publish the `orkestrator` npm package on its release channel's dist-tag.
 *
 *   bun scripts/release-cli.ts publish [--dry-run]
 *
 * Stable publishes to `latest`, beta to `beta` and unstable to `unstable`. The
 * tag is always explicit: publishing a prerelease without one would move
 * `latest` and hand every `bunx orkestrator` user a beta. Headless backends
 * install exactly the version the channel index names, so this must run
 * before `release:publish` (which refuses until the version is on npm).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertReleaseChannelVersion,
  npmDistTagForChannel,
} from "../packages/protocol/src/release-channels";

const root = path.resolve(import.meta.dir, "..");

export type CliReleaseRuntime = {
  cliVersion(): string;
  rootVersion(): string;
  run(command: string[]): void;
};

const defaultRuntime: CliReleaseRuntime = {
  cliVersion: () =>
    (
      JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8")) as {
        version: string;
      }
    ).version,
  rootVersion: () =>
    (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string })
      .version,
  run: (command) => {
    console.log(`\n$ ${command.join(" ")}`);
    const result = Bun.spawnSync(command, { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
    if (result.exitCode !== 0)
      throw new Error(`\`${command.join(" ")}\` exited with ${result.exitCode}`);
  },
};

export function runCliRelease(args: string[], runtime: CliReleaseRuntime = defaultRuntime): string {
  const [command, ...flags] = args;
  if (command !== "publish" || !flags.every((flag) => flag === "--dry-run")) {
    throw new Error("usage: release-cli.ts publish [--dry-run]");
  }
  const version = runtime.cliVersion();
  if (version !== runtime.rootVersion()) {
    throw new Error(
      `packages/cli is ${version} but the root package.json is ${runtime.rootVersion()}`,
    );
  }
  const tag = npmDistTagForChannel(assertReleaseChannelVersion(version));
  runtime.run([
    "bun",
    "publish",
    "--cwd",
    "packages/cli",
    "--access",
    "public",
    "--tag",
    tag,
    ...(flags.includes("--dry-run") ? ["--dry-run"] : []),
  ]);
  return tag;
}

if (import.meta.main) {
  try {
    const tag = runCliRelease(process.argv.slice(2));
    console.log(`\nPublished orkestrator on the "${tag}" dist-tag.`);
  } catch (error) {
    console.error(`release-cli: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
