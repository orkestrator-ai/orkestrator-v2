import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUILD_COMMIT_ENV,
  buildCommitDefine,
  buildCommitEnv,
  readBuildCommit,
  type GitReader,
} from "./build-commit.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A scripted Git, in a tree whose real path is `root`. */
function fakeGit(root: string, answers: { status?: string | null; head?: string | null } = {}) {
  const reader: GitReader = (_root, args) => {
    if (args.includes("--show-toplevel")) return root;
    if (args.includes("status")) return answers.status === undefined ? "" : answers.status;
    return answers.head === undefined ? COMMIT : answers.head;
  };
  return reader;
}

describe("readBuildCommit against a real repository", () => {
  let directory: string;
  let repository: string;

  /** The repository's own config only; the preload already isolates the global one. */
  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(path.join(tmpdir(), "orkestrator-build-commit-")));
    repository = path.join(directory, "repository");
    mkdirSync(repository);
    git(repository, "init", "--quiet");
    writeFileSync(path.join(repository, "tracked.txt"), "one\n");
    writeFileSync(path.join(repository, ".gitignore"), "ignored.txt\n");
    git(repository, "add", ".");
    git(repository, "commit", "--quiet", "--no-gpg-sign", "-m", "first");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("a clean tree reports its full HEAD", () => {
    expect(readBuildCommit(repository)).toBe(git(repository, "rev-parse", "HEAD"));
    expect(readBuildCommit(repository)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a later commit reports the later commit", () => {
    const first = readBuildCommit(repository);
    writeFileSync(path.join(repository, "tracked.txt"), "two\n");
    git(repository, "commit", "--quiet", "--no-gpg-sign", "-am", "second");
    expect(readBuildCommit(repository)).toBe(git(repository, "rev-parse", "HEAD"));
    expect(readBuildCommit(repository)).not.toBe(first);
  });

  test("a modified tracked file reports null", () => {
    writeFileSync(path.join(repository, "tracked.txt"), "edited\n");
    expect(readBuildCommit(repository)).toBeNull();
  });

  test("a staged change reports null", () => {
    writeFileSync(path.join(repository, "tracked.txt"), "edited\n");
    git(repository, "add", ".");
    expect(readBuildCommit(repository)).toBeNull();
  });

  test("an untracked file reports null", () => {
    writeFileSync(path.join(repository, "new.ts"), "export {};\n");
    expect(readBuildCommit(repository)).toBeNull();
  });

  test("untracked files report null even when status is configured to hide them", () => {
    git(repository, "config", "status.showUntrackedFiles", "no");
    expect(readBuildCommit(repository)).toBe(git(repository, "rev-parse", "HEAD"));
    writeFileSync(path.join(repository, "new.ts"), "export {};\n");
    expect(git(repository, "status", "--porcelain")).toBe("");
    expect(readBuildCommit(repository)).toBeNull();
  });

  test("an ignored file does not count as a modification", () => {
    writeFileSync(path.join(repository, "ignored.txt"), "build output\n");
    expect(readBuildCommit(repository)).toBe(git(repository, "rev-parse", "HEAD"));
  });

  test("a directory that is not a repository reports null", () => {
    const outside = path.join(directory, "outside");
    mkdirSync(outside);
    expect(readBuildCommit(outside)).toBeNull();
  });

  test("a tree inside some other repository does not report that repository's commit", () => {
    const nested = path.join(repository, "unpacked-archive");
    mkdirSync(nested);
    writeFileSync(path.join(repository, ".gitignore"), "ignored.txt\nunpacked-archive/\n");
    git(repository, "commit", "--quiet", "--no-gpg-sign", "-am", "ignore it");
    expect(readBuildCommit(nested)).toBeNull();
  });
});

describe("readBuildCommit when Git does not answer", () => {
  const root = realpathSync(tmpdir());

  test("reports the commit when every read succeeds", () => {
    expect(readBuildCommit(root, fakeGit(root))).toBe(COMMIT);
  });

  test("a failed status is not a clean tree", () => {
    expect(readBuildCommit(root, fakeGit(root, { status: null }))).toBeNull();
  });

  test("a failed or malformed HEAD reports null", () => {
    expect(readBuildCommit(root, fakeGit(root, { head: null }))).toBeNull();
    expect(readBuildCommit(root, fakeGit(root, { head: "not-a-commit" }))).toBeNull();
    // A SHA-256 repository's object names are outside the reported form.
    expect(readBuildCommit(root, fakeGit(root, { head: "a".repeat(64) }))).toBeNull();
  });

  test("no Git at all reports null", () => {
    expect(readBuildCommit(root, () => null)).toBeNull();
  });
});

describe("buildCommitEnv", () => {
  const root = realpathSync(tmpdir());

  test("sets the commit of the tree", () => {
    expect(buildCommitEnv(root, { KEPT: "1" }, fakeGit(root))).toEqual({
      KEPT: "1",
      [BUILD_COMMIT_ENV]: COMMIT,
    });
  });

  test("a modified tree removes a value it inherited rather than reporting it", () => {
    const env = { KEPT: "1", [BUILD_COMMIT_ENV]: "abc1234" };
    expect(buildCommitEnv(root, env, fakeGit(root, { status: " M file" }))).toEqual({ KEPT: "1" });
    expect(env[BUILD_COMMIT_ENV]).toBe("abc1234");
  });
});

describe("buildCommitDefine", () => {
  const defined = (value?: string) =>
    buildCommitDefine(value === undefined ? {} : { [BUILD_COMMIT_ENV]: value })
      .__ORKESTRATOR_BUILD_COMMIT__;

  test("embeds a valid commit as a string literal", () => {
    expect(defined(COMMIT)).toBe(JSON.stringify(COMMIT));
    expect(defined("abc1234")).toBe('"abc1234"');
  });

  test("embeds null with no commit, an empty one from a modified tree, or an invalid one", () => {
    expect(defined()).toBe("null");
    expect(defined("")).toBe("null");
    expect(defined("abc1234-dirty")).toBe("null");
    expect(defined('";process.exit(1);"')).toBe("null");
  });
});
