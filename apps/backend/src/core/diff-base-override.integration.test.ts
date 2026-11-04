import { expect, onTestFinished, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as shell from "./shell.js";
import {
  diffBaseGitForEnvironment,
  listDiffBaseBranches,
  resolveDiffBaseOverride,
} from "./diff-base-override.js";
import { createEnvironment } from "./storage.js";
import { createPublicApiHarness, headCommit } from "./public-api/test-support.js";
import { environmentBaselineCommit } from "@orkestrator/protocol/diff-stats";
import { discardedRuntimeSetupUpdates } from "./commands-environment.js";

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
    const replaced = await step("updateEnvironment", () =>
      h.storage.updateEnvironment(environment.id, {
        ...discardedRuntimeSetupUpdates(),
        worktreePath: replacement,
      }),
    );
    expect(replaced.diffBaseOverride).toBeNull();
    expect(environmentBaselineCommit(replaced)).toBeUndefined();
    await step("diffStats.sync", () => h.context.runtime.diffStats.sync(h.context));
    await read(replacement, "main");
    await step("write replacement README", () =>
      fs.writeFile(path.join(replacement, "README.md"), "dirty again\n"),
    );
    await command("revert_local_file", {
      environmentId: environment.id,
      filePath: "README.md",
      targetBranch: "main",
    });
    expect(
      await step("read replacement README", () =>
        fs.readFile(path.join(replacement, "README.md"), "utf8"),
      ),
    ).toBe("# comparison\n");
    expect(await step("listDiffBaseBranches", () => listDiffBaseBranches(freshGit))).toContainEqual(
      {
        ref: "refs/heads/main",
        name: "main",
        kind: "local",
      },
    );
    await expect(
      step("resolveDiffBaseOverride", () =>
        resolveDiffBaseOverride(freshGit, { ref: "refs/heads/main", commit: unpushed }),
      ),
    ).rejects.toThrow("not in this environment's checkout");
    const missingGit = diffBaseGitForEnvironment({
      ...replaced,
      worktreePath: path.join(h.root, "missing"),
    });
    await expect(
      step("listDiffBaseBranches (missing checkout)", () => listDiffBaseBranches(missingGit)),
    ).rejects.toThrow();
    expect(() => diffBaseGitForEnvironment({ ...replaced, worktreePath: undefined })).toThrow(
      "no checkout",
    );
  } finally {
    await step("h.cleanup", () => h.cleanup());
  }
  timings.passed();
}, 30_000);

test("step timings name the unfinished step and every step's time, and only when not passed", async () => {
  let clock = 1_000;
  const reports: string[] = [];
  const timed = (work: (timings: ReturnType<typeof createStepTimings>) => Promise<void>) => {
    const timings = createStepTimings(
      (report) => reports.push(report),
      () => clock,
    );
    return { timings, done: work(timings) };
  };

  // A stall: the step never settles, as when the deadline abandons the body.
  const { timings: stalled } = timed(async (timings) => {
    await timings.step("fast step", async () => {
      clock += 5;
    });
    await timings.step("stuck step", () => new Promise<void>(() => undefined));
  });
  await Bun.sleep(0);
  clock += 30_000;
  stalled.report();
  stalled.report();
  expect(reports).toEqual([
    [
      "[step timings] test did not pass after 30005 ms; waiting on #2 stuck step",
      "  #1 ok 5 ms fast step",
      "  #2 WAITING 30000 ms stuck step",
    ].join("\n"),
  ]);

  // A failure between steps says so, and an error's text is never reported.
  reports.length = 0;
  const failing = timed(async (timings) => {
    await timings.step("failing step", async () => {
      clock += 1;
      throw new Error("secret file contents");
    });
  });
  await expect(failing.done).rejects.toThrow("secret file contents");
  failing.timings.report();
  expect(reports).toEqual([
    [
      "[step timings] test did not pass after 1 ms; no step unfinished",
      "  #1 rejected 1 ms failing step",
    ].join("\n"),
  ]);

  // A passing run prints nothing.
  reports.length = 0;
  const passing = timed(async (timings) => {
    await timings.step("only step", async () => undefined);
    timings.passed();
  });
  await passing.done;
  passing.timings.report();
  expect(reports).toEqual([]);

  // Output stays bounded however many steps ran and however long their names.
  const bounded = timed(async (timings) => {
    for (let index = 0; index < MAX_TIMED_STEPS + 10; index += 1) {
      await timings.step("x".repeat(MAX_STEP_NAME_LENGTH * 2), async () => undefined);
    }
  });
  await bounded.done;
  bounded.timings.report();
  const lines = reports[0]!.split("\n");
  expect(lines[1]).toBe("  (10 earlier steps dropped)");
  expect(lines.length).toBe(MAX_TIMED_STEPS + 2);
  expect(lines.at(-1)).toBe(
    `  #${MAX_TIMED_STEPS + 10} ok 0 ms ${"x".repeat(MAX_STEP_NAME_LENGTH)}`,
  );
});

