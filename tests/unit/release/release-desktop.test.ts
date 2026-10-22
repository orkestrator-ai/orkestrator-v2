import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_NOTARY_KEYCHAIN_PROFILE,
  assertTaggedCheckout,
  ensureReleaseTag,
  releaseChannel,
  runDesktopRelease,
  type ReleaseRuntime,
} from "../../../scripts/release-desktop";

const head = "a".repeat(40);
const other = "b".repeat(40);
const tag = "v2.19.9";
/** A complete draft for a release whose updater feeds are `<feed>-*.yml`. */
function assetsFor(feed: "latest" | "beta" | "alpha"): string[] {
  return [
    "app.dmg",
    "app.zip",
    `${feed}-mac.yml`,
    "app.AppImage",
    "app.pacman",
    `${feed}-linux.yml`,
    "toolchain-pins.json",
  ];
}
const assets = assetsFor("latest");

type FakeRelease = { id: number; draft: boolean; assets: string[] };

const isReleaseList = (command: string[]) => command[1] === "api" && command.includes("--paginate");

/** A release for another tag, so the repository never lists as empty. */
const UNRELATED_RELEASE = { id: 1, tag: "v2.0.0", draft: false, assets: [] };

/**
 * Every release the GitHub API lists, as `gh api --jq` prints it: `releases`
 * for `releaseTag`, the `published` releases of other tags, and one unrelated
 * release, because this repository always has some.
 */
function listing(
  releases: FakeRelease[],
  releaseTag: string = tag,
  published: Array<{ id: number; tag: string }> = [],
): string {
  return [
    ...releases.map((release) => ({ ...release, tag: releaseTag })),
    ...published.map((release) => ({ ...release, draft: false, assets: [] })),
    UNRELATED_RELEASE,
  ]
    .map((release) => JSON.stringify(release))
    .join("\n");
}

