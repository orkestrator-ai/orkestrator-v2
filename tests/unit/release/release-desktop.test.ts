import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertTaggedCheckout,
  runDesktopRelease,
  type ReleaseRuntime,
} from "../../../scripts/release-desktop";

const head = "a".repeat(40);
const other = "b".repeat(40);
const tag = "v2.19.9";
const assets = [
  "app.dmg",
  "app.zip",
  "latest-mac.yml",
  "app.AppImage",
  "app.pacman",
  "latest-linux.yml",
  "release-requirements.json",
];
const REPO = "orkestrator-ai/orkestrator-v2";

function harness(overrides: Partial<ReleaseRuntime> = {}) {
  const run = mock((_command: string[], _env?: NodeJS.ProcessEnv) => {});
  const capture = mock((command: string[]) => {
    if (command[0] === "gh" && command[2] === "download") return "minimumSystemVersion: '22.0.0'\n";
    if (command[0] === "gh")
      return JSON.stringify({ isDraft: true, assets: assets.map((name) => ({ name })) });
    if (command[1] === "status") return "";
    if (command[1] === "rev-parse") return head;
    if (command[1] === "ls-remote") return `${head}\trefs/tags/${tag}`;
    throw new Error(`Unexpected command: ${command.join(" ")}`);
  });
  const runtime: ReleaseRuntime = {
    platform: "darwin",
    arch: "arm64",
    env: { GH_TOKEN: "test-only" },
    which: () => "/usr/bin/bsdtar",
    run,
    capture,
    releaseTag: () => tag,
    artifacts: () => ["app.dmg", "mac-arm64-unpacked"],
    prepareMacUpdateFeeds: () => ["release/latest-mac.yml"],
    tempDir: () => ({ path: "/tmp/release-test", cleanup: () => {} }),
    npmVersionExists: () => true,
    ...overrides,
  };
  return { runtime, run, capture };
}

