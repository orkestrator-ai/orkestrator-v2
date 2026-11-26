/**
 * The scheduler against real Git, for the one failure it retries: another Git
 * process holding the remote-tracking ref the background fetch updates. The
 * harness tests in `apps/backend/tests/git-fetch-scheduler.test.ts` cover the
 * scheduling itself with a fake runner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { quoteShell } from "../commands/agent-support.js";
import { createGitFetchScheduler } from "../diff-stats-tracking.js";
import { recurringWorkMetrics, RecurringWorkMetrics } from "../recurring/work-metrics.js";
import { CommandFailedError, runCommand } from "../shell.js";
import { backgroundFetchArgs } from "./background-fetch.js";
import { GitFetchScheduler } from "./fetch-scheduler.js";
import { isMissingRemoteRefFailure, isRefLockContentionFailure } from "./noninteractive-env.js";

let root: string;
let upstream: string;
let clone: string;
let env: NodeJS.ProcessEnv;

const git = (args: string[], cwd: string) =>
  runCommand("git", args, { cwd, env, timeoutMs: 20_000 });
const commit = (message: string) =>
  git(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-qm",
      message,
    ],
    upstream,
  );
const tip = async (cwd: string, ref: string) => (await git(["rev-parse", ref], cwd)).stdout.trim();
const lockPath = () => path.join(clone, ".git", "refs", "remotes", "origin", "main.lock");

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-git-fetch-lock-")));
  upstream = path.join(root, "upstream");
  clone = path.join(root, "clone");
  const gitconfig = path.join(root, "gitconfig");
  await fs.writeFile(gitconfig, "");
  env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitconfig, LC_ALL: "C" };
  await fs.mkdir(upstream);
  await git(["init", "-q", "-b", "main"], upstream);
  await commit("one");
  await git(["clone", "-q", upstream, clone], root);
  // The remote moves on, so the background fetch has a ref to update.
  await commit("two");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Git's own failure when another process holds `origin/main` during the fetch. */
async function fetchWithRefLocked(): Promise<unknown> {
  await fs.writeFile(lockPath(), "");
  return git(["fetch", ...backgroundFetchArgs("main")], clone).then(
    () => null,
    (error: unknown) => error,
  );
}

describe("isRefLockContentionFailure", () => {
  test("matches Git's failure when another process holds the ref", async () => {
    const error = await fetchWithRefLocked();

    expect(error).toBeInstanceOf(CommandFailedError);
    expect(isRefLockContentionFailure(error)).toBe(true);
    expect(isMissingRemoteRefFailure(error)).toBe(false);
  });

  test("does not match a branch the remote does not have", async () => {
    const error = await git(["fetch", ...backgroundFetchArgs("no-such-branch")], clone).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(isMissingRemoteRefFailure(error)).toBe(true);
    expect(isRefLockContentionFailure(error)).toBe(false);
  });

  test("does not match a timed-out command or a plain error", () => {
    const stderr =
      "error: cannot lock ref 'refs/remotes/origin/main': is at 1111111 but expected 2222222";
    expect(
      isRefLockContentionFailure(new CommandFailedError("t", { stderr, timedOut: true })),
    ).toBe(false);
    expect(isRefLockContentionFailure(new Error(stderr))).toBe(false);
  });
});

describe("GitFetchScheduler with a contended ref", () => {
  test("the production scheduler retries a real lock failure under French locale settings", async () => {
    await fs.writeFile(lockPath(), "");
    const attempts = path.join(root, "fetch-locales");
    const uploadPack = path.join(root, "upload-pack");
    // Release the competing lock when the second fetch reaches the remote.
    await fs.writeFile(
      uploadPack,
      `if test -f ${quoteShell(attempts)}; then rm -f ${quoteShell(lockPath())}; fi\n` +
        `printf '%s\\n' "$LC_ALL" >> ${quoteShell(attempts)}\n` +
        'exec git-upload-pack "$@"\n',
    );
    await git(["config", "remote.origin.uploadpack", `sh ${quoteShell(uploadPack)}`], clone);
    // LANGUAGE selects the French Git catalogue where it is installed. Inspect
    // both commands' effective locale even on hosts without that catalogue.
    const hostEnv = {
      LC_ALL: "en_US.UTF-8",
      LANGUAGE: "fr",
      GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: env.GIT_CONFIG_NOSYSTEM,
    };
    const saved = { ...process.env };
    const before = recurringWorkMetrics.snapshot().kinds["git-fetch-local"];
    try {
      Object.assign(process.env, hostEnv);
      await createGitFetchScheduler().ensureFetched(clone, "main");
    } finally {
      for (const key of Object.keys(hostEnv)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }

    expect(await fs.readFile(attempts, "utf8")).toBe("C\nC\n");
    expect(await tip(clone, "refs/remotes/origin/main")).toBe(await tip(upstream, "HEAD"));
    expect(recurringWorkMetrics.snapshot().kinds["git-fetch-local"]).toMatchObject({
      started: (before?.started ?? 0) + 1,
      completed: (before?.completed ?? 0) + 1,
      failed: before?.failed ?? 0,
    });
  });

  test("a stale lock still fails after one retry", async () => {
    const metrics = new RecurringWorkMetrics();
    let fetches = 0;
    await fs.writeFile(lockPath(), "");
    const scheduler = new GitFetchScheduler({
      metrics,
      lockRetryDelayMs: 0,
      run: (args, timeoutMs) => {
        if (args[2] === "fetch") fetches += 1;
        return runCommand("git", args, { env, timeoutMs });
      },
    });

    await scheduler.ensureFetched(clone, "main");

    expect(fetches).toBe(2);
    expect(metrics.snapshot().kinds["git-fetch-local"]).toMatchObject({ started: 1, failed: 1 });
  });

  test("a stale parent tracking ref blocks the new child branch without a retry", async () => {
    await git(["update-ref", "refs/remotes/origin/release", "HEAD"], clone);
    await git(["branch", "release/v2"], upstream);
    const metrics = new RecurringWorkMetrics();
    let fetches = 0;
    const scheduler = new GitFetchScheduler({
      metrics,
      lockRetryDelayMs: 0,
      run: (args, timeoutMs) => {
        if (args[2] === "fetch") fetches += 1;
        return runCommand("git", args, { env, timeoutMs });
      },
    });

    await scheduler.ensureFetched(clone, "release/v2");

    expect(fetches).toBe(1);
    expect(metrics.snapshot().kinds["git-fetch-local"]).toMatchObject({
      started: 1,
      completed: 0,
      failed: 1,
    });
  });
});
