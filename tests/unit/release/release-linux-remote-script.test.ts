/**
 * Runs the real `release-linux-remote.sh` in bash, as the builder would, with
 * a local bare repository as `origin` and stub `mise`, `gh` and `bsdtar`.
 * Slow tier: real Git and a polling follow loop.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REMOTE_SCRIPT_PATH } from "../../../scripts/release-linux-remote";

const VERSION = "9.9.9-beta";
const CHECKOUT = "~/project/apps/orkestrator-v2";

let dir: string;
let home: string;
let seed: string;
let checkout: string;

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ORKESTRATOR_RELEASE_POLL_SECONDS: "0.1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    ...extra,
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: baseEnv(),
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

function stub(name: string, body: string): void {
  const file = path.join(home, ".local/bin", name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

function runScript(args: string[], extra: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bash", REMOTE_SCRIPT_PATH, ...args], {
    cwd: home,
    env: baseEnv(extra),
    stdin: "ignore",
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

function commit(message: string): string {
  writeFileSync(path.join(seed, "file.txt"), `${message}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", message);
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  return git(seed, "rev-parse", "HEAD");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ork-release-linux-"));
  home = path.join(dir, "home");
  mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  const origin = path.join(dir, "origin.git");
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  seed = path.join(dir, "seed");
  git(dir, "clone", "--quiet", origin, seed);
  commit("first");
  checkout = path.join(home, "project/apps/orkestrator-v2");
  mkdirSync(path.dirname(checkout), { recursive: true });
  git(dir, "clone", "--quiet", origin, checkout);
  stub("gh", "exit 0");
  stub("bsdtar", "exit 0");
  // The build: record what release-desktop would have been asked to do.
  stub("mise", 'echo "build-called: $*"; echo "built in $(pwd)"; exit "${FAKE_BUILD_EXIT:-0}"');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("release-linux-remote.sh", () => {
  test("check reports a ready builder", () => {
    const result = runScript(["check", CHECKOUT, "unused", VERSION]);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("ok: gh is signed in");
    expect(result.output).toContain(`ok: checkout ${checkout}`);
    expect(result.output).toContain("ok: GitHub over HTTPS");
  }, 20_000);

  test("check names a missing checkout", () => {
    const result = runScript(["check", "~/elsewhere", "unused", VERSION]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("gh repo clone orkestrator-ai/orkestrator-v2");
  }, 20_000);

  test("build checks out the commit, runs the release build and reports its exit", () => {
    const head = commit("second");
    const result = runScript(["build", CHECKOUT, head, VERSION, "--no-publish"]);
    expect(result.exitCode, result.output).toBe(0);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(head);
    expect(result.output).toContain(
      "build-called: exec -- bun scripts/release-desktop.ts build --no-publish",
    );
    expect(result.output).toContain(`built in ${checkout}`);
    expect(result.output).toContain("release-desktop build exited with 0");
    const state = path.join(home, ".cache/orkestrator-release");
    expect(readFileSync(path.join(state, `release-desktop-${VERSION}.exit`), "utf8").trim()).toBe(
      "0",
    );

    // attach replays the finished build and its result.
    const attached = runScript(["attach", CHECKOUT, head, VERSION]);
    expect(attached.exitCode).toBe(0);
    expect(attached.output).toContain("build-called:");
  }, 30_000);

  test("build passes a failed release build's exit code back", () => {
    const head = commit("second");
    const result = runScript(["build", CHECKOUT, head, VERSION], { FAKE_BUILD_EXIT: "3" });
    expect(result.exitCode, result.output).toBe(3);
    expect(result.output).toContain("build-called: exec -- bun scripts/release-desktop.ts build");
    expect(result.output).toContain("release-desktop build exited with 3");
  }, 30_000);

  test("build refuses a dirty checkout and a commit origin does not have", () => {
    writeFileSync(path.join(checkout, "stray.txt"), "dirty\n");
    const dirty = runScript(["build", CHECKOUT, git(seed, "rev-parse", "HEAD"), VERSION]);
    expect(dirty.exitCode).toBe(1);
    expect(dirty.output).toContain("uncommitted changes");
    rmSync(path.join(checkout, "stray.txt"));

    const missing = runScript(["build", CHECKOUT, "f".repeat(40), VERSION]);
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain("is not on origin");
    expect(missing.output).not.toContain("build-called");
  }, 30_000);

  test("attach without a build says so", () => {
    const result = runScript(["attach", CHECKOUT, "unused", VERSION]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no build log");
  }, 20_000);
});
