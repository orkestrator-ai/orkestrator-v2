/**
 * The smallest case found that still loses a child's completion event (to-do
 * 6900, task 2): the first test of
 * `apps/backend/src/core/diff-base-override.integration.test.ts`, verbatim up
 * to its replacement `git clone` and `cat-file` and cut there, with the
 * backend's watch host stubbed out. It loses events only when `runCommand` is
 * the old pipe capture (`pipe-runner.ts`), so do not run it directly:
 * `scratch.ts` splices the runner into a throwaway worktree's
 * `command-capture.ts` and runs this file there, one process per run, with
 * the strict probe.
 *
 * Each run spawns 77 Git children. On macOS (arktech-mini, Bun 1.4.4) about
 * 1 run in 100 loses one (3 of 350 on 2026-11-13), always the 67th or 68th: the `merge-base` or
 * `config` of the diff scan the service starts in the background as the test
 * resets its override and clones. Replaying the same 77 commands with the
 * same file writes, identity and timing (`reduction.ts replay`), standalone or
 * inside `bun test` next to the harness, loses nothing. A shorter rewrite of
 * this test lost 1 child in 300 runs, too few to tell apart, and lost none
 * in 400 with `runCommand` swapped through `mock.module` instead of spliced
 * in, so the test is kept as written. See to-do 6900 for the counts.
 *
 * Nothing imports this file, and it is not named `.test.ts`, so no suite runs it.
 */
