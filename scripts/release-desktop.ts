#!/usr/bin/env bun
/**
 * Build the desktop app on this machine and attach it to a GitHub release.
 *
 *   bun scripts/release-desktop.ts build [--no-publish]
 *   bun scripts/release-desktop.ts publish
 *
 * The version in package.json decides everything: its tag (`v<version>`) and
 * its update channel, from the suffix. `2.23.0` ships to Stable,
 * `2.23.0-beta` to Beta and `2.23.0-alpha` to Unstable (each optionally
 * numbered, `-beta.2`); any other suffix is refused.
 *
 * `build` runs once per platform (macOS on a Mac, Linux on the Linux machine).
 * The first run creates and pushes the tag on HEAD, which must already be on
 * origin/main; later runs check that the tag is on their HEAD. Each run
 * uploads its artifacts and updater feed to the same draft release for the
 * tag; the first run creates that draft before packaging, and every run and
 * `publish` refuse to continue if the tag has more than one release.
 * `publish` checks that every platform made it and then makes the draft
 * public, so users and installed apps never see a partial release.
 * `--no-publish` builds without touching git state or GitHub.
 *
 * Every build also uploads `toolchain-pins.json` (the agent CLI and gh pins
 * this release carries), which a running Orkestrator reads to show what an
 * update would change. `publish` publishes the `orkestrator` npm package at
 * the same version, under its channel's dist-tag, before making the release
 * public, so standalone backends and desktop apps update to the same release;
 * `--skip-npm` leaves it out. A prerelease stays off GitHub's "Latest", so the
 * website's download links keep serving the stable release. Publishing an
 * alpha turns older published alphas back into drafts (see `hideOlderAlphas`).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  hasNotarizationCredentials,
  releaseFeedChannel,
} from "../electron-builder.release.config.js";
import {
  hostUpdateChannelOfVersion,
  type HostUpdateChannel,
} from "../packages/protocol/src/host-maintenance.js";
import { PINNED_TOOL_VERSIONS } from "../packages/toolchain/src/manifest.js";
import { assertMacUpdateFeed, prepareMacUpdateFeeds } from "./mac-update-feed.js";

const root = path.resolve(import.meta.dir, "..");
const REPOSITORY = "orkestrator-ai/orkestrator-v2";

/** Artifact extensions a complete release has, besides each platform's updater feed. */
const REQUIRED_ASSET_SUFFIXES = [
  ".dmg",
  ".zip",
  ".AppImage",
  ".pacman",
  "toolchain-pins.json",
] as const;
export const TOOLCHAIN_PINS_ASSET = "toolchain-pins.json";

/**
 * The updater feeds a release must carry: macOS's, and Linux's for either
 * supported architecture (electron-builder gives arm64 its own file).
 */
function updateFeeds(tag: string): { mac: string; linux: [string, string] } {
  const feed = releaseFeedChannel(tag);
  return { mac: `${feed}-mac.yml`, linux: [`${feed}-linux.yml`, `${feed}-linux-arm64.yml`] };
}

const CHANNEL_AUDIENCE: Record<HostUpdateChannel, string> = {
  stable: "Stable channel: everyone",
  beta: "Beta channel: Beta and Unstable users",
  unstable: "Unstable channel: Unstable users only",
};

/** The update channel `tag` ships to; refuses a suffix no channel uses. */
export function releaseChannel(tag: string): HostUpdateChannel {
  return (
    hostUpdateChannelOfVersion(tag) ??
    fail(
      `${tag} has a suffix no update channel ships. Use no suffix (Stable), -beta or -alpha (Unstable), optionally numbered like -beta.2.`,
    )
  );
}

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

function assertCleanCheckout(captureOutput: typeof capture): string {
  if (captureOutput(["git", "status", "--porcelain"])) {
    fail("the working tree has uncommitted changes. Commit or stash them first.");
  }
  return captureOutput(["git", "rev-parse", "HEAD"]);
}

/** The commit `tag` names on origin (peeled for an annotated tag), or null. */
function remoteTagCommit(tag: string, captureOutput: typeof capture): string | null {
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
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null;
}

/** The tag is what the release is built from; it must be pushed and match HEAD. */
export function assertTaggedCheckout(tag: string, captureOutput = capture): void {
  const head = assertCleanCheckout(captureOutput);
  let tagged: string;
  try {
    tagged = captureOutput(["git", "rev-parse", `${tag}^{commit}`]);
  } catch {
    fail(`tag ${tag} does not exist locally. Create it on this commit.`);
  }
  if (tagged !== head) {
    fail(`tag ${tag} does not point at HEAD (${head.slice(0, 8)}). Check out the tagged commit.`);
  }
  const remoteCommit = remoteTagCommit(tag, captureOutput);
  if (!remoteCommit) {
    fail(`tag ${tag} is not on origin. Run \`git push origin ${tag}\` first.`);
  }
  if (remoteCommit !== head) {
    fail(`tag ${tag} on origin does not point at HEAD (${head.slice(0, 8)}).`);
  }
}

