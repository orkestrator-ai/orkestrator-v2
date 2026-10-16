#!/usr/bin/env bun
/**
 * Rebuild and publish the release channel index (`channels.json`).
 *
 *   bun scripts/release-channel-index.ts build
 *   bun scripts/release-channel-index.ts publish
 *   bun scripts/release-channel-index.ts prune-unstable [--keep 10]
 *
 * The index is derived, never edited: every run lists the published releases,
 * takes the newest of each channel, checks its requirements manifest, and
 * replaces the whole file on the fixed `update-channels` prerelease. Writers
 * that race (a maintainer's release:publish and the nightly) converge because
 * each recomputes from the same releases, and `generatedAt` is the newest
 * publication time rather than the clock.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareReleaseVersions,
  RELEASE_CHANNEL_INDEX_ASSET,
  RELEASE_CHANNEL_INDEX_SCHEMA,
  RELEASE_CHANNEL_INDEX_SCHEMA_VERSION,
  RELEASE_CHANNEL_INDEX_TAG,
  RELEASE_CHANNELS,
  RELEASE_REPOSITORY,
  parseReleaseChannelIndex,
  releaseChannelOfVersion,
  type ReleaseChannel,
  type ReleaseChannelIndex,
} from "../packages/protocol/src/release-channels";
import {
  parseReleaseRequirementsBytes,
  RELEASE_REQUIREMENTS_ASSET,
  RELEASE_REQUIREMENTS_SIGNATURE_ASSET,
  sha256Hex,
  verifyReleaseRequirementsSignature,
} from "../packages/protocol/src/release-requirements";
import { RELEASE_SIGNING_PUBLIC_KEYS } from "../packages/protocol/src/release-signing-keys";

export type PublishedRelease = {
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
  publishedAt: string | null;
  assets: string[];
};

export type ChannelIndexRuntime = {
  capture(command: string[]): string;
  captureBytes(command: string[]): Uint8Array;
  run(command: string[]): void;
  signingKeys: readonly string[];
};

function fail(message: string): never {
  throw new Error(message);
}

function versionOfTag(tag: string): string | null {
  return tag.startsWith("v") ? tag.slice(1) : null;
}

/**
 * The newest published release of each channel. A draft, a tag that is not a
 * channel version, a GitHub prerelease flag that contradicts the channel, or a
 * release without its requirements manifest is never eligible.
 */
export function selectChannelReleases(
  releases: readonly PublishedRelease[],
): Record<ReleaseChannel, (PublishedRelease & { version: string }) | null> {
  const selected = Object.fromEntries(RELEASE_CHANNELS.map((channel) => [channel, null])) as Record<
    ReleaseChannel,
    (PublishedRelease & { version: string }) | null
  >;
  for (const release of releases) {
    if (release.isDraft || !release.publishedAt) continue;
    const version = versionOfTag(release.tagName);
    const channel = version ? releaseChannelOfVersion(version) : null;
    if (!version || !channel) continue;
    if (release.isPrerelease !== (channel !== "stable")) continue;
    if (!release.assets.includes(RELEASE_REQUIREMENTS_ASSET)) continue;
    const current = selected[channel];
    if (!current || compareReleaseVersions(version, current.version) > 0) {
      selected[channel] = { ...release, version };
    }
  }
  return selected;
}

export function buildReleaseChannelIndex(options: {
  releases: readonly PublishedRelease[];
  /** SHA-256 of each selected release's verified manifest, by tag. */
  requirementsSha256: ReadonlyMap<string, string>;
  repository?: string;
}): ReleaseChannelIndex {
  const selected = selectChannelReleases(options.releases);
  const channels = {} as ReleaseChannelIndex["channels"];
  let generatedAt = "1970-01-01T00:00:00Z";
  for (const channel of RELEASE_CHANNELS) {
    const release = selected[channel];
    if (!release) {
      channels[channel] = null;
      continue;
    }
    const digest = options.requirementsSha256.get(release.tagName);
    if (!digest) fail(`no verified requirements digest for ${release.tagName}`);
    channels[channel] = {
      version: release.version,
      tag: release.tagName,
      publishedAt: release.publishedAt!,
      requirementsSha256: digest,
    };
    if (Date.parse(release.publishedAt!) > Date.parse(generatedAt))
      generatedAt = release.publishedAt!;
  }
  return parseReleaseChannelIndex({
    schema: RELEASE_CHANNEL_INDEX_SCHEMA,
    schemaVersion: RELEASE_CHANNEL_INDEX_SCHEMA_VERSION,
    repository: options.repository ?? RELEASE_REPOSITORY,
    generatedAt,
    channels,
  });
}