function publishHarness(overrides: Partial<ReleaseRuntime> = {}, releaseAssets = assets) {
  const { runtime, run, capture } = harness(overrides);
  const original = capture.getMockImplementation()!;
  capture.mockImplementation((command) =>
    command[0] === "gh" && command[2] === "view"
      ? JSON.stringify({ isDraft: true, assets: releaseAssets.map((name) => ({ name })) })
      : original(command),
  );
  return { runtime, run, capture };
}

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desktop-release-git-"));
  directories.push(dir);
  const capture = (command: string[]) => {
    const result = Bun.spawnSync(command, {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  capture(["git", "init", "--initial-branch=release"]);
  capture(["git", "config", "user.name", "Release Test"]);
  capture(["git", "config", "user.email", "release@example.invalid"]);
  capture(["git", "init", "--bare", path.join(dir, "origin.git")]);
  capture(["git", "remote", "add", "origin", path.join(dir, "origin.git")]);
  writeFileSync(path.join(dir, ".gitignore"), "origin.git/\n");
  capture(["git", "add", ".gitignore"]);
  capture(["git", "commit", "-m", "fixture"]);
  return { dir, capture };
}

describe("release checkout guards", () => {
  test.each(["lightweight", "annotated"])("accepts a matching %s tag on a real remote", (kind) => {
    const { capture } = gitFixture();
    capture(
      kind === "annotated" ? ["git", "tag", "-a", tag, "-m", "release"] : ["git", "tag", tag],
    );
    capture(["git", "push", "origin", tag]);
    expect(() => assertTaggedCheckout(tag, capture)).not.toThrow();
  });

  test.each(["lightweight", "annotated"])(
    "rejects a mismatching remote %s tag despite a matching local tag",
    (kind) => {
      const { capture } = gitFixture();
      capture(
        kind === "annotated" ? ["git", "tag", "-a", tag, "-m", "release"] : ["git", "tag", tag],
      );
      capture(["git", "push", "origin", tag]);
      capture(["git", "commit", "--allow-empty", "-m", "later"]);
      capture(["git", "tag", "-f", tag]);
      expect(() => assertTaggedCheckout(tag, capture)).toThrow("on origin does not point at HEAD");
    },
  );

  test("rejects missing local and remote tags, a dirty checkout, and a local tag on another commit", () => {
    const { dir, capture } = gitFixture();
    expect(() => assertTaggedCheckout(tag, capture)).toThrow("does not exist locally");
    capture(["git", "tag", tag]);
    expect(() => assertTaggedCheckout(tag, capture)).toThrow("is not on origin");
    writeFileSync(path.join(dir, "dirty"), "fixture");
    expect(() => assertTaggedCheckout(tag, capture)).toThrow("uncommitted changes");
    rmSync(path.join(dir, "dirty"));
    capture(["git", "commit", "--allow-empty", "-m", "later"]);
    expect(() => assertTaggedCheckout(tag, capture)).toThrow("does not point at HEAD");
  });

  test("uses exact ref names and gives peeled annotated commits precedence over direct SHA", () => {
    const { capture } = harness();
    capture.mockImplementation((command) =>
      command[1] === "status"
        ? ""
        : command[1] === "ls-remote"
          ? `${head}\trefs/tags/${tag}\n${other}\trefs/tags/${tag}^{}`
          : head,
    );
    expect(() => assertTaggedCheckout(tag, capture)).toThrow("on origin does not point at HEAD");
    capture.mockImplementation((command) =>
      command[1] === "status"
        ? ""
        : command[1] === "ls-remote"
          ? `${head}\trefs/tags/${tag}-other`
          : head,
    );
    expect(() => assertTaggedCheckout(tag, capture)).toThrow("is not on origin");
  });
});

describe("desktop release commands", () => {
  test.each(["version: 2.19.15\n", "minimumSystemVersion: '21.0.0'\n"])(
    "refuses to publish an uploaded macOS feed without the required floor: %s",
    (feed) => {
      const { runtime, run, capture } = harness();
      const original = capture.getMockImplementation()!;
      capture.mockImplementation((command) =>
        command[2] === "download" ? feed : original(command),
      );
      expect(() => runDesktopRelease(["publish"], runtime)).toThrow("Darwin 22");
      expect(run).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["darwin", "arm64", "--mac", "electron-builder.release.config.ts"],
    ["linux", "x64", "--linux", "electron-builder.release.linux.config.ts"],
    ["linux", "arm64", "--linux", "electron-builder.release.linux.config.ts"],
  ] as const)(
    "builds %s %s with explicit publication and the correct config",
    (platform, arch, flag, config) => {
      const { runtime, run, capture } = harness({ platform, arch });
      runDesktopRelease(["build"], runtime);
      expect(capture).toHaveBeenCalledWith([
        "git",
        "ls-remote",
        "origin",
        `refs/tags/${tag}`,
        `refs/tags/${tag}^{}`,
      ]);
      expect(run.mock.calls.map(([command]) => command)).toEqual([
        ["bun", "install", "--frozen-lockfile"],
        ["mise", "run", "download:bun"],
        ["mise", "run", "build:all"],
        [
          "bun",
          "scripts/release-requirements.ts",
          "generate",
          "--out",
          "build/release-requirements.json",
        ],
        ["bunx", "electron-builder", flag, `--${arch}`, "--config", config, "--publish", "always"],
        ...(platform === "darwin"
          ? [
              [
                "gh",
                "release",
                "upload",
                tag,
                "--repo",
                REPO,
                "--clobber",
                "release/latest-mac.yml",
              ],
              // Only the macOS build uploads the manifest: parallel CI jobs
              // must not race on one asset.
              [
                "gh",
                "release",
                "upload",
                tag,
                "--repo",
                REPO,
                "--clobber",
                "build/release-requirements.json",
              ],
            ]
          : []),
      ]);
      expect(run.mock.calls[2]?.[1]).toMatchObject({
        GH_TOKEN: "test-only",
        NODE_OPTIONS: "--max-old-space-size=4096",
      });
    },
  );

  test("no-publish never checks git or GitHub and disables publishing even with a token present", () => {
    const { runtime, run, capture } = harness();
    runDesktopRelease(["build", "--no-publish"], runtime);
    expect(capture).not.toHaveBeenCalled();
    expect(run.mock.calls[4]?.[0].slice(-2)).toEqual(["--publish", "never"]);
    expect(run.mock.calls.some(([command]) => command[2] === "upload")).toBe(false);
  });

  test("signs the manifest and uploads the signature when a signing key is configured", () => {
    const { runtime, run } = harness({
      env: { GH_TOKEN: "test-only", ORKESTRATOR_RELEASE_SIGNING_KEY: "pem" },
    });
    runDesktopRelease(["build"], runtime);
    const commands = run.mock.calls.map(([command]) => command);
    expect(commands).toContainEqual([
      "bun",
      "scripts/release-requirements.ts",
      "sign",
      "--file",
      "build/release-requirements.json",
      "--out",
      "build/release-requirements.json.sig",
    ]);
    expect(commands.at(-1)?.slice(-2)).toEqual([
      "build/release-requirements.json",
      "build/release-requirements.json.sig",
    ]);
  });

  test.each(["2.21.0-rc.1", "2.21.0-alpha.1", "2.21.0+build"])(
    "refuses to build or publish %s, which is on no channel, before side effects",
    (version) => {
      const { runtime, run, capture } = harness({ releaseTag: () => `v${version}` });
      expect(() => runDesktopRelease(["build"], runtime)).toThrow("not a release channel version");
      expect(() => runDesktopRelease(["publish"], runtime)).toThrow(
        "not a release channel version",
      );
      expect(run).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["darwin", "x64", "Apple Silicon"],
    ["linux", "ia32", "unsupported Linux architecture"],
    ["win32", "x64", "unsupported platform"],
  ] as const)("refuses unsupported %s %s before side effects", (platform, arch, message) => {
    const { runtime, run, capture } = harness({ platform, arch });
    expect(() => runDesktopRelease(["build"], runtime)).toThrow(message);
    expect(run).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  test("refuses Linux packaging without bsdtar", () => {
    const { runtime, run } = harness({ platform: "linux", which: () => null });
    expect(() => runDesktopRelease(["build", "--no-publish"], runtime)).toThrow(
      "bsdtar is required",
    );
    expect(run).not.toHaveBeenCalled();
  });

  test("refuses publication before building when remote commit differs", () => {
    const { runtime, run, capture } = harness();
    capture.mockImplementation((command) =>
      command[1] === "status"
        ? ""
        : command[1] === "ls-remote"
          ? `${other}\trefs/tags/${tag}`
          : head,
    );
    expect(() => runDesktopRelease(["build"], runtime)).toThrow("on origin does not point at HEAD");
    expect(run).not.toHaveBeenCalled();
  });

  test.each(assets)("refuses to publish a draft missing required %s", (missing) => {
    const { runtime, run } = publishHarness(
      {},
      assets.filter((name) => name !== missing),
    );
    expect(() => runDesktopRelease(["publish"], runtime)).toThrow("is missing");
    expect(run).not.toHaveBeenCalled();
  });

  test("refuses to publish from a checkout that is not the pushed tag", () => {
    const { runtime, run, capture } = publishHarness();
    const original = capture.getMockImplementation()!;
    capture.mockImplementation((command) =>
      command[1] === "ls-remote" ? `${other}\trefs/tags/${tag}` : original(command),
    );
    expect(() => runDesktopRelease(["publish"], runtime)).toThrow(
      "on origin does not point at HEAD",
    );
    expect(run).not.toHaveBeenCalled();
  });

  test("verifies the uploaded requirements manifest against this checkout before publishing", () => {
    const { runtime, run } = publishHarness();
    runDesktopRelease(["publish"], runtime);
    const commands = run.mock.calls.map(([command]) => command);
    expect(commands.slice(0, 2)).toEqual([
      [
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        REPO,
        "--pattern",
        "release-requirements.json",
        "--dir",
        "/tmp/release-test",
        "--clobber",
      ],
      [
        "bun",
        "scripts/release-requirements.ts",
        "verify",
        "--file",
        "/tmp/release-test/release-requirements.json",
      ],
    ]);
  });

  test("downloads and checks the signature when the draft carries one", () => {
    const { runtime, run } = publishHarness({}, [...assets, "release-requirements.json.sig"]);
    runDesktopRelease(["publish"], runtime);
    const commands = run.mock.calls.map(([command]) => command);
    expect(commands[1]?.[7]).toBe("release-requirements.json.sig");
    expect(commands[2]?.slice(-2)).toEqual([
      "--signature",
      "/tmp/release-test/release-requirements.json.sig",
    ]);
  });

  test("refuses to publish before the npm package exists", () => {
    const { runtime, run } = publishHarness({ npmVersionExists: () => false });
    expect(() => runDesktopRelease(["publish"], runtime)).toThrow("publish:cli");
    expect(run.mock.calls.some(([command]) => command[2] === "edit")).toBe(false);
  });

  test.each([
    ["v2.19.9", false],
    ["v2.20.0-beta.1", true],
    ["v2.20.1-unstable.20261015.12.g3f2a9c1", true],
  ] as const)(
    "derives prerelease/latest flags from %s and republishes the channel index",
    (releaseTag, prerelease) => {
      const { runtime, run, capture } = publishHarness({ releaseTag: () => releaseTag });
      const original = capture.getMockImplementation()!;
      capture.mockImplementation((command) =>
        command[1] === "ls-remote" ? `${head}\trefs/tags/${releaseTag}` : original(command),
      );
      runDesktopRelease(["publish"], runtime);
      const commands = run.mock.calls.map(([command]) => command);
      expect(commands.at(-2)).toEqual([
        "gh",
        "release",
        "edit",
        releaseTag,
        "--repo",
        REPO,
        "--draft=false",
        `--prerelease=${prerelease}`,
        `--latest=${!prerelease}`,
      ]);
      expect(commands.at(-1)).toEqual(["bun", "scripts/release-channel-index.ts", "publish"]);
    },
  );

  test("accepts the architecture-specific arm64 Linux updater feed", () => {
    const { runtime, run } = publishHarness(
      {},
      assets.map((name) => (name === "latest-linux.yml" ? "latest-linux-arm64.yml" : name)),
    );
    runDesktopRelease(["publish"], runtime);
    expect(run.mock.calls.some(([command]) => command[2] === "edit")).toBe(true);
  });

  test("refuses an already-public release", () => {
    const { runtime, run, capture } = harness();
    const original = capture.getMockImplementation()!;
    capture.mockImplementation((command) =>
      command[0] === "gh" && command[2] === "view"
        ? JSON.stringify({ isDraft: false, assets: [] })
        : original(command),
    );
    expect(() => runDesktopRelease(["publish"], runtime)).toThrow("already published");
    expect(run).not.toHaveBeenCalled();
  });

  test.each([[], ["publish", "--no-publish"], ["build", "--pubish"], ["unknown"]])(
    "refuses invalid arguments %j",
    (...args) => {
      const { runtime, run } = harness();
      expect(() => runDesktopRelease(args, runtime)).toThrow("usage:");
      expect(run).not.toHaveBeenCalled();
    },
  );
});
