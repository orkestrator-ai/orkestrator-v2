#!/usr/bin/env bun
/**
 * Build the desktop app on this machine and attach it to a GitHub release.
 *
 *   bun scripts/release-desktop.ts build [--no-publish]
 *   bun scripts/release-desktop.ts publish
 *
 * `build` runs once per platform (macOS on a Mac, Linux on the Linux machine).
 * Each run uploads its artifacts and updater feed to the same draft release for
 * the `v<version>` tag; the first run creates that draft before packaging, and
 * every run and `publish` refuse to continue if the tag has more than one
 * release. `publish` checks that every platform made it and then makes the
 * draft public, so users and installed apps never see a partial release.
 * `--no-publish` builds without touching git state or GitHub.
 *
 * Every build also uploads `toolchain-pins.json` (the agent CLI and gh pins
 * this release carries), which a running Orkestrator reads to show what an
 * update would change. `publish` publishes the `orkestrator` npm package at
 * the same version before making the release public, so standalone backends
 * and desktop apps update to the same release; `--skip-npm` leaves it out.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hasNotarizationCredentials } from "../electron-builder.release.config.js";
import { PINNED_TOOL_VERSIONS } from "../packages/toolchain/src/manifest.js";
import { assertMacUpdateFeed, prepareMacUpdateFeeds } from "./mac-update-feed.js";

const root = path.resolve(import.meta.dir, "..");
const REPOSITORY = "orkestrator-ai/orkestrator-v2";

/** Artifact extensions a complete release has, and the feed each platform owns. */
const REQUIRED_ASSET_SUFFIXES = [
  ".dmg",
  ".zip",
  "latest-mac.yml",
  ".AppImage",
  ".pacman",
  "toolchain-pins.json",
] as const;
export const TOOLCHAIN_PINS_ASSET = "toolchain-pins.json";
const LINUX_UPDATE_FEEDS = ["latest-linux.yml", "latest-linux-arm64.yml"] as const;
/**
 * The `xcrun notarytool store-credentials` profile the release Mac keeps. Used
 * only when no notarization credentials are set, so an exported
 * APPLE_KEYCHAIN_PROFILE, API key or Apple ID still takes precedence.
 */
export const DEFAULT_NOTARY_KEYCHAIN_PROFILE = "orkestrator-notary";

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string[], env: NodeJS.ProcessEnv = process.env): void {
  console.log(`\n$ ${command.join(" ")}`);
  const result = Bun.spawnSync(command, {
    cwd: root,
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode !== 0) fail(`\`${command.join(" ")}\` exited with ${result.exitCode}`);
}

function capture(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    fail(`\`${command.join(" ")}\` failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function releaseTag(): string {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    version: string;
  };
  return `v${manifest.version}`;
}

/** The tag is what the release is built from; it must be pushed and match HEAD. */
export function assertTaggedCheckout(tag: string, captureOutput = capture): void {
  if (captureOutput(["git", "status", "--porcelain"])) {
    fail("the working tree has uncommitted changes. Commit or stash them first.");
  }
  const head = captureOutput(["git", "rev-parse", "HEAD"]);
  let tagged: string;
  try {
    tagged = captureOutput(["git", "rev-parse", `${tag}^{commit}`]);
  } catch {
    fail(`tag ${tag} does not exist locally. Create it on this commit.`);
  }
  if (tagged !== head) {
    fail(`tag ${tag} does not point at HEAD (${head.slice(0, 8)}). Check out the tagged commit.`);
  }
  const remote = captureOutput([
    "git",
    "ls-remote",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  const refs = new Map(
    remote
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((fields): fields is [string, string] => fields.length === 2)
      .map(([sha, ref]) => [ref, sha]),
  );
  const remoteCommit = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  if (!remoteCommit) {
    fail(`tag ${tag} is not on origin. Run \`git push origin ${tag}\` first.`);
  }
  if (remoteCommit !== head) {
    fail(`tag ${tag} on origin does not point at HEAD (${head.slice(0, 8)}).`);
  }
}

export type ReleaseRuntime = {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  which(command: string): string | null;
  capture(command: string[]): string;
  run(command: string[], env?: NodeJS.ProcessEnv): void;
  releaseTag(): string;
  artifacts(): string[];
  prepareMacUpdateFeeds(): string[];
  /** Writes `toolchain-pins.json` for this release; returns its path. */
  writeToolchainPins(version: string): string;
  /** Whether `orkestrator@version` is already on npm. */
  npmHasVersion(version: string): boolean;
};

function writeToolchainPins(version: string): string {
  const directory = path.join(root, "release");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, TOOLCHAIN_PINS_ASSET);
  writeFileSync(file, `${JSON.stringify({ version, tools: PINNED_TOOL_VERSIONS }, null, 2)}\n`);
  return file;
}

function npmHasVersion(version: string): boolean {
  const result = Bun.spawnSync([
    "curl",
    "-sf",
    "-o",
    "/dev/null",
    `https://registry.npmjs.org/orkestrator/${version}`,
  ]);
  return result.exitCode === 0;
}

