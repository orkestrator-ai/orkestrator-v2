/**
 * Runs the real `release-linux-remote.sh` as the builder does (`bash -s`, the
 * script on stdin), with a local bare repository as `origin` and stub `mise`,
 * `gh` and `bsdtar`. Slow tier: real Git and a polling follow loop.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UNMAPPED_PID } from "@orkestrator/protocol/testing/fake-pids";
import { REMOTE_SCRIPT_PATH } from "../../../scripts/release-linux-remote";

const VERSION = "9.9.9-beta";
const OTHER_VERSION = "9.9.10-beta";
const CHECKOUT = "~/project/apps/orkestrator-v2";
const SCRIPT = readFileSync(REMOTE_SCRIPT_PATH);
const STARTED = "started the Linux release build";

let dir: string;
let home: string;
let seed: string;
let checkout: string;
let gate: string;
const followers: Bun.Subprocess[] = [];

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ORKESTRATOR_RELEASE_POLL_SECONDS: "0.1",
    ORKESTRATOR_RELEASE_FLUSH_SECONDS: "0.1",
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

/** Runs the script the way ssh delivers it: `bash -s -- <args>` with the script on stdin. */
function runScript(args: string[], extra: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bash", "-s", "--", ...args], {
    cwd: home,
    env: baseEnv(extra),
    stdin: SCRIPT,
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

/** Starts the script in the background, its output going to files the test can poll. */
function startScript(args: string[], extra: Record<string, string> = {}) {
  const name = `run-${followers.length}`;
  const stdout = path.join(dir, `${name}.out`);
  const stderr = path.join(dir, `${name}.err`);
  const child = Bun.spawn(["bash", "-s", "--", ...args], {
    cwd: home,
    env: baseEnv(extra),
    stdin: SCRIPT,
    stdout: Bun.file(stdout),
    stderr: Bun.file(stderr),
  });
  followers.push(child);
  const output = () =>
    (existsSync(stdout) ? readFileSync(stdout, "utf8") : "") +
    (existsSync(stderr) ? readFileSync(stderr, "utf8") : "");
  return { child, output };
}

async function waitFor(what: string, done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commit(message: string): string {
  writeFileSync(path.join(seed, "file.txt"), `${message}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", message);
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  return git(seed, "rev-parse", "HEAD");
}

/** The builder's state directory for a checkout, as the script names it. */
function stateDir(forCheckout: string = checkout): string {
  const key = realpathSync(forCheckout).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(home, ".cache/orkestrator-release", key);
}

function lockExists(): boolean {
  try {
    lstatSync(path.join(stateDir(), "lock"));
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ork-release-linux-")));
  home = path.join(dir, "home");
  gate = path.join(dir, "gate");
  mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  const origin = path.join(dir, "origin.git");
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  seed = path.join(dir, "seed");
  git(dir, "clone", "--quiet", origin, seed);
  commit("first");
  checkout = path.join(home, "project/apps/orkestrator-v2");
  mkdirSync(path.dirname(checkout), { recursive: true });
  git(dir, "clone", "--quiet", origin, checkout);
  // gh as git's credential helper answers with a token unless told not to.
  stub(
    "gh",
    [
      'if [ "$1 $2" = "auth git-credential" ]; then',
      "  cat >/dev/null",
      '  [ -n "${FAKE_GH_NO_TOKEN:-}" ] || printf "username=x-access-token\\npassword=stub-secret-token\\n"',
      "fi",
      "exit 0",
    ].join("\n"),
  );
  stub("bsdtar", "exit 0");
  // The build: record what release-desktop would have been asked to do, and
  // with FAKE_BUILD_GATE set keep running until that file appears.
  stub(
    "mise",
    [
      'echo "build-called: $*"',
      'echo "built in $(pwd)"',
      'if [ -n "${FAKE_BUILD_GATE:-}" ]; then while [ ! -e "$FAKE_BUILD_GATE" ]; do sleep 0.05; done; fi',
      'exit "${FAKE_BUILD_EXIT:-0}"',
    ].join("\n"),
  );
});

afterEach(async () => {
  // Let any held build finish so no process outlives the test.
  writeFileSync(gate, "");
  await Promise.all(followers.splice(0).map((child) => child.exited));
  const state = path.join(home, ".cache/orkestrator-release");
  if (existsSync(state)) {
    for (const entry of Array.from(new Bun.Glob("*/*.pid").scanSync({ cwd: state }))) {
      const pid = Number(readFileSync(path.join(state, entry), "utf8").trim());
      if (pid > 0) await waitFor(`build ${pid} to exit`, () => !alive(pid), 10_000);
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("release-linux-remote.sh", () => {
  test("check reports a ready builder, GitHub rewritten to HTTPS with gh's credential", () => {
    const result = runScript(["check", CHECKOUT, "unused", VERSION]);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("ok: gh is signed in");
    expect(result.output).toContain("ok: git@github.com: URLs go over HTTPS");
    expect(result.output).toContain("ok: git gets GitHub credentials from gh");
    expect(result.output).toContain(`ok: checkout ${checkout}`);
    expect(result.output).toContain("ok: GitHub over HTTPS");
    expect(result.output).not.toContain("stub-secret-token");
  }, 20_000);

  test("check fails when gh hands git no credential", () => {
    const result = runScript(["check", CHECKOUT, "unused", VERSION], { FAKE_GH_NO_TOKEN: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("git gets no GitHub credentials");
  }, 20_000);

  test("check names a missing checkout", () => {
    const result = runScript(["check", "~/elsewhere", "unused", VERSION]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("gh repo clone orkestrator-ai/orkestrator-v2");
  }, 20_000);

  test("a subdirectory of a checkout is not a checkout", () => {
    mkdirSync(path.join(checkout, "sub"));
    const result = runScript(["check", `${CHECKOUT}/sub`, "unused", VERSION]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no checkout at");
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
    expect(
      readFileSync(path.join(stateDir(), `release-desktop-${VERSION}.exit`), "utf8").trim(),
    ).toBe("0");
    expect(lockExists()).toBe(false);

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
    expect(lockExists()).toBe(false);
  }, 30_000);

  test("a build refused before it started leaves no earlier result for attach to replay", () => {
    const head = commit("second");
    const first = runScript(["build", CHECKOUT, head, VERSION], { FAKE_BUILD_EXIT: "0" });
    expect(first.exitCode, first.output).toBe(0);

    writeFileSync(path.join(checkout, "stray.txt"), "dirty\n");
    const refused = runScript(["build", CHECKOUT, head, VERSION]);
    expect(refused.exitCode).toBe(1);
    expect(refused.output).toContain("uncommitted changes");

    const attached = runScript(["attach", CHECKOUT, head, VERSION]);
    expect(attached.exitCode).toBe(1);
    expect(attached.output).toContain("no build log");
    expect(attached.output).not.toContain("build-called");
    expect(attached.output).not.toContain("exited with 0");
  }, 30_000);

  test("attach without a build says so", () => {
    const result = runScript(["attach", CHECKOUT, "unused", VERSION]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no build log");
  }, 20_000);

  test("a linked Git worktree is a valid checkout for check and build", () => {
    const head = commit("second");
    const worktree = path.join(home, "project/worktree");
    git(checkout, "worktree", "add", "--quiet", "--detach", worktree);
    expect(lstatSync(path.join(worktree, ".git")).isFile()).toBe(true);

    const checked = runScript(["check", "~/project/worktree", "unused", VERSION]);
    expect(checked.exitCode, checked.output).toBe(0);
    expect(checked.output).toContain(`ok: checkout ${worktree}`);

    const built = runScript(["build", "~/project/worktree", head, VERSION, "--no-publish"]);
    expect(built.exitCode, built.output).toBe(0);
    expect(built.output).toContain(`built in ${worktree}`);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
  }, 30_000);

  test("a second build cannot touch the checkout while one is running", async () => {
    const first = commit("second");
    const running = startScript(["build", CHECKOUT, first, VERSION], { FAKE_BUILD_GATE: gate });
    await waitFor("the first build to start", () => running.output().includes("build-called"));
    const log = path.join(stateDir(), `release-desktop-${VERSION}.log`);

    // The same version again.
    const same = runScript(["build", CHECKOUT, first, VERSION]);
    expect(same.exitCode).toBe(1);
    expect(same.output).toContain("another release build holds");
    expect(same.output).not.toContain(STARTED);

    // Another version at another commit.
    const second = commit("third");
    const other = runScript(["build", CHECKOUT, second, OTHER_VERSION]);
    expect(other.exitCode).toBe(1);
    expect(other.output).toContain("another release build holds");
    expect(existsSync(path.join(stateDir(), `release-desktop-${OTHER_VERSION}.log`))).toBe(false);

    // Neither moved the checkout or touched the running build's record.
    expect(git(checkout, "rev-parse", "HEAD")).toBe(first);
    expect(readFileSync(log, "utf8")).toContain("build-called");
    expect(existsSync(path.join(stateDir(), `release-desktop-${VERSION}.exit`))).toBe(false);

    writeFileSync(gate, "");
    expect(await running.child.exited).toBe(0);
    expect(running.output()).toContain("release-desktop build exited with 0");
    expect(lockExists()).toBe(false);

    // With the first build done, the other version builds.
    const after = runScript(["build", CHECKOUT, second, OTHER_VERSION]);
    expect(after.exitCode, after.output).toBe(0);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(second);
  }, 60_000);

  test("a lock left by a build that died is taken over", () => {
    const head = commit("second");
    mkdirSync(stateDir(), { recursive: true });
    symlinkSync(`pid:${UNMAPPED_PID}`, path.join(stateDir(), "lock"));
    const result = runScript(["build", CHECKOUT, head, VERSION]);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain(`removed a stale lock left by pid ${UNMAPPED_PID}`);
    expect(lockExists()).toBe(false);
  }, 30_000);

  test("the build survives a dropped connection and attach returns its result", async () => {
    const head = commit("second");
    const follower = startScript(["build", CHECKOUT, head, VERSION], { FAKE_BUILD_GATE: gate });
    await waitFor("the build to start", () => follower.output().includes("build-called"));
    const pid = Number(
      readFileSync(path.join(stateDir(), `release-desktop-${VERSION}.pid`), "utf8").trim(),
    );

    // ssh hanging up on the session.
    follower.child.kill("SIGHUP");
    expect(await follower.child.exited).toBe(129);
    const log = path.join(stateDir(), `release-desktop-${VERSION}.log`);
    // The follower stopped its log tail on the way out.
    await waitFor("the log tail to stop", () => {
      const ps = Bun.spawnSync(["ps", "-axo", "command"]).stdout.toString();
      return !ps.includes(`tail -n +1 -F ${log}`);
    });
    expect(alive(pid)).toBe(true);
    expect(existsSync(path.join(stateDir(), `release-desktop-${VERSION}.exit`))).toBe(false);
    expect(lockExists()).toBe(true);

    const attached = startScript(["attach", CHECKOUT, head, VERSION]);
    await waitFor("attach to follow", () => attached.output().includes("build-called"));
    writeFileSync(gate, "");
    expect(await attached.child.exited).toBe(0);
    expect(attached.output()).toContain("release-desktop build exited with 0");
    expect(lockExists()).toBe(false);
  }, 60_000);
});