export function serializeReleaseChannelIndex(index: ReleaseChannelIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

type ApiRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: Array<{ name: string }>;
};

function listReleases(runtime: ChannelIndexRuntime): PublishedRelease[] {
  // --slurp joins the pages into one array of page arrays.
  const pages = JSON.parse(
    runtime.capture([
      "gh",
      "api",
      "--paginate",
      "--slurp",
      `repos/${RELEASE_REPOSITORY}/releases?per_page=100`,
    ]),
  ) as ApiRelease[][];
  return pages.flat().map((release) => ({
    tagName: release.tag_name,
    isDraft: release.draft,
    isPrerelease: release.prerelease,
    publishedAt: release.published_at,
    assets: release.assets.map((asset) => asset.name),
  }));
}

function downloadAsset(runtime: ChannelIndexRuntime, tag: string, asset: string): Uint8Array {
  return runtime.captureBytes([
    "gh",
    "release",
    "download",
    tag,
    "--repo",
    RELEASE_REPOSITORY,
    "--pattern",
    asset,
    "--output",
    "-",
  ]);
}

/** Downloads, parses and (when keys are embedded) signature-checks a release's manifest. */
export async function verifiedRequirementsDigest(
  runtime: ChannelIndexRuntime,
  release: PublishedRelease & { version: string },
): Promise<string> {
  const bytes = downloadAsset(runtime, release.tagName, RELEASE_REQUIREMENTS_ASSET);
  const manifest = parseReleaseRequirementsBytes(bytes);
  if (manifest.version !== release.version) {
    fail(`${release.tagName}'s requirements manifest is for ${manifest.version}`);
  }
  if (runtime.signingKeys.length > 0) {
    if (!release.assets.includes(RELEASE_REQUIREMENTS_SIGNATURE_ASSET)) {
      fail(`${release.tagName} has no ${RELEASE_REQUIREMENTS_SIGNATURE_ASSET}`);
    }
    const signature = new TextDecoder().decode(
      downloadAsset(runtime, release.tagName, RELEASE_REQUIREMENTS_SIGNATURE_ASSET),
    );
    if (!(await verifyReleaseRequirementsSignature(bytes, signature, runtime.signingKeys))) {
      fail(`${release.tagName}'s requirements manifest signature does not verify`);
    }
  }
  return sha256Hex(bytes);
}

export async function computeReleaseChannelIndex(
  runtime: ChannelIndexRuntime,
): Promise<ReleaseChannelIndex> {
  const releases = listReleases(runtime);
  const digests = new Map<string, string>();
  for (const release of Object.values(selectChannelReleases(releases))) {
    if (release) digests.set(release.tagName, await verifiedRequirementsDigest(runtime, release));
  }
  return buildReleaseChannelIndex({ releases, requirementsSha256: digests });
}

function assertIndexReleaseIsSafe(runtime: ChannelIndexRuntime): void {
  let release: { isPrerelease: boolean; isDraft: boolean };
  try {
    release = JSON.parse(
      runtime.capture([
        "gh",
        "release",
        "view",
        RELEASE_CHANNEL_INDEX_TAG,
        "--repo",
        RELEASE_REPOSITORY,
        "--json",
        "isPrerelease,isDraft",
      ]),
    ) as { isPrerelease: boolean; isDraft: boolean };
  } catch {
    fail(
      `the ${RELEASE_CHANNEL_INDEX_TAG} release does not exist. Create it once with ` +
        `\`gh release create ${RELEASE_CHANNEL_INDEX_TAG} --repo ${RELEASE_REPOSITORY} --prerelease ` +
        `--title "Update channels" --notes "Channel index for in-app updates. Do not delete."\``,
    );
  }
  // Pre-channel clients follow /releases/latest; this release must never be it.
  if (!release.isPrerelease || release.isDraft) {
    fail(`the ${RELEASE_CHANNEL_INDEX_TAG} release must be a published prerelease`);
  }
}

