#!/usr/bin/env bun
/**
 * Build the desktop app on this machine and attach it to a GitHub release.
 *
 *   bun scripts/release-desktop.ts build [--no-publish]
 *   bun scripts/release-desktop.ts publish
 *
 * `build` runs once per platform (macOS on a Mac, Linux on the Linux machine).
 * Each run uploads its artifacts, updater feed and release requirements
 * manifest to the same draft release for the `v<version>` tag. `publish`
 * checks that every platform made it, that the uploaded manifest is the one
 * this tagged checkout generates and that the npm package exists, then makes
 * the draft public on its channel and rebuilds the channel index, so users and
 * installed apps never see a partial release. `--no-publish` builds without
 * touching git state or GitHub. Channels: docs/architecture/release-channels-and-updates.md.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertReleaseChannelVersion,
  type ReleaseChannel,
} from "../packages/protocol/src/release-channels.js";
import {
  RELEASE_REQUIREMENTS_ASSET,
  RELEASE_REQUIREMENTS_SIGNATURE_ASSET,
} from "../packages/protocol/src/release-requirements.js";
import { RELEASE_SIGNING_PUBLIC_KEYS } from "../packages/protocol/src/release-signing-keys.js";
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
  RELEASE_REQUIREMENTS_ASSET,
] as const;
const LINUX_UPDATE_FEEDS = ["latest-linux.yml", "latest-linux-arm64.yml"] as const;
/** Where the build writes the manifest; electron-builder copies it into resources. */
export const REQUIREMENTS_FILE = `build/${RELEASE_REQUIREMENTS_ASSET}`;
export const REQUIREMENTS_SIGNATURE_FILE = `build/${RELEASE_REQUIREMENTS_SIGNATURE_ASSET}`;

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
  /** A fresh private directory; `cleanup` removes it. */
  tempDir(): { path: string; cleanup(): void };
  /** Whether `orkestrator@<version>` is on the npm registry. */
  npmVersionExists(version: string): boolean;
  /** The public keys this build embeds (`release-signing-keys.ts`). */
  trustedSigningKeys: readonly string[];
};

function npmVersionExists(version: string): boolean {
  const url = `https://registry.npmjs.org/orkestrator/${encodeURIComponent(version)}`;
  const result = Bun.spawnSync(["curl", "-sS", "-o", os.devNull, "-w", "%{http_code}", url], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const status = result.stdout.toString().trim();
  if (status === "200") return true;
  if (status === "404") return false;
  fail(`could not ask npm about orkestrator@${version} (HTTP ${status || "error"})`);
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
  tempDir: () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "orkestrator-release-"));
    return { path: directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  },
  npmVersionExists,
  trustedSigningKeys: RELEASE_SIGNING_PUBLIC_KEYS,
};

/** The release's channel, refused before any side effect when the version has none. */
function releaseChannel(tag: string): ReleaseChannel {
  if (!tag.startsWith("v")) fail(`release tag ${tag} must start with v`);
  return assertReleaseChannelVersion(tag.slice(1));
}