/**
 * Tags HEAD with the release tag and pushes it, or checks the tag another
 * machine already pushed. A new tag only goes on a commit that is already on
 * origin/main, so a release is always built from merged code. Both machines
 * tagging the same commit at once push the same lightweight tag, which git
 * accepts; a tag on any other commit is refused.
 */
export function ensureReleaseTag(
  tag: string,
  captureOutput = capture,
  runCommand: (command: string[]) => void = run,
): void {
  const head = assertCleanCheckout(captureOutput);
  let local: string | null;
  try {
    local = captureOutput(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  } catch {
    local = null;
  }
  if (local && local !== head) {
    fail(
      `tag ${tag} already exists locally on ${local.slice(0, 8)}, not HEAD (${head.slice(0, 8)}). Check out the tagged commit, or delete the local tag if it was never pushed.`,
    );
  }
  const remoteCommit = remoteTagCommit(tag, captureOutput);
  if (remoteCommit) {
    if (remoteCommit !== head) {
      fail(
        `tag ${tag} on origin is on ${remoteCommit.slice(0, 8)}, not HEAD (${head.slice(0, 8)}). Check out the tagged commit.`,
      );
    }
    if (!local) {
      // Fetch the actual tag object (including annotations), without forcing refs.
      runCommand(["git", "fetch", "--quiet", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
      if (captureOutput(["git", "rev-parse", `${tag}^{commit}`]) !== head) {
        fail(`tag ${tag} changed on origin while fetching; refusing to release`);
      }
    }
    return;
  }
  captureOutput(["git", "fetch", "--quiet", "origin", "main"]);
  try {
    captureOutput(["git", "merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]);
  } catch {
    fail(
      `HEAD (${head.slice(0, 8)}) is not on origin/main. Merge the version bump, then release from main.`,
    );
  }
  console.log(`\nTagging ${head.slice(0, 8)} as ${tag} and pushing the tag.`);
  if (!local) runCommand(["git", "tag", tag]);
  runCommand(["git", "push", "origin", `refs/tags/${tag}`]);
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
  /** Blocks for `ms`; used to back off from a failed GitHub listing. */
  sleep(ms: number): void;
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
  sleep: Bun.sleepSync,
};

function githubToken(runtime: ReleaseRuntime): string {
  const token =
    runtime.env.GH_TOKEN ?? runtime.env.GITHUB_TOKEN ?? runtime.capture(["gh", "auth", "token"]);
  if (!token) fail("no GitHub token. Set GH_TOKEN or run `gh auth login`.");
  return token;
}

type TagRelease = { id: number; draft: boolean; assets: string[] };
type ListedRelease = TagRelease & { tag: string };

/** Waits between listings that came back empty; about half a minute in all. */
const EMPTY_LISTING_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

/**
 * Every release in the repository, draft or public.
 *
 * GitHub's list endpoint intermittently answers with no releases at all
 * (v2.26.2-beta hit it on every machine). This repository always has
 * releases, so an empty listing is a failed read, never an answer: taken at
 * face value it made a build create a second draft, a finished build report
 * its draft missing, and `publish` refuse. Filtering by tag here rather than
 * in `--jq` is what lets an empty read be told apart from "no release for this
 * tag".
 */
function listReleases(runtime: Pick<ReleaseRuntime, "capture" | "sleep">): ListedRelease[] {
  for (let attempt = 0; ; attempt++) {
    const output = runtime.capture([
      "gh",
      "api",
      "--paginate",
      `repos/${REPOSITORY}/releases?per_page=100`,
      "--jq",
      ".[] | {id, tag: .tag_name, draft, assets: [.assets[].name]}",
    ]);
    const releases = output
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ListedRelease);
    if (releases.length > 0) return releases;
    const delay = EMPTY_LISTING_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      fail(
        `GitHub listed no releases at all for ${REPOSITORY} after ${attempt + 1} attempts. ` +
          "Its releases API is returning empty pages; try again shortly.",
      );
    }
    console.warn(`\nGitHub listed no releases at all; retrying in ${delay / 1000}s.`);
    runtime.sleep(delay);
  }
}

/**
 * Every release, draft or public, for `tag`. GitHub allows several drafts for
 * one tag, and `gh release view <tag>` silently picks one of them, so anything
 * that has to see all of them lists them here.
 */
function releasesForTag(
  tag: string,
  runtime: Pick<ReleaseRuntime, "capture" | "sleep">,
): TagRelease[] {
  return listReleases(runtime)
    .filter((release) => release.tag === tag)
    .map(({ id, draft, assets }) => ({ id, draft, assets }));
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
  const existing = releasesForTag(tag, runtime);
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
  //
  // The list can lag a fresh write and omit the draft just created. Only a
  // listing that shows our draft and an older one is evidence we lost; anything
  // else keeps the draft, and the check before packaging catches a real pair.
  const ids = releasesForTag(tag, runtime).map((release) => release.id);
  const lostRace = ids.includes(created) && ids.some((id) => id < created);
  if (lostRace) {
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
    // Intel and Apple Silicon builds would both write the channel's
    // `<channel>-mac.yml` and overwrite each other, so macOS ships arm64 only.
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
  const channel = releaseChannel(tag);
  console.log(`\nReleasing ${tag} to the ${CHANNEL_AUDIENCE[channel]}.`);
  if (publish) ensureReleaseTag(tag, runtime.capture, run);
  let env = publish ? { ...runtime.env, GH_TOKEN: githubToken(runtime) } : runtime.env;
  if (platform === "darwin" && !hasNotarizationCredentials(env)) {
    env = { ...env, APPLE_KEYCHAIN_PROFILE: DEFAULT_NOTARY_KEYCHAIN_PROFILE };
  }

  if (publish) claimDraftRelease(tag, runtime, env);

  run(["bun", "install", "--frozen-lockfile"]);
  run(["mise", "run", "download:bun"]);
  run(["mise", "run", "build:all"], { ...env, NODE_OPTIONS: "--max-old-space-size=4096" });
  if (publish) soleRelease(tag, releasesForTag(tag, runtime));
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
  if (publish) soleRelease(tag, releasesForTag(tag, runtime));

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
  const channel = releaseChannel(tag);
  console.log(`\nPublishing ${tag} to the ${CHANNEL_AUDIENCE[channel]}.`);
  const release = soleRelease(tag, releasesForTag(tag, runtime));
  if (!release.draft) fail(`release ${tag} is already published.`);

  const names = release.assets;
  const feeds = updateFeeds(tag);
  const missing: string[] = [...REQUIRED_ASSET_SUFFIXES, feeds.mac].filter(
    (suffix) => !names.some((n) => n.endsWith(suffix)),
  );
  // Either supported Linux architecture can supply this platform's release build.
  if (!feeds.linux.some((feed) => names.includes(feed))) {
    missing.push(feeds.linux.join(" or "));
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

  const prerelease = channel !== "stable";
  // npm first: if it fails the release stays a draft, so the desktop and npm
  // channels never disagree about the newest version. `publish:cli` publishes
  // under the channel's dist-tag, never a prerelease under `latest`.
  const version = tag.replace(/^v/, "");
  if (options.npm) {
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
  if (channel === "unstable") hideOlderAlphas(tag, runtime);
}

/**
 * Turns every published alpha older than `tag` back into a draft.
 *
 * Beta and Unstable hosts find releases through GitHub's releases feed, which
 * lists only the newest ten or so. Both select the greatest eligible version,
 * and Beta skips alphas, so a run of alphas after the last beta or stable would
 * push every release Beta accepts off the feed. With one alpha published at a
 * time, it never can. Drafts keep their tag and assets (and npm and the
 * container image keep the version); they only leave the feed. The new alpha
 * is already public, so a failure here only warns.
 */
function hideOlderAlphas(tag: string, runtime: ReleaseRuntime): void {
  let published: ListedRelease[];
  try {
    published = listReleases(runtime).filter((release) => !release.draft);
  } catch (error) {
    console.warn(`\nCould not list releases to hide older alphas: ${String(error)}`);
    return;
  }
  const version = tag.replace(/^v/, "");
  const older = published.filter(
    (release) =>
      release.tag !== tag &&
      hostUpdateChannelOfVersion(release.tag) === "unstable" &&
      Bun.semver.order(release.tag.replace(/^v/, ""), version) < 0,
  );
  for (const release of older) {
    console.log(`\nHiding ${release.tag}: it becomes a draft, so the releases feed keeps room.`);
    try {
      runtime.run([
        "gh",
        "api",
        "--method",
        "PATCH",
        `repos/${REPOSITORY}/releases/${release.id}`,
        "-F",
        "draft=true",
        "--silent",
      ]);
    } catch (error) {
      console.warn(
        `Could not hide ${release.tag}; make it a draft on GitHub by hand: ${String(error)}`,
      );
    }
  }
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