export async function publishReleaseChannelIndex(runtime: ChannelIndexRuntime): Promise<string> {
  assertIndexReleaseIsSafe(runtime);
  const text = serializeReleaseChannelIndex(await computeReleaseChannelIndex(runtime));
  const directory = mkdtempSync(path.join(os.tmpdir(), "orkestrator-channels-"));
  try {
    const file = path.join(directory, RELEASE_CHANNEL_INDEX_ASSET);
    writeFileSync(file, text);
    runtime.run([
      "gh",
      "release",
      "upload",
      RELEASE_CHANNEL_INDEX_TAG,
      "--repo",
      RELEASE_REPOSITORY,
      "--clobber",
      file,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return text;
}

/** Unstable releases (newest first) beyond the newest `keep`, never the indexed one. */
export function unstableReleasesToPrune(
  releases: readonly PublishedRelease[],
  keep: number,
): PublishedRelease[] {
  const indexed = selectChannelReleases(releases).unstable?.tagName;
  const unstable = releases
    .filter((release) => {
      const version = versionOfTag(release.tagName);
      return version !== null && releaseChannelOfVersion(version) === "unstable";
    })
    .sort((left, right) => compareReleaseVersions(right.tagName.slice(1), left.tagName.slice(1)));
  return unstable.slice(keep).filter((release) => release.tagName !== indexed);
}

export function pruneUnstableReleases(runtime: ChannelIndexRuntime, keep: number): string[] {
  if (!Number.isSafeInteger(keep) || keep < 1) fail("--keep must be a positive integer");
  const pruned = unstableReleasesToPrune(listReleases(runtime), keep);
  for (const release of pruned) {
    runtime.run([
      "gh",
      "release",
      "delete",
      release.tagName,
      "--repo",
      RELEASE_REPOSITORY,
      "--cleanup-tag",
      "--yes",
    ]);
  }
  return pruned.map((release) => release.tagName);
}

function spawn(command: string[]): Uint8Array {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    fail(`\`${command.join(" ")}\` failed: ${result.stderr.toString().trim()}`);
  }
  return new Uint8Array(result.stdout);
}

export const defaultChannelIndexRuntime: ChannelIndexRuntime = {
  capture: (command) => new TextDecoder().decode(spawn(command)).trim(),
  captureBytes: spawn,
  run: (command) => {
    console.log(`\n$ ${command.join(" ")}`);
    const result = Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"] });
    if (result.exitCode !== 0) fail(`\`${command.join(" ")}\` exited with ${result.exitCode}`);
  },
  signingKeys: RELEASE_SIGNING_PUBLIC_KEYS,
};

export async function runChannelIndex(
  args: string[],
  runtime: ChannelIndexRuntime = defaultChannelIndexRuntime,
): Promise<void> {
  const [command, ...flags] = args;
  if (command === "build" && flags.length === 0) {
    process.stdout.write(serializeReleaseChannelIndex(await computeReleaseChannelIndex(runtime)));
  } else if (command === "publish" && flags.length === 0) {
    process.stdout.write(await publishReleaseChannelIndex(runtime));
  } else if (
    command === "prune-unstable" &&
    (flags.length === 0 || (flags.length === 2 && flags[0] === "--keep"))
  ) {
    const pruned = pruneUnstableReleases(runtime, flags.length === 2 ? Number(flags[1]) : 10);
    console.log(pruned.length > 0 ? `Pruned ${pruned.join(", ")}` : "Nothing to prune");
  } else {
    fail("usage: release-channel-index.ts build | publish | prune-unstable [--keep N]");
  }
}

if (import.meta.main) {
  try {
    await runChannelIndex(process.argv.slice(2));
  } catch (error) {
    console.error(
      `release-channel-index: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