const defaultRuntime: ReleaseRuntime = {
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  which: Bun.which,
  capture,
  run,
  releaseTag,
  artifacts: () => readdirSync(path.join(root, "release")),
  prepareMacUpdateFeeds: () => prepareMacUpdateFeeds(path.join(root, "release")),
  writeToolchainPins,
  npmHasVersion,
};

function githubToken(runtime: ReleaseRuntime): string {
  const token =
    runtime.env.GH_TOKEN ?? runtime.env.GITHUB_TOKEN ?? runtime.capture(["gh", "auth", "token"]);
  if (!token) fail("no GitHub token. Set GH_TOKEN or run `gh auth login`.");
  return token;
}

type TagRelease = { id: number; draft: boolean; assets: string[] };

/**
 * Every release, draft or public, for `tag`. GitHub allows several drafts for
 * one tag, and `gh release view <tag>` silently picks one of them, so anything
 * that has to see all of them lists them here.
 */
function releasesForTag(tag: string, captureOutput: ReleaseRuntime["capture"]): TagRelease[] {
  const output = captureOutput([
    "gh",
    "api",
    "--paginate",
    `repos/${REPOSITORY}/releases?per_page=100`,
    "--jq",
    `.[] | select(.tag_name == "${tag}") | {id, draft, assets: [.assets[].name]}`,
  ]);
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TagRelease);
}

function splitReleaseMessage(tag: string, releases: TagRelease[]): string {
  const listing = releases
    .map((release) => `  ${release.id}: ${release.assets.join(", ") || "(no assets)"}`)
    .join("\n");
  return (
    `tag ${tag} has ${releases.length} releases on GitHub, so platform builds would be split across them:\n` +
    `${listing}\nMove every asset onto one draft and delete the others before continuing.`
  );
}

/** Exactly one release for `tag`, or a failure that names every one found. */
function soleRelease(tag: string, releases: TagRelease[]): TagRelease {
  if (releases.length === 0)
    fail(`release ${tag} does not exist. Run \`mise run release:desktop\` first.`);
  if (releases.length > 1) fail(splitReleaseMessage(tag, releases));
  return releases[0]!;
}

/**
 * Make sure the tag has exactly one draft before electron-builder runs. Left to
 * itself, electron-builder uploads several files at once and each upload that
 * finds no release creates its own, which splits one platform's artifacts
 * across several drafts. With the draft already there, every upload finds it.
 */
function claimDraftRelease(tag: string, runtime: ReleaseRuntime, env: NodeJS.ProcessEnv): void {
  const existing = releasesForTag(tag, runtime.capture);
  if (existing.some((release) => !release.draft)) fail(`release ${tag} is already published.`);
  if (existing.length === 1) return;
  if (existing.length > 1) fail(splitReleaseMessage(tag, existing));

  console.log(`\nCreating the draft release for ${tag}.`);
  const created = Number(
    runtime.capture([
      "gh",
      "api",
      "--method",
      "POST",
      `repos/${REPOSITORY}/releases`,
      "-f",
      `tag_name=${tag}`,
      "-f",
      `name=${tag.replace(/^v/, "")}`,
      "-F",
      "draft=true",
      "--jq",
      ".id",
    ]),
  );
  // Two machines that both found no draft each create one. Release ids only
  // grow, so the oldest wins everywhere and each loser deletes the empty draft
  // it just made, never anyone else's. The winner may still see the loser's
  // draft here; the check before packaging confirms it has gone.
  const drafts = releasesForTag(tag, runtime.capture);
  const oldest = Math.min(...drafts.map((release) => release.id));
  if (created !== oldest) {
    runtime.run(
      ["gh", "api", "--method", "DELETE", `repos/${REPOSITORY}/releases/${created}`],
      env,
    );
  }
}

