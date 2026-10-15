#!/usr/bin/env bun
/**
 * Channel arithmetic for the release workflows, so the rules live in tested
 * code (`packages/protocol/src/release-channels.ts`) rather than in YAML.
 *
 *   bun scripts/release-channel.ts classify <version>
 *   bun scripts/release-channel.ts unstable-version --run <n> --sha <commit> [--date <iso>]
 *   bun scripts/release-channel.ts container-tags <version> --image <ref> --sha <commit> [--immutable-only]
 *   bun scripts/release-channel.ts moving-tags <version> --image <ref>
 *   bun scripts/release-channel.ts set-version <version>
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertReleaseChannelVersion,
  containerTagsForVersion,
  movingContainerTags,
  npmDistTagForChannel,
  parseSemver,
  releaseTagForVersion,
  unstableVersion,
} from "../packages/protocol/src/release-channels";

const root = path.resolve(import.meta.dir, "..");

/** Every manifest that carries the app version (see "Application Version Bumps" in AGENTS.md). */
export function versionedManifestPaths(repositoryRoot = root): string[] {
  const found = ["package.json"];
  for (const group of ["apps", "bridges", "packages"]) {
    const groupDir = path.join(repositoryRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const manifest = `${group}/${entry.name}/package.json`;
      if (entry.isDirectory() && existsSync(path.join(repositoryRoot, manifest))) {
        found.push(manifest);
      }
    }
  }
  return found.sort();
}

const TOP_LEVEL_VERSION = /^( {2}"version": ")([^"]+)(",?)$/m;

/** Rewrites only the top-level `version` line, preserving each file's formatting. */
export function setManifestVersion(text: string, version: string): string {
  if (!TOP_LEVEL_VERSION.test(text)) throw new Error("no top-level version field");
  const updated = text.replace(TOP_LEVEL_VERSION, `$1${version}$3`);
  if ((JSON.parse(updated) as { version?: string }).version !== version) {
    throw new Error("the rewritten version is not the manifest's top-level version");
  }
  return updated;
}

export function setWorkspaceVersion(version: string, repositoryRoot = root): string[] {
  if (!parseSemver(version)) throw new Error(`${version} is not semver`);
  const written: string[] = [];
  for (const manifest of versionedManifestPaths(repositoryRoot)) {
    const file = path.join(repositoryRoot, manifest);
    writeFileSync(file, setManifestVersion(readFileSync(file, "utf8"), version));
    written.push(manifest);
  }
  return written;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function runReleaseChannel(args: string[], repositoryRoot = root): string {
  const [command, ...rest] = args;
  if (command === "classify" && rest.length === 1) {
    const version = rest[0]!;
    const channel = assertReleaseChannelVersion(version);
    return JSON.stringify({
      version,
      channel,
      tag: releaseTagForVersion(version),
      npmDistTag: npmDistTagForChannel(channel),
      prerelease: channel !== "stable",
    });
  }
  if (command === "unstable-version") {
    const run = Number(option(rest, "--run"));
    const sha = option(rest, "--sha");
    const date = option(rest, "--date");
    if (!sha) throw new Error("usage: unstable-version --run <n> --sha <commit> [--date <iso>]");
    const mainVersion = (
      JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    return unstableVersion({
      mainVersion,
      date: date ? new Date(date) : new Date(),
      runNumber: run,
      commitSha: sha,
    });
  }
  if (command === "container-tags" && rest.length >= 5) {
    const [version, ...flags] = rest;
    const image = option(flags, "--image");
    const sha = option(flags, "--sha");
    if (!version || !image || !sha) {
      throw new Error(
        "usage: container-tags <version> --image <ref> --sha <commit> [--immutable-only]",
      );
    }
    return containerTagsForVersion(version, sha, { moving: !flags.includes("--immutable-only") })
      .map((tag) => `${image}:${tag}`)
      .join("\n");
  }
  if (command === "moving-tags" && rest.length === 3) {
    const [version, flag, image] = rest;
    if (!version || flag !== "--image" || !image) {
      throw new Error("usage: moving-tags <version> --image <ref>");
    }
    return movingContainerTags(version)
      .map((tag) => `${image}:${tag}`)
      .join("\n");
  }
  if (command === "set-version" && rest.length === 1) {
    assertReleaseChannelVersion(rest[0]!);
    return setWorkspaceVersion(rest[0]!, repositoryRoot).join("\n");
  }
  throw new Error(
    "usage: release-channel.ts classify <version> | unstable-version --run <n> --sha <commit> " +
      "| container-tags <version> --image <ref> --sha <commit> [--immutable-only] " +
      "| moving-tags <version> --image <ref> | set-version <version>",
  );
}

if (import.meta.main) {
  try {
    console.log(runReleaseChannel(process.argv.slice(2)));
  } catch (error) {
    console.error(`release-channel: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
