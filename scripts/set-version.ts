#!/usr/bin/env bun
/**
 * Set the Orkestrator version everywhere it lives and regenerate the lockfiles.
 *
 *   mise run release:version -- 2.23.0-beta
 *
 * Checks that the committed contract manifest is current, writes the
 * top-level `version` of every package manifest (the list in AGENTS.md,
 * "Application Version Bumps"), then reinstalls with the pinned Bun so each
 * tracked `bun.lock` records it, proves the lockfiles are current with frozen
 * installs, runs the version drift test, and writes the release's contract
 * snapshot (`packages/protocol/contracts/releases/<version>.json`, plan item
 * 1007; see `scripts/contract-snapshots.ts`) with its entry in
 * `releases/index.json`. The index also takes the publication times of the
 * releases GitHub has published since (read-only `gh release list`; skipped
 * with a warning when `gh` is unavailable). Commit the result and merge it
 * through a pull request; `mise run release:desktop` then tags and builds that
 * commit.
 *
 * The suffix picks the update channel, as for every release command: none is
 * Stable, `-beta` Beta and `-alpha` Unstable. A new target must be newer than
 * the current version. Retrying the same target repairs lockfiles after an
 * interrupted run; every manifest must already match that target.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hostUpdateChannelOfVersion } from "../packages/protocol/src/host-maintenance.js";
import {
  CONTRACTS_DIRECTORY,
  GH_RELEASE_LIST_COMMAND,
  parseGitHubReleases,
  readReleaseIndex,
  releaseInputFromManifest,
  releaseSnapshotFile,
  withReleaseIndexEntries,
  writeReleaseIndex,
  writeReleaseSnapshot,
  type PublishedRelease,
} from "./contract-snapshots.js";
import type { ContractManifest } from "./generate-contract-manifest.ts";

const root = path.resolve(import.meta.dir, "..");

/** Every manifest whose `version` is the Orkestrator version. */
export const VERSIONED_MANIFESTS = [
  "package.json",
  "apps/backend/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/web-public/package.json",
  "bridges/acp-bridge/package.json",
  "bridges/cursor-bridge/package.json",
  "bridges/claude-bridge/package.json",
  "bridges/codex-bridge/package.json",
  "bridges/pi-bridge/package.json",
  "packages/cli/package.json",
  "packages/protocol/package.json",
  "packages/toolchain/package.json",
] as const;

/** Directories that own a tracked `bun.lock`; the root install does not update nested ones. */
export const LOCKFILE_DIRECTORIES = [".", "bridges/claude-bridge"] as const;

const CHANNEL_NAMES = { stable: "Stable", beta: "Beta", unstable: "Unstable" } as const;

function fail(message: string): never {
  throw new Error(message);
}

/** The version to set, without a leading `v`; refuses one no channel ships or that is older. */
export function targetVersion(input: string | undefined, current: string): string {
  if (!input) fail("usage: release:version -- <version>, for example 2.23.0 or 2.23.0-beta");
  const version = input.replace(/^v/, "");
  if (!hostUpdateChannelOfVersion(version)) {
    fail(
      `${version} is not a release version. Use no suffix (Stable), -beta or -alpha (Unstable), optionally numbered like -beta.2.`,
    );
  }
  if (Bun.semver.order(version, current) < 0) {
    fail(`${version} is not newer than the current version ${current}.`);
  }
  return version;
}

/**
 * Replaces a manifest's top-level `version`, leaving the rest of the file as
 * it was written.
 */
export function withVersion(manifest: string, version: string): string {
  const updated = manifest.replace(/^( {2}"version": )"[^"]*"/m, `$1"${version}"`);
  const parsed = JSON.parse(updated) as { version?: unknown };
  if (parsed.version !== version) fail("the manifest has no top-level version field");
  return updated;
}

/** Fails when the committed contract manifest differs from the registry, before anything is written. */
export const CONTRACT_CHECK_COMMAND = ["bun", "scripts/generate-contract-manifest.ts", "--check"];

export type SetVersionRuntime = {
  root: string;
  run(command: string[], cwd: string): void;
  log(message: string): void;
  /**
   * GitHub's published releases, for the publication times in the release
   * index; `null` when they cannot be listed. Omitted: no refresh.
   */
  listPublishedReleases?(): readonly PublishedRelease[] | null;
};

