import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGitFetchScheduler } from "../diff-stats-tracking.js";
import { ProjectGitService } from "../project-git-service.js";
import { createProject, StorageService } from "../storage.js";
import {
  backgroundFetchArgs,
  backgroundFetchRefspec,
  NO_WRITE_FETCH_HEAD,
} from "./background-fetch.js";

/**
 * Background freshness fetches against real Git and a local bare remote: the
 * remote-tracking ref they exist to refresh moves, and the `FETCH_HEAD` the
 * user or agent last produced in that checkout does not.
 */

let root: string;
let remote: string;
let publisher: string;
let checkout: string;
let savedEnv: NodeJS.ProcessEnv;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(
    ["git", "-c", "user.email=a@b", "-c", "user.name=a", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

/** Commits `file` on the remote's `branch` and returns the new tip. */
async function publish(file: string, branch = "main"): Promise<string> {
  await git(publisher, "checkout", "-q", "-B", branch);
  await fs.writeFile(path.join(publisher, file), `${file}\n`);
  await git(publisher, "add", file);
  await git(publisher, "commit", "-q", "-m", file);
  await git(publisher, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  return git(publisher, "rev-parse", "HEAD");
}

/** The FETCH_HEAD file of the worktree at `cwd` (it is per worktree). */
async function fetchHead(cwd: string): Promise<string> {
  const file = await git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD");
  return fs.readFile(file, "utf8");
}

beforeEach(async () => {
  savedEnv = { ...process.env };
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-background-fetch-")));
  // Isolate from the developer's own Git configuration; the code under test
  // spawns Git with process.env.
  await fs.writeFile(path.join(root, "gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_TERMINAL_PROMPT = "0";

  remote = path.join(root, "remote.git");
  publisher = path.join(root, "publisher");
  checkout = path.join(root, "checkout");
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  await git(root, "init", "-q", "-b", "main", publisher);
  await git(publisher, "remote", "add", "origin", remote);
  await publish("base.txt");
  await publish("side.txt", "side");
  await git(root, "clone", "-q", remote, checkout);

  // What the person in the checkout last fetched by hand.
  await git(checkout, "fetch", "-q", "origin", "side");
  expect(await fetchHead(checkout)).toContain("'side'");
});

afterEach(async () => {
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("backgroundFetchArgs", () => {
  test("names one remote-tracking ref and suppresses FETCH_HEAD", () => {
    expect(backgroundFetchArgs("feature/x")).toEqual([
      NO_WRITE_FETCH_HEAD,
      "origin",
      "+refs/heads/feature/x:refs/remotes/origin/feature/x",
    ]);
    expect(NO_WRITE_FETCH_HEAD).toBe("--no-write-fetch-head");
  });

  // A recorded creation commit has no branch to track; only its objects are needed.
  test("fetches a full commit SHA by name, without a destination", () => {
    const sha1 = "a".repeat(40);
    const sha256 = "B".repeat(64);
    expect(backgroundFetchArgs(sha1)).toEqual([NO_WRITE_FETCH_HEAD, "origin", sha1]);
    expect(backgroundFetchRefspec(sha256)).toBe(sha256);
    // An abbreviated SHA is indistinguishable from a branch name.
    expect(backgroundFetchRefspec("abc1234")).toBe(
      "+refs/heads/abc1234:refs/remotes/origin/abc1234",
    );
  });
});

describe("background fetches leave FETCH_HEAD alone", () => {
  test("the worktree fetch scheduler moves origin/<ref> in a linked worktree", async () => {
    const worktree = path.join(root, "worktree");
    await git(checkout, "worktree", "add", "-q", "-b", "work", worktree, "origin/main");
    await git(worktree, "fetch", "-q", "origin", "side");
    const before = await fetchHead(worktree);
    const checkoutBefore = await fetchHead(checkout);
    const tip = await publish("upstream.txt");

    const scheduler = createGitFetchScheduler();
    try {
      await scheduler.ensureFetched(worktree, "main");
    } finally {
      scheduler.forget(worktree);
    }

    expect(await git(worktree, "rev-parse", "refs/remotes/origin/main")).toBe(tip);
    expect(await fetchHead(worktree)).toBe(before);
    expect(await fetchHead(checkout)).toBe(checkoutBefore);
  });

  // A single-branch clone or a narrowed refspec does not cover the target, so
  // only an explicit refspec makes the fetch update what the diff reads.
  test("the scheduler updates origin/<ref> even when the configured refspec omits it", async () => {
    await git(
      checkout,
      "config",
      "remote.origin.fetch",
      "+refs/heads/side:refs/remotes/origin/side",
    );
    const before = await fetchHead(checkout);
    const tip = await publish("narrowed.txt");

    const scheduler = createGitFetchScheduler();
    try {
      await scheduler.ensureFetched(checkout, "main");
    } finally {
      scheduler.forget(checkout);
    }

    expect(await git(checkout, "rev-parse", "refs/remotes/origin/main")).toBe(tip);
    expect(await fetchHead(checkout)).toBe(before);
  });

  test("the scheduler fetches a missing creation commit without touching FETCH_HEAD", async () => {
    const tip = await publish("creation.txt");
    const before = await fetchHead(checkout);
    expect(
      Bun.spawnSync(["git", "cat-file", "-e", `${tip}^{commit}`], { cwd: checkout }).exitCode,
    ).not.toBe(0);

    const scheduler = createGitFetchScheduler();
    try {
      await scheduler.ensureFetched(checkout, tip);
    } finally {
      scheduler.forget(checkout);
    }

    expect(await git(checkout, "rev-parse", "--verify", `${tip}^{commit}`)).toBe(tip);
    expect(await fetchHead(checkout)).toBe(before);
  });

  test("project checkout refreshes move remote refs only", async () => {
    const storage = new StorageService(path.join(root, "data"));
    await storage.init();
    try {
      const project = await storage.addProject(createProject(remote, checkout));
      const service = new ProjectGitService(storage);
      const before = await fetchHead(checkout);

      const fetchedTip = await publish("refresh.txt");
      const refreshed = await service.fetch(project.id, true);
      expect(refreshed.lastError).toBeNull();
      expect(await git(checkout, "rev-parse", "refs/remotes/origin/main")).toBe(fetchedTip);
      expect(await fetchHead(checkout)).toBe(before);

      const baseTip = await publish("launch.txt");
      expect(await service.baseBranchTip(project.id, "main")).toMatchObject({
        commit: baseTip,
        ref: "origin/main",
        fetched: true,
      });
      expect(await fetchHead(checkout)).toBe(before);
    } finally {
      storage.close();
    }
  });
});