function harness(
  overrides: Partial<ReleaseRuntime> = {},
  releases: FakeRelease[] = [{ id: 100, draft: true, assets: [...assets] }],
  /** Every public release, as the listing of published releases prints them. */
  published: Array<{ id: number; tag: string }> = [],
) {
  let nextId = Math.max(100, ...releases.map((release) => release.id)) + 1;
  const releaseTag = overrides.releaseTag?.() ?? tag;
  const run = mock((command: string[], _env?: NodeJS.ProcessEnv) => {
    if (command[1] === "api" && command.includes("DELETE")) {
      const id = Number(command.at(-1)?.split("/").at(-1));
      releases.splice(
        releases.findIndex((release) => release.id === id),
        1,
      );
    }
  });
  const capture = mock((command: string[]) => {
    if (command[0] === "gh" && command[2] === "download") return "minimumSystemVersion: '22.0.0'\n";
    if (command[0] === "gh" && isReleaseList(command)) {
      return listing(releases, releaseTag, published);
    }
    if (command[0] === "gh" && command.includes("POST")) {
      const id = nextId++;
      releases.push({ id, draft: true, assets: [] });
      return String(id);
    }
    if (command[1] === "status") return "";
    if (command[1] === "rev-parse") return head;
    // Origin has whichever tag is asked for, on HEAD.
    if (command[1] === "ls-remote") return `${head}\t${command[3]}`;
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
    sleep: mock((_ms: number) => {}),
    ...overrides,
  };
  return { runtime, run, capture, releases };
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
  return { dir, capture, run: (command: string[]) => void capture(command) };
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

describe("release tagging", () => {
  test("the first machine tags the merged commit and pushes the tag; the second reuses it", () => {
    const first = gitFixture();
    first.capture(["git", "push", "origin", "HEAD:main"]);
    ensureReleaseTag(tag, first.capture, first.run);
    const head = first.capture(["git", "rev-parse", "HEAD"]);
    expect(first.capture(["git", "ls-remote", "origin", `refs/tags/${tag}`])).toStartWith(head);
    expect(() => assertTaggedCheckout(tag, first.capture)).not.toThrow();

    // The other machine: the same origin and commit, without the local tag.
    const second = gitFixture();
    second.capture(["git", "remote", "set-url", "origin", path.join(first.dir, "origin.git")]);
    second.capture(["git", "fetch", "--quiet", "origin", "main"]);
    second.capture(["git", "reset", "--hard", "FETCH_HEAD"]);
    expect(() => ensureReleaseTag(tag, second.capture, second.run)).not.toThrow();
  });

  test.each(["lightweight", "annotated"])(
    "a second machine builds and publishes with only a remote %s tag",
    (kind) => {
      const git = gitFixture();
      git.capture(
        kind === "annotated"
          ? ["git", "tag", "-a", tag, "-m", "annotated release"]
          : ["git", "tag", tag],
      );
      git.capture(["git", "push", "origin", tag]);
      const object = git.capture(["git", "rev-parse", `refs/tags/${tag}`]);
      git.capture(["git", "tag", "-d", tag]);
      const { runtime, run, capture } = harness();
      const original = capture.getMockImplementation()!;
      runtime.capture = (command) =>
        command[0] === "git" ? git.capture(command) : original(command);
      const running = run.getMockImplementation()!;
      run.mockImplementation((command, env) => {
        if (command[0] === "git") git.run(command);
        else running(command, env);
      });
      runDesktopRelease(["build"], runtime);
      expect(git.capture(["git", "rev-parse", `refs/tags/${tag}`])).toBe(object);
      runDesktopRelease(["publish"], runtime);
      expect(run).toHaveBeenCalledWith(["mise", "run", "publish:cli"]);
    },
  );

  test("refuses to tag a commit that is not on origin/main", () => {
    const { capture, run } = gitFixture();
    capture(["git", "push", "origin", "HEAD:main"]);
    capture(["git", "commit", "--allow-empty", "-m", "unmerged"]);
    expect(() => ensureReleaseTag(tag, capture, run)).toThrow("is not on origin/main");
    expect(capture(["git", "tag", "--list", tag])).toBe("");
  });

  test("refuses when the tag already names another commit, locally or on origin", () => {
    const { capture, run } = gitFixture();
    capture(["git", "push", "origin", "HEAD:main"]);
    ensureReleaseTag(tag, capture, run);
    capture(["git", "commit", "--allow-empty", "-m", "later"]);
    capture(["git", "push", "origin", "HEAD:main"]);
    expect(() => ensureReleaseTag(tag, capture, run)).toThrow("already exists locally");
    capture(["git", "tag", "-d", tag]);
    expect(() => ensureReleaseTag(tag, capture, run)).toThrow("on origin is on");
  });

  test("a build pushes a missing tag before it touches GitHub releases or packages", () => {
    const { runtime, run, capture } = harness({}, []);
    const original = capture.getMockImplementation()!;
    capture.mockImplementation((command) => {
      if (command[1] === "ls-remote" || command[1] === "fetch" || command[1] === "merge-base") {
        return "";
      }
      if (command.includes("--verify")) throw new Error("no such tag");
      return original(command);
    });
    runDesktopRelease(["build"], runtime);
    expect(run.mock.calls.slice(0, 3).map(([command]) => command.join(" "))).toEqual([
      `git tag ${tag}`,
      `git push origin refs/tags/${tag}`,
      "bun install --frozen-lockfile",
    ]);
    const tagged = capture.mock.calls.findIndex(([command]) => command[1] === "merge-base");
    const drafted = capture.mock.calls.findIndex(([command]) => command.includes("POST"));
    expect(tagged).toBeGreaterThan(-1);
    expect(drafted).toBeGreaterThan(tagged);
  });

  test("refuses a dirty checkout before tagging", () => {
    const { dir, capture, run } = gitFixture();
    writeFileSync(path.join(dir, "dirty"), "fixture");
    expect(() => ensureReleaseTag(tag, capture, run)).toThrow("uncommitted changes");
  });
});

describe("release channels", () => {
  test.each([
    ["v2.23.0", "stable"],
    ["v2.23.0-beta", "beta"],
    ["v2.23.0-beta.2", "beta"],
    ["v2.24.0-alpha", "unstable"],
  ] as const)("%s ships to %s", (releaseTag, channel) => {
    expect(releaseChannel(releaseTag)).toBe(channel);
  });

  test.each<[string[]]>([[["build"]], [["build", "--no-publish"]], [["publish"]]])(
    "%j refuses a suffix no channel ships before any side effect",
    (args) => {
      const { runtime, run, capture } = harness({ releaseTag: () => "v2.23.0-rc.1" });
      expect(() => runDesktopRelease(args, runtime)).toThrow("no update channel ships");
      expect(run).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["v2.23.0-beta", "beta"],
    ["v2.24.0-alpha.1", "alpha"],
  ] as const)("publishes %s once its %s feeds are uploaded", (releaseTag, feed) => {
    const { runtime, run } = harness({ releaseTag: () => releaseTag }, [
      { id: 100, draft: true, assets: assetsFor(feed) },
    ]);
    runDesktopRelease(["publish"], runtime);
    expect(run).toHaveBeenLastCalledWith([
      "gh",
      "release",
      "edit",
      releaseTag,
      "--repo",
      "orkestrator-ai/orkestrator-v2",
      "--draft=false",
      "--prerelease=true",
      "--latest=false",
    ]);
  });

  test("publishing an alpha turns every older published alpha back into a draft", () => {
    const { runtime, run } = harness(
      { releaseTag: () => "v2.24.0-alpha.3" },
      [{ id: 100, draft: true, assets: assetsFor("alpha") }],
      [
        { id: 90, tag: "v2.24.0-alpha.2" },
        { id: 80, tag: "v2.24.0-alpha" },
        { id: 70, tag: "v2.23.0-beta" },
        { id: 60, tag: "v2.22.0" },
        // A newer alpha line is left alone.
        { id: 95, tag: "v2.25.0-alpha" },
      ],
    );
    runDesktopRelease(["publish", "--skip-npm"], runtime);
    const commands = run.mock.calls.map(([command]) => command);
    expect(commands[0]?.[2]).toBe("edit");
    expect(commands.slice(1)).toEqual(
      [90, 80].map((id) => [
        "gh",
        "api",
        "--method",
        "PATCH",
        `repos/orkestrator-ai/orkestrator-v2/releases/${id}`,
        "-F",
        "draft=true",
        "--silent",
      ]),
    );
  });

  test.each(["v2.23.0", "v2.23.0-beta"])("publishing %s hides no alpha", (releaseTag) => {
    const { runtime, run, capture } = harness(
      { releaseTag: () => releaseTag },
      [
        {
          id: 100,
          draft: true,
          assets: assetsFor(releaseTag.includes("beta") ? "beta" : "latest"),
        },
      ],
      [{ id: 90, tag: "v2.22.0-alpha" }],
    );
    runDesktopRelease(["publish", "--skip-npm"], runtime);
    expect(run.mock.calls.map(([command]) => command[2])).toEqual(["edit"]);
    // Only the check that the draft is complete lists releases.
    expect(capture.mock.calls.filter(([command]) => isReleaseList(command))).toHaveLength(1);
  });

  test("an alpha that cannot be hidden only warns: the new alpha is already public", () => {
    const { runtime, run } = harness(
      { releaseTag: () => "v2.24.0-alpha.2" },
      [{ id: 100, draft: true, assets: assetsFor("alpha") }],
      [{ id: 90, tag: "v2.24.0-alpha" }],
    );
    run.mockImplementation((command) => {
      if (command.includes("PATCH")) throw new Error("HTTP 403");
    });
    expect(() => runDesktopRelease(["publish", "--skip-npm"], runtime)).not.toThrow();
  });

  test("refuses a beta whose drafts carry only the stable feeds", () => {
    const { runtime, run } = harness({ releaseTag: () => "v2.23.0-beta" });
    expect(() => runDesktopRelease(["publish"], runtime)).toThrow(
      "is missing beta-mac.yml, beta-linux.yml or beta-linux-arm64.yml",
    );
    expect(run).not.toHaveBeenCalled();
  });

  test("a prerelease is published to npm too", () => {
    const { runtime, run } = harness({ releaseTag: () => "v2.20.0-beta.1" }, [
      { id: 100, draft: true, assets: assetsFor("beta") },
    ]);
    runDesktopRelease(["publish"], runtime);
    expect(
      run.mock.calls.map(([command]) => (command[0] === "mise" ? command.join(" ") : command[2])),
    ).toEqual(["mise run publish:cli", "edit"]);
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
    expect(() => runDesktopRelease(["build"], runtime)).toThrow("on origin is on");
    expect(run).not.toHaveBeenCalled();
  });

  test.each(assets)("refuses to publish a draft missing required %s", (missing) => {
    const { runtime, run } = harness({}, [
      { id: 100, draft: true, assets: assets.filter((name) => name !== missing) },
    ]);
    expect(() => runDesktopRelease(["publish"], runtime)).toThrow("is missing");
    expect(run).not.toHaveBeenCalled();
  });

  test.each([
    ["v2.19.9", false, "latest"],
    ["v2.20.0-beta.1", true, "beta"],
  ] as const)("derives prerelease/latest flags from %s", (releaseTag, prerelease, feed) => {
    const { runtime, run } = harness({ releaseTag: () => releaseTag }, [
      { id: 100, draft: true, assets: assetsFor(feed) },
    ]);
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
    const { runtime, run } = harness({}, [
      {
        id: 100,
        draft: true,
        assets: assets.map((name) =>
          name === "latest-linux.yml" ? "latest-linux-arm64.yml" : name,
        ),
      },
    ]);
    runDesktopRelease(["publish"], runtime);
    // publish:cli, then the release edit.
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("publishes the npm package before making the release public, once", () => {
    const { runtime, run } = harness();
    runDesktopRelease(["publish"], runtime);
    expect(
      run.mock.calls.map(([command]) => (command[0] === "mise" ? command.join(" ") : command[2])),
    ).toEqual(["mise run publish:cli", "edit"]);

    const already = harness({ npmHasVersion: () => true });
    runDesktopRelease(["publish"], already.runtime);
    expect(already.run.mock.calls.map(([command]) => command[2])).toEqual(["edit"]);

    const skipped = harness();
    runDesktopRelease(["publish", "--skip-npm"], skipped.runtime);
    expect(skipped.run.mock.calls.map(([command]) => command[2])).toEqual(["edit"]);
  });

  test("refuses an already-public release", () => {
    const { runtime, run } = harness({}, [{ id: 100, draft: false, assets: [] }]);
    expect(() => runDesktopRelease(["publish"], runtime)).toThrow("already published");
    expect(run).not.toHaveBeenCalled();
  });

  test("refuses to publish when the tag's assets are split across two drafts", () => {
    // The v2.22.2 shape: each platform's files landed in a different draft.
    const { runtime, run } = harness({}, [
      {
        id: 100,
        draft: true,
        assets: ["app.dmg", "app.zip", "latest-mac.yml", "toolchain-pins.json"],
      },
      { id: 102, draft: true, assets: ["app.AppImage", "app.pacman", "latest-linux.yml"] },
    ]);
    expect(() => runDesktopRelease(["publish"], runtime)).toThrow("has 2 releases");
    expect(run).not.toHaveBeenCalled();
  });

  test("refuses to publish a tag with no release", () => {
    const { runtime, run } = harness({}, []);
    expect(() => runDesktopRelease(["publish"], runtime)).toThrow("does not exist");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("draft release ownership", () => {
  const buildRuns = (run: ReturnType<typeof harness>["run"]) =>
    run.mock.calls.map(([command]) => command.slice(0, 3).join(" "));

  test("the first build creates the one draft before electron-builder runs", () => {
    const { runtime, run, capture, releases } = harness({}, []);
    runDesktopRelease(["build"], runtime);
    const created = capture.mock.calls.findIndex(([command]) => command.includes("POST"));
    expect(capture.mock.calls[created]?.[0]).toEqual([
      "gh",
      "api",
      "--method",
      "POST",
      "repos/orkestrator-ai/orkestrator-v2/releases",
      "-f",
      `tag_name=${tag}`,
      "-f",
      "name=2.19.9",
      "-F",
      "draft=true",
      "--jq",
      ".id",
    ]);
    expect(releases).toEqual([{ id: 101, draft: true, assets: [] }]);
    expect(buildRuns(run)[0]).toBe("bun install --frozen-lockfile");
  });

  test("a listing that lags the create never deletes the new draft", () => {
    // v2.22.3: the list right after the create omitted the new draft.
    const { runtime, run, capture, releases } = harness({}, []);
    const original = capture.getMockImplementation()!;
    let listings = 0;
    capture.mockImplementation((command) =>
      isReleaseList(command) && ++listings === 2 ? listing([]) : original(command),
    );
    runDesktopRelease(["build"], runtime);
    expect(run.mock.calls.some(([command]) => command.includes("DELETE"))).toBe(false);
    expect(releases.map((release) => release.id)).toEqual([101]);
  });

  test("a lagging listing that shows only an older draft keeps ours and stops before packaging", () => {
    const { runtime, run, capture, releases } = harness({}, []);
    const original = capture.getMockImplementation()!;
    let listings = 0;
    capture.mockImplementation((command) => {
      const output = original(command);
      if (command.includes("POST")) releases.unshift({ id: 50, draft: true, assets: [] });
      // The second listing has the other machine's draft but not yet ours.
      if (isReleaseList(command) && ++listings === 2) return listing([releases[0]!]);
      return output;
    });
    expect(() => runDesktopRelease(["build"], runtime)).toThrow("has 2 releases");
    expect(run.mock.calls.some(([command]) => command.includes("DELETE"))).toBe(false);
    expect(run.mock.calls.some(([command]) => command[1] === "electron-builder")).toBe(false);
    expect(releases.map((release) => release.id)).toEqual([50, 101]);
  });

  test("a later build reuses the existing draft", () => {
    const { runtime, capture, releases } = harness({ platform: "linux", arch: "x64" }, [
      { id: 100, draft: true, assets: ["app.dmg"] },
    ]);
    runDesktopRelease(["build"], runtime);
    expect(capture.mock.calls.some(([command]) => command.includes("POST"))).toBe(false);
    expect(releases.map((release) => release.id)).toEqual([100]);
  });

  test("a build that loses a creation race deletes only its own empty draft", () => {
    const { runtime, run, capture, releases } = harness({}, []);
    const original = capture.getMockImplementation()!;
    capture.mockImplementation((command) => {
      const output = original(command);
      // Another machine created its draft first, between our list and our create.
      if (command.includes("POST")) releases.unshift({ id: 50, draft: true, assets: [] });
      return output;
    });
    runDesktopRelease(["build"], runtime);
    expect(run.mock.calls[0]?.[0]).toEqual([
      "gh",
      "api",
      "--method",
      "DELETE",
      "repos/orkestrator-ai/orkestrator-v2/releases/101",
    ]);
    expect(releases.map((release) => release.id)).toEqual([50]);
  });

  test.each([
    ["deletes its draft", true],
    ["leaves its draft behind", false],
  ])(
    "the race winner keeps its draft and packages only once the loser %s",
    (_name, loserCleansUp) => {
      const { runtime, run, capture, releases } = harness({}, []);
      const capturing = capture.getMockImplementation()!;
      capture.mockImplementation((command) => {
        const output = capturing(command);
        // The other machine creates just after us, so its draft is the newer one.
        if (command.includes("POST")) releases.push({ id: 200, draft: true, assets: [] });
        return output;
      });
      const running = run.getMockImplementation()!;
      run.mockImplementation((command, env) => {
        running(command, env);
        // The loser removes its own draft while this machine installs and builds.
        if (
          loserCleansUp &&
          command[0] === "bun" &&
          releases.some((release) => release.id === 200)
        ) {
          releases.splice(
            releases.findIndex((release) => release.id === 200),
            1,
          );
        }
      });

      const build = () => runDesktopRelease(["build"], runtime);
      if (loserCleansUp) {
        expect(build).not.toThrow();
        expect(releases.map((release) => release.id)).toEqual([101]);
      } else {
        expect(build).toThrow("has 2 releases");
        expect(run.mock.calls.some(([command]) => command[1] === "electron-builder")).toBe(false);
      }
      expect(run.mock.calls.some(([command]) => command.includes("DELETE"))).toBe(false);
    },
  );

  test.each([
    [
      "already split",
      [
        { id: 100, draft: true, assets: ["app.dmg"] },
        { id: 102, draft: true, assets: ["app.AppImage"] },
      ],
      "has 2 releases",
    ],
    ["already published", [{ id: 100, draft: false, assets: [] }], "already published"],
  ] as const)(
    "refuses to build into a tag that is %s, before packaging",
    (_name, existing, message) => {
      const { runtime, run } = harness(
        {},
        existing.map((release) => ({ ...release, assets: [...release.assets] })),
      );
      expect(() => runDesktopRelease(["build"], runtime)).toThrow(message);
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("refuses to upload pins and feeds if electron-builder split the release", () => {
    const { runtime, run, releases } = harness();
    const original = run.getMockImplementation()!;
    run.mockImplementation((command, env) => {
      original(command, env);
      if (command[1] === "electron-builder")
        releases.push({ id: 300, draft: true, assets: ["app.dmg.blockmap"] });
    });
    expect(() => runDesktopRelease(["build"], runtime)).toThrow("has 2 releases");
    expect(run.mock.calls.some(([command]) => command[1] === "release")).toBe(false);
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

describe("empty release listings", () => {
  /** Makes the first `count` release listings come back empty, as GitHub's API intermittently does. */
  function emptyListings(capture: ReturnType<typeof harness>["capture"], count: number) {
    const original = capture.getMockImplementation()!;
    let listings = 0;
    capture.mockImplementation((command) =>
      isReleaseList(command) && ++listings <= count ? "" : original(command),
    );
  }

  test("a build retries an empty listing instead of creating a second draft", () => {
    // v2.26.2-beta: an empty listing made a later build create a duplicate draft.
    const { runtime, capture, releases } = harness();
    emptyListings(capture, 2);
    runDesktopRelease(["build"], runtime);
    expect(capture.mock.calls.some(([command]) => command.includes("POST"))).toBe(false);
    expect(releases.map((release) => release.id)).toEqual([100]);
    expect(runtime.sleep).toHaveBeenCalledTimes(2);
  });

  test("a finished build retries an empty listing before uploading pins and feeds", () => {
    // v2.26.2-beta: Linux uploaded everything, then reported its draft missing.
    const { runtime, run, capture } = harness();
    const original = capture.getMockImplementation()!;
    let built = false;
    capture.mockImplementation((command) => {
      if (isReleaseList(command) && built) {
        built = false;
        return "";
      }
      return original(command);
    });
    const running = run.getMockImplementation()!;
    run.mockImplementation((command, env) => {
      running(command, env);
      if (command[1] === "electron-builder") built = true;
    });
    runDesktopRelease(["build"], runtime);
    expect(run.mock.calls.at(-1)?.[0].at(-1)).toBe("release/toolchain-pins.json");
  });

  test("publish retries an empty listing", () => {
    const { runtime, run, capture } = harness();
    emptyListings(capture, 1);
    runDesktopRelease(["publish", "--skip-npm"], runtime);
    expect(run.mock.calls.map(([command]) => command[2])).toEqual(["edit"]);
  });

  test("gives up on a listing that stays empty, before any side effect", () => {
    const { runtime, run, capture } = harness({}, []);
    emptyListings(capture, Number.POSITIVE_INFINITY);
    expect(() => runDesktopRelease(["build"], runtime)).toThrow("listed no releases at all");
    expect(runtime.sleep).toHaveBeenCalledTimes(4);
    expect(capture.mock.calls.some(([command]) => command.includes("POST"))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

test.each(["dirty", "wrong-head"])(
  "npm publication refuses %s checkout before building",
  (mode) => {
    const { runtime, run, capture } = harness();
    const original = capture.getMockImplementation()!;
    capture.mockImplementation((command) => {
      if (mode === "dirty" && command[1] === "status") return " M source.ts";
      if (mode === "wrong-head" && command[2] === `${tag}^{commit}`) return other;
      return original(command);
    });
    expect(() => runDesktopRelease(["publish"], runtime)).toThrow(
      mode === "dirty" ? "uncommitted changes" : "does not point at HEAD",
    );
    expect(run).not.toHaveBeenCalled();
  },
);