function run(command: string[], cwd: string): void {
  console.log(
    `\n$ ${command.join(" ")}${cwd === root ? "" : `  (in ${path.relative(root, cwd)})`}`,
  );
  const result = Bun.spawnSync(command, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  if (result.exitCode !== 0) fail(`\`${command.join(" ")}\` exited with ${result.exitCode}`);
}

function listPublishedReleases(): readonly PublishedRelease[] | null {
  try {
    const result = Bun.spawnSync([...GH_RELEASE_LIST_COMMAND], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.exitCode !== 0) return null;
    return parseGitHubReleases(result.stdout.toString());
  } catch {
    return null;
  }
}

const defaultRuntime: SetVersionRuntime = {
  root,
  run,
  log: (message) => console.log(message),
  listPublishedReleases,
};

/**
 * Writes `version`'s contract snapshot from the committed manifest (checked
 * current before the bump) and records it in the release index, with the
 * publication times of already recorded releases that GitHub has published.
 */
export function writeVersionSnapshot(version: string, runtime: SetVersionRuntime): void {
  const contracts = path.join(runtime.root, CONTRACTS_DIRECTORY);
  const manifest = JSON.parse(
    readFileSync(path.join(contracts, "manifest.json"), "utf8"),
  ) as ContractManifest;
  const { release, written } = writeReleaseSnapshot(
    contracts,
    releaseInputFromManifest(version, manifest),
  );
  const index = readReleaseIndex(contracts);
  const published = runtime.listPublishedReleases?.();
  if (published === null) {
    runtime.log(
      "Could not list GitHub releases; publication times in the release index were not refreshed.",
    );
  }
  const recorded = new Set(index.releases.map((entry) => entry.version));
  const dates = (published ?? []).filter((entry) => recorded.has(entry.version));
  const missing = (published ?? []).filter(
    (entry) => !recorded.has(entry.version) && entry.version !== version,
  );
  writeReleaseIndex(
    contracts,
    withReleaseIndexEntries(index, [
      ...dates.map(({ version: v, publishedAt }) => ({ version: v, publishedAt })),
      {
        version,
        publishedAt: published?.find((entry) => entry.version === version)?.publishedAt ?? null,
      },
    ]),
  );
  runtime.log(
    `Wrote the contract snapshot ${CONTRACTS_DIRECTORY}/${releaseSnapshotFile(version)} ` +
      `(${release.counts.commands} commands, ${written.filter((file) => file.startsWith("domains/")).length} new domain blobs).`,
  );
  if (missing.length > 0) {
    runtime.log(
      `Published releases without a snapshot: ${missing.map((entry) => entry.version).join(", ")}. ` +
        "Run `mise run contract:backfill`.",
    );
  }
}

export function setVersion(args: string[], runtime: SetVersionRuntime = defaultRuntime): void {
  if (args.length > 1) fail("usage: release:version -- <version>");
  const read = (manifest: string) => readFileSync(path.join(runtime.root, manifest), "utf8");
  const current = (JSON.parse(read("package.json")) as { version: string }).version;
  const version = targetVersion(args[0], current);
  if (
    version === current &&
    VERSIONED_MANIFESTS.some(
      (manifest) => (JSON.parse(read(manifest)) as { version?: string }).version !== version,
    )
  )
    fail("Cannot retry a version bump unless every manifest already matches the target");
  const channel = CHANNEL_NAMES[hostUpdateChannelOfVersion(version)!];
  runtime.log(`Setting ${current} → ${version} (${channel} channel).`);

  // Check every manifest before writing any, so a bad one leaves nothing half-bumped.
  const updates = VERSIONED_MANIFESTS.map((manifest) => {
    try {
      return [manifest, withVersion(read(manifest), version)] as const;
    } catch (error) {
      fail(`${manifest}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  // The snapshot is split from the committed manifest, so it must match the registry.
  runtime.run(CONTRACT_CHECK_COMMAND, runtime.root);
  for (const [manifest, contents] of updates) {
    writeFileSync(path.join(runtime.root, manifest), contents);
  }
  runtime.log(`Updated ${updates.length} manifests.`);

  for (const directory of LOCKFILE_DIRECTORIES) {
    runtime.run(["bun", "install"], path.join(runtime.root, directory));
  }
  for (const directory of LOCKFILE_DIRECTORIES) {
    runtime.run(["bun", "install", "--frozen-lockfile"], path.join(runtime.root, directory));
  }
  runtime.run(["bun", "test", "./tests/unit/version-drift.test.ts", "--parallel=1"], runtime.root);
  writeVersionSnapshot(version, runtime);

  runtime.log(
    `\nVersion set to ${version}. Commit the manifests, lockfiles and ${CONTRACTS_DIRECTORY}/ and merge them through a pull request,\n` +
      "then run `mise run release:desktop` on each machine and `mise run release:publish`.",
  );
}

if (import.meta.main) {
  try {
    setVersion(process.argv.slice(2));
  } catch (error) {
    console.error(`release:version: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