// Run only in a child selected by the parent test below. An actual Bun deadline
// exercises onTestFinished even though the awaited step never settles.
const timingProbe = process.env.ORKESTRATOR_DIFF_TIMINGS_PROBE;
if (timingProbe) {
  test("step timings lifecycle probe", async () => {
    const timings = createStepTimings();
    onTestFinished(() => timings.report());
    await timings.step("probe completed", async () => undefined);
    if (timingProbe === "deadline") {
      await timings.step("probe stalled", () => new Promise<void>(() => undefined));
    }
    timings.passed();
  }, 100);
}

test("step timings report through Bun's deadline hook and stay silent on success", async () => {
  for (const outcome of ["deadline", "passed"]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        import.meta.path,
        "--test-name-pattern",
        "^step timings lifecycle probe$",
        "--parallel=1",
      ],
      {
        cwd: import.meta.dir,
        env: { ...process.env, ORKESTRATOR_DIFF_TIMINGS_PROBE: outcome },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const watchdog = setTimeout(() => child.kill(), 10_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const output = stdout + stderr;
      expect(exitCode).toBe(outcome === "deadline" ? 1 : 0);
      if (outcome === "deadline") {
        expect(output).toContain("waiting on #2 probe stalled");
        expect(output).toMatch(/#1 ok \d+ ms probe completed/);
        expect(output).toMatch(/#2 WAITING \d+ ms probe stalled/);
        expect(output.match(/\[step timings\]/g)).toHaveLength(1);
      } else {
        expect(output).not.toContain("[step timings]");
      }
    } finally {
      clearTimeout(watchdog);
    }
  }
}, 25_000);

test("container Git quotes arguments, selects /workspace and rejects stopped runtimes", async () => {
  const environment = {
    environmentType: "containerized" as const,
    worktreePath: undefined,
    containerId: "container",
    status: "running" as const,
  };
  const run = spyOn(shell, "runCommand").mockResolvedValue({ stdout: "result", stderr: "" });
  try {
    expect(
      await diffBaseGitForEnvironment(environment)(["log", "refs/heads/it's-main", "$(touch bad)"]),
    ).toBe("result");
    expect(run).toHaveBeenCalledWith(
      "docker",
      [
        "exec",
        "container",
        "bash",
        "-lc",
        `cd /workspace && git 'log' 'refs/heads/it'"'"'s-main' '$(touch bad)'`,
      ],
      { timeoutMs: 30_000, redactValues: undefined, signal: undefined },
    );
    expect(() => diffBaseGitForEnvironment({ ...environment, status: "stopped" })).toThrow(
      "Start the environment",
    );
    expect(() => diffBaseGitForEnvironment({ ...environment, containerId: null })).toThrow(
      "Start the environment",
    );
  } finally {
    run.mockRestore();
  }
});
