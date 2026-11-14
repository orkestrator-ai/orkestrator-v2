import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReadOnlyShellCommand } from "./read-only-policy.js";
import { withReadOnlyGitConfig } from "./runtime-env.js";

/**
 * Hardened reviewer Git (`gitWithoutSandbox: "harden"`) against real Git, in
 * repositories whose own configuration names a helper program at every place
 * an admitted read could run one: `diff.external`, a textconv and diff-command
 * driver, an inline submodule diff (the submodule's own `diff.external`), and a
 * custom merge driver behind a remerge diff. Each command is judged by the
 * read-only policy, then run exactly as the hook would hand it on (the
 * rewritten form) with the turn's Git environment (`withReadOnlyGitConfig`).
 * The helper writes a sentinel; it must never appear. A control runs the same
 * command unhardened and must see the sentinel, so a fixture that quietly
 * stopped selecting its helper cannot make the check pass.
 *
 * Slow tier (`*.integration.test.ts`): it builds Git repositories per run.
 */

// Every test runs real Git processes, and the fixtures build three repositories.
setDefaultTimeout(30_000);

const hardened = {
  commandSandbox: "unavailable",
  gitWithoutSandbox: "harden",
  role: "read-only",
} as const;

let root = "";
let sentinel = "";
let helper = "";
const repos = { helpers: "", parent: "", merge: "" };
let mergeCommit = "";

function hermeticEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(root, "home"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_PAGER: "cat",
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: hermeticEnv() });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

/** Runs `command` (literal words only, as the policy requires) and reports the helper. */
function run(cwd: string, command: string, environment: NodeJS.ProcessEnv) {
  rmSync(sentinel, { force: true });
  const result = Bun.spawnSync(command.split(/\s+/), { cwd, env: environment });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    helperRan: existsSync(sentinel),
  };
}

