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
const REQUIRED_ASSET_SUFFIXES = [
  ".dmg",
  ".zip",
  "latest-mac.yml",
  ".AppImage",
  ".pacman",
  "latest-linux.yml",
] as const;

function fail(message: string): never {
  console.error(`release-desktop: ${message}`);
  process.exit(1);
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
function assertTaggedCheckout(tag: string): void {
  if (capture(["git", "status", "--porcelain"])) {
    fail("the working tree has uncommitted changes. Commit or stash them first.");
  }
  const head = capture(["git", "rev-parse", "HEAD"]);
  const tagged = Bun.spawnSync(["git", "rev-parse", `${tag}^{commit}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tagged.exitCode !== 0) fail(`tag ${tag} does not exist locally. Create it on this commit.`);
  if (tagged.stdout.toString().trim() !== head) {
    fail(`tag ${tag} does not point at HEAD (${head.slice(0, 8)}). Check out the tagged commit.`);
  }
  const remote = capture(["git", "ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  if (!remote.split("\n").some((line) => line.startsWith(head) || line.includes(tag))) {
    fail(`tag ${tag} is not on origin. Run \`git push origin ${tag}\` first.`);
  }
}

function githubToken(): string {
  const token =
    process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? capture(["gh", "auth", "token"]);
  if (!token) fail("no GitHub token. Set GH_TOKEN or run `gh auth login`.");
  return token;
}

function build(publish: boolean): void {
  const arch = process.arch;
  let platformFlags: string[];
  let configFile: string;
  if (process.platform === "darwin") {
    // Intel and Apple Silicon builds would both write latest-mac.yml and
    // overwrite each other, so macOS ships arm64 only.
    if (arch !== "arm64") fail("macOS releases are built on Apple Silicon (arm64) only.");
    platformFlags = ["--mac", "--arm64"];
    configFile = "electron-builder.release.config.ts";
  } else if (process.platform === "linux") {
    if (arch !== "x64" && arch !== "arm64") fail(`unsupported Linux architecture: ${arch}`);
    // The pacman package is built with bsdtar (Arch's `libarchive` package).
    if (!Bun.which("bsdtar")) fail("bsdtar is required to build the pacman package.");
    platformFlags = ["--linux", `--${arch}`];
    configFile = "electron-builder.release.linux.config.ts";
  } else {
    fail(`unsupported platform: ${process.platform}`);
  }

  const tag = releaseTag();
  if (publish) assertTaggedCheckout(tag);
  const env = publish ? { ...process.env, GH_TOKEN: githubToken() } : process.env;

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

  const artifacts = readdirSync(path.join(root, "release")).filter(
    (name) => !name.includes("unpacked"),
  );
  console.log(`\nBuilt ${tag}:\n  ${artifacts.join("\n  ")}`);
  console.log(
    publish
      ? `\nUploaded to the draft release. When every platform has been built, run \`mise run release:publish\`.`
      : "\nNothing was uploaded (--no-publish).",
  );
}

function publish(): void {
  const tag = releaseTag();
  const release = JSON.parse(
    capture(["gh", "release", "view", tag, "--repo", REPOSITORY, "--json", "isDraft,assets"]),
  ) as { isDraft: boolean; assets: Array<{ name: string }> };
  if (!release.isDraft) fail(`release ${tag} is already published.`);

  const names = release.assets.map((asset) => asset.name);
  const missing = REQUIRED_ASSET_SUFFIXES.filter(
    (suffix) => !names.some((n) => n.endsWith(suffix)),
  );
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

const [command, ...flags] = process.argv.slice(2);
if (command === "build") build(!flags.includes("--no-publish"));
else if (command === "publish") publish();
else fail("usage: release-desktop.ts build [--no-publish] | publish");