function build(publish: boolean, runtime: ReleaseRuntime): void {
  const { arch, platform, run, releaseTag } = runtime;
  let platformFlags: string[];
  let configFile: string;
  if (platform === "darwin") {
    // Intel and Apple Silicon builds would both write latest-mac.yml and
    // overwrite each other, so macOS ships arm64 only.
    if (arch !== "arm64") fail("macOS releases are built on Apple Silicon (arm64) only.");
    platformFlags = ["--mac", "--arm64"];
    configFile = "electron-builder.release.config.ts";
  } else if (platform === "linux") {
    if (arch !== "x64" && arch !== "arm64") fail(`unsupported Linux architecture: ${arch}`);
    // The pacman package is built with bsdtar (Arch's `libarchive` package).
    if (!runtime.which("bsdtar")) fail("bsdtar is required to build the pacman package.");
    platformFlags = ["--linux", `--${arch}`];
    configFile = "electron-builder.release.linux.config.ts";
  } else {
    fail(`unsupported platform: ${platform}`);
  }

  const tag = releaseTag();
  if (publish) assertTaggedCheckout(tag, runtime.capture);
  let env = publish ? { ...runtime.env, GH_TOKEN: githubToken(runtime) } : runtime.env;
  if (platform === "darwin" && !hasNotarizationCredentials(env)) {
    env = { ...env, APPLE_KEYCHAIN_PROFILE: DEFAULT_NOTARY_KEYCHAIN_PROFILE };
  }

  if (publish) claimDraftRelease(tag, runtime, env);

  run(["bun", "install", "--frozen-lockfile"]);
  run(["mise", "run", "download:bun"]);
  run(["mise", "run", "build:all"], { ...env, NODE_OPTIONS: "--max-old-space-size=4096" });
  if (publish) soleRelease(tag, releasesForTag(tag, runtime.capture));
  run(
    [
      "bunx",
      "electron-builder",
      ...platformFlags,
      "--config",
      configFile,
      "--publish",
      publish ? "always" : "never",
    ],
    env,
  );
  // The `gh release upload <tag>` calls below go to whichever release gh picks,
  // so confirm electron-builder left exactly one.
  if (publish) soleRelease(tag, releasesForTag(tag, runtime.capture));

  if (platform === "darwin") {
    // Builder 26 omits mac.minimumSystemVersion from updater metadata. Its
    // uploads are draft-only; replace every feed before the draft can go public.
    const feeds = runtime.prepareMacUpdateFeeds();
    if (publish)
      run(["gh", "release", "upload", tag, "--repo", REPOSITORY, "--clobber", ...feeds], env);
  }

  const pins = runtime.writeToolchainPins(tag.replace(/^v/, ""));
  if (publish) run(["gh", "release", "upload", tag, "--repo", REPOSITORY, "--clobber", pins], env);

  const artifacts = runtime.artifacts().filter((name) => !name.includes("unpacked"));
  console.log(`\nBuilt ${tag}:\n  ${artifacts.join("\n  ")}`);
  console.log(
    publish
      ? `\nUploaded to the draft release. When every platform has been built, run \`mise run release:publish\`.`
      : "\nNothing was uploaded (--no-publish).",
  );
}

function publish(runtime: ReleaseRuntime, options: { npm: boolean }): void {
  const { releaseTag, capture, run } = runtime;
  const tag = releaseTag();
  const release = soleRelease(tag, releasesForTag(tag, capture));
  if (!release.draft) fail(`release ${tag} is already published.`);

  const names = release.assets;
  const missing: string[] = REQUIRED_ASSET_SUFFIXES.filter(
    (suffix) => !names.some((n) => n.endsWith(suffix)),
  );
  // electron-builder gives arm64 its own channel file; either supported Linux
  // architecture can supply this platform's release build.
  if (!LINUX_UPDATE_FEEDS.some((feed) => names.includes(feed))) {
    missing.push(LINUX_UPDATE_FEEDS.join(" or "));
  }
  if (missing.length > 0) {
    fail(`release ${tag} is missing ${missing.join(", ")}. Build the other platform first.`);
  }

  // Validate the uploaded bytes, not just a local copy or an asset name. This
  // also fences old drafts and interrupted builds that uploaded an ungated feed.
  for (const name of names.filter((name) => /^[a-zA-Z0-9_-]+-mac\.yml$/.test(name))) {
    assertMacUpdateFeed(
      capture([
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        REPOSITORY,
        "--pattern",
        name,
        "--output",
        "-",
      ]),
    );
  }

  const prerelease = tag.includes("-");
  // npm first: if it fails the release stays a draft, so the desktop and npm
  // channels never disagree about the newest version.
  const version = tag.replace(/^v/, "");
  if (options.npm && !prerelease) {
    if (runtime.npmHasVersion(version)) {
      console.log(`\norkestrator@${version} is already on npm.`);
    } else {
      assertTaggedCheckout(tag, runtime.capture);
      run(["mise", "run", "publish:cli"]);
    }
  }
  run([
    "gh",
    "release",
    "edit",
    tag,
    "--repo",
    REPOSITORY,
    "--draft=false",
    `--prerelease=${prerelease}`,
    `--latest=${!prerelease}`,
  ]);
  console.log(`\nPublished ${tag}: https://github.com/${REPOSITORY}/releases/tag/${tag}`);
}

export function runDesktopRelease(args: string[], runtime: ReleaseRuntime = defaultRuntime): void {
  const [command, ...flags] = args;
  if (command === "build" && flags.every((flag) => flag === "--no-publish")) {
    build(!flags.includes("--no-publish"), runtime);
  } else if (command === "publish" && flags.every((flag) => flag === "--skip-npm")) {
    publish(runtime, { npm: !flags.includes("--skip-npm") });
  } else {
    fail("usage: release-desktop.ts build [--no-publish] | publish [--skip-npm]");
  }
}

if (import.meta.main) {
  try {
    runDesktopRelease(process.argv.slice(2));
  } catch (error) {
    console.error(`release-desktop: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