import { expect, mock, onTestFinished, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { environmentBaselineCommit } from "@orkestrator/protocol/diff-stats";
import { discardedRuntimeSetupUpdates } from "../../apps/backend/src/core/commands-environment";
import {
  diffBaseGitForEnvironment,
  listDiffBaseBranches,
  resolveDiffBaseOverride,
} from "../../apps/backend/src/core/diff-base-override";
import {
  createPublicApiHarness,
  headCommit,
} from "../../apps/backend/src/core/public-api/test-support";
import * as shell from "../../apps/backend/src/core/shell";
import { createEnvironment } from "../../apps/backend/src/core/storage";
import * as watchHost from "../../apps/backend/src/core/watch-host";

// Loaded as test 1's file loads them, though the cut test no longer calls them.
void [
  environmentBaselineCommit,
  discardedRuntimeSetupUpdates,
  listDiffBaseBranches,
  resolveDiffBaseOverride,
];

// The watch host is a long-lived `bun` child on pipes. Test 1 loses events as
// often without it, so it is left out to keep FSEvents out of the case.
mock.module("../../apps/backend/src/core/watch-host", () => ({
  ...watchHost,
  watchDirectory: () => ({
    on: () => undefined,
    close: () => undefined,
    established: Promise.resolve(),
  }),
}));

/** Steps kept per test (the oldest go first) and characters kept per step name. */
const MAX_TIMED_STEPS = 64;
const MAX_STEP_NAME_LENGTH = 80;

/**
 * Names each await of a test so a deadline miss says which one it was waiting
 * on. Bun's deadline fails the test without settling the body, so the report
 * comes from `onTestFinished`, which still runs then, and stays silent once
 * `passed()` was reached. It holds literal step names and times only: never a
 * command's arguments, output or error text, or a file's contents.
 */
function createStepTimings(
  write: (report: string) => void = (report) => console.error(report),
  now: () => number = () => performance.now(),
) {
  type Step = { index: number; name: string; startedAt: number; ms?: number; rejected?: boolean };
  const startedAt = now();
  const steps: Step[] = [];
  let started = 0;
  let didPass = false;
  let reported = false;
  return {
    async step<T>(name: string, work: () => Promise<T>): Promise<T> {
      const record: Step = {
        index: ++started,
        name: name.slice(0, MAX_STEP_NAME_LENGTH),
        startedAt: now(),
      };
      steps.push(record);
      if (steps.length > MAX_TIMED_STEPS) steps.shift();
      try {
        return await work();
      } catch (error) {
        record.rejected = true;
        throw error;
      } finally {
        record.ms = now() - record.startedAt;
      }
    },
    passed() {
      didPass = true;
    },
    report() {
      if (didPass || reported) return;
      reported = true;
      const at = now();
      const waiting = steps.filter((step) => step.ms === undefined);
      const lines = steps.map((step) => {
        const state = step.ms === undefined ? "WAITING" : step.rejected ? "rejected" : "ok";
        const ms = Math.round(step.ms ?? at - step.startedAt);
        return `  #${step.index} ${state} ${ms} ms ${step.name}`;
      });
      const summary = waiting.length
        ? `waiting on ${waiting.map((step) => `#${step.index} ${step.name}`).join(", ")}`
        : "no step unfinished";
      const dropped = started - steps.length;
      write(
        [
          `[step timings] test did not pass after ${Math.round(at - startedAt)} ms; ${summary}`,
          ...(dropped > 0 ? [`  (${dropped} earlier steps dropped)`] : []),
          ...lines,
        ].join("\n"),
      );
    },
  };
}

// Exercise real Git, storage, command registration, scan targeting and file restoration.
test("saved/reset overrides retarget real scans and reverts; replacement drops an unpushed base", async () => {
  const timings = createStepTimings();
  onTestFinished(() => timings.report());
  const { step } = timings;
  const h = await step("createPublicApiHarness", () => createPublicApiHarness());
  try {
    const { projectPath, originPath } = await step("createRepository", () =>
      h.createRepository("comparison"),
    );
    const initial = await step("headCommit", () => headCommit(projectPath));
    const file = path.join(projectPath, "README.md");
    const git = (args: string[]) => shell.runCommand("git", ["-C", projectPath, ...args]);
    await step("write README", () => fs.writeFile(file, "unpushed base\n"));
    await step("git add", () => git(["add", "."]));
    await step("git commit", () =>
      git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "Unpushed base",
      ]),
    );
    const unpushed = await step("headCommit", () => headCommit(projectPath));
    const environment = await step("addEnvironment", () =>
      h.storage.addEnvironment({
        ...createEnvironment("project", { environmentType: "local" }),
        worktreePath: projectPath,
        createdFromCommit: initial,
        status: "running",
      }),
    );
    const command = (name: string, args: Record<string, unknown>) =>
      step(name, async () => h.commands.get(name)!(args, h.context));
    const read = (worktreePath: string, comparisonRef: string) =>
      step("readFileList", () =>
        h.context.runtime.diffStats.service.readFileList({
          lookup: { worktreePath },
          comparisonRef,
          includeUncommitted: true,
          refresh: true,
        }),
      );
    await command("set_environment_diff_base", {
      environmentId: environment.id,
      ref: "refs/heads/main",
      commit: unpushed,
    });
    expect(
      (await step("getEnvironment", () => h.storage.getEnvironment(environment.id)))
        ?.diffBaseOverride?.commit,
    ).toBe(unpushed);
    await read(projectPath, unpushed);
    expect(
      h.context.runtime.diffStats.service
        .revisionedWorktreeSnapshot()
        .entries.find((e) => e.environmentId === environment.id)?.comparisonRef,
    ).toBe(unpushed);
    await step("write README", () => fs.writeFile(file, "dirty\n"));
    await command("revert_local_file", {
      environmentId: environment.id,
      filePath: "README.md",
      targetBranch: unpushed,
    });
    expect(await step("read README", () => fs.readFile(file, "utf8"))).toBe("unpushed base\n");
    await command("set_environment_diff_base", {
      environmentId: environment.id,
      ref: null,
      commit: null,
    });
    await read(projectPath, initial);
    expect(
      h.context.runtime.diffStats.service
        .revisionedWorktreeSnapshot()
        .entries.find((e) => e.environmentId === environment.id)?.comparisonRef,
    ).toBe(initial);
    await command("revert_local_file", {
      environmentId: environment.id,
      filePath: "README.md",
      targetBranch: initial,
    });
    expect(await step("read README", () => fs.readFile(file, "utf8"))).toBe("# comparison\n");
    await command("set_environment_diff_base", {
      environmentId: environment.id,
      ref: "refs/heads/main",
      commit: unpushed,
    });
    const replacement = path.join(h.root, "replacement");
    await step("git clone", () => shell.runCommand("git", ["clone", originPath, replacement]));
    const freshGit = diffBaseGitForEnvironment({
      environmentType: "local",
      worktreePath: replacement,
      containerId: null,
      status: "running",
    });
    await expect(
      step("git cat-file", () => freshGit(["cat-file", "-e", unpushed])),
    ).rejects.toThrow();
    // Cut here (to-do 6900): let the scans the service started in the
    // background finish.
    await step("settle", () => Bun.sleep(1_000));
  } finally {
    await step("h.cleanup", () => h.cleanup());
  }
  timings.passed();
}, 30_000);