const turnEnv = () => withReadOnlyGitConfig({ id: "coordinator-read-only" }, hermeticEnv());

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "review-git-hardening-"));
  sentinel = join(root, "helper-ran");
  helper = join(root, "helper.sh");
  writeFileSync(helper, `#!/bin/sh\necho ran >> ${sentinel}\n[ -f "$1" ] && cat "$1"\nexit 0\n`);
  chmodSync(helper, 0o755);

  // Every diff helper a checkout's own config and attributes can name.
  repos.helpers = join(root, "helpers");
  git(root, "init", "-q", "-b", "main", repos.helpers);
  writeFileSync(join(repos.helpers, ".gitattributes"), "*.txt diff=probe\n");
  writeFileSync(join(repos.helpers, "a.txt"), "one\n");
  git(repos.helpers, "add", ".");
  git(repos.helpers, "commit", "-qm", "one");
  writeFileSync(join(repos.helpers, "a.txt"), "two\n");
  git(repos.helpers, "commit", "-qam", "two");
  git(repos.helpers, "config", "diff.external", helper);
  git(repos.helpers, "config", "diff.probe.textconv", helper);
  git(repos.helpers, "config", "diff.probe.command", helper);

  // A submodule whose own config names `diff.external`, in a parent that
  // asks for inline submodule diffs by default.
  const sub = join(root, "sub");
  git(root, "init", "-q", "-b", "main", sub);
  writeFileSync(join(sub, "f"), "one\n");
  git(sub, "add", ".");
  git(sub, "commit", "-qm", "one");
  repos.parent = join(root, "parent");
  git(root, "init", "-q", "-b", "main", repos.parent);
  git(repos.parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
  git(repos.parent, "commit", "-qm", "add sub");
  const inner = join(repos.parent, "sub");
  writeFileSync(join(inner, "f"), "two\n");
  git(inner, "commit", "-qam", "two");
  git(inner, "config", "diff.external", helper);
  git(repos.parent, "add", "sub");
  git(repos.parent, "commit", "-qm", "bump sub");
  git(repos.parent, "config", "diff.submodule", "diff");

  // A conflicted merge whose file names a custom merge driver, with
  // `log.diffMerges=remerge` so `-m` would re-run it.
  repos.merge = join(root, "merge");
  git(root, "init", "-q", "-b", "main", repos.merge);
  writeFileSync(join(repos.merge, ".gitattributes"), "f merge=probe\n");
  writeFileSync(join(repos.merge, "f"), "base\n");
  git(repos.merge, "add", ".");
  git(repos.merge, "commit", "-qm", "base");
  git(repos.merge, "checkout", "-qb", "side");
  writeFileSync(join(repos.merge, "f"), "side\n");
  git(repos.merge, "commit", "-qam", "side");
  git(repos.merge, "checkout", "-q", "main");
  writeFileSync(join(repos.merge, "f"), "mainline\n");
  git(repos.merge, "commit", "-qam", "mainline");
  git(repos.merge, "-c", "merge.probe.driver=true", "merge", "-q", "side", "-m", "merge");
  mergeCommit = git(repos.merge, "rev-parse", "HEAD");
  git(repos.merge, "config", "merge.probe.driver", `${helper} %O %A %B`);
  git(repos.merge, "config", "log.diffMerges", "remerge");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("hardened reviewer Git against a hostile checkout", () => {
  const admitted = (): [string, string][] => [
    [repos.helpers, "git diff HEAD~1..HEAD"],
    [repos.helpers, "git diff HEAD~1..HEAD -- a.txt"],
    [repos.helpers, "git show HEAD"],
    [repos.helpers, "git show HEAD:a.txt"],
    [repos.helpers, "git log -p -1"],
    [repos.helpers, "git blame a.txt"],
    [repos.parent, "git diff HEAD~1..HEAD"],
    [repos.parent, "git show HEAD"],
    [repos.parent, "git log -p -1"],
    [repos.merge, `git show -m ${mergeCommit}`],
    [repos.merge, `git log -m -p -1 ${mergeCommit}`],
    [repos.merge, `git show --diff-merges=on ${mergeCommit}`],
  ];

  test("each fixture's helper is live: the unhardened command runs it", () => {
    for (const [cwd, command] of [
      [repos.helpers, "git diff HEAD~1..HEAD"],
      [repos.helpers, "git log -p -1"],
      [repos.helpers, "git blame a.txt"],
      [repos.parent, "git diff HEAD~1..HEAD"],
      [repos.merge, `git show -m ${mergeCommit}`],
    ] as const) {
      expect({ command, ran: run(cwd, command, hermeticEnv()).helperRan }).toEqual({
        command,
        ran: true,
      });
    }
  });

  test("every admitted read runs, as rewritten, without running a configured helper", () => {
    for (const [cwd, command] of admitted()) {
      const verdict = isReadOnlyShellCommand(command, hardened);
      expect({ command, allowed: verdict.allowed }).toEqual({ command, allowed: true });
      const outcome = run(cwd, verdict.command ?? command, turnEnv());
      expect({ command, exitCode: outcome.exitCode, helperRan: outcome.helperRan }).toEqual({
        command,
        exitCode: 0,
        helperRan: false,
      });
    }
  });

  test("the rewritten reads still show the change", () => {
    const diff = isReadOnlyShellCommand("git diff HEAD~1..HEAD", hardened).command!;
    expect(run(repos.helpers, diff, turnEnv()).stdout).toContain("+two");
    const submodule = run(repos.parent, diff, turnEnv()).stdout;
    expect(submodule).toContain("Subproject commit");
  });

  test("the forms no flag can harden are refused, and would have run the helper", () => {
    for (const [cwd, command] of [
      [repos.parent, "git diff --submodule=diff HEAD~1..HEAD"],
      [repos.parent, "git log --submodule=diff -p -1"],
      [repos.merge, `git show --remerge-diff ${mergeCommit}`],
      [repos.merge, `git log --diff-merges=remerge -1 ${mergeCommit}`],
      [repos.merge, `git log --diff-merges r -1 ${mergeCommit}`],
    ] as const) {
      expect({ command, allowed: isReadOnlyShellCommand(command, hardened).allowed }).toEqual({
        command,
        allowed: false,
      });
      // With the hardening flags and the turn's environment, still the helper.
      const words = command.split(" ");
      const flagged = [words[0], words[1], "--no-ext-diff", "--no-textconv", ...words.slice(2)];
      expect({ command, ran: run(cwd, flagged.join(" "), turnEnv()).helperRan }).toEqual({
        command,
        ran: true,
      });
    }
  });
});
