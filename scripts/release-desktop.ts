#!/usr/bin/env bun
/**
 * Build the desktop app on this machine and attach it to a GitHub release.
 *
 *   bun scripts/release-desktop.ts build [--no-publish]
 *   bun scripts/release-desktop.ts publish
 *
 * `build` runs once per platform (macOS on a Mac, Linux on the Linux machine).
 * Each run uploads its artifacts and updater feed to the same draft release for
 * the `v<version>` tag. `publish` checks that every platform made it and then
 * makes the draft public, so users and installed apps never see a partial
 * release. `--no-publish` builds without touching git state or GitHub.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const REPOSITORY = "orkestrator-ai/orkestrator-v2";

/** Artifact extensions a complete release has, and the feed each platform owns. */
const REQUIRED_ASSET_SUFFIXES = [".dmg", ".zip", "latest-mac.yml", ".AppImage", ".pacman"] as const;
const LINUX_UPDATE_FEEDS = ["latest-linux.yml", "latest-linux-arm64.yml"] as const;

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
};

const defaultRuntime: ReleaseRuntime = {
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  which: Bun.which,
  capture,
  run,
  releaseTag,
  artifacts: () => readdirSync(path.join(root, "release")),
};

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
  if (publish) assertTaggedCheckout(tag, runtime.capture);
  const env = publish ? { ...runtime.env, GH_TOKEN: githubToken(runtime) } : runtime.env;

  run(["bun", "install", "--frozen-lockfile"]);
  run(["mise", "run", "download:bun"]);
  run(["mise", "run", "build:all"], { ...env, NODE_OPTIONS: "--max-old-space-size=4096" });
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

  const artifacts = runtime.artifacts().filter((name) => !name.includes("unpacked"));
  console.log(`\nBuilt ${tag}:\n  ${artifacts.join("\n  ")}`);
  console.log(
    publish
      ? `\nUploaded to the draft release. When every platform has been built, run \`mise run release:publish\`.`
      : "\nNothing was uploaded (--no-publish).",
  );
}

function publish(runtime: ReleaseRuntime): void {
  const { releaseTag, capture, run } = runtime;
  const tag = releaseTag();
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

  const prerelease = tag.includes("-");
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
