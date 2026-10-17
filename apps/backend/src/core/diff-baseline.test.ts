import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { environmentBaselineCommit } from "@orkestrator/protocol/diff-stats";
import { baselineTargetBranch, findIntegratedBaseline, localBaselineGit } from "./diff-baseline.js";
import { runCommand } from "./shell.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await runCommand("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Orkestrator Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Orkestrator Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return stdout.trim();
}

async function commit(cwd: string, file: string): Promise<string> {
  await fs.writeFile(path.join(cwd, file), `${file}\n`);
  await git(cwd, ["add", file]);
  await git(cwd, ["commit", "-m", file]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * A repository whose `origin/main` is at `created`, with a worker worktree on
 * its own branch from that commit, the way a coordinator launch makes one.
 */
async function workerFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-diff-baseline-"));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const project = path.join(root, "project");
  const worktree = path.join(root, "worker");
  await fs.mkdir(project);
  await git(root, ["init", "--bare", "-b", "main", origin]);
  await git(project, ["init", "-b", "main"]);
  const created = await commit(project, "base.txt");
  await git(project, ["remote", "add", "origin", origin]);
  await git(project, ["push", "-u", "origin", "main"]);
  await git(project, ["worktree", "add", "--no-track", "-b", "worker", worktree, created]);
  const advanceOrigin = async () => {
    await commit(project, "upstream-1.txt");
    const tip = await commit(project, "upstream-2.txt");
    await git(project, ["push", "origin", "main"]);
    await git(worktree, ["fetch", "origin"]);
    return tip;
  };
  return { project, worktree, created, advanceOrigin, run: localBaselineGit(worktree) };
}

test("a branch that took in newer target history is measured from where it now leaves it", async () => {
  const { worktree, created, advanceOrigin, run } = await workerFixture();
  await commit(worktree, "own-work.txt");
  const tip = await advanceOrigin();
  // Before the merge the creation commit is still the fork point.
  expect(await findIntegratedBaseline(run, created, "main")).toBeNull();

  await git(worktree, ["merge", "--no-edit", "origin/main"]);
  const baseline = await findIntegratedBaseline(run, created, "main");
  expect(baseline).toEqual({ createdFromCommit: created, commit: tip });
  const diff = await git(worktree, ["diff", "--name-only", baseline!.commit]);
  expect(diff.split("\n")).toEqual(["own-work.txt"]);
});

test("a worker reset or fast-forwarded to a newer target has no changes of its own", async () => {
  const { worktree, created, advanceOrigin, run } = await workerFixture();
  const tip = await advanceOrigin();
  await git(worktree, ["reset", "--hard", "origin/main"]);
  expect(await findIntegratedBaseline(run, created, "main")).toEqual({
    createdFromCommit: created,
    commit: tip,
  });
});

test("the creation commit stays the baseline when the target does not contain it", async () => {
  const { project, worktree, run } = await workerFixture();
  // Launched from a local commit that was never pushed.
  const unpushed = await commit(project, "local-only.txt");
  await git(worktree, ["reset", "--hard", unpushed]);
  await commit(worktree, "own-work.txt");
  expect(await findIntegratedBaseline(run, unpushed, "main")).toBeNull();
});

test("a missing target branch or a non-commit creation ref leaves the baseline alone", async () => {
  const { created, run } = await workerFixture();
  expect(await findIntegratedBaseline(run, created, "does-not-exist")).toBeNull();
  expect(await findIntegratedBaseline(run, created, "bad..ref")).toBeNull();
  expect(await findIntegratedBaseline(run, "origin/main", "main")).toBeNull();
});

test("a baseline recorded for an earlier checkout is ignored", () => {
  const created = "a".repeat(40);
  const advanced = "b".repeat(40);
  expect(
    environmentBaselineCommit({
      createdFromCommit: created,
      diffBaseline: { createdFromCommit: created, commit: advanced },
    }),
  ).toBe(advanced);
  expect(
    environmentBaselineCommit({
      createdFromCommit: "c".repeat(40),
      diffBaseline: { createdFromCommit: created, commit: advanced },
    }),
  ).toBe("c".repeat(40));
  expect(
    environmentBaselineCommit({
      diffBaseline: { createdFromCommit: created, commit: advanced },
    }),
  ).toBeUndefined();
});

test("the target branch prefers the PR base, then the delegated branch, then repository config", () => {
  // A merged PR's commits are in the target already; its baseline stays put.
  expect(baselineTargetBranch({ prState: "merged", prBaseBranch: "main" }, null)).toBeNull();
  expect(
    baselineTargetBranch(
      { prBaseBranch: "release", delegationBaseBranch: "develop" },
      { prBaseBranch: "staging", defaultBranch: "trunk" },
    ),
  ).toBe("release");
  expect(
    baselineTargetBranch({ delegationBaseBranch: "develop" }, { defaultBranch: "trunk" }),
  ).toBe("develop");
  expect(baselineTargetBranch({}, { defaultBranch: "trunk" })).toBe("trunk");
  expect(baselineTargetBranch({ prBaseBranch: null }, null)).toBe("main");
});
