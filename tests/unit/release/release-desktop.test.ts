import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_NOTARY_KEYCHAIN_PROFILE,
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
  "toolchain-pins.json",
];

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
    writeToolchainPins: () => "release/toolchain-pins.json",
    npmHasVersion: () => false,
    ...overrides,
  };
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
        ["bunx", "electron-builder", flag, `--${arch}`, "--config", config, "--publish", "always"],
        ...(platform === "darwin"
          ? [
              [
                "gh",
                "release",
                "upload",
                tag,
                "--repo",
                "orkestrator-ai/orkestrator-v2",
                "--clobber",
                "release/latest-mac.yml",
              ],
            ]
          : []),
        [
          "gh",
          "release",
          "upload",
          tag,
          "--repo",
          "orkestrator-ai/orkestrator-v2",
          "--clobber",
          "release/toolchain-pins.json",
        ],
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
    expect(run.mock.calls[3]?.[0].slice(-2)).toEqual(["--publish", "never"]);
  });

  test("macOS packaging defaults to the release keychain profile for notarization", () => {
    const { runtime, run } = harness();
    runDesktopRelease(["build", "--no-publish"], runtime);
    expect(run.mock.calls[3]?.[1]).toMatchObject({
      APPLE_KEYCHAIN_PROFILE: DEFAULT_NOTARY_KEYCHAIN_PROFILE,
    });
  });

  test.each([
    [{ APPLE_KEYCHAIN_PROFILE: "other-profile" }],
    [{ APPLE_API_KEY: "key.p8", APPLE_API_KEY_ID: "id", APPLE_API_ISSUER: "issuer" }],
  ])("explicit notarization credentials are left untouched: %o", (credentials) => {
    const { runtime, run } = harness({ env: { GH_TOKEN: "test-only", ...credentials } });
    runDesktopRelease(["build", "--no-publish"], runtime);
    const env = run.mock.calls[3]?.[1];
    expect(env).toMatchObject(credentials);
    if (!("APPLE_KEYCHAIN_PROFILE" in credentials)) {
      expect(env?.APPLE_KEYCHAIN_PROFILE).toBeUndefined();
    }
  });

  test("Linux packaging gets no Apple keychain profile", () => {
    const { runtime, run } = harness({ platform: "linux", arch: "x64" });
    runDesktopRelease(["build", "--no-publish"], runtime);
    expect(run.mock.calls[3]?.[1]?.APPLE_KEYCHAIN_PROFILE).toBeUndefined();
  });

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
    const { runtime, run } = harness({
      capture: () =>
        JSON.stringify({
          isDraft: true,
          assets: assets.filter((name) => name !== missing).map((name) => ({ name })),
        }),
    });
    expect(() => runDesktopRelease(["publish"], runtime)).toThrow("is missing");
    expect(run).not.toHaveBeenCalled();
  });

  test.each([
    ["v2.19.9", false],
    ["v2.20.0-beta.1", true],
  ] as const)("derives prerelease/latest flags from %s", (releaseTag, prerelease) => {
    const { runtime, run } = harness({ releaseTag: () => releaseTag });
    runDesktopRelease(["publish"], runtime);
    expect(run).toHaveBeenCalledWith([
      "gh",
      "release",
      "edit",
      releaseTag,
      "--repo",
      "orkestrator-ai/orkestrator-v2",
      "--draft=false",
      `--prerelease=${prerelease}`,
      `--latest=${!prerelease}`,
    ]);
  });

  test("accepts the architecture-specific arm64 Linux updater feed", () => {
    const { runtime, run, capture } = harness();
    const original = capture.getMockImplementation()!;
    capture.mockImplementation((command) => command[0] === "gh" && command[2] === "view"
      ? JSON.stringify({ isDraft: true, assets: assets.map((name) => ({ name: name === "latest-linux.yml" ? "latest-linux-arm64.yml" : name })) })
      : original(command));
    runDesktopRelease(["publish"], runtime);
    // publish:cli, then the release edit.
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("publishes the npm package before making the release public, once", () => {
    const { runtime, run } = harness();
    runDesktopRelease(["publish"], runtime);
    expect(run.mock.calls.map(([command]) => command[0] === "mise" ? command.join(" ") : command[2])).toEqual([
      "mise run publish:cli",
      "edit",
    ]);

    const already = harness({ npmHasVersion: () => true });
    runDesktopRelease(["publish"], already.runtime);
    expect(already.run.mock.calls.map(([command]) => command[2])).toEqual(["edit"]);

    const skipped = harness();
    runDesktopRelease(["publish", "--skip-npm"], skipped.runtime);
    expect(skipped.run.mock.calls.map(([command]) => command[2])).toEqual(["edit"]);
  });

  test("a prerelease is never published to npm", () => {
    const { runtime, run } = harness({ releaseTag: () => "v2.20.0-beta.1" });
    runDesktopRelease(["publish"], runtime);
    expect(run.mock.calls.map(([command]) => command[2])).toEqual(["edit"]);
  });

  test("refuses an already-public release", () => {
    const { runtime, run } = harness({
      capture: () => JSON.stringify({ isDraft: false, assets: [] }),
    });
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

test.each(["dirty", "wrong-head"])("npm publication refuses %s checkout before building", (mode) => {
  const { runtime, run, capture } = harness();
  const original = capture.getMockImplementation()!;
  capture.mockImplementation((command) => {
    if (mode === "dirty" && command[1] === "status") return " M source.ts";
    if (mode === "wrong-head" && command[2] === `${tag}^{commit}`) return other;
    return original(command);
  });
  expect(() => runDesktopRelease(["publish"], runtime)).toThrow(mode === "dirty" ? "uncommitted changes" : "does not point at HEAD");
  expect(run).not.toHaveBeenCalled();
});