function githubToken(runtime: ReleaseRuntime): string {
  const token =
    runtime.env.GH_TOKEN ?? runtime.env.GITHUB_TOKEN ?? runtime.capture(["gh", "auth", "token"]);
  if (!token) fail("no GitHub token. Set GH_TOKEN or run `gh auth login`.");
  return token;
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
  releaseChannel(tag);
  if (publish) assertTaggedCheckout(tag, runtime.capture);
  const env = publish ? { ...runtime.env, GH_TOKEN: githubToken(runtime) } : runtime.env;
  const signed =
    platform === "darwin" && Boolean(runtime.env.ORKESTRATOR_RELEASE_SIGNING_KEY?.trim());
  // Installs that ship these keys refuse an unsigned manifest, so find out
  // before a 20-minute build rather than at publish. Only the macOS job
  // publishes the shared manifest/signature; Linux builders need no private key.
  if (publish && platform === "darwin" && runtime.trustedSigningKeys.length > 0 && !signed) {
    fail(
      "this build embeds release signing keys, so its release must be signed: set ORKESTRATOR_RELEASE_SIGNING_KEY",
    );
  }

  run(["bun", "install", "--frozen-lockfile"]);
  run(["mise", "run", "download:bun"]);
  run(["mise", "run", "build:all"], { ...env, NODE_OPTIONS: "--max-old-space-size=4096" });
  // Before packaging: electron-builder copies it into the app's resources.
  run(["bun", "scripts/release-requirements.ts", "generate", "--out", REQUIREMENTS_FILE]);
  if (signed) {
    run([
      "bun",
      "scripts/release-requirements.ts",
      "sign",
      "--file",
      REQUIREMENTS_FILE,
      "--out",
      REQUIREMENTS_SIGNATURE_FILE,
    ]);
    // A key the build does not embed would sign a release no install accepts.
    run([
      "bun",
      "scripts/release-requirements.ts",
      "verify",
      "--file",
      REQUIREMENTS_FILE,
      "--signature",
      REQUIREMENTS_SIGNATURE_FILE,
    ]);
  }
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

  if (platform === "darwin") {
    // Builder 26 omits mac.minimumSystemVersion from updater metadata. Its
    // uploads are draft-only; replace every feed before the draft can go public.
    const feeds = runtime.prepareMacUpdateFeeds();
    if (publish)
      run(["gh", "release", "upload", tag, "--repo", REPOSITORY, "--clobber", ...feeds], env);
  }
  // Generation is deterministic, so every platform makes the same bytes; only
  // the macOS build (required in every release) uploads them, so parallel CI
  // jobs never race on one asset. `publish` re-derives and compares them.
  if (publish && platform === "darwin") {
    run(
      [
        "gh",
        "release",
        "upload",
        tag,
        "--repo",
        REPOSITORY,
        "--clobber",
        REQUIREMENTS_FILE,
        ...(signed ? [REQUIREMENTS_SIGNATURE_FILE] : []),
      ],
      env,
    );
  }

  const artifacts = runtime.artifacts().filter((name) => !name.includes("unpacked"));
  console.log(`\nBuilt ${tag}:\n  ${artifacts.join("\n  ")}`);
  console.log(
    publish
      ? `\nUploaded to the draft release. When every platform has been built, run \`mise run release:publish\`.`
      : "\nNothing was uploaded (--no-publish).",
  );
}

function verifyUploadedRequirements(
  runtime: ReleaseRuntime,
  tag: string,
  names: readonly string[],
): void {
  const directory = runtime.tempDir();
  try {
    const signed = names.includes(RELEASE_REQUIREMENTS_SIGNATURE_ASSET);
    const assets = [
      RELEASE_REQUIREMENTS_ASSET,
      ...(signed ? [RELEASE_REQUIREMENTS_SIGNATURE_ASSET] : []),
    ];
    for (const asset of assets) {
      runtime.run([
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        REPOSITORY,
        "--pattern",
        asset,
        "--dir",
        directory.path,
        "--clobber",
      ]);
    }
    // Re-derives the bytes from this tagged checkout, and requires a valid
    // signature whenever this build embeds signing keys.
    runtime.run([
      "bun",
      "scripts/release-requirements.ts",
      "verify",
      "--file",
      path.join(directory.path, RELEASE_REQUIREMENTS_ASSET),
      ...(signed
        ? ["--signature", path.join(directory.path, RELEASE_REQUIREMENTS_SIGNATURE_ASSET)]
        : []),
    ]);
  } finally {
    directory.cleanup();
  }
}

function publish(runtime: ReleaseRuntime): void {
  const { releaseTag, capture, run } = runtime;
  const tag = releaseTag();
  const channel = releaseChannel(tag);
  // The manifest check regenerates from the tree, so it must be the tag's.
  assertTaggedCheckout(tag, capture);
  const release = JSON.parse(
    capture(["gh", "release", "view", tag, "--repo", REPOSITORY, "--json", "isDraft,assets"]),
  ) as { isDraft: boolean; assets: Array<{ name: string }> };
  if (!release.isDraft) fail(`release ${tag} is already published.`);

  const names = release.assets.map((asset) => asset.name);
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

  verifyUploadedRequirements(runtime, tag, names);
  // The channel index must never point a headless backend at a version
  // `bun add` cannot install.
  if (!runtime.npmVersionExists(tag.slice(1))) {
    fail(`orkestrator@${tag.slice(1)} is not on npm yet. Run \`mise run publish:cli\` first.`);
  }

  // Only stable is ever "latest": pre-channel clients follow /releases/latest.
  const prerelease = channel !== "stable";
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
  console.log(
    `\nPublished ${tag} on ${channel}: https://github.com/${REPOSITORY}/releases/tag/${tag}`,
  );
  run(["bun", "scripts/release-channel-index.ts", "publish"]);
}

export function runDesktopRelease(args: string[], runtime: ReleaseRuntime = defaultRuntime): void {
  const [command, ...flags] = args;
  if (command === "build" && flags.every((flag) => flag === "--no-publish")) {
    build(!flags.includes("--no-publish"), runtime);
  } else if (command === "publish" && flags.length === 0) {
    publish(runtime);
  } else {
    fail("usage: release-desktop.ts build [--no-publish] | publish");
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
